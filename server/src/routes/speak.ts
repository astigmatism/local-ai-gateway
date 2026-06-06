import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { ApiError } from '../errors/apiError.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { speakText, type TtsProviderId, type VoiceSpeechOptions } from '../services/voiceClient.js';
import { getSelectedVoiceReferenceIdForTts } from '../services/voiceReferenceService.js';

export const speakRouter = Router();

const speakRateLimiter = createRateLimiter({
  keyPrefix: 'tts-speak',
  windowMs: config.rateLimits.tts.windowMs,
  max: config.rateLimits.tts.max,
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? 'unknown'
});

const ttsProviderSchema = z.enum(['chatterbox', 'kokoro']);

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().max(160).optional()
);

const optionalReferenceText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().max(1024).optional()
);

const optionalControlNumber = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}, z.coerce.number().finite().optional());

const speakBodySchema = z
  .object({
    provider: ttsProviderSchema.optional(),
    text: z.unknown().optional(),
    voice: optionalText,
    speed: optionalControlNumber,
    exaggeration: optionalControlNumber,
    cfg_weight: optionalControlNumber,
    cfgWeight: optionalControlNumber,
    temperature: optionalControlNumber,
    language: optionalText,
    model: optionalText,
    referenceAudioId: optionalReferenceText,
    referenceAudioPath: optionalReferenceText,
    format: z.literal('wav').optional(),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough();

type ParsedSpeakRequest = {
  provider?: TtsProviderId;
  text: string;
  voice?: string;
  speed?: number;
  exaggeration?: number;
  cfgWeight?: number;
  temperature?: number;
  language?: string;
  model?: string;
  referenceAudioId?: string;
  referenceAudioPath?: string;
  format?: 'wav';
  metadata?: Record<string, unknown>;
};

const parseSpeakRequest = (body: unknown): ParsedSpeakRequest => {
  const parsedResult = speakBodySchema.safeParse(body ?? {});
  if (!parsedResult.success) {
    const providerIssue = parsedResult.error.issues.find((issue) => issue.path.includes('provider'));
    if (providerIssue) {
      throw new ApiError(400, 'Unsupported TTS provider. Use chatterbox or kokoro.', 'TTS_PROVIDER_UNSUPPORTED');
    }
    throw new ApiError(400, 'Invalid text-to-speech request.', 'TTS_REQUEST_INVALID', {
      issues: parsedResult.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    });
  }

  const parsed = parsedResult.data;

  if (typeof parsed.text !== 'string') {
    throw new ApiError(400, 'Text is required.', 'TTS_TEXT_REQUIRED');
  }

  const text = parsed.text.trim();
  if (text.length === 0) {
    throw new ApiError(400, 'Text is required.', 'TTS_TEXT_REQUIRED');
  }

  if (text.length > config.tts.maxTextChars) {
    throw new ApiError(
      400,
      `This message is too long to speak. Maximum is ${config.tts.maxTextChars} characters.`,
      'TTS_TEXT_TOO_LONG'
    );
  }

  if (parsed.speed !== undefined && (parsed.speed < 0.25 || parsed.speed > 4.0)) {
    throw new ApiError(400, 'Speed must be between 0.25 and 4.0.', 'TTS_INVALID_SPEED');
  }

  for (const [name, value] of [
    ['exaggeration', parsed.exaggeration],
    ['cfg_weight', parsed.cfgWeight ?? parsed.cfg_weight],
    ['temperature', parsed.temperature]
  ] as const) {
    if (value !== undefined && (value < 0 || value > 5)) {
      throw new ApiError(400, `${name} must be between 0 and 5.`, 'TTS_INVALID_CONTROL');
    }
  }

  if (parsed.provider === 'kokoro' && (parsed.referenceAudioId || parsed.referenceAudioPath)) {
    throw new ApiError(400, 'Kokoro does not support Chatterbox reference audio.', 'TTS_REFERENCE_AUDIO_UNSUPPORTED');
  }

  return {
    provider: parsed.provider,
    text,
    voice: parsed.voice,
    speed: parsed.speed,
    exaggeration: parsed.exaggeration,
    cfgWeight: parsed.cfgWeight ?? parsed.cfg_weight,
    temperature: parsed.temperature,
    language: parsed.language,
    model: parsed.model,
    referenceAudioId: parsed.referenceAudioId,
    referenceAudioPath: parsed.referenceAudioPath,
    format: parsed.format,
    metadata: parsed.metadata
  };
};

const providerEnabled = (provider: TtsProviderId) => config.tts.providers[provider].enabled;

const resolveRequestProvider = (requestedProvider: TtsProviderId | undefined): TtsProviderId | undefined =>
  requestedProvider ?? (config.tts.explicitProvider ? config.tts.defaultProvider : undefined);

const resolveFallbackProvider = (provider: TtsProviderId | undefined): TtsProviderId | undefined => {
  if (!provider || config.tts.fallbackPolicy === 'fail') return undefined;

  if (config.tts.fallbackPolicy === 'try-default-provider') {
    const fallbackProvider = config.tts.defaultProvider;
    return fallbackProvider !== provider && providerEnabled(fallbackProvider) ? fallbackProvider : undefined;
  }

  const fallbackProvider = provider === 'chatterbox' ? 'kokoro' : 'chatterbox';
  return providerEnabled(fallbackProvider) ? fallbackProvider : undefined;
};

const shouldRetryWithFallback = (error: unknown) =>
  error instanceof ApiError && [500, 502, 503, 504].includes(error.statusCode);

const requestIdForLog = (req: unknown) => {
  const maybeReq = req as { id?: unknown; headers?: { [key: string]: unknown } };
  const requestId = maybeReq.id ?? maybeReq.headers?.['x-request-id'];
  return typeof requestId === 'string' ? requestId.slice(0, 120) : undefined;
};

const safeErrorForLog = (error: unknown) => {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message.slice(0, 240)
    };
  }
  if (error instanceof Error) return { message: error.message.slice(0, 240) };
  return { message: 'Unknown TTS error' };
};

const buildSpeechOptions = (
  body: ParsedSpeakRequest,
  provider: TtsProviderId | undefined,
  selectedReferenceId: string | undefined,
  fallbackUsed: boolean
): VoiceSpeechOptions => {
  const providerDefaults = provider ? config.tts.providers[provider] : undefined;
  const isChatterbox = provider === 'chatterbox' || (!provider && config.tts.defaultProvider === 'chatterbox');
  const useChatterboxReference = isChatterbox && !fallbackUsed;

  return {
    provider,
    text: body.text,
    voice: fallbackUsed ? providerDefaults?.defaultVoice : body.voice ?? selectedReferenceId ?? providerDefaults?.defaultVoice,
    speed: body.speed,
    language: body.language,
    model: fallbackUsed ? providerDefaults?.defaultModel : body.model ?? providerDefaults?.defaultModel,
    format: body.format,
    metadata: body.metadata,
    timeoutMs: config.tts.timeoutMs,
    exaggeration: useChatterboxReference ? body.exaggeration : undefined,
    cfgWeight: useChatterboxReference ? body.cfgWeight : undefined,
    temperature: useChatterboxReference ? body.temperature : undefined,
    referenceAudioId: useChatterboxReference ? body.referenceAudioId ?? selectedReferenceId : undefined,
    referenceAudioPath: useChatterboxReference ? body.referenceAudioPath : undefined
  };
};

const selectedReferenceForProvider = async (body: ParsedSpeakRequest, provider: TtsProviderId | undefined, fallbackUsed: boolean) => {
  const referenceProvider = provider ?? config.tts.defaultProvider;
  if (referenceProvider !== 'chatterbox' || fallbackUsed || body.voice || body.referenceAudioId || body.referenceAudioPath) return undefined;
  return getSelectedVoiceReferenceIdForTts();
};

const safeResponseHeader = (value: string | undefined) => {
  if (!value) return undefined;
  return value.replace(/[\r\n]/g, '').slice(0, 160);
};

speakRouter.post(
  '/',
  speakRateLimiter,
  asyncHandler(async (req, res) => {
    if (!req.auth?.user.id) {
      throw new ApiError(401, 'Authentication required.', 'AUTH_REQUIRED');
    }

    if (!config.tts.enabled) {
      throw new ApiError(403, 'Text-to-speech is disabled.', 'TTS_DISABLED');
    }

    const body = parseSpeakRequest(req.body);
    const requestedProvider = body.provider;
    const selectedProvider = resolveRequestProvider(requestedProvider);
    if (selectedProvider && !providerEnabled(selectedProvider)) {
      throw new ApiError(403, `Text-to-speech provider ${selectedProvider} is disabled.`, 'TTS_PROVIDER_DISABLED');
    }

    const speakWithProvider = async (provider: TtsProviderId | undefined, fallbackUsed: boolean) => {
      const selectedReferenceId = await selectedReferenceForProvider(body, provider, fallbackUsed);
      return speakText(buildSpeechOptions(body, provider, selectedReferenceId, fallbackUsed));
    };

    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof speakText>>;
    let responseProvider = selectedProvider;
    let fallbackUsed = false;

    try {
      result = await speakWithProvider(selectedProvider, false);
    } catch (error) {
      const fallbackProvider = resolveFallbackProvider(selectedProvider);
      if (!fallbackProvider || !shouldRetryWithFallback(error)) {
        logger.warn(
          {
            event: 'tts.speak.failed',
            requestId: requestIdForLog(req),
            provider: selectedProvider ?? 'default',
            requestedProvider: requestedProvider ?? null,
            fallbackPolicy: config.tts.fallbackPolicy,
            textLength: body.text.length,
            error: safeErrorForLog(error)
          },
          'TTS speak request failed'
        );
        throw error;
      }

      logger.warn(
        {
          event: 'tts.speak.fallback',
          requestId: requestIdForLog(req),
          provider: selectedProvider,
          fallbackProvider,
          fallbackPolicy: config.tts.fallbackPolicy,
          textLength: body.text.length,
          reason: safeErrorForLog(error)
        },
        'Retrying TTS speak request with configured fallback provider'
      );
      result = await speakWithProvider(fallbackProvider, true);
      responseProvider = fallbackProvider;
      fallbackUsed = true;
    }

    res.setHeader('Content-Type', result.contentType || 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');

    const ttsEngine = safeResponseHeader(result.headers.engine);
    const ttsVoice = safeResponseHeader(result.headers.voice);
    const ttsSpeed = safeResponseHeader(result.headers.speed);
    const ttsModel = safeResponseHeader(result.headers.model);
    const ttsLanguage = safeResponseHeader(result.headers.language);
    const ttsProvider = safeResponseHeader(result.headers.provider ?? responseProvider);

    if (ttsEngine) res.setHeader('X-TTS-Engine', ttsEngine);
    if (ttsVoice) res.setHeader('X-TTS-Voice', ttsVoice);
    if (ttsSpeed) res.setHeader('X-TTS-Speed', ttsSpeed);
    if (ttsModel) res.setHeader('X-TTS-Model', ttsModel);
    if (ttsLanguage) res.setHeader('X-TTS-Language', ttsLanguage);
    if (ttsProvider) res.setHeader('X-TTS-Provider', ttsProvider);

    logger.info(
      {
        event: 'tts.speak.proxy',
        requestId: requestIdForLog(req),
        provider: responseProvider ?? 'default',
        requestedProvider: requestedProvider ?? null,
        voice: body.voice,
        model: body.model,
        language: body.language,
        speed: body.speed,
        textLength: body.text.length,
        status: 200,
        durationMs: Date.now() - startedAt,
        audioBytes: result.audio.byteLength,
        fallbackUsed,
        fallbackPolicy: config.tts.fallbackPolicy
      },
      'TTS speak proxy request completed'
    );

    res.status(200).send(result.audio);
  })
);
