import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/env.js';
import { ApiError } from '../errors/apiError.js';
import { hashSecurityToken } from './session.js';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

const timingSafeTextEqual = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

export const csrfProtection = (req: Request, _res: Response, next: NextFunction) => {
  if (!config.csrf.enabled || safeMethods.has(req.method.toUpperCase())) {
    next();
    return;
  }

  const expectedHash = req.auth?.csrfTokenHash;
  const submittedToken = req.get(config.csrf.headerName);

  if (!expectedHash || !submittedToken) {
    next(new ApiError(403, 'CSRF token is required.', 'CSRF_REQUIRED'));
    return;
  }

  const submittedHash = hashSecurityToken(submittedToken);
  if (!timingSafeTextEqual(submittedHash, expectedHash)) {
    next(new ApiError(403, 'CSRF token is invalid.', 'CSRF_INVALID'));
    return;
  }

  next();
};
