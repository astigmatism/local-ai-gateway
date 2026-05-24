import crypto from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import type { NextFunction, Request, Response } from 'express';
import type { AuthSession, User } from '@prisma/client';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../errors/apiError.js';
import { isEricAdmin, toAuthenticatedUser } from './identity.js';

export interface AuthContext {
  sessionId: string;
  csrfTokenHash: string;
  tokenExpiresAt: Date;
  user: {
    id: string;
    displayName: string;
    loginName: string;
    isAdmin: boolean;
    mustChangePassword: boolean;
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

const sha256Base64Url = (value: string) => crypto.createHmac('sha256', config.session.secret).update(value).digest('base64url');
const createOpaqueToken = () => crypto.randomBytes(32).toString('base64url');
const sessionTtlMs = () => config.session.ttlHours * 60 * 60 * 1000;
const sessionExpiresAt = () => new Date(Date.now() + sessionTtlMs());
let warnedAboutInsecureSessionCookie = false;

const serializeCookie = (
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'lax' | 'strict' | 'none';
    path?: string;
    maxAgeSeconds?: number;
    expires?: Date;
  }
) => {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];

  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAgeSeconds)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite.charAt(0).toUpperCase()}${options.sameSite.slice(1)}`);

  return parts.join('; ');
};

const readCookies = (req: Request) => {
  const header = req.headers.cookie;
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const cookie of header.split(';')) {
    const [rawName, ...rawValueParts] = cookie.trim().split('=');
    if (!rawName) continue;
    const rawValue = rawValueParts.join('=');
    try {
      cookies.set(decodeURIComponent(rawName), decodeURIComponent(rawValue));
    } catch {
      cookies.set(rawName, rawValue);
    }
  }

  return cookies;
};

interface SessionCookieRequest {
  secure: boolean;
  get(name: string): string | undefined;
  socket: Partial<TLSSocket>;
}

const firstForwardedValue = (value: string | undefined) => value?.split(',')[0]?.trim().toLowerCase();

export const isRequestSecure = (req: SessionCookieRequest) => {
  if (req.secure) return true;
  if (firstForwardedValue(req.get('x-forwarded-proto')) === 'https') return true;
  return Boolean(req.socket.encrypted);
};

export const shouldUseSecureSessionCookie = (req: SessionCookieRequest) => {
  if (!config.session.cookieSecure) return false;
  const requestIsSecure = isRequestSecure(req);

  if (!requestIsSecure && !warnedAboutInsecureSessionCookie) {
    warnedAboutInsecureSessionCookie = true;
    logger.warn(
      {
        host: req.get('host'),
        forwardedProto: req.get('x-forwarded-proto')
      },
      'SESSION_COOKIE_SECURE is enabled, but the current request is not HTTPS; omitting Secure on the session cookie so the browser can store it for this local HTTP request. Use HTTPS for production access.'
    );
  }

  return requestIsSecure;
};

const setSessionCookie = (req: Request, res: Response, token: string, expiresAt: Date) => {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(config.session.cookieName, token, {
      httpOnly: true,
      secure: shouldUseSecureSessionCookie(req),
      sameSite: config.session.sameSite,
      path: '/',
      maxAgeSeconds: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
      expires: expiresAt
    })
  );
};

export const clearSessionCookie = (req: Request, res: Response) => {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(config.session.cookieName, '', {
      httpOnly: true,
      secure: shouldUseSecureSessionCookie(req),
      sameSite: config.session.sameSite,
      path: '/',
      maxAgeSeconds: 0,
      expires: new Date(0)
    })
  );
};

export const hashSecurityToken = sha256Base64Url;

export const createSession = async ({ req, res, userId }: { req: Request; res: Response; userId: string }) => {
  const token = createOpaqueToken();
  const csrfToken = createOpaqueToken();
  const expiresAt = sessionExpiresAt();

  const session = await prisma.authSession.create({
    data: {
      userId,
      tokenHash: sha256Base64Url(token),
      csrfTokenHash: sha256Base64Url(csrfToken),
      expiresAt,
      userAgent: req.get('user-agent')?.slice(0, 500),
      ipAddress: req.ip || req.socket.remoteAddress || null
    }
  });

  setSessionCookie(req, res, token, expiresAt);

  return { session, csrfToken };
};

export const rotateCsrfToken = async (sessionId: string) => {
  const csrfToken = createOpaqueToken();
  await prisma.authSession.update({
    where: { id: sessionId },
    data: { csrfTokenHash: sha256Base64Url(csrfToken) }
  });
  return csrfToken;
};

export const destroySession = async (sessionId: string) => {
  await prisma.authSession.deleteMany({ where: { id: sessionId } });
};

export const destroySessionsForUser = async (userId: string) => {
  await prisma.authSession.deleteMany({ where: { userId } });
};

const presentAuthContext = (session: AuthSession & { user: User }): AuthContext => ({
  sessionId: session.id,
  csrfTokenHash: session.csrfTokenHash,
  tokenExpiresAt: session.expiresAt,
  user: toAuthenticatedUser(session.user)
});

const findValidSession = async (req: Request, res: Response) => {
  const token = readCookies(req).get(config.session.cookieName);
  if (!token) return null;

  const tokenHash = sha256Base64Url(token);
  const session = await prisma.authSession.findUnique({
    where: { tokenHash },
    include: { user: true }
  });

  if (!session) return null;

  const now = new Date();
  if (session.expiresAt <= now) {
    await prisma.authSession.deleteMany({ where: { id: session.id } });
    return null;
  }

  if (!session.user.isActive || session.user.deletedAt || !session.user.passwordHash) {
    await prisma.authSession.deleteMany({ where: { id: session.id } });
    return null;
  }

  const renewedExpiresAt = sessionExpiresAt();
  const renewedSession = await prisma.authSession.update({
    where: { id: session.id },
    data: {
      lastSeenAt: now,
      expiresAt: renewedExpiresAt
    },
    include: { user: true }
  });

  setSessionCookie(req, res, token, renewedExpiresAt);

  return renewedSession;
};

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    const session = await findValidSession(req, res);
    if (!session) {
      clearSessionCookie(req, res);
      throw new ApiError(401, 'Authentication required.', 'AUTH_REQUIRED');
    }

    req.auth = presentAuthContext(session);
    next();
  })().catch(next);
};

export const requirePasswordChangeCompleted = (req: Request, _res: Response, next: NextFunction) => {
  if (req.auth?.user.mustChangePassword) {
    next(new ApiError(403, 'You must change your password before continuing.', 'PASSWORD_CHANGE_REQUIRED'));
    return;
  }

  next();
};

export const requireAdmin = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth || !isEricAdmin(req.auth.user)) {
    logger.warn(
      {
        userId: req.auth?.user.id,
        path: req.originalUrl,
        method: req.method
      },
      'Admin-only route rejected'
    );
    next(new ApiError(403, 'Administrator permission required.', 'ADMIN_REQUIRED'));
    return;
  }

  next();
};
