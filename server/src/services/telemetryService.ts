import axios from 'axios';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface TelemetryEntry {
  data: Record<string, unknown> | null;
  last_success_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  stale: boolean;
}

export interface ServiceTelemetryStatus {
  health: TelemetryEntry;
  gpu: TelemetryEntry;
}

export interface GatewayTelemetryStatus {
  llm: ServiceTelemetryStatus;
  voice: ServiceTelemetryStatus;
}

export interface NormalizedGpuTelemetryRecord extends Record<string, unknown> {
  ok?: boolean;
  status: string;
  index?: number;
  uuid?: string;
  name?: string;
  gpu_name?: string;
  driver_version?: string;
  driverVersion?: string;
  memory_total_mib?: number;
  memoryTotalMiB?: number;
  memory_used_mib?: number;
  memoryUsedMiB?: number;
  memory_free_mib?: number;
  memoryFreeMiB?: number;
  utilization_gpu_percent?: number;
  utilizationGpuPercent?: number;
  temperature_gpu_c?: number;
  temperature_c?: number;
  temperatureC?: number;
  power_draw_w?: number;
  powerDrawW?: number;
  power_limit_w?: number;
  powerLimitW?: number;
  fan_speed_percent?: number;
  fanSpeedPercent?: number;
  checked_at?: string;
  checkedAt?: string;
  source_endpoint?: string;
  raw: unknown;
}

export interface NormalizedGpuTelemetryPayload extends Record<string, unknown> {
  ok?: boolean;
  status: string;
  gpus: NormalizedGpuTelemetryRecord[];
  gpu_count: number;
  source_endpoint?: string;
  source?: string;
  raw: unknown;
}

type ServiceName = 'llm' | 'voice';
export type EndpointName = 'health' | 'gpu';

type MutableTelemetryEntry = Omit<TelemetryEntry, 'stale'>;

interface TelemetryNormalizationOptions {
  sourceEndpoint?: string;
  source?: string;
}

const makeEntry = (): MutableTelemetryEntry => ({
  data: null,
  last_success_at: null,
  last_checked_at: null,
  last_error: null
});

const trimUrl = (url: string) => url.replace(/\/+$/, '');

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
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'ok', 'healthy', 'up', 'online'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'error', 'failed', 'down', 'offline', 'unavailable'].includes(normalized)) return false;
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

const mibFromBytes = (value: unknown) => {
  const bytes = cleanNumber(value);
  return bytes === undefined ? undefined : bytes / (1024 * 1024);
};

const describePayload = (value: unknown): Record<string, unknown> => {
  const record = asRecord(value);
  if (!record) {
    return { payloadType: Array.isArray(value) ? 'array' : typeof value };
  }

  const keys = Object.keys(record).slice(0, 20);
  return {
    payloadType: 'object',
    keys,
    hasGpuObject: asRecord(record.gpu) !== null,
    hasGpusArray: Array.isArray(record.gpus),
    hasDevicesArray: Array.isArray(record.devices),
    hasOk: 'ok' in record,
    hasStatus: 'status' in record
  };
};

class TelemetryPayloadError extends Error {
  public readonly payloadSummary: Record<string, unknown>;

  constructor(message: string, payload: unknown) {
    super(message);
    this.name = 'TelemetryPayloadError';
    this.payloadSummary = describePayload(payload);
  }
}

const hasOwn = (record: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(record, key);

const hasAnyOwn = (record: Record<string, unknown>, keys: string[]) => keys.some((key) => hasOwn(record, key));

const hasGpuSignal = (record: Record<string, unknown>) =>
  hasAnyOwn(record, [
    'index',
    'gpu_index',
    'gpuIndex',
    'uuid',
    'gpu_uuid',
    'gpuUuid',
    'name',
    'gpu_name',
    'gpuName',
    'product_name',
    'productName',
    'driver_version',
    'driverVersion',
    'memory_total_mib',
    'memoryTotalMiB',
    'memoryTotalMib',
    'memory_total_mb',
    'memory_used_mib',
    'memoryUsedMiB',
    'memoryUsedMib',
    'memory_used_mb',
    'memory_free_mib',
    'memoryFreeMiB',
    'memoryFreeMib',
    'memory_free_mb',
    'memory_total_bytes',
    'memoryTotalBytes',
    'memory_used_bytes',
    'memoryUsedBytes',
    'memory_free_bytes',
    'memoryFreeBytes',
    'utilization_gpu_percent',
    'utilizationGpuPercent',
    'gpu_utilization_percent',
    'utilization_percent',
    'temperature_gpu_c',
    'temperatureGpuC',
    'temperatureC',
    'temperature_c',
    'temperature',
    'power_draw_w',
    'powerDrawW',
    'power_limit_w',
    'powerLimitW',
    'fan_speed_percent',
    'fanSpeedPercent'
  ]) ||
  asRecord(record.memory) !== null ||
  asRecord(record.utilization) !== null ||
  asRecord(record.power) !== null ||
  asRecord(record.temperature) !== null;

const recordsFromArray = (value: unknown) => {
  const array = asArray(value);
  if (!array) return null;
  return array.map(asRecord).filter((record): record is Record<string, unknown> => record !== null);
};

const firstRecordFromArray = (value: unknown) => recordsFromArray(value)?.[0] ?? null;

const selectGpuRecords = (payload: unknown): { records: Record<string, unknown>[]; explicitGpuList: boolean } => {
  const root = asRecord(payload);
  if (!root) {
    throw new TelemetryPayloadError('GPU telemetry response was not a JSON object.', payload);
  }

  const arrayCandidates = [root.gpus, root.devices, root.cards, root.gpu, root.device, root.card];
  for (const candidate of arrayCandidates) {
    const records = recordsFromArray(candidate);
    if (records) return { records, explicitGpuList: true };
  }

  const candidates = [
    asRecord(root.gpu),
    firstRecordFromArray(root.gpus),
    asRecord(root.device),
    firstRecordFromArray(root.devices),
    asRecord(root.card),
    firstRecordFromArray(root.cards),
    asRecord(root.nvidia),
    asRecord(root.nvidia_smi),
    root
  ].filter((candidate): candidate is Record<string, unknown> => candidate !== null);

  const withSignal = candidates.find(hasGpuSignal);
  return { records: withSignal ? [withSignal] : candidates.slice(0, 1), explicitGpuList: false };
};

const statusFromOk = (ok: boolean | undefined, fallbackStatus: string | undefined, hasSignal: boolean) => {
  const normalizedFallback = fallbackStatus?.toLowerCase();
  if (normalizedFallback) return normalizedFallback;
  if (ok === true) return 'ok';
  if (ok === false) return 'error';
  return hasSignal ? 'ok' : 'unknown';
};

export const normalizeHealthTelemetryPayload = (payload: unknown): Record<string, unknown> => {
  const record = asRecord(payload);
  if (!record) {
    throw new TelemetryPayloadError('Health telemetry response was not a JSON object.', payload);
  }

  const ok = firstBoolean(record.ok, record.healthy, record.online, record.status);
  const status = statusFromOk(ok, firstString(record.status), true);

  return {
    ...record,
    ok,
    status
  };
};

const normalizeGpuRecord = (
  gpu: Record<string, unknown>,
  root: Record<string, unknown>,
  indexHint: number | undefined,
  options: TelemetryNormalizationOptions
): NormalizedGpuTelemetryRecord | null => {
  const memory = asRecord(gpu.memory) ?? asRecord(readPath(gpu, ['fb_memory_usage'])) ?? {};
  const utilization = asRecord(gpu.utilization) ?? {};
  const power = asRecord(gpu.power) ?? {};
  const temperature = asRecord(gpu.temperature) ?? {};

  const index = firstNumber(gpu.index, gpu.gpu_index, gpu.gpuIndex) ?? indexHint;
  const uuid = firstString(gpu.uuid, gpu.gpu_uuid, gpu.gpuUuid, gpu.id, gpu.gpuId);
  const name = firstString(gpu.name, gpu.gpu_name, gpu.gpuName, gpu.product_name, gpu.productName, root.name, root.gpu_name);
  const driverVersion = firstString(
    gpu.driver_version,
    gpu.driverVersion,
    gpu.driver,
    root.driver_version,
    root.driverVersion,
    root.driver
  );

  const memoryTotalMib = firstNumber(
    gpu.memory_total_mib,
    gpu.memoryTotalMib,
    gpu.memoryTotalMiB,
    gpu.memory_total_mb,
    gpu.memoryTotalMb,
    memory.total_mib,
    memory.totalMib,
    memory.totalMiB,
    memory.total_mb,
    memory.totalMb,
    memory.total,
    mibFromBytes(gpu.memory_total_bytes),
    mibFromBytes(gpu.memoryTotalBytes),
    mibFromBytes(memory.total_bytes),
    mibFromBytes(memory.totalBytes)
  );
  const memoryUsedMib = firstNumber(
    gpu.memory_used_mib,
    gpu.memoryUsedMib,
    gpu.memoryUsedMiB,
    gpu.memory_used_mb,
    gpu.memoryUsedMb,
    memory.used_mib,
    memory.usedMib,
    memory.usedMiB,
    memory.used_mb,
    memory.usedMb,
    memory.used,
    mibFromBytes(gpu.memory_used_bytes),
    mibFromBytes(gpu.memoryUsedBytes),
    mibFromBytes(memory.used_bytes),
    mibFromBytes(memory.usedBytes)
  );
  const reportedMemoryFreeMib = firstNumber(
    gpu.memory_free_mib,
    gpu.memoryFreeMib,
    gpu.memoryFreeMiB,
    gpu.memory_free_mb,
    gpu.memoryFreeMb,
    memory.free_mib,
    memory.freeMib,
    memory.freeMiB,
    memory.free_mb,
    memory.freeMb,
    memory.free,
    memory.available,
    mibFromBytes(gpu.memory_free_bytes),
    mibFromBytes(gpu.memoryFreeBytes),
    mibFromBytes(memory.free_bytes),
    mibFromBytes(memory.freeBytes),
    mibFromBytes(memory.available_bytes),
    mibFromBytes(memory.availableBytes)
  );
  const memoryFreeMib =
    reportedMemoryFreeMib ??
    (memoryTotalMib !== undefined && memoryUsedMib !== undefined ? Math.max(0, memoryTotalMib - memoryUsedMib) : undefined);

  const utilizationGpuPercent = firstNumber(
    gpu.utilization_gpu_percent,
    gpu.utilizationGpuPercent,
    gpu.gpu_utilization_percent,
    gpu.gpuUtilizationPercent,
    gpu.utilization_percent,
    gpu.utilizationPercent,
    typeof gpu.utilization === 'number' || typeof gpu.utilization === 'string' ? gpu.utilization : undefined,
    utilization.gpu_percent,
    utilization.gpuPercent,
    utilization.gpu,
    utilization.percent
  );
  const temperatureGpuC = firstNumber(
    gpu.temperature_gpu_c,
    gpu.temperatureGpuC,
    gpu.temperatureC,
    gpu.temperature_c,
    typeof gpu.temperature === 'number' || typeof gpu.temperature === 'string' ? gpu.temperature : undefined,
    temperature.gpu_c,
    temperature.gpuC,
    temperature.c,
    temperature.current
  );
  const powerDrawW = firstNumber(
    gpu.power_draw_w,
    gpu.powerDrawW,
    gpu.power_draw,
    gpu.powerDraw,
    power.draw_w,
    power.drawW,
    power.draw,
    power.current_w,
    power.currentW,
    power.current
  );
  const powerLimitW = firstNumber(
    gpu.power_limit_w,
    gpu.powerLimitW,
    gpu.power_limit,
    gpu.powerLimit,
    power.limit_w,
    power.limitW,
    power.limit
  );
  const fanSpeedPercent = firstNumber(
    gpu.fan_speed_percent,
    gpu.fanSpeedPercent,
    gpu.fan_percent,
    gpu.fanPercent,
    gpu.fan_speed,
    gpu.fanSpeed
  );
  const checkedAt = firstString(gpu.checked_at, gpu.checkedAt, root.checked_at, root.checkedAt);

  const ok = firstBoolean(gpu.ok, gpu.available, root.ok, root.available, gpu.healthy, root.healthy, gpu.status, root.status);
  const hasSignal =
    index !== undefined ||
    uuid !== undefined ||
    name !== undefined ||
    driverVersion !== undefined ||
    memoryTotalMib !== undefined ||
    memoryUsedMib !== undefined ||
    memoryFreeMib !== undefined ||
    utilizationGpuPercent !== undefined ||
    temperatureGpuC !== undefined ||
    powerDrawW !== undefined ||
    powerLimitW !== undefined ||
    fanSpeedPercent !== undefined;

  if (!hasSignal && ok === undefined) return null;

  const normalized: NormalizedGpuTelemetryRecord = {
    ...gpu,
    ok,
    status: statusFromOk(ok, firstString(gpu.status, root.status), hasSignal),
    raw: gpu
  };

  if (index !== undefined) normalized.index = index;
  if (uuid !== undefined) normalized.uuid = uuid;
  if (name !== undefined) {
    normalized.name = name;
    normalized.gpu_name = name;
  }
  if (driverVersion !== undefined) {
    normalized.driver_version = driverVersion;
    normalized.driverVersion = driverVersion;
  }
  if (memoryTotalMib !== undefined) {
    normalized.memory_total_mib = memoryTotalMib;
    normalized.memoryTotalMiB = memoryTotalMib;
  }
  if (memoryUsedMib !== undefined) {
    normalized.memory_used_mib = memoryUsedMib;
    normalized.memoryUsedMiB = memoryUsedMib;
  }
  if (memoryFreeMib !== undefined) {
    normalized.memory_free_mib = memoryFreeMib;
    normalized.memoryFreeMiB = memoryFreeMib;
  }
  if (utilizationGpuPercent !== undefined) {
    normalized.utilization_gpu_percent = utilizationGpuPercent;
    normalized.utilizationGpuPercent = utilizationGpuPercent;
  }
  if (temperatureGpuC !== undefined) {
    normalized.temperature_gpu_c = temperatureGpuC;
    normalized.temperature_c = temperatureGpuC;
    normalized.temperatureC = temperatureGpuC;
  }
  if (powerDrawW !== undefined) {
    normalized.power_draw_w = powerDrawW;
    normalized.powerDrawW = powerDrawW;
  }
  if (powerLimitW !== undefined) {
    normalized.power_limit_w = powerLimitW;
    normalized.powerLimitW = powerLimitW;
  }
  if (fanSpeedPercent !== undefined) {
    normalized.fan_speed_percent = fanSpeedPercent;
    normalized.fanSpeedPercent = fanSpeedPercent;
  }
  if (checkedAt !== undefined) {
    normalized.checked_at = checkedAt;
    normalized.checkedAt = checkedAt;
  }
  if (options.sourceEndpoint) normalized.source_endpoint = options.sourceEndpoint;
  if (options.source) normalized.source = options.source;

  return normalized;
};

export const normalizeGpuTelemetryPayload = (
  payload: unknown,
  options: TelemetryNormalizationOptions = {}
): NormalizedGpuTelemetryPayload => {
  const root = asRecord(payload);
  if (!root) {
    throw new TelemetryPayloadError('GPU telemetry response was not a JSON object.', payload);
  }

  const { records, explicitGpuList } = selectGpuRecords(payload);
  const normalizedGpus = records
    .map((gpu, index) => normalizeGpuRecord(gpu, root, explicitGpuList ? index : undefined, options))
    .filter((gpu): gpu is NormalizedGpuTelemetryRecord => gpu !== null);
  const rootOk = firstBoolean(root.ok, root.available, root.healthy, root.status);

  if (normalizedGpus.length === 0) {
    if (!explicitGpuList && rootOk === undefined) {
      throw new TelemetryPayloadError('GPU telemetry response did not include recognizable GPU fields.', payload);
    }

    const normalized: NormalizedGpuTelemetryPayload = {
      ...root,
      ok: rootOk,
      status: statusFromOk(rootOk, firstString(root.status), explicitGpuList),
      gpus: [],
      gpu_count: 0,
      raw: payload
    };
    if (options.sourceEndpoint) normalized.source_endpoint = options.sourceEndpoint;
    if (options.source) normalized.source = options.source;
    return normalized;
  }

  const firstGpu = normalizedGpus[0]!;
  const ok = rootOk ?? firstGpu.ok;
  const normalized: NormalizedGpuTelemetryPayload = {
    ...root,
    ...firstGpu,
    ok,
    status: statusFromOk(ok, firstString(root.status, firstGpu.status), true),
    gpus: normalizedGpus,
    gpu_count: normalizedGpus.length,
    raw: payload
  };
  if (options.sourceEndpoint) normalized.source_endpoint = options.sourceEndpoint;
  if (options.source) normalized.source = options.source;

  return normalized;
};

export const normalizeTelemetryPayload = (
  endpoint: EndpointName,
  payload: unknown,
  options: TelemetryNormalizationOptions = {}
) => {
  if (endpoint === 'health') return normalizeHealthTelemetryPayload(payload);
  return normalizeGpuTelemetryPayload(payload, options);
};

const errorMessage = (error: unknown) => {
  if (error instanceof TelemetryPayloadError) return error.message;
  if (axios.isAxiosError(error)) {
    const axiosError = error as { response?: { status?: number }; code?: string; message?: string };
    if (axiosError.response?.status) {
      return `HTTP ${axiosError.response.status}`;
    }
    if (axiosError.code === 'ECONNABORTED') {
      return `timeout after ${config.telemetry.requestTimeoutMs} ms`;
    }
    return axiosError.message ?? 'axios error';
  }
  return error instanceof Error ? error.message : 'unknown error';
};

class TelemetryService {
  private readonly state: Record<ServiceName, Record<EndpointName, MutableTelemetryEntry>> = {
    llm: {
      health: makeEntry(),
      gpu: makeEntry()
    },
    voice: {
      health: makeEntry(),
      gpu: makeEntry()
    }
  };

  private timers: NodeJS.Timeout[] = [];
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;

    void this.pollAllHealth();
    void this.pollAllGpu();

    this.timers.push(setInterval(() => void this.pollAllHealth(), config.telemetry.healthPollIntervalMs));
    this.timers.push(setInterval(() => void this.pollAllGpu(), config.telemetry.gpuPollIntervalMs));
  }

  stop() {
    this.timers.forEach((timer) => clearInterval(timer));
    this.timers = [];
    this.started = false;
  }

  getStatus(): GatewayTelemetryStatus {
    return {
      llm: {
        health: this.present(this.state.llm.health),
        gpu: this.present(this.state.llm.gpu)
      },
      voice: {
        health: this.present(this.state.voice.health),
        gpu: this.present(this.state.voice.gpu)
      }
    };
  }

  private present(entry: MutableTelemetryEntry): TelemetryEntry {
    const stale =
      !entry.last_success_at || Date.now() - new Date(entry.last_success_at).getTime() > config.telemetry.staleAfterMs;

    return {
      ...entry,
      stale
    };
  }

  private async pollAllHealth() {
    await Promise.all([
      this.pollEndpoint('llm', 'health', config.llm.monitorBaseUrl),
      this.pollEndpoint('voice', 'health', config.voice.baseUrl, '/api/health')
    ]);
  }

  private async pollAllGpu() {
    await Promise.all([this.pollLlmGpuEndpoint(), this.pollEndpoint('voice', 'gpu', config.voice.baseUrl, '/api/gpu')]);
  }

  private async fetchTelemetry(
    endpoint: EndpointName,
    baseUrl: string,
    path: string,
    options: TelemetryNormalizationOptions,
    requireGpuList = false
  ) {
    const response = await axios.get(`${trimUrl(baseUrl)}${path}`, {
      timeout: config.telemetry.requestTimeoutMs,
      validateStatus: (status: number) => status >= 200 && status < 300
    });

    if (requireGpuList) {
      const root = asRecord(response.data);
      if (!root || !Array.isArray(root.gpus)) {
        throw new TelemetryPayloadError('Multi-GPU telemetry response did not include gpus[].', response.data);
      }
    }

    return normalizeTelemetryPayload(endpoint, response.data, options);
  }

  private async pollLlmGpuEndpoint() {
    const entry = this.state.llm.gpu;
    entry.last_checked_at = new Date().toISOString();

    try {
      entry.data = await this.fetchTelemetry(
        'gpu',
        config.llm.monitorBaseUrl,
        '/gpus',
        {
          sourceEndpoint: '/gpus',
          source: 'multi-gpu'
        },
        true
      );
      entry.last_success_at = new Date().toISOString();
      entry.last_error = null;
      return;
    } catch (primaryError) {
      try {
        entry.data = await this.fetchTelemetry('gpu', config.llm.monitorBaseUrl, '/gpu', {
          sourceEndpoint: '/gpu',
          source: 'legacy-fallback'
        });
        entry.last_success_at = new Date().toISOString();
        entry.last_error = null;
        return;
      } catch (fallbackError) {
        entry.last_error = `/gpus failed: ${errorMessage(primaryError)}; /gpu fallback failed: ${errorMessage(fallbackError)}`;
        logger.warn(
          {
            primaryError: primaryError instanceof TelemetryPayloadError ? undefined : primaryError,
            fallbackError: fallbackError instanceof TelemetryPayloadError ? undefined : fallbackError,
            errorMessage: entry.last_error,
            primaryPayloadSummary: primaryError instanceof TelemetryPayloadError ? primaryError.payloadSummary : undefined,
            fallbackPayloadSummary: fallbackError instanceof TelemetryPayloadError ? fallbackError.payloadSummary : undefined,
            service: 'llm',
            endpoint: 'gpu',
            baseUrl: config.llm.monitorBaseUrl,
            primaryPath: '/gpus',
            fallbackPath: '/gpu'
          },
          'Telemetry poll failed'
        );
      }
    }
  }

  private async pollEndpoint(service: ServiceName, endpoint: EndpointName, baseUrl: string, pathOverride?: string) {
    const entry = this.state[service][endpoint];
    const path = pathOverride ?? `/${endpoint}`;
    entry.last_checked_at = new Date().toISOString();

    try {
      entry.data = await this.fetchTelemetry(endpoint, baseUrl, path, {
        sourceEndpoint: path,
        source: 'primary'
      });
      entry.last_success_at = new Date().toISOString();
      entry.last_error = null;
    } catch (error) {
      entry.last_error = errorMessage(error);
      logger.warn(
        {
          err: error instanceof TelemetryPayloadError ? undefined : error,
          errorMessage: entry.last_error,
          payloadSummary: error instanceof TelemetryPayloadError ? error.payloadSummary : undefined,
          service,
          endpoint,
          baseUrl,
          path
        },
        'Telemetry poll failed'
      );
    }
  }
}

export const telemetryService = new TelemetryService();
