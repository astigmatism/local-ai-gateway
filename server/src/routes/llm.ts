import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { generateWithLlm } from '../services/llmClient.js';

export const llmRouter = Router();

const generateRateLimiter = createRateLimiter({
  keyPrefix: 'llm-generate',
  windowMs: config.rateLimits.chat.windowMs,
  max: config.rateLimits.chat.max,
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? 'unknown'
});

const generateSchema = z.object({
  prompt: z.string().trim().min(1).max(50000)
});

llmRouter.post(
  '/generate',
  generateRateLimiter,
  asyncHandler(async (req, res) => {
    const body = generateSchema.parse(req.body);
    const result = await generateWithLlm(body.prompt);
    res.json(result);
  })
);
