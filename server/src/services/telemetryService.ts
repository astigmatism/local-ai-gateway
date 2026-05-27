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

type ServiceName = 'llm' | 'voice';
export type EndpointName = 'health' | 'gpu';

type MutableTelemetryEntry = Omit<TelemetryEntry, 'stale'>;

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
    'name',
    'gpu_name',
    'gpuName',
    'product_name',
    'driver_version',
    'driverVersion',
    'memory_total_mib',
    'memoryTotalMiB',
    'memory_total_mb',
    'memory_used_mib',
    'memoryUsedMiB',
    'memory_used_mb',
    'memory_free_mib',
    'memoryFreeMiB',
    'memory_free_mb',
    'memory_total_bytes',
    'memory_used_bytes',
    'memory_free_bytes',
    'utilization_gpu_percent',
    'utilizationGpuPercent',
    'gpu_utilization_percent',
    'utilization_percent',
    'temperature_gpu_c',
    'temperatureC',
    'temperature_c',
    'temperature',
    'power_draw_w',
    'power_limit_w',
    'fan_speed_percent'
  ]) ||
  asRecord(record.memory) !== null ||
  asRecord(record.utilization) !== null ||
  asRecord(record.power) !== null ||
  asRecord(record.temperature) !== null;

const firstRecordFromArray = (value: unknown) => {
  const array = asArray(value);
  if (!array) return null;
  for (const item of array) {
    const record = asRecord(item);
    if (record) return record;
  }
  return null;
};

const selectGpuRecord = (payload: unknown): Record<string, unknown> => {
  const root = asRecord(payload);
  if (!root) {
    throw new TelemetryPayloadError('GPU telemetry response was not a JSON object.', payload);
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
  return withSignal ?? candidates[0] ?? root;
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

export const normalizeGpuTelemetryPayload = (payload: unknown): Record<string, unknown> => {
  const root = asRecord(payload);
  if (!root) {
    throw new TelemetryPayloadError('GPU telemetry response was not a JSON object.', payload);
  }

  const gpu = selectGpuRecord(payload);
  const memory = asRecord(gpu.memory) ?? asRecord(readPath(gpu, ['fb_memory_usage'])) ?? {};
  const utilization = asRecord(gpu.utilization) ?? {};
  const power = asRecord(gpu.power) ?? {};
  const temperature = asRecord(gpu.temperature) ?? {};

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
    memory.totalMiB,
    memory.totalMib,
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
    memory.usedMiB,
    memory.usedMib,
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
    memory.freeMiB,
    memory.freeMib,
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
    gpu.temperatureC,
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

  const ok = firstBoolean(gpu.ok, root.ok, root.available, gpu.healthy, root.healthy, gpu.status, root.status);
  const hasSignal =
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

  if (!hasSignal && ok === undefined) {
    throw new TelemetryPayloadError('GPU telemetry response did not include recognizable GPU fields.', payload);
  }

  const normalized: Record<string, unknown> = {
    ...gpu,
    ok,
    status: statusFromOk(ok, firstString(gpu.status, root.status), hasSignal),
    raw: payload
  };

  if (name !== undefined) {
    normalized.name = name;
    normalized.gpu_name = name;
  }
  if (driverVersion !== undefined) normalized.driver_version = driverVersion;
  if (memoryTotalMib !== undefined) normalized.memory_total_mib = memoryTotalMib;
  if (memoryUsedMib !== undefined) normalized.memory_used_mib = memoryUsedMib;
  if (memoryFreeMib !== undefined) normalized.memory_free_mib = memoryFreeMib;
  if (utilizationGpuPercent !== undefined) normalized.utilization_gpu_percent = utilizationGpuPercent;
  if (temperatureGpuC !== undefined) {
    normalized.temperature_gpu_c = temperatureGpuC;
    normalized.temperature_c = temperatureGpuC;
  }
  if (powerDrawW !== undefined) normalized.power_draw_w = powerDrawW;
  if (powerLimitW !== undefined) normalized.power_limit_w = powerLimitW;
  if (fanSpeedPercent !== undefined) normalized.fan_speed_percent = fanSpeedPercent;

  return normalized;
};

export const normalizeTelemetryPayload = (endpoint: EndpointName, payload: unknown) => {
  if (endpoint === 'health') return normalizeHealthTelemetryPayload(payload);
  return normalizeGpuTelemetryPayload(payload);
};

const errorMessage = (error: unknown) => {
  if (error instanceof TelemetryPayloadError) return error.message;
  if (axios.isAxiosError(error)) {
    if (error.response) {
      return `HTTP ${error.response.status}`;
    }
    if (error.code === 'ECONNABORTED') {
      return `timeout after ${config.telemetry.requestTimeoutMs} ms`;
    }
    return error.message;
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
    await Promise.all([
      this.pollEndpoint('llm', 'gpu', config.llm.monitorBaseUrl),
      this.pollEndpoint('voice', 'gpu', config.voice.baseUrl, '/api/gpu')
    ]);
  }

  private async pollEndpoint(service: ServiceName, endpoint: EndpointName, baseUrl: string, pathOverride?: string) {
    const entry = this.state[service][endpoint];
    entry.last_checked_at = new Date().toISOString();

    try {
      const response = await axios.get(`${trimUrl(baseUrl)}${pathOverride ?? `/${endpoint}`}`, {
        timeout: config.telemetry.requestTimeoutMs,
        validateStatus: (status) => status >= 200 && status < 300
      });

      entry.data = normalizeTelemetryPayload(endpoint, response.data);
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
          baseUrl
        },
        'Telemetry poll failed'
      );
    }
  }
}

export const telemetryService = new TelemetryService();
