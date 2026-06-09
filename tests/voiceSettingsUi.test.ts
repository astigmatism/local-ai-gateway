import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');

describe('Settings > Voice provider-aware UI', () => {
  it('renders provider registry separately from the authenticated user speech preference', () => {
    const source = readSource('client/src/components/VoiceSettingsPanel.tsx');

    expect(source).toContain('<h4>TTS Providers</h4>');
    expect(source).toContain('<h4>My speech voice</h4>');
    expect(source).toContain('tts-provider-choice-group');
    expect(source).toContain('api.getVoiceTtsPreference()');
    expect(source).toContain('api.updateVoiceTtsPreference');
    expect(source).not.toContain('saveTtsSpeechPreference');
    expect(source).not.toContain('readTtsSpeechPreference');
  });

  it('keeps Chatterbox models and Kokoro settings provider-scoped', () => {
    const source = readSource('client/src/components/VoiceSettingsPanel.tsx');

    expect(source).toContain('Chatterbox model');
    expect(source).toContain('Kokoro model');
    expect(source).toContain('chatterboxModelOptions');
    expect(source).toContain('kokoroModelOptions');
    const preferencesSource = readSource('client/src/lib/ttsPreferences.ts');

    expect(source).toContain('Kokoro never receives referenceAudioId or referenceAudioPath');
    expect(source).toContain('Chatterbox reference audio controls are hidden');
    expect(preferencesSource).toContain("kokoro: 'Kokoro'");
    expect(source).not.toContain('kokoro-default');
    expect(preferencesSource).not.toContain('kokoro-default');
    expect(preferencesSource).not.toContain("model: 'kokoro");
  });
});
