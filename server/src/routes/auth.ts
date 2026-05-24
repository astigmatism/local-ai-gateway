import type { User } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../errors/apiError.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { csrfProtection } from '../auth/csrf.js';
import { toAuthenticatedUser, toSafeLoginUser } from '../auth/identity.js';
import { hashPassword, validateNewPassword, verifyPassword } from '../auth/password.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  requireAuth,
  rotateCsrfToken
} from '../auth/session.js';

export const authRouter = Router();

const loginRateLimiter = createRateLimiter({
  keyPrefix: 'auth-login',
  windowMs: config.auth.loginRateLimitWindowMs,
  max: config.auth.loginRateLimitMax
});

const passwordChangeRateLimiter = createRateLimiter({
  keyPrefix: 'auth-change-password',
  windowMs: config.auth.loginRateLimitWindowMs,
  max: config.auth.loginRateLimitMax,
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? 'unknown'
});

const loginSchema = z.object({
  userId: z.string().uuid(),
  password: z.string().min(1).max(1000)
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1000),
  newPassword: z.string().min(1).max(1000),
  confirmPassword: z.string().min(1).max(1000)
});

const lockoutWindowMs = () => config.auth.lockoutWindowMinutes * 60 * 1000;
const lockoutDurationMs = () => config.auth.lockoutDurationMinutes * 60 * 1000;

const genericInvalidLogin = () => new ApiError(401, 'Invalid username or password.', 'INVALID_CREDENTIALS');
const genericLockout = () => new ApiError(429, 'Too many failed attempts. Try again later.', 'ACCOUNT_LOCKED');
const passwordPolicy = () => ({ minLength: config.auth.minPasswordLength });

const isAccountLocked = (user: Pick<User, 'lockedUntil'>) => Boolean(user.lockedUntil && user.lockedUntil > new Date());

const recordFailedLogin = async (user: User) => {
  const now = new Date();
  const windowStartedAt = user.failedLoginWindowStartedAt;
  const inCurrentWindow = Boolean(windowStartedAt && now.getTime() - windowStartedAt.getTime() <= lockoutWindowMs());
  const failedLoginCount = inCurrentWindow ? user.failedLoginCount + 1 : 1;
  const lockedUntil =
    failedLoginCount >= config.auth.maxFailedLoginAttempts ? new Date(now.getTime() + lockoutDurationMs()) : null;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount,
      failedLoginWindowStartedAt: inCurrentWindow ? windowStartedAt : now,
      lockedUntil
    }
  });

  logger.warn(
    {
      userId: user.id,
      displayName: user.displayName,
      locked: Boolean(lockedUntil)
    },
    lockedUntil ? 'Account locked after failed login attempts' : 'Failed login attempt'
  );
};

const recordSuccessfulLogin = async (user: User) => {
  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      failedLoginWindowStartedAt: null,
      lockedUntil: null,
      lastLoginAt: new Date()
    }
  });

  logger.info({ userId: user.id, displayName: user.displayName }, 'User logged in');
};

authRouter.get(
  '/login-users',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        passwordHash: { not: null }
      },
      orderBy: [{ isAdmin: 'desc' }, { displayName: 'asc' }],
      select: {
        id: true,
        displayName: true
      }
    });

    res.json({ users: users.map(toSafeLoginUser) });
  })
);

authRouter.post(
  '/login',
  loginRateLimiter,
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body ?? {});
    const user = await prisma.user.findUnique({ where: { id: body.userId } });

    if (!user || !user.isActive || user.deletedAt || !user.passwordHash) {
      logger.warn({ userId: body.userId }, 'Login rejected for missing or inactive user');
      throw genericInvalidLogin();
    }

    if (isAccountLocked(user)) {
      logger.warn({ userId: user.id, displayName: user.displayName }, 'Login rejected for locked account');
      throw genericLockout();
    }

    const passwordMatches = await verifyPassword(user.passwordHash, body.password);
    if (!passwordMatches) {
      await recordFailedLogin(user);
      const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
      if (updatedUser && isAccountLocked(updatedUser)) throw genericLockout();
      throw genericInvalidLogin();
    }

    await recordSuccessfulLogin(user);
    const refreshedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const { csrfToken } = await createSession({ req, res, userId: user.id });

    res.json({
      user: toAuthenticatedUser(refreshedUser),
      mustChangePassword: refreshedUser.mustChangePassword,
      csrfToken,
      passwordPolicy: passwordPolicy()
    });
  })
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.user.id } });
    const csrfToken = await rotateCsrfToken(req.auth!.sessionId);

    res.json({
      user: toAuthenticatedUser(user),
      mustChangePassword: user.mustChangePassword,
      csrfToken,
      passwordPolicy: passwordPolicy()
    });
  })
);

authRouter.post(
  '/logout',
  requireAuth,
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (req.auth) {
      await destroySession(req.auth.sessionId);
      logger.info({ userId: req.auth.user.id, displayName: req.auth.user.displayName }, 'User logged out');
    }
    clearSessionCookie(req, res);
    res.json({ ok: true });
  })
);

authRouter.post(
  '/change-password',
  requireAuth,
  csrfProtection,
  passwordChangeRateLimiter,
  asyncHandler(async (req, res) => {
    const body = changePasswordSchema.parse(req.body ?? {});
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.user.id } });

    if (!user.passwordHash) {
      throw new ApiError(400, 'Current password cannot be verified.', 'PASSWORD_NOT_SET');
    }

    const currentPasswordMatches = await verifyPassword(user.passwordHash, body.currentPassword);
    if (!currentPasswordMatches) {
      throw new ApiError(400, 'Current password is incorrect.', 'CURRENT_PASSWORD_INCORRECT');
    }

    await validateNewPassword({
      currentPasswordHash: user.passwordHash,
      newPassword: body.newPassword,
      confirmPassword: body.confirmPassword
    });

    const passwordHash = await hashPassword(body.newPassword);
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        failedLoginWindowStartedAt: null,
        lockedUntil: null
      }
    });

    const csrfToken = await rotateCsrfToken(req.auth!.sessionId);
    logger.info({ userId: user.id, displayName: user.displayName }, 'User changed password');

    res.json({
      user: toAuthenticatedUser(updatedUser),
      mustChangePassword: updatedUser.mustChangePassword,
      csrfToken,
      passwordPolicy: passwordPolicy()
    });
  })
);
