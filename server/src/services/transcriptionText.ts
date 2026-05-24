export type TranscriptSource = 'transcript' | 'segments' | 'words' | 'none';

export interface ExtractedTranscriptText {
  transcript: string;
  source: TranscriptSource;
  segmentCount?: number;
  wordCount?: number;
}

interface TranscriptionTextResponse {
  transcript?: unknown;
  segments?: unknown;
  words?: unknown;
}

const normalizeNewlines = (value: string) => value.replace(/\r\n?/g, '\n').trim();

const readText = (value: unknown) => (typeof value === 'string' ? normalizeNewlines(value) : '');

const readObjectText = (value: unknown, keys: string[]) => {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;

  for (const key of keys) {
    const text = readText(record[key]);
    if (text) return text;
  }

  return '';
};

const joinWordTokens = (words: string[]) =>
  words
    .join(' ')
    .replace(/\s+([,.;:!?%)\]])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .trim();

export const extractTranscriptText = (response: TranscriptionTextResponse): ExtractedTranscriptText => {
  const transcript = readText(response.transcript);
  if (transcript) {
    return {
      transcript,
      source: 'transcript'
    };
  }

  if (Array.isArray(response.segments)) {
    const segmentTexts = response.segments
      .map((segment) => readObjectText(segment, ['text']))
      .filter((text) => text.length > 0);

    if (segmentTexts.length > 0) {
      return {
        transcript: segmentTexts.join('\n'),
        source: 'segments',
        segmentCount: segmentTexts.length
      };
    }
  }

  if (Array.isArray(response.words)) {
    const wordTexts = response.words
      .map((word) => (typeof word === 'string' ? readText(word) : readObjectText(word, ['word', 'text'])))
      .filter((text) => text.length > 0);

    if (wordTexts.length > 0) {
      return {
        transcript: joinWordTokens(wordTexts),
        source: 'words',
        wordCount: wordTexts.length
      };
    }
  }

  return {
    transcript: '',
    source: 'none'
  };
};
