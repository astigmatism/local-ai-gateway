import { afterEach, describe, expect, it, vi } from 'vitest';

const requiredTestEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test',
  INITIAL_ADMIN_PASSWORD: 'initial-admin-password',
  NEW_USER_DEFAULT_PASSWORD: 'new-user-password',
  SESSION_SECRET: 'test-session-secret-with-enough-entropy',
  LLM_BASE_URL: 'http://ollama.test',
  LLM_MONITOR_BASE_URL: 'http://local-ai-llm.test',
  LLM_MODEL: 'qwen3:30b',
  VOICE_BASE_URL: 'http://127.0.0.1:8000'
} as const;

const loadVoiceClient = async (overrides: Record<string, string> = {}) => {
  vi.resetModules();
  vi.unstubAllEnvs();

  for (const [name, value] of Object.entries(requiredTestEnv)) {
    vi.stubEnv(name, value);
  }

  for (const [name, value] of Object.entries(overrides)) {
    vi.stubEnv(name, value);
  }

  return import('../server/src/services/voiceClient.js');
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('concurrent TTS provider registry normalization', () => {
  it('preserves Chatterbox and Kokoro provider statuses from /api/services/tts', async () => {
    const { normalizeTtsRegistry } = await loadVoiceClient();

    const registry = normalizeTtsRegistry({
      ok: true,
      defaultProvider: 'chatterbox',
      providers: [
        {
          id: 'chatterbox',
          displayName: 'Chatterbox TTS',
          reachable: true,
          state: 'loaded',
          model: 'chatterbox-turbo',
          voice: 'default',
          workerPort: 8001,
          capabilities: {
            referenceAudio: true,
            voiceSelection: true,
            languageSelection: true,
            speedControl: true
          }
        },
        {
          id: 'kokoro',
          displayName: 'Kokoro',
          reachable: true,
          state: 'loaded',
          model: 'kokoro-82m',
          voice: 'default',
          workerPort: 8003,
          capabilities: {
            referenceAudio: false,
            voiceSelection: true,
            languageSelection: true,
            speedControl: true
          }
        }
      ]
    });

    expect(registry.defaultProvider).toBe('chatterbox');
    expect(registry.providers.chatterbox).toMatchObject({
      id: 'chatterbox',
      displayName: 'Chatterbox TTS',
      reachable: true,
      state: 'loaded',
      model: 'chatterbox-turbo',
      workerPort: 8001,
      capabilities: { referenceAudio: true }
    });
    expect(registry.providers.kokoro).toMatchObject({
      id: 'kokoro',
      displayName: 'Kokoro',
      reachable: true,
      state: 'loaded',
      model: 'kokoro-82m',
      workerPort: 8003,
      capabilities: { referenceAudio: false }
    });
  });

  it('applies a root-level TTS provider to catalog models before provider bucketing', async () => {
    const { normalizeVoiceModelCatalog } = await loadVoiceClient();

    const catalog = normalizeVoiceModelCatalog('tts', {
      provider: 'chatterbox',
      currentModel: 'chatterbox-turbo',
      models: ['chatterbox-turbo']
    });

    expect(catalog.models.map((model) => model.provider)).toEqual(['chatterbox']);
    expect(catalog.providers?.chatterbox?.currentModel).toBe('chatterbox-turbo');
    expect(catalog.providers?.chatterbox?.models.map((model) => model.id)).toEqual(['chatterbox-turbo']);
    expect(catalog.providers?.kokoro).toBeUndefined();
  });

  it('keeps TTS models scoped by provider instead of merging them into one global slot', async () => {
    const { normalizeVoiceModelCatalog } = await loadVoiceClient();

    const catalog = normalizeVoiceModelCatalog('tts', {
      providers: [
        {
          id: 'chatterbox',
          currentModel: 'chatterbox-turbo',
          models: ['chatterbox-turbo']
        },
        {
          id: 'kokoro',
          currentModel: 'kokoro-82m',
          models: ['kokoro-82m']
        }
      ]
    });

    expect(catalog.providers?.chatterbox?.currentModel).toBe('chatterbox-turbo');
    expect(catalog.providers?.chatterbox?.models.map((model) => model.id)).toEqual(['chatterbox-turbo']);
    expect(catalog.providers?.kokoro?.currentModel).toBe('kokoro-82m');
    expect(catalog.providers?.kokoro?.models.map((model) => model.id)).toEqual(['kokoro-82m']);
  });
});

describe('provider-aware TTS speak request bodies', () => {
  it('sends Chatterbox-specific reference audio fields only for Chatterbox requests', async () => {
    const { buildVoiceSpeechJsonBody } = await loadVoiceClient();

    expect(
      buildVoiceSpeechJsonBody({
        provider: 'chatterbox',
        text: 'Hello',
        voice: 'default',
        language: 'en',
        referenceAudioId: 'speaker-profile-001',
        exaggeration: 0.8,
        cfgWeight: 0.5,
        temperature: 0.7
      })
    ).toMatchObject({
      provider: 'chatterbox',
      text: 'Hello',
      voice: 'default',
      language: 'en',
      referenceAudioId: 'speaker-profile-001',
      exaggeration: 0.8,
      cfg_weight: 0.5,
      temperature: 0.7
    });
  });

  it('normalizes legacy Kokoro placeholder models before building VoiceVM JSON bodies', async () => {
    const { buildVoiceSpeechJsonBody } = await loadVoiceClient({ TTS_KOKORO_DEFAULT_MODEL: 'kokoro-82m' });

    expect(
      buildVoiceSpeechJsonBody({
        provider: 'kokoro',
        text: 'Hello',
        model: 'kokoro-default',
        voice: 'af_heart',
        language: 'a'
      })
    ).toMatchObject({
      provider: 'kokoro',
      text: 'Hello',
      model: 'kokoro-82m',
      voice: 'af_heart',
      language: 'a'
    });
  });

  it('omits the legacy Chatterbox reference-upload placeholder before sending VoiceVM JSON bodies', async () => {
    const { buildVoiceSpeechJsonBody } = await loadVoiceClient();

    const body = buildVoiceSpeechJsonBody({
      provider: 'chatterbox',
      text: 'Hello',
      voice: 'reference-upload',
      language: 'en'
    });

    expect(body).toMatchObject({
      provider: 'chatterbox',
      text: 'Hello',
      language: 'en'
    });
    expect(body).not.toHaveProperty('voice');
  });

  it('strips Chatterbox reference and tuning fields from Kokoro requests', async () => {
    const { buildVoiceSpeechJsonBody } = await loadVoiceClient();

    const body = buildVoiceSpeechJsonBody({
      provider: 'kokoro',
      text: 'Hello',
      voice: 'af_heart',
      language: 'a',
      speed: 1,
      referenceAudioId: 'speaker-profile-001',
      referenceAudioPath: '/tmp/reference.wav',
      exaggeration: 0.8,
      cfgWeight: 0.5,
      temperature: 0.7
    });

    expect(body).toMatchObject({
      provider: 'kokoro',
      text: 'Hello',
      voice: 'af_heart',
      language: 'a',
      speed: 1
    });
    expect(body).not.toHaveProperty('referenceAudioId');
    expect(body).not.toHaveProperty('referenceAudioPath');
    expect(body).not.toHaveProperty('exaggeration');
    expect(body).not.toHaveProperty('cfg_weight');
    expect(body).not.toHaveProperty('temperature');
  });
});
