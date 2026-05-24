import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../errors/apiError.js';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  keyPrefix: string;
  windowMs: number;
  max: number;
  keyGenerator?: (req: Request) => string;
}

const buckets = new Map<string, RateLimitBucket>();

const defaultKeyGenerator = (req: Request) => req.ip || req.socket.remoteAddress || 'unknown';

const pruneExpiredBuckets = (now: number) => {
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
};

export const createRateLimiter = ({ keyPrefix, windowMs, max, keyGenerator = defaultKeyGenerator }: RateLimitOptions) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const now = Date.now();
    pruneExpiredBuckets(now);

    const key = `${keyPrefix}:${keyGenerator(req)}`;
    const existing = buckets.get(key);
    const bucket = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    buckets.set(key, bucket);

    if (bucket.count > max) {
      next(new ApiError(429, 'Too many requests. Try again later.', 'RATE_LIMITED'));
      return;
    }

    next();
  };
};
