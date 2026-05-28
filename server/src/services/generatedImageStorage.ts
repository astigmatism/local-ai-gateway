import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/env.js';
import { ApiError } from '../errors/apiError.js';

export interface StoredGeneratedImage {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

const mimeToExtension: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

export async function saveGeneratedImageFile({
  conversationId,
  messageId,
  base64,
  mimeType
}: {
  conversationId: string;
  messageId: string;
  base64: string;
  mimeType: string;
}): Promise<StoredGeneratedImage> {
  const decoded = decodeAndValidateImage(base64, mimeType);
  const extension = mimeToExtension[decoded.mimeType];
  if (!extension) {
    throw new ApiError(502, `Unsupported generated image MIME type: ${decoded.mimeType}`, 'IMAGE_STORAGE_UNSUPPORTED_MIME');
  }

  await fs.mkdir(config.imageGeneration.storageDir, { recursive: true });
  const filename = `${messageId}.${extension}`;
  const filePath = resolveGeneratedImagePath(filename);
  await fs.writeFile(filePath, decoded.buffer, { mode: 0o640 });

  return {
    filename,
    mimeType: decoded.mimeType,
    sizeBytes: decoded.buffer.length,
    url: `/api/conversations/${conversationId}/messages/${messageId}/image`
  };
}

export function resolveGeneratedImagePath(filename: string): string {
  if (!/^[0-9a-fA-F-]{36}\.(png|jpg|webp|gif)$/.test(filename)) {
    throw new ApiError(404, 'Generated image not found.', 'GENERATED_IMAGE_NOT_FOUND');
  }

  const resolved = path.resolve(config.imageGeneration.storageDir, filename);
  const root = path.resolve(config.imageGeneration.storageDir);
  if (resolved !== path.join(root, path.basename(filename))) {
    throw new ApiError(400, 'Invalid generated image path.', 'GENERATED_IMAGE_PATH_INVALID');
  }

  return resolved;
}

export async function readGeneratedImageFile(filename: string): Promise<Buffer> {
  const filePath = resolveGeneratedImagePath(filename);
  try {
    return await fs.readFile(filePath);
  } catch {
    throw new ApiError(404, 'Generated image file not found.', 'GENERATED_IMAGE_NOT_FOUND');
  }
}

function decodeAndValidateImage(base64: string, declaredMimeType: string): { buffer: Buffer; mimeType: string } {
  const normalizedBase64 = stripDataUriPrefix(base64);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedBase64) || normalizedBase64.length < 16) {
    throw new ApiError(502, 'Generated image data is not valid base64.', 'IMAGE_STORAGE_INVALID_BASE64');
  }

  const buffer = Buffer.from(normalizedBase64, 'base64');
  const detectedMimeType = detectImageMimeType(buffer);

  if (!detectedMimeType) {
    throw new ApiError(502, 'Generated image data is not a supported image format.', 'IMAGE_STORAGE_INVALID_IMAGE');
  }

  if (declaredMimeType !== detectedMimeType) {
    throw new ApiError(
      502,
      `Generated image MIME mismatch: service returned ${declaredMimeType}, decoded image is ${detectedMimeType}.`,
      'IMAGE_STORAGE_MIME_MISMATCH'
    );
  }

  return { buffer, mimeType: detectedMimeType };
}

function stripDataUriPrefix(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^data:image\/[a-z0-9.+-]+;base64,(?<data>[A-Za-z0-9+/=\r\n]+)$/iu);
  return (match?.groups?.data ?? trimmed).replace(/\s+/g, '');
}

function detectImageMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  return null;
}
