import compression from 'compression';
import cors from 'cors';
import express from 'express';
import type { RequestHandler } from 'express';
import fs from 'node:fs';
import helmet from 'helmet';
import pinoHttpModule from 'pino-http';

const pinoHttp = pinoHttpModule.default || pinoHttpModule;
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { adminUsersRouter } from './routes/adminUsers.js';
import { authRouter } from './routes/auth.js';
import { conversationsRouter } from './routes/conversations.js';
import { llmRouter } from './routes/llm.js';
import { statusRouter } from './routes/status.js';
import { transcribeRouter } from './routes/transcribe.js';
import { usersRouter } from './routes/users.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { csrfProtection } from './auth/csrf.js';
import { requireAdmin, requireAuth, requirePasswordChangeCompleted } from './auth/session.js';

export const permissionsPolicyHeaderValue = 'microphone=(self), camera=(), geolocation=()';

export const helmetConfig = () => ({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'https:', 'data:'],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' as const }
});

const applyPermissionsPolicyHeader: RequestHandler = (_req, res, next) => {
  res.setHeader('Permissions-Policy', permissionsPolicyHeaderValue);
  next();
};

const redirectHttpToHttps: RequestHandler = (req, res, next) => {
  if (!config.httpsRedirect.enabled) {
    next();
    return;
  }

  if (req.secure) {
    next();
    return;
  }

  const host = req.hostname.toLowerCase();
  const allowedHosts = config.httpsRedirect.allowedHosts.map((allowedHost) => allowedHost.toLowerCase());

  if (allowedHosts.length > 0 && !allowedHosts.includes(host)) {
    next();
    return;
  }

  res.redirect(config.httpsRedirect.statusCode, `https://${req.get('host') ?? host}${req.originalUrl}`);
};

const corsOptions = () => ({
  credentials: true,
  origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
    if (!origin) {
      callback(null, true);
      return;
    }

    if (!config.isProduction || config.cors.allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('CORS origin not allowed'));
  }
});

export const createApp = () => {
  const app = express();

  app.disable('x-powered-by');
  if (config.auth.trustProxy) app.set('trust proxy', 1);
  app.use(redirectHttpToHttps);

  if (config.securityHeaders.enabled) {
    app.use(helmet(helmetConfig()));
    app.use(applyPermissionsPolicyHeader);
  }
  app.use(compression());

  if (!config.isProduction || config.cors.allowedOrigins.length > 0) {
    app.use(cors(corsOptions()));
  }

  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url === '/health'
      }
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'local-ai-gateway',
      appName: config.appName,
      version: process.env.npm_package_version ?? '0.1.0',
      node: process.version,
      uptime_seconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString()
    });
  });

  app.use('/api/auth', authRouter);

  app.use('/api', requireAuth, csrfProtection);
  app.use('/api/admin/users', requirePasswordChangeCompleted, requireAdmin, adminUsersRouter);
  app.use('/api/users', requirePasswordChangeCompleted, requireAdmin, usersRouter);
  app.use('/api', requirePasswordChangeCompleted, conversationsRouter);
  app.use('/api/status', requirePasswordChangeCompleted, statusRouter);
  app.use('/api/transcribe', requirePasswordChangeCompleted, transcribeRouter);
  app.use('/api/llm', requirePasswordChangeCompleted, llmRouter);

  if (config.isProduction && fs.existsSync(config.clientDistPath)) {
    app.use(express.static(config.clientDistPath, { index: false }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path === '/health') {
        next();
        return;
      }
      res.sendFile(`${config.clientDistPath}/index.html`);
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
