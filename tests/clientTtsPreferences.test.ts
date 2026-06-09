import { describe, expect, it } from 'vitest';
import { defaultUserTtsPreference, normalizeUserTtsPreference } from '../client/src/lib/ttsPreferences.js';

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
});
