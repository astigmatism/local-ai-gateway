import express, { type NextFunction, type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nonAdminUserId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '99999999-9999-4999-8999-999999999999';
const conversationId = '22222222-2222-4222-8222-222222222222';
const otherConversationId = '33333333-3333-4333-8333-333333333333';
const createdAt = new Date('2026-05-29T12:00:00.000Z');
const updatedAt = new Date('2026-05-29T12:01:00.000Z');

const readSource = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');

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

const jsonFetch = async (port: number, path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { response, body };
};

const baseConversation = (overrides: Record<string, unknown> = {}) => ({
  id: conversationId,
  userId: nonAdminUserId,
  title: 'New conversation',
  archived: false,
  createdAt,
  updatedAt,
  messages: [],
  _count: { messages: 0 },
  ...overrides
});

interface LoadConversationAppOptions {
  prisma?: Record<string, unknown>;
}

const loadConversationApp = async ({ prisma = {} }: LoadConversationAppOptions = {}) => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-with-enough-entropy');
  vi.stubEnv('INITIAL_ADMIN_PASSWORD', 'initial-admin-password');
  vi.stubEnv('NEW_USER_DEFAULT_PASSWORD', 'new-user-password');
  vi.stubEnv('CONVERSATION_TITLE_GENERATION_ENABLED', 'false');

  const generateWithLlm = vi.fn(async () => ({
    content: 'I am the configured test model.',
    metadata: {
      provider: 'ollama',
      endpoint: '/api/generate',
      model: 'test-model',
      generatedAt: '2026-05-29T12:02:00.000Z'
    }
  }));

  async function* generateWithLlmStream() {
    yield {
      type: 'metadata',
      provider: 'ollama',
      endpoint: '/api/generate',
      model: 'test-model',
      generatedAt: '2026-05-29T12:02:00.000Z'
    };
    yield {
      type: 'delta',
      delta: 'I am the configured test model.',
      content: 'I am the configured test model.',
      generatedAt: '2026-05-29T12:02:00.000Z'
    };
    yield {
      type: 'done',
      content: 'I am the configured test model.',
      metadata: {
        provider: 'ollama',
        endpoint: '/api/generate',
        model: 'test-model',
        generatedAt: '2026-05-29T12:02:00.000Z'
      }
    };
  }

  vi.doMock('../server/src/db/prisma.js', () => ({ prisma }));
  vi.doMock('../server/src/auth/rateLimit.js', () => ({
    createRateLimiter: () => (_req: Request, _res: Response, next: NextFunction) => next()
  }));
  vi.doMock('../server/src/services/conversationTitle.js', () => ({
    conversationNeedsGeneratedTitle: vi.fn(() => false),
    generateConversationTitle: vi.fn(async () => ({
      title: 'Generated title',
      generated: true,
      fallbackUsed: false,
      model: 'test-model'
    })),
    isPlaceholderConversationTitle: vi.fn(() => false),
    makeFallbackConversationTitle: vi.fn((content: string) => content.slice(0, 60) || 'New conversation')
  }));
  vi.doMock('../server/src/services/llmClient.js', () => ({
    generateWithLlm,
    generateWithLlmStream,
    generateImageWithLlm: vi.fn()
  }));
  vi.doMock('../server/src/services/modelSettingsService.js', () => ({
    resolveDefaultLlmModel: vi.fn(async () => 'test-model')
  }));

  const [{ conversationsRouter }, { errorHandler }] = await Promise.all([
    import('../server/src/routes/conversations.js'),
    import('../server/src/middleware/errorHandler.js')
  ]);

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as Request & { auth: unknown }).auth = {
      sessionId: 'test-session',
      csrfTokenHash: 'test-csrf-hash',
      tokenExpiresAt: new Date('2026-05-29T13:00:00.000Z'),
      user: {
        id: nonAdminUserId,
        displayName: 'Normal User',
        loginName: 'normal_user',
        isAdmin: false,
        mustChangePassword: false
      }
    };
    next();
  });
  app.use('/api', conversationsRouter);
  app.use(errorHandler);

  return { app, generateWithLlm };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../server/src/db/prisma.js');
  vi.doUnmock('../server/src/auth/rateLimit.js');
  vi.doUnmock('../server/src/services/conversationTitle.js');
  vi.doUnmock('../server/src/services/llmClient.js');
  vi.doUnmock('../server/src/services/modelSettingsService.js');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('authorization route boundaries', () => {
  it('registers authenticated conversation routes before the legacy admin-only /api/users route', () => {
    const source = readSource('server/src/app.ts');
    const conversationMount = "app.use('/api', requirePasswordChangeCompleted, conversationsRouter);";
    const legacyUsersMount = "app.use('/api/users', requirePasswordChangeCompleted, requireAdmin, usersRouter);";

    expect(source.indexOf(conversationMount)).toBeGreaterThan(-1);
    expect(source.indexOf(legacyUsersMount)).toBeGreaterThan(-1);
    expect(source.indexOf(conversationMount)).toBeLessThan(source.indexOf(legacyUsersMount));
    expect(source).toContain("app.use('/api/admin/users', requirePasswordChangeCompleted, requireAdmin, adminUsersRouter);");
  });

  it('keeps global model and voice mutations admin-only', () => {
    const modelSettings = readSource('server/src/routes/settingsModels.ts');
    const voiceSettings = readSource('server/src/routes/settingsVoice.ts');

    expect(modelSettings).toMatch(/settingsModelsRouter\.post\(\s*'\/load',[\s\S]*?requireAdmin/);
    expect(modelSettings).toMatch(/settingsModelsRouter\.post\(\s*'\/pull',[\s\S]*?requireAdmin/);
    expect(modelSettings).toMatch(/settingsModelsRouter\.delete\(\s*'\/',[\s\S]*?requireAdmin/);
    expect(voiceSettings).toMatch(/settingsVoiceRouter\.post\(\s*'\/models\/stt\/load',[\s\S]*?requireAdmin/);
    expect(voiceSettings).toMatch(/settingsVoiceRouter\.patch\(\s*'\/config\/tts',[\s\S]*?requireAdmin/);
    expect(voiceSettings).toMatch(/settingsVoiceRouter\.get\(\s*'\/logs',[\s\S]*?requireAdmin/);
  });
});

describe('non-admin conversation and chat permissions', () => {
  it('allows a non-admin authenticated user with no conversations to load an empty own list', async () => {
    const findMany = vi.fn(async () => []);
    const { app } = await loadConversationApp({
      prisma: {
        conversation: { findMany }
      }
    });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response, body } = await jsonFetch(port, '/api/conversations');

      expect(response.status).toBe(200);
      expect(body).toEqual({ conversations: [] });
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: nonAdminUserId, archived: false }
        })
      );
    } finally {
      await close(server);
    }
  });

  it('creates a conversation owned by the authenticated non-admin user', async () => {
    const create = vi.fn(async ({ data }: { data: { userId: string; title: string } }) =>
      baseConversation({ id: conversationId, title: data.title })
    );
    const { app } = await loadConversationApp({
      prisma: {
        conversation: { create }
      }
    });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response, body } = await jsonFetch(port, '/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: 'Project notes', userId: otherUserId })
      });

      expect(response.status).toBe(201);
      expect(body.conversation).toMatchObject({ id: conversationId, userId: nonAdminUserId, title: 'Project notes' });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { userId: nonAdminUserId, title: 'Project notes' }
        })
      );
    } finally {
      await close(server);
    }
  });

  it('lets a non-admin user compose a response in their own conversation', async () => {
    const userMessage = {
      id: '44444444-4444-4444-8444-444444444444',
      conversationId,
      role: 'user',
      content: 'this is a test, which model are you?',
      metadata: null,
      createdAt: new Date('2026-05-29T12:02:00.000Z')
    };
    const assistantMessage = {
      id: '55555555-5555-4555-8555-555555555555',
      conversationId,
      role: 'assistant',
      content: 'I am the configured test model.',
      metadata: { model: 'test-model' },
      createdAt: new Date('2026-05-29T12:02:01.000Z')
    };
    const conversation = baseConversation({ _count: { messages: 0 } });
    const updatedConversation = baseConversation({ _count: { messages: 2 }, messages: [{ content: assistantMessage.content }] });
    const findFirst = vi.fn(async () => conversation);
    const findMany = vi.fn(async () => [userMessage]);
    const create = vi.fn().mockResolvedValueOnce(userMessage).mockResolvedValueOnce(assistantMessage);
    const update = vi.fn().mockResolvedValueOnce(conversation).mockResolvedValueOnce(updatedConversation);
    const { app, generateWithLlm } = await loadConversationApp({
      prisma: {
        conversation: { findFirst, update },
        message: { create, findMany }
      }
    });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response, body } = await jsonFetch(port, `/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: userMessage.content })
      });

      expect(response.status).toBe(201);
      expect(body.userMessage).toMatchObject({ conversationId, role: 'user', content: userMessage.content });
      expect(body.assistantMessage).toMatchObject({ conversationId, role: 'assistant', content: assistantMessage.content });
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: conversationId, userId: nonAdminUserId, archived: false }
        })
      );
      expect(generateWithLlm).toHaveBeenCalledOnce();
    } finally {
      await close(server);
    }
  });

  it('does not let a non-admin user read or delete another user\'s conversation', async () => {
    const findFirst = vi.fn(async () => null);
    const update = vi.fn();
    const { app } = await loadConversationApp({
      prisma: {
        conversation: { findFirst, update }
      }
    });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const readResult = await jsonFetch(port, `/api/conversations/${otherConversationId}`);
      const deleteResult = await jsonFetch(port, `/api/conversations/${otherConversationId}`, { method: 'DELETE' });

      expect(readResult.response.status).toBe(404);
      expect(deleteResult.response.status).toBe(404);
      expect(update).not.toHaveBeenCalled();
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: otherConversationId, userId: nonAdminUserId, archived: false }
        })
      );
    } finally {
      await close(server);
    }
  });

  it('rejects legacy user-scoped conversation requests for any user other than the authenticated user', async () => {
    const findMany = vi.fn(async () => []);
    const { app } = await loadConversationApp({
      prisma: {
        conversation: { findMany }
      }
    });
    const server = createServer(app);
    const port = await listen(server);

    try {
      const { response, body } = await jsonFetch(port, `/api/users/${otherUserId}/conversations`);

      expect(response.status).toBe(403);
      expect(body.error).toMatchObject({ code: 'CONVERSATION_FORBIDDEN' });
      expect(findMany).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});
