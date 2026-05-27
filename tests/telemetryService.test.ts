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
      temperature_gpu_c: 37,
      gpu_count: 1
    });
    expect(normalized.gpus).toHaveLength(1);
  });

  it('normalizes every device from the local-ai-llm /gpus response', async () => {
    const { normalizeGpuTelemetryPayload } = await loadTelemetryService();

    const normalized = normalizeGpuTelemetryPayload(
      {
        ok: true,
        gpus: [
          {
            index: 0,
            uuid: 'GPU-358353dd-5933-1dc6-ac0d-e1189b063e4c',
            name: 'NVIDIA GeForce RTX 3090',
            driver_version: '595.71.05',
            memory_total_mib: 24576,
            memory_used_mib: 1,
            memory_free_mib: 24126,
            utilization_gpu_percent: 0,
            temperature_c: 40,
            power_draw_w: 12.15,
            power_limit_w: 420
          },
          {
            index: 1,
            uuid: 'GPU-b0c40094-4d7a-fe22-3995-664a81ee7e33',
            name: 'NVIDIA GeForce RTX 4080',
            driver_version: '595.71.05',
            memory_total_mib: 16376,
            memory_used_mib: 2,
            memory_free_mib: 15945,
            utilization_gpu_percent: 0,
            temperature_c: 45,
            power_draw_w: 11.68,
            power_limit_w: 320
          }
        ]
      },
      { sourceEndpoint: '/gpus', source: 'multi-gpu' }
    );

    expect(normalized).toMatchObject({
      ok: true,
      status: 'ok',
      gpu_count: 2,
      source_endpoint: '/gpus',
      source: 'multi-gpu'
    });
    expect(normalized.gpus).toHaveLength(2);
    expect(normalized.gpus[0]).toMatchObject({
      index: 0,
      uuid: 'GPU-358353dd-5933-1dc6-ac0d-e1189b063e4c',
      name: 'NVIDIA GeForce RTX 3090',
      memory_total_mib: 24576,
      temperature_c: 40,
      power_draw_w: 12.15,
      source_endpoint: '/gpus'
    });
    expect(normalized.gpus[1]).toMatchObject({
      index: 1,
      uuid: 'GPU-b0c40094-4d7a-fe22-3995-664a81ee7e33',
      name: 'NVIDIA GeForce RTX 4080',
      memory_total_mib: 16376,
      temperature_c: 45,
      power_limit_w: 320,
      source_endpoint: '/gpus'
    });
  });

  it('accepts an empty local-ai-llm /gpus list without throwing', async () => {
    const { normalizeGpuTelemetryPayload } = await loadTelemetryService();

    const normalized = normalizeGpuTelemetryPayload({ ok: true, gpus: [] }, { sourceEndpoint: '/gpus' });

    expect(normalized.status).toBe('ok');
    expect(normalized.gpu_count).toBe(0);
    expect(normalized.gpus).toEqual([]);
    expect(normalized.source_endpoint).toBe('/gpus');
  });

  it('normalizes the modern local-ai-voice /api/gpu device shape', async () => {
    const { normalizeGpuTelemetryPayload } = await loadTelemetryService();

    const normalized = normalizeGpuTelemetryPayload({
      available: true,
      checkedAt: '2026-05-26T00:00:00.000Z',
      devices: [
        {
          index: 0,
          name: 'NVIDIA GeForce RTX 3090',
          driverVersion: '555.42.06',
          memoryTotalMiB: 24576,
          memoryUsedMiB: 4096,
          memoryFreeMiB: 20480,
          utilizationGpuPercent: 12,
          temperatureC: 55
        }
      ]
    });

    expect(normalized).toMatchObject({
      status: 'ok',
      name: 'NVIDIA GeForce RTX 3090',
      gpu_name: 'NVIDIA GeForce RTX 3090',
      driver_version: '555.42.06',
      memory_total_mib: 24576,
      memory_used_mib: 4096,
      memory_free_mib: 20480,
      utilization_gpu_percent: 12,
      temperature_gpu_c: 55,
      temperature_c: 55
    });
  });

  it('represents an unavailable modern voice GPU without throwing', async () => {
    const { normalizeGpuTelemetryPayload } = await loadTelemetryService();

    const normalized = normalizeGpuTelemetryPayload({
      available: false,
      checkedAt: '2026-05-26T00:00:00.000Z',
      devices: []
    });

    expect(normalized.status).toBe('error');
    expect(normalized.ok).toBe(false);
  });

  it('throws a clear parse error for unrecognizable GPU payloads', async () => {
    const { normalizeGpuTelemetryPayload } = await loadTelemetryService();

    expect(() => normalizeGpuTelemetryPayload({ foo: 'bar' })).toThrow(/recognizable GPU fields/i);
  });
});
