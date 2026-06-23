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

describe('api client conversation routes', () => {
  it('uses authenticated conversation endpoints instead of admin-only user-management endpoints', async () => {
    const { api } = await loadApi();
    const conversationId = '22222222-2222-4222-8222-222222222222';
    const conversation = {
      id: conversationId,
      userId: '11111111-1111-4111-8111-111111111111',
      title: 'New conversation',
      archived: false,
      createdAt: '2026-05-29T12:00:00.000Z',
      updatedAt: '2026-05-29T12:00:00.000Z',
      messages: [],
      _count: { messages: 0 }
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';

      if (path === '/api/conversations' && method === 'GET') {
        return new Response(JSON.stringify({ conversations: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (path === '/api/conversations' && method === 'POST') {
        return new Response(JSON.stringify({ conversation }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (path === `/api/conversations/${conversationId}` && method === 'DELETE') {
        return new Response(JSON.stringify({ conversation: { ...conversation, archived: true } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ error: { code: 'UNEXPECTED_ROUTE', message: path } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    await expect(api.listConversations()).resolves.toEqual({ conversations: [] });
    await expect(api.createConversation()).resolves.toEqual({ conversation });
    await expect(api.deleteConversation(conversationId)).resolves.toEqual({
      conversation: { ...conversation, archived: true }
    });

    const paths = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(paths).toEqual(['/api/conversations', '/api/conversations', `/api/conversations/${conversationId}`]);
    expect(paths.some((path) => path.startsWith('/api/users/'))).toBe(false);
  });

  it('hides persisted assistant think blocks when loading conversation data', async () => {
    const { api } = await loadApi();
    const conversationId = '22222222-2222-4222-8222-222222222222';
    const summary = {
      id: conversationId,
      userId: '11111111-1111-4111-8111-111111111111',
      title: 'New conversation',
      archived: false,
      createdAt: '2026-05-29T12:00:00.000Z',
      updatedAt: '2026-05-29T12:01:00.000Z',
      messages: [
        {
          role: 'assistant',
          content: '<think>persisted reasoning</think>Visible answer',
          createdAt: '2026-05-29T12:01:00.000Z'
        }
      ],
      _count: { messages: 2 }
    };
    const conversation = {
      ...summary,
      messages: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          conversationId,
          role: 'user',
          content: 'Explain <think>literal user example</think>',
          createdAt: '2026-05-29T12:00:00.000Z'
        },
        {
          id: '44444444-4444-4444-8444-444444444444',
          conversationId,
          role: 'assistant',
          content: '<think>persisted reasoning</think>Visible answer',
          createdAt: '2026-05-29T12:01:00.000Z'
        }
      ]
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/conversations') {
        return new Response(JSON.stringify({ conversations: [summary] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (path === `/api/conversations/${conversationId}`) {
        return new Response(JSON.stringify({ conversation }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ error: { code: 'UNEXPECTED_ROUTE', message: path } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const listResponse = await api.listConversations();
    const detailResponse = await api.getConversation(conversationId);

    expect(listResponse.conversations[0]?.messages?.[0]?.content).toBe('Visible answer');
    expect(detailResponse.conversation.messages[0]?.content).toBe('Explain <think>literal user example</think>');
    expect(detailResponse.conversation.messages[1]?.content).toBe('Visible answer');
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

    const result = await api.speakText('Hello from Bear Castle AI.', { provider: 'kokoro', voice: 'af_heart', speed: 1 });

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
    expect(new Headers(init.headers).get('Accept')).toBe('audio/wav');
    expect(JSON.parse(init.body as string)).toEqual({
      provider: 'kokoro',
      text: 'Hello from Bear Castle AI.',
      voice: 'af_heart',
      speed: 1
    });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain('/api/settings/voice/models/tts/unload');
  });

  it('passes explicit Chatterbox provider and reference audio IDs for speech requests', async () => {
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

    await api.speakText('Hello from Chatterbox.', {
      provider: 'chatterbox',
      referenceAudioId: 'speaker-profile-001',
      language: 'en',
      speed: 1
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      provider: 'chatterbox',
      text: 'Hello from Chatterbox.',
      referenceAudioId: 'speaker-profile-001',
      language: 'en',
      speed: 1
    });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain('/api/settings/voice/models/tts/unload');
  });



  it('reads and updates the authenticated user TTS preference through Settings > Voice endpoints', async () => {
    const { api } = await loadApi();
    const preference = {
      provider: 'kokoro',
      chatterbox: {
        model: 'chatterbox-turbo',
        language: 'en',
        speed: 1
      },
      kokoro: {
        model: 'kokoro-82m',
        voice: 'af_heart',
        language: 'a',
        speed: 1
      },
      updatedAt: '2026-06-06T00:00:00.000Z'
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      if (path === '/api/settings/voice/preference' && method === 'GET') {
        return new Response(JSON.stringify(preference), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (path === '/api/settings/voice/preference' && method === 'PATCH') {
        return new Response(JSON.stringify({ ...preference, provider: 'chatterbox' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ error: { code: 'UNEXPECTED_ROUTE', message: path } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    await expect(api.getVoiceTtsPreference()).resolves.toEqual(preference);
    await expect(
      api.updateVoiceTtsPreference({
        provider: 'chatterbox',
        chatterbox: {
          model: 'chatterbox-turbo',
          referenceAudioId: 'speaker-profile-001'
        }
      })
    ).resolves.toMatchObject({ provider: 'chatterbox' });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/settings/voice/preference',
      expect.objectContaining({ credentials: 'include', method: 'GET' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/settings/voice/preference',
      expect.objectContaining({ credentials: 'include', method: 'PATCH' })
    );

    const patchInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(patchInit.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(JSON.parse(patchInit.body as string)).toEqual({
      provider: 'chatterbox',
      chatterbox: {
        model: 'chatterbox-turbo',
        referenceAudioId: 'speaker-profile-001'
      }
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

describe('api client speech-to-text requests', () => {
  it('uploads microphone audio through the Bear Castle gateway with CSRF and multipart field file', async () => {
    const { api } = await loadApi();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ transcript: 'Hello from the microphone.', segments: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    );

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    const response = await api.transcribeAudio(new Blob(['WEBM'], { type: 'audio/webm;codecs=opus' }), {
      userId: '11111111-1111-4111-8111-111111111111',
      conversationId: '22222222-2222-4222-8222-222222222222',
      vadFilter: true,
      minSilenceDurationMs: 1000,
      beamSize: 5,
      wordTimestamps: false
    });

    expect(response.transcript).toBe('Hello from the microphone.');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/transcribe',
      expect.objectContaining({ credentials: 'include', method: 'POST' })
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-CSRF-Token')).toBe('csrf-token');
    expect(headers.get('Content-Type')).toBeNull();
    expect(init.body).toBeInstanceOf(FormData);

    const formData = init.body as FormData;
    const uploadedFile = formData.get('file') as File;
    expect(uploadedFile.name).toBe('browser-recording.webm');
    expect(uploadedFile.type).toBe('audio/webm;codecs=opus');
    expect(formData.get('vad_filter')).toBe('true');
    expect(formData.get('min_silence_duration_ms')).toBe('1000');
    expect(formData.get('beam_size')).toBe('5');
    expect(formData.get('word_timestamps')).toBe('false');
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

    const response = await api.uploadReferenceAudio(new Blob(['RIFF'], { type: 'audio/wav' }), {
      filename: 'sample.wav',
      displayName: 'Eric sample.wav'
    });

    expect(response.message).toBe('Reference audio uploaded.');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/voice/reference-audio',
      expect.objectContaining({ credentials: 'include', method: 'POST' })
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(init.body).toBeInstanceOf(FormData);
    const formData = init.body as FormData;
    expect(formData.get('displayName')).toBe('Eric sample.wav');
    const uploadedFile = formData.get('reference_audio') as File;
    expect(uploadedFile.name).toBe('sample.wav');
    expect(uploadedFile.type).toBe('audio/wav');
    expect(formData.has('useAfterUpload')).toBe(false);
  });

  it('loads an existing voice reference through the gateway with CSRF', async () => {
    const { api } = await loadApi();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'Reference loaded for future TTS requests.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    );

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    const response = await api.selectVoiceReference('reference_20260527_abc123.wav');

    expect(response.message).toContain('Reference loaded');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/voice/references/select',
      expect.objectContaining({ credentials: 'include', method: 'POST' })
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(JSON.parse(init.body as string)).toEqual({ id: 'reference_20260527_abc123.wav' });
  });

  it('deletes an existing voice reference through the gateway with CSRF', async () => {
    const { api } = await loadApi();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'Reference audio deleted: Eric sample.wav.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    );

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    const response = await api.deleteVoiceReference('reference_20260527_abc123.wav');

    expect(response.message).toContain('Reference audio deleted');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/voice/references/reference_20260527_abc123.wav',
      expect.objectContaining({ credentials: 'include', method: 'DELETE' })
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
  });
});

describe('api client chat streaming requests', () => {
  it('streams chat deltas through the gateway with CSRF and returns the final done event', async () => {
    const { api } = await loadApi();
    const encoder = new TextEncoder();
    const events = [
      {
        type: 'start',
        conversationId: '22222222-2222-4222-8222-222222222222',
        userMessage: {
          id: '33333333-3333-4333-8333-333333333333',
          conversationId: '22222222-2222-4222-8222-222222222222',
          role: 'user',
          content: 'Tell me about streaming.',
          createdAt: '2026-05-28T12:00:00.000Z'
        },
        assistantMessageTempId: 'stream-assistant-temp',
        model: 'qwen3:14b',
        createdAt: '2026-05-28T12:00:00.000Z'
      },
      {
        type: 'delta',
        delta: 'Real',
        content: 'Real',
        generatedAt: '2026-05-28T12:00:01.000Z'
      },
      {
        type: 'delta',
        delta: ' streaming',
        content: 'Real streaming',
        generatedAt: '2026-05-28T12:00:02.000Z'
      },
      {
        type: 'done',
        assistantMessage: {
          id: '44444444-4444-4444-8444-444444444444',
          conversationId: '22222222-2222-4222-8222-222222222222',
          role: 'assistant',
          content: 'Real streaming',
          createdAt: '2026-05-28T12:00:03.000Z'
        },
        conversation: {
          id: '22222222-2222-4222-8222-222222222222',
          userId: '11111111-1111-4111-8111-111111111111',
          title: 'New conversation',
          archived: false,
          createdAt: '2026-05-28T12:00:00.000Z',
          updatedAt: '2026-05-28T12:00:03.000Z'
        },
        titleGeneration: { needed: true }
      }
    ];
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify(events[0])}\n${JSON.stringify(events[1])}\n`));
        controller.enqueue(encoder.encode(`${JSON.stringify(events[2])}\n${JSON.stringify(events[3])}\n`));
        controller.close();
      }
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, {
          status: 201,
          headers: {
            'Content-Type': 'application/x-ndjson'
          }
        })
    );
    const onEvent = vi.fn();

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    const doneEvent = await api.sendMessageStream('22222222-2222-4222-8222-222222222222', 'Tell me about streaming.', {
      enableThinking: true,
      onEvent
    });

    expect(doneEvent.type).toBe('done');
    expect(doneEvent.assistantMessage.content).toBe('Real streaming');
    expect(onEvent).toHaveBeenCalledTimes(4);
    expect(onEvent.mock.calls.map((call) => call[0].type)).toEqual(['start', 'delta', 'delta', 'done']);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations/22222222-2222-4222-8222-222222222222/messages/stream',
      expect.objectContaining({
        credentials: 'include',
        method: 'POST'
      })
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(new Headers(init.headers).get('Accept')).toBe('application/x-ndjson');
    expect(JSON.parse(init.body as string)).toEqual({ content: 'Tell me about streaming.', enableThinking: true });
  });

  it('separates raw think blocks in chat streams even if the server leaks them', async () => {
    const { api } = await loadApi();
    const encoder = new TextEncoder();
    const events = [
      {
        type: 'start',
        conversationId: '22222222-2222-4222-8222-222222222222',
        userMessage: {
          id: '33333333-3333-4333-8333-333333333333',
          conversationId: '22222222-2222-4222-8222-222222222222',
          role: 'user',
          content: 'Hello',
          createdAt: '2026-05-28T12:00:00.000Z'
        },
        assistantMessageTempId: 'stream-assistant-temp',
        model: 'qwen3:14b',
        createdAt: '2026-05-28T12:00:00.000Z'
      },
      {
        type: 'delta',
        delta: '<thi',
        content: '<thi',
        generatedAt: '2026-05-28T12:00:01.000Z'
      },
      {
        type: 'delta',
        delta: 'nk>private browser-side reasoning</think>\n\nVisible answer',
        content: '<think>private browser-side reasoning</think>\n\nVisible answer',
        generatedAt: '2026-05-28T12:00:02.000Z'
      },
      {
        type: 'done',
        assistantMessage: {
          id: '44444444-4444-4444-8444-444444444444',
          conversationId: '22222222-2222-4222-8222-222222222222',
          role: 'assistant',
          content: '<think>persisted private reasoning</think>\n\nVisible answer',
          createdAt: '2026-05-28T12:00:03.000Z'
        },
        conversation: {
          id: '22222222-2222-4222-8222-222222222222',
          userId: '11111111-1111-4111-8111-111111111111',
          title: 'New conversation',
          archived: false,
          createdAt: '2026-05-28T12:00:00.000Z',
          updatedAt: '2026-05-28T12:00:03.000Z',
          messages: [
            {
              role: 'assistant',
              content: '<think>summary private reasoning</think>Visible answer',
              createdAt: '2026-05-28T12:00:03.000Z'
            }
          ]
        },
        metadata: {}
      }
    ];
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify(events[0])}\n${JSON.stringify(events[1])}\n`));
        controller.enqueue(encoder.encode(`${JSON.stringify(events[2])}\n${JSON.stringify(events[3])}\n`));
        controller.close();
      }
    });
    const onEvent = vi.fn();

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(stream, {
            status: 201,
            headers: { 'Content-Type': 'application/x-ndjson' }
          })
      )
    );

    const doneEvent = await api.sendMessageStream('22222222-2222-4222-8222-222222222222', 'Hello', { onEvent });

    expect(onEvent.mock.calls.map((call) => call[0].type)).toEqual(['start', 'thinking_delta', 'delta', 'done']);
    expect(onEvent.mock.calls[1]?.[0]).toMatchObject({
      type: 'thinking_delta',
      delta: 'private browser-side reasoning',
      thinking: 'private browser-side reasoning'
    });
    expect(onEvent.mock.calls[2]?.[0]).toMatchObject({
      type: 'delta',
      delta: 'Visible answer',
      content: 'Visible answer'
    });
    expect(doneEvent.assistantMessage.content).toBe('Visible answer');
    expect(doneEvent.conversation.messages?.[0]?.content).toBe('Visible answer');
    expect(doneEvent.metadata).toMatchObject({
      hasRawThinkingTag: true,
      rawThinkingTagSuppressed: true,
      thinkingContent: 'private browser-side reasoning\n\npersisted private reasoning'
    });
    expect(JSON.stringify(onEvent.mock.calls.filter((call) => call[0].type === 'delta'))).not.toContain('private browser-side reasoning');
    expect(doneEvent.assistantMessage.content).not.toContain('persisted private reasoning');
  });

  it('turns chat stream error events into ApiClientError failures', async () => {
    const { api } = await loadApi();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ type: 'error', message: 'The model stream failed.', code: 'LLM_STREAM_FAILED', generatedAt: '2026-05-28T12:00:00.000Z' })}\n`
          )
        );
        controller.close();
      }
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(stream, {
            status: 201,
            headers: { 'Content-Type': 'application/x-ndjson' }
          })
      )
    );

    await expect(api.sendMessageStream('22222222-2222-4222-8222-222222222222', 'Hello')).rejects.toMatchObject({
      code: 'LLM_STREAM_FAILED',
      message: 'The model stream failed.'
    });
  });
});

describe('api client admin user management', () => {
  it('reads temporary-password metadata and calls the purge endpoint with DELETE', async () => {
    const { api } = await loadApi();
    const userId = '22222222-2222-4222-8222-222222222222';
    const adminUser = {
      id: userId,
      displayName: 'Ada Lovelace',
      loginName: 'ada_lovelace',
      isAdmin: false,
      mustChangePassword: true,
      isActive: true,
      lockedUntil: null,
      lastLoginAt: null,
      passwordChangedAt: null,
      createdAt: '2026-05-29T12:00:00.000Z',
      updatedAt: '2026-05-29T12:00:00.000Z',
      deletedAt: null
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestPath = String(input);
      const method = init?.method ?? 'GET';

      if (requestPath === '/api/admin/users' && method === 'GET') {
        return new Response(
          JSON.stringify({
            users: [adminUser],
            newUserTemporaryPassword: 'new-user-password'
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      if (requestPath === `/api/admin/users/${userId}` && method === 'DELETE') {
        return new Response(
          JSON.stringify({
            deletedUserId: userId,
            purgedUser: adminUser,
            deleted: {
              authSessions: 1,
              messages: 2,
              conversations: 1,
              audioSnippets: 0,
              generatedImageFiles: {
                referenced: 0,
                deleted: 0,
                missing: 0,
                failed: 0
              }
            }
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      return new Response(JSON.stringify({ error: { code: 'UNEXPECTED_ROUTE', message: requestPath } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    await expect(api.listAdminUsers()).resolves.toEqual({
      users: [adminUser],
      newUserTemporaryPassword: 'new-user-password'
    });
    await expect(api.purgeAdminUser(userId)).resolves.toMatchObject({ deletedUserId: userId });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/admin/users',
      expect.objectContaining({ credentials: 'include', method: 'GET' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/admin/users/${userId}`,
      expect.objectContaining({ credentials: 'include', method: 'DELETE' })
    );
    const deleteRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(deleteRequest.headers).get('X-CSRF-Token')).toBe('csrf-token');
  });
});
