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

  it('strips multiple think blocks while preserving normal answer text', () => {
    const result = sanitizeThinkingBlocks(
      '<think>first private block</think>\nFinal answer part one.\n<think>second private block</think>\nFinal answer part two.',
      { trim: true }
    );

    expect(result.content).toBe('Final answer part one.\n\nFinal answer part two.');
    expect(result.thinking).toContain('first private block');
    expect(result.thinking).toContain('second private block');
    expect(result.content).not.toContain('private block');
  });

  it('treats unterminated think blocks as internal content instead of visible output', () => {
    const result = sanitizeThinkingBlocks('<think>\nReasoning that never closes...\nFinal answer is maybe here', { trim: true });

    expect(result.content).toBe('');
    expect(result.thinking).toContain('Reasoning that never closes');
    expect(result.hasThinkingBlock).toBe(true);
    expect(result.suppressedThinkingBlock).toBe(true);
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

  it('suppresses think tags split across the exact user-observed streaming boundary shape', () => {
    const suppressor = new ThinkingBlockSuppressor();
    let visible = '';

    for (const chunk of ['<thi', 'nk>reasoning', '</th', 'ink>Final answer']) {
      visible += suppressor.feed(chunk).delta;
    }
    visible += suppressor.flush().delta;

    expect(visible).toBe('Final answer');
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

  it('extracts untagged analysis sections before the final answer when enabled', () => {
    const leaked = [
      'Analysis:',
      'Analyze user input and identify key elements in input.',
      'Determine best practices, draft, refine, and check against constraints.',
      '',
      'Final answer:',
      'Visible answer only.'
    ].join('\n');

    const server = sanitizeThinkingBlocks(leaked, { trim: true, extractUntaggedReasoning: true });
    const client = sanitizeClientThinkingBlocks(leaked, { trim: true, extractUntaggedReasoning: true });

    expect(server).toMatchObject({
      content: 'Visible answer only.',
      hasUntaggedReasoning: true,
      suppressedUntaggedReasoning: true
    });
    expect(server.thinking).toContain('Analyze user input');
    expect(client).toMatchObject({
      content: 'Visible answer only.',
      hasUntaggedReasoning: true,
      suppressedUntaggedReasoning: true
    });
  });

  it('keeps streamed untagged analysis out of visible content until the final marker arrives', () => {
    const extractor = new ThinkingBlockExtractor({ extractUntaggedReasoning: true });
    let visible = '';
    let thinking = '';

    for (const chunk of ['Analysis:\nAnalyze user input.\n', 'Identify key elements.\n\nFinal answer:\n', 'Visible answer.']) {
      const result = extractor.feed(chunk);
      visible += result.contentDelta;
      thinking += result.thinkingDelta;
    }
    const final = extractor.flush();
    visible += final.contentDelta;
    thinking += final.thinkingDelta;

    expect(visible.trim()).toBe('Visible answer.');
    expect(thinking).toContain('Analyze user input');
    expect(visible).not.toContain('Identify key elements');
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
