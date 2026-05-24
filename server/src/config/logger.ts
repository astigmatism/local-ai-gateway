import pino from 'pino';
import { config } from './env.js';

export const logger = pino({
  level: config.logLevel,
  base: {
    app: 'local-ai-gateway'
  },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers.x-csrf-token',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.newPassword',
      'req.body.confirmPassword',
      'req.body.prompt',
      'req.body.transcript',
      'res.headers.set-cookie',
      'password',
      'passwordHash',
      'sessionToken',
      'csrfToken',
      'prompt',
      'transcript',
      'rawTranscript',
      '*.password',
      '*.passwordHash',
      '*.sessionToken',
      '*.csrfToken',
      '*.prompt',
      '*.transcript',
      '*.rawTranscript'
    ],
    censor: '[redacted]'
  }
});
