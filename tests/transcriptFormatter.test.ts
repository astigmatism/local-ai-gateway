import { afterEach, describe, expect, it, vi } from 'vitest';

const stubEnv = (model: string) => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test');
  vi.stubEnv('INITIAL_ADMIN_PASSWORD', 'initial-admin-password');
  vi.stubEnv('NEW_USER_DEFAULT_PASSWORD', 'new-user-password');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-with-enough-entropy');
  vi.stubEnv('LLM_BASE_URL', 'http://ollama.test');
  vi.stubEnv('LLM_MONITOR_BASE_URL', 'http://local-ai-llm.test');
  vi.stubEnv('LLM_MODEL', 'qwen3:30b');
  vi.stubEnv('TRANSCRIPT_FORMATTING_ENABLED', 'true');
  vi.stubEnv('TRANSCRIPT_FORMATTING_MODEL', model);
};

interface LoadFormatterOptions {
  configuredModel?: string;
  resolvedModel?: string | undefined;
  formattedContent?: string;
}

const loadFormatter = async (options: LoadFormatterOptions = {}) => {
  vi.resetModules();
  vi.unstubAllEnvs();

  const configuredModel = options.configuredModel ?? '';
  const resolvedModel = Object.prototype.hasOwnProperty.call(options, 'resolvedModel')
    ? options.resolvedModel
    : 'qwen3:30b';
  const formattedContent = options.formattedContent ?? 'Hello, world.';

  stubEnv(configuredModel);

  const generateWithLlm = vi.fn(async () => ({
    content: formattedContent,
    metadata: {}
  }));
  const resolveOptionalLlmFeatureModel = vi.fn(async () => resolvedModel);

  vi.doMock('../server/src/services/llmClient.js', () => ({
    generateWithLlm
  }));
  vi.doMock('../server/src/services/modelSettingsService.js', () => ({
    resolveOptionalLlmFeatureModel
  }));

  const module = await import('../server/src/services/transcriptFormatter.js');
  return { ...module, generateWithLlm, resolveOptionalLlmFeatureModel };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../server/src/services/llmClient.js');
  vi.doUnmock('../server/src/services/modelSettingsService.js');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('maybeFormatTranscript model resolution', () => {
  it('uses the request-time default LLM model when no transcript formatting model is configured', async () => {
    const { maybeFormatTranscript, generateWithLlm, resolveOptionalLlmFeatureModel } = await loadFormatter();

    const result = await maybeFormatTranscript('hello world');

    expect(resolveOptionalLlmFeatureModel).toHaveBeenCalledWith(undefined);
    expect(generateWithLlm).toHaveBeenCalledWith(expect.stringContaining('Transcript:\nhello world'), {
      model: 'qwen3:30b',
      timeoutMs: 120000
    });
    expect(result.transcript).toBe('Hello, world.');
    expect(result.metadata).toMatchObject({
      enabled: true,
      applied: true,
      model: 'qwen3:30b',
      rawTranscriptLength: 11,
      formattedTranscriptLength: 13
    });
  });

  it('uses an explicit transcript formatting model when configured', async () => {
    const { maybeFormatTranscript, generateWithLlm, resolveOptionalLlmFeatureModel } = await loadFormatter({
      configuredModel: 'qwen3:14b',
      resolvedModel: 'qwen3:14b'
    });

    await maybeFormatTranscript('hello world');

    expect(resolveOptionalLlmFeatureModel).toHaveBeenCalledWith('qwen3:14b');
    expect(generateWithLlm).toHaveBeenCalledWith(expect.any(String), {
      model: 'qwen3:14b',
      timeoutMs: 120000
    });
  });

  it('falls back to the raw transcript when no feature or default model can be resolved', async () => {
    const { maybeFormatTranscript, generateWithLlm, resolveOptionalLlmFeatureModel } = await loadFormatter({
      resolvedModel: undefined
    });

    const result = await maybeFormatTranscript('hello world');

    expect(resolveOptionalLlmFeatureModel).toHaveBeenCalledWith(undefined);
    expect(generateWithLlm).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      transcript: 'hello world',
      metadata: {
        enabled: true,
        applied: false,
        rawTranscriptLength: 11,
        skippedReason: 'model_unavailable',
        failed: true,
        error: 'Transcript formatting model is not configured and no default LLM model is available.'
      }
    });
  });
});
