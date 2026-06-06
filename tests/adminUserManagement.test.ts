import express, { type RequestHandler } from 'express';
import fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../server/src/auth/session.js';

const adminUserId = '11111111-1111-4111-8111-111111111111';
const regularUserId = '22222222-2222-4222-8222-222222222222';
const otherAdminUserId = '33333333-3333-4333-8333-333333333333';
const imageFileName = '44444444-4444-4444-8444-444444444444.png';
const createdAt = new Date('2026-05-29T12:00:00.000Z');
const updatedAt = new Date('2026-05-29T12:05:00.000Z');

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  id: regularUserId,
  displayName: 'Ada Lovelace',
  loginName: 'ada_lovelace',
  passwordHash: 'hashed-password',
  isAdmin: false,
  mustChangePassword: false,
  isActive: true,
  failedLoginCount: 0,
  failedLoginWindowStartedAt: null,
  lockedUntil: null,
  lastLoginAt: null,
  passwordChangedAt: null,
  deletedAt: null,
  createdAt,
  updatedAt,
  ...overrides
});

const adminUser = makeUser({
  id: adminUserId,
  displayName: 'Eric',
  loginName: 'eric',
  isAdmin: true
});

const regularUser = makeUser();

const otherAdminUser = makeUser({
  id: otherAdminUserId,
  displayName: 'Admin Two',
  loginName: 'admin_two',
  isAdmin: true
});

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

const jsonFetch = async (port: number, pathName: string, init: RequestInit = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {})
    }
  });
  return { response, body: await response.json() };
};

const makePurgeTransaction = ({
  target = regularUser,
  remainingActiveAdminCount = 1,
  generatedImageMessages = [] as Array<{ metadata: unknown }>,
  deletedCounts = {
    messages: 2,
    audioSnippets: 1,
    conversations: 1,
    authSessions: 1
  }
} = {}) => {
  const tx = {
    user: {
      findUnique: vi.fn(async () => target),
      count: vi.fn(async () => remainingActiveAdminCount),
      delete: vi.fn(async () => target)
    },
    message: {
      findMany: vi.fn(async () => generatedImageMessages),
      deleteMany: vi.fn(async () => ({ count: deletedCounts.messages }))
    },
    audioSnippet: {
      deleteMany: vi.fn(async () => ({ count: deletedCounts.audioSnippets }))
    },
    conversation: {
      deleteMany: vi.fn(async () => ({ count: deletedCounts.conversations }))
    },
    authSession: {
      deleteMany: vi.fn(async () => ({ count: deletedCounts.authSessions }))
    }
  };

  return tx;
};

const loadAdminApp = async ({
  tx = makePurgeTransaction(),
  users = [adminUser, regularUser],
  imageStorageDir
}: {
  tx?: ReturnType<typeof makePurgeTransaction>;
  users?: Array<Record<string, unknown>>;
  imageStorageDir?: string;
} = {}) => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test');
  vi.stubEnv('INITIAL_ADMIN_PASSWORD', 'initial-admin-password');
  vi.stubEnv('NEW_USER_DEFAULT_PASSWORD', 'new-user-password');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-with-enough-entropy');
  if (imageStorageDir) vi.stubEnv('IMAGE_GENERATION_STORAGE_DIR', imageStorageDir);

  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    user: {
      findMany: vi.fn(async () => users),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      create: vi.fn()
    },
    authSession: {
      deleteMany: vi.fn(async () => ({ count: 0 }))
    }
  };

  vi.doMock('../server/src/db/prisma.js', () => ({ prisma }));

  const [{ adminUsersRouter }, { requireAdmin, requirePasswordChangeCompleted }, { ApiError }, { errorHandler }] = await Promise.all([
    import('../server/src/routes/adminUsers.js'),
    import('../server/src/auth/session.js'),
    import('../server/src/errors/apiError.js'),
    import('../server/src/middleware/errorHandler.js')
  ]);

  const attachTestAuth: RequestHandler = (req, _res, next) => {
    const authMode = req.get('x-test-auth');
    if (!authMode) {
      next(new ApiError(401, 'Authentication required.', 'AUTH_REQUIRED'));
      return;
    }

    const authenticatedRequest = req as typeof req & { auth?: AuthContext };
    authenticatedRequest.auth = {
      sessionId: 'test-session',
      csrfTokenHash: 'test-csrf-hash',
      tokenExpiresAt: new Date(Date.now() + 60_000),
      user:
        authMode === 'non-admin'
          ? {
              id: regularUserId,
              displayName: 'Ada Lovelace',
              loginName: 'ada_lovelace',
              isAdmin: false,
              mustChangePassword: false
            }
          : {
              id: adminUserId,
              displayName: 'Eric',
              loginName: 'eric',
              isAdmin: true,
              mustChangePassword: false
            }
    };
    next();
  };

  const app = express();
  app.use(express.json());
  app.use('/api/admin/users', attachTestAuth, requirePasswordChangeCompleted, requireAdmin, adminUsersRouter);
  app.use(errorHandler);

  return { app, prisma, tx };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../server/src/db/prisma.js');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('admin user management', () => {
  it('returns the configured new-user temporary password only from the admin-only user list response', async () => {
    const { app, prisma } = await loadAdminApp();
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response, body } = await jsonFetch(port, '/api/admin/users', {
        headers: { 'x-test-auth': 'admin' }
      });

      expect(response.status).toBe(200);
      expect(body.newUserTemporaryPassword).toBe('new-user-password');
      expect(body.users).toHaveLength(2);
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        orderBy: [{ isAdmin: 'desc' }, { isActive: 'desc' }, { displayName: 'asc' }]
      });
    } finally {
      await close(server);
    }
  });

  it('does not expose the temporary password to non-admin users', async () => {
    const { app } = await loadAdminApp();
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response, body } = await jsonFetch(port, '/api/admin/users', {
        headers: { 'x-test-auth': 'non-admin' }
      });

      expect(response.status).toBe(403);
      expect(body.error.code).toBe('ADMIN_REQUIRED');
    } finally {
      await close(server);
    }
  });

  it('rejects unauthenticated purge requests before user data is touched', async () => {
    const tx = makePurgeTransaction();
    const { app, prisma } = await loadAdminApp({ tx });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response, body } = await jsonFetch(port, `/api/admin/users/${regularUserId}`, { method: 'DELETE' });

      expect(response.status).toBe(401);
      expect(body.error.code).toBe('AUTH_REQUIRED');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.user.delete).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it('purges a non-admin user account, sessions, conversations, messages, and audio snippets', async () => {
    const tx = makePurgeTransaction();
    const { app } = await loadAdminApp({ tx });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response, body } = await jsonFetch(port, `/api/admin/users/${regularUserId}`, {
        method: 'DELETE',
        headers: { 'x-test-auth': 'admin' }
      });

      expect(response.status).toBe(200);
      expect(body.deletedUserId).toBe(regularUserId);
      expect(body.deleted).toMatchObject({
        authSessions: 1,
        messages: 2,
        conversations: 1,
        audioSnippets: 1,
        generatedImageFiles: {
          referenced: 0,
          deleted: 0,
          missing: 0,
          failed: 0
        }
      });
      expect(tx.message.deleteMany).toHaveBeenCalledWith({ where: { conversation: { userId: regularUserId } } });
      expect(tx.audioSnippet.deleteMany).toHaveBeenCalledWith({ where: { userId: regularUserId } });
      expect(tx.conversation.deleteMany).toHaveBeenCalledWith({ where: { userId: regularUserId } });
      expect(tx.authSession.deleteMany).toHaveBeenCalledWith({ where: { userId: regularUserId } });
      expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: regularUserId } });
    } finally {
      await close(server);
    }
  });

  it('deletes generated image files referenced by the purged user messages', async () => {
    const imageStorageDir = await fs.mkdtemp(path.join(tmpdir(), 'local-ai-gateway-images-'));
    const imagePath = path.join(imageStorageDir, imageFileName);
    await fs.writeFile(imagePath, Buffer.from('not-a-real-png-but-deletable'));

    const tx = makePurgeTransaction({
      generatedImageMessages: [
        {
          metadata: {
            type: 'image',
            image: {
              url: `/api/conversations/55555555-5555-4555-8555-555555555555/messages/${imageFileName.replace('.png', '')}/image`,
              fileName: imageFileName,
              mimeType: 'image/png'
            }
          }
        }
      ]
    });
    const { app } = await loadAdminApp({ tx, imageStorageDir });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response, body } = await jsonFetch(port, `/api/admin/users/${regularUserId}`, {
        method: 'DELETE',
        headers: { 'x-test-auth': 'admin' }
      });

      expect(response.status).toBe(200);
      expect(body.deleted.generatedImageFiles).toEqual({
        referenced: 1,
        deleted: 1,
        missing: 0,
        failed: 0
      });
      await expect(fs.access(imagePath)).rejects.toThrow();
    } finally {
      await close(server);
      await fs.rm(imageStorageDir, { recursive: true, force: true });
    }
  });

  it('prevents an administrator from purging their own account', async () => {
    const tx = makePurgeTransaction({ target: adminUser });
    const { app } = await loadAdminApp({ tx });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response, body } = await jsonFetch(port, `/api/admin/users/${adminUserId}`, {
        method: 'DELETE',
        headers: { 'x-test-auth': 'admin' }
      });

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('CANNOT_DELETE_SELF');
      expect(body.error.message).toBe('You cannot delete your own account.');
      expect(tx.message.deleteMany).not.toHaveBeenCalled();
      expect(tx.user.delete).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it('prevents deleting the last active administrator', async () => {
    const tx = makePurgeTransaction({ target: otherAdminUser, remainingActiveAdminCount: 0 });
    const { app } = await loadAdminApp({ tx });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response, body } = await jsonFetch(port, `/api/admin/users/${otherAdminUserId}`, {
        method: 'DELETE',
        headers: { 'x-test-auth': 'admin' }
      });

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('CANNOT_DELETE_LAST_ADMIN');
      expect(body.error.message).toBe('You cannot delete the last administrator.');
      expect(tx.user.count).toHaveBeenCalledWith({
        where: {
          id: { not: otherAdminUserId },
          isAdmin: true,
          isActive: true,
          deletedAt: null
        }
      });
      expect(tx.user.delete).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});
