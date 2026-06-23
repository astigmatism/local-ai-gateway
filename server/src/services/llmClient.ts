import axios from 'axios';
import { z } from 'zod';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../errors/apiError.js';
import { resolveDefaultLlmModel } from './modelSettingsService.js';
import {
  sanitizeThinkingBlocks,
  ThinkingBlockExtractor,
  type ThinkingBlockExtractionResult,
  type ThinkingBlockMetadata
} from './thinkingBlocks.js';

const ollamaModelDetailsSchema = z
  .object({
    capabilities: z.array(z.string()).optional(),
    digest: z.string().optional(),
    details: z
      .object({
        family: z.string().optional(),
        families: z.array(z.string()).optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

type OllamaModelDetails = z.infer<typeof ollamaModelDetailsSchema>;

const ollamaGenerateResponseSchema = z
  .object({
    model: z.string().optional(),
    created_at: z.string().optional(),
    response: z.string().optional(),
    done: z.boolean().optional(),
    done_reason: z.string().optional(),
    total_duration: z.number().optional(),
    load_duration: z.number().optional(),
    prompt_eval_count: z.number().optional(),
    prompt_eval_duration: z.number().optional(),
    eval_count: z.number().optional(),
    eval_duration: z.number().optional(),
    context: z.array(z.number()).optional(),
    thinking: z.unknown().optional()
  })
  .passthrough();

type OllamaGenerateResponse = z.infer<typeof ollamaGenerateResponseSchema>;

const localAiGeneratedImageSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  base64: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
});

const localAiImageResponseSchema = z.object({
  ok: z.literal(true),
  model: z.string().min(1),
  images: z.array(localAiGeneratedImageSchema).min(1),
  metadata: z.record(z.string(), z.unknown()).optional()
});

type LocalAiImageResponse = z.infer<typeof localAiImageResponseSchema>;

const localAiImageGenerationCapabilitySchema = z
  .object({
    enabled: z.boolean(),
    available: z.boolean(),
    currentModel: z.string().nullable().optional(),
    installed: z.boolean().nullable().optional(),
    loaded: z.boolean().nullable().optional(),
    endpoint: z.literal('/api/images/generate').optional(),
    ollamaEndpoint: z.literal('/api/generate').optional(),
    maxPromptChars: z.number().optional(),
    provider: z.literal('ollama').optional(),
    requiredCapability: z.literal('image').optional(),
    modelCapabilities: z.array(z.string()).optional(),
    supportsImageGeneration: z.boolean().nullable().optional(),
    supportsImageInput: z.boolean().nullable().optional(),
    reason: z.string().optional()
  })
  .passthrough();

const localAiCapabilitiesResponseSchema = z
  .object({
    ok: z.literal(true),
    imageGeneration: localAiImageGenerationCapabilitySchema
  })
  .passthrough();

type LocalAiImageGenerationCapability = z.infer<typeof localAiImageGenerationCapabilitySchema>;

export interface OllamaGenerateStreamChunk extends Record<string, unknown> {
  model?: string;
  created_at?: string;
  response?: string;
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  context?: number[];
  thinking?: unknown;
}

export interface LlmGenerateResult {
  content: string;
  metadata: Record<string, unknown>;
}

export interface LlmGenerateOptions {
  model?: string;
  timeoutMs?: number;
  enableThinking?: boolean;
}

export interface LlmStreamOptions extends LlmGenerateOptions {
  signal?: AbortSignal;
}

export interface ImageGenerateOptions {
  width?: number;
  height?: number;
  steps?: number;
  signal?: AbortSignal;
}

export interface ImageGenerateResult {
  model: string;
  image: LocalAiImageResponse['images'][number];
  images: LocalAiImageResponse['images'];
  metadata: Record<string, unknown>;
}

export interface LlmStreamMetadataEvent {
  type: 'metadata';
  provider: 'ollama';
  endpoint: '/api/generate';
  model: string;
  generatedAt: string;
}

interface OllamaModelCapabilityCacheEntry {
  capabilities: string[];
  digest?: string;
  cachedAt: number;
}

interface OllamaThinkingRequestDecision {
  modelCapabilities?: string[];
  supportsThinking: boolean | null;
  requestedThinking: boolean;
  supportsThinkingControl: boolean;
  thinkEnabled: boolean;
  thinkDisabled: boolean;
  thinkEnabledReason?: 'capability' | 'known-reasoning-model';
  thinkDisabledReason?: 'capability' | 'known-reasoning-model';
  assumeLeadingThinking: boolean;
}

export interface LlmStreamDeltaEvent {
  type: 'delta';
  delta: string;
  content: string;
  generatedAt: string;
}

export interface LlmStreamThinkingDeltaEvent {
  type: 'thinking_delta';
  delta: string;
  thinking: string;
  generatedAt: string;
}

export interface LlmStreamDoneEvent {
  type: 'done';
  content: string;
  metadata: Record<string, unknown>;
}

export type LlmStreamEvent = LlmStreamMetadataEvent | LlmStreamDeltaEvent | LlmStreamThinkingDeltaEvent | LlmStreamDoneEvent;

const client = axios.create({
  baseURL: config.llm.baseUrl,
  timeout: config.llm.timeoutMs,
  headers: {
    'Content-Type': 'application/json'
  },
  validateStatus: (status) => status >= 200 && status < 300
});

const localAiClient = axios.create({
  baseURL: config.llm.monitorBaseUrl,
  timeout: config.imageGeneration.timeoutMs,
  headers: {
    'Content-Type': 'application/json'
  },
  validateStatus: (status) => status >= 200 && status < 300
});

const imageCapabilityCheckTimeoutMs = () => Math.min(config.imageGeneration.timeoutMs, 30000);
const modelCapabilityCacheTtlMs = 5 * 60 * 1000;
const modelDetailsTimeoutMs = () => Math.min(5_000, config.modelManagement.detailsTimeoutMs, config.llm.timeoutMs);

const modelCapabilityCache = new Map<string, OllamaModelCapabilityCacheEntry>();

const axiosErrorMessage = (error: unknown, timeoutMs = config.llm.timeoutMs) => {
  if (axios.isAxiosError(error)) {
    if (error.response) {
      return `HTTP ${error.response.status}: ${JSON.stringify(error.response.data).slice(0, 500)}`;
    }
    if (error.code === 'ECONNABORTED') {
      return `request timed out after ${timeoutMs} ms`;
    }
    return error.message;
  }

  return error instanceof Error ? error.message : 'unknown error';
};

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';

const parseMaybeJson = (value: string): unknown => {
  if (value.trim() === '') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const extractOllamaErrorMessage = (body: unknown) => {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.status === 'string') return record.status;
  }
  return typeof body === 'string' && body.trim() ? body.slice(0, 500) : null;
};

const apiErrorFromOllamaStatus = (status: number, body: unknown) => {
  const message = extractOllamaErrorMessage(body) ?? `Ollama returned HTTP ${status}`;
  const statusCode = status >= 400 && status < 600 ? status : 502;

  if (status === 404) {
    return new ApiError(404, message, 'LLM_MODEL_NOT_FOUND', { provider: 'ollama', response: body });
  }

  if (status === 408 || status === 504) {
    return new ApiError(504, message, 'LLM_TIMEOUT', { provider: 'ollama', response: body });
  }

  return new ApiError(statusCode, message, 'LLM_REQUEST_FAILED', { provider: 'ollama', response: body });
};

const metadataFromOllamaGenerate = (
  parsed: OllamaGenerateResponse,
  model: string,
  hasThinkingField: boolean,
  thinkingDecision: OllamaThinkingRequestDecision,
  thinkingBlockMetadata: ThinkingBlockMetadata = { hasThinkingBlock: false, suppressedThinkingBlock: false },
  thinkingContent = ''
): Record<string, unknown> => {
  const ollamaMetadata: Record<string, unknown> = { ...parsed };
  delete ollamaMetadata.response;
  delete ollamaMetadata.thinking;

  const trimmedThinkingContent = thinkingContent.trim();

  return {
    provider: 'ollama',
    model,
    generatedAt: new Date().toISOString(),
    hasThinkingField,
    hasRawThinkingTag: thinkingBlockMetadata.hasThinkingBlock,
    rawThinkingTagSuppressed: thinkingBlockMetadata.suppressedThinkingBlock,
    thinkingCapabilityDetected: thinkingDecision.supportsThinking,
    thinkingRequested: thinkingDecision.requestedThinking,
    thinkingEnabled: thinkingDecision.thinkEnabled,
    thinkDisabled: thinkingDecision.thinkDisabled,
    supportsThinkingControl: thinkingDecision.supportsThinkingControl,
    ...(thinkingDecision.thinkEnabledReason ? { thinkEnabledReason: thinkingDecision.thinkEnabledReason } : {}),
    ...(thinkingDecision.thinkDisabledReason ? { thinkDisabledReason: thinkingDecision.thinkDisabledReason } : {}),
    ...(trimmedThinkingContent ? { thinkingContent: trimmedThinkingContent } : {}),
    ...(thinkingDecision.modelCapabilities ? { modelCapabilities: thinkingDecision.modelCapabilities } : {}),
    ollama: ollamaMetadata
  };
};

const readOllamaErrorBody = async (response: Response) => {
  const text = await response.text();
  return parseMaybeJson(text);
};

const fetchErrorMessage = (error: unknown, timeoutMs: number) => {
  if (isAbortError(error)) return `request timed out or was canceled after ${timeoutMs} ms`;
  return error instanceof Error ? error.message : 'unknown error';
};

const stringifyThinkingField = (value: unknown) => {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const mergeThinkingContent = (...parts: string[]) =>
  parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');

const imageCapabilityUnavailableMessage = (capability: LocalAiImageGenerationCapability) =>
  capability.reason ??
  (capability.supportsImageGeneration === false
    ? `The selected local-ai-llm model${capability.currentModel ? ` (${capability.currentModel})` : ''} does not support image generation output through Ollama.`
    : 'local-ai-llm reports image generation is not available for the selected provider/model.');

const imageCapabilityUnavailableCode = (capability: LocalAiImageGenerationCapability) => {
  if (!capability.enabled) return 'IMAGE_GENERATION_DISABLED';
  if (capability.supportsImageGeneration === false) return 'IMAGE_GENERATION_UNSUPPORTED_MODEL';
  return 'IMAGE_GENERATION_UNAVAILABLE';
};

const imageCapabilityUnavailableStatus = (capability: LocalAiImageGenerationCapability) => {
  if (!capability.enabled) return 503;
  if (capability.supportsImageGeneration === false) return 422;
  return 503;
};

const normalizeCapabilityName = (capability: string) => capability.trim().toLowerCase();

const hasThinkingCapability = (capabilities: string[]) =>
  capabilities.some((capability) => normalizeCapabilityName(capability) === 'thinking');

const knownRawThinkingModelMarkers = [
  'qwen',
  'qwq',
  'deepseek-r1',
  'deepseek_r1',
  'deepseek r1',
  'gpt-oss'
];

const isKnownRawThinkingModel = (model: string, details?: OllamaModelDetails | null) => {
  const identifiers = [model, details?.details?.family, ...(details?.details?.families ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());

  return identifiers.some((identifier) => knownRawThinkingModelMarkers.some((marker) => identifier.includes(marker)));
};

const qwenNoThinkModelMarkers = ['qwen', 'qwq'];

const isKnownQwenThinkingModelName = (model: string) => {
  const normalizedModel = model.trim().toLowerCase();
  return qwenNoThinkModelMarkers.some((marker) => normalizedModel.includes(marker));
};

const thinkingDirectivePattern = /(?:^|\n)\s*\/(?:no_think|think)\b/i;

const applyThinkingPromptDirective = (prompt: string, model: string, thinkingDecision: OllamaThinkingRequestDecision) => {
  if (!isKnownQwenThinkingModelName(model)) return prompt;
  if (thinkingDirectivePattern.test(prompt)) return prompt;

  if (thinkingDecision.thinkEnabled) return `/think\n\n${prompt.trimStart()}`;
  if (thinkingDecision.thinkDisabled) return `/no_think\n\n${prompt.trimStart()}`;
  return prompt;
};

const readCachedModelCapabilities = (model: string) => {
  const cached = modelCapabilityCache.get(model);
  if (!cached || Date.now() - cached.cachedAt > modelCapabilityCacheTtlMs) return null;
  return cached;
};

const fetchOllamaModelDetails = async (model: string): Promise<OllamaModelDetails | null> => {
  const cached = readCachedModelCapabilities(model);
  if (cached) {
    return {
      capabilities: cached.capabilities,
      ...(cached.digest ? { digest: cached.digest } : {})
    };
  }

  try {
    const response = await client.post(
      '/api/show',
      { model },
      {
        timeout: modelDetailsTimeoutMs()
      }
    );
    const parsed = ollamaModelDetailsSchema.parse(response.data);
    const capabilities = parsed.capabilities ?? [];

    modelCapabilityCache.set(model, {
      capabilities,
      ...(parsed.digest ? { digest: parsed.digest } : {}),
      cachedAt: Date.now()
    });

    return parsed;
  } catch (error) {
    logger.warn(
      {
        errorMessage: axiosErrorMessage(error, modelDetailsTimeoutMs()),
        llmBaseUrl: config.llm.baseUrl,
        model
      },
      'Could not inspect Ollama model capabilities; falling back to model-name-based thinking suppression'
    );
    return null;
  }
};

const resolveThinkingRequestDecision = async (
  model: string,
  requestedThinking = false
): Promise<OllamaThinkingRequestDecision> => {
  const details = await fetchOllamaModelDetails(model);
  const capabilities = details?.capabilities;
  const supportsThinking = capabilities ? hasThinkingCapability(capabilities) : null;
  const looksLikeRawThinkingModel = isKnownRawThinkingModel(model, details);
  const supportsThinkingControl = supportsThinking === true || looksLikeRawThinkingModel;
  const reason = supportsThinking === true
    ? 'capability'
    : looksLikeRawThinkingModel
      ? 'known-reasoning-model'
      : undefined;
  const thinkEnabled = requestedThinking && supportsThinkingControl;
  const thinkDisabled = !requestedThinking && supportsThinkingControl;

  return {
    ...(capabilities ? { modelCapabilities: capabilities } : {}),
    supportsThinking,
    requestedThinking,
    supportsThinkingControl,
    thinkEnabled,
    thinkDisabled,
    ...(thinkEnabled && reason ? { thinkEnabledReason: reason } : {}),
    ...(thinkDisabled && reason ? { thinkDisabledReason: reason } : {}),
    assumeLeadingThinking: thinkEnabled && looksLikeRawThinkingModel
  };
};

const buildOllamaGenerateRequestBody = async (
  model: string,
  prompt: string,
  stream: boolean,
  options: Pick<LlmGenerateOptions, 'enableThinking'> = {}
) => {
  const thinkingDecision = await resolveThinkingRequestDecision(model, options.enableThinking === true);
  return {
    body: {
      model,
      prompt: applyThinkingPromptDirective(prompt, model, thinkingDecision),
      stream,
      ...(thinkingDecision.thinkEnabled ? { think: true } : {}),
      ...(thinkingDecision.thinkDisabled ? { think: false } : {})
    },
    thinkingDecision
  };
};

const assertLocalAiImageGenerationAvailable = async (signal?: AbortSignal) => {
  try {
    const response = await localAiClient.get('/api/capabilities', {
      timeout: imageCapabilityCheckTimeoutMs(),
      signal
    });
    const parsed = localAiCapabilitiesResponseSchema.parse(response.data);
    const capability = parsed.imageGeneration;

    if (capability.enabled && capability.available) return;

    throw new ApiError(
      imageCapabilityUnavailableStatus(capability),
      imageCapabilityUnavailableMessage(capability),
      imageCapabilityUnavailableCode(capability),
      {
        provider: 'local-ai-llm',
        imageGeneration: capability
      }
    );
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof z.ZodError) {
      throw new ApiError(502, 'local-ai-llm returned an invalid capability response.', 'IMAGE_CAPABILITY_RESPONSE_INVALID', {
        issues: error.issues
      });
    }

    if (axios.isAxiosError(error)) {
      if (error.response?.status === 404) {
        logger.warn(
          { localAiBaseUrl: config.llm.monitorBaseUrl },
          'local-ai-llm capability endpoint was not found; proceeding with image request for backward compatibility'
        );
        return;
      }

      const statusCode = error.response?.status ?? (error.code === 'ECONNABORTED' ? 504 : 503);
      const message = error.code === 'ECONNABORTED'
        ? `Capability check timed out after ${imageCapabilityCheckTimeoutMs()} ms.`
        : axiosErrorMessage(error, imageCapabilityCheckTimeoutMs());

      logger.error(
        {
          errorMessage: message,
          errorCode: error.code,
          localAiBaseUrl: config.llm.monitorBaseUrl,
          statusCode
        },
        'local-ai-llm image-generation capability check failed'
      );

      throw new ApiError(
        statusCode >= 400 && statusCode < 600 ? statusCode : 503,
        `Unable to verify local-ai-llm image-generation capability: ${message}`,
        'IMAGE_CAPABILITY_CHECK_FAILED',
        {
          provider: 'local-ai-llm',
          response: error.response?.data as unknown
        }
      );
    }

    const message = error instanceof Error ? error.message : 'unknown error';
    throw new ApiError(502, `Unable to verify local-ai-llm image-generation capability: ${message}`, 'IMAGE_CAPABILITY_CHECK_FAILED');
  }
};

export const generateWithLlm = async (
  prompt: string,
  options: LlmGenerateOptions = {}
): Promise<LlmGenerateResult> => {
  const model = options.model ?? (await resolveDefaultLlmModel());
  const timeoutMs = options.timeoutMs ?? config.llm.timeoutMs;

  try {
    const { body, thinkingDecision } = await buildOllamaGenerateRequestBody(model, prompt, false, options);
    const response = await client.post('/api/generate', body, { timeout: timeoutMs });

    const parsed = ollamaGenerateResponseSchema.parse(response.data);
    const sanitized = sanitizeThinkingBlocks(parsed.response ?? '', {
      trim: true,
      assumeLeadingThinking: thinkingDecision.assumeLeadingThinking
    });
    const content = sanitized.content;
    const thinkingContent = mergeThinkingContent(stringifyThinkingField(parsed.thinking), sanitized.thinking);

    if (!content) {
      throw new ApiError(502, 'LLM returned an empty response.', 'LLM_EMPTY_RESPONSE', {
        model
      });
    }

    return {
      content,
      metadata: metadataFromOllamaGenerate(
        parsed,
        model,
        parsed.thinking !== undefined,
        thinkingDecision,
        {
          hasThinkingBlock: sanitized.hasThinkingBlock,
          suppressedThinkingBlock: sanitized.suppressedThinkingBlock
        },
        thinkingContent
      )
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    const message = axiosErrorMessage(error, timeoutMs);
    logger.error(
      {
        errorMessage: message,
        errorCode: axios.isAxiosError(error) ? error.code : undefined,
        llmBaseUrl: config.llm.baseUrl,
        model
      },
      'LLM request failed'
    );
    throw new ApiError(502, `LLM request failed: ${message}`, 'LLM_REQUEST_FAILED');
  }
};

export const generateImageWithLlm = async (
  prompt: string,
  options: ImageGenerateOptions = {}
): Promise<ImageGenerateResult> => {
  const trimmedPrompt = prompt.trim();

  if (!config.imageGeneration.enabled) {
    throw new ApiError(503, 'Image generation is disabled in Bear Castle AI.', 'IMAGE_GENERATION_DISABLED');
  }

  if (!trimmedPrompt) {
    throw new ApiError(400, 'Add an image prompt after /image.', 'IMAGE_PROMPT_REQUIRED');
  }

  if (trimmedPrompt.length > config.imageGeneration.maxPromptChars) {
    throw new ApiError(413, `Image prompt must be ${config.imageGeneration.maxPromptChars} characters or fewer.`, 'IMAGE_PROMPT_TOO_LONG');
  }

  const { signal, ...generationOptions } = options;

  try {
    await assertLocalAiImageGenerationAvailable(signal);

    const response = await localAiClient.post(
      '/api/images/generate',
      {
        prompt: trimmedPrompt,
        options: generationOptions
      },
      { timeout: config.imageGeneration.timeoutMs, signal }
    );

    const parsed = localAiImageResponseSchema.parse(response.data);
    const [image] = parsed.images;
    if (!image) {
      throw new ApiError(502, 'local-ai-llm returned no image data.', 'IMAGE_GENERATION_EMPTY_RESULT');
    }

    return {
      model: parsed.model,
      image,
      images: parsed.images,
      metadata: parsed.metadata ?? {}
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof z.ZodError) {
      throw new ApiError(502, 'local-ai-llm returned an invalid image-generation response.', 'IMAGE_GENERATION_RESPONSE_INVALID', {
        issues: error.issues
      });
    }

    if (axios.isAxiosError(error)) {
      const statusCode = error.response?.status ?? (error.code === 'ECONNABORTED' ? 504 : 503);
      const responseData = error.response?.data as unknown;
      const responseRecord = responseData && typeof responseData === 'object' && !Array.isArray(responseData)
        ? responseData as Record<string, unknown>
        : null;
      const errorRecord = responseRecord?.error && typeof responseRecord.error === 'object' && !Array.isArray(responseRecord.error)
        ? responseRecord.error as Record<string, unknown>
        : null;
      const message = typeof errorRecord?.message === 'string'
        ? errorRecord.message
        : error.code === 'ECONNABORTED'
          ? `Image generation timed out after ${config.imageGeneration.timeoutMs} ms.`
          : axiosErrorMessage(error, config.imageGeneration.timeoutMs);
      const code = typeof errorRecord?.code === 'string' ? errorRecord.code : 'IMAGE_GENERATION_REQUEST_FAILED';

      logger.error(
        {
          errorMessage: message,
          errorCode: error.code,
          localAiBaseUrl: config.llm.monitorBaseUrl,
          statusCode
        },
        'local-ai-llm image-generation request failed'
      );

      throw new ApiError(statusCode >= 400 && statusCode < 600 ? statusCode : 502, message, code, {
        provider: 'local-ai-llm',
        response: responseData
      });
    }

    const message = error instanceof Error ? error.message : 'unknown error';
    logger.error({ errorMessage: message, localAiBaseUrl: config.llm.monitorBaseUrl }, 'local-ai-llm image-generation request failed');
    throw new ApiError(502, `Image generation request failed: ${message}`, 'IMAGE_GENERATION_REQUEST_FAILED');
  }
};

const parseOllamaGenerateStreamLine = (line: string): OllamaGenerateResponse | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed) as unknown;
  } catch {
    throw new ApiError(502, 'LLM stream returned malformed NDJSON.', 'LLM_STREAM_INVALID_JSON');
  }

  try {
    return ollamaGenerateResponseSchema.parse(raw);
  } catch (error) {
    throw new ApiError(502, 'LLM stream returned an unexpected chunk shape.', 'LLM_STREAM_INVALID_CHUNK', {
      issues: error instanceof z.ZodError ? error.issues : undefined
    });
  }
};

export async function* generateWithLlmStream(
  prompt: string,
  options: LlmStreamOptions = {}
): AsyncGenerator<LlmStreamEvent> {
  const model = options.model ?? (await resolveDefaultLlmModel());
  const timeoutMs = options.timeoutMs ?? config.llm.timeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort();

  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  let finalChunk: OllamaGenerateResponse | null = null;
  let content = '';
  let thinkingContent = '';
  let hasThinkingField = false;
  let hasRawThinkingTag = false;
  let suppressedRawThinkingTag = false;

  try {
    const { body, thinkingDecision } = await buildOllamaGenerateRequestBody(model, prompt, true, options);
    const thinkingBlockExtractor = new ThinkingBlockExtractor({
      assumeLeadingThinking: thinkingDecision.assumeLeadingThinking
    });
    const response = await fetch(`${config.llm.baseUrl}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      throw apiErrorFromOllamaStatus(response.status, await readOllamaErrorBody(response));
    }

    if (!response.body) {
      throw new ApiError(502, 'LLM stream did not include a response body.', 'LLM_STREAM_MISSING_BODY', {
        model
      });
    }

    yield {
      type: 'metadata',
      provider: 'ollama',
      endpoint: '/api/generate',
      model,
      generatedAt: new Date().toISOString()
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const recordThinkingBlockResult = (result: ThinkingBlockExtractionResult) => {
      hasRawThinkingTag = hasRawThinkingTag || result.hasThinkingBlock;
      suppressedRawThinkingTag = suppressedRawThinkingTag || result.suppressedThinkingBlock;
    };

    const appendThinkingDelta = function* (delta: string): Generator<LlmStreamThinkingDeltaEvent> {
      const thinkingDelta = thinkingContent.length === 0 ? delta.replace(/^\s+/, '') : delta;
      if (thinkingDelta.length === 0) return;

      thinkingContent += thinkingDelta;
      yield {
        type: 'thinking_delta',
        delta: thinkingDelta,
        thinking: thinkingContent,
        generatedAt: new Date().toISOString()
      };
    };

    const appendVisibleDelta = function* (delta: string): Generator<LlmStreamDeltaEvent> {
      const visibleDelta = content.length === 0 ? delta.replace(/^\s+/, '') : delta;
      if (visibleDelta.length === 0) return;

      content += visibleDelta;
      yield {
        type: 'delta',
        delta: visibleDelta,
        content,
        generatedAt: new Date().toISOString()
      };
    };

    const appendExtractedDeltas = function* (
      extracted: ThinkingBlockExtractionResult
    ): Generator<LlmStreamDeltaEvent | LlmStreamThinkingDeltaEvent> {
      recordThinkingBlockResult(extracted);
      yield* appendThinkingDelta(extracted.thinkingDelta);
      yield* appendVisibleDelta(extracted.contentDelta);
    };

    const readLine = function* (line: string): Generator<LlmStreamDeltaEvent | LlmStreamThinkingDeltaEvent> {
      const parsed = parseOllamaGenerateStreamLine(line);
      if (!parsed) return;

      if (parsed.thinking !== undefined) {
        hasThinkingField = true;
        yield* appendThinkingDelta(stringifyThinkingField(parsed.thinking));
      }

      const delta = typeof parsed.response === 'string' ? parsed.response : '';
      if (delta.length > 0) {
        yield* appendExtractedDeltas(thinkingBlockExtractor.feed(delta));
      }

      if (parsed.done === true) {
        finalChunk = parsed;
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        for (const event of readLine(line)) {
          yield event;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const event of readLine(buffer)) {
        yield event;
      }
    }

    const flushed = thinkingBlockExtractor.flush();
    for (const event of appendExtractedDeltas(flushed)) {
      yield event;
    }

    if (!finalChunk) {
      throw new ApiError(502, 'LLM stream ended before Ollama sent a done chunk.', 'LLM_STREAM_INCOMPLETE', {
        model
      });
    }

    const finalContent = content.trim();
    if (!finalContent) {
      throw new ApiError(502, 'LLM returned an empty response.', 'LLM_EMPTY_RESPONSE', {
        model
      });
    }

    yield {
      type: 'done',
      content: finalContent,
      metadata: metadataFromOllamaGenerate(
        finalChunk,
        model,
        hasThinkingField,
        thinkingDecision,
        {
          hasThinkingBlock: hasRawThinkingTag,
          suppressedThinkingBlock: suppressedRawThinkingTag
        },
        thinkingContent
      )
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw new ApiError(499, 'LLM request was canceled.', 'LLM_REQUEST_ABORTED', { model });
    }

    if (error instanceof ApiError) {
      throw error;
    }

    const message = fetchErrorMessage(error, timeoutMs);
    logger.error(
      {
        errorMessage: message,
        llmBaseUrl: config.llm.baseUrl,
        model
      },
      'LLM stream request failed'
    );
    throw new ApiError(502, `LLM stream request failed: ${message}`, 'LLM_STREAM_REQUEST_FAILED');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}
