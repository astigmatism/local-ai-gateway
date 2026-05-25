import axios from 'axios';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../errors/apiError.js';

export type ModelSourceState = 'ok' | 'error' | 'skipped';

export interface ModelSourceStatus {
  status: ModelSourceState;
  message?: string;
}

export interface ModelRuntimeInfo {
  name: string;
  size?: number;
  sizeVram?: number;
  contextLength?: number;
  expiresAt?: string;
  details?: Record<string, unknown>;
  source?: 'health' | 'ollamaPs' | 'combined';
}

export interface AvailableModelInfo {
  name: string;
  size?: number;
  modifiedAt?: string;
  details?: {
    family?: string;
    format?: string;
    parameterSize?: string;
    quantization?: string;
    [key: string]: unknown;
  };
  source?: 'health' | 'ollamaTags' | 'combined';
}

export interface ModelManagementStatus {
  defaultModel: string | null;
  defaultModelSource: 'local-ai-llm' | 'gateway-fallback';
  defaultModelLoaded: boolean | null;
  loadedModels: ModelRuntimeInfo[];
  availableModels: AvailableModelInfo[];
  source: {
    health: ModelSourceStatus;
    ollamaTags: ModelSourceStatus;
    ollamaPs: ModelSourceStatus;
  };
  generatedAt: string;
}

export interface ModelLoadOptions {
  model: string;
  makeDefault: boolean;
}

const statusCacheTtlMs = 30_000;
const statusRequestTimeoutMs = Math.min(30_000, config.llm.timeoutMs);
const chatDefaultLookupTimeoutMs = Math.min(5_000, config.llm.timeoutMs);

let runtimeDefaultModel = config.llm.model;
let statusCache: { status: ModelManagementStatus; cachedAt: number } | null = null;
let modelLoadInFlight: { model: string; startedAt: string } | null = null;

const modelNamePattern =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/){0,2}[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/u;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);

const cleanString = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const cleanNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const cleanBoolean = (value: unknown) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'loaded'].includes(normalized)) return true;
    if (['false', '0', 'no', 'not_loaded', 'unloaded'].includes(normalized)) return false;
  }
  return undefined;
};

const readPath = (root: unknown, path: string[]) => {
  let current: unknown = root;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record || !(segment in record)) return undefined;
    current = record[segment];
  }
  return current;
};

const sourceError = (message: string): ModelSourceStatus => ({ status: 'error', message });
const sourceOk = (): ModelSourceStatus => ({ status: 'ok' });
const sourceSkipped = (message: string): ModelSourceStatus => ({ status: 'skipped', message });

const sanitizedAxiosMessage = (error: unknown, timeoutMs: number) => {
  if (axios.isAxiosError(error)) {
    if (error.response) return `HTTP ${error.response.status}`;
    if (error.code === 'ECONNABORTED') return `timeout after ${timeoutMs} ms`;
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'EHOSTUNREACH') {
      return 'service unavailable';
    }
    return error.message || 'service unavailable';
  }

  return error instanceof Error ? error.message : 'unknown error';
};

const makeSourceStatusFromError = (error: unknown, timeoutMs: number) => sourceError(sanitizedAxiosMessage(error, timeoutMs));

const nameFromModelObject = (value: unknown) => {
  const record = asRecord(value);
  if (!record) return undefined;

  return (
    cleanString(record.name) ??
    cleanString(record.model) ??
    cleanString(record.model_name) ??
    cleanString(record.modelName) ??
    cleanString(record.id)
  );
};

export const normalizeModelName = (value: unknown) => cleanString(value);

export const isValidModelName = (value: unknown): value is string => {
  const model = normalizeModelName(value);
  if (!model || model.length > 120) return false;
  if (model.includes('://')) return false;
  if (model.includes('..') || model.includes('\\')) return false;
  if (/\s/u.test(model)) return false;
  if (/[`'";&|<>{}[\]$]/u.test(model)) return false;
  if (model.startsWith('/') || model.startsWith('-') || model.startsWith('.')) return false;
  return modelNamePattern.test(model);
};

export const assertValidModelName = (value: unknown) => {
  const model = normalizeModelName(value);
  if (!isValidModelName(model)) {
    throw new ApiError(
      400,
      'Model name must be a local Ollama model name such as qwen3:30b, qwen3:14b, llama3.1:8b, or namespace/model:tag.',
      'INVALID_MODEL_NAME'
    );
  }
  return model;
};

const includeIfPresent = (details: Record<string, unknown>, key: string, value: unknown) => {
  if (value !== undefined && value !== null && value !== '') details[key] = value;
};

const detailsFromModelObject = (record: Record<string, unknown>) => {
  const details: Record<string, unknown> = {};
  const rawDetails = asRecord(record.details);
  if (rawDetails) {
    for (const [key, value] of Object.entries(rawDetails)) {
      if (value !== undefined && value !== null) details[key] = value;
    }
  }

  includeIfPresent(details, 'family', record.family);
  includeIfPresent(details, 'format', record.format);
  includeIfPresent(details, 'parameter_size', record.parameter_size ?? record.parameterSize);
  includeIfPresent(details, 'quantization_level', record.quantization_level ?? record.quantizationLevel ?? record.quantization);

  return Object.keys(details).length > 0 ? details : undefined;
};

const normalizeRuntimeModel = (value: unknown, source: ModelRuntimeInfo['source']): ModelRuntimeInfo | null => {
  const modelName = typeof value === 'string' ? cleanString(value) : nameFromModelObject(value);
  if (!modelName || !isValidModelName(modelName)) return null;

  const record = asRecord(value);
  if (!record) return { name: modelName, source };

  const sizeVram = cleanNumber(record.size_vram ?? record.sizeVram ?? record.vram_size ?? record.vramSize);
  const contextLength = cleanNumber(record.context_length ?? record.contextLength ?? readPath(record, ['details', 'context_length']));
  const expiresAt = cleanString(record.expires_at ?? record.expiresAt);
  const details = detailsFromModelObject(record);

  return {
    name: modelName,
    size: cleanNumber(record.size),
    sizeVram,
    contextLength,
    expiresAt,
    details,
    source
  };
};

const normalizeAvailableModel = (value: unknown, source: AvailableModelInfo['source']): AvailableModelInfo | null => {
  const modelName = typeof value === 'string' ? cleanString(value) : nameFromModelObject(value);
  if (!modelName || !isValidModelName(modelName)) return null;

  const record = asRecord(value);
  if (!record) return { name: modelName, source };

  const rawDetails = detailsFromModelObject(record);
  const details = rawDetails
    ? {
        ...rawDetails,
        family: cleanString(rawDetails.family),
        format: cleanString(rawDetails.format),
        parameterSize: cleanString(rawDetails.parameter_size ?? rawDetails.parameterSize),
        quantization: cleanString(rawDetails.quantization_level ?? rawDetails.quantizationLevel ?? rawDetails.quantization)
      }
    : undefined;

  return {
    name: modelName,
    size: cleanNumber(record.size),
    modifiedAt: cleanString(record.modified_at ?? record.modifiedAt),
    details,
    source
  };
};

const modelListFromValue = <T>(
  value: unknown,
  normalizer: (item: unknown) => T | null,
  preferNestedModels = true
): T[] => {
  const candidates: unknown[] = [];
  const array = asArray(value);
  if (array) candidates.push(...array);

  const record = asRecord(value);
  if (record && preferNestedModels) {
    const models = asArray(record.models);
    if (models) candidates.push(...models);
  }

  return candidates.map(normalizer).filter((item): item is T => item !== null);
};

const uniqueModelList = <T extends { name: string }>(models: T[]) => {
  const seen = new Map<string, T>();
  for (const model of models) {
    const existing = seen.get(model.name);
    seen.set(model.name, existing ? { ...existing, ...model } : model);
  }
  return Array.from(seen.values()).sort((left, right) => left.name.localeCompare(right.name));
};

const mergeRuntimeModels = (models: ModelRuntimeInfo[]) => {
  const merged = new Map<string, ModelRuntimeInfo>();

  for (const model of models) {
    const existing = merged.get(model.name);
    if (!existing) {
      merged.set(model.name, model);
      continue;
    }

    merged.set(model.name, {
      name: model.name,
      size: model.size ?? existing.size,
      sizeVram: model.sizeVram ?? existing.sizeVram,
      contextLength: model.contextLength ?? existing.contextLength,
      expiresAt: model.expiresAt ?? existing.expiresAt,
      details: { ...(existing.details ?? {}), ...(model.details ?? {}) },
      source: existing.source === model.source ? existing.source : 'combined'
    });
  }

  return Array.from(merged.values()).sort((left, right) => left.name.localeCompare(right.name));
};

const mergeAvailableModels = (models: AvailableModelInfo[]) => {
  const merged = new Map<string, AvailableModelInfo>();

  for (const model of models) {
    const existing = merged.get(model.name);
    if (!existing) {
      merged.set(model.name, model);
      continue;
    }

    merged.set(model.name, {
      ...existing,
      ...model,
      details: { ...(existing.details ?? {}), ...(model.details ?? {}) },
      source: existing.source === model.source ? existing.source : 'combined'
    });
  }

  return Array.from(merged.values()).sort((left, right) => left.name.localeCompare(right.name));
};

const firstValidModelNameAtPaths = (data: unknown, paths: string[][]) => {
  for (const path of paths) {
    const value = readPath(data, path);
    const model = cleanString(value);
    if (model && isValidModelName(model)) return model;
  }
  return null;
};

const firstBooleanAtPaths = (data: unknown, paths: string[][]) => {
  for (const path of paths) {
    const value = cleanBoolean(readPath(data, path));
    if (value !== undefined) return value;
  }
  return null;
};

const firstListAtPaths = <T>(data: unknown, paths: string[][], normalizer: (item: unknown) => T | null) => {
  for (const path of paths) {
    const value = readPath(data, path);
    const models = modelListFromValue(value, normalizer);
    if (models.length > 0) return models;
  }
  return [];
};

export const extractDefaultModelFromHealth = (data: unknown) =>
  firstValidModelNameAtPaths(data, [
    ['defaultModel'],
    ['default_model'],
    ['configuredDefaultModel'],
    ['configured_default_model'],
    ['configured_model'],
    ['llmModel'],
    ['llm_model'],
    ['config', 'defaultModel'],
    ['config', 'default_model'],
    ['config', 'model'],
    ['ollama', 'defaultModel'],
    ['ollama', 'default_model'],
    ['ollama', 'configured_default_model'],
    ['model']
  ]);

export const extractDefaultLoadedFromHealth = (data: unknown) =>
  firstBooleanAtPaths(data, [
    ['defaultModelLoaded'],
    ['default_model_loaded'],
    ['defaultLoaded'],
    ['default_loaded'],
    ['isDefaultLoaded'],
    ['is_default_loaded'],
    ['config', 'default_model_loaded'],
    ['ollama', 'defaultModelLoaded'],
    ['ollama', 'default_model_loaded'],
    ['ollama', 'default_loaded']
  ]);

export const extractLoadedModelsFromHealth = (data: unknown) =>
  uniqueModelList(
    firstListAtPaths(
      data,
      [
        ['loadedModels'],
        ['loaded_models'],
        ['loadedOllamaModels'],
        ['loaded_ollama_models'],
        ['runningModels'],
        ['running_models'],
        ['modelsLoaded'],
        ['models_loaded'],
        ['ollamaModels'],
        ['ollama_models'],
        ['ollama', 'loadedModels'],
        ['ollama', 'loaded_models'],
        ['ollama', 'runningModels'],
        ['ollama', 'running_models'],
        ['ollama', 'models'],
        ['models']
      ],
      (item) => normalizeRuntimeModel(item, 'health')
    )
  );

export const extractAvailableModelsFromHealth = (data: unknown) =>
  uniqueModelList(
    firstListAtPaths(
      data,
      [
        ['availableModels'],
        ['available_models'],
        ['installedModels'],
        ['installed_models'],
        ['localModels'],
        ['local_models'],
        ['selectableModels'],
        ['selectable_models'],
        ['ollama', 'availableModels'],
        ['ollama', 'available_models'],
        ['ollama', 'installedModels'],
        ['ollama', 'installed_models'],
        ['ollama', 'localModels'],
        ['ollama', 'local_models'],
        ['ollama', 'tags']
      ],
      (item) => normalizeAvailableModel(item, 'health')
    )
  );

export const extractLoadedModelsFromOllamaPs = (data: unknown) =>
  uniqueModelList(modelListFromValue(data, (item) => normalizeRuntimeModel(item, 'ollamaPs')));

export const extractAvailableModelsFromOllamaTags = (data: unknown) =>
  uniqueModelList(modelListFromValue(data, (item) => normalizeAvailableModel(item, 'ollamaTags')));

interface BuildModelStatusInput {
  healthData?: unknown;
  healthSource: ModelSourceStatus;
  tagsData?: unknown;
  tagsSource: ModelSourceStatus;
  psData?: unknown;
  psSource: ModelSourceStatus;
}

export const buildModelManagementStatus = ({
  healthData,
  healthSource,
  tagsData,
  tagsSource,
  psData,
  psSource
}: BuildModelStatusInput): ModelManagementStatus => {
  const healthDefaultModel = healthSource.status === 'ok' ? extractDefaultModelFromHealth(healthData) : null;
  const healthDefaultLoaded = healthSource.status === 'ok' ? extractDefaultLoadedFromHealth(healthData) : null;
  const healthLoadedModels = healthSource.status === 'ok' ? extractLoadedModelsFromHealth(healthData) : [];
  const healthAvailableModels = healthSource.status === 'ok' ? extractAvailableModelsFromHealth(healthData) : [];
  const psLoadedModels = psSource.status === 'ok' ? extractLoadedModelsFromOllamaPs(psData) : [];
  const tagAvailableModels = tagsSource.status === 'ok' ? extractAvailableModelsFromOllamaTags(tagsData) : [];
  const loadedModels = mergeRuntimeModels([...healthLoadedModels, ...psLoadedModels]);
  const availableModels = mergeAvailableModels([...healthAvailableModels, ...tagAvailableModels]);
  const defaultModel = healthDefaultModel ?? runtimeDefaultModel ?? config.llm.model ?? null;
  const loadedSourceKnown = healthSource.status === 'ok' || psSource.status === 'ok';
  const inferredDefaultLoaded =
    defaultModel && loadedSourceKnown
      ? loadedModels.some((model) => model.name.toLowerCase() === defaultModel.toLowerCase())
      : null;

  if (healthDefaultModel) runtimeDefaultModel = healthDefaultModel;

  return {
    defaultModel,
    defaultModelSource: healthDefaultModel ? 'local-ai-llm' : 'gateway-fallback',
    defaultModelLoaded: healthDefaultLoaded ?? inferredDefaultLoaded,
    loadedModels,
    availableModels,
    source: {
      health: healthSource,
      ollamaTags: tagsSource,
      ollamaPs: psSource
    },
    generatedAt: new Date().toISOString()
  };
};

const fetchHealth = async (timeoutMs: number) => {
  const response = await axios.get(`${config.llm.monitorBaseUrl}/health`, {
    timeout: timeoutMs,
    validateStatus: (status) => status >= 200 && status < 300
  });
  return response.data;
};

const fetchOllamaTags = async () => {
  const response = await axios.get(`${config.llm.baseUrl}/api/tags`, {
    timeout: statusRequestTimeoutMs,
    validateStatus: (status) => status >= 200 && status < 300
  });
  return response.data;
};

const fetchOllamaPs = async () => {
  const response = await axios.get(`${config.llm.baseUrl}/api/ps`, {
    timeout: statusRequestTimeoutMs,
    validateStatus: (status) => status >= 200 && status < 300
  });
  return response.data;
};

export const getModelManagementStatus = async ({ forceRefresh = false }: { forceRefresh?: boolean } = {}) => {
  const now = Date.now();
  if (!forceRefresh && statusCache && now - statusCache.cachedAt < statusCacheTtlMs) {
    return statusCache.status;
  }

  let healthData: unknown;
  let healthSource: ModelSourceStatus = sourceOk();

  try {
    healthData = await fetchHealth(statusRequestTimeoutMs);
  } catch (error) {
    healthSource = makeSourceStatusFromError(error, statusRequestTimeoutMs);
    logger.warn(
      {
        errorMessage: healthSource.message,
        service: 'local-ai-llm',
        endpoint: 'health'
      },
      'Model settings health discovery failed'
    );
  }

  const healthAvailableModels = healthSource.status === 'ok' ? extractAvailableModelsFromHealth(healthData) : [];

  let tagsData: unknown;
  let tagsSource: ModelSourceStatus =
    healthAvailableModels.length > 0 ? sourceSkipped('Available models were reported by local-ai-llm health.') : sourceOk();

  if (tagsSource.status !== 'skipped') {
    try {
      tagsData = await fetchOllamaTags();
    } catch (error) {
      tagsSource = makeSourceStatusFromError(error, statusRequestTimeoutMs);
      logger.warn(
        {
          errorMessage: tagsSource.message,
          service: 'ollama',
          endpoint: 'api/tags'
        },
        'Ollama available-model discovery failed'
      );
    }
  }

  let psData: unknown;
  let psSource: ModelSourceStatus = sourceOk();

  try {
    psData = await fetchOllamaPs();
  } catch (error) {
    psSource = makeSourceStatusFromError(error, statusRequestTimeoutMs);
    logger.warn(
      {
        errorMessage: psSource.message,
        service: 'ollama',
        endpoint: 'api/ps'
      },
      'Ollama running-model discovery failed'
    );
  }

  const status = buildModelManagementStatus({
    healthData,
    healthSource,
    tagsData,
    tagsSource,
    psData,
    psSource
  });

  statusCache = { status, cachedAt: now };
  return status;
};

export const resolveDefaultLlmModel = async () => {
  if (statusCache && Date.now() - statusCache.cachedAt < statusCacheTtlMs && statusCache.status.defaultModel) {
    return statusCache.status.defaultModel;
  }

  try {
    const healthData = await fetchHealth(chatDefaultLookupTimeoutMs);
    const healthDefaultModel = extractDefaultModelFromHealth(healthData);
    if (healthDefaultModel) {
      runtimeDefaultModel = healthDefaultModel;
      return healthDefaultModel;
    }
  } catch (error) {
    logger.warn(
      {
        errorMessage: sanitizedAxiosMessage(error, chatDefaultLookupTimeoutMs),
        fallbackModel: runtimeDefaultModel
      },
      'Could not refresh default LLM model; using gateway fallback model'
    );
  }

  return runtimeDefaultModel || config.llm.model;
};

export const loadModel = async ({ model, makeDefault }: ModelLoadOptions) => {
  const validModel = assertValidModelName(model);

  if (modelLoadInFlight) {
    throw new ApiError(
      409,
      `Another model load is already in progress for ${modelLoadInFlight.model}. Try again after it finishes.`,
      'MODEL_LOAD_IN_PROGRESS',
      { model: modelLoadInFlight.model, startedAt: modelLoadInFlight.startedAt }
    );
  }

  modelLoadInFlight = { model: validModel, startedAt: new Date().toISOString() };
  const startedAt = Date.now();

  try {
    logger.info({ model: validModel, makeDefault }, 'Model load requested');

    const response = await axios.post(
      `${config.llm.monitorBaseUrl}/model/load`,
      {
        model: validModel,
        make_default: makeDefault
      },
      {
        timeout: config.llm.timeoutMs,
        validateStatus: (status) => status >= 200 && status < 300
      }
    );

    const loadedFromLoadResponse = extractLoadedModelsFromHealth(response.data);
    const availableFromLoadResponse = extractAvailableModelsFromHealth(response.data);

    if (makeDefault) {
      const reportedDefault = extractDefaultModelFromHealth(response.data);
      runtimeDefaultModel = reportedDefault ?? validModel;
    }

    statusCache = null;
    const status = await getModelManagementStatus({ forceRefresh: true });

    if (loadedFromLoadResponse.length > 0) {
      status.loadedModels = mergeRuntimeModels([...status.loadedModels, ...loadedFromLoadResponse]);
    }

    if (availableFromLoadResponse.length > 0) {
      status.availableModels = mergeAvailableModels([...status.availableModels, ...availableFromLoadResponse]);
    }

    if (makeDefault && (!status.defaultModel || status.defaultModel.toLowerCase() !== validModel.toLowerCase())) {
      runtimeDefaultModel = validModel;
      status.defaultModel = validModel;
      status.defaultModelSource = 'gateway-fallback';
      status.defaultModelLoaded = status.loadedModels.some(
        (loadedModel) => loadedModel.name.toLowerCase() === validModel.toLowerCase()
      );
    }

    logger.info(
      {
        model: validModel,
        makeDefault,
        durationMs: Date.now() - startedAt,
        loadedModelCount: status.loadedModels.length,
        defaultModel: status.defaultModel
      },
      'Model load completed'
    );

    return status;
  } catch (error) {
    if (error instanceof ApiError) throw error;

    const message = sanitizedAxiosMessage(error, config.llm.timeoutMs);
    logger.error(
      {
        errorMessage: message,
        model: validModel,
        makeDefault,
        durationMs: Date.now() - startedAt
      },
      'Model load failed'
    );

    if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
      throw new ApiError(504, `Model load timed out after ${config.llm.timeoutMs} ms.`, 'MODEL_LOAD_TIMEOUT');
    }

    if (axios.isAxiosError(error) && error.response) {
      throw new ApiError(502, `local-ai-llm model load failed with ${message}.`, 'MODEL_LOAD_FAILED');
    }

    throw new ApiError(503, 'Could not reach local-ai-llm to load the model.', 'LLM_MONITOR_UNAVAILABLE');
  } finally {
    modelLoadInFlight = null;
  }
};

export const resetModelSettingsCacheForTests = () => {
  runtimeDefaultModel = config.llm.model;
  statusCache = null;
  modelLoadInFlight = null;
};
