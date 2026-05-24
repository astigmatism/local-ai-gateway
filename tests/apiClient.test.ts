import { afterEach, describe, expect, it, vi } from 'vitest';

const authRequiredResponse = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Authentication required.'
      }
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );

const authResponse = ({ mustChangePassword, csrfToken }: { mustChangePassword: boolean; csrfToken: string }) =>
  new Response(
    JSON.stringify({
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        displayName: 'Eric',
        loginName: 'eric',
        isAdmin: true,
        mustChangePassword
      },
      mustChangePassword,
      csrfToken,
      passwordPolicy: { minLength: 8 }
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );

const loadApi = async () => {
  vi.resetModules();
  return import('../client/src/lib/api.js');
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('api client authentication errors', () => {
  it('does not hide password-change failures behind the global unauthorized redirect', async () => {
    const { api, ApiClientError } = await loadApi();
    const unauthorizedHandler = vi.fn();
    const fetchMock = vi.fn(async () => authRequiredResponse());

    vi.stubGlobal('fetch', fetchMock);
    api.setUnauthorizedHandler(unauthorizedHandler);
    api.setCsrfToken('csrf-token');

    await expect(api.changePassword('old-password', 'new-password', 'new-password')).rejects.toBeInstanceOf(
      ApiClientError
    );

    expect(unauthorizedHandler).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/change-password',
      expect.objectContaining({
        credentials: 'include',
        method: 'POST'
      })
    );

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const init = firstCall?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
  });

  it('keeps the global unauthorized redirect for normal session restoration failures', async () => {
    const { api, ApiClientError } = await loadApi();
    const unauthorizedHandler = vi.fn();

    vi.stubGlobal('fetch', vi.fn(async () => authRequiredResponse()));
    api.setUnauthorizedHandler(unauthorizedHandler);

    await expect(api.me()).rejects.toBeInstanceOf(ApiClientError);
    expect(unauthorizedHandler).toHaveBeenCalledOnce();
  });

  it('does not treat a stale must-change-password success response as a completed password update', async () => {
    const { api } = await loadApi();
    const fetchMock = vi.fn(async () => authResponse({ mustChangePassword: true, csrfToken: 'next-csrf-token' }));

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    await expect(api.changePassword('old-password', 'new-password', 'new-password')).rejects.toMatchObject({
      status: 500,
      code: 'PASSWORD_CHANGE_NOT_COMPLETED'
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('verifies completed password changes against the persisted auth state before resolving', async () => {
    const { api } = await loadApi();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authResponse({ mustChangePassword: false, csrfToken: 'changed-csrf-token' }))
      .mockResolvedValueOnce(authResponse({ mustChangePassword: false, csrfToken: 'verified-csrf-token' }));

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    const response = await api.changePassword('same-password', 'same-password', 'same-password');

    expect(response.mustChangePassword).toBe(false);
    expect(response.user.mustChangePassword).toBe(false);
    expect(response.csrfToken).toBe('verified-csrf-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/auth/change-password',
      expect.objectContaining({ credentials: 'include', method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/auth/me',
      expect.objectContaining({ credentials: 'include', method: 'GET' })
    );
  });

  it('does not close the password-change flow when the follow-up auth state still requires a password change', async () => {
    const { api } = await loadApi();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authResponse({ mustChangePassword: false, csrfToken: 'changed-csrf-token' }))
      .mockResolvedValueOnce(authResponse({ mustChangePassword: true, csrfToken: 'verified-csrf-token' }));

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    await expect(api.changePassword('same-password', 'same-password', 'same-password')).rejects.toMatchObject({
      status: 500,
      code: 'PASSWORD_CHANGE_NOT_COMPLETED'
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('api client text-to-speech requests', () => {
  it('requests speech audio through the gateway with CSRF and returns the WAV blob', async () => {
    const { api } = await loadApi();
    const audioBlob = new Blob(['RIFF'], { type: 'audio/wav' });
    const fetchMock = vi.fn(async () =>
      new Response(audioBlob, {
        status: 200,
        headers: {
          'Content-Type': 'audio/wav'
        }
      })
    );

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    const result = await api.speakText('Hello from Bear Castle AI.', { voice: 'af_heart', speed: 1 });

    expect(result.type).toBe('audio/wav');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/speak',
      expect.objectContaining({
        credentials: 'include',
        method: 'POST'
      })
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-token');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'Hello from Bear Castle AI.',
      voice: 'af_heart',
      speed: 1
    });
  });

  it('surfaces JSON errors from the speech endpoint', async () => {
    const { api } = await loadApi();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'TTS_TEXT_TOO_LONG',
              message: 'Text is too long to speak.'
            }
          }),
          {
            status: 400,
            headers: {
              'Content-Type': 'application/json'
            }
          }
        )
    );

    vi.stubGlobal('fetch', fetchMock);
    api.setCsrfToken('csrf-token');

    await expect(api.speakText('too long')).rejects.toMatchObject({
      status: 400,
      code: 'TTS_TEXT_TOO_LONG',
      message: 'Text is too long to speak.'
    });
  });
});
