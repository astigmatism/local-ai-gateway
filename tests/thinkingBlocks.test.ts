import { describe, expect, it } from 'vitest';
import {
  sanitizeThinkingBlocks,
  ThinkingBlockSuppressor,
  ThinkingBlockExtractor
} from '../server/src/services/thinkingBlocks.js';
import {
  sanitizeThinkingBlocks as sanitizeClientThinkingBlocks,
  ThinkingBlockExtractor as ClientThinkingBlockExtractor
} from '../client/src/lib/thinkingBlocks.js';

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

  it('treats near-miss opening tags as thinking when the close tag is exact', () => {
    const result = sanitizeThinkingBlocks('<thin>private near-miss reasoning</think>Visible answer', { trim: true });

    expect(result.content).toBe('Visible answer');
    expect(result.thinking).toContain('private near-miss reasoning');
    expect(result.hasThinkingBlock).toBe(true);
    expect(result.suppressedThinkingBlock).toBe(true);
  });

  it('keeps split untagged reasoning starts out of visible streaming output', () => {
    const extractor = new ThinkingBlockExtractor({ extractUntaggedReasoning: true });
    let visible = '';
    let thinking = '';

    for (const chunk of ['He', "re's a thinking process:\n", 'Analyze User Input\n\nFinal answer:\nVisible answer']) {
      const result = extractor.feed(chunk);
      visible += result.contentDelta;
      thinking += result.thinkingDelta;
    }
    const final = extractor.flush();
    visible += final.contentDelta;
    thinking += final.thinkingDelta;

    expect(visible.trim()).toBe('Visible answer');
    expect(thinking).toContain("Here's a thinking process");
    expect(thinking).toContain('Analyze User Input');
  });

  it('separates untagged thinking that appears after visible answer text and then resumes final output', () => {
    const input = [
      'Visible answer before.',
      '',
      "Here's a thinking process:",
      'Analyze User Input',
      '',
      'Final answer:',
      'Visible answer after.'
    ].join('\n');

    const server = sanitizeThinkingBlocks(input, { trim: true, extractUntaggedReasoning: true });
    const client = sanitizeClientThinkingBlocks(input, { trim: true, extractUntaggedReasoning: true });

    for (const result of [server, client]) {
      expect(result.content).toBe('Visible answer before.\n\nVisible answer after.');
      expect(result.thinking).toContain("Here's a thinking process");
      expect(result.thinking).toContain('Analyze User Input');
      expect(result.content).not.toContain('thinking process');
      expect(result.hasUntaggedReasoning).toBe(true);
      expect(result.suppressedUntaggedReasoning).toBe(true);
    }
  });

  it('keeps split mid-answer untagged reasoning out of visible streaming output', () => {
    type ExtractorConstructor = new (options?: { extractUntaggedReasoning?: boolean }) => {
      feed(input: string): ReturnType<ThinkingBlockExtractor['feed']>;
      flush(): ReturnType<ThinkingBlockExtractor['flush']>;
    };
    const run = (Extractor: ExtractorConstructor) => {
      const extractor = new Extractor({ extractUntaggedReasoning: true });
      let visible = '';
      let thinking = '';

      for (const chunk of [
        'Visible answer before.\n\nHe',
        "re's a thinking process:\n",
        'Analyze User Input\n\nFinal answer:\nVisible answer after.'
      ]) {
        const result = extractor.feed(chunk);
        visible += result.contentDelta;
        thinking += result.thinkingDelta;
      }

      const final = extractor.flush();
      visible += final.contentDelta;
      thinking += final.thinkingDelta;
      return { visible, thinking };
    };

    for (const result of [run(ThinkingBlockExtractor), run(ClientThinkingBlockExtractor)]) {
      expect(result.visible).toBe('Visible answer before.\n\nVisible answer after.');
      expect(result.thinking).toContain("Here's a thinking process");
      expect(result.thinking).toContain('Analyze User Input');
      expect(result.visible).not.toContain('thinking process');
    }
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


  it('strips a fake assistant continuation and unterminated thinking block after valid answer text', () => {
    const visibleAnswer = [
      'That is a great question! The way Millennials and Gen Z express edginess is different.',
      'Here is a lowdown on the differences:',
      '### 1. **Millennial Swearing**',
      'Millennials often leaned on ironic profanity, TV quotes, and early-internet phrasing.'
    ].join('\n');
    const leaked = [
      visibleAnswer,
      '',
      '### Assistant:',
      '<think>',
      "Here's a thinking process:",
      '1. **Analyze User Input:** The user asked "What\'s different between them?"'
    ].join('\n');

    const server = sanitizeThinkingBlocks(leaked, { trim: true, extractUntaggedReasoning: true });
    const client = sanitizeClientThinkingBlocks(leaked, { trim: true, extractUntaggedReasoning: true });

    expect(server.content).toBe(visibleAnswer);
    expect(client).toMatchObject({
      content: server.content,
      hasThinkingBlock: server.hasThinkingBlock,
      suppressedThinkingBlock: server.suppressedThinkingBlock,
      hasUntaggedReasoning: server.hasUntaggedReasoning,
      suppressedUntaggedReasoning: server.suppressedUntaggedReasoning
    });
    for (const result of [server, client]) {
      expect(result.content).not.toContain('### Assistant:');
      expect(result.content).not.toContain('<think>');
      expect(result.content).not.toContain("Here's a thinking process");
      expect(result.content).not.toContain('Analyze User Input');
      expect(result.hasThinkingBlock || result.hasUntaggedReasoning).toBe(true);
      expect(result.suppressedThinkingBlock || result.suppressedUntaggedReasoning).toBe(true);
    }
  });



  it('strips fake assistant continuations with complete thinking blocks while preserving visible text after them', () => {
    const before = 'Valid visible answer part 1.';
    const after = 'Valid visible answer part 2.';
    const leaked = [
      before,
      '',
      '### Assistant:',
      '',
      '<think>',
      "Here's a thinking process:",
      '1. **Analyze User Input:** Hidden self-dialogue.',
      '</think>',
      '',
      after
    ].join('\n');

    const server = sanitizeThinkingBlocks(leaked, { trim: true, extractUntaggedReasoning: true });
    const client = sanitizeClientThinkingBlocks(leaked, { trim: true, extractUntaggedReasoning: true });

    for (const result of [server, client]) {
      expect(result.content).toBe(`${before}\n\n${after}`);
      expect(result.content).not.toContain('### Assistant:');
      expect(result.content).not.toContain('thinking process');
      expect(result.thinking).toContain('### Assistant:');
      expect(result.thinking).toContain('Analyze User Input');
      expect(result.hasThinkingBlock).toBe(true);
      expect(result.suppressedThinkingBlock).toBe(true);
    }
  });

  it('preserves final-answer content after fake assistant untagged reasoning', () => {
    const before = 'Visible answer before the fake continuation.';
    const after = 'Visible answer after hidden reasoning.';
    const leaked = [
      before,
      '',
      'Assistant Response:',
      'Analysis:',
      'Analyze user input and identify key elements before drafting.',
      'Determine best practices, draft, refine, and check against constraints.',
      '',
      'Final answer:',
      after
    ].join('\n');

    const server = sanitizeThinkingBlocks(leaked, { trim: true, extractUntaggedReasoning: true });
    const client = sanitizeClientThinkingBlocks(leaked, { trim: true, extractUntaggedReasoning: true });

    for (const result of [server, client]) {
      expect(result.content).toBe(`${before}\n\n${after}`);
      expect(result.content).not.toContain('Assistant Response:');
      expect(result.content).not.toContain('Analyze user input');
      expect(result.content).not.toContain('Final answer:');
      expect(result.thinking).toContain('Assistant Response:');
      expect(result.thinking).toContain('Analyze user input');
      expect(result.hasUntaggedReasoning).toBe(true);
      expect(result.suppressedUntaggedReasoning).toBe(true);
    }
  });

  it('streams fake assistant complete thinking blocks without leaking the marker and resumes visible output', () => {
    type ExtractorConstructor = new (options?: { extractUntaggedReasoning?: boolean }) => {
      feed(input: string): ReturnType<ThinkingBlockExtractor['feed']>;
      flush(): ReturnType<ThinkingBlockExtractor['flush']>;
    };
    const before = 'Visible answer before.';
    const after = 'Visible answer after.';
    const run = (Extractor: ExtractorConstructor) => {
      const extractor = new Extractor({ extractUntaggedReasoning: true });
      let visible = '';
      let thinking = '';

      for (const chunk of [
        `${before}\n\n### Assist`,
        'ant:\n<thi',
        `nk>hidden reasoning</think>\n\n${after}`
      ]) {
        const result = extractor.feed(chunk);
        visible += result.contentDelta;
        thinking += result.thinkingDelta;
      }

      const final = extractor.flush();
      visible += final.contentDelta;
      thinking += final.thinkingDelta;
      return { visible, thinking };
    };

    for (const result of [run(ThinkingBlockExtractor), run(ClientThinkingBlockExtractor)]) {
      expect(result.visible).toBe(`${before}\n\n${after}`);
      expect(result.visible).not.toContain('### Assistant:');
      expect(result.visible).not.toContain('hidden reasoning');
      expect(result.thinking).toContain('### Assistant:');
      expect(result.thinking).toContain('hidden reasoning');
    }
  });

  it('streams fake assistant untagged reasoning until a final-answer boundary and then resumes visible output', () => {
    type ExtractorConstructor = new (options?: { extractUntaggedReasoning?: boolean }) => {
      feed(input: string): ReturnType<ThinkingBlockExtractor['feed']>;
      flush(): ReturnType<ThinkingBlockExtractor['flush']>;
    };
    const run = (Extractor: ExtractorConstructor) => {
      const extractor = new Extractor({ extractUntaggedReasoning: true });
      let visible = '';
      let thinking = '';

      for (const chunk of [
        'Visible prefix.\n\n### Assistant Response:\nAnalysis:\nAnalyze user input and identify key elements.\n',
        'Determine best practices, draft, refine, and check against constraints.\n\nFinal answer:\n',
        'Visible suffix.'
      ]) {
        const result = extractor.feed(chunk);
        visible += result.contentDelta;
        thinking += result.thinkingDelta;
      }

      const final = extractor.flush();
      visible += final.contentDelta;
      thinking += final.thinkingDelta;
      return { visible, thinking };
    };

    for (const result of [run(ThinkingBlockExtractor), run(ClientThinkingBlockExtractor)]) {
      expect(result.visible).toBe('Visible prefix.\n\nVisible suffix.');
      expect(result.visible).not.toContain('Assistant Response:');
      expect(result.visible).not.toContain('Analyze user input');
      expect(result.thinking).toContain('Assistant Response:');
      expect(result.thinking).toContain('Analyze user input');
    }
  });

  it('strips fake assistant-response continuations followed by untagged reasoning preambles', () => {
    const examples = [
      [
        'Visible answer.',
        '',
        'Assistant Response:',
        'Analysis:',
        'Analyze user input and identify key elements before drafting.'
      ].join('\n'),
      [
        'Visible answer.',
        '',
        '### Assistant Response:',
        'Reasoning:',
        '1. **Analyze User Input:** Work through hidden steps.'
      ].join('\n')
    ];

    for (const leaked of examples) {
      const server = sanitizeThinkingBlocks(leaked, { trim: true, extractUntaggedReasoning: true });
      const client = sanitizeClientThinkingBlocks(leaked, { trim: true, extractUntaggedReasoning: true });

      expect(server.content).toBe('Visible answer.');
      expect(client).toMatchObject({
        content: server.content,
        hasUntaggedReasoning: server.hasUntaggedReasoning,
        suppressedUntaggedReasoning: server.suppressedUntaggedReasoning
      });
      expect(server.hasUntaggedReasoning).toBe(true);
      expect(server.suppressedUntaggedReasoning).toBe(true);
      expect(server.content).not.toContain('Assistant Response:');
      expect(server.content).not.toContain('Analyze User Input');
    }
  });

  it('keeps streamed fake assistant continuations hidden when marker and think tag split across chunks', () => {
    type ExtractorConstructor = new (options?: { extractUntaggedReasoning?: boolean }) => {
      feed(input: string): ReturnType<ThinkingBlockExtractor['feed']>;
      flush(): ReturnType<ThinkingBlockExtractor['flush']>;
    };
    const run = (Extractor: ExtractorConstructor) => {
      const extractor = new Extractor({ extractUntaggedReasoning: true });
      let visible = '';
      let thinking = '';
      let hasThinkingBlock = false;
      let suppressedThinkingBlock = false;
      let hasUntaggedReasoning = false;
      let suppressedUntaggedReasoning = false;

      for (const chunk of [
        'Visible answer paragraph.\n\n### Assist',
        'ant:\n\n<thi',
        "nk>\nHere's a thinking process:\n1. **Analyze User Input:** hidden steps"
      ]) {
        const result = extractor.feed(chunk);
        visible += result.contentDelta;
        thinking += result.thinkingDelta;
        hasThinkingBlock = hasThinkingBlock || result.hasThinkingBlock;
        suppressedThinkingBlock = suppressedThinkingBlock || result.suppressedThinkingBlock;
        hasUntaggedReasoning = hasUntaggedReasoning || Boolean(result.hasUntaggedReasoning);
        suppressedUntaggedReasoning = suppressedUntaggedReasoning || Boolean(result.suppressedUntaggedReasoning);
      }

      const final = extractor.flush();
      visible += final.contentDelta;
      thinking += final.thinkingDelta;
      hasThinkingBlock = hasThinkingBlock || final.hasThinkingBlock;
      suppressedThinkingBlock = suppressedThinkingBlock || final.suppressedThinkingBlock;
      hasUntaggedReasoning = hasUntaggedReasoning || Boolean(final.hasUntaggedReasoning);
      suppressedUntaggedReasoning = suppressedUntaggedReasoning || Boolean(final.suppressedUntaggedReasoning);

      return { visible, thinking, hasThinkingBlock, suppressedThinkingBlock, hasUntaggedReasoning, suppressedUntaggedReasoning };
    };

    for (const result of [run(ThinkingBlockExtractor), run(ClientThinkingBlockExtractor)]) {
      expect(result.visible).toBe('Visible answer paragraph.');
      expect(result.visible).not.toContain('### Assistant:');
      expect(result.visible).not.toContain('<think>');
      expect(result.visible).not.toContain('Analyze User Input');
      expect(result.thinking).toContain('Analyze User Input');
      expect(result.hasThinkingBlock || result.hasUntaggedReasoning).toBe(true);
      expect(result.suppressedThinkingBlock || result.suppressedUntaggedReasoning).toBe(true);
    }
  });

  it('does not over-strip normal prose or benign transcript examples using assistant', () => {
    const inline = 'A helpful assistant can explain trade-offs without revealing private reasoning.';
    expect(sanitizeThinkingBlocks(inline, { trim: true, extractUntaggedReasoning: true })).toMatchObject({
      content: inline,
      hasThinkingBlock: false,
      suppressedThinkingBlock: false,
      hasUntaggedReasoning: false,
      suppressedUntaggedReasoning: false
    });

    const transcript = ['Example transcript:', 'Assistant:', 'Hello! I can help with that.', 'User:', 'Thanks.'].join('\n');
    expect(sanitizeThinkingBlocks(transcript, { trim: true, extractUntaggedReasoning: true })).toMatchObject({
      content: transcript,
      hasThinkingBlock: false,
      suppressedThinkingBlock: false,
      hasUntaggedReasoning: false,
      suppressedUntaggedReasoning: false
    });
  });

  it('does not strip unrelated tags or words that only start with think', () => {
    expect(sanitizeThinkingBlocks('Use <thinker>literally</thinker> here.', { trim: true })).toMatchObject({
      content: 'Use <thinker>literally</thinker> here.',
      hasThinkingBlock: false,
      suppressedThinkingBlock: false
    });
  });

  it('preserves benign markdown code examples that contain thinking-like tokens and transcript labels', () => {
    const codeExample = [
      'Here is a literal parser fixture:',
      '```xml',
      '<think>literal tag in documentation</think>',
      'Assistant:',
      'Analysis: this line is part of the code sample, not hidden reasoning.',
      '```',
      'The explanation continues here.'
    ].join('\n');

    const server = sanitizeThinkingBlocks(codeExample, { trim: true, extractUntaggedReasoning: true });
    const client = sanitizeClientThinkingBlocks(codeExample, { trim: true, extractUntaggedReasoning: true });

    for (const result of [server, client]) {
      expect(result.content).toBe(codeExample);
      expect(result.thinking).toBe('');
      expect(result.hasThinkingBlock).toBe(false);
      expect(result.hasUntaggedReasoning).toBe(false);
    }

    type ExtractorConstructor = new (options?: { extractUntaggedReasoning?: boolean }) => {
      feed(input: string): ReturnType<ThinkingBlockExtractor['feed']>;
      flush(): ReturnType<ThinkingBlockExtractor['flush']>;
    };
    const run = (Extractor: ExtractorConstructor) => {
      const extractor = new Extractor({ extractUntaggedReasoning: true });
      let visible = '';
      let thinking = '';

      for (const chunk of [
        'Here is a literal parser fixture:\n``',
        '`xml\n<thi',
        'nk>literal tag in documentation</think>\nAssistant:\nAnalysis: this line is part of the code sample, not hidden reasoning.\n',
        '```\nThe explanation continues here.'
      ]) {
        const result = extractor.feed(chunk);
        visible += result.contentDelta;
        thinking += result.thinkingDelta;
      }

      const final = extractor.flush();
      visible += final.contentDelta;
      thinking += final.thinkingDelta;
      return { visible, thinking };
    };

    for (const result of [run(ThinkingBlockExtractor), run(ClientThinkingBlockExtractor)]) {
      expect(result.visible).toBe(codeExample);
      expect(result.thinking).toBe('');
    }
  });
});
