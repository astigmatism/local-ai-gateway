import axios from 'axios';
import { z } from 'zod';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../errors/apiError.js';

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
    thinking: z.unknown().optional()
  })
  .passthrough();

export interface LlmGenerateResult {
  content: string;
  metadata: Record<string, unknown>;
}

export interface LlmGenerateOptions {
  model?: string;
  timeoutMs?: number;
}

const client = axios.create({
  baseURL: config.llm.baseUrl,
  timeout: config.llm.timeoutMs,
  headers: {
    'Content-Type': 'application/json'
  },
  validateStatus: (status) => status >= 200 && status < 300
});

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

export const generateWithLlm = async (
  prompt: string,
  options: LlmGenerateOptions = {}
): Promise<LlmGenerateResult> => {
  const model = options.model ?? config.llm.model;
  const timeoutMs = options.timeoutMs ?? config.llm.timeoutMs;

  try {
    const response = await client.post(
      '/api/generate',
      {
        model,
        prompt,
        stream: false
      },
      { timeout: timeoutMs }
    );

    const parsed = ollamaGenerateResponseSchema.parse(response.data);
    const content = parsed.response?.trim() ?? '';

    if (!content) {
      throw new ApiError(502, 'LLM returned an empty response.', 'LLM_EMPTY_RESPONSE', {
        model
      });
    }

    const ollamaMetadata = { ...parsed };
    delete ollamaMetadata.response;
    delete ollamaMetadata.thinking;

    return {
      content,
      metadata: {
        provider: 'ollama',
        model,
        generatedAt: new Date().toISOString(),
        hasThinkingField: parsed.thinking !== undefined,
        ollama: ollamaMetadata
      }
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
