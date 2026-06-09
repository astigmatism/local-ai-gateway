import fs from 'node:fs';
import axios from 'axios';
import FormData from 'form-data';
import { z } from 'zod';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../errors/apiError.js';
import { normalizeProviderModelForRuntime } from './ttsProviderDefaults.js';
import { maybeFormatTranscript } from './transcriptFormatter.js';
import { extractTranscriptText } from './transcriptionText.js';

type UnknownRecord = Record<string, unknown>;
type VoiceModelKind = 'stt' | 'tts';

export const ttsProviderIds = ['chatterbox', 'kokoro'] as const;
export type TtsProviderId = (typeof ttsProviderIds)[number];
export type TtsProviderState = 'unknown' | 'unloaded' | 'loading' | 'loaded' | 'failed';

export interface TtsProviderCapabilities {
  referenceAudio?: boolean;
  voiceSelection?: boolean;
  languageSelection?: boolean;
  speedControl?: boolean;
  streaming?: boolean;
  [key: string]: boolean | undefined;
}

export interface TtsProviderStatus {
  id: TtsProviderId;
  name?: string;
  displayName: string;
  reachable: boolean;
  active?: boolean;
  state: TtsProviderState;
  model?: string;
  voice?: string;
  workerPort?: number;
  capabilities: TtsProviderCapabilities;
  lastCheckedAt?: string;
  lastError?: string | null;
  raw?: unknown;
}

export interface TtsRegistryState {
  defaultProvider: TtsProviderId;
  providers: Record<TtsProviderId, TtsProviderStatus>;
  raw?: unknown;
}

const transcriptionResponseSchema = z
  .object({
    filename: z.string().optional(),
    model: z.string().optional(),
    defaultModel: z.string().optional(),
    default_model: z.string().optional(),
    activeModel: z.string().optional(),
    active_model: z.string().optional(),
    language: z.string().optional(),
    languageProbability: z.number().optional(),
    language_probability: z.number().optional(),
    vadFilter: z.boolean().optional(),
    vad_filter: z.boolean().optional(),
    minSilenceDurationMs: z.number().optional(),
    min_silence_duration_ms: z.number().optional(),
    beamSize: z.number().optional(),
    beam_size: z.number().optional(),
    wordTimestamps: z.boolean().optional(),
    word_timestamps: z.boolean().optional(),
    transcript: z.string().nullable().optional(),
    segments: z
      .array(
        z
          .object({
            start: z.number().optional(),
            end: z.number().optional(),
            text: z.string().nullable().optional()
          })
          .passthrough()
      )
      .optional(),
    words: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              word: z.string().nullable().optional(),
              text: z.string().nullable().optional()
            })
            .passthrough()
        ])
      )
      .optional()
  })
  .passthrough();

type RawTranscriptionResponse = z.infer<typeof transcriptionResponseSchema>;

export interface VoiceTranscribeOptions {
  model?: string;
  language?: string;
  vadFilter?: boolean;
  minSilenceDurationMs?: number;
  beamSize?: number;
  wordTimestamps?: boolean;
  timeoutMs?: number;
}

export interface VoiceTranscriptionSegment extends UnknownRecord {
  start?: number;
  end?: number;
  text?: string | null;
}

export interface NormalizedTranscribeResponse {
  filename?: string;
  model?: string;
  defaultModel?: string;
  activeModel?: string;
  language?: string;
  languageProbability?: number;
  vadFilter?: boolean;
  minSilenceDurationMs?: number;
  beamSize?: number;
  wordTimestamps?: boolean;
  transcript: string;
  segments: VoiceTranscriptionSegment[];
}

export interface VoiceTranscriptionResult extends NormalizedTranscribeResponse {
  metadata: Record<string, unknown>;
}

export interface VoiceSpeechOptions {
  provider?: TtsProviderId;
  text: string;
  voice?: string;
  speed?: number;
  exaggeration?: number;
  cfgWeight?: number;
  temperature?: number;
  language?: string;
  model?: string;
  referenceAudioId?: string;
  referenceAudioPath?: string;
  format?: 'wav';
  metadata?: Record<string, unknown>;
  referenceAudio?: {
    buffer: Buffer;
    filename: string;
    contentType?: string;
  };
  timeoutMs?: number;
}

export interface VoiceSpeechResult {
  audio: Buffer;
  contentType: string;
  headers: {
    engine?: string;
    voice?: string;
    speed?: string;
    model?: string;
    language?: string;
    provider?: string;
  };
}

export interface VoiceGpuDevice {
  index?: number;
  name?: string;
  driverVersion?: string;
  memoryTotalMiB?: number;
  memoryUsedMiB?: number;
  memoryFreeMiB?: number;
  utilizationGpuPercent?: number;
  temperatureC?: number;
  raw: unknown;
}

export interface VoiceGpuResponse {
  available: boolean;
  checkedAt?: string;
  devices: VoiceGpuDevice[];
  raw: unknown;
}

export interface VoiceModelDescriptor {
  id: string;
  label: string;
  provider?: string;
  model?: string;
  name?: string;
  language?: string;
  languages?: string[];
  description?: string;
  raw: unknown;
}

export interface VoiceProviderModelCatalog {
  provider: TtsProviderId;
  currentModel?: string;
  defaultModel?: string;
  activeModel?: string;
  loadedModel?: string;
  language?: string;
  status?: string;
  worker: UnknownRecord | null;
  models: VoiceModelDescriptor[];
  raw?: unknown;
}

export interface VoiceModelCatalogResponse {
  kind: VoiceModelKind;
  provider?: string;
  defaultModel?: string;
  activeModel?: string;
  loadedModel?: string;
  computeType?: string;
  language?: string;
  status?: string;
  worker: UnknownRecord | null;
  models: VoiceModelDescriptor[];
  providers?: Partial<Record<TtsProviderId, VoiceProviderModelCatalog>>;
  raw: unknown;
}

export interface VoiceModelsResponse {
  stt: VoiceModelCatalogResponse;
  tts: VoiceModelCatalogResponse;
  raw: unknown;
}

export interface VoiceConfigSection {
  defaultModel?: string;
  defaultProvider?: TtsProviderId;
  computeType?: string;
  language?: string;
  raw: UnknownRecord | null;
}

export interface VoiceConfigResponse {
  stt: VoiceConfigSection;
  tts: VoiceConfigSection;
  raw: unknown;
}

export interface VoiceDescriptor {
  id: string;
  label: string;
  provider?: string;
  model?: string;
  language?: string;
  description?: string;
  type?: string;
  raw: unknown;
}

export interface VoiceDescriptorsResponse {
  voices: VoiceDescriptor[];
  raw: unknown;
}

export interface DeleteReferenceAudioRequest {
  id: string;
  storedFilename?: string;
  path?: string;
  raw?: unknown;
}

export interface DeleteReferenceAudioResult {
  result: unknown;
  route: string;
  routeSource: 'descriptor' | 'bear-castle-fallback';
}

export interface SttLoadRequest {
  provider: string;
  model: string;
  computeType?: string;
  options?: UnknownRecord;
}

export interface TtsLoadRequest {
  provider: TtsProviderId;
  model: string;
  language?: string;
  options?: UnknownRecord;
}

export interface ModelUnloadRequest {
  strategy?: 'soft' | 'hard';
  clearCache?: boolean;
}

export interface TtsUnloadRequest extends ModelUnloadRequest {
  provider: TtsProviderId;
}

export interface UpdateSttConfigRequest {
  defaultModel?: string;
  computeType?: string;
}

export interface UpdateTtsConfigRequest {
  defaultProvider?: TtsProviderId;
  defaultModel?: string;
  language?: string;
}

const asRecord = (value: unknown): UnknownRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : null;

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
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'ok', 'healthy', 'available', 'up', 'online'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'error', 'failed', 'unavailable', 'down', 'offline'].includes(normalized)) return false;
  }
  return undefined;
};

const firstString = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = cleanString(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const firstNumber = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = cleanNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const firstBoolean = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = cleanBoolean(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const firstArray = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = asArray(value);
    if (parsed) return parsed;
  }
  return undefined;
};

const firstRecord = (...values: unknown[]) => {
  for (const value of values) {
    const parsed = asRecord(value);
    if (parsed) return parsed;
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

export const isTtsProviderId = (value: unknown): value is TtsProviderId =>
  typeof value === 'string' && (ttsProviderIds as readonly string[]).includes(value.trim().toLowerCase());

export const ttsProviderDisplayName = (provider: TtsProviderId) =>
  provider === 'kokoro' ? 'Kokoro' : 'Chatterbox TTS';

const normalizeTtsProviderDisplayName = (provider: TtsProviderId, ...values: unknown[]) => {
  const displayName = firstString(...values);
  if (provider === 'kokoro') return 'Kokoro';
  if (!displayName || displayName.trim().toLowerCase() === 'chatterbox') return 'Chatterbox TTS';
  return displayName;
};

export const normalizeTtsProviderId = (value: unknown): TtsProviderId | undefined => {
  const parsed = cleanString(value)?.toLowerCase();
  if (!parsed) return undefined;
  if (parsed === 'chatterbox' || parsed.includes('chatterbox')) return 'chatterbox';
  if (parsed === 'kokoro' || parsed.includes('kokoro')) return 'kokoro';
  return undefined;
};

const firstTtsProvider = (...values: unknown[]) => {
  for (const value of values) {
    const provider = normalizeTtsProviderId(value);
    if (provider) return provider;
  }
  return undefined;
};

const ttsProviderStateValues: readonly TtsProviderState[] = ['unknown', 'unloaded', 'loading', 'loaded', 'failed'];

const normalizeTtsProviderState = (...values: unknown[]): TtsProviderState => {
  for (const value of values) {
    const parsed = cleanString(value)?.toLowerCase();
    if (!parsed) continue;
    if ((ttsProviderStateValues as readonly string[]).includes(parsed)) return parsed as TtsProviderState;
    if (['ready', 'running', 'active', 'available', 'healthy', 'online'].includes(parsed)) return 'loaded';
    if (['disabled', 'off', 'stopped', 'inactive'].includes(parsed)) return 'unloaded';
    if (['starting', 'initializing', 'warming'].includes(parsed)) return 'loading';
    if (['error', 'unhealthy', 'unreachable', 'down'].includes(parsed)) return 'failed';
  }
  return 'unknown';
};

const normalizeTtsCapabilities = (value: unknown, provider: TtsProviderId): TtsProviderCapabilities => {
  const record = asRecord(value) ?? {};
  const capabilities: TtsProviderCapabilities = {
    referenceAudio: firstBoolean(record.referenceAudio, record.reference_audio, record.voiceCloning, record.voice_cloning),
    voiceSelection: firstBoolean(record.voiceSelection, record.voice_selection, record.voices, record.voice),
    languageSelection: firstBoolean(record.languageSelection, record.language_selection, record.languages, record.language),
    speedControl: firstBoolean(record.speedControl, record.speed_control, record.speed),
    streaming: firstBoolean(record.streaming)
  };

  for (const [key, rawValue] of Object.entries(record)) {
    const parsed = cleanBoolean(rawValue);
    if (parsed !== undefined && capabilities[key] === undefined) capabilities[key] = parsed;
  }

  return stripUndefinedFields({
    ...capabilities,
    referenceAudio: capabilities.referenceAudio ?? provider === 'chatterbox',
    voiceSelection: capabilities.voiceSelection ?? true,
    languageSelection: capabilities.languageSelection ?? true,
    speedControl: capabilities.speedControl ?? true,
    streaming: capabilities.streaming
  });
};

const normalizeTtsProviderStatus = (provider: TtsProviderId, value: unknown): TtsProviderStatus => {
  const record = asRecord(value) ?? {};
  const worker = firstRecord(record.worker, record.service, record.health, record.workerHealth, record.worker_health) ?? {};
  const state = normalizeTtsProviderState(record.state, record.status, worker.state, worker.status, record.loaded);
  const reachable =
    firstBoolean(record.reachable, record.available, record.ok, record.healthy, worker.reachable, worker.available, worker.ok, worker.healthy) ??
    (state === 'loaded' || state === 'loading');

  return stripUndefinedFields({
    id: provider,
    name: firstString(record.name, record.providerName, record.provider_name),
    displayName: normalizeTtsProviderDisplayName(provider, record.displayName, record.display_name, record.name),
    reachable,
    active: firstBoolean(record.active, record.enabled),
    state,
    model: firstString(record.model, record.currentModel, record.current_model, record.loadedModel, record.loaded_model, worker.model),
    voice: firstString(record.voice, record.defaultVoice, record.default_voice),
    workerPort: firstNumber(record.workerPort, record.worker_port, worker.port),
    capabilities: normalizeTtsCapabilities(record.capabilities, provider),
    lastCheckedAt: firstString(record.lastCheckedAt, record.last_checked_at, record.checkedAt, record.checked_at, record.timestamp),
    lastError: firstString(record.lastError, record.last_error, record.error, worker.error) ?? null,
    raw: value
  });
};

const defaultTtsProviderStatus = (provider: TtsProviderId): TtsProviderStatus => ({
  id: provider,
  displayName: ttsProviderDisplayName(provider),
  reachable: false,
  state: 'unknown',
  capabilities: normalizeTtsCapabilities(undefined, provider)
});

export const normalizeTtsRegistry = (payload: unknown): TtsRegistryState => {
  const root = asRecord(payload) ?? {};
  const providerEntries = new Map<TtsProviderId, unknown>();
  const providersValue = firstArray(root.providers, root.items, root.ttsProviders, root.tts_providers);
  if (providersValue) {
    for (const item of providersValue) {
      const record = asRecord(item);
      const provider = firstTtsProvider(record?.id, record?.provider, record?.name, record?.displayName, record?.display_name);
      if (provider) providerEntries.set(provider, item);
    }
  }

  const providerRecord = firstRecord(root.providers, root.ttsProviders, root.tts_providers);
  if (providerRecord) {
    for (const [key, value] of Object.entries(providerRecord)) {
      const provider = normalizeTtsProviderId(key) ?? firstTtsProvider(asRecord(value)?.id, asRecord(value)?.provider);
      if (provider) providerEntries.set(provider, value);
    }
  }

  for (const provider of ttsProviderIds) {
    const direct = firstRecord(root[provider], readPath(root, ['providers', provider]));
    if (direct) providerEntries.set(provider, direct);
  }

  const providers = Object.fromEntries(
    ttsProviderIds.map((provider) => [
      provider,
      providerEntries.has(provider)
        ? normalizeTtsProviderStatus(provider, providerEntries.get(provider))
        : defaultTtsProviderStatus(provider)
    ])
  ) as Record<TtsProviderId, TtsProviderStatus>;

  return {
    defaultProvider: firstTtsProvider(root.defaultProvider, root.default_provider, root.provider) ?? config.tts.defaultProvider,
    providers,
    raw: payload
  };
};

const responseDataSummary = (data: unknown) => {
  const record = asRecord(data);
  if (!record) return typeof data;
  const maybeError = asRecord(record.error);
  return {
    keys: Object.keys(record).slice(0, 12),
    errorCode: firstString(maybeError?.code, record.code),
    errorMessage: firstString(maybeError?.message, record.message)?.slice(0, 240)
  };
};

const voiceResponseErrorMessage = (data: unknown) => {
  const record = asRecord(data);
  if (!record) return undefined;
  const maybeError = asRecord(record.error);

  return firstString(
    maybeError?.message,
    maybeError?.detail,
    maybeError?.description,
    record.message,
    record.detail,
    record.error,
    record.reason
  )?.slice(0, 240);
};

const readHeader = (headers: unknown, name: string) => {
  if (!headers || typeof headers !== 'object') return undefined;

  const maybeGetter = headers as { get?: (headerName: string) => unknown };
  if (typeof maybeGetter.get === 'function') {
    const value = maybeGetter.get(name);
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.join(', ');
    if (value !== undefined && value !== null) return String(value);
  }

  const record = headers as Record<string, unknown>;
  const value = record[name.toLowerCase()] ?? record[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  if (value !== undefined && value !== null) return String(value);
  return undefined;
};

const voiceErrorStatusCode = (error: unknown) => {
  if (!axios.isAxiosError(error)) return 500;
  if (error.code === 'ECONNABORTED') return 504;
  if (error.response) {
    const status = error.response.status;
    if ([400, 413, 415, 422, 500, 502, 503, 504].includes(status)) return status;
    return status >= 500 ? 502 : 502;
  }
  return 503;
};

const voiceErrorCode = (error: unknown, prefix: string) => {
  if (!axios.isAxiosError(error)) return `${prefix}_FAILED`;
  if (error.code === 'ECONNABORTED') return `${prefix}_TIMEOUT`;
  if (error.response?.status === 404) return `${prefix}_ROUTE_UNAVAILABLE`;
  if (error.response?.status === 413) return `${prefix}_UPLOAD_TOO_LARGE`;
  if (error.response?.status === 415) return `${prefix}_UNSUPPORTED_MEDIA_TYPE`;
  if (error.response?.status === 400 || error.response?.status === 422) return `${prefix}_VALIDATION_FAILED`;
  if (error.response) return `${prefix}_SERVICE_FAILED`;
  return `${prefix}_SERVICE_UNAVAILABLE`;
};

const voiceErrorMessage = (error: unknown, operation: string, timeoutMs: number) => {
  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED') return `${operation} timed out after ${timeoutMs} ms.`;
    if (error.response?.status === 404) {
      return `${operation} failed because the local-ai-voice gateway did not expose the requested modern /api route.`;
    }
    if (error.response) {
      const serviceMessage = voiceResponseErrorMessage(error.response.data);
      const suffix = serviceMessage ? `: ${serviceMessage}` : ` with HTTP ${error.response.status}`;
      if ([400, 413, 415, 422].includes(error.response.status)) {
        return `${operation} was rejected by the local-ai-voice gateway${suffix}.`;
      }
      return `${operation} failed${suffix}.`;
    }
    return `${operation} could not reach the local-ai-voice gateway.`;
  }

  return `${operation} failed.`;
};

const throwVoiceApiError = (error: unknown, operation: string, codePrefix: string, timeoutMs: number): never => {
  const message = voiceErrorMessage(error, operation, timeoutMs);
  logger.warn(
    {
      errorMessage: message,
      errorCode: axios.isAxiosError(error) ? error.code : undefined,
      responseStatus: axios.isAxiosError(error) ? error.response?.status : undefined,
      responseData: axios.isAxiosError(error) ? responseDataSummary(error.response?.data) : undefined,
      voiceBaseUrl: config.voice.baseUrl
    },
    'Voice VM API request failed'
  );

  throw new ApiError(voiceErrorStatusCode(error), message, voiceErrorCode(error, codePrefix));
};

const getJson = async <T = unknown>(path: string, operation: string, timeoutMs = config.voice.timeoutMs): Promise<T> => {
  try {
    const response = await axios.get(`${config.voice.baseUrl}${path}`, {
      timeout: timeoutMs,
      validateStatus: (status) => status >= 200 && status < 300
    });
    return response.data as T;
  } catch (error) {
    return throwVoiceApiError(error, operation, 'VOICE_API', timeoutMs);
  }
};

const sendJson = async <T = unknown>(
  method: 'post' | 'patch',
  path: string,
  body: unknown,
  operation: string,
  timeoutMs = config.voice.timeoutMs
): Promise<T> => {
  try {
    const response = await axios.request({
      method,
      url: `${config.voice.baseUrl}${path}`,
      data: body,
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: (status) => status >= 200 && status < 300,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });
    return response.data as T;
  } catch (error) {
    return throwVoiceApiError(error, operation, 'VOICE_API', timeoutMs);
  }
};

const postForm = async <T = unknown>(
  path: string,
  form: FormData,
  operation: string,
  timeoutMs = config.voice.timeoutMs
): Promise<T> => {
  try {
    const response = await axios.post(`${config.voice.baseUrl}${path}`, form, {
      headers: form.getHeaders(),
      timeout: timeoutMs,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: (status) => status >= 200 && status < 300
    });
    return response.data as T;
  } catch (error) {
    return throwVoiceApiError(error, operation, 'VOICE_API', timeoutMs);
  }
};

const normalizeGpuDevice = (device: unknown): VoiceGpuDevice => {
  const record = asRecord(device) ?? {};
  return {
    index: firstNumber(record.index, record.gpuIndex),
    name: firstString(record.name, record.gpu_name, record.gpuName, record.product_name, record.productName),
    driverVersion: firstString(record.driverVersion, record.driver_version, record.driver),
    memoryTotalMiB: firstNumber(
      record.memoryTotalMiB,
      record.memoryTotalMib,
      record.memory_total_mib,
      record.memory_total_mb,
      readPath(record, ['memory', 'totalMiB']),
      readPath(record, ['memory', 'totalMib']),
      readPath(record, ['memory', 'total_mib'])
    ),
    memoryUsedMiB: firstNumber(
      record.memoryUsedMiB,
      record.memoryUsedMib,
      record.memory_used_mib,
      record.memory_used_mb,
      readPath(record, ['memory', 'usedMiB']),
      readPath(record, ['memory', 'usedMib']),
      readPath(record, ['memory', 'used_mib'])
    ),
    memoryFreeMiB: firstNumber(
      record.memoryFreeMiB,
      record.memoryFreeMib,
      record.memory_free_mib,
      record.memory_free_mb,
      readPath(record, ['memory', 'freeMiB']),
      readPath(record, ['memory', 'freeMib']),
      readPath(record, ['memory', 'free_mib'])
    ),
    utilizationGpuPercent: firstNumber(
      record.utilizationGpuPercent,
      record.utilization_gpu_percent,
      record.gpu_utilization_percent,
      readPath(record, ['utilization', 'gpuPercent']),
      readPath(record, ['utilization', 'gpu_percent']),
      readPath(record, ['utilization', 'gpu'])
    ),
    temperatureC: firstNumber(
      record.temperatureC,
      record.temperature_gpu_c,
      record.temperature_c,
      readPath(record, ['temperature', 'c']),
      readPath(record, ['temperature', 'gpuC']),
      readPath(record, ['temperature', 'gpu_c'])
    ),
    raw: device
  };
};

export const normalizeVoiceGpuResponse = (payload: unknown): VoiceGpuResponse => {
  const root = asRecord(payload) ?? {};
  const deviceInputs = firstArray(root.devices, root.gpus, root.cards) ?? [];
  const devices = deviceInputs.map(normalizeGpuDevice);
  const fallbackDevice = devices.length === 0 && Object.keys(root).length > 0 ? normalizeGpuDevice(root) : null;
  const useFallbackDevice =
    fallbackDevice !== null &&
    (fallbackDevice.name !== undefined ||
      fallbackDevice.memoryTotalMiB !== undefined ||
      fallbackDevice.memoryUsedMiB !== undefined ||
      fallbackDevice.utilizationGpuPercent !== undefined ||
      fallbackDevice.temperatureC !== undefined);
  const normalizedDevices = useFallbackDevice ? [fallbackDevice] : devices;
  const available = firstBoolean(root.available, root.ok, root.healthy) ?? normalizedDevices.length > 0;

  return {
    available,
    checkedAt: firstString(root.checkedAt, root.checked_at, root.timestamp),
    devices: normalizedDevices,
    raw: payload
  };
};

const normalizeCatalogItem = (item: unknown): VoiceModelDescriptor | null => {
  if (typeof item === 'string') {
    const id = item.trim();
    return id ? { id, label: id, model: id, name: id, raw: item } : null;
  }

  const record = asRecord(item);
  if (!record) return null;

  const model = firstString(record.model, record.name, record.id, record.value);
  const id = firstString(record.id, model, record.slug);
  if (!id) return null;

  const languages = asArray(record.languages)?.filter((value): value is string => typeof value === 'string');

  return {
    id,
    label: firstString(record.label, record.displayName, record.display_name, model, id) ?? id,
    provider: normalizeTtsProviderId(record.provider) ?? firstString(record.provider),
    model,
    name: firstString(record.name, model),
    language: firstString(record.language),
    languages,
    description: firstString(record.description, record.summary),
    raw: item
  };
};

const normalizeVoiceDescriptor = (item: unknown): VoiceDescriptor | null => {
  if (typeof item === 'string') {
    const id = item.trim();
    return id ? { id, label: id, raw: item } : null;
  }

  const record = asRecord(item);
  if (!record) return null;
  const id = firstString(record.id, record.voice, record.name, record.reference, record.referenceId, record.reference_id, record.model);
  if (!id) return null;

  return {
    id,
    label: firstString(record.label, record.displayName, record.display_name, record.name, record.voice, id) ?? id,
    provider: normalizeTtsProviderId(record.provider) ?? firstString(record.provider),
    model: firstString(record.model),
    language: firstString(record.language),
    description: firstString(record.description, record.summary),
    type: firstString(record.type, record.kind),
    raw: item
  };
};

const catalogRootForKind = (payload: unknown, kind: VoiceModelKind) => {
  const root = asRecord(payload);
  if (!root) return payload;
  return asRecord(root[kind]) ?? asRecord(root[`${kind}Models`]) ?? asRecord(root[`${kind}_models`]) ?? root;
};

const normalizeTtsProviderModelCatalog = (
  provider: TtsProviderId,
  value: unknown,
  fallbackModels: VoiceModelDescriptor[] = []
): VoiceProviderModelCatalog => {
  const record = asRecord(value) ?? {};
  const statusRecord = firstRecord(record.status, record.modelStatus, record.model_status, record.state, record.workerState, record.worker_state);
  const worker = firstRecord(record.worker, record.service, record.health, record.workerHealth, record.worker_health, statusRecord) ?? null;
  const modelList =
    firstArray(
      record.models,
      record.catalog,
      record.availableModels,
      record.available_models,
      record.available,
      record.items,
      readPath(record, ['catalog', 'models'])
    ) ?? [];
  const scopedModels = modelList
    .map(normalizeCatalogItem)
    .filter((model): model is VoiceModelDescriptor => model !== null)
    .map((model) => ({ ...model, provider }));
  const models = scopedModels.length > 0 ? scopedModels : fallbackModels.filter((model) => normalizeTtsProviderId(model.provider) === provider);
  const loadedModel = firstString(
    record.loadedModel,
    record.loaded_model,
    record.currentModel,
    record.current_model,
    statusRecord?.loadedModel,
    statusRecord?.loaded_model,
    statusRecord?.currentModel,
    statusRecord?.current_model,
    worker?.model
  );
  const activeModel = firstString(record.activeModel, record.active_model, statusRecord?.activeModel, statusRecord?.active_model);
  const defaultModel = firstString(record.defaultModel, record.default_model, statusRecord?.defaultModel, statusRecord?.default_model);

  return stripUndefinedFields({
    provider,
    currentModel: firstString(record.currentModel, record.current_model, activeModel, loadedModel, defaultModel),
    defaultModel,
    activeModel,
    loadedModel,
    language: firstString(record.language, statusRecord?.language),
    status: firstString(record.status, record.state, statusRecord?.status, statusRecord?.state, worker?.status, worker?.state),
    worker,
    models,
    raw: value
  });
};

const normalizeTtsProviderModelCatalogs = (
  root: UnknownRecord,
  models: VoiceModelDescriptor[]
): Partial<Record<TtsProviderId, VoiceProviderModelCatalog>> => {
  const providerValues = new Map<TtsProviderId, unknown>();
  const providerArray = firstArray(root.providers, root.items, root.ttsProviders, root.tts_providers);
  if (providerArray) {
    for (const item of providerArray) {
      const record = asRecord(item);
      const provider = firstTtsProvider(record?.id, record?.provider, record?.name, record?.displayName, record?.display_name);
      if (provider) providerValues.set(provider, item);
    }
  }

  const providerRecord = firstRecord(root.providers, root.ttsProviders, root.tts_providers);
  if (providerRecord) {
    for (const [key, value] of Object.entries(providerRecord)) {
      const provider = normalizeTtsProviderId(key) ?? firstTtsProvider(asRecord(value)?.id, asRecord(value)?.provider);
      if (provider) providerValues.set(provider, value);
    }
  }

  for (const provider of ttsProviderIds) {
    const direct = firstRecord(root[provider], root[`${provider}Models`], root[`${provider}_models`]);
    if (direct) providerValues.set(provider, direct);
  }

  const byProvider = Object.fromEntries(
    ttsProviderIds.flatMap((provider) => {
      const fallbackModels = models.filter((model) => normalizeTtsProviderId(model.provider) === provider);
      if (!providerValues.has(provider) && fallbackModels.length === 0) return [];
      return [[provider, normalizeTtsProviderModelCatalog(provider, providerValues.get(provider) ?? { models: fallbackModels }, fallbackModels)]];
    })
  ) as Partial<Record<TtsProviderId, VoiceProviderModelCatalog>>;

  return byProvider;
};

export const normalizeVoiceModelCatalog = (kind: VoiceModelKind, payload: unknown): VoiceModelCatalogResponse => {
  const rootValue = catalogRootForKind(payload, kind);
  const root = asRecord(rootValue) ?? {};
  const statusRecord = firstRecord(root.status, root.modelStatus, root.model_status, root.state, root.workerState, root.worker_state);
  const worker = firstRecord(root.worker, root.service, root.health, root.workerHealth, root.worker_health, statusRecord) ?? null;
  const modelList =
    firstArray(
      root.models,
      root.catalog,
      root.availableModels,
      root.available_models,
      root.available,
      root.items,
      readPath(root, ['catalog', 'models'])
    ) ?? (Array.isArray(rootValue) ? rootValue : []);
  const models = modelList.map(normalizeCatalogItem).filter((model): model is VoiceModelDescriptor => model !== null);

  const rootProvider = normalizeTtsProviderId(root.provider);
  const normalizedModels = kind === 'tts' && rootProvider ? models.map((model) => ({ ...model, provider: model.provider ?? rootProvider })) : models;

  return {
    kind,
    provider: normalizeTtsProviderId(root.provider) ?? firstString(root.provider, statusRecord?.provider, worker?.provider),
    defaultModel: firstString(root.defaultModel, root.default_model, statusRecord?.defaultModel, statusRecord?.default_model),
    activeModel: firstString(root.activeModel, root.active_model, statusRecord?.activeModel, statusRecord?.active_model),
    loadedModel: firstString(root.loadedModel, root.loaded_model, statusRecord?.loadedModel, statusRecord?.loaded_model, worker?.model),
    computeType: firstString(root.computeType, root.compute_type, statusRecord?.computeType, statusRecord?.compute_type),
    language: firstString(root.language, statusRecord?.language),
    status: firstString(root.status, root.state, worker?.status, worker?.state),
    worker,
    models: normalizedModels,
    ...(kind === 'tts' ? { providers: normalizeTtsProviderModelCatalogs(root, normalizedModels) } : {}),
    raw: payload
  };
};

export const normalizeVoiceModels = (payload: unknown): VoiceModelsResponse => ({
  stt: normalizeVoiceModelCatalog('stt', payload),
  tts: normalizeVoiceModelCatalog('tts', payload),
  raw: payload
});

export const normalizeVoiceConfig = (payload: unknown): VoiceConfigResponse => {
  const root = asRecord(payload) ?? {};
  const stt = firstRecord(root.stt, root.sttConfig, root.stt_config, readPath(root, ['config', 'stt'])) ?? null;
  const tts = firstRecord(root.tts, root.ttsConfig, root.tts_config, readPath(root, ['config', 'tts'])) ?? null;

  return {
    stt: {
      defaultModel: firstString(stt?.defaultModel, stt?.default_model, root.defaultSttModel, root.default_stt_model),
      computeType: firstString(stt?.computeType, stt?.compute_type, root.sttComputeType, root.stt_compute_type),
      raw: stt
    },
    tts: {
      defaultProvider:
        firstTtsProvider(tts?.defaultProvider, tts?.default_provider, root.defaultTtsProvider, root.default_tts_provider) ??
        config.tts.defaultProvider,
      defaultModel: firstString(tts?.defaultModel, tts?.default_model, root.defaultTtsModel, root.default_tts_model),
      language: firstString(tts?.language, root.ttsLanguage, root.tts_language),
      raw: tts
    },
    raw: payload
  };
};

export const normalizeVoiceDescriptors = (payload: unknown): VoiceDescriptorsResponse => {
  const root = asRecord(payload) ?? {};
  const list =
    firstArray(root.voices, root.references, root.referenceAudio, root.reference_audio, root.descriptors, root.items, root.catalog) ??
    (Array.isArray(payload) ? payload : []);
  return {
    voices: list.map(normalizeVoiceDescriptor).filter((voice): voice is VoiceDescriptor => voice !== null),
    raw: payload
  };
};

const addOptionalFormField = (form: FormData, key: string, value: string | number | boolean | undefined) => {
  if (value !== undefined) form.append(key, String(value));
};

const stripUndefinedFields = <T extends Record<string, unknown>>(record: T) => {
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) delete record[key];
  }
  return record;
};

export const normalizeVoiceTranscriptionResponse = (
  parsed: RawTranscriptionResponse,
  transcript: string
): NormalizedTranscribeResponse => {
  const segments = (parsed.segments ?? []) as VoiceTranscriptionSegment[];

  return stripUndefinedFields({
    filename: parsed.filename,
    model: parsed.model,
    defaultModel: parsed.defaultModel ?? parsed.default_model,
    activeModel: parsed.activeModel ?? parsed.active_model,
    language: parsed.language,
    languageProbability: parsed.languageProbability ?? parsed.language_probability,
    vadFilter: parsed.vadFilter ?? parsed.vad_filter,
    minSilenceDurationMs: parsed.minSilenceDurationMs ?? parsed.min_silence_duration_ms,
    beamSize: parsed.beamSize ?? parsed.beam_size,
    wordTimestamps: parsed.wordTimestamps ?? parsed.word_timestamps,
    transcript,
    segments
  });
};

const runtimeSpeechModel = (options: VoiceSpeechOptions) =>
  options.provider
    ? normalizeProviderModelForRuntime(options.provider, options.model)
    : options.model;

export const buildVoiceSpeechJsonBody = (options: VoiceSpeechOptions) => {
  const includeChatterboxFields = options.provider !== 'kokoro';
  return stripUndefinedFields({
    provider: options.provider,
    text: options.text,
    voice: options.voice,
    speed: options.speed,
    language: options.language,
    model: runtimeSpeechModel(options),
    format: options.format,
    metadata: options.metadata,
    exaggeration: includeChatterboxFields ? options.exaggeration : undefined,
    cfg_weight: includeChatterboxFields ? options.cfgWeight : undefined,
    temperature: includeChatterboxFields ? options.temperature : undefined,
    referenceAudioId: includeChatterboxFields ? options.referenceAudioId : undefined,
    referenceAudioPath: includeChatterboxFields ? options.referenceAudioPath : undefined
  });
};

export const speakText = async (options: VoiceSpeechOptions): Promise<VoiceSpeechResult> => {
  const timeoutMs = options.timeoutMs ?? config.tts.timeoutMs;
  const startedAt = Date.now();

  if (options.provider === 'kokoro' && (options.referenceAudio || options.referenceAudioId || options.referenceAudioPath)) {
    throw new ApiError(400, 'Kokoro does not support Chatterbox reference audio.', 'TTS_REFERENCE_AUDIO_UNSUPPORTED');
  }

  try {
    const response = options.referenceAudio
      ? await (() => {
          const form = new FormData();
          addOptionalFormField(form, 'provider', options.provider);
          form.append('text', options.text);
          addOptionalFormField(form, 'voice', options.voice);
          addOptionalFormField(form, 'speed', options.speed);
          addOptionalFormField(form, 'exaggeration', options.exaggeration);
          addOptionalFormField(form, 'cfg_weight', options.cfgWeight);
          addOptionalFormField(form, 'temperature', options.temperature);
          addOptionalFormField(form, 'language', options.language);
          addOptionalFormField(form, 'model', runtimeSpeechModel(options));
          addOptionalFormField(form, 'referenceAudioId', options.referenceAudioId);
          addOptionalFormField(form, 'referenceAudioPath', options.referenceAudioPath);
          addOptionalFormField(form, 'format', options.format);
          form.append('reference_audio', options.referenceAudio.buffer, {
            filename: options.referenceAudio.filename || 'reference.wav',
            contentType: options.referenceAudio.contentType || 'audio/wav'
          });
          return axios.post(`${config.voice.baseUrl}/api/tts/speak`, form, {
            headers: { ...form.getHeaders(), Accept: 'audio/wav' },
            timeout: timeoutMs,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            responseType: 'arraybuffer',
            validateStatus: (status) => status >= 200 && status < 300
          });
        })()
      : await axios.post(`${config.voice.baseUrl}/api/tts/speak`, buildVoiceSpeechJsonBody(options), {
          headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
          timeout: timeoutMs,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          responseType: 'arraybuffer',
          validateStatus: (status) => status >= 200 && status < 300
        });

    const audio = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);

    if (audio.byteLength === 0) {
      throw new ApiError(502, 'Voice text-to-speech returned empty audio.', 'TTS_EMPTY_AUDIO');
    }

    const contentType = readHeader(response.headers, 'content-type') || 'audio/wav';
    const headers = {
      engine: readHeader(response.headers, 'x-tts-engine'),
      voice: readHeader(response.headers, 'x-tts-voice'),
      speed: readHeader(response.headers, 'x-tts-speed'),
      model: readHeader(response.headers, 'x-tts-model'),
      language: readHeader(response.headers, 'x-tts-language'),
      provider: readHeader(response.headers, 'x-tts-provider') ?? options.provider
    };

    logger.info(
      {
        event: 'tts.speak',
        provider: options.provider ?? 'default',
        textLength: options.text.length,
        voice: options.voice,
        model: options.model,
        language: options.language,
        speed: options.speed,
        referenceAudioProvided: options.referenceAudio !== undefined || options.referenceAudioId !== undefined,
        status: 200,
        durationMs: Date.now() - startedAt,
        audioBytes: audio.byteLength,
        fallbackUsed: false,
        contentType,
        ttsEngine: headers.engine
      },
      'Voice text-to-speech completed'
    );

    return {
      audio,
      contentType,
      headers
    } satisfies VoiceSpeechResult;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return throwVoiceApiError(error, `Voice text-to-speech provider ${options.provider ?? 'default'}`, 'TTS', timeoutMs);
  }
};

export const transcribeAudio = async (
  filePath: string,
  originalFilename: string,
  mimeType?: string,
  options: VoiceTranscribeOptions = {}
): Promise<VoiceTranscriptionResult> => {
  const timeoutMs = options.timeoutMs ?? config.voice.timeoutMs;
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: originalFilename || 'recording.webm',
    contentType: mimeType || 'application/octet-stream'
  });
  addOptionalFormField(form, 'model', options.model);
  addOptionalFormField(form, 'language', options.language);
  addOptionalFormField(form, 'vad_filter', options.vadFilter);
  addOptionalFormField(form, 'min_silence_duration_ms', options.minSilenceDurationMs);
  addOptionalFormField(form, 'beam_size', options.beamSize);
  addOptionalFormField(form, 'word_timestamps', options.wordTimestamps);

  try {
    const response = await axios.post(`${config.voice.baseUrl}/api/stt/transcribe`, form, {
      headers: form.getHeaders(),
      timeout: timeoutMs,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: (status) => status >= 200 && status < 300
    });

    const parseResult = transcriptionResponseSchema.safeParse(response.data);
    if (!parseResult.success) {
      throw new ApiError(502, 'Voice transcription returned an unexpected response shape.', 'VOICE_TRANSCRIPTION_INVALID_RESPONSE', {
        issues: parseResult.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      });
    }

    const parsed = parseResult.data;
    const extracted = extractTranscriptText(parsed);

    if (!extracted.transcript) {
      throw new ApiError(502, 'Voice service returned an empty transcript.', 'VOICE_EMPTY_TRANSCRIPT', {
        filename: originalFilename,
        transcriptSource: extracted.source
      });
    }

    const formatting = await maybeFormatTranscript(extracted.transcript);
    const finalTranscript = formatting.transcript.trim();

    if (!finalTranscript) {
      throw new ApiError(502, 'Voice service returned an empty transcript.', 'VOICE_EMPTY_TRANSCRIPT', {
        filename: originalFilename,
        transcriptSource: extracted.source
      });
    }

    const normalizedResponse = normalizeVoiceTranscriptionResponse(parsed, finalTranscript);
    const serviceMetadata: Record<string, unknown> = { ...parsed };
    delete serviceMetadata.transcript;

    const normalizedMetadata: Record<string, unknown> = {
      filename: normalizedResponse.filename,
      model: normalizedResponse.model,
      defaultModel: normalizedResponse.defaultModel,
      activeModel: normalizedResponse.activeModel,
      language: normalizedResponse.language,
      languageProbability: normalizedResponse.languageProbability,
      vadFilter: normalizedResponse.vadFilter,
      minSilenceDurationMs: normalizedResponse.minSilenceDurationMs,
      beamSize: normalizedResponse.beamSize,
      wordTimestamps: normalizedResponse.wordTimestamps
    };

    for (const [key, value] of Object.entries(normalizedMetadata)) {
      if (value === undefined) delete normalizedMetadata[key];
    }

    const transcriptMetadata: Record<string, unknown> = {
      ...serviceMetadata,
      ...normalizedMetadata,
      transcriptSource: extracted.source,
      transcriptFormatting: formatting.metadata,
      transcribedAt: new Date().toISOString()
    };

    if (extracted.segmentCount !== undefined) transcriptMetadata.transcriptSegmentCount = extracted.segmentCount;
    if (extracted.wordCount !== undefined) transcriptMetadata.transcriptWordCount = extracted.wordCount;
    if (formatting.metadata.applied) transcriptMetadata.rawTranscript = extracted.transcript;

    logger.info(
      {
        transcriptSource: extracted.source,
        rawTranscriptLength: extracted.transcript.length,
        finalTranscriptLength: finalTranscript.length,
        transcriptFormattingApplied: formatting.metadata.applied,
        model: parsed.model,
        defaultModel: normalizedMetadata.defaultModel,
        activeModel: normalizedMetadata.activeModel
      },
      'Voice transcription completed'
    );

    return {
      ...normalizedResponse,
      metadata: transcriptMetadata
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return throwVoiceApiError(error, 'Voice transcription', 'VOICE_TRANSCRIPTION', timeoutMs);
  }
};

export const getVoiceHealth = () => getJson('/api/health', 'Voice health');
export const getVoiceSystem = () => getJson('/api/system', 'Voice system status');
export const getVoiceServices = () => getJson('/api/services', 'Voice worker services status');
export const getVoiceSttService = () => getJson('/api/services/stt', 'Voice STT service status');
export const getVoiceTtsService = async () => normalizeTtsRegistry(await getJson('/api/services/tts', 'Voice TTS service status'));
export const getVoiceLogs = () => getJson('/api/logs', 'Voice logs');

export const getVoiceGpu = async () => normalizeVoiceGpuResponse(await getJson('/api/gpu', 'Voice GPU telemetry'));

export const getVoiceModels = async () => normalizeVoiceModels(await getJson('/api/models', 'Voice model catalog'));
export const getVoiceSttModels = async () =>
  normalizeVoiceModelCatalog('stt', await getJson('/api/models/stt', 'Voice STT model catalog'));
export const getVoiceTtsModels = async () =>
  normalizeVoiceModelCatalog('tts', await getJson('/api/models/tts', 'Voice TTS model catalog'));
export const getVoiceConfig = async () => normalizeVoiceConfig(await getJson('/api/config', 'Voice runtime configuration'));
export const listVoiceDescriptors = async () => normalizeVoiceDescriptors(await getJson('/voices', 'Voice descriptors'));

export const loadVoiceSttModel = (body: SttLoadRequest) =>
  sendJson('post', '/api/models/stt/load', body, 'Load STT model');

export const unloadVoiceSttModel = (body: ModelUnloadRequest) =>
  sendJson('post', '/api/models/stt/unload', body, 'Unload STT model');

export const loadVoiceTtsModel = (body: TtsLoadRequest) =>
  sendJson('post', '/api/models/tts/load', body, 'Load TTS model');

export const unloadVoiceTtsModel = (body: TtsUnloadRequest) =>
  sendJson('post', '/api/models/tts/unload', body, 'Unload TTS model');

export const reloadVoiceTtsModel = (body: Partial<TtsLoadRequest> & { provider: TtsProviderId }) =>
  sendJson('post', '/api/models/tts/reload', body, 'Reload TTS provider');

export const updateVoiceSttConfig = (body: UpdateSttConfigRequest) =>
  sendJson('patch', '/api/config/stt', body, 'Update STT configuration');

export const updateVoiceTtsConfig = (body: UpdateTtsConfigRequest) =>
  sendJson('patch', '/api/config/tts', body, 'Update TTS configuration');

const sanitizeRouteSegment = (value: string) => encodeURIComponent(value).replace(/%2F/gi, '%252F');

const uniqueReferenceDeleteCandidates = (
  candidates: Array<{ path: string; body?: UnknownRecord; routeSource: 'descriptor' | 'bear-castle-fallback' }>
) => {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.path}:${JSON.stringify(candidate.body ?? {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const sameVoiceVmRelativePath = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('//')) return undefined;

  try {
    const voiceBase = new URL(config.voice.baseUrl);
    const url = trimmed.startsWith('/') ? new URL(trimmed, voiceBase) : new URL(trimmed);
    if (url.origin !== voiceBase.origin || !url.pathname.startsWith('/api/')) return undefined;
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
};

const candidateDeletePathFromUnknown = (value: unknown) => {
  const candidate = cleanString(value);
  return candidate ? sameVoiceVmRelativePath(candidate) : undefined;
};

const collectDescriptorDeletePaths = (raw: unknown) => {
  const root = asRecord(raw);
  if (!root) return [];

  const paths: string[] = [];
  const append = (value: unknown) => {
    const candidate = candidateDeletePathFromUnknown(value);
    if (candidate) paths.push(candidate);
  };

  append(root.deleteUrl);
  append(root.delete_url);
  append(root.deleteHref);
  append(root.delete_href);
  append(root.referenceDeleteUrl);
  append(root.reference_delete_url);
  append(readPath(root, ['links', 'delete']));
  append(readPath(root, ['links', 'delete', 'href']));
  append(readPath(root, ['links', 'delete', 'url']));
  append(readPath(root, ['links', 'delete', 'path']));
  append(readPath(root, ['_links', 'delete']));
  append(readPath(root, ['_links', 'delete', 'href']));
  append(readPath(root, ['_links', 'delete', 'url']));
  append(readPath(root, ['_links', 'delete', 'path']));
  append(readPath(root, ['actions', 'delete']));
  append(readPath(root, ['actions', 'delete', 'href']));
  append(readPath(root, ['actions', 'delete', 'url']));
  append(readPath(root, ['actions', 'delete', 'path']));
  append(readPath(root, ['routes', 'delete']));
  append(readPath(root, ['routes', 'delete', 'href']));
  append(readPath(root, ['routes', 'delete', 'url']));
  append(readPath(root, ['routes', 'delete', 'path']));
  append(readPath(root, ['api', 'delete']));
  append(readPath(root, ['api', 'delete', 'href']));
  append(readPath(root, ['api', 'delete', 'url']));
  append(readPath(root, ['api', 'delete', 'path']));

  return Array.from(new Set(paths));
};

const referenceDeleteCandidates = (request: DeleteReferenceAudioRequest) => {
  const descriptorPaths = collectDescriptorDeletePaths(request.raw).map((deletePath) => ({
    path: deletePath,
    routeSource: 'descriptor' as const
  }));

  const ids = Array.from(new Set([request.id, request.storedFilename].filter((value): value is string => Boolean(cleanString(value)))));
  const fallbackPathCandidates = ids.map((id) => ({
    path: `/api/tts/reference-audio/${sanitizeRouteSegment(id)}`,
    routeSource: 'bear-castle-fallback' as const
  }));
  const fallbackBodyCandidates = [
    {
      path: '/api/tts/reference-audio',
      body: {
        id: request.id,
        voice: request.id,
        filename: request.storedFilename ?? request.id,
        storedFilename: request.storedFilename,
        path: request.path
      },
      routeSource: 'bear-castle-fallback' as const
    }
  ];

  return uniqueReferenceDeleteCandidates([...descriptorPaths, ...fallbackPathCandidates, ...fallbackBodyCandidates]);
};

const isRetryableReferenceDeleteStatus = (status: number) => [400, 404, 405, 422].includes(status);

export const deleteReferenceAudio = async (request: DeleteReferenceAudioRequest): Promise<DeleteReferenceAudioResult> => {
  const candidates = referenceDeleteCandidates(request);
  const timeoutMs = config.voice.timeoutMs;
  const attemptedRoutes: string[] = [];

  for (const candidate of candidates) {
    attemptedRoutes.push(candidate.path);
    try {
      const response = await axios.request({
        method: 'delete',
        url: `${config.voice.baseUrl}${candidate.path}`,
        data: candidate.body,
        timeout: timeoutMs,
        headers: candidate.body ? { 'Content-Type': 'application/json' } : undefined,
        validateStatus: (status) => status >= 200 && status < 300,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
      return {
        result: response.data ?? { ok: true },
        route: candidate.path,
        routeSource: candidate.routeSource
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response && isRetryableReferenceDeleteStatus(error.response.status)) {
        logger.warn(
          {
            route: candidate.path,
            status: error.response.status,
            routeSource: candidate.routeSource
          },
          'Voice reference delete route candidate was not accepted; trying next candidate if available'
        );
        continue;
      }
      return throwVoiceApiError(error, 'Delete TTS reference audio', 'REFERENCE_AUDIO_DELETE', timeoutMs);
    }
  }

  throw new ApiError(
    501,
    'VoiceVM did not expose a usable reference-audio delete API for this descriptor. The supplied contract documents upload and /voices listing, but not deletion.',
    'REFERENCE_AUDIO_DELETE_UNSUPPORTED',
    { attemptedRoutes }
  );
};

const postReferenceAudioWithField = (buffer: Buffer, filename: string, contentType: string, fieldName: string) => {
  const form = new FormData();
  form.append(fieldName, buffer, { filename, contentType });
  return postForm('/api/tts/reference-audio', form, 'Upload TTS reference audio');
};

export const uploadReferenceAudio = async (buffer: Buffer, filename: string, contentType = 'audio/wav') => {
  try {
    return await postReferenceAudioWithField(buffer, filename, contentType, 'reference_audio');
  } catch (error) {
    const shouldRetryFileField =
      error instanceof ApiError &&
      ([400, 415, 422, 502].includes(error.statusCode) || error.code === 'VOICE_API_SERVICE_FAILED');

    if (shouldRetryFileField) {
      logger.warn(
        { statusCode: error.statusCode, code: error.code },
        'Reference-audio upload with reference_audio field failed; retrying with file field'
      );
      return postReferenceAudioWithField(buffer, filename, contentType, 'file');
    }
    throw error;
  }
};

const settle = async <T>(name: string, fn: () => Promise<T>) => {
  try {
    return { name, data: await fn(), error: null };
  } catch (error) {
    return { name, data: null, error: error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Unknown error' };
  }
};

export const getVoiceOverview = async () => {
  const [health, services, ttsRegistry, gpu, system, sttModels, ttsModels, configResponse, voices] = await Promise.all([
    settle('health', getVoiceHealth),
    settle('services', getVoiceServices),
    settle('ttsRegistry', getVoiceTtsService),
    settle('gpu', getVoiceGpu),
    settle('system', getVoiceSystem),
    settle('sttModels', getVoiceSttModels),
    settle('ttsModels', getVoiceTtsModels),
    settle('config', getVoiceConfig),
    settle('voices', listVoiceDescriptors)
  ]);

  return {
    health: health.data,
    services: services.data,
    ttsRegistry: ttsRegistry.data,
    gpu: gpu.data,
    system: system.data,
    models: {
      stt: sttModels.data,
      tts: ttsModels.data
    },
    config: configResponse.data,
    voices: voices.data,
    errors: Object.fromEntries(
      [health, services, ttsRegistry, gpu, system, sttModels, ttsModels, configResponse, voices]
        .filter((result) => result.error)
        .map((result) => [result.name, result.error])
    ),
    generatedAt: new Date().toISOString()
  };
};
