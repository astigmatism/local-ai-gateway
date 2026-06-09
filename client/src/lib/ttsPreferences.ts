import type {
  ChatterboxTtsPreference,
  KokoroTtsPreference,
  TtsProviderId,
  UserTtsPreference,
  UserTtsPreferencePatch
} from './types.js';

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

const cleanString = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const cleanNullableString = (value: unknown) => (value === null ? null : cleanString(value));

const cleanNumber = (value: unknown, fallback?: number) => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0.25 || parsed > 4) return fallback;
  return parsed;
};

const cleanTuningNumber = (value: unknown) => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < 0 || parsed > 5) return undefined;
  return parsed;
};

const stripUndefinedFields = <T extends Record<string, unknown>>(record: T): T => {
  Object.keys(record).forEach((key) => {
    if (record[key] === undefined) delete record[key];
  });
  return record;
};

export const defaultUserTtsPreference: UserTtsPreference = {
  provider: 'chatterbox',
  chatterbox: {
    language: 'en',
    speed: 1
  },
  kokoro: {
    language: 'a',
    speed: 1
  }
};

const normalizeChatterboxPreference = (value: unknown): ChatterboxTtsPreference => {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return stripUndefinedFields({
    model: cleanString(record.model),
    voice: cleanString(record.voice),
    language: cleanString(record.language),
    speed: cleanNumber(record.speed),
    referenceAudioId: cleanNullableString(record.referenceAudioId),
    referenceAudioPath: cleanNullableString(record.referenceAudioPath),
    exaggeration: cleanTuningNumber(record.exaggeration),
    cfgWeight: cleanTuningNumber(record.cfgWeight),
    temperature: cleanTuningNumber(record.temperature)
  });
};

const normalizeKokoroPreference = (value: unknown): KokoroTtsPreference => {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return stripUndefinedFields({
    model: cleanString(record.model),
    voice: cleanString(record.voice),
    language: cleanString(record.language),
    speed: cleanNumber(record.speed)
  });
};

export const normalizeUserTtsPreference = (value: unknown): UserTtsPreference => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultUserTtsPreference;
  const record = value as Record<string, unknown>;
  return stripUndefinedFields({
    provider: normalizeTtsProviderId(record.provider) ?? defaultUserTtsPreference.provider,
    chatterbox: {
      ...defaultUserTtsPreference.chatterbox,
      ...normalizeChatterboxPreference(record.chatterbox)
    },
    kokoro: {
      ...defaultUserTtsPreference.kokoro,
      ...normalizeKokoroPreference(record.kokoro)
    },
    updatedAt: cleanString(record.updatedAt)
  });
};

export const mergeUserTtsPreference = (
  current: UserTtsPreference,
  patch: UserTtsPreferencePatch
): UserTtsPreference =>
  normalizeUserTtsPreference({
    ...current,
    provider: patch.provider ?? current.provider,
    chatterbox: {
      ...current.chatterbox,
      ...(patch.chatterbox ?? {})
    },
    kokoro: {
      ...current.kokoro,
      ...(patch.kokoro ?? {})
    }
  });
