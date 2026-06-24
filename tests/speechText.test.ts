import { describe, expect, it } from 'vitest';
import { normalizeTextForSpeech } from '../client/src/lib/speechText.js';

describe('normalizeTextForSpeech', () => {
  it('lightly removes common Markdown syntax without changing stored message content', () => {
    const result = normalizeTextForSpeech(`### Why It Matters

- **Local** gateway calls [voice service](http://example.test).
- Use \`af_heart\` by default.

\`\`\`ts
const speed = 1.0;
\`\`\``);

    expect(result).toBe('Why It Matters\n\nLocal gateway calls voice service.\nUse af_heart by default.\n\nconst speed = 1.0;');
  });

  it('returns an empty string for whitespace-only content', () => {
    expect(normalizeTextForSpeech('  \n\t  ')).toBe('');
  });

  it('removes hidden thinking blocks before preparing text for TTS', () => {
    expect(normalizeTextForSpeech('\n\n<think>private reasoning</think>\n\n**Visible answer**')).toBe('Visible answer');
  });
});
