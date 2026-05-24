import crypto, { type ScryptOptions } from 'node:crypto';
import { config } from '../config/env.js';
import { ApiError } from '../errors/apiError.js';

const algorithm = 'scrypt';
const scryptOptions = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
} as const satisfies ScryptOptions;
const keyLength = 64;

const encode = (value: Buffer) => value.toString('base64url');
const decode = (value: string) => Buffer.from(value, 'base64url');

const scryptAsync = (password: string, salt: Buffer, length: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, length, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });

const derivePasswordKey = async (
  password: string,
  salt: Buffer,
  length = keyLength,
  options: ScryptOptions = scryptOptions
) => scryptAsync(password, salt, length, options);

export const hashPassword = async (password: string) => {
  const salt = crypto.randomBytes(16);
  const key = await derivePasswordKey(password, salt);
  return [algorithm, scryptOptions.N, scryptOptions.r, scryptOptions.p, encode(salt), encode(key)].join('$');
};

export const verifyPassword = async (passwordHash: string | null | undefined, password: string) => {
  if (!passwordHash || !password) return false;

  const [storedAlgorithm, storedN, storedR, storedP, saltText, keyText] = passwordHash.split('$');
  if (storedAlgorithm !== algorithm || !storedN || !storedR || !storedP || !saltText || !keyText) {
    return false;
  }

  const parsedOptions = {
    N: Number(storedN),
    r: Number(storedR),
    p: Number(storedP),
    maxmem: 64 * 1024 * 1024
  } satisfies ScryptOptions;

  if (!Number.isFinite(parsedOptions.N) || !Number.isFinite(parsedOptions.r) || !Number.isFinite(parsedOptions.p)) {
    return false;
  }

  try {
    const salt = decode(saltText);
    const storedKey = decode(keyText);
    const derived = await derivePasswordKey(password, salt, storedKey.length, parsedOptions);

    return storedKey.length === derived.length && crypto.timingSafeEqual(storedKey, derived);
  } catch {
    return false;
  }
};

export const validateNewPassword = async ({
  newPassword,
  confirmPassword
}: {
  newPassword: string;
  confirmPassword: string;
}) => {
  if (!newPassword) {
    throw new ApiError(400, 'New password is required.', 'PASSWORD_REQUIRED');
  }

  if (newPassword !== confirmPassword) {
    throw new ApiError(400, 'New passwords do not match.', 'PASSWORD_CONFIRMATION_MISMATCH');
  }

  if (newPassword.length < config.auth.minPasswordLength) {
    throw new ApiError(
      400,
      `New password must be at least ${config.auth.minPasswordLength} characters long.`,
      'PASSWORD_TOO_SHORT'
    );
  }
};
