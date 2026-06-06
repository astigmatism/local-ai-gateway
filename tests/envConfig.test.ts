import { afterEach, describe, expect, it, vi } from 'vitest';

const requiredTestEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test',
  INITIAL_ADMIN_PASSWORD: 'initial-admin-password',
  NEW_USER_DEFAULT_PASSWORD: 'new-user-password',
  SESSION_SECRET: 'test-session-secret-with-enough-entropy',
  LLM_BASE_URL: 'http://ollama.test',
  LLM_MONITOR_BASE_URL: 'http://local-ai-llm.test',
  LLM_MODEL: 'qwen3:30b'
} as const;

const loadConfig = async (overrides: Record<string, string> = {}) => {
  vi.resetModules();
  vi.unstubAllEnvs();

  for (const [name, value] of Object.entries(requiredTestEnv)) {
    vi.stubEnv(name, value);
  }

  for (const [name, value] of Object.entries(overrides)) {
    vi.stubEnv(name, value);
  }

  return (await import('../server/src/config/env.js')).config;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('environment configuration optional feature models', () => {
  it('accepts blank optional model env vars and normalizes them to absence', async () => {
    await expect(
      loadConfig({
        TRANSCRIPT_FORMATTING_MODEL: '',
        CONVERSATION_TITLE_MODEL: ''
      })
    ).resolves.toMatchObject({
      transcriptFormatting: { model: undefined },
      conversationTitle: { model: undefined },
      llm: { model: 'qwen3:30b' }
    });
  });

  it('normalizes whitespace-only optional model env vars to absence', async () => {
    const config = await loadConfig({
      TRANSCRIPT_FORMATTING_MODEL: '   ',
      CONVERSATION_TITLE_MODEL: ' \t  '
    });

    expect(config.transcriptFormatting.model).toBeUndefined();
    expect(config.conversationTitle.model).toBeUndefined();
  });

  it('preserves explicit optional model env vars after trimming', async () => {
    const config = await loadConfig({
      TRANSCRIPT_FORMATTING_MODEL: ' qwen3:14b ',
      CONVERSATION_TITLE_MODEL: ' llama3.1:8b '
    });

    expect(config.transcriptFormatting.model).toBe('qwen3:14b');
    expect(config.conversationTitle.model).toBe('llama3.1:8b');
  });

  it('keeps the global LLM model strict when explicitly provided', async () => {
    await expect(loadConfig({ LLM_MODEL: '' })).rejects.toThrow(/LLM_MODEL/);
  });

  it('loads provider-aware TTS defaults and fallback policy', async () => {
    const config = await loadConfig({
      TTS_DEFAULT_PROVIDER: 'kokoro',
      TTS_EXPLICIT_PROVIDER: 'true',
      TTS_FALLBACK_POLICY: 'try-other-provider',
      TTS_CHATTERBOX_DEFAULT_MODEL: 'chatterbox-turbo',
      TTS_CHATTERBOX_DEFAULT_VOICE: 'default',
      TTS_KOKORO_DEFAULT_MODEL: 'kokoro-default',
      TTS_KOKORO_DEFAULT_VOICE: 'af_heart'
    });

    expect(config.tts.defaultProvider).toBe('kokoro');
    expect(config.tts.explicitProvider).toBe(true);
    expect(config.tts.fallbackPolicy).toBe('try-other-provider');
    expect(config.tts.providers.chatterbox).toMatchObject({
      enabled: true,
      defaultModel: 'chatterbox-turbo',
      defaultVoice: 'default'
    });
    expect(config.tts.providers.kokoro).toMatchObject({
      enabled: true,
      defaultModel: 'kokoro-default',
      defaultVoice: 'af_heart'
    });
  });
});
