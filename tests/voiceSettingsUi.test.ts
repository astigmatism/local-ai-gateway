import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');

describe('Settings > Voice provider-selection UI', () => {
  it('puts provider selection first and separates advanced settings from health', () => {
    const source = readSource('client/src/components/VoiceSettingsPanel.tsx');

    const providerSelectionIndex = source.indexOf('TTS Provider Selection');
    const advancedSettingsIndex = source.indexOf('Advanced Settings —');
    const healthSummaryIndex = source.indexOf('Health Summary');

    expect(providerSelectionIndex).toBeGreaterThan(-1);
    expect(advancedSettingsIndex).toBeGreaterThan(providerSelectionIndex);
    expect(healthSummaryIndex).toBeGreaterThan(advancedSettingsIndex);
    expect(source).toContain('tts-provider-selection-grid');
    expect(source).toContain('Use this one');
    expect(source).toContain('Active');
    expect(source).not.toContain('<h4>My speech voice</h4>');
  });

  it('shows only the active provider controls inside Advanced Settings', () => {
    const source = readSource('client/src/components/VoiceSettingsPanel.tsx');

    expect(source).toContain("selectedSpeechProvider === 'chatterbox'");
    expect(source).toContain('aria-label="Chatterbox TTS advanced settings"');
    expect(source).toContain('aria-label="Kokoro advanced settings"');
    expect(source).toContain('Chatterbox reference audio');
    expect(source).toContain('Chatterbox reference WAV controls are hidden');
    expect(source).toContain('Kokoro never receives referenceAudioId or referenceAudioPath');
    const preferencesSource = readSource('client/src/lib/ttsPreferences.ts');
    expect(preferencesSource).toContain("kokoro: 'Kokoro'");
    expect(source).not.toContain('Cocoro');
    expect(source).not.toContain('KOKORO');
    expect(source).not.toContain('Kokoro.ai');
  });

  it('saves provider selection as a per-user app TTS preference without unloading providers or changing appliance defaults', () => {
    const source = readSource('client/src/components/VoiceSettingsPanel.tsx');

    const selectionStart = source.indexOf('const selectSpeechProvider = async (provider: TtsProviderId)');
    const selectionEnd = source.indexOf('const testSpeech = async', selectionStart);
    const selectionSource = source.slice(selectionStart, selectionEnd);

    expect(selectionStart).toBeGreaterThan(-1);
    expect(selectionSource).toContain('api.updateVoiceTtsPreference');
    expect(selectionSource).toContain('The other provider remains on standby');
    expect(selectionSource).not.toContain('api.updateTtsConfig');
    expect(selectionSource).not.toContain('api.unloadTtsModel');
  });

  it('message-level Speak playback resolves and sends the saved provider explicitly', () => {
    const playbackSource = readSource('client/src/hooks/useTextToSpeechPlayback.ts');
    const preferencesSource = readSource('client/src/lib/ttsPreferences.ts');

    expect(playbackSource).toContain('api.getVoiceTtsPreference()');
    expect(playbackSource).toContain('ttsSpeakOptionsFromPreference(preference)');
    expect(preferencesSource).toContain('export const ttsSpeakOptionsFromPreference');
    expect(preferencesSource).toContain("provider: 'kokoro'");
    expect(preferencesSource).toContain("provider: 'chatterbox'");
    expect(preferencesSource).toContain('referenceAudioId: chatterbox.referenceAudioId ?? undefined');
  });
});
