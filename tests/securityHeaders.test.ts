import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const stubAppEnv = () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway_test');
  vi.stubEnv('INITIAL_ADMIN_PASSWORD', 'initial-admin-password');
  vi.stubEnv('NEW_USER_DEFAULT_PASSWORD', 'new-user-password');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-with-enough-entropy');
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

const loadAppModule = async () => {
  vi.resetModules();
  stubAppEnv();
  return import('../server/src/app.js');
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('security headers', () => {
  it('keeps security headers while allowing same-origin microphone recording', async () => {
    const { createApp, permissionsPolicyHeaderValue } = await loadAppModule();
    const server = createServer(createApp());
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      await response.text();

      expect(response.headers.get('permissions-policy')).toBe(permissionsPolicyHeaderValue);
      expect(response.headers.get('permissions-policy')).toContain('microphone=(self)');
      expect(response.headers.get('permissions-policy')).toContain('camera=()');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    } finally {
      await close(server);
    }
  });
});
