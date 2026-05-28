import axios, { AxiosError } from 'axios';
import { config } from '../config/env.js';
import { ApiError } from '../errors/apiError.js';

export interface LocalGeneratedImage {
  mimeType: string;
  base64: string;
  width?: number;
  height?: number;
}

export interface LocalImageGenerationResult {
  model: string;
  image: LocalGeneratedImage;
  metadata: Record<string, unknown>;
}

interface LocalImageGenerationResponse {
  ok?: boolean;
  model?: unknown;
  images?: unknown;
  image?: unknown;
  metadata?: unknown;
}

export async function generateImageWithLocalAi(prompt: string): Promise<LocalImageGenerationResult> {
  if (!config.imageGeneration.enabled) {
    throw new ApiError(
      503,
      'Image generation is disabled on the gateway. Enable IMAGE_GENERATION_ENABLED and configure local-ai-llm image generation first.',
      'IMAGE_GENERATION_DISABLED'
    );
  }

  if (prompt.trim().length === 0) {
    throw new ApiError(400, 'Image prompt is required.', 'IMAGE_PROMPT_REQUIRED');
  }

  if (prompt.length > config.imageGeneration.maxPromptChars) {
    throw new ApiError(
      413,
      `Image prompt is too long. Maximum length is ${config.imageGeneration.maxPromptChars} characters.`,
      'IMAGE_PROMPT_TOO_LONG'
    );
  }

  try {
    const response = await axios.post<LocalImageGenerationResponse>(
      `${config.llm.monitorBaseUrl}/api/images/generate`,
      { prompt },
      {
        timeout: config.imageGeneration.timeoutMs,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }
      }
    );

    return parseLocalImageGenerationResponse(response.data);
  } catch (error) {
    if (error instanceof ApiError) throw error;

    if (axios.isAxiosError(error)) {
      throw apiErrorFromAxios(error);
    }

    throw new ApiError(503, 'local-ai-llm image generation is unavailable.', 'IMAGE_GENERATION_SERVICE_UNAVAILABLE');
  }
}

function parseLocalImageGenerationResponse(data: LocalImageGenerationResponse): LocalImageGenerationResult {
  if (data.ok === false) {
    throw new ApiError(502, 'local-ai-llm reported image generation failed.', 'IMAGE_GENERATION_FAILED');
  }

  const model = typeof data.model === 'string' && data.model.trim().length > 0 ? data.model : 'unknown-image-model';
  const image = extractImage(data);

  if (!image) {
    throw new ApiError(
      502,
      'local-ai-llm did not return generated image data. Verify the configured model supports image generation.',
      'IMAGE_GENERATION_NO_IMAGE'
    );
  }

  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)) {
    throw new ApiError(502, `Unsupported generated image MIME type: ${image.mimeType}`, 'IMAGE_GENERATION_UNSUPPORTED_MIME');
  }

  if (!/^[A-Za-z0-9+/\s]+={0,2}$/.test(image.base64) || image.base64.replace(/\s+/g, '').length < 16) {
    throw new ApiError(502, 'local-ai-llm returned invalid base64 image data.', 'IMAGE_GENERATION_INVALID_IMAGE');
  }

  return {
    model,
    image: {
      ...image,
      base64: image.base64.replace(/\s+/g, '')
    },
    metadata: isRecord(data.metadata) ? data.metadata : {}
  };
}

function extractImage(data: LocalImageGenerationResponse): LocalGeneratedImage | null {
  if (Array.isArray(data.images)) {
    for (const value of data.images) {
      const image = parseImageRecord(value);
      if (image) return image;
    }
  }

  return parseImageRecord(data.image);
}

function parseImageRecord(value: unknown): LocalGeneratedImage | null {
  if (!isRecord(value)) return null;
  const mimeType = typeof value.mimeType === 'string' ? value.mimeType : typeof value.mime_type === 'string' ? value.mime_type : null;
  const base64 = typeof value.base64 === 'string' ? value.base64 : typeof value.data === 'string' ? value.data : null;
  if (!mimeType || !base64) return null;

  return {
    mimeType,
    base64,
    width: typeof value.width === 'number' ? value.width : undefined,
    height: typeof value.height === 'number' ? value.height : undefined
  };
}

function apiErrorFromAxios(error: AxiosError<unknown>): ApiError {
  if (error.code === 'ECONNABORTED') {
    return new ApiError(
      504,
      'Timed out waiting for local-ai-llm image generation.',
      'IMAGE_GENERATION_TIMEOUT'
    );
  }

  if (error.response) {
    const payload = isRecord(error.response.data) ? error.response.data : null;
    const errorPayload = isRecord(payload?.error) ? payload.error : null;
    const code = typeof errorPayload?.code === 'string' ? errorPayload.code : 'IMAGE_GENERATION_SERVICE_ERROR';
    const message = typeof errorPayload?.message === 'string'
      ? errorPayload.message
      : `local-ai-llm image generation failed with HTTP ${error.response.status}.`;
    const safeStatus = error.response.status >= 400 && error.response.status < 600 ? error.response.status : 502;

    return new ApiError(safeStatus, message, code, errorPayload?.details);
  }

  return new ApiError(
    503,
    'Could not reach local-ai-llm image generation endpoint.',
    'IMAGE_GENERATION_SERVICE_UNAVAILABLE',
    error.message
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
