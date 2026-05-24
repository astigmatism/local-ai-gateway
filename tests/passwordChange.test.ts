import { afterEach, describe, expect, it, vi } from 'vitest';

const activeUser = {
  id: '00000000-0000-0000-0000-000000000001',
  displayName: 'Eric',
  isActive: true,
  deletedAt: null,
  passwordHash: 'hashed-current',
  mustChangePassword: true
};

const changedUser = {
  ...activeUser,
  passwordHash: 'hashed-new',
  mustChangePassword: false,
  passwordChangedAt: new Date('2026-05-24T00:00:00.000Z'),
  failedLoginCount: 0,
  failedLoginWindowStartedAt: null,
  lockedUntil: null
};

interface LoadPasswordChangeOptions {
  initialUser?: Record<string, unknown> | null;
  persistedUser?: Record<string, unknown> | null;
  currentPasswordMatches?: boolean;
  newPasswordMatchesPersistedHash?: boolean;
  generatedPasswordHash?: string;
  currentPlaintext?: string;
  newPlaintext?: string;
}

const loadPasswordChange = async ({
  initialUser = activeUser,
  persistedUser = changedUser,
  currentPasswordMatches = true,
  newPasswordMatchesPersistedHash = true,
  generatedPasswordHash = 'hashed-new',
  currentPlaintext = 'current-password',
  newPlaintext = 'new-password'
}: LoadPasswordChangeOptions = {}) => {
  vi.resetModules();

  const findUnique = vi.fn().mockResolvedValueOnce(initialUser).mockResolvedValueOnce(persistedUser);
  const update = vi.fn().mockResolvedValue({ ...changedUser, ...(persistedUser ?? {}) });
  const hashPassword = vi.fn(async () => generatedPasswordHash);
  const validateNewPassword = vi.fn(async () => undefined);
  const verifyPassword = vi.fn(async (hash: string | null | undefined, password: string) => {
    if (hash === 'hashed-current' && password === currentPlaintext) return currentPasswordMatches;
    if (hash === generatedPasswordHash && password === newPlaintext) return newPasswordMatchesPersistedHash;
    return false;
  });

  vi.doMock('../server/src/db/prisma.js', () => ({
    prisma: {
      user: {
        findUnique,
        update
      }
    }
  }));

  vi.doMock('../server/src/auth/password.js', () => ({
    hashPassword,
    validateNewPassword,
    verifyPassword
  }));

  const module = await import('../server/src/auth/passwordChange.js');
  return { ...module, findUnique, update, hashPassword, validateNewPassword, verifyPassword };
};

afterEach(() => {
  vi.doUnmock('../server/src/db/prisma.js');
  vi.doUnmock('../server/src/auth/password.js');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('changeOwnPassword', () => {
  it('updates and verifies the persisted password state before returning success', async () => {
    const { changeOwnPassword, update, hashPassword, validateNewPassword, verifyPassword } = await loadPasswordChange();

    await expect(
      changeOwnPassword({
        userId: activeUser.id,
        currentPassword: 'current-password',
        newPassword: 'new-password',
        confirmPassword: 'new-password'
      })
    ).resolves.toMatchObject({ id: activeUser.id, passwordHash: 'hashed-new', mustChangePassword: false });

    expect(validateNewPassword).toHaveBeenCalledWith({
      newPassword: 'new-password',
      confirmPassword: 'new-password'
    });
    expect(hashPassword).toHaveBeenCalledWith('new-password');
    expect(update).toHaveBeenCalledWith({
      where: { id: activeUser.id },
      data: expect.objectContaining({
        passwordHash: 'hashed-new',
        mustChangePassword: false,
        failedLoginCount: 0,
        failedLoginWindowStartedAt: null,
        lockedUntil: null
      })
    });
    expect(verifyPassword).toHaveBeenCalledWith('hashed-current', 'current-password');
    expect(verifyPassword).toHaveBeenCalledWith('hashed-new', 'new-password');
  });

  it('allows first-login setup to complete when the new password is the same as the current password', async () => {
    const samePassword = 'initial-admin-password';
    const { changeOwnPassword, update, hashPassword, verifyPassword } = await loadPasswordChange({
      persistedUser: { ...changedUser, passwordHash: 'hashed-same-password' },
      generatedPasswordHash: 'hashed-same-password',
      currentPlaintext: samePassword,
      newPlaintext: samePassword
    });

    await expect(
      changeOwnPassword({
        userId: activeUser.id,
        currentPassword: samePassword,
        newPassword: samePassword,
        confirmPassword: samePassword
      })
    ).resolves.toMatchObject({ id: activeUser.id, passwordHash: 'hashed-same-password', mustChangePassword: false });

    expect(hashPassword).toHaveBeenCalledWith(samePassword);
    expect(update).toHaveBeenCalledWith({
      where: { id: activeUser.id },
      data: expect.objectContaining({
        passwordHash: 'hashed-same-password',
        mustChangePassword: false
      })
    });
    expect(verifyPassword).toHaveBeenCalledWith('hashed-current', samePassword);
    expect(verifyPassword).toHaveBeenCalledWith('hashed-same-password', samePassword);
  });

  it('rejects a wrong current password without updating the database', async () => {
    const { changeOwnPassword, update } = await loadPasswordChange({ currentPasswordMatches: false });

    await expect(
      changeOwnPassword({
        userId: activeUser.id,
        currentPassword: 'current-password',
        newPassword: 'new-password',
        confirmPassword: 'new-password'
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'CURRENT_PASSWORD_INCORRECT' });

    expect(update).not.toHaveBeenCalled();
  });

  it('does not return success when the database readback still requires a password change', async () => {
    const { changeOwnPassword } = await loadPasswordChange({ persistedUser: { ...changedUser, mustChangePassword: true } });

    await expect(
      changeOwnPassword({
        userId: activeUser.id,
        currentPassword: 'current-password',
        newPassword: 'new-password',
        confirmPassword: 'new-password'
      })
    ).rejects.toMatchObject({ statusCode: 500, code: 'PASSWORD_UPDATE_NOT_VERIFIED' });
  });

  it('does not return success when the persisted hash is not the generated password hash', async () => {
    const { changeOwnPassword } = await loadPasswordChange({
      persistedUser: { ...changedUser, passwordHash: 'hashed-stale-password' }
    });

    await expect(
      changeOwnPassword({
        userId: activeUser.id,
        currentPassword: 'current-password',
        newPassword: 'new-password',
        confirmPassword: 'new-password'
      })
    ).rejects.toMatchObject({ statusCode: 500, code: 'PASSWORD_UPDATE_NOT_VERIFIED' });
  });

  it('does not return success when the persisted hash does not verify the new password', async () => {
    const { changeOwnPassword } = await loadPasswordChange({ newPasswordMatchesPersistedHash: false });

    await expect(
      changeOwnPassword({
        userId: activeUser.id,
        currentPassword: 'current-password',
        newPassword: 'new-password',
        confirmPassword: 'new-password'
      })
    ).rejects.toMatchObject({ statusCode: 500, code: 'PASSWORD_UPDATE_NOT_VERIFIED' });
  });
});
