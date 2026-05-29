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
  vi.stubEnv('CONVERSATION_TITLE_GENERATION_ENABLED', 'true');
  vi.stubEnv('CONVERSATION_TITLE_MODEL', model);
};

interface LoadTitleServiceOptions {
  configuredModel?: string;
  resolvedModel?: string | undefined;
  generatedTitle?: string;
}

const loadTitleService = async (options: LoadTitleServiceOptions = {}) => {
  vi.resetModules();
  vi.unstubAllEnvs();

  const configuredModel = options.configuredModel ?? '';
  const resolvedModel = Object.prototype.hasOwnProperty.call(options, 'resolvedModel')
    ? options.resolvedModel
    : 'qwen3:30b';
  const generatedTitle = options.generatedTitle ?? 'PostgreSQL Backup Strategy';

  stubEnv(configuredModel);

  const generateWithLlm = vi.fn(async () => ({
    content: generatedTitle,
    metadata: {}
  }));
  const resolveOptionalLlmFeatureModel = vi.fn(async () => resolvedModel);

  vi.doMock('../server/src/services/llmClient.js', () => ({
    generateWithLlm
  }));
  vi.doMock('../server/src/services/modelSettingsService.js', () => ({
    resolveOptionalLlmFeatureModel
  }));

  const module = await import('../server/src/services/conversationTitle.js');
  return { ...module, generateWithLlm, resolveOptionalLlmFeatureModel };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../server/src/services/llmClient.js');
  vi.doUnmock('../server/src/services/modelSettingsService.js');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('generateConversationTitle model resolution', () => {
  it('uses the request-time default LLM model when no conversation title model is configured', async () => {
    const { generateConversationTitle, generateWithLlm, resolveOptionalLlmFeatureModel } = await loadTitleService();

    const result = await generateConversationTitle('How should I configure PostgreSQL backups?');

    expect(resolveOptionalLlmFeatureModel).toHaveBeenCalledWith(undefined);
    expect(generateWithLlm).toHaveBeenCalledWith(
      expect.stringContaining('User message:\nHow should I configure PostgreSQL backups?'),
      {
        model: 'qwen3:30b',
        timeoutMs: 120000
      }
    );
    expect(result).toMatchObject({
      title: 'PostgreSQL Backup Strategy',
      generated: true,
      fallbackUsed: false,
      model: 'qwen3:30b'
    });
  });

  it('uses an explicit conversation title model when configured', async () => {
    const { generateConversationTitle, generateWithLlm, resolveOptionalLlmFeatureModel } = await loadTitleService({
      configuredModel: 'qwen3:14b',
      resolvedModel: 'qwen3:14b'
    });

    await generateConversationTitle('How should I configure PostgreSQL backups?');

    expect(resolveOptionalLlmFeatureModel).toHaveBeenCalledWith('qwen3:14b');
    expect(generateWithLlm).toHaveBeenCalledWith(expect.any(String), {
      model: 'qwen3:14b',
      timeoutMs: 120000
    });
  });

  it('keeps the conversation usable with a fallback title when no model can be resolved', async () => {
    const { generateConversationTitle, generateWithLlm, resolveOptionalLlmFeatureModel } = await loadTitleService({
      resolvedModel: undefined
    });

    const result = await generateConversationTitle('How should I configure PostgreSQL backups?');

    expect(resolveOptionalLlmFeatureModel).toHaveBeenCalledWith(undefined);
    expect(generateWithLlm).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      title: 'How should I configure PostgreSQL backups?',
      generated: false,
      fallbackUsed: true,
      reason: 'model_unavailable'
    });
  });
});
