import { describe, expect, it } from 'vitest';
import {
  sanitizeThinkingBlocks,
  ThinkingBlockSuppressor,
  ThinkingBlockExtractor
} from '../server/src/services/thinkingBlocks.js';
import { sanitizeThinkingBlocks as sanitizeClientThinkingBlocks } from '../client/src/lib/thinkingBlocks.js';

describe('thinking block sanitizer', () => {
  it('strips complete think and thinking blocks before content is displayed or persisted', () => {
    expect(sanitizeThinkingBlocks('<think>private reasoning</think>\n\nVisible answer', { trim: true })).toMatchObject({
      content: 'Visible answer',
      hasThinkingBlock: true,
      suppressedThinkingBlock: true
    });

    expect(sanitizeThinkingBlocks('<thinking data-source="model">private</thinking>Visible answer', { trim: true })).toMatchObject({
      content: 'Visible answer',
      hasThinkingBlock: true,
      suppressedThinkingBlock: true
    });

    expect(sanitizeClientThinkingBlocks('< THINK >private</ THINK >\nVisible answer', { trim: true })).toMatchObject({
      content: 'Visible answer',
      hasThinkingBlock: true,
      suppressedThinkingBlock: true
    });
  });

  it('suppresses thinking blocks whose tags are split across streaming chunks', () => {
    const suppressor = new ThinkingBlockSuppressor();
    let visible = '';

    for (const chunk of ['<thi', 'nk class="x">private streamed reasoning</thi', 'nking>\n\nVisible answer']) {
      visible += suppressor.feed(chunk).delta;
    }
    visible += suppressor.flush().delta;

    expect(visible.trim()).toBe('Visible answer');
    expect(visible).not.toContain('private streamed reasoning');
  });

  it('strips Qwen-style thought control tokens even when split across chunks', () => {
    const suppressor = new ThinkingBlockSuppressor();
    let visible = '';

    for (const chunk of ['<|begin_of', '_thought|>hidden reasoning<|end_', 'of_thought|>\nFinal answer']) {
      visible += suppressor.feed(chunk).delta;
    }
    visible += suppressor.flush().delta;

    expect(visible.trim()).toBe('Final answer');
    expect(visible).not.toContain('hidden reasoning');
  });


  it('can extract thinking text separately from final content', () => {
    const extractor = new ThinkingBlockExtractor();
    const first = extractor.feed('<think>private reasoning</think>Visible');
    const final = extractor.flush();

    expect(`${first.contentDelta}${final.contentDelta}`).toBe('Visible');
    expect(`${first.thinkingDelta}${final.thinkingDelta}`).toBe('private reasoning');
    expect(first.hasThinkingBlock || final.hasThinkingBlock).toBe(true);
  });

  it('does not strip unrelated tags or words that only start with think', () => {
    expect(sanitizeThinkingBlocks('Use <thinker>literally</thinker> here.', { trim: true })).toMatchObject({
      content: 'Use <thinker>literally</thinker> here.',
      hasThinkingBlock: false,
      suppressedThinkingBlock: false
    });
  });
});
