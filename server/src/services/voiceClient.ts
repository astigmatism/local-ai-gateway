import fs from 'node:fs';
import axios from 'axios';
import FormData from 'form-data';
import { z } from 'zod';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError } from '../errors/apiError.js';
import { maybeFormatTranscript } from './transcriptFormatter.js';
import { extractTranscriptText } from './transcriptionText.js';

const transcriptionResponseSchema = z
  .object({
    filename: z.string().optional(),
    model: z.string().optional(),
    language: z.string().optional(),
    language_probability: z.number().optional(),
    vad_filter: z.boolean().optional(),
    min_silence_duration_ms: z.number().optional(),
    transcript: z.string().nullable().optional(),
    segments: z
      .array(
        z
          .object({
            start: z.number().optional(),
            end: z.number().optional(),
            text: z.string().nullable().optional()
          })
          .passthrough()
      )
      .optional(),
    words: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              word: z.string().nullable().optional(),
              text: z.string().nullable().optional()
            })
            .passthrough()
        ])
      )
      .optional()
  })
  .passthrough();

export interface VoiceTranscriptionResult {
  transcript: string;
  metadata: Record<string, unknown>;
}

const axiosErrorMessage = (error: unknown) => {
  if (axios.isAxiosError(error)) {
    if (error.response) {
      return `HTTP ${error.response.status}: ${JSON.stringify(error.response.data).slice(0, 500)}`;
    }
    if (error.code === 'ECONNABORTED') {
      return `request timed out after ${config.voice.timeoutMs} ms`;
    }
    return error.message;
  }

  return error instanceof Error ? error.message : 'unknown error';
};

export const transcribeAudio = async (
  filePath: string,
  originalFilename: string,
  mimeType?: string
): Promise<VoiceTranscriptionResult> => {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: originalFilename || 'recording.webm',
    contentType: mimeType || 'application/octet-stream'
  });

  try {
    const response = await axios.post(`${config.voice.baseUrl}/transcribe`, form, {
      headers: form.getHeaders(),
      timeout: config.voice.timeoutMs,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: (status) => status >= 200 && status < 300
    });

    const parsed = transcriptionResponseSchema.parse(response.data);
    const extracted = extractTranscriptText(parsed);

    if (!extracted.transcript) {
      throw new ApiError(502, 'Voice service returned an empty transcript.', 'VOICE_EMPTY_TRANSCRIPT', {
        filename: originalFilename,
        transcriptSource: extracted.source
      });
    }

    const formatting = await maybeFormatTranscript(extracted.transcript);
    const finalTranscript = formatting.transcript.trim();

    if (!finalTranscript) {
      throw new ApiError(502, 'Voice service returned an empty transcript.', 'VOICE_EMPTY_TRANSCRIPT', {
        filename: originalFilename,
        transcriptSource: extracted.source
      });
    }

    const serviceMetadata = { ...parsed };
    delete serviceMetadata.transcript;

    const transcriptMetadata: Record<string, unknown> = {
      transcriptSource: extracted.source,
      transcriptFormatting: formatting.metadata,
      transcribedAt: new Date().toISOString()
    };

    if (extracted.segmentCount !== undefined) {
      transcriptMetadata.transcriptSegmentCount = extracted.segmentCount;
    }

    if (extracted.wordCount !== undefined) {
      transcriptMetadata.transcriptWordCount = extracted.wordCount;
    }

    if (formatting.metadata.applied) {
      transcriptMetadata.rawTranscript = extracted.transcript;
    }

    logger.info(
      {
        transcriptSource: extracted.source,
        rawTranscriptLength: extracted.transcript.length,
        finalTranscriptLength: finalTranscript.length,
        transcriptFormattingApplied: formatting.metadata.applied
      },
      'Voice transcription completed'
    );

    return {
      transcript: finalTranscript,
      metadata: {
        ...serviceMetadata,
        ...transcriptMetadata
      }
    };
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    const message = axiosErrorMessage(error);
    logger.error(
      {
        errorMessage: message,
        errorCode: axios.isAxiosError(error) ? error.code : undefined,
        voiceBaseUrl: config.voice.baseUrl
      },
      'Voice transcription request failed'
    );
    throw new ApiError(502, `Voice transcription failed: ${message}`, 'VOICE_REQUEST_FAILED');
  }
};
