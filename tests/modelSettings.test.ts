import { afterEach, describe, expect, it, vi } from 'vitest';

const stubEnv = () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test');
  vi.stubEnv('LLM_BASE_URL', 'http://192.168.1.5:11434');
  vi.stubEnv('LLM_MONITOR_BASE_URL', 'http://192.168.1.5:8000');
  vi.stubEnv('LLM_MODEL', 'qwen3:30b');
};

const loadService = async () => {
  vi.resetModules();
  stubEnv();
  const service = await import('../server/src/services/modelSettingsService.js');
  service.resetModelSettingsCacheForTests();
  return service;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('model settings service helpers', () => {
  it('validates common Ollama model names and rejects unsafe input', async () => {
    const { isValidModelName } = await loadService();

    expect(isValidModelName('qwen3:30b')).toBe(true);
    expect(isValidModelName('qwen3:14b')).toBe(true);
    expect(isValidModelName('llama3.1:8b')).toBe(true);
    expect(isValidModelName('namespace/model-name:q4_K_M')).toBe(true);
    expect(isValidModelName('model_name:tag')).toBe(true);

    expect(isValidModelName('')).toBe(false);
    expect(isValidModelName('   ')).toBe(false);
    expect(isValidModelName('http://192.168.1.5:11434/api/tags')).toBe(false);
    expect(isValidModelName('../qwen3:30b')).toBe(false);
    expect(isValidModelName('qwen3:30b; rm -rf /')).toBe(false);
    expect(isValidModelName('qwen3:30b\n{"make_default":true}')).toBe(false);
  });

  it('combines local-ai-llm health, Ollama tags, and Ollama ps status', async () => {
    const { buildModelManagementStatus } = await loadService();

    const status = buildModelManagementStatus({
      healthSource: { status: 'ok' },
      healthData: {
        default_model: 'qwen3:30b',
        default_model_loaded: true,
        loaded_models: [{ name: 'qwen3:30b', size_vram: 12_884_901_888, context_length: 32_768 }]
      },
      tagsSource: { status: 'ok' },
      tagsData: {
        models: [
          {
            name: 'qwen3:14b',
            size: 9_123_456_789,
            modified_at: '2026-05-24T12:00:00Z',
            details: { parameter_size: '14B', quantization_level: 'Q4_K_M' }
          }
        ]
      },
      psSource: { status: 'ok' },
      psData: {
        models: [{ name: 'qwen3:30b', expires_at: '2026-05-24T13:00:00Z' }]
      }
    });

    expect(status.defaultModel).toBe('qwen3:30b');
    expect(status.defaultModelLoaded).toBe(true);
    expect(status.loadedModels).toHaveLength(1);
    expect(status.loadedModels[0]).toMatchObject({
      name: 'qwen3:30b',
      source: 'combined',
      sizeVram: 12_884_901_888,
      contextLength: 32_768,
      expiresAt: '2026-05-24T13:00:00Z'
    });
    expect(status.availableModels[0]).toMatchObject({
      name: 'qwen3:14b',
      size: 9_123_456_789,
      details: { parameterSize: '14B', quantization: 'Q4_K_M' }
    });
  });

  it('keeps partial discovery data and marks default loaded status unknown when running-model sources fail', async () => {
    const { buildModelManagementStatus } = await loadService();

    const status = buildModelManagementStatus({
      healthSource: { status: 'error', message: 'service unavailable' },
      tagsSource: { status: 'ok' },
      tagsData: { models: [{ name: 'qwen3:14b' }] },
      psSource: { status: 'error', message: 'timeout after 30000 ms' }
    });

    expect(status.defaultModel).toBe('qwen3:30b');
    expect(status.defaultModelSource).toBe('gateway-fallback');
    expect(status.defaultModelLoaded).toBeNull();
    expect(status.availableModels.map((model) => model.name)).toEqual(['qwen3:14b']);
    expect(status.source.health.status).toBe('error');
    expect(status.source.ollamaTags.status).toBe('ok');
    expect(status.source.ollamaPs.status).toBe('error');
  });
});
