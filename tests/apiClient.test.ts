import { afterEach, describe, expect, it, vi } from 'vitest';

const authRequiredResponse = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Authentication required.'
      }
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );

const authResponse = ({ mustChangePassword, csrfToken }: { mustChangePassword: boolean; csrfToken: string }) =>
  new Response(
    JSON.stringify({
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        displayName: 'Eric',
        loginName: 'eric',
        isAdmin: true,
        mustChangePassword
      },
      mustChangePassword,
      csrfToken,
      passwordPolicy: { minLength: 8 }
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );

const loadApi = async () => {
  vi.resetModules();
  return import('../client/src/lib/api.js');
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('api client authentication errors', () => {
  it('does not hide password-change failures behind the global unauthorized redirect', async () => {
    const { api, ApiClientError } = await loadApi();
    const unauthorizedHandler = vi.fn();
    const fetchMock = vi.fn(async () => authRequiredResponse());

    vi.stubGlobal('fetch', fetchMock);
    api.setUnauthorizedHandler(unauthorizedHandler);
    api.setCsrfToken('csrf-token');

    await expect(api.changePassword('old-password', 'new-password', 'new-password')).rejects.toBeInstanceOf(
      ApiClientError
    );

    expect(unauthorizedHandler).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/change-password',
      expect.objectContaining({
        credentials: 'include',
        method: 'POST'
      })
    );

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const init = firstCall?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
  });

  it('keeps the global unauthorized redirect for normal session restoration failures', async () => {
    const { api, ApiClientError } = await loadApi();
    const unauthorizedHandler = vi.fn();

    vi.stubGlobal('fetch', vi.fn(async () => authRequiredResponse()));
    api.setUnauthorizedHandler(unauthorizedHandler);

    await expect(api.me()).rejects.toBeInstanceOf(ApiClientError);
    expect(unauthorizedHandler).toHaveBeenCalledOnce();
  });

  it('does not treat a stale must-change-password success response as a completed password update', async () => {
    const { api } = await loadApi();
    const fetchMock = vi.fn(async () => authResponse({ mustChangePassword: true, csrfToken: 'next-csrf-token' }));

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    await expect(api.changePassword('old-password', 'new-password', 'new-password')).rejects.toMatchObject({
      status: 500,
      code: 'PASSWORD_CHANGE_NOT_COMPLETED'
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('verifies completed password changes against the persisted auth state before resolving', async () => {
    const { api } = await loadApi();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authResponse({ mustChangePassword: false, csrfToken: 'changed-csrf-token' }))
      .mockResolvedValueOnce(authResponse({ mustChangePassword: false, csrfToken: 'verified-csrf-token' }));

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    const response = await api.changePassword('same-password', 'same-password', 'same-password');

    expect(response.mustChangePassword).toBe(false);
    expect(response.user.mustChangePassword).toBe(false);
    expect(response.csrfToken).toBe('verified-csrf-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/auth/change-password',
      expect.objectContaining({ credentials: 'include', method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/auth/me',
      expect.objectContaining({ credentials: 'include', method: 'GET' })
    );
  });

  it('does not close the password-change flow when the follow-up auth state still requires a password change', async () => {
    const { api } = await loadApi();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authResponse({ mustChangePassword: false, csrfToken: 'changed-csrf-token' }))
      .mockResolvedValueOnce(authResponse({ mustChangePassword: true, csrfToken: 'verified-csrf-token' }));

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    await expect(api.changePassword('same-password', 'same-password', 'same-password')).rejects.toMatchObject({
      status: 500,
      code: 'PASSWORD_CHANGE_NOT_COMPLETED'
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('api client text-to-speech requests', () => {
  it('requests speech audio through the gateway with CSRF and returns the WAV blob', async () => {
    const { api } = await loadApi();
    const audioBlob = new Blob(['RIFF'], { type: 'audio/wav' });
    const fetchMock = vi.fn(async () =>
      new Response(audioBlob, {
        status: 200,
        headers: {
          'Content-Type': 'audio/wav'
        }
      })
    );

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    const result = await api.speakText('Hello from Bear Castle AI.', { voice: 'af_heart', speed: 1 });

    expect(result.type).toBe('audio/wav');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/speak',
      expect.objectContaining({
        credentials: 'include',
        method: 'POST'
      })
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'Hello from Bear Castle AI.',
      voice: 'af_heart',
      speed: 1
    });
  });

  it('surfaces JSON errors from the speech endpoint', async () => {
    const { api } = await loadApi();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'TTS_TEXT_TOO_LONG',
              message: 'Text is too long to speak.'
            }
          }),
          {
            status: 400,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
    );

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    await expect(api.speakText('too long')).rejects.toMatchObject({
      status: 400,
      code: 'TTS_TEXT_TOO_LONG',
      message: 'Text is too long to speak.'
    });
  });
});

describe('api client model settings requests', () => {
  it('loads models through the gateway with CSRF and makeDefault payload', async () => {
    const { api } = await loadApi();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            defaultModel: 'qwen3:14b',
            defaultModelSource: 'local-ai-llm',
            defaultModelLoaded: true,
            loadedModels: [{ name: 'qwen3:14b' }],
            availableModels: [{ name: 'qwen3:14b' }],
            source: {
              health: { status: 'ok' },
              ollamaTags: { status: 'ok' },
              ollamaPs: { status: 'ok' }
            },
            generatedAt: '2026-05-24T12:00:00.000Z',
            message: 'Model loaded and set as default.'
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
    );

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    const response = await api.loadModel('qwen3:14b', true);

    expect(response.defaultModel).toBe('qwen3:14b');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/models/load',
      expect.objectContaining({
        credentials: 'include',
        method: 'POST'
      })
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'qwen3:14b',
      makeDefault: true
    });
  });
});

describe('api client model manager requests', () => {
  it('requests model details through the gateway', async () => {
    const { api } = await loadApi();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: 'qwen3:14b',
            summary: { name: 'qwen3:14b', parameterSize: '14B', quantization: 'Q4_K_M' },
            raw: {},
            generatedAt: '2026-05-24T12:00:00.000Z'
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
    );

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    const response = await api.getModelDetails('qwen3:14b');

    expect(response.summary.parameterSize).toBe('14B');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/models/details',
      expect.objectContaining({
        credentials: 'include',
        method: 'POST'
      })
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'qwen3:14b' });
  });

  it('streams model pull progress through the gateway', async () => {
    const { api } = await loadApi();
    const encoder = new TextEncoder();
    const events = [
      {
        type: 'progress',
        model: 'qwen3:14b',
        status: 'pulling manifest',
        generatedAt: '2026-05-24T12:00:00.000Z'
      },
      {
        type: 'complete',
        model: 'qwen3:14b',
        status: 'success',
        completedBytes: 100,
        totalBytes: 100,
        percent: 100,
        generatedAt: '2026-05-24T12:00:01.000Z'
      }
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        controller.close();
      }
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: {
            'Content-Type': 'application/x-ndjson'
          }
        })
    );
    const onProgress = vi.fn();

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    const finalEvent = await api.pullModel('qwen3:14b', onProgress);

    expect(finalEvent.type).toBe('complete');
    expect(finalEvent.percent).toBe(100);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/models/pull',
      expect.objectContaining({
        credentials: 'include',
        method: 'POST'
      })
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'qwen3:14b' });
  });

  it('deletes local models through the gateway with CSRF', async () => {
    const { api } = await loadApi();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            defaultModel: 'qwen3:30b',
            defaultModelSource: 'local-ai-llm',
            defaultModelLoaded: true,
            loadedModels: [{ name: 'qwen3:30b' }],
            availableModels: [],
            storage: {
              installedModelBytes: 0,
              installedModelCount: 0,
              disk: null,
              lowSpace: null
            },
            catalog: {
              mode: 'manual',
              stableApiAvailable: false,
              libraryUrl: 'https://ollama.com/search',
              message: 'Manual model-name entry is available.'
            },
            source: {
              health: { status: 'ok' },
              ollamaTags: { status: 'ok' },
              ollamaPs: { status: 'ok' },
              storage: { status: 'skipped' }
            },
            generatedAt: '2026-05-24T12:00:00.000Z',
            message: 'Deleted local model qwen3:14b.'
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
    );

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    const response = await api.deleteModel('qwen3:14b');

    expect(response.message).toBe('Deleted local model qwen3:14b.');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/models',
      expect.objectContaining({
        credentials: 'include',
        method: 'DELETE'
      })
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'qwen3:14b' });
  });
});

describe('api client voice VM settings requests', () => {
  it('loads the aggregated voice settings overview through the Bear Castle AI gateway', async () => {
    const { api } = await loadApi();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            health: { status: 'ok' },
            services: { stt: { status: 'ready' }, tts: { status: 'ready' } },
            gpu: { available: true, devices: [] },
            system: {},
            models: { stt: null, tts: null },
            config: null,
            voices: null,
            errors: {},
            generatedAt: '2026-05-26T00:00:00.000Z'
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        )
    );

    vi.stubGlobal('fetch', fetchMock);

    const response = await api.getVoiceOverview();

    expect(response.health?.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/voice',
      expect.objectContaining({ credentials: 'include', method: 'GET' })
    );
  });

  it('loads STT models using the modern voice settings gateway route', async () => {
    const { api } = await loadApi();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            kind: 'stt',
            provider: 'fast-whisper',
            defaultModel: 'large-v3-turbo',
            activeModel: 'large-v3-turbo',
            worker: { status: 'ready' },
            models: [{ id: 'large-v3-turbo', label: 'large-v3-turbo', model: 'large-v3-turbo' }]
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        )
    );

    vi.stubGlobal('fetch', fetchMock);

    const response = await api.getSttModels();

    expect(response.kind).toBe('stt');
    expect(response.models[0]?.id).toBe('large-v3-turbo');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/voice/models/stt',
      expect.objectContaining({ credentials: 'include', method: 'GET' })
    );
  });

  it('sends STT load requests with CSRF to the modern voice model route', async () => {
    const { api } = await loadApi();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { ok: true }, message: 'STT model large-v3-turbo load requested.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    );

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    const response = await api.loadSttModel({
      provider: 'fast-whisper',
      model: 'large-v3-turbo',
      computeType: 'int8_float16',
      options: {}
    });

    expect(response.message).toContain('STT model');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/voice/models/stt/load',
      expect.objectContaining({ credentials: 'include', method: 'POST' })
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(JSON.parse(init.body as string)).toEqual({
      provider: 'fast-whisper',
      model: 'large-v3-turbo',
      computeType: 'int8_float16',
      options: {}
    });
  });

  it('uploads TTS reference audio with CSRF through the gateway', async () => {
    const { api } = await loadApi();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { id: 'sample' }, message: 'Reference audio uploaded.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    );

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    const response = await api.uploadReferenceAudio(new Blob(['RIFF'], { type: 'audio/wav' }), 'sample.wav');

    expect(response.message).toBe('Reference audio uploaded.');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/voice/reference-audio',
      expect.objectContaining({ credentials: 'include', method: 'POST' })
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(init.body).toBeInstanceOf(FormData);
  });
});
