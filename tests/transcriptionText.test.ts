import { describe, expect, it } from 'vitest';
import { extractTranscriptText } from '../server/src/services/transcriptionText.js';

describe('extractTranscriptText', () => {
  it('prefers the top-level transcript and preserves punctuation and line breaks', () => {
    const result = extractTranscriptText({
      transcript: 'Hello, this is Eric on May 22nd, 2026.\n\nThis is a second sentence.',
      segments: [{ text: 'fallback should not be used' }]
    });

    expect(result).toEqual({
      transcript: 'Hello, this is Eric on May 22nd, 2026.\n\nThis is a second sentence.',
      source: 'transcript'
    });
  });

  it('falls back to segment text with readable separators', () => {
    const result = extractTranscriptText({
      segments: [
        { start: 0, end: 2, text: 'Hello, this came from segment one.' },
        { start: 2, end: 4, text: 'This came from segment two.' }
      ]
    });

    expect(result).toEqual({
      transcript: 'Hello, this came from segment one.\nThis came from segment two.',
      source: 'segments',
      segmentCount: 2
    });
  });

  it('uses word tokens only as a final fallback', () => {
    const result = extractTranscriptText({
      words: [{ word: 'Hello' }, { word: ',' }, { word: 'world' }, { word: '!' }]
    });

    expect(result).toEqual({
      transcript: 'Hello, world!',
      source: 'words',
      wordCount: 4
    });
  });

  it('returns an empty result when no transcript text is available', () => {
    const result = extractTranscriptText({ transcript: '   ', segments: [{ text: '   ' }] });

    expect(result).toEqual({
      transcript: '',
      source: 'none'
    });
  });
});
