import { Prisma } from '@prisma/client';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { hashPassword } from './password.js';
import { ADMIN_DISPLAY_NAME, makeUniqueLoginName, normalizeLoginName } from './identity.js';

export const ensureAuthBootstrap = async () => {
  const ericUsers = await prisma.user.findMany({
    where: { displayName: { equals: ADMIN_DISPLAY_NAME, mode: 'insensitive' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
  });
  const existingEric = ericUsers[0] ?? null;

  if (!existingEric) {
    const passwordHash = await hashPassword(config.auth.initialAdminPassword);
    const eric = await prisma.user.create({
      data: {
        displayName: ADMIN_DISPLAY_NAME,
        loginName: normalizeLoginName(ADMIN_DISPLAY_NAME),
        passwordHash,
        isAdmin: true,
        mustChangePassword: true,
        isActive: true,
        deletedAt: null
      }
    });
    logger.info({ userId: eric.id, displayName: eric.displayName }, 'Bootstrapped Eric administrator account');
  } else {
    const updates: Prisma.UserUpdateInput = {
      isAdmin: true,
      isActive: true,
      deletedAt: null
    };

    if (!existingEric.passwordHash) {
      updates.passwordHash = await hashPassword(config.auth.initialAdminPassword);
      updates.mustChangePassword = true;
    }

    if (!existingEric.loginName) {
      updates.loginName = normalizeLoginName(ADMIN_DISPLAY_NAME);
    }

    const eric = await prisma.user.update({
      where: { id: existingEric.id },
      data: updates
    });
    logger.info({ userId: eric.id, displayName: eric.displayName }, 'Verified Eric administrator account');
  }

  for (const duplicateEric of ericUsers.slice(1)) {
    await prisma.user.update({
      where: { id: duplicateEric.id },
      data: {
        isAdmin: false,
        isActive: false,
        deletedAt: duplicateEric.deletedAt ?? new Date(),
        lockedUntil: null
      }
    });
    await prisma.authSession.deleteMany({ where: { userId: duplicateEric.id } });
    logger.warn(
      { userId: duplicateEric.id, displayName: duplicateEric.displayName },
      'Deactivated duplicate Eric account during auth bootstrap'
    );
  }

  const usersMissingLoginName = await prisma.user.findMany({
    where: { loginName: '' }
  });

  for (const user of usersMissingLoginName) {
    await prisma.user.update({
      where: { id: user.id },
      data: { loginName: await makeUniqueLoginName(user.displayName) }
    });
  }

  const usersMissingPassword = await prisma.user.findMany({
    where: {
      passwordHash: null,
      NOT: {
        displayName: { equals: ADMIN_DISPLAY_NAME, mode: 'insensitive' }
      }
    }
  });

  if (usersMissingPassword.length > 0) {
    for (const user of usersMissingPassword) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await hashPassword(config.auth.newUserDefaultPassword),
          mustChangePassword: true,
          isActive: true,
          deletedAt: null
        }
      });
      logger.info({ userId: user.id, displayName: user.displayName }, 'Applied default password to existing user');
    }
  }

  await prisma.authSession.deleteMany({ where: { expiresAt: { lte: new Date() } } });
};
