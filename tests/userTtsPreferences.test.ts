import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface PreferenceRow {
  id: string;
  userId: string;
  preference: unknown;
  createdAt: Date;
  updatedAt: Date;
}

interface FindUniqueArgs {
  where: { userId: string };
}

interface UpsertArgs {
  where: { userId: string };
  create: { userId: string; preference: unknown };
  update: { preference: unknown };
}

const prismaState = vi.hoisted(() => ({
  rows: new Map<string, PreferenceRow>(),
  findUnique: vi.fn<(args: FindUniqueArgs) => Promise<PreferenceRow | null>>(),
  upsert: vi.fn<(args: UpsertArgs) => Promise<PreferenceRow>>()
}));

vi.mock('../server/src/db/prisma.js', () => ({
  prisma: {
    userTtsPreference: {
      findUnique: prismaState.findUnique,
      upsert: prismaState.upsert
    }
  }
}));

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
  TTS_DEFAULT_PROVIDER: 'chatterbox',
  TTS_CHATTERBOX_DEFAULT_MODEL: 'chatterbox-turbo',
  TTS_KOKORO_DEFAULT_MODEL: 'kokoro-default',
  TTS_KOKORO_DEFAULT_VOICE: 'af_heart'
} as const;

const loadPreferenceService = async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [name, value] of Object.entries(requiredTestEnv)) {
    vi.stubEnv(name, value);
  }
  return import('../server/src/services/userTtsPreferenceService.js');
};

beforeEach(() => {
  prismaState.rows.clear();
  prismaState.findUnique.mockImplementation(async ({ where }) => prismaState.rows.get(where.userId) ?? null);
  prismaState.upsert.mockImplementation(async ({ where, create, update }) => {
    const existing = prismaState.rows.get(where.userId);
    const row: PreferenceRow = existing
      ? {
          ...existing,
          preference: update.preference,
          updatedAt: new Date('2026-06-06T00:01:00.000Z')
        }
      : {
          id: `pref-${where.userId}`,
          userId: create.userId,
          preference: create.preference,
          createdAt: new Date('2026-06-06T00:00:00.000Z'),
          updatedAt: new Date('2026-06-06T00:00:00.000Z')
        };
    prismaState.rows.set(where.userId, row);
    return row;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('server-side per-user TTS preference persistence', () => {
  it('returns a provider-aware default preference for an authenticated user without saved settings', async () => {
    const { getUserTtsPreference } = await loadPreferenceService();

    const preference = await getUserTtsPreference('user-a');

    expect(preference).toMatchObject({
      provider: 'chatterbox',
      chatterbox: {
        model: 'chatterbox-turbo',
        language: 'en',
        speed: 1
      },
      kokoro: {
        model: 'kokoro-default',
        voice: 'af_heart',
        language: 'a',
        speed: 1
      }
    });
  });

  it('persists different provider preferences for different users', async () => {
    const { getUserTtsPreference, updateUserTtsPreference } = await loadPreferenceService();
    const knownModels = {
      chatterbox: ['chatterbox-turbo', 'chatterbox-small'],
      kokoro: ['kokoro-default']
    };

    await updateUserTtsPreference(
      'user-a',
      {
        provider: 'kokoro',
        kokoro: { model: 'kokoro-default', voice: 'af_heart', language: 'a', speed: 1.05 }
      },
      knownModels
    );
    await updateUserTtsPreference(
      'user-b',
      {
        provider: 'chatterbox',
        chatterbox: { model: 'chatterbox-small', referenceAudioId: 'speaker-profile-001', speed: 0.95 }
      },
      knownModels
    );

    await expect(getUserTtsPreference('user-a')).resolves.toMatchObject({
      provider: 'kokoro',
      kokoro: { voice: 'af_heart', speed: 1.05 },
      chatterbox: { model: 'chatterbox-turbo' }
    });
    await expect(getUserTtsPreference('user-b')).resolves.toMatchObject({
      provider: 'chatterbox',
      chatterbox: { model: 'chatterbox-small', referenceAudioId: 'speaker-profile-001', speed: 0.95 },
      kokoro: { model: 'kokoro-default' }
    });
  });

  it('merges partial updates without wiping the other provider settings', async () => {
    const { updateUserTtsPreference } = await loadPreferenceService();

    const kokoroSaved = await updateUserTtsPreference('user-a', {
      provider: 'kokoro',
      kokoro: { voice: 'af_heart', language: 'a', speed: 1.1 }
    });
    expect(kokoroSaved.kokoro.voice).toBe('af_heart');

    const merged = await updateUserTtsPreference('user-a', {
      provider: 'chatterbox',
      chatterbox: { referenceAudioId: 'speaker-profile-001' }
    });

    expect(merged.provider).toBe('chatterbox');
    expect(merged.chatterbox.referenceAudioId).toBe('speaker-profile-001');
    expect(merged.kokoro).toMatchObject({ voice: 'af_heart', language: 'a', speed: 1.1 });
  });
});

describe('TTS preference validation', () => {
  it('rejects unsupported providers and arbitrary provider URLs', async () => {
    const { parseUserTtsPreferencePatch } = await loadPreferenceService();

    expect(() => parseUserTtsPreferencePatch({ provider: 'elevenlabs' })).toThrow(/Unsupported TTS provider/);
    expect(() => parseUserTtsPreferencePatch({ provider: 'http://127.0.0.1:8003' })).toThrow(/Unsupported TTS provider/);
  });

  it('rejects attempts to write another user id in the preference body', async () => {
    const { parseUserTtsPreferencePatch } = await loadPreferenceService();

    expect(() => parseUserTtsPreferencePatch({ provider: 'kokoro', userId: 'user-b' })).toThrow(/Invalid TTS preference update/);
  });

  it('rejects Chatterbox reference audio fields inside Kokoro settings', async () => {
    const { parseUserTtsPreferencePatch } = await loadPreferenceService();

    expect(() =>
      parseUserTtsPreferencePatch({
        provider: 'kokoro',
        kokoro: { voice: 'af_heart', referenceAudioId: 'speaker-profile-001' }
      })
    ).toThrow(/Kokoro does not support Chatterbox reference audio fields/);
  });

  it('accepts Chatterbox reference audio fields', async () => {
    const { parseUserTtsPreferencePatch } = await loadPreferenceService();

    expect(
      parseUserTtsPreferencePatch({
        provider: 'chatterbox',
        chatterbox: { referenceAudioId: 'speaker-profile-001', referenceAudioPath: '/references/speaker.wav' }
      })
    ).toMatchObject({
      provider: 'chatterbox',
      chatterbox: { referenceAudioId: 'speaker-profile-001', referenceAudioPath: '/references/speaker.wav' }
    });
  });

  it('validates speed range and provider-scoped model catalogs', async () => {
    const { parseUserTtsPreferencePatch } = await loadPreferenceService();

    expect(() => parseUserTtsPreferencePatch({ provider: 'kokoro', kokoro: { speed: 99 } })).toThrow(
      /Invalid TTS preference update/
    );
    expect(() =>
      parseUserTtsPreferencePatch(
        { provider: 'chatterbox', chatterbox: { model: 'kokoro-default' } },
        { chatterbox: ['chatterbox-turbo'], kokoro: ['kokoro-default'] }
      )
    ).toThrow(/Chatterbox TTS model kokoro-default is not in the reported provider model catalog/);
  });
});
