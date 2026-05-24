import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../errors/apiError.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { isEricDisplayName, makeUniqueLoginName, toAdminUserSummary } from '../auth/identity.js';
import { hashPassword } from '../auth/password.js';

export const usersRouter = Router();

const createUserSchema = z.object({
  displayName: z.string().trim().min(1).max(80)
});

usersRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: [{ isAdmin: 'desc' }, { isActive: 'desc' }, { displayName: 'asc' }]
    });

    res.json({ users: users.map(toAdminUserSummary) });
  })
);

usersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createUserSchema.parse(req.body);

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
        isActive: true
      }
    });

    logger.info(
      {
        adminUserId: req.auth?.user.id,
        createdUserId: user.id,
        displayName: user.displayName
      },
      'Admin created user through legacy users route'
    );

    res.status(201).json({ user: toAdminUserSummary(user) });
  })
);
