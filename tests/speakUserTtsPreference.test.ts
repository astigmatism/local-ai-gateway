import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const userId = '11111111-1111-4111-8111-111111111111';

const requiredTestEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test',
  INITIAL_ADMIN_PASSWORD: 'initial-admin-password',
  NEW_USER_DEFAULT_PASSWORD: 'new-user-password',
  SESSION_SECRET: 'test-session-secret-with-enough-entropy',
  LLM_BASE_URL: 'http://ollama.test',
  LLM_MONITOR_BASE_URL: 'http://local-ai-llm.test',
  LLM_MODEL: 'qwen3:30b',
  VOICE_BASE_URL: 'http://127.0.0.1:8000',
  TTS_ENABLED: 'true',
  TTS_DEFAULT_PROVIDER: 'chatterbox',
  TTS_EXPLICIT_PROVIDER: 'true',
  TTS_FALLBACK_POLICY: 'fail',
  TTS_CHATTERBOX_DEFAULT_MODEL: 'chatterbox-turbo',
  TTS_KOKORO_DEFAULT_MODEL: 'kokoro-test-model'
} as const;

interface MockUserTtsPreference {
  provider: 'chatterbox' | 'kokoro';
  chatterbox: {
    model?: string;
    voice?: string;
    language?: string;
    speed?: number;
    referenceAudioId?: string | null;
    referenceAudioPath?: string | null;
    exaggeration?: number;
    cfgWeight?: number;
    temperature?: number;
  };
  kokoro: {
    model?: string;
    voice?: string;
    language?: string;
    speed?: number;
  };
}

interface SpeakOptionsRecord extends Record<string, unknown> {
  text: string;
  provider?: 'chatterbox' | 'kokoro';
}

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

const close = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const jsonFetch = async (port: number, body: Record<string, unknown>) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const contentType = response.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/json')) {
    return { response, body: (await response.json()) as Record<string, unknown> };
  }
  return { response, body: await response.arrayBuffer() };
};

const loadSpeakApp = async (
  preference: MockUserTtsPreference,
  envOverrides: Record<string, string> = {},
  selectedReferenceId: string | undefined | null = 'loaded-chatterbox-reference'
) => {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(requiredTestEnv)) {
    vi.stubEnv(name, value);
  }
  for (const [name, value] of Object.entries(envOverrides)) {
    vi.stubEnv(name, value);
  }

  const speakText = vi.fn(async (options: SpeakOptionsRecord) => ({
    audio: Buffer.from('RIFF'),
    contentType: 'audio/wav',
    headers: {
      provider: options.provider,
      voice: typeof options.voice === 'string' ? options.voice : undefined,
      model: typeof options.model === 'string' ? options.model : undefined,
      language: typeof options.language === 'string' ? options.language : undefined,
      speed: typeof options.speed === 'number' ? String(options.speed) : undefined
    }
  }));
  const getUserTtsPreference = vi.fn(async () => preference);
  const getSelectedVoiceReferenceIdForTts = vi.fn(async () => selectedReferenceId ?? undefined);

  vi.doMock('../server/src/auth/rateLimit.js', () => ({
    createRateLimiter: () => (_req: Request, _res: Response, next: NextFunction) => next()
  }));
  vi.doMock('../server/src/services/voiceClient.js', () => ({
    speakText
  }));
  vi.doMock('../server/src/services/userTtsPreferenceService.js', () => ({
    getUserTtsPreference
  }));
  vi.doMock('../server/src/services/voiceReferenceService.js', () => ({
    getSelectedVoiceReferenceIdForTts
  }));

  const [{ speakRouter }, { errorHandler }] = await Promise.all([
    import('../server/src/routes/speak.js'),
    import('../server/src/middleware/errorHandler.js')
  ]);

  const app = express();
  app.use(express.json());
  app.use('/api/speak', (req, _res, next) => {
    (req as Request & { auth: unknown }).auth = {
      user: {
        id: userId,
        displayName: 'User A',
        loginName: 'user_a',
        isAdmin: false,
        mustChangePassword: false
      }
    };
    next();
  });
  app.use('/api/speak', speakRouter);
  app.use(errorHandler);

  return { app, speakText, getUserTtsPreference, getSelectedVoiceReferenceIdForTts };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../server/src/auth/rateLimit.js');
  vi.doUnmock('../server/src/services/voiceClient.js');
  vi.doUnmock('../server/src/services/userTtsPreferenceService.js');
  vi.doUnmock('../server/src/services/voiceReferenceService.js');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('speak route user TTS preference resolution', () => {
  it('uses the authenticated user Kokoro preference when no explicit provider is supplied', async () => {
    const { app, speakText, getUserTtsPreference } = await loadSpeakApp({
      provider: 'kokoro',
      chatterbox: {
        model: 'chatterbox-turbo',
        referenceAudioId: 'speaker-profile-001',
        language: 'en',
        speed: 1
      },
      kokoro: {
        model: 'kokoro-test-model',
        voice: 'af_heart',
        language: 'a',
        speed: 1.05
      }
    });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response } = await jsonFetch(port, { text: 'Hello from Kokoro.' });

      expect(response.status).toBe(200);
      expect(getUserTtsPreference).toHaveBeenCalledWith(userId);
      expect(speakText).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'kokoro',
          text: 'Hello from Kokoro.',
          model: 'kokoro-test-model',
          voice: 'af_heart',
          language: 'a',
          speed: 1.05
        })
      );
      const options = speakText.mock.calls[0]?.[0] as SpeakOptionsRecord;
      expect(options).not.toHaveProperty('referenceAudioId');
      expect(options).not.toHaveProperty('referenceAudioPath');
      expect(options).not.toHaveProperty('exaggeration');
      expect(options).not.toHaveProperty('cfgWeight');
      expect(options).not.toHaveProperty('temperature');
    } finally {
      await close(server);
    }
  });

  it('uses the configured Kokoro default model when the saved preference omits a model', async () => {
    const { app, speakText } = await loadSpeakApp(
      {
        provider: 'kokoro',
        chatterbox: { model: 'chatterbox-turbo', language: 'en', speed: 1 },
        kokoro: { voice: 'af_heart', language: 'a', speed: 1 }
      },
      { TTS_KOKORO_DEFAULT_MODEL: 'kokoro-env-swapped-model' }
    );
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response } = await jsonFetch(port, { text: 'Hello from configured Kokoro default.' });

      expect(response.status).toBe(200);
      expect(speakText).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'kokoro',
          model: 'kokoro-env-swapped-model'
        })
      );
    } finally {
      await close(server);
    }
  });

  it('normalizes a legacy persisted Kokoro placeholder before calling VoiceVM', async () => {
    const { app, speakText } = await loadSpeakApp(
      {
        provider: 'kokoro',
        chatterbox: { model: 'chatterbox-turbo', language: 'en', speed: 1 },
        kokoro: { model: 'kokoro-default', voice: 'af_heart', language: 'a', speed: 1 }
      },
      { TTS_KOKORO_DEFAULT_MODEL: 'kokoro-82m' }
    );
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response } = await jsonFetch(port, { text: 'Legacy Kokoro preference.' });

      expect(response.status).toBe(200);
      expect(speakText).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'kokoro',
          model: 'kokoro-82m'
        })
      );
    } finally {
      await close(server);
    }
  });

  it('uses the authenticated user Chatterbox preference and preserves reference audio fields', async () => {
    const { app, speakText } = await loadSpeakApp({
      provider: 'chatterbox',
      chatterbox: {
        model: 'chatterbox-turbo',
        referenceAudioId: 'speaker-profile-001',
        language: 'en',
        speed: 0.95,
        exaggeration: 0.7,
        cfgWeight: 0.4,
        temperature: 0.8
      },
      kokoro: {
        model: 'kokoro-test-model',
        voice: 'af_heart',
        language: 'a',
        speed: 1
      }
    });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response } = await jsonFetch(port, { text: 'Hello from Chatterbox.' });

      expect(response.status).toBe(200);
      expect(speakText).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'chatterbox',
          text: 'Hello from Chatterbox.',
          model: 'chatterbox-turbo',
          language: 'en',
          speed: 0.95,
          referenceAudioId: 'speaker-profile-001',
          exaggeration: 0.7,
          cfgWeight: 0.4,
          temperature: 0.8
        })
      );
    } finally {
      await close(server);
    }
  });

  it('does not send the legacy Chatterbox reference-upload default voice when no loaded reference exists', async () => {
    const { app, speakText, getSelectedVoiceReferenceIdForTts } = await loadSpeakApp(
      {
        provider: 'chatterbox',
        chatterbox: { model: 'chatterbox-turbo', language: 'en', speed: 1 },
        kokoro: { model: 'kokoro-test-model', voice: 'af_heart', language: 'a', speed: 1 }
      },
      { TTS_CHATTERBOX_DEFAULT_VOICE: 'reference-upload' },
      null
    );
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response } = await jsonFetch(port, { text: 'Hello from Chatterbox without a loaded reference.' });

      expect(response.status).toBe(200);
      expect(getSelectedVoiceReferenceIdForTts).toHaveBeenCalledOnce();
      const options = speakText.mock.calls[0]?.[0] as SpeakOptionsRecord;
      expect(options).toMatchObject({
        provider: 'chatterbox',
        text: 'Hello from Chatterbox without a loaded reference.',
        model: 'chatterbox-turbo',
        language: 'en',
        speed: 1
      });
      expect(options).not.toHaveProperty('voice');
      expect(options).not.toHaveProperty('referenceAudioId');
    } finally {
      await close(server);
    }
  });

  it('rejects Chatterbox reference audio fields when the resolved provider is Kokoro', async () => {
    const { app, speakText } = await loadSpeakApp({
      provider: 'kokoro',
      chatterbox: { model: 'chatterbox-turbo', language: 'en', speed: 1 },
      kokoro: { model: 'kokoro-test-model', voice: 'af_heart', language: 'a', speed: 1 }
    });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response, body } = await jsonFetch(port, {
        text: 'This should not include Chatterbox fields.',
        referenceAudioId: 'speaker-profile-001'
      });

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: {
          code: 'TTS_REFERENCE_AUDIO_UNSUPPORTED'
        }
      });
      expect(speakText).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it('allows an explicit provider override without mutating the saved user preference', async () => {
    const { app, speakText, getUserTtsPreference } = await loadSpeakApp({
      provider: 'kokoro',
      chatterbox: { model: 'chatterbox-turbo', language: 'en', speed: 1 },
      kokoro: { model: 'kokoro-test-model', voice: 'af_heart', language: 'a', speed: 1 }
    });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response } = await jsonFetch(port, {
        provider: 'chatterbox',
        text: 'Explicit Chatterbox request.',
        referenceAudioId: 'speaker-profile-001'
      });

      expect(response.status).toBe(200);
      expect(getUserTtsPreference).toHaveBeenCalledWith(userId);
      expect(speakText).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'chatterbox',
          referenceAudioId: 'speaker-profile-001'
        })
      );
    } finally {
      await close(server);
    }
  });
});
