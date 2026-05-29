import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmStreamEvent } from '../server/src/services/llmClient.js';

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lzLZhwAAAABJRU5ErkJggg==';

const stubEnv = (overrides: Record<string, string> = {}) => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test');
  vi.stubEnv('LLM_BASE_URL', 'http://ollama.test');
  vi.stubEnv('LLM_MONITOR_BASE_URL', 'http://local-ai-llm.test');
  vi.stubEnv('LLM_MODEL', 'qwen3:30b');
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
};

const loadLlmClient = async (envOverrides: Record<string, string> = {}) => {
  vi.resetModules();
  stubEnv(envOverrides);
  return import('../server/src/services/llmClient.js');
};

const mockAxiosForImageGeneration = () => {
  const textClient = {
    post: vi.fn()
  };
  const localAiClient = {
    get: vi.fn(),
    post: vi.fn()
  };
  const create = vi.fn()
    .mockReturnValueOnce(textClient)
    .mockReturnValueOnce(localAiClient);
  const isAxiosError = (error: unknown) => Boolean(error && typeof error === 'object' && 'isAxiosError' in error);

  vi.doMock('axios', () => ({
    default: {
      create,
      isAxiosError
    },
    isAxiosError
  }));

  return { create, textClient, localAiClient };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock('axios');
  vi.resetModules();
});

describe('generateWithLlmStream', () => {
  it('requests Ollama /api/generate with stream true and yields deltas before done', async () => {
    const encoder = new TextEncoder();
    const payload = [
      JSON.stringify({ model: 'qwen3:14b', response: 'Hel', done: false }),
      JSON.stringify({ model: 'qwen3:14b', thinking: 'hidden reasoning chunk', done: false }),
      JSON.stringify({ model: 'qwen3:14b', response: 'lo', done: false }),
      JSON.stringify({ model: 'qwen3:14b', done: true, total_duration: 123, eval_count: 2 })
    ].join('\n');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload.slice(0, 45)));
        controller.enqueue(encoder.encode(payload.slice(45) + '\n'));
        controller.close();
      }
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' }
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { generateWithLlmStream } = await loadLlmClient();
    const events: LlmStreamEvent[] = [];
    for await (const event of generateWithLlmStream('User: hello\nAssistant:', { model: 'qwen3:14b' })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['metadata', 'delta', 'delta', 'done']);
    expect(events[1]).toMatchObject({ type: 'delta', delta: 'Hel', content: 'Hel' });
    expect(events[2]).toMatchObject({ type: 'delta', delta: 'lo', content: 'Hello' });
    expect(events[3]).toMatchObject({
      type: 'done',
      content: 'Hello',
      metadata: {
        provider: 'ollama',
        model: 'qwen3:14b',
        hasThinkingField: true
      }
    });
    expect(JSON.stringify(events)).not.toContain('hidden reasoning chunk');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://ollama.test/api/generate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson'
        })
      })
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'qwen3:14b',
      prompt: 'User: hello\nAssistant:',
      stream: true
    });
  });

  it('rejects streams that end before Ollama sends done true', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ response: 'partial', done: false })}\n`));
        controller.close();
      }
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'application/x-ndjson' }
          })
      )
    );

    const { generateWithLlmStream } = await loadLlmClient();
    const consume = async () => {
      for await (const event of generateWithLlmStream('Prompt', { model: 'qwen3:14b' })) {
        void event;
      }
    };

    await expect(consume()).rejects.toMatchObject({ code: 'LLM_STREAM_INCOMPLETE' });
  });
});

describe('generateImageWithLlm', () => {
  it('does not call the image endpoint when local-ai-llm reports an unsupported model capability', async () => {
    const { localAiClient } = mockAxiosForImageGeneration();
    localAiClient.get.mockResolvedValue({
      data: {
        ok: true,
        imageGeneration: {
          enabled: true,
          available: false,
          currentModel: 'qwen3.6:35b-a3b-q4_K_M',
          installed: true,
          loaded: false,
          endpoint: '/api/images/generate',
          ollamaEndpoint: '/api/generate',
          maxPromptChars: 4000,
          provider: 'ollama',
          requiredCapability: 'image',
          modelCapabilities: ['completion', 'vision', 'tools', 'thinking'],
          supportsImageGeneration: false,
          supportsImageInput: true,
          reason: 'Current model qwen3.6:35b-a3b-q4_K_M does not report Ollama image-generation capability "image".'
        }
      }
    });

    const { generateImageWithLlm } = await loadLlmClient({ IMAGE_GENERATION_ENABLED: 'true' });

    await expect(generateImageWithLlm('a bear castle')).rejects.toMatchObject({
      statusCode: 422,
      code: 'IMAGE_GENERATION_UNSUPPORTED_MODEL',
      message: expect.stringContaining('does not report Ollama image-generation capability "image"')
    });
    expect(localAiClient.get).toHaveBeenCalledWith('/api/capabilities', expect.objectContaining({ timeout: 30000 }));
    expect(localAiClient.post).not.toHaveBeenCalled();
  });

  it('checks local-ai-llm capabilities before sending the aligned image request shape', async () => {
    const { localAiClient } = mockAxiosForImageGeneration();
    localAiClient.get.mockResolvedValue({
      data: {
        ok: true,
        imageGeneration: {
          enabled: true,
          available: true,
          currentModel: 'x/z-image-turbo',
          installed: true,
          loaded: false,
          endpoint: '/api/images/generate',
          ollamaEndpoint: '/api/generate',
          maxPromptChars: 4000,
          provider: 'ollama',
          requiredCapability: 'image',
          modelCapabilities: ['image'],
          supportsImageGeneration: true,
          supportsImageInput: false
        }
      }
    });
    localAiClient.post.mockResolvedValue({
      data: {
        ok: true,
        model: 'x/z-image-turbo',
        images: [{ mimeType: 'image/png', base64: tinyPngBase64, width: 1, height: 1 }],
        metadata: { provider: 'ollama', endpoint: '/api/generate' }
      }
    });

    const { generateImageWithLlm } = await loadLlmClient({ IMAGE_GENERATION_ENABLED: 'true' });
    const result = await generateImageWithLlm('  a bear castle  ', { width: 512, steps: 20 });

    expect(localAiClient.get).toHaveBeenCalledWith('/api/capabilities', expect.objectContaining({ timeout: 30000 }));
    expect(localAiClient.post).toHaveBeenCalledWith(
      '/api/images/generate',
      {
        prompt: 'a bear castle',
        options: { width: 512, steps: 20 }
      },
      expect.objectContaining({ timeout: 600000 })
    );
    expect(result.model).toBe('x/z-image-turbo');
    expect(result.image.base64).toBe(tinyPngBase64);
    expect(result.metadata).toEqual({ provider: 'ollama', endpoint: '/api/generate' });
  });
});
