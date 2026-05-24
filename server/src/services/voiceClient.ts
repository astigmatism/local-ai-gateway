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

export interface VoiceSpeechOptions {
  text: string;
  voice: string;
  speed: number;
  timeoutMs?: number;
}

export interface VoiceSpeechResult {
  audio: Buffer;
  contentType: string;
  headers: {
    engine?: string;
    voice?: string;
    speed?: string;
  };
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

const readHeader = (headers: unknown, name: string) => {
  if (!headers || typeof headers !== 'object') return undefined;

  const maybeGetter = headers as { get?: (headerName: string) => unknown };
  if (typeof maybeGetter.get === 'function') {
    const value = maybeGetter.get(name);
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.join(', ');
    if (value !== undefined && value !== null) return String(value);
  }

  const record = headers as Record<string, unknown>;
  const value = record[name.toLowerCase()] ?? record[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  if (value !== undefined && value !== null) return String(value);
  return undefined;
};

const ttsErrorStatusCode = (error: unknown) => {
  if (!axios.isAxiosError(error)) return 500;
  if (error.code === 'ECONNABORTED') return 504;
  if (error.response) return error.response.status >= 500 ? 503 : 502;
  return 503;
};

const ttsErrorCode = (error: unknown) => {
  if (!axios.isAxiosError(error)) return 'TTS_REQUEST_FAILED';
  if (error.code === 'ECONNABORTED') return 'TTS_TIMEOUT';
  if (error.response) return 'TTS_SERVICE_FAILED';
  return 'TTS_SERVICE_UNAVAILABLE';
};

const ttsErrorMessage = (error: unknown, timeoutMs: number) => {
  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED') {
      return `Voice text-to-speech timed out after ${timeoutMs} ms.`;
    }
    if (error.response) {
      return `Voice text-to-speech failed with HTTP ${error.response.status}.`;
    }
    return 'Voice text-to-speech service is unavailable.';
  }

  return 'Voice text-to-speech failed.';
};

export const speakText = async ({ text, voice, speed, timeoutMs = config.tts.timeoutMs }: VoiceSpeechOptions) => {
  const form = new FormData();
  form.append('text', text);
  form.append('voice', voice);
  form.append('speed', String(speed));

  try {
    const response = await axios.post(`${config.voice.baseUrl}/speak`, form, {
      headers: form.getHeaders(),
      timeout: timeoutMs,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      responseType: 'arraybuffer',
      validateStatus: (status) => status >= 200 && status < 300
    });

    const audio = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);

    if (audio.byteLength === 0) {
      throw new ApiError(502, 'Voice text-to-speech returned empty audio.', 'TTS_EMPTY_AUDIO');
    }

    const contentType = readHeader(response.headers, 'content-type') || 'audio/wav';
    const headers = {
      engine: readHeader(response.headers, 'x-tts-engine'),
      voice: readHeader(response.headers, 'x-tts-voice'),
      speed: readHeader(response.headers, 'x-tts-speed')
    };

    logger.info(
      {
        textLength: text.length,
        voice,
        speed,
        audioBytes: audio.byteLength,
        contentType,
        ttsEngine: headers.engine
      },
      'Voice text-to-speech completed'
    );

    return {
      audio,
      contentType,
      headers
    } satisfies VoiceSpeechResult;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    const message = ttsErrorMessage(error, timeoutMs);
    logger.error(
      {
        errorMessage: message,
        errorCode: axios.isAxiosError(error) ? error.code : undefined,
        responseStatus: axios.isAxiosError(error) ? error.response?.status : undefined,
        voiceBaseUrl: config.voice.baseUrl,
        textLength: text.length,
        voice,
        speed
      },
      'Voice text-to-speech request failed'
    );

    throw new ApiError(ttsErrorStatusCode(error), message, ttsErrorCode(error));
  }
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
