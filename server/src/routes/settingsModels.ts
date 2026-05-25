import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { requireAdmin } from '../auth/session.js';
import { ApiError } from '../errors/apiError.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  deleteModel,
  getModelManagementStatus,
  loadModel,
  reserveModelPull,
  runReservedModelPull,
  showModelDetails,
  type ModelPullProgressEvent
} from '../services/modelSettingsService.js';

export const settingsModelsRouter = Router();

const modelMutationRateLimiter = createRateLimiter({
  keyPrefix: 'settings-model-mutation',
  windowMs: config.rateLimits.admin.windowMs,
  max: Math.min(config.rateLimits.admin.max, 10),
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? 'unknown'
});

const modelReadRateLimiter = createRateLimiter({
  keyPrefix: 'settings-model-read',
  windowMs: config.rateLimits.admin.windowMs,
  max: Math.max(config.rateLimits.admin.max, 30),
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? 'unknown'
});

const modelNameSchema = z.string().trim().min(1).max(120);

const loadModelSchema = z
  .object({
    model: modelNameSchema,
    makeDefault: z.boolean().optional(),
    make_default: z.boolean().optional()
  })
  .transform((body) => ({
    model: body.model,
    makeDefault: body.makeDefault ?? body.make_default ?? false
  }));

const modelSchema = z.object({
  model: modelNameSchema
});

const writePullEvent = (write: (event: ModelPullProgressEvent) => void, event: ModelPullProgressEvent) => {
  write(event);
};

const pullErrorEvent = (model: string, error: unknown): ModelPullProgressEvent => {
  const message =
    error instanceof ApiError && error.expose
      ? error.message
      : error instanceof Error
        ? error.message
        : 'Model pull failed.';

  return {
    type: 'error',
    model,
    status: message,
    error: message,
    generatedAt: new Date().toISOString()
  };
};

settingsModelsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const status = await getModelManagementStatus({ forceRefresh: true });
    res.json(status);
  })
);

settingsModelsRouter.post(
  '/details',
  modelReadRateLimiter,
  asyncHandler(async (req, res) => {
    const body = modelSchema.parse(req.body ?? {});
    const details = await showModelDetails(body.model);
    res.json(details);
  })
);

settingsModelsRouter.post(
  '/load',
  requireAdmin,
  modelMutationRateLimiter,
  asyncHandler(async (req, res) => {
    const body = loadModelSchema.parse(req.body ?? {});
    const status = await loadModel({ model: body.model, makeDefault: body.makeDefault });

    res.json({
      ...status,
      message: body.makeDefault ? 'Model loaded and set as default.' : 'Model loaded successfully.'
    });
  })
);

settingsModelsRouter.post(
  '/pull',
  requireAdmin,
  modelMutationRateLimiter,
  asyncHandler(async (req, res) => {
    const body = modelSchema.parse(req.body ?? {});
    const reservation = reserveModelPull(body.model);

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const write = (event: ModelPullProgressEvent) => {
      res.write(`${JSON.stringify(event)}\n`);
    };

    try {
      await runReservedModelPull(reservation, (event) => writePullEvent(write, event));
    } catch (error) {
      write(pullErrorEvent(reservation.model, error));
    } finally {
      res.end();
    }
  })
);

settingsModelsRouter.delete(
  '/',
  requireAdmin,
  modelMutationRateLimiter,
  asyncHandler(async (req, res) => {
    const body = modelSchema.parse(req.body ?? {});
    const status = await deleteModel(body.model);

    res.json({
      ...status,
      message: `Deleted local model ${body.model}.`
    });
  })
);
