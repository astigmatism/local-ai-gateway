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

const mockAxiosClients = () => {
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

describe('generateWithLlm', () => {
  it('disables Ollama thinking when the selected model reports the thinking capability', async () => {
    const { textClient } = mockAxiosClients();
    textClient.post.mockImplementation(async (url: string, body: unknown) => {
      if (url === '/api/show') {
        return {
          data: {
            capabilities: ['completion', 'tools', 'thinking'],
            digest: 'thinking-model-digest'
          }
        };
      }

      if (url === '/api/generate') {
        return {
          data: {
            response: 'backend-ok',
            done: true,
            done_reason: 'stop'
          }
        };
      }

      throw new Error(`Unexpected text client POST ${url} with ${JSON.stringify(body)}`);
    });

    const { generateWithLlm } = await loadLlmClient();
    const result = await generateWithLlm('Reply with exactly backend-ok', { model: 'qwen3:14b' });

    expect(result.content).toBe('backend-ok');
    expect(result.metadata).toMatchObject({
      provider: 'ollama',
      model: 'qwen3:14b',
      thinkingCapabilityDetected: true,
      thinkDisabled: true,
      modelCapabilities: ['completion', 'tools', 'thinking']
    });
    expect(textClient.post).toHaveBeenCalledWith('/api/show', { model: 'qwen3:14b' }, expect.objectContaining({ timeout: 5000 }));
    expect(textClient.post).toHaveBeenCalledWith(
      '/api/generate',
      {
        model: 'qwen3:14b',
        prompt: '/no_think\n\nReply with exactly backend-ok',
        stream: false,
        think: false
      },
      expect.objectContaining({ timeout: 600000 })
    );
  });

  it('uses the clean response field and suppresses native Ollama thinking fields in non-streaming responses', async () => {
    const { textClient } = mockAxiosClients();
    textClient.post.mockImplementation(async (url: string, body: unknown) => {
      if (url === '/api/show') {
        return {
          data: {
            capabilities: ['completion', 'thinking'],
            digest: 'thinking-model-digest'
          }
        };
      }

      if (url === '/api/generate') {
        return {
          data: {
            response: '2 plus 2 equals 4.',
            thinking: "Here's a thinking process:\n\n1. Analyze User Input...",
            reasoning_content: 'duplicated hidden reasoning',
            analysis: { steps: ['hidden analysis step'] },
            done: true,
            done_reason: 'stop'
          }
        };
      }

      throw new Error(`Unexpected text client POST ${url} with ${JSON.stringify(body)}`);
    });

    const { generateWithLlm } = await loadLlmClient();
    const result = await generateWithLlm('What is 2 plus 2?', { model: 'qwen3.6:27b-q4_K_M' });

    expect(result.content).toBe('2 plus 2 equals 4.');
    expect(result.metadata).toMatchObject({
      provider: 'ollama',
      model: 'qwen3.6:27b-q4_K_M',
      hasThinkingField: true,
      thinkingContentDiscarded: true,
      thinkingContentSuppressed: true,
      thinking: expect.objectContaining({ discarded: true })
    });
    expect(result.metadata).not.toHaveProperty('thinkingContent');
    expect(JSON.stringify(result.metadata)).not.toContain('thinking process');
    expect(JSON.stringify(result.metadata)).not.toContain('duplicated hidden reasoning');
    expect(JSON.stringify(result.metadata)).not.toContain('hidden analysis step');
  });

  it('enables Ollama thinking when requested for a thinking-capable Qwen model', async () => {
    const { textClient } = mockAxiosClients();
    textClient.post.mockImplementation(async (url: string, body: unknown) => {
      if (url === '/api/show') {
        return {
          data: {
            capabilities: ['completion', 'thinking'],
            digest: 'thinking-model-digest'
          }
        };
      }

      if (url === '/api/generate') {
        return {
          data: {
            response: '<think>private reasoning</think>\n\nbackend-ok',
            done: true,
            done_reason: 'stop'
          }
        };
      }

      throw new Error(`Unexpected text client POST ${url} with ${JSON.stringify(body)}`);
    });

    const { generateWithLlm } = await loadLlmClient();
    const result = await generateWithLlm('Reply with exactly backend-ok', { model: 'qwen3:14b', enableThinking: true });

    expect(result.content).toBe('backend-ok');
    expect(result.metadata).toMatchObject({
      provider: 'ollama',
      model: 'qwen3:14b',
      thinkingCapabilityDetected: true,
      thinkingRequested: true,
      thinkingEnabled: true,
      thinkEnabledReason: 'capability',
      hasRawThinkingTag: true,
      rawThinkingTagSuppressed: true,
      thinkingContentDiscarded: true,
      thinking: expect.objectContaining({ discarded: true })
    });
    expect(result.metadata).not.toHaveProperty('thinkingContent');
    expect(textClient.post).toHaveBeenCalledWith(
      '/api/generate',
      {
        model: 'qwen3:14b',
        prompt: '/think\n\nReply with exactly backend-ok',
        stream: false,
        think: true
      },
      expect.objectContaining({ timeout: 600000 })
    );
  });

  it('does not send an Ollama think override when the selected model does not report thinking support', async () => {
    const { textClient } = mockAxiosClients();
    textClient.post.mockImplementation(async (url: string, body: unknown) => {
      if (url === '/api/show') {
        return {
          data: {
            capabilities: ['completion'],
            digest: 'completion-model-digest'
          }
        };
      }

      if (url === '/api/generate') {
        return {
          data: {
            response: 'plain-ok',
            done: true,
            done_reason: 'stop'
          }
        };
      }

      throw new Error(`Unexpected text client POST ${url} with ${JSON.stringify(body)}`);
    });

    const { generateWithLlm } = await loadLlmClient();
    const result = await generateWithLlm('Reply with exactly plain-ok', { model: 'plain:latest' });

    expect(result.content).toBe('plain-ok');
    expect(result.metadata).toMatchObject({
      provider: 'ollama',
      model: 'plain:latest',
      thinkingCapabilityDetected: false,
      thinkDisabled: false,
      modelCapabilities: ['completion']
    });
    expect(textClient.post).toHaveBeenCalledWith(
      '/api/generate',
      {
        model: 'plain:latest',
        prompt: 'Reply with exactly plain-ok',
        stream: false
      },
      expect.objectContaining({ timeout: 600000 })
    );
  });

  it('disables Ollama thinking for known reasoning-prone Qwen models even when metadata omits the thinking capability', async () => {
    const { textClient } = mockAxiosClients();
    textClient.post.mockImplementation(async (url: string, body: unknown) => {
      if (url === '/api/show') {
        return {
          data: {
            capabilities: ['completion'],
            digest: 'hf-qwen-digest',
            details: {
              family: 'qwen35',
              families: ['qwen35']
            }
          }
        };
      }

      if (url === '/api/generate') {
        return {
          data: {
            response: '\n\n<think>private reasoning</think>\n\nbackend-ok',
            done: true,
            done_reason: 'stop'
          }
        };
      }

      throw new Error(`Unexpected text client POST ${url} with ${JSON.stringify(body)}`);
    });

    const model = 'hf.co/gaston-parravicini/Qwen3.6-27B-Abliterated-MTP-GGUF:Q8_0';
    const { generateWithLlm } = await loadLlmClient();
    const result = await generateWithLlm('Reply with exactly backend-ok', { model });

    expect(result.content).toBe('backend-ok');
    expect(result.metadata).toMatchObject({
      provider: 'ollama',
      model,
      thinkingCapabilityDetected: false,
      thinkDisabled: true,
      thinkDisabledReason: 'known-reasoning-model',
      hasRawThinkingTag: true,
      rawThinkingTagSuppressed: true,
      thinkingContentDiscarded: true,
      thinkingContentSuppressed: true,
      thinking: expect.objectContaining({ discarded: true }),
      modelCapabilities: ['completion']
    });
    expect(result.metadata).not.toHaveProperty('thinkingContent');
    expect(textClient.post).toHaveBeenCalledWith(
      '/api/generate',
      {
        model,
        prompt: '/no_think\n\nReply with exactly backend-ok',
        stream: false,
        think: false
      },
      expect.objectContaining({ timeout: 600000 })
    );
  });
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
    const { textClient } = mockAxiosClients();
    textClient.post.mockResolvedValueOnce({
      data: {
        capabilities: ['completion', 'thinking'],
        digest: 'thinking-model-digest'
      }
    });

    const { generateWithLlmStream } = await loadLlmClient();
    const events: LlmStreamEvent[] = [];
    for await (const event of generateWithLlmStream('User: hello\nAssistant:', { model: 'qwen3:14b' })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'metadata',
      'delta',
      'thinking_lifecycle',
      'thinking_delta',
      'delta',
      'thinking_lifecycle',
      'done'
    ]);
    const finalDeltaEvent = events.filter((event) => event.type === 'delta').at(-1);
    expect(finalDeltaEvent).toMatchObject({ type: 'delta', delta: 'lo', content: 'Hello' });
    const hiddenThinkingDoneEvent = events.find((event) => event.type === 'done');
    if (!hiddenThinkingDoneEvent || hiddenThinkingDoneEvent.type !== 'done') {
      throw new Error('Expected stream to finish with a done event.');
    }
    expect(hiddenThinkingDoneEvent).toMatchObject({
      type: 'done',
      content: 'Hello',
      metadata: {
        provider: 'ollama',
        model: 'qwen3:14b',
        hasThinkingField: true,
        thinkingContentDiscarded: true,
        thinkingContentSuppressed: true,
        thinking: expect.objectContaining({ discarded: true })
      }
    });
    expect(hiddenThinkingDoneEvent.metadata).not.toHaveProperty('thinkingContent');
    expect(events.filter((event) => event.type === 'delta').map((event) => JSON.stringify(event)).join('')).not.toContain('hidden reasoning chunk');
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
    expect(textClient.post).toHaveBeenCalledWith('/api/show', { model: 'qwen3:14b' }, expect.objectContaining({ timeout: 5000 }));
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'qwen3:14b',
      prompt: '/no_think\n\nUser: hello\nAssistant:',
      stream: true,
      think: false
    });
  });

  it('suppresses alternate structured reasoning fields in streamed Ollama chunks', async () => {
    const encoder = new TextEncoder();
    const payload = [
      JSON.stringify({ model: 'qwen3:14b', reasoning_content: 'hidden reasoning chunk', done: false }),
      JSON.stringify({ model: 'qwen3:14b', response: 'Visible answer', done: false }),
      JSON.stringify({ model: 'qwen3:14b', done: true, total_duration: 123, eval_count: 2 })
    ].join('\n');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${payload}\n`));
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
    const { textClient } = mockAxiosClients();
    textClient.post.mockResolvedValueOnce({ data: { capabilities: ['completion', 'thinking'], digest: 'thinking-model-digest' } });

    const { generateWithLlmStream } = await loadLlmClient();
    const events: LlmStreamEvent[] = [];
    for await (const event of generateWithLlmStream('User: hello\nAssistant:', { model: 'qwen3:14b' })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'metadata',
      'thinking_lifecycle',
      'thinking_delta',
      'delta',
      'thinking_lifecycle',
      'done'
    ]);
    expect(events.find((event) => event.type === 'delta')).toMatchObject({
      type: 'delta',
      delta: 'Visible answer',
      content: 'Visible answer'
    });
    const structuredThinkingDoneEvent = events.find((event) => event.type === 'done');
    if (!structuredThinkingDoneEvent || structuredThinkingDoneEvent.type !== 'done') throw new Error('Expected done event.');
    expect(structuredThinkingDoneEvent).toMatchObject({
      type: 'done',
      content: 'Visible answer',
      metadata: {
        provider: 'ollama',
        model: 'qwen3:14b',
        hasThinkingField: true,
        thinkingContentDiscarded: true,
        thinkingContentSuppressed: true,
        thinking: expect.objectContaining({ discarded: true })
      }
    });
    expect(structuredThinkingDoneEvent.metadata).not.toHaveProperty('thinkingContent');
    expect(events.filter((event) => event.type === 'delta').map((event) => JSON.stringify(event)).join('')).not.toContain('hidden reasoning chunk');
  });


  it('suppresses untagged streamed analysis before the final response', async () => {
    const encoder = new TextEncoder();
    const payload = [
      JSON.stringify({ model: 'plain:latest', response: 'Analysis:\nAnalyze user input and identify key elements.\n', done: false }),
      JSON.stringify({
        model: 'plain:latest',
        response: 'Determine best practices, draft, refine, and check against constraints.\n\nFinal answer:\n',
        done: false
      }),
      JSON.stringify({ model: 'plain:latest', response: 'Visible answer.', done: false }),
      JSON.stringify({ model: 'plain:latest', done: true, total_duration: 123, eval_count: 3 })
    ].join('\n');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${payload}\n`));
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
    const { textClient } = mockAxiosClients();
    textClient.post.mockResolvedValueOnce({ data: { capabilities: ['completion'], digest: 'plain-digest' } });

    const { generateWithLlmStream } = await loadLlmClient();
    const events: LlmStreamEvent[] = [];
    for await (const event of generateWithLlmStream('User: hello\nAssistant:', { model: 'plain:latest' })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'metadata',
      'thinking_lifecycle',
      'thinking_delta',
      'delta',
      'thinking_lifecycle',
      'done'
    ]);
    expect(events.find((event) => event.type === 'delta')).toMatchObject({
      type: 'delta',
      delta: 'Visible answer.',
      content: 'Visible answer.'
    });
    const untaggedDoneEvent = events.find((event) => event.type === 'done');
    if (!untaggedDoneEvent || untaggedDoneEvent.type !== 'done') throw new Error('Expected done event.');
    expect(untaggedDoneEvent).toMatchObject({
      type: 'done',
      content: 'Visible answer.',
      metadata: {
        model: 'plain:latest',
        hasUntaggedReasoning: true,
        untaggedReasoningSuppressed: true,
        thinkingContentDiscarded: true,
        thinkingContentSuppressed: true,
        thinking: expect.objectContaining({ discarded: true })
      }
    });
    expect(untaggedDoneEvent.metadata).not.toHaveProperty('thinkingContent');
    expect(JSON.stringify(events.filter((event) => event.type === 'delta'))).not.toContain('Analyze user input');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'plain:latest',
      prompt: 'User: hello\nAssistant:',
      stream: true
    });
  });



  it('removes fake assistant continuations around complete streamed thinking blocks and resumes visible output', async () => {
    const encoder = new TextEncoder();
    const payload = [
      JSON.stringify({ model: 'plain:latest', response: 'Visible before.\n\n### Assist', done: false }),
      JSON.stringify({ model: 'plain:latest', response: 'ant:\n<think>hidden streamed reasoning</think>\n\nVisible after.', done: false }),
      JSON.stringify({ model: 'plain:latest', done: true, total_duration: 123, eval_count: 3 })
    ].join('\n');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${payload}\n`));
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
    const { textClient } = mockAxiosClients();
    textClient.post.mockResolvedValueOnce({ data: { capabilities: ['completion'], digest: 'plain-digest' } });

    const { generateWithLlmStream } = await loadLlmClient();
    const events: LlmStreamEvent[] = [];
    for await (const event of generateWithLlmStream('User: hello\nAssistant:', { model: 'plain:latest' })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'metadata',
      'delta',
      'thinking_lifecycle',
      'thinking_delta',
      'delta',
      'thinking_lifecycle',
      'done'
    ]);
    const visibleDeltas = events.filter((event) => event.type === 'delta');
    expect(visibleDeltas[0]).toMatchObject({ type: 'delta', delta: 'Visible before.', content: 'Visible before.' });
    expect(visibleDeltas[1]).toMatchObject({
      type: 'delta',
      delta: '\n\nVisible after.',
      content: 'Visible before.\n\nVisible after.'
    });
    const fakeAssistantDoneEvent = events.find((event) => event.type === 'done');
    if (!fakeAssistantDoneEvent || fakeAssistantDoneEvent.type !== 'done') throw new Error('Expected done event.');
    expect(fakeAssistantDoneEvent).toMatchObject({
      type: 'done',
      content: 'Visible before.\n\nVisible after.',
      metadata: {
        hasRawThinkingTag: true,
        rawThinkingTagSuppressed: true,
        hasUntaggedReasoning: true,
        untaggedReasoningSuppressed: true,
        thinkingContentDiscarded: true,
        thinkingContentSuppressed: true,
        thinking: expect.objectContaining({ discarded: true })
      }
    });
    expect(fakeAssistantDoneEvent.metadata).not.toHaveProperty('thinkingContent');
    expect(JSON.stringify(events.filter((event) => event.type === 'delta'))).not.toContain('### Assistant');
    expect(JSON.stringify(events.filter((event) => event.type === 'delta'))).not.toContain('hidden streamed reasoning');
  });

  it('separates literal think blocks that arrive split across streamed response chunks when thinking is enabled', async () => {
    const encoder = new TextEncoder();
    const payload = [
      JSON.stringify({ model: 'hf-qwen', response: '<thi', done: false }),
      JSON.stringify({ model: 'hf-qwen', response: 'nk>private streamed reasoning</thi', done: false }),
      JSON.stringify({ model: 'hf-qwen', response: 'nk>\n\nI am Q8.', done: false }),
      JSON.stringify({ model: 'hf-qwen', done: true, total_duration: 123, eval_count: 3 })
    ].join('\n');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload.slice(0, 58)));
        controller.enqueue(encoder.encode(payload.slice(58) + '\n'));
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
    const { textClient } = mockAxiosClients();
    textClient.post.mockResolvedValueOnce({
      data: {
        capabilities: ['completion'],
        digest: 'hf-qwen-digest',
        details: { family: 'qwen35', families: ['qwen35'] }
      }
    });

    const model = 'hf.co/gaston-parravicini/Qwen3.6-27B-Abliterated-MTP-GGUF:Q8_0';
    const { generateWithLlmStream } = await loadLlmClient();
    const events: LlmStreamEvent[] = [];
    for await (const event of generateWithLlmStream('User: hi\nAssistant:', { model, enableThinking: true })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'metadata',
      'thinking_lifecycle',
      'thinking_delta',
      'delta',
      'thinking_lifecycle',
      'done'
    ]);
    expect(events.find((event) => event.type === 'thinking_delta')).toMatchObject({
      type: 'thinking_delta',
      delta: 'private streamed reasoning',
      thinking: 'private streamed reasoning'
    });
    expect(events.find((event) => event.type === 'delta')).toMatchObject({ type: 'delta', delta: 'I am Q8.', content: 'I am Q8.' });
    expect(events.find((event) => event.type === 'done')).toMatchObject({
      type: 'done',
      content: 'I am Q8.',
      metadata: {
        provider: 'ollama',
        model,
        thinkingCapabilityDetected: false,
        thinkingRequested: true,
        thinkingEnabled: true,
        thinkEnabledReason: 'known-reasoning-model',
        hasRawThinkingTag: true,
        rawThinkingTagSuppressed: true,
        thinkingContentDiscarded: true,
        thinking: expect.objectContaining({ discarded: true })
      }
    });
    const splitThinkingDoneEvent = events.find((event) => event.type === 'done');
    if (!splitThinkingDoneEvent || splitThinkingDoneEvent.type !== 'done') throw new Error('Expected done event.');
    expect(splitThinkingDoneEvent.metadata).not.toHaveProperty('thinkingContent');
    expect(events.filter((event) => event.type === 'delta').map((event) => JSON.stringify(event)).join('')).not.toContain('private streamed reasoning');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      model,
      prompt: '/think\n\nUser: hi\nAssistant:',
      stream: true,
      think: true
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
    const { textClient } = mockAxiosClients();
    textClient.post.mockResolvedValueOnce({ data: { capabilities: ['completion'] } });

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
    const { localAiClient } = mockAxiosClients();
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
    const { localAiClient } = mockAxiosClients();
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
