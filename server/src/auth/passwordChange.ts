import { type User } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../errors/apiError.js';
import { hashPassword, validateNewPassword, verifyPassword } from './password.js';

interface ChangeOwnPasswordInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

const passwordPersistenceError = () =>
  new ApiError(500, 'Password update could not be verified.', 'PASSWORD_UPDATE_NOT_VERIFIED', undefined, false);

export const changeOwnPassword = async ({
  userId,
  currentPassword,
  newPassword,
  confirmPassword
}: ChangeOwnPasswordInput): Promise<User> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user || !user.isActive || user.deletedAt) {
    throw new ApiError(401, 'Authentication required.', 'AUTH_REQUIRED');
  }

  if (!user.passwordHash) {
    throw new ApiError(400, 'Current password cannot be verified.', 'PASSWORD_NOT_SET');
  }

  const currentPasswordMatches = await verifyPassword(user.passwordHash, currentPassword);
  if (!currentPasswordMatches) {
    throw new ApiError(400, 'Current password is incorrect.', 'CURRENT_PASSWORD_INCORRECT');
  }

  await validateNewPassword({
    currentPasswordHash: user.passwordHash,
    newPassword,
    confirmPassword
  });

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({
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

  const persistedUser = await prisma.user.findUnique({ where: { id: user.id } });
  if (!persistedUser?.passwordHash || persistedUser.mustChangePassword) {
    throw passwordPersistenceError();
  }

  const persistedNewPasswordMatches = await verifyPassword(persistedUser.passwordHash, newPassword);
  const persistedCurrentPasswordStillMatches = await verifyPassword(persistedUser.passwordHash, currentPassword);
  if (!persistedNewPasswordMatches || persistedCurrentPasswordStillMatches) {
    throw passwordPersistenceError();
  }

  return persistedUser;
};
