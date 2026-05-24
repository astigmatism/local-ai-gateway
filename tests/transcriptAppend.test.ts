import { describe, expect, it } from 'vitest';
import { appendTranscript } from '../client/src/lib/transcripts.js';

describe('appendTranscript', () => {
  it('inserts a transcript directly when the draft is empty', () => {
    expect(appendTranscript('', '  Hello, world.\nThis keeps line breaks.  ')).toBe(
      'Hello, world.\nThis keeps line breaks.'
    );
  });

  it('separates existing draft text and appended transcript with a blank line', () => {
    expect(appendTranscript('Existing text', 'Hello, this is Eric.')).toBe(
      'Existing text\n\nHello, this is Eric.'
    );
  });

  it('does not erase the existing draft when the transcript is empty', () => {
    expect(appendTranscript('Existing text', '   ')).toBe('Existing text');
  });
});
