import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { generateWithLlm } from './llmClient.js';
import { resolveOptionalLlmFeatureModel } from './modelSettingsService.js';

export interface TranscriptFormattingMetadata {
  enabled: boolean;
  applied: boolean;
  model?: string;
  rawTranscriptLength: number;
  formattedTranscriptLength?: number;
  skippedReason?: 'disabled' | 'empty' | 'too_long' | 'model_unavailable' | 'empty_formatter_response';
  failed?: boolean;
  error?: string;
  formattedAt?: string;
}

const missingModelMessage = 'Transcript formatting model is not configured and no default LLM model is available.';

export interface TranscriptFormattingResult {
  transcript: string;
  metadata: TranscriptFormattingMetadata;
}

const buildTranscriptFormattingPrompt = (transcript: string) =>
  [
    'You are a transcript formatter. Restore punctuation, capitalization, paragraph breaks, and readable sentence boundaries in the transcript below. Do not add facts. Do not remove meaning. Do not summarize. Do not answer the transcript. Return only the cleaned transcript text.',
    '',
    'Important:',
    '- Do not respond conversationally.',
    '- Do not add explanations.',
    '- Do not wrap the transcript in Markdown.',
    '- Do not change names, numbers, commands, code, URLs, or technical terms unless obvious speech recognition spacing/capitalization needs correction.',
    '- If the transcript is too short, return the original with only obvious capitalization or punctuation fixes.',
    '',
    'Transcript:',
    transcript
  ].join('\n');

const unwrapAccidentalFence = (value: string) => {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```(?:text|txt|transcript|markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return fenceMatch?.[1]?.trim() ?? trimmed;
};

export const maybeFormatTranscript = async (rawTranscript: string): Promise<TranscriptFormattingResult> => {
  const trimmed = rawTranscript.trim();
  const rawTranscriptLength = trimmed.length;

  if (!config.transcriptFormatting.enabled) {
    return {
      transcript: rawTranscript,
      metadata: {
        enabled: false,
        applied: false,
        rawTranscriptLength,
        skippedReason: 'disabled'
      }
    };
  }

  if (!trimmed) {
    return {
      transcript: rawTranscript,
      metadata: {
        enabled: true,
        applied: false,
        rawTranscriptLength,
        skippedReason: 'empty'
      }
    };
  }

  if (trimmed.length > config.transcriptFormatting.maxChars) {
    logger.warn(
      {
        rawTranscriptLength,
        maxChars: config.transcriptFormatting.maxChars
      },
      'Transcript formatting skipped because transcript exceeded configured maximum length'
    );

    return {
      transcript: rawTranscript,
      metadata: {
        enabled: true,
        applied: false,
        model: config.transcriptFormatting.model,
        rawTranscriptLength,
        skippedReason: 'too_long'
      }
    };
  }

  let model: string | undefined;
  try {
    model = await resolveOptionalLlmFeatureModel(config.transcriptFormatting.model);
    if (!model) {
      logger.warn(
        {
          rawTranscriptLength
        },
        'Transcript formatting skipped because no LLM model could be resolved'
      );

      return {
        transcript: rawTranscript,
        metadata: {
          enabled: true,
          applied: false,
          rawTranscriptLength,
          skippedReason: 'model_unavailable',
          failed: true,
          error: missingModelMessage
        }
      };
    }

    const result = await generateWithLlm(buildTranscriptFormattingPrompt(trimmed), {
      model,
      timeoutMs: config.transcriptFormatting.timeoutMs
    });
    const formattedTranscript = unwrapAccidentalFence(result.content);

    if (!formattedTranscript) {
      return {
        transcript: rawTranscript,
        metadata: {
          enabled: true,
          applied: false,
          model,
          rawTranscriptLength,
          skippedReason: 'empty_formatter_response'
        }
      };
    }

    return {
      transcript: formattedTranscript,
      metadata: {
        enabled: true,
        applied: true,
        model,
        rawTranscriptLength,
        formattedTranscriptLength: formattedTranscript.length,
        formattedAt: new Date().toISOString()
      }
    };
  } catch (error) {
    logger.warn(
      {
        errorMessage: error instanceof Error ? error.message : 'Unknown transcript formatting error',
        rawTranscriptLength,
        model
      },
      'Transcript formatting failed; using raw voice transcript'
    );

    return {
      transcript: rawTranscript,
      metadata: {
        enabled: true,
        applied: false,
        model,
        rawTranscriptLength,
        failed: true,
        error: error instanceof Error ? error.message : 'Unknown transcript formatting error'
      }
    };
  }
};
