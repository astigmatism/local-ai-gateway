import { afterEach, describe, expect, it, vi } from 'vitest';

const stubEnv = () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test');
  vi.stubEnv('LLM_BASE_URL', 'http://192.168.1.21:11434');
  vi.stubEnv('LLM_MONITOR_BASE_URL', 'http://192.168.1.21:8000');
  vi.stubEnv('VOICE_BASE_URL', 'http://192.168.1.8:8000');
};

const loadTelemetryService = async () => {
  vi.resetModules();
  stubEnv();
  return import('../server/src/services/telemetryService.js');
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('telemetry service normalization', () => {
  it('maps monitor health ok=true to status ok while preserving model metadata', async () => {
    const { normalizeHealthTelemetryPayload } = await loadTelemetryService();

    const normalized = normalizeHealthTelemetryPayload({
      ok: true,
      default_model: 'qwen3:14b',
      default_model_loaded: true,
      running_models: [{ name: 'qwen3:14b' }]
    });

    expect(normalized.status).toBe('ok');
    expect(normalized.ok).toBe(true);
    expect(normalized.default_model).toBe('qwen3:14b');
    expect(normalized.default_model_loaded).toBe(true);
  });

  it('normalizes the current nested local-ai-llm GPU response shape', async () => {
    const { normalizeGpuTelemetryPayload } = await loadTelemetryService();

    const normalized = normalizeGpuTelemetryPayload({
      ok: true,
      gpu: {
        name: 'NVIDIA GeForce RTX 2080 Ti',
        driver_version: '595.71.05',
        memory_total_mib: 11264,
        memory_used_mib: 9485,
        memory_free_mib: 1334,
        utilization_gpu_percent: 0,
        temperature_c: 29,
        power_draw_w: 19.95,
        power_limit_w: 250.0
      }
    });

    expect(normalized).toMatchObject({
      ok: true,
      status: 'ok',
      name: 'NVIDIA GeForce RTX 2080 Ti',
      gpu_name: 'NVIDIA GeForce RTX 2080 Ti',
      driver_version: '595.71.05',
      memory_total_mib: 11264,
      memory_used_mib: 9485,
      memory_free_mib: 1334,
      utilization_gpu_percent: 0,
      temperature_gpu_c: 29,
      temperature_c: 29,
      power_draw_w: 19.95,
      power_limit_w: 250
    });
  });

  it('keeps compatibility with flat legacy GPU telemetry keys', async () => {
    const { normalizeGpuTelemetryPayload } = await loadTelemetryService();

    const normalized = normalizeGpuTelemetryPayload({
      status: 'ok',
      gpu_name: 'NVIDIA RTX A6000',
      driverVersion: '555.42.06',
      memory_total_mb: '49152',
      memory_used_mb: '24576',
      utilization_percent: '73',
      temperature: '61',
      power_draw: '198.5',
      power_limit: '300',
      fan_speed: '45'
    });

    expect(normalized).toMatchObject({
      status: 'ok',
      name: 'NVIDIA RTX A6000',
      gpu_name: 'NVIDIA RTX A6000',
      driver_version: '555.42.06',
      memory_total_mib: 49152,
      memory_used_mib: 24576,
      memory_free_mib: 24576,
      utilization_gpu_percent: 73,
      temperature_gpu_c: 61,
      power_draw_w: 198.5,
      power_limit_w: 300,
      fan_speed_percent: 45
    });
  });

  it('normalizes GPU arrays and byte-based memory fields', async () => {
    const { normalizeGpuTelemetryPayload } = await loadTelemetryService();

    const normalized = normalizeGpuTelemetryPayload({
      ok: true,
      gpus: [
        {
          product_name: 'NVIDIA GeForce RTX 4090',
          memory_total_bytes: 24 * 1024 * 1024 * 1024,
          memory_used_bytes: 6 * 1024 * 1024 * 1024,
          gpu_utilization_percent: 12,
          temperature_gpu_c: 37
        }
      ]
    });

    expect(normalized).toMatchObject({
      status: 'ok',
      name: 'NVIDIA GeForce RTX 4090',
      memory_total_mib: 24576,
      memory_used_mib: 6144,
      memory_free_mib: 18432,
      utilization_gpu_percent: 12,
      temperature_gpu_c: 37
    });
  });

  it('throws a clear parse error for unrecognizable GPU payloads', async () => {
    const { normalizeGpuTelemetryPayload } = await loadTelemetryService();

    expect(() => normalizeGpuTelemetryPayload({ foo: 'bar' })).toThrow(/recognizable GPU fields/i);
  });
});
