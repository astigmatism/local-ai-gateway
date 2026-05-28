import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmStreamEvent } from '../server/src/services/llmClient.js';

const stubEnv = () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test');
  vi.stubEnv('LLM_BASE_URL', 'http://ollama.test');
  vi.stubEnv('LLM_MONITOR_BASE_URL', 'http://local-ai-llm.test');
  vi.stubEnv('LLM_MODEL', 'qwen3:30b');
};

const loadLlmClient = async () => {
  vi.resetModules();
  stubEnv();
  return import('../server/src/services/llmClient.js');
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
