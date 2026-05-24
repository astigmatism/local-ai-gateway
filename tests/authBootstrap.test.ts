import { afterEach, describe, expect, it, vi } from 'vitest';

const ericUser = {
  id: '00000000-0000-0000-0000-000000000001',
  displayName: 'Eric',
  loginName: 'eric',
  passwordHash: 'existing-password-hash',
  isAdmin: true,
  mustChangePassword: false,
  isActive: true,
  deletedAt: null,
  createdAt: new Date('2026-05-24T00:00:00.000Z')
};

const stubAuthEnv = () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test');
  vi.stubEnv('INITIAL_ADMIN_PASSWORD', 'initial-admin-password');
  vi.stubEnv('NEW_USER_DEFAULT_PASSWORD', 'new-user-password');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-with-enough-entropy');
};

const loadBootstrap = async ({
  ericUsers = [ericUser]
}: {
  ericUsers?: Array<Record<string, unknown>>;
} = {}) => {
  vi.resetModules();
  stubAuthEnv();

  const findMany = vi.fn().mockResolvedValueOnce(ericUsers).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  const findUnique = vi.fn(async () => null);
  const create = vi.fn(async (input: { data: Record<string, unknown> }) => ({ id: ericUser.id, ...input.data }));
  const update = vi.fn(async (input: { data: Record<string, unknown> }) => ({ ...ericUser, ...input.data }));
  const deleteMany = vi.fn(async () => ({ count: 0 }));
  const hashPassword = vi.fn(async () => 'hashed-initial-admin-password');

  vi.doMock('../server/src/db/prisma.js', () => ({
    prisma: {
      user: {
        findMany,
        findUnique,
        create,
        update
      },
      authSession: {
        deleteMany
      }
    }
  }));

  vi.doMock('../server/src/auth/password.js', () => ({
    hashPassword
  }));

  const module = await import('../server/src/auth/bootstrap.js');
  return { ...module, findMany, findUnique, create, update, deleteMany, hashPassword };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../server/src/db/prisma.js');
  vi.doUnmock('../server/src/auth/password.js');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('ensureAuthBootstrap', () => {
  it('does not overwrite Eric password state when the admin account already has a password hash', async () => {
    const { ensureAuthBootstrap, update, hashPassword } = await loadBootstrap();

    await ensureAuthBootstrap();

    expect(hashPassword).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: ericUser.id },
      data: {
        isAdmin: true,
        isActive: true,
        deletedAt: null
      }
    });

    const updateData = update.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(updateData).not.toHaveProperty('passwordHash');
    expect(updateData).not.toHaveProperty('mustChangePassword');
  });

  it('creates Eric with the initial admin password and forced password-change state when missing', async () => {
    const { ensureAuthBootstrap, create, hashPassword } = await loadBootstrap({ ericUsers: [] });

    await ensureAuthBootstrap();

    expect(hashPassword).toHaveBeenCalledWith('initial-admin-password');
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        displayName: 'Eric',
        loginName: 'eric',
        passwordHash: 'hashed-initial-admin-password',
        isAdmin: true,
        mustChangePassword: true,
        isActive: true,
        deletedAt: null
      })
    });
  });
});
