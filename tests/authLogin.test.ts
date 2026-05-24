import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Use an RFC 4122 UUID so the real login request schema accepts the test request.
const userId = '11111111-1111-4111-8111-111111111111';

const storedUser = {
  id: userId,
  displayName: 'Eric',
  loginName: 'eric',
  isAdmin: true,
  mustChangePassword: false,
  isActive: true,
  deletedAt: null,
  passwordHash: 'stored-password-hash',
  failedLoginCount: 0,
  failedLoginWindowStartedAt: null,
  lockedUntil: null
};

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

const close = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

const loadAuthApp = async () => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test');
  vi.stubEnv('INITIAL_ADMIN_PASSWORD', 'initial-admin-password');
  vi.stubEnv('NEW_USER_DEFAULT_PASSWORD', 'new-user-password');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-with-enough-entropy');

  const findUnique = vi.fn(async () => storedUser);
  const findUniqueOrThrow = vi.fn(async () => storedUser);
  const update = vi.fn(async () => storedUser);
  const verifyPassword = vi.fn(async () => true);
  const createSession = vi.fn(async () => ({ csrfToken: 'csrf-token' }));

  vi.doMock('../server/src/db/prisma.js', () => ({
    prisma: {
      user: {
        findUnique,
        findUniqueOrThrow,
        update
      }
    }
  }));

  vi.doMock('../server/src/auth/password.js', () => ({
    hashPassword: vi.fn(async () => 'unused-hash'),
    validateNewPassword: vi.fn(async () => undefined),
    verifyPassword
  }));

  vi.doMock('../server/src/auth/session.js', () => ({
    clearSessionCookie: vi.fn(),
    createSession,
    destroySession: vi.fn(),
    hashSecurityToken: vi.fn((value: string) => `hashed-${value}`),
    requireAuth: vi.fn(),
    rotateCsrfToken: vi.fn(async () => 'rotated-csrf-token')
  }));

  const [{ authRouter }, { errorHandler }] = await Promise.all([
    import('../server/src/routes/auth.js'),
    import('../server/src/middleware/errorHandler.js')
  ]);
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use(errorHandler);

  return {
    app,
    findUnique,
    findUniqueOrThrow,
    update,
    verifyPassword,
    createSession
  };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../server/src/db/prisma.js');
  vi.doUnmock('../server/src/auth/password.js');
  vi.doUnmock('../server/src/auth/session.js');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('auth login routing state', () => {
  it('uses the persisted mustChangePassword flag instead of password equality with INITIAL_ADMIN_PASSWORD', async () => {
    const { app, verifyPassword, findUniqueOrThrow, createSession } = await loadAuthApp();
    const server = createServer(app);
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, password: 'initial-admin-password' })
      });
      const body = (await response.json()) as {
        mustChangePassword: boolean;
        user: { mustChangePassword: boolean };
      };

      expect(response.status).toBe(200);
      expect(verifyPassword).toHaveBeenCalledWith('stored-password-hash', 'initial-admin-password');
      expect(findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: userId } });
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ userId }));
      expect(body.mustChangePassword).toBe(false);
      expect(body.user.mustChangePassword).toBe(false);
    } finally {
      await close(server);
    }
  });
});
