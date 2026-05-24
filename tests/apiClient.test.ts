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
});
