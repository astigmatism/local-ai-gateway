import axios from 'axios';
import type { Readable } from 'node:stream';
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
  digest?: string;
  details?: Record<string, unknown>;
  source?: 'health' | 'ollamaPs' | 'combined';
}

export interface AvailableModelInfo {
  name: string;
  size?: number;
  modifiedAt?: string;
  digest?: string;
  details?: {
    family?: string;
    families?: string[];
    format?: string;
    parameterSize?: string;
    quantization?: string;
    [key: string]: unknown;
  };
  source?: 'health' | 'ollamaTags' | 'combined';
}

export interface DiskStorageInfo {
  path?: string;
  filesystem?: string;
  usedBytes?: number;
  availableBytes?: number;
  totalBytes?: number;
  usedPercent?: number;
  ollamaModelsBytes?: number;
}

export interface ModelStorageSummary {
  installedModelBytes: number;
  installedModelCount: number;
  disk: DiskStorageInfo | null;
  lowSpace: boolean | null;
  warning?: string;
}

export interface ModelCatalogCapability {
  mode: 'manual';
  stableApiAvailable: false;
  libraryUrl: string;
  message: string;
}

export interface ModelManagementStatus {
  defaultModel: string | null;
  defaultModelSource: 'local-ai-llm' | 'gateway-fallback';
  defaultModelLoaded: boolean | null;
  loadedModels: ModelRuntimeInfo[];
  availableModels: AvailableModelInfo[];
  storage: ModelStorageSummary;
  catalog: ModelCatalogCapability;
  source: {
    health: ModelSourceStatus;
    ollamaTags: ModelSourceStatus;
    ollamaPs: ModelSourceStatus;
    storage: ModelSourceStatus;
  };
  generatedAt: string;
}

export interface ModelLoadOptions {
  model: string;
  makeDefault: boolean;
}

export interface ModelDetailsSummary {
  name: string;
  size?: number;
  digest?: string;
  modifiedAt?: string;
  format?: string;
  family?: string;
  families?: string[];
  parameterSize?: string;
  quantization?: string;
  contextLength?: number;
  capabilities?: string[];
  license?: string;
  template?: string;
  system?: string;
  modelfile?: string;
  parameters?: string;
  modelInfo?: Record<string, unknown>;
}

export interface ModelDetailsResponse {
  model: string;
  summary: ModelDetailsSummary;
  raw: Record<string, unknown>;
  generatedAt: string;
}

export type ModelPullEventType = 'progress' | 'complete' | 'error';

export interface ModelPullProgressEvent {
  type: ModelPullEventType;
  model: string;
  status: string;
  completedBytes?: number;
  totalBytes?: number;
  percent?: number;
  error?: string;
  raw?: Record<string, unknown>;
  generatedAt: string;
}

export interface ModelPullReservation {
  model: string;
  startedAt: string;
}

const statusCacheTtlMs = 30_000;
const statusRequestTimeoutMs = config.modelManagement.discoveryTimeoutMs;
const chatDefaultLookupTimeoutMs = Math.min(5_000, config.llm.timeoutMs);

let runtimeDefaultModel = config.llm.model;
let statusCache: { status: ModelManagementStatus; cachedAt: number } | null = null;
let modelLoadInFlight: { model: string; startedAt: string } | null = null;
const modelPullsInFlight = new Map<string, { startedAt: string }>();
const modelDeletesInFlight = new Map<string, { startedAt: string }>();

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

const cleanStringArray = (value: unknown) => {
  const items = asArray(value);
  if (!items) return undefined;
  const strings = items.map((item) => cleanString(item)).filter((item): item is string => Boolean(item));
  return strings.length > 0 ? strings : undefined;
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
const sourceOk = (message?: string): ModelSourceStatus => (message ? { status: 'ok', message } : { status: 'ok' });
const sourceSkipped = (message: string): ModelSourceStatus => ({ status: 'skipped', message });

const catalogCapability: ModelCatalogCapability = {
  mode: 'manual',
  stableApiAvailable: false,
  libraryUrl: 'https://ollama.com/search',
  message:
    'No official stable Ollama public catalog search API is configured. Enter a model name from the Ollama library and Bear Castle AI will pull it through the gateway.'
};

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
  includeIfPresent(details, 'families', record.families);
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
    digest: cleanString(record.digest),
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
        families: cleanStringArray(rawDetails.families),
        format: cleanString(rawDetails.format),
        parameterSize: cleanString(rawDetails.parameter_size ?? rawDetails.parameterSize),
        quantization: cleanString(rawDetails.quantization_level ?? rawDetails.quantizationLevel ?? rawDetails.quantization)
      }
    : undefined;

  return {
    name: modelName,
    size: cleanNumber(record.size),
    modifiedAt: cleanString(record.modified_at ?? record.modifiedAt),
    digest: cleanString(record.digest),
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
      digest: model.digest ?? existing.digest,
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

const storageCandidatePaths = [
  ['storage'],
  ['disk'],
  ['filesystem'],
  ['ollama', 'storage'],
  ['ollama', 'disk'],
  ['system', 'storage'],
  ['system', 'disk']
];

const normalizeDiskStorageInfo = (data: unknown): DiskStorageInfo | null => {
  const candidates: unknown[] = [data];
  for (const path of storageCandidatePaths) {
    const candidate = readPath(data, path);
    if (candidate !== undefined) candidates.push(candidate);
  }

  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (!record) continue;

    const usedBytes = cleanNumber(record.used_bytes ?? record.usedBytes ?? record.used);
    const availableBytes = cleanNumber(
      record.available_bytes ?? record.availableBytes ?? record.free_bytes ?? record.freeBytes ?? record.available ?? record.free
    );
    const totalBytes = cleanNumber(record.total_bytes ?? record.totalBytes ?? record.total ?? record.size_bytes ?? record.sizeBytes);
    let usedPercent = cleanNumber(record.used_percent ?? record.usedPercent ?? record.percent_used ?? record.percentUsed);
    if (usedPercent === undefined && usedBytes !== undefined && totalBytes !== undefined && totalBytes > 0) {
      usedPercent = (usedBytes / totalBytes) * 100;
    }

    const ollamaModelsBytes = cleanNumber(
      record.ollama_models_bytes ?? record.ollamaModelsBytes ?? record.models_bytes ?? record.modelsBytes
    );

    if (
      usedBytes === undefined &&
      availableBytes === undefined &&
      totalBytes === undefined &&
      usedPercent === undefined &&
      ollamaModelsBytes === undefined
    ) {
      continue;
    }

    return {
      path: cleanString(record.path ?? record.mount_path ?? record.mountPath),
      filesystem: cleanString(record.filesystem ?? record.device),
      usedBytes,
      availableBytes,
      totalBytes,
      usedPercent,
      ollamaModelsBytes
    };
  }

  return null;
};

const installedModelBytes = (models: AvailableModelInfo[]) =>
  models.reduce((total, model) => total + (model.size !== undefined && Number.isFinite(model.size) ? model.size : 0), 0);

const buildStorageSummary = (
  availableModels: AvailableModelInfo[],
  storageData: unknown,
  storageSource: ModelSourceStatus
): ModelStorageSummary => {
  const disk = storageSource.status === 'ok' ? normalizeDiskStorageInfo(storageData) : null;
  const usedPercent = disk?.usedPercent;
  const availableBytes = disk?.availableBytes;
  const lowByPercent = usedPercent !== undefined && usedPercent >= config.modelManagement.lowDiskWarningPercent;
  const lowByBytes = availableBytes !== undefined && availableBytes <= config.modelManagement.lowDiskWarningBytes;
  const lowSpace = usedPercent !== undefined || availableBytes !== undefined ? lowByPercent || lowByBytes : null;

  return {
    installedModelBytes: installedModelBytes(availableModels),
    installedModelCount: availableModels.length,
    disk,
    lowSpace,
    warning:
      lowSpace === true
        ? `local-ai-llm disk usage is above ${config.modelManagement.lowDiskWarningPercent}% or below the free-space warning threshold.`
        : undefined
  };
};

interface BuildModelStatusInput {
  healthData?: unknown;
  healthSource: ModelSourceStatus;
  tagsData?: unknown;
  tagsSource: ModelSourceStatus;
  psData?: unknown;
  psSource: ModelSourceStatus;
  storageData?: unknown;
  storageSource?: ModelSourceStatus;
}

export const buildModelManagementStatus = ({
  healthData,
  healthSource,
  tagsData,
  tagsSource,
  psData,
  psSource,
  storageData,
  storageSource = sourceSkipped('Storage endpoint was not queried.')
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
    storage: buildStorageSummary(availableModels, storageData, storageSource),
    catalog: catalogCapability,
    source: {
      health: healthSource,
      ollamaTags: tagsSource,
      ollamaPs: psSource,
      storage: storageSource
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

const storageEndpointsToTry = () => {
  const configured = config.modelManagement.storageEndpoint;
  const endpoints = [configured];
  if (configured === '/storage') endpoints.push('/disk');
  return endpoints;
};

const fetchStorage = async () => {
  const errors: string[] = [];

  for (const endpoint of storageEndpointsToTry()) {
    try {
      const response = await axios.get(`${config.llm.monitorBaseUrl}${endpoint}`, {
        timeout: statusRequestTimeoutMs,
        validateStatus: (status) => status >= 200 && status < 300
      });
      return {
        data: response.data,
        source: sourceOk(`Disk data from local-ai-llm monitor ${endpoint}.`)
      };
    } catch (error) {
      errors.push(`${endpoint}: ${sanitizedAxiosMessage(error, statusRequestTimeoutMs)}`);
    }
  }

  throw new Error(errors.join('; ') || 'storage endpoint unavailable');
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

  let tagsData: unknown;
  let tagsSource: ModelSourceStatus = sourceOk();

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
      'Ollama installed-model discovery failed'
    );
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

  let storageData: unknown;
  let storageSource: ModelSourceStatus = sourceSkipped('Disk data unavailable; showing installed model sizes only.');

  if (healthSource.status === 'ok' && normalizeDiskStorageInfo(healthData)) {
    storageData = healthData;
    storageSource = sourceOk('Disk data from local-ai-llm monitor health.');
  } else {
    try {
      const storage = await fetchStorage();
      storageData = storage.data;
      storageSource = normalizeDiskStorageInfo(storage.data)
        ? storage.source
        : sourceError('Storage endpoint did not include disk usage fields.');
    } catch (error) {
      storageSource = makeSourceStatusFromError(error, statusRequestTimeoutMs);
      logger.warn(
        {
          errorMessage: storageSource.message,
          service: 'local-ai-llm',
          endpoint: config.modelManagement.storageEndpoint
        },
        'local-ai-llm storage discovery failed'
      );
    }
  }

  const status = buildModelManagementStatus({
    healthData,
    healthSource,
    tagsData,
    tagsSource,
    psData,
    psSource,
    storageData,
    storageSource
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

export const resolveOptionalLlmFeatureModel = async (explicitModel: string | undefined) => {
  const trimmedExplicitModel = explicitModel?.trim();
  if (trimmedExplicitModel) return trimmedExplicitModel;

  const defaultModel = await resolveDefaultLlmModel();
  return defaultModel.trim() || undefined;
};

export const loadModel = async ({ model, makeDefault }: ModelLoadOptions) => {
  const validModel = assertValidModelName(model);

  const pullOperation = modelPullsInFlight.get(validModel);
  if (pullOperation) {
    throw new ApiError(409, `A pull operation is already in progress for ${validModel}.`, 'MODEL_PULL_IN_PROGRESS', {
      model: validModel,
      startedAt: pullOperation.startedAt
    });
  }

  const deleteOperation = modelDeletesInFlight.get(validModel);
  if (deleteOperation) {
    throw new ApiError(409, `A delete operation is already in progress for ${validModel}.`, 'MODEL_DELETE_IN_PROGRESS', {
      model: validModel,
      startedAt: deleteOperation.startedAt
    });
  }

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

const rawRecord = (value: unknown) => asRecord(value) ?? {};

const contextLengthFromModelInfo = (modelInfo: Record<string, unknown> | undefined) => {
  if (!modelInfo) return undefined;

  const direct = cleanNumber(modelInfo.context_length ?? modelInfo.contextLength ?? modelInfo['general.context_length']);
  if (direct !== undefined) return direct;

  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('.context_length')) {
      const parsed = cleanNumber(value);
      if (parsed !== undefined) return parsed;
    }
  }

  return undefined;
};

const summarizeModelDetails = (model: string, data: Record<string, unknown>): ModelDetailsSummary => {
  const details = asRecord(data.details);
  const modelInfo = asRecord(data.model_info ?? data.modelInfo) ?? undefined;

  return {
    name: model,
    size: cleanNumber(data.size),
    digest: cleanString(data.digest),
    modifiedAt: cleanString(data.modified_at ?? data.modifiedAt),
    format: cleanString(details?.format ?? data.format),
    family: cleanString(details?.family ?? data.family),
    families: cleanStringArray(details?.families ?? data.families),
    parameterSize: cleanString(details?.parameter_size ?? details?.parameterSize ?? data.parameter_size ?? data.parameterSize),
    quantization: cleanString(
      details?.quantization_level ?? details?.quantizationLevel ?? details?.quantization ?? data.quantization_level ?? data.quantization
    ),
    contextLength: cleanNumber(data.context_length ?? data.contextLength) ?? contextLengthFromModelInfo(modelInfo),
    capabilities: cleanStringArray(data.capabilities),
    license: cleanString(data.license),
    template: cleanString(data.template),
    system: cleanString(data.system),
    modelfile: cleanString(data.modelfile ?? data.modelFile),
    parameters: cleanString(data.parameters),
    modelInfo
  };
};

export const showModelDetails = async (model: string): Promise<ModelDetailsResponse> => {
  const validModel = assertValidModelName(model);

  try {
    const response = await axios.post(
      `${config.llm.baseUrl}/api/show`,
      { model: validModel },
      {
        timeout: config.modelManagement.detailsTimeoutMs,
        validateStatus: (status) => status >= 200 && status < 300
      }
    );
    const raw = rawRecord(response.data);
    return {
      model: validModel,
      summary: summarizeModelDetails(validModel, raw),
      raw,
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;

    const message = sanitizedAxiosMessage(error, config.modelManagement.detailsTimeoutMs);
    logger.warn({ errorMessage: message, model: validModel, endpoint: 'api/show' }, 'Ollama model details request failed');

    if (axios.isAxiosError(error) && error.response) {
      throw new ApiError(502, `Ollama model details failed with ${message}.`, 'MODEL_DETAILS_FAILED');
    }

    throw new ApiError(503, 'Could not reach Ollama to show model details.', 'OLLAMA_UNAVAILABLE');
  }
};

const assertNoDeleteInFlight = (model: string) => {
  const deleteOperation = modelDeletesInFlight.get(model);
  if (deleteOperation) {
    throw new ApiError(409, `A delete operation is already in progress for ${model}.`, 'MODEL_DELETE_IN_PROGRESS', {
      model,
      startedAt: deleteOperation.startedAt
    });
  }
};

const assertNoPullInFlight = (model: string) => {
  const pullOperation = modelPullsInFlight.get(model);
  if (pullOperation) {
    throw new ApiError(409, `A pull operation is already in progress for ${model}.`, 'MODEL_PULL_IN_PROGRESS', {
      model,
      startedAt: pullOperation.startedAt
    });
  }
};

export const reserveModelPull = (model: string): ModelPullReservation => {
  const validModel = assertValidModelName(model);
  assertNoPullInFlight(validModel);
  assertNoDeleteInFlight(validModel);

  if (modelLoadInFlight?.model === validModel) {
    throw new ApiError(409, `A load operation is already in progress for ${validModel}.`, 'MODEL_LOAD_IN_PROGRESS', {
      model: validModel,
      startedAt: modelLoadInFlight.startedAt
    });
  }

  if (modelPullsInFlight.size >= config.modelManagement.maxConcurrentPulls) {
    const activeModel = Array.from(modelPullsInFlight.keys())[0] ?? 'another model';
    throw new ApiError(
      409,
      `Another model pull is already in progress for ${activeModel}. Try again after it finishes.`,
      'MODEL_PULL_LIMIT_REACHED',
      { activeModel }
    );
  }

  const reservation = { model: validModel, startedAt: new Date().toISOString() };
  modelPullsInFlight.set(validModel, { startedAt: reservation.startedAt });
  return reservation;
};

const progressEventFromOllama = (model: string, record: Record<string, unknown>): ModelPullProgressEvent => {
  const status = cleanString(record.status) ?? cleanString(record.error) ?? 'Downloading model';
  const completedBytes = cleanNumber(record.completed);
  const totalBytes = cleanNumber(record.total);
  const percent =
    completedBytes !== undefined && totalBytes !== undefined && totalBytes > 0
      ? Math.max(0, Math.min(100, (completedBytes / totalBytes) * 100))
      : undefined;

  return {
    type: cleanString(record.error) ? 'error' : status.toLowerCase() === 'success' ? 'complete' : 'progress',
    model,
    status,
    completedBytes,
    totalBytes,
    percent,
    error: cleanString(record.error),
    raw: record,
    generatedAt: new Date().toISOString()
  };
};

const writeProgress = (onProgress: ((event: ModelPullProgressEvent) => void) | undefined, event: ModelPullProgressEvent) => {
  onProgress?.(event);
};

const parsePullStream = async (
  model: string,
  stream: Readable,
  onProgress?: (event: ModelPullProgressEvent) => void
): Promise<ModelPullProgressEvent> =>
  new Promise((resolve, reject) => {
    let buffer = '';
    let lastEvent: ModelPullProgressEvent | null = null;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
      stream.destroy();
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let record: Record<string, unknown>;
      try {
        record = rawRecord(JSON.parse(trimmed));
      } catch {
        fail(new ApiError(502, 'Ollama returned an invalid pull progress event.', 'MODEL_PULL_STREAM_INVALID'));
        return;
      }

      const event = progressEventFromOllama(model, record);
      lastEvent = event;
      writeProgress(onProgress, event);

      if (event.error) {
        fail(new ApiError(502, `Ollama pull failed: ${event.error}`, 'MODEL_PULL_FAILED', event));
      }
    };

    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });
    stream.on('error', fail);
    stream.on('end', () => {
      if (settled) return;
      if (buffer.trim()) handleLine(buffer);
      if (settled) return;
      settled = true;

      const completeEvent: ModelPullProgressEvent =
        lastEvent?.type === 'complete'
          ? lastEvent
          : {
              type: 'complete',
              model,
              status: lastEvent?.status ?? 'success',
              completedBytes: lastEvent?.completedBytes,
              totalBytes: lastEvent?.totalBytes,
              percent: lastEvent?.percent ?? 100,
              generatedAt: new Date().toISOString()
            };
      writeProgress(onProgress, completeEvent);
      resolve(completeEvent);
    });
  });

export const runReservedModelPull = async (
  reservation: ModelPullReservation,
  onProgress?: (event: ModelPullProgressEvent) => void
) => {
  const startedAt = Date.now();
  try {
    logger.info({ model: reservation.model }, 'Ollama model pull requested');
    writeProgress(onProgress, {
      type: 'progress',
      model: reservation.model,
      status: 'Starting model download',
      generatedAt: new Date().toISOString()
    });

    const response = await axios.post(
      `${config.llm.baseUrl}/api/pull`,
      { model: reservation.model, stream: true },
      {
        timeout: config.modelManagement.pullTimeoutMs,
        responseType: 'stream',
        validateStatus: (status) => status >= 200 && status < 300
      }
    );

    const finalEvent = await parsePullStream(reservation.model, response.data as Readable, onProgress);
    statusCache = null;
    logger.info({ model: reservation.model, durationMs: Date.now() - startedAt }, 'Ollama model pull completed');
    return finalEvent;
  } catch (error) {
    if (error instanceof ApiError) throw error;

    const message = sanitizedAxiosMessage(error, config.modelManagement.pullTimeoutMs);
    logger.error({ errorMessage: message, model: reservation.model }, 'Ollama model pull failed');

    if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
      throw new ApiError(504, `Model pull timed out after ${config.modelManagement.pullTimeoutMs} ms.`, 'MODEL_PULL_TIMEOUT');
    }

    if (axios.isAxiosError(error) && error.response) {
      throw new ApiError(502, `Ollama model pull failed with ${message}.`, 'MODEL_PULL_FAILED');
    }

    throw new ApiError(503, 'Could not reach Ollama to pull the model.', 'OLLAMA_UNAVAILABLE');
  } finally {
    modelPullsInFlight.delete(reservation.model);
  }
};

export const pullModel = async (model: string, onProgress?: (event: ModelPullProgressEvent) => void) => {
  const reservation = reserveModelPull(model);
  return runReservedModelPull(reservation, onProgress);
};

export const deleteModel = async (model: string) => {
  const validModel = assertValidModelName(model);
  assertNoPullInFlight(validModel);
  assertNoDeleteInFlight(validModel);

  if (modelLoadInFlight?.model === validModel) {
    throw new ApiError(409, `A load operation is already in progress for ${validModel}.`, 'MODEL_LOAD_IN_PROGRESS', {
      model: validModel,
      startedAt: modelLoadInFlight.startedAt
    });
  }

  modelDeletesInFlight.set(validModel, { startedAt: new Date().toISOString() });
  const startedAt = Date.now();

  try {
    logger.info({ model: validModel }, 'Ollama model delete requested');

    await axios.delete(`${config.llm.baseUrl}/api/delete`, {
      data: { model: validModel },
      timeout: config.modelManagement.deleteTimeoutMs,
      validateStatus: (status) => status >= 200 && status < 300
    });

    statusCache = null;
    const status = await getModelManagementStatus({ forceRefresh: true });
    logger.info({ model: validModel, durationMs: Date.now() - startedAt }, 'Ollama model delete completed');
    return status;
  } catch (error) {
    if (error instanceof ApiError) throw error;

    const message = sanitizedAxiosMessage(error, config.modelManagement.deleteTimeoutMs);
    logger.error({ errorMessage: message, model: validModel }, 'Ollama model delete failed');

    if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
      throw new ApiError(504, `Model delete timed out after ${config.modelManagement.deleteTimeoutMs} ms.`, 'MODEL_DELETE_TIMEOUT');
    }

    if (axios.isAxiosError(error) && error.response) {
      throw new ApiError(502, `Ollama model delete failed with ${message}.`, 'MODEL_DELETE_FAILED');
    }

    throw new ApiError(503, 'Could not reach Ollama to delete the model.', 'OLLAMA_UNAVAILABLE');
  } finally {
    modelDeletesInFlight.delete(validModel);
  }
};

export const resetModelSettingsCacheForTests = () => {
  runtimeDefaultModel = config.llm.model;
  statusCache = null;
  modelLoadInFlight = null;
  modelPullsInFlight.clear();
  modelDeletesInFlight.clear();
};
