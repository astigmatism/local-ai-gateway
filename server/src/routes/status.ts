import { Router } from 'express';
import { telemetryService } from '../services/telemetryService.js';

export const statusRouter = Router();

statusRouter.get('/', (_req, res) => {
  res.json({
    status: telemetryService.getStatus(),
    generated_at: new Date().toISOString()
  });
});
