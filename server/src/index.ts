import { createServer } from 'node:http';
import { ensureAuthBootstrap } from './auth/bootstrap.js';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { prisma } from './db/prisma.js';
import { createApp } from './app.js';
import { telemetryService } from './services/telemetryService.js';

await ensureAuthBootstrap();

const app = createApp();
const server = createServer(app);

telemetryService.start();

server.listen(config.port, config.host, () => {
  logger.info(
    {
      host: config.host,
      port: config.port,
      nodeEnv: config.nodeEnv,
      llmBaseUrl: config.llm.baseUrl,
      llmMonitorBaseUrl: config.llm.monitorBaseUrl,
      voiceBaseUrl: config.voice.baseUrl,
      authEnabled: config.auth.enabled,
      secureSessionCookie: config.session.cookieSecure
    },
    'Local AI Gateway started'
  );
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutting down Local AI Gateway');
  telemetryService.stop();

  server.close(async (error) => {
    if (error) {
      logger.error({ err: error }, 'HTTP server close failed');
      process.exit(1);
    }

    await prisma.$disconnect();
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled rejection');
  process.exit(1);
});
