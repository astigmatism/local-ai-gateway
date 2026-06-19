import { describe, expect, it } from 'vitest';
import {
  defaultUserTtsPreference,
  normalizeUserTtsPreference,
  ttsSpeakOptionsFromPreference
} from '../client/src/lib/ttsPreferences.js';

describe('client-side TTS preference defaults', () => {
  it('does not invent provider model IDs in default preferences', () => {
    expect(defaultUserTtsPreference.chatterbox).not.toHaveProperty('model');
    expect(defaultUserTtsPreference.kokoro).not.toHaveProperty('model');
  });

  it('leaves Kokoro model undefined until the server or provider catalog supplies one', () => {
    const normalized = normalizeUserTtsPreference({ provider: 'kokoro', kokoro: { voice: 'af_heart' } });

    expect(normalized.provider).toBe('kokoro');
    expect(normalized.kokoro).toMatchObject({ voice: 'af_heart', language: 'a', speed: 1 });
    expect(normalized.kokoro).not.toHaveProperty('model');
  });

  it('builds explicit Kokoro speak options without Chatterbox reference fields', () => {
    const options = ttsSpeakOptionsFromPreference(
      normalizeUserTtsPreference({
        provider: 'kokoro',
        chatterbox: { referenceAudioId: 'speaker-1', referenceAudioPath: '/private/reference.wav' },
        kokoro: { voice: 'af_heart', language: 'a', speed: 1 }
      })
    );

    expect(options).toEqual({
      provider: 'kokoro',
      voice: 'af_heart',
      language: 'a',
      speed: 1
    });
    expect(options).not.toHaveProperty('referenceAudioId');
    expect(options).not.toHaveProperty('referenceAudioPath');
  });

  it('builds explicit Chatterbox speak options with Chatterbox tuning and reference fields', () => {
    const options = ttsSpeakOptionsFromPreference(
      normalizeUserTtsPreference({
        provider: 'chatterbox',
        chatterbox: {
          voice: 'speaker-1',
          language: 'en',
          speed: 1.05,
          referenceAudioId: 'speaker-1',
          exaggeration: 0.4,
          cfgWeight: 0.7,
          temperature: 0.8
        }
      })
    );

    expect(options).toMatchObject({
      provider: 'chatterbox',
      voice: 'speaker-1',
      language: 'en',
      speed: 1.05,
      referenceAudioId: 'speaker-1',
      exaggeration: 0.4,
      cfgWeight: 0.7,
      temperature: 0.8
    });
  });
});
