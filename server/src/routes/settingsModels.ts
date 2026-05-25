import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { requireAdmin } from '../auth/session.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { getModelManagementStatus, loadModel } from '../services/modelSettingsService.js';

export const settingsModelsRouter = Router();

const modelLoadRateLimiter = createRateLimiter({
  keyPrefix: 'settings-model-load',
  windowMs: config.rateLimits.admin.windowMs,
  max: Math.min(config.rateLimits.admin.max, 10),
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? 'unknown'
});

const loadModelSchema = z
  .object({
    model: z.string().trim().min(1).max(120),
    makeDefault: z.boolean().optional(),
    make_default: z.boolean().optional()
  })
  .transform((body) => ({
    model: body.model,
    makeDefault: body.makeDefault ?? body.make_default ?? false
  }));

settingsModelsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const status = await getModelManagementStatus({ forceRefresh: true });
    res.json(status);
  })
);

settingsModelsRouter.post(
  '/load',
  requireAdmin,
  modelLoadRateLimiter,
  asyncHandler(async (req, res) => {
    const body = loadModelSchema.parse(req.body ?? {});
    const status = await loadModel({ model: body.model, makeDefault: body.makeDefault });

    res.json({
      ...status,
      message: body.makeDefault ? 'Model loaded and set as default.' : 'Model loaded successfully.'
    });
  })
);
