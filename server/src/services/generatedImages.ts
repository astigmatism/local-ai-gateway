import type { Message } from '@prisma/client';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { ApiError } from '../errors/apiError.js';

export interface LocalAiGeneratedImage {
  mimeType: string;
  base64: string;
  width?: number;
  height?: number;
}

export type GeneratedImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface StoredGeneratedImage {
  fileName: string;
  mimeType: GeneratedImageMimeType;
  sizeBytes: number;
  width?: number;
  height?: number;
}

export interface GeneratedImageMessageMetadata {
  type: 'image';
  image: {
    url: string;
    fileName: string;
    mimeType: GeneratedImageMimeType;
    sizeBytes: number;
    prompt: string;
    model: string;
    provider: 'local-ai-llm';
    localAiEndpoint: '/api/images/generate';
    ollamaEndpoint?: '/api/generate';
    generatedAt: string;
    width?: number;
    height?: number;
  };
  generation?: Record<string, unknown>;
}

const mimeToExtension: Record<GeneratedImageMimeType, 'png' | 'jpg' | 'webp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
};

const isGeneratedImageMimeType = (mimeType: string): mimeType is GeneratedImageMimeType => {
  return Object.prototype.hasOwnProperty.call(mimeToExtension, mimeType);
};

const normalizeMimeType = (mimeType: string) => {
  const normalized = mimeType.trim().toLowerCase();
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
};

export const isGeneratedImageMetadata = (value: unknown): value is GeneratedImageMessageMetadata => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'image') return false;
  const image = record.image;
  if (!image || typeof image !== 'object' || Array.isArray(image)) return false;
  const imageRecord = image as Record<string, unknown>;
  return typeof imageRecord.fileName === 'string' && typeof imageRecord.mimeType === 'string' && typeof imageRecord.url === 'string';
};

export const generatedImageMetadataFromMessage = (message: Message): GeneratedImageMessageMetadata | null => {
  return isGeneratedImageMetadata(message.metadata) ? message.metadata : null;
};

export async function saveGeneratedImage(image: LocalAiGeneratedImage): Promise<StoredGeneratedImage> {
  const mimeType = normalizeMimeType(image.mimeType);
  if (!isGeneratedImageMimeType(mimeType)) {
    throw new ApiError(502, 'The image generator returned an unsupported image type.', 'IMAGE_UNSUPPORTED_MIME_TYPE');
  }

  const base64 = image.base64.replace(/^data:[^;,]+;base64,/iu, '').replace(/\s+/gu, '');
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0 || buffer.toString('base64').replace(/=+$/u, '') !== base64.replace(/=+$/u, '')) {
    throw new ApiError(502, 'The image generator returned invalid image data.', 'IMAGE_INVALID_BASE64');
  }

  const storageDir = path.resolve(config.imageGeneration.storageDir);
  await fs.mkdir(storageDir, { recursive: true, mode: 0o750 });
  const extension = mimeToExtension[mimeType];
  const fileName = `${randomUUID()}.${extension}`;
  const filePath = generatedImagePath(fileName);
  await fs.writeFile(filePath, buffer, { mode: 0o640 });

  return {
    fileName,
    mimeType,
    sizeBytes: buffer.length,
    ...(image.width !== undefined ? { width: image.width } : {}),
    ...(image.height !== undefined ? { height: image.height } : {})
  };
}

export function generatedImagePath(fileName: string): string {
  if (!/^[0-9a-fA-F-]+\.(?:png|jpg|webp)$/u.test(fileName)) {
    throw new ApiError(400, 'Invalid generated image reference.', 'IMAGE_REFERENCE_INVALID');
  }

  const storageDir = path.resolve(config.imageGeneration.storageDir);
  const resolved = path.resolve(storageDir, fileName);
  const relative = path.relative(storageDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ApiError(400, 'Invalid generated image reference.', 'IMAGE_REFERENCE_INVALID');
  }

  return resolved;
}