import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { ApiError } from '../errors/apiError.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { speakText } from '../services/voiceClient.js';
import { getSelectedVoiceReferenceIdForTts } from '../services/voiceReferenceService.js';

export const speakRouter = Router();

const speakRateLimiter = createRateLimiter({
  keyPrefix: 'tts-speak',
  windowMs: config.rateLimits.tts.windowMs,
  max: config.rateLimits.tts.max,
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? 'unknown'
});

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().max(160).optional()
);

const optionalControlNumber = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}, z.coerce.number().finite().optional());

const speakBodySchema = z
  .object({
    text: z.unknown().optional(),
    voice: optionalText,
    speed: optionalControlNumber,
    exaggeration: optionalControlNumber,
    cfg_weight: optionalControlNumber,
    cfgWeight: optionalControlNumber,
    temperature: optionalControlNumber,
    language: optionalText,
    model: optionalText
  })
  .passthrough();

const parseSpeakRequest = (body: unknown) => {
  const parsed = speakBodySchema.parse(body ?? {});

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

  return {
    text,
    voice: parsed.voice,
    speed: parsed.speed,
    exaggeration: parsed.exaggeration,
    cfgWeight: parsed.cfgWeight ?? parsed.cfg_weight,
    temperature: parsed.temperature,
    language: parsed.language,
    model: parsed.model
  };
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
    const selectedReferenceId = body.voice ? undefined : await getSelectedVoiceReferenceIdForTts();
    const result = await speakText({
      ...body,
      voice: body.voice ?? selectedReferenceId,
      timeoutMs: config.tts.timeoutMs
    });

    res.setHeader('Content-Type', result.contentType || 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');

    const ttsEngine = safeResponseHeader(result.headers.engine);
    const ttsVoice = safeResponseHeader(result.headers.voice);
    const ttsSpeed = safeResponseHeader(result.headers.speed);
    const ttsModel = safeResponseHeader(result.headers.model);
    const ttsLanguage = safeResponseHeader(result.headers.language);

    if (ttsEngine) res.setHeader('X-TTS-Engine', ttsEngine);
    if (ttsVoice) res.setHeader('X-TTS-Voice', ttsVoice);
    if (ttsSpeed) res.setHeader('X-TTS-Speed', ttsSpeed);
    if (ttsModel) res.setHeader('X-TTS-Model', ttsModel);
    if (ttsLanguage) res.setHeader('X-TTS-Language', ttsLanguage);

    res.status(200).send(result.audio);
  })
);
