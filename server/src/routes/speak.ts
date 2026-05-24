import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { ApiError } from '../errors/apiError.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { speakText } from '../services/voiceClient.js';

export const speakRouter = Router();

const speakRateLimiter = createRateLimiter({
  keyPrefix: 'tts-speak',
  windowMs: config.rateLimits.tts.windowMs,
  max: config.rateLimits.tts.max,
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? 'unknown'
});

const speakBodySchema = z
  .object({
    text: z.unknown().optional(),
    voice: z.unknown().optional(),
    speed: z.unknown().optional()
  })
  .passthrough();

const parseSpeakRequest = (body: unknown) => {
  const parsed = speakBodySchema.parse(body ?? {});

  if (typeof parsed.text !== 'string') {
    throw new ApiError(400, 'Text is required.', 'TTS_TEXT_REQUIRED');
  }

  if (parsed.text.trim().length === 0) {
    throw new ApiError(400, 'Text is required.', 'TTS_TEXT_REQUIRED');
  }

  if (parsed.text.length > config.tts.maxTextChars) {
    throw new ApiError(
      400,
      `This message is too long to speak. Maximum is ${config.tts.maxTextChars} characters.`,
      'TTS_TEXT_TOO_LONG'
    );
  }

  let voice = config.tts.defaultVoice;
  if (parsed.voice !== undefined) {
    if (typeof parsed.voice !== 'string' || parsed.voice.trim().length === 0) {
      throw new ApiError(400, 'Voice must be a non-empty string.', 'TTS_INVALID_VOICE');
    }
    voice = parsed.voice.trim();
    if (voice.length > 120) {
      throw new ApiError(400, 'Voice is too long.', 'TTS_INVALID_VOICE');
    }
  }

  let speed = config.tts.defaultSpeed;
  if (parsed.speed !== undefined) {
    speed =
      typeof parsed.speed === 'number'
        ? parsed.speed
        : typeof parsed.speed === 'string'
          ? Number(parsed.speed)
          : NaN;
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2.0) {
      throw new ApiError(400, 'Speed must be between 0.5 and 2.0.', 'TTS_INVALID_SPEED');
    }
  }

  return {
    text: parsed.text,
    voice,
    speed
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
    const result = await speakText({
      text: body.text,
      voice: body.voice,
      speed: body.speed,
      timeoutMs: config.tts.timeoutMs
    });

    res.setHeader('Content-Type', result.contentType || 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');

    const ttsEngine = safeResponseHeader(result.headers.engine);
    const ttsVoice = safeResponseHeader(result.headers.voice);
    const ttsSpeed = safeResponseHeader(result.headers.speed);

    if (ttsEngine) res.setHeader('X-TTS-Engine', ttsEngine);
    if (ttsVoice) res.setHeader('X-TTS-Voice', ttsVoice);
    if (ttsSpeed) res.setHeader('X-TTS-Speed', ttsSpeed);

    res.status(200).send(result.audio);
  })
);
