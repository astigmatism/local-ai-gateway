import type { TtsProviderId } from './types.js';

export interface TtsSpeechPreference {
  provider: TtsProviderId;
  voice?: string;
  model?: string;
  language?: string;
  speed?: number;
}

const storageKey = 'bearCastleAi.ttsSpeechPreference.v1';

export const ttsProviderOptions = ['chatterbox', 'kokoro'] as const satisfies readonly TtsProviderId[];

export const ttsProviderDisplayNames: Record<TtsProviderId, string> = {
  chatterbox: 'Chatterbox TTS',
  kokoro: 'Kokoro'
};

const normalizeTtsProviderId = (value: unknown): TtsProviderId | undefined => {
  if (typeof value !== 'string') return undefined;
  const parsed = value.trim().toLowerCase();
  return (ttsProviderOptions as readonly string[]).includes(parsed) ? (parsed as TtsProviderId) : undefined;
};

export const isTtsProviderId = (value: unknown): value is TtsProviderId => normalizeTtsProviderId(value) !== undefined;

export const defaultTtsSpeechPreference: TtsSpeechPreference = {
  provider: 'chatterbox',
  speed: 1
};

const browserStorage = () => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const cleanString = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const cleanSpeed = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0.25 || value > 4) return undefined;
  return value;
};

const normalizePreference = (value: unknown): TtsSpeechPreference => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return defaultTtsSpeechPreference;
  const record = value as Record<string, unknown>;
  const provider = normalizeTtsProviderId(record.provider) ?? defaultTtsSpeechPreference.provider;
  return {
    provider,
    voice: cleanString(record.voice),
    model: cleanString(record.model),
    language: cleanString(record.language),
    speed: cleanSpeed(record.speed) ?? defaultTtsSpeechPreference.speed
  };
};

export const hasTtsSpeechPreference = () => Boolean(browserStorage()?.getItem(storageKey));

export const readTtsSpeechPreference = (): TtsSpeechPreference => {
  const storage = browserStorage();
  if (!storage) return defaultTtsSpeechPreference;

  const raw = storage.getItem(storageKey);
  if (!raw) return defaultTtsSpeechPreference;

  try {
    return normalizePreference(JSON.parse(raw) as unknown);
  } catch {
    return defaultTtsSpeechPreference;
  }
};

export const saveTtsSpeechPreference = (preference: TtsSpeechPreference) => {
  const normalized = normalizePreference(preference);
  browserStorage()?.setItem(storageKey, JSON.stringify(normalized));
  return normalized;
};

export const clearTtsSpeechPreference = () => {
  browserStorage()?.removeItem(storageKey);
};
