import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../errors/apiError.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { ADMIN_DISPLAY_NAME, isEricDisplayName, makeUniqueLoginName, toAdminUserSummary } from '../auth/identity.js';
import { hashPassword } from '../auth/password.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { destroySessionsForUser } from '../auth/session.js';
import { purgeUser } from '../services/userPurge.js';

export const adminUsersRouter = Router();

const adminRateLimiter = createRateLimiter({
  keyPrefix: 'admin-users',
  windowMs: config.rateLimits.admin.windowMs,
  max: config.rateLimits.admin.max,
  keyGenerator: (req) => req.auth?.user.id ?? req.ip ?? 'unknown'
});

const userIdSchema = z.string().uuid();
const createUserSchema = z.object({
  displayName: z.string().trim().min(1).max(80)
});

const findUserOr404 = async (userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'User not found.', 'USER_NOT_FOUND');
  return user;
};

const ensureCanModifyTarget = (currentUserId: string, target: { id: string; displayName: string; isAdmin: boolean }) => {
  if (target.id === currentUserId) {
    throw new ApiError(400, 'You cannot perform this action on your own account.', 'CANNOT_MODIFY_SELF');
  }

  if (target.isAdmin || isEricDisplayName(target.displayName)) {
    throw new ApiError(400, `${ADMIN_DISPLAY_NAME} cannot be modified through user management.`, 'CANNOT_MODIFY_ADMIN');
  }
};

adminUsersRouter.use(adminRateLimiter);

adminUsersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: [{ isAdmin: 'desc' }, { isActive: 'desc' }, { displayName: 'asc' }]
    });

    res.json({
      users: users.map(toAdminUserSummary),
      newUserTemporaryPassword: config.auth.newUserDefaultPassword
    });
  })
);

adminUsersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createUserSchema.parse(req.body ?? {});

    if (isEricDisplayName(body.displayName)) {
      throw new ApiError(409, 'Eric already exists as the default administrator.', 'ERIC_ALREADY_EXISTS');
    }

    const duplicate = await prisma.user.findFirst({
      where: {
        displayName: { equals: body.displayName, mode: 'insensitive' },
        isActive: true,
        deletedAt: null
      }
    });

    if (duplicate) {
      throw new ApiError(409, 'A user with that display name already exists.', 'DUPLICATE_USER');
    }

    const user = await prisma.user.create({
      data: {
        displayName: body.displayName,
        loginName: await makeUniqueLoginName(body.displayName),
        passwordHash: await hashPassword(config.auth.newUserDefaultPassword),
        isAdmin: false,
        mustChangePassword: true,
        isActive: true,
        failedLoginCount: 0,
        failedLoginWindowStartedAt: null,
        lockedUntil: null
      }
    });

    logger.info(
      {
        adminUserId: req.auth?.user.id,
        createdUserId: user.id,
        displayName: user.displayName
      },
      'Admin created user'
    );

    res.status(201).json({ user: toAdminUserSummary(user) });
  })
);

adminUsersRouter.patch(
  '/:userId/deactivate',
  asyncHandler(async (req, res) => {
    const userId = userIdSchema.parse(req.params.userId);
    const user = await findUserOr404(userId);
    ensureCanModifyTarget(req.auth!.user.id, user);

    const deactivatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        isActive: false,
        deletedAt: new Date(),
        lockedUntil: null
      }
    });
    await destroySessionsForUser(user.id);

    logger.info(
      {
        adminUserId: req.auth?.user.id,
        deactivatedUserId: user.id,
        displayName: user.displayName
      },
      'Admin deactivated user'
    );

    res.json({ user: toAdminUserSummary(deactivatedUser) });
  })
);

adminUsersRouter.delete(
  '/:userId',
  asyncHandler(async (req, res) => {
    const userId = userIdSchema.parse(req.params.userId);
    const result = await purgeUser({ currentUserId: req.auth!.user.id, targetUserId: userId });

    logger.info(
      {
        adminUserId: req.auth?.user.id,
        purgedUserId: result.user.id,
        displayName: result.user.displayName,
        deleted: result.deleted
      },
      'Admin purged user and user-owned data'
    );

    res.json({
      deletedUserId: result.user.id,
      purgedUser: toAdminUserSummary(result.user),
      deleted: result.deleted
    });
  })
);

adminUsersRouter.post(
  '/:userId/reset-password',
  asyncHandler(async (req, res) => {
    const userId = userIdSchema.parse(req.params.userId);
    const user = await findUserOr404(userId);
    ensureCanModifyTarget(req.auth!.user.id, user);

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(config.auth.newUserDefaultPassword),
        mustChangePassword: true,
        failedLoginCount: 0,
        failedLoginWindowStartedAt: null,
        lockedUntil: null
      }
    });
    await destroySessionsForUser(user.id);

    logger.info(
      {
        adminUserId: req.auth?.user.id,
        resetUserId: user.id,
        displayName: user.displayName
      },
      'Admin reset user password'
    );

    res.json({ user: toAdminUserSummary(updatedUser) });
  })
);
