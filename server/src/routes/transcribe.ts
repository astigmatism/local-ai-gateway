import { Prisma } from '@prisma/client';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../errors/apiError.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { transcribeAudio } from '../services/voiceClient.js';

export const transcribeRouter = Router();

const transcribeRateLimiter = createRateLimiter({
  keyPrefix: 'transcribe',
  windowMs: config.rateLimits.transcribe.windowMs,
  max: config.rateLimits.transcribe.max,
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? 'unknown'
});

const tempUploadDir = config.audio.storeUploads
  ? config.audio.uploadDir
  : path.join(os.tmpdir(), 'local-ai-gateway-uploads');

await fs.mkdir(tempUploadDir, { recursive: true });

const safeFilename = (filename: string) =>
  filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120) || 'recording.webm';

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, tempUploadDir);
  },
  filename: (_req, file, callback) => {
    callback(null, `${Date.now()}-${crypto.randomUUID()}-${safeFilename(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: config.audio.maxUploadBytes,
    files: 1
  },
  fileFilter: (_req, file, callback) => {
    const mime = file.mimetype || '';
    const allowed =
      mime.startsWith('audio/') ||
      mime === 'video/webm' ||
      mime === 'video/mp4' ||
      mime === 'application/octet-stream' ||
      mime === 'application/x-mpegURL';

    if (!allowed) {
      callback(new ApiError(415, `Unsupported audio MIME type: ${mime || 'unknown'}`, 'UNSUPPORTED_AUDIO_TYPE'));
      return;
    }

    callback(null, true);
  }
});

const getUploadedAudioFile = (files: Express.Multer.File[] | { [fieldname: string]: Express.Multer.File[] } | undefined) => {
  if (!files) return undefined;
  if (Array.isArray(files)) return files[0];
  return files.file?.[0] ?? files.audio?.[0];
};

const booleanField = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const optionalText = z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), z.string().trim().max(120).optional());

const transcribeBodySchema = z.object({
  userId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  model: optionalText,
  language: optionalText,
  vad_filter: booleanField.optional(),
  vadFilter: booleanField.optional(),
  min_silence_duration_ms: z.coerce.number().int().positive().max(60000).optional(),
  minSilenceDurationMs: z.coerce.number().int().positive().max(60000).optional(),
  beam_size: z.coerce.number().int().positive().max(64).optional(),
  beamSize: z.coerce.number().int().positive().max(64).optional(),
  word_timestamps: booleanField.optional(),
  wordTimestamps: booleanField.optional()
});

transcribeRouter.post(
  '/',
  transcribeRateLimiter,
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'audio', maxCount: 1 }
  ]),
  asyncHandler(async (req, res) => {
    const file = getUploadedAudioFile(req.files);

    if (!file) {
      throw new ApiError(400, 'Missing multipart form-data audio file field. Use field name "file".', 'MISSING_AUDIO_FILE');
    }

    const authenticatedUserId = req.auth?.user.id;
    if (!authenticatedUserId) {
      throw new ApiError(401, 'Authentication required.', 'AUTH_REQUIRED');
    }

    const body = transcribeBodySchema.parse(req.body ?? {});

    try {
      if (body.userId && body.userId !== authenticatedUserId) {
        throw new ApiError(403, 'You can only transcribe audio for your own account.', 'TRANSCRIBE_FORBIDDEN');
      }

      if (body.conversationId) {
        const conversation = await prisma.conversation.findFirst({
          where: {
            id: body.conversationId,
            userId: authenticatedUserId,
            archived: false
          }
        });
        if (!conversation) {
          throw new ApiError(404, 'Conversation not found.', 'CONVERSATION_NOT_FOUND');
        }
      }

      const result = await transcribeAudio(file.path, file.originalname, file.mimetype, {
        model: body.model,
        language: body.language,
        vadFilter: body.vadFilter ?? body.vad_filter,
        minSilenceDurationMs: body.minSilenceDurationMs ?? body.min_silence_duration_ms,
        beamSize: body.beamSize ?? body.beam_size,
        wordTimestamps: body.wordTimestamps ?? body.word_timestamps
      });

      const audioSnippet = await prisma.audioSnippet.create({
        data: {
          userId: authenticatedUserId,
          conversationId: body.conversationId,
          originalFilename: file.originalname,
          mimeType: file.mimetype,
          transcript: result.transcript,
          sttMetadata: result.metadata as Prisma.InputJsonValue
        }
      });

      res.json({
        filename: result.filename ?? file.originalname,
        model: result.model,
        defaultModel: result.defaultModel,
        activeModel: result.activeModel,
        language: result.language,
        languageProbability: result.languageProbability,
        vadFilter: result.vadFilter,
        minSilenceDurationMs: result.minSilenceDurationMs,
        beamSize: result.beamSize,
        wordTimestamps: result.wordTimestamps,
        transcript: result.transcript,
        segments: result.segments,
        metadata: result.metadata,
        audioSnippet
      });
    } finally {
      if (!config.audio.storeUploads) {
        await fs.unlink(file.path).catch(() => undefined);
      }
    }
  })
);
