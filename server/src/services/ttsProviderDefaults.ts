import { config } from '../config/env.js';
import type { TtsProviderId } from './voiceClient.js';

const legacyKokoroModelParts = ['kokoro', 'default'] as const;
const legacyKokoroModelSeparator = '-';
const legacyUnsupportedKokoroDefaultModel = legacyKokoroModelParts.join(legacyKokoroModelSeparator);
const legacyUnsupportedChatterboxDefaultVoice = 'reference-upload';

const cleanConfiguredString = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

export const normalizeProviderVoiceForRuntime = (
  provider: TtsProviderId,
  voice: string | undefined
): string | undefined => {
  const trimmed = cleanConfiguredString(voice);
  if (!trimmed) return undefined;

  if (provider === 'chatterbox' && trimmed.toLowerCase() === legacyUnsupportedChatterboxDefaultVoice) {
    return undefined;
  }

  return trimmed;
};

export const configuredProviderDefaultModel = (provider: TtsProviderId): string | undefined =>
  cleanConfiguredString(config.tts.providers[provider]?.defaultModel);

export const configuredProviderDefaultVoice = (provider: TtsProviderId): string | undefined =>
  normalizeProviderVoiceForRuntime(provider, config.tts.providers[provider]?.defaultVoice);

export const providerRuntimeDefaults = (provider: TtsProviderId) => config.tts.providers[provider];

export const normalizeProviderModelForRuntime = (
  provider: TtsProviderId,
  model: string | undefined
): string | undefined => {
  const trimmed = cleanConfiguredString(model);
  if (!trimmed) return undefined;

  if (provider === 'kokoro' && trimmed === legacyUnsupportedKokoroDefaultModel) {
    return configuredProviderDefaultModel('kokoro');
  }

  return trimmed;
};
