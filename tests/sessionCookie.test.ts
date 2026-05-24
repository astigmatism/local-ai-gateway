import { afterEach, describe, expect, it, vi } from 'vitest';

type MockRequest = {
  secure: boolean;
  get(name: string): string | undefined;
  socket: {
    encrypted?: boolean;
  };
};

const makeRequest = ({
  secure = false,
  forwardedProto,
  encrypted = false,
  host = 'localhost:3000'
}: {
  secure?: boolean;
  forwardedProto?: string;
  encrypted?: boolean;
  host?: string;
} = {}): MockRequest => ({
  secure,
  get(name: string) {
    const normalized = name.toLowerCase();
    if (normalized === 'x-forwarded-proto') return forwardedProto;
    if (normalized === 'host') return host;
    return undefined;
  },
  socket: { encrypted }
});

const loadSessionModule = async ({
  sessionCookieSecure = 'true',
  sameSite = 'lax'
}: {
  sessionCookieSecure?: 'true' | 'false';
  sameSite?: 'lax' | 'strict' | 'none';
} = {}) => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test');
  vi.stubEnv('INITIAL_ADMIN_PASSWORD', 'initial-admin-password');
  vi.stubEnv('NEW_USER_DEFAULT_PASSWORD', 'new-user-password');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-with-enough-entropy');
  vi.stubEnv('SESSION_COOKIE_SECURE', sessionCookieSecure);
  vi.stubEnv('SESSION_COOKIE_SAME_SITE', sameSite);
  return import('../server/src/auth/session.js');
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('session cookie security detection', () => {
  it('keeps Secure cookies on HTTPS requests', async () => {
    const { shouldUseSecureSessionCookie } = await loadSessionModule({ sessionCookieSecure: 'true' });

    expect(shouldUseSecureSessionCookie(makeRequest({ secure: true }))).toBe(true);
    expect(shouldUseSecureSessionCookie(makeRequest({ forwardedProto: 'https' }))).toBe(true);
    expect(shouldUseSecureSessionCookie(makeRequest({ encrypted: true }))).toBe(true);
  });

  it('omits Secure on plain HTTP so local first-login password changes keep their session cookie', async () => {
    const { shouldUseSecureSessionCookie } = await loadSessionModule({ sessionCookieSecure: 'true' });

    expect(shouldUseSecureSessionCookie(makeRequest())).toBe(false);
  });

  it('honors explicit insecure-cookie configuration for local HTTP deployments', async () => {
    const { shouldUseSecureSessionCookie } = await loadSessionModule({ sessionCookieSecure: 'false' });

    expect(shouldUseSecureSessionCookie(makeRequest({ secure: true }))).toBe(false);
  });

  it('falls back from SameSite=None to Lax on plain HTTP so browsers do not reject the local session cookie', async () => {
    const { sessionCookieOptionsForRequest } = await loadSessionModule({
      sessionCookieSecure: 'true',
      sameSite: 'none'
    });

    expect(sessionCookieOptionsForRequest(makeRequest())).toEqual({ secure: false, sameSite: 'lax' });
  });

  it('keeps SameSite=None when the request is HTTPS and the cookie can be Secure', async () => {
    const { sessionCookieOptionsForRequest } = await loadSessionModule({
      sessionCookieSecure: 'true',
      sameSite: 'none'
    });

    expect(sessionCookieOptionsForRequest(makeRequest({ secure: true }))).toEqual({ secure: true, sameSite: 'none' });
  });
});
