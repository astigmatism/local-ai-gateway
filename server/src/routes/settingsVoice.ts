import multer from 'multer';
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/session.js';
import { config } from '../config/env.js';
import { ApiError } from '../errors/apiError.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  getVoiceConfig,
  getVoiceGpu,
  getVoiceHealth,
  getVoiceLogs,
  getVoiceModels,
  getVoiceOverview,
  getVoiceServices,
  getVoiceSttModels,
  getVoiceSttService,
  getVoiceSystem,
  getVoiceTtsModels,
  getVoiceTtsService,
  listVoiceDescriptors,
  loadVoiceSttModel,
  loadVoiceTtsModel,
  unloadVoiceSttModel,
  unloadVoiceTtsModel,
  updateVoiceSttConfig,
  updateVoiceTtsConfig
} from '../services/voiceClient.js';
import {
  getVoiceReferences,
  selectVoiceReference,
  sanitizeDisplayName,
  sanitizeOriginalFilename,
  uploadAndRememberReferenceAudio
} from '../services/voiceReferenceService.js';

export const settingsVoiceRouter = Router();

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).max(160).optional()
);

const requiredText = z.string().trim().min(1).max(160);
const referenceIdText = z.string().trim().min(1).max(240);
const optionsSchema = z.record(z.string(), z.unknown()).optional().default({});

const sttLoadSchema = z.object({
  provider: requiredText.default('fast-whisper'),
  model: requiredText,
  computeType: requiredText.default('int8_float16'),
  options: optionsSchema
});

const ttsLoadSchema = z.object({
  provider: requiredText.default('chatterbox'),
  model: requiredText,
  language: optionalText.default('en'),
  options: optionsSchema
});

const unloadSchema = z.object({
  strategy: z.enum(['soft', 'hard']).default('soft'),
  clearCache: z.coerce.boolean().default(true)
});

const updateSttConfigSchema = z
  .object({
    defaultModel: optionalText,
    computeType: optionalText
  })
  .refine((body) => body.defaultModel !== undefined || body.computeType !== undefined, {
    message: 'At least one STT config field is required.'
  });

const updateTtsConfigSchema = z
  .object({
    defaultModel: optionalText,
    language: optionalText
  })
  .refine((body) => body.defaultModel !== undefined || body.language !== undefined, {
    message: 'At least one TTS config field is required.'
  });

const selectReferenceSchema = z.object({
  id: referenceIdText
});

const isWavUpload = (file: Express.Multer.File) => {
  const mime = (file.mimetype || '').toLowerCase();
  const name = (file.originalname || '').toLowerCase();
  return (
    name.endsWith('.wav') ||
    mime === 'audio/wav' ||
    mime === 'audio/wave' ||
    mime === 'audio/x-wav' ||
    mime === 'audio/vnd.wave' ||
    (mime === 'application/octet-stream' && name.endsWith('.wav'))
  );
};

const referenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.audio.maxUploadBytes,
    files: 1
  },
  fileFilter: (_req, file, callback) => {
    if (!isWavUpload(file)) {
      callback(new ApiError(415, 'Reference audio must be a WAV file.', 'REFERENCE_AUDIO_WAV_REQUIRED'));
      return;
    }
    callback(null, true);
  }
});

const readReferenceFile = (files: Express.Multer.File[] | Record<string, Express.Multer.File[]> | undefined) => {
  if (Array.isArray(files)) return files[0];
  return files?.reference_audio?.[0] ?? files?.file?.[0];
};

const voiceSettingErrorMessage = (error: unknown) => {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unknown voice reference error.';
};

const getVoiceOverviewWithReferences = async () => {
  const overview = await getVoiceOverview();
  try {
    const references = await getVoiceReferences();
    return {
      ...overview,
      references,
      errors: {
        ...overview.errors
      }
    };
  } catch (error) {
    return {
      ...overview,
      references: null,
      errors: {
        ...overview.errors,
        references: voiceSettingErrorMessage(error)
      }
    };
  }
};

settingsVoiceRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await getVoiceOverviewWithReferences());
  })
);

settingsVoiceRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    res.json(await getVoiceHealth());
  })
);

settingsVoiceRouter.get(
  '/system',
  asyncHandler(async (_req, res) => {
    res.json(await getVoiceSystem());
  })
);

settingsVoiceRouter.get(
  '/gpu',
  asyncHandler(async (_req, res) => {
    res.json(await getVoiceGpu());
  })
);

settingsVoiceRouter.get(
  '/services',
  asyncHandler(async (_req, res) => {
    res.json(await getVoiceServices());
  })
);

settingsVoiceRouter.get(
  '/services/stt',
  asyncHandler(async (_req, res) => {
    res.json(await getVoiceSttService());
  })
);

settingsVoiceRouter.get(
  '/services/tts',
  asyncHandler(async (_req, res) => {
    res.json(await getVoiceTtsService());
  })
);

settingsVoiceRouter.get(
  '/models',
  asyncHandler(async (_req, res) => {
    res.json(await getVoiceModels());
  })
);

settingsVoiceRouter.get(
  '/models/stt',
  asyncHandler(async (_req, res) => {
    res.json(await getVoiceSttModels());
  })
);

settingsVoiceRouter.get(
  '/models/tts',
  asyncHandler(async (_req, res) => {
    res.json(await getVoiceTtsModels());
  })
);

settingsVoiceRouter.post(
  '/models/stt/load',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = sttLoadSchema.parse(req.body ?? {});
    const result = await loadVoiceSttModel(body);
    res.json({ result, message: `STT model ${body.model} load requested.` });
  })
);

settingsVoiceRouter.post(
  '/models/stt/unload',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = unloadSchema.parse(req.body ?? {});
    const result = await unloadVoiceSttModel(body);
    res.json({ result, message: `STT model unload requested with ${body.strategy} strategy.` });
  })
);

settingsVoiceRouter.post(
  '/models/tts/load',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = ttsLoadSchema.parse(req.body ?? {});
    const result = await loadVoiceTtsModel(body);
    res.json({ result, message: `TTS model ${body.model} load requested.` });
  })
);

settingsVoiceRouter.post(
  '/models/tts/unload',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = unloadSchema.parse(req.body ?? {});
    const result = await unloadVoiceTtsModel(body);
    res.json({ result, message: `TTS model unload requested with ${body.strategy} strategy.` });
  })
);

settingsVoiceRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    res.json(await getVoiceConfig());
  })
);

settingsVoiceRouter.patch(
  '/config/stt',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = updateSttConfigSchema.parse(req.body ?? {});
    const result = await updateVoiceSttConfig(body);
    res.json({ result, message: 'STT defaults updated.' });
  })
);

settingsVoiceRouter.patch(
  '/config/tts',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = updateTtsConfigSchema.parse(req.body ?? {});
    const result = await updateVoiceTtsConfig(body);
    res.json({ result, message: 'TTS defaults updated.' });
  })
);

settingsVoiceRouter.get(
  '/voices',
  asyncHandler(async (_req, res) => {
    res.json(await listVoiceDescriptors());
  })
);

settingsVoiceRouter.get(
  '/references',
  asyncHandler(async (_req, res) => {
    res.json(await getVoiceReferences());
  })
);

settingsVoiceRouter.post(
  '/references/select',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = selectReferenceSchema.parse(req.body ?? {});
    const references = await selectVoiceReference(body.id);
    res.json({ references, message: 'Reference selected for future TTS requests.' });
  })
);

settingsVoiceRouter.post(
  '/reference-audio',
  requireAdmin,
  referenceUpload.fields([
    { name: 'reference_audio', maxCount: 1 },
    { name: 'file', maxCount: 1 }
  ]),
  asyncHandler(async (req, res) => {
    const file = readReferenceFile(req.files as Record<string, Express.Multer.File[]> | undefined);
    if (!file) {
      throw new ApiError(400, 'Missing multipart form-data WAV field named "reference_audio".', 'REFERENCE_AUDIO_REQUIRED');
    }
    if (!isWavUpload(file)) {
      throw new ApiError(415, 'Reference audio must be a WAV file.', 'REFERENCE_AUDIO_WAV_REQUIRED');
    }

    const originalFilename = sanitizeOriginalFilename(file.originalname || 'reference.wav');
    const displayName = sanitizeDisplayName(req.body?.displayName ?? req.body?.display_name, originalFilename);
    const useAfterUpload = z.coerce.boolean().default(false).parse(req.body?.useAfterUpload ?? req.body?.use_after_upload ?? false);
    const result = await uploadAndRememberReferenceAudio(file.buffer, originalFilename, file.mimetype || 'audio/wav', {
      displayName,
      useAfterUpload
    });
    res.json(result);
  })
);

settingsVoiceRouter.get(
  '/logs',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await getVoiceLogs());
  })
);
