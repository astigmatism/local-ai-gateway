import type { User } from '@prisma/client';
import { prisma } from '../db/prisma.js';

export const ADMIN_DISPLAY_NAME = 'Eric';

export interface SafeLoginUser {
  id: string;
  displayName: string;
  initials: string;
}

export interface AuthenticatedUser {
  id: string;
  displayName: string;
  loginName: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

export interface AdminUserSummary extends AuthenticatedUser {
  isActive: boolean;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export const isEricDisplayName = (displayName: string) =>
  displayName.trim().localeCompare(ADMIN_DISPLAY_NAME, undefined, { sensitivity: 'accent' }) === 0;

export const initialsForDisplayName = (displayName: string) => {
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  return initials || 'U';
};

export const normalizeLoginName = (displayName: string) => {
  const normalized = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || 'user';
};

export const makeUniqueLoginName = async (displayName: string) => {
  const base = normalizeLoginName(displayName);
  let candidate = base;
  let suffix = 2;

  while (await prisma.user.findUnique({ where: { loginName: candidate } })) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }

  return candidate;
};

export const toSafeLoginUser = (user: Pick<User, 'id' | 'displayName'>): SafeLoginUser => ({
  id: user.id,
  displayName: user.displayName,
  initials: initialsForDisplayName(user.displayName)
});

export const toAuthenticatedUser = (
  user: Pick<User, 'id' | 'displayName' | 'loginName' | 'isAdmin' | 'mustChangePassword'>
): AuthenticatedUser => ({
  id: user.id,
  displayName: user.displayName,
  loginName: user.loginName,
  isAdmin: user.isAdmin,
  mustChangePassword: user.mustChangePassword
});

export const toAdminUserSummary = (user: User): AdminUserSummary => ({
  ...toAuthenticatedUser(user),
  isActive: user.isActive,
  lockedUntil: user.lockedUntil,
  lastLoginAt: user.lastLoginAt,
  passwordChangedAt: user.passwordChangedAt,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  deletedAt: user.deletedAt
});

export const isEricAdmin = (user: Pick<User, 'displayName' | 'isAdmin'>) =>
  user.isAdmin && isEricDisplayName(user.displayName);
