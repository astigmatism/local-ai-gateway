import { afterEach, describe, expect, it, vi } from 'vitest';

const loadPasswordModule = async () => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test');
  vi.stubEnv('INITIAL_ADMIN_PASSWORD', 'initial-admin-password');
  vi.stubEnv('NEW_USER_DEFAULT_PASSWORD', 'new-user-password');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-with-enough-entropy');
  vi.stubEnv('AUTH_MIN_PASSWORD_LENGTH', '8');
  return import('../server/src/auth/password.js');
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('validateNewPassword', () => {
  it('allows the configured initial admin password as the chosen permanent password', async () => {
    const { validateNewPassword } = await loadPasswordModule();

    await expect(
      validateNewPassword({
        newPassword: 'initial-admin-password',
        confirmPassword: 'initial-admin-password'
      })
    ).resolves.toBeUndefined();
  });

  it('allows the configured new-user default password as the chosen permanent password', async () => {
    const { validateNewPassword } = await loadPasswordModule();

    await expect(
      validateNewPassword({
        newPassword: 'new-user-password',
        confirmPassword: 'new-user-password'
      })
    ).resolves.toBeUndefined();
  });

  it('continues to reject mismatched confirmation passwords', async () => {
    const { validateNewPassword } = await loadPasswordModule();

    await expect(
      validateNewPassword({
        newPassword: 'valid-password',
        confirmPassword: 'different-password'
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'PASSWORD_CONFIRMATION_MISMATCH' });
  });

  it('continues to enforce the configured minimum password length', async () => {
    const { validateNewPassword } = await loadPasswordModule();

    await expect(
      validateNewPassword({
        newPassword: 'short',
        confirmPassword: 'short'
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'PASSWORD_TOO_SHORT' });
  });
});
