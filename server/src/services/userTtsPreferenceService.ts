import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { config } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../errors/apiError.js';
import type { TtsProviderId, VoiceModelCatalogResponse, VoiceModelDescriptor } from './voiceClient.js';

export interface ChatterboxTtsPreference {
  model?: string;
  voice?: string;
  language?: string;
  speed?: number;
  referenceAudioId?: string | null;
  referenceAudioPath?: string | null;
  exaggeration?: number;
  cfgWeight?: number;
  temperature?: number;
}

export interface KokoroTtsPreference {
  model?: string;
  voice?: string;
  language?: string;
  speed?: number;
}

export interface UserTtsPreference {
  provider: TtsProviderId;
  chatterbox: ChatterboxTtsPreference;
  kokoro: KokoroTtsPreference;
  updatedAt?: string;
}

export type UserTtsPreferencePatch = Partial<Pick<UserTtsPreference, 'provider'>> & {
  chatterbox?: Partial<ChatterboxTtsPreference>;
  kokoro?: Partial<KokoroTtsPreference>;
};

export type KnownTtsModelOptions = Partial<Record<TtsProviderId, readonly string[]>>;

type UnknownRecord = Record<string, unknown>;

interface StoredUserTtsPreferenceRow {
  id: string;
  userId: string;
  preference: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

interface UserTtsPreferenceDelegate {
  findUnique(args: { where: { userId: string } }): Promise<StoredUserTtsPreferenceRow | null>;
  upsert(args: {
    where: { userId: string };
    create: { userId: string; preference: Prisma.InputJsonObject };
    update: { preference: Prisma.InputJsonObject };
  }): Promise<StoredUserTtsPreferenceRow>;
}

const userTtsPreferenceDelegate = () =>
  (prisma as unknown as { userTtsPreference: UserTtsPreferenceDelegate }).userTtsPreference;

const providerIds = ['chatterbox', 'kokoro'] as const;
const ttsProviderSchema = z.enum(providerIds);

const emptyStringToUndefined = (value: unknown) => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
};

const emptyStringToNull = (value: unknown) => {
  if (typeof value === 'string' && value.trim() === '') return null;
  return value;
};

const hasUnsafeControlCharacter = (value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const charCode = value.charCodeAt(index);
    if (charCode <= 31 || charCode === 127) return true;
  }
  return false;
};

const noControlCharacters = (value: string) => !hasUnsafeControlCharacter(value);
const notUrl = (value: string) => !/^https?:\/\//i.test(value) && !value.startsWith('//');

const safeText = (maxLength = 160) =>
  z.preprocess(
    emptyStringToUndefined,
    z
      .string()
      .trim()
      .min(1)
      .max(maxLength)
      .refine(noControlCharacters, 'must not contain control characters')
      .refine(notUrl, 'must not be a URL')
      .optional()
  );

const nullableSafeText = (maxLength = 240) =>
  z.preprocess(
    emptyStringToNull,
    z
      .string()
      .trim()
      .min(1)
      .max(maxLength)
      .refine(noControlCharacters, 'must not contain control characters')
      .refine(notUrl, 'must not be a URL')
      .nullable()
      .optional()
  );

const speedSchema = z.preprocess(emptyStringToUndefined, z.coerce.number().finite().min(0.25).max(4).optional());
const tuningSchema = z.preprocess(emptyStringToUndefined, z.coerce.number().finite().min(0).max(5).optional());

const chatterboxPreferencePatchSchema = z
  .object({
    model: safeText(),
    voice: safeText(),
    language: safeText(32),
    speed: speedSchema,
    referenceAudioId: nullableSafeText(240),
    referenceAudioPath: nullableSafeText(1024),
    exaggeration: tuningSchema,
    cfgWeight: tuningSchema,
    temperature: tuningSchema
  })
  .strict();

const kokoroPreferencePatchSchema = z
  .object({
    model: safeText(),
    voice: safeText(),
    language: safeText(32),
    speed: speedSchema
  })
  .strict();

const userTtsPreferencePatchSchema = z
  .object({
    provider: ttsProviderSchema.optional(),
    chatterbox: chatterboxPreferencePatchSchema.optional(),
    kokoro: kokoroPreferencePatchSchema.optional()
  })
  .strict()
  .refine((body) => body.provider !== undefined || body.chatterbox !== undefined || body.kokoro !== undefined, {
    message: 'At least one TTS preference field is required.'
  });

const asRecord = (value: unknown): UnknownRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : null;

const cleanString = (value: unknown, maxLength = 160) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || !noControlCharacters(trimmed) || !notUrl(trimmed)) return undefined;
  return trimmed;
};

const cleanNullableString = (value: unknown, maxLength = 240) => {
  if (value === null) return null;
  return cleanString(value, maxLength);
};

const cleanNumberInRange = (value: unknown, min: number, max: number) => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < min || parsed > max) return undefined;
  return parsed;
};

const stripUndefinedFields = <T extends Record<string, unknown>>(record: T): T => {
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) delete record[key];
  }
  return record;
};

const providerDefaults = (provider: TtsProviderId) => config.tts.providers[provider];

export const getDefaultUserTtsPreference = (): UserTtsPreference => ({
  provider: config.tts.defaultProvider ?? 'chatterbox',
  chatterbox: stripUndefinedFields({
    model: providerDefaults('chatterbox').defaultModel,
    voice: providerDefaults('chatterbox').defaultVoice,
    language: 'en',
    speed: config.tts.defaultSpeed
  }),
  kokoro: stripUndefinedFields({
    model: providerDefaults('kokoro').defaultModel ?? 'kokoro-default',
    voice: providerDefaults('kokoro').defaultVoice ?? config.tts.defaultVoice,
    language: 'a',
    speed: config.tts.defaultSpeed
  })
});

const normalizeStoredChatterboxPreference = (value: unknown): ChatterboxTtsPreference => {
  const record = asRecord(value) ?? {};
  return stripUndefinedFields({
    model: cleanString(record.model),
    voice: cleanString(record.voice),
    language: cleanString(record.language, 32),
    speed: cleanNumberInRange(record.speed, 0.25, 4),
    referenceAudioId: cleanNullableString(record.referenceAudioId ?? record.reference_audio_id, 240),
    referenceAudioPath: cleanNullableString(record.referenceAudioPath ?? record.reference_audio_path, 1024),
    exaggeration: cleanNumberInRange(record.exaggeration, 0, 5),
    cfgWeight: cleanNumberInRange(record.cfgWeight ?? record.cfg_weight, 0, 5),
    temperature: cleanNumberInRange(record.temperature, 0, 5)
  });
};

const normalizeStoredKokoroPreference = (value: unknown): KokoroTtsPreference => {
  const record = asRecord(value) ?? {};
  return stripUndefinedFields({
    model: cleanString(record.model),
    voice: cleanString(record.voice),
    language: cleanString(record.language, 32),
    speed: cleanNumberInRange(record.speed, 0.25, 4)
  });
};

const normalizeProvider = (value: unknown): TtsProviderId | undefined => {
  if (typeof value !== 'string') return undefined;
  const parsed = value.trim().toLowerCase();
  return (providerIds as readonly string[]).includes(parsed) ? (parsed as TtsProviderId) : undefined;
};

export const normalizeUserTtsPreference = (value: unknown, updatedAt?: string): UserTtsPreference => {
  const defaults = getDefaultUserTtsPreference();
  const record = asRecord(value) ?? {};
  const provider = normalizeProvider(record.provider) ?? defaults.provider;

  return stripUndefinedFields({
    provider,
    chatterbox: {
      ...defaults.chatterbox,
      ...normalizeStoredChatterboxPreference(record.chatterbox)
    },
    kokoro: {
      ...defaults.kokoro,
      ...normalizeStoredKokoroPreference(record.kokoro)
    },
    updatedAt
  });
};

const uniqueStrings = (values: Array<string | undefined>) => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
};

const modelValuesForProvider = (catalog: VoiceModelCatalogResponse | null | undefined, provider: TtsProviderId) => {
  const providerCatalog = catalog?.providers?.[provider];
  const scopedModels = providerCatalog?.models ?? catalog?.models?.filter((model) => model.provider === provider) ?? [];

  return uniqueStrings([
    providerCatalog?.currentModel,
    providerCatalog?.defaultModel,
    providerCatalog?.activeModel,
    providerCatalog?.loadedModel,
    ...scopedModels.flatMap((model: VoiceModelDescriptor) => [model.model, model.name, model.id])
  ]);
};

export const knownTtsModelOptionsFromCatalog = (catalog: VoiceModelCatalogResponse | null | undefined): KnownTtsModelOptions => ({
  chatterbox: modelValuesForProvider(catalog, 'chatterbox'),
  kokoro: modelValuesForProvider(catalog, 'kokoro')
});

const canonicalModelFallbacks = (provider: TtsProviderId) =>
  uniqueStrings([providerDefaults(provider).defaultModel, provider === 'kokoro' ? 'kokoro-default' : undefined]);

const validateKnownModel = (provider: TtsProviderId, model: string | undefined, knownModels?: KnownTtsModelOptions) => {
  if (!model) return;
  const allowed = knownModels?.[provider];
  if (!allowed || allowed.length === 0) return;
  const normalizedAllowed = uniqueStrings([...allowed, ...canonicalModelFallbacks(provider)]);
  if (!normalizedAllowed.includes(model)) {
    throw new ApiError(
      400,
      `${provider === 'kokoro' ? 'Kokoro' : 'Chatterbox TTS'} model ${model} is not in the reported provider model catalog.`,
      'TTS_PREFERENCE_MODEL_UNSUPPORTED',
      { provider, model, allowedModels: normalizedAllowed }
    );
  }
};

const hasKokoroReferenceFields = (body: unknown) => {
  const kokoro = asRecord(asRecord(body)?.kokoro);
  if (!kokoro) return false;
  return 'referenceAudioId' in kokoro || 'reference_audio_id' in kokoro || 'referenceAudioPath' in kokoro || 'reference_audio_path' in kokoro;
};

export const parseUserTtsPreferencePatch = (body: unknown, knownModels?: KnownTtsModelOptions): UserTtsPreferencePatch => {
  if (hasKokoroReferenceFields(body)) {
    throw new ApiError(400, 'Kokoro does not support Chatterbox reference audio fields.', 'TTS_REFERENCE_AUDIO_UNSUPPORTED');
  }

  const parsed = userTtsPreferencePatchSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const providerIssue = parsed.error.issues.find((issue) => issue.path.includes('provider'));
    if (providerIssue) {
      throw new ApiError(400, 'Unsupported TTS provider. Use chatterbox or kokoro.', 'TTS_PROVIDER_UNSUPPORTED');
    }
    throw new ApiError(400, 'Invalid TTS preference update.', 'TTS_PREFERENCE_INVALID', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    });
  }

  validateKnownModel('chatterbox', parsed.data.chatterbox?.model, knownModels);
  validateKnownModel('kokoro', parsed.data.kokoro?.model, knownModels);

  return parsed.data;
};

export const mergeUserTtsPreference = (current: UserTtsPreference, patch: UserTtsPreferencePatch): UserTtsPreference => {
  const normalizedCurrent = normalizeUserTtsPreference(current, current.updatedAt);
  return stripUndefinedFields({
    provider: patch.provider ?? normalizedCurrent.provider,
    chatterbox: stripUndefinedFields({
      ...normalizedCurrent.chatterbox,
      ...(patch.chatterbox ?? {})
    }),
    kokoro: stripUndefinedFields({
      ...normalizedCurrent.kokoro,
      ...(patch.kokoro ?? {})
    }),
    updatedAt: normalizedCurrent.updatedAt
  });
};

const preferenceToJson = (preference: UserTtsPreference): Prisma.InputJsonObject => {
  const { updatedAt: _updatedAt, ...persistedPreference } = preference;
  return JSON.parse(JSON.stringify(persistedPreference)) as Prisma.InputJsonObject;
};

export const getUserTtsPreference = async (userId: string): Promise<UserTtsPreference> => {
  const row = await userTtsPreferenceDelegate().findUnique({ where: { userId } });
  if (!row) return getDefaultUserTtsPreference();
  return normalizeUserTtsPreference(row.preference, row.updatedAt.toISOString());
};

export const updateUserTtsPreference = async (
  userId: string,
  body: unknown,
  knownModels?: KnownTtsModelOptions
): Promise<UserTtsPreference> => {
  const patch = parseUserTtsPreferencePatch(body, knownModels);
  const current = await getUserTtsPreference(userId);
  const merged = mergeUserTtsPreference(current, patch);
  const row = await userTtsPreferenceDelegate().upsert({
    where: { userId },
    create: {
      userId,
      preference: preferenceToJson(merged)
    },
    update: {
      preference: preferenceToJson(merged)
    }
  });

  return normalizeUserTtsPreference(row.preference, row.updatedAt.toISOString());
};
