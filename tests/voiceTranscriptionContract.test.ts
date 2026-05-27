import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadVoiceClient = async () => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test');
  vi.stubEnv('VOICE_BASE_URL', 'http://127.0.0.1:8000');
  vi.stubEnv('INITIAL_ADMIN_PASSWORD', 'initial-admin-password');
  vi.stubEnv('NEW_USER_DEFAULT_PASSWORD', 'new-user-default-password');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-with-enough-entropy');
  return import('../server/src/services/voiceClient.js');
};

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('voice transcription contract normalization', () => {
  it('keeps the modern camelCase STT response shape stable for the frontend', async () => {
    const { normalizeVoiceTranscriptionResponse } = await loadVoiceClient();

    expect(
      normalizeVoiceTranscriptionResponse(
        {
          filename: 'browser-recording.webm',
          model: 'large-v3-turbo',
          defaultModel: 'large-v3-turbo',
          activeModel: 'large-v3-turbo',
          language: 'en',
          languageProbability: 0.98,
          vadFilter: true,
          minSilenceDurationMs: 1000,
          beamSize: 5,
          wordTimestamps: false,
          transcript: 'raw transcript',
          segments: [{ start: 0, end: 1.2, text: 'Hello.' }]
        },
        'Hello.'
      )
    ).toEqual({
      filename: 'browser-recording.webm',
      model: 'large-v3-turbo',
      defaultModel: 'large-v3-turbo',
      activeModel: 'large-v3-turbo',
      language: 'en',
      languageProbability: 0.98,
      vadFilter: true,
      minSilenceDurationMs: 1000,
      beamSize: 5,
      wordTimestamps: false,
      transcript: 'Hello.',
      segments: [{ start: 0, end: 1.2, text: 'Hello.' }]
    });
  });

  it('normalizes legacy snake_case STT fields when compatibility responses appear', async () => {
    const { normalizeVoiceTranscriptionResponse } = await loadVoiceClient();

    expect(
      normalizeVoiceTranscriptionResponse(
        {
          filename: 'sample.wav',
          model: 'large-v3-turbo',
          default_model: 'large-v3-turbo',
          active_model: 'large-v3-turbo',
          language_probability: 0.9,
          vad_filter: false,
          min_silence_duration_ms: 750,
          beam_size: 3,
          word_timestamps: true,
          transcript: 'legacy transcript',
          segments: []
        },
        'legacy transcript'
      )
    ).toMatchObject({
      filename: 'sample.wav',
      defaultModel: 'large-v3-turbo',
      activeModel: 'large-v3-turbo',
      languageProbability: 0.9,
      vadFilter: false,
      minSilenceDurationMs: 750,
      beamSize: 3,
      wordTimestamps: true,
      transcript: 'legacy transcript',
      segments: []
    });
  });
});
