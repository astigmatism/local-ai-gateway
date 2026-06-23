import { describe, expect, it } from 'vitest';
import { buildConversationPrompt } from '../server/src/services/promptBuilder.js';

describe('buildConversationPrompt', () => {
  it('includes recent conversation and assistant cue', () => {
    const prompt = buildConversationPrompt(
      [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'What can you do?' }
      ],
      { maxMessages: 20, maxChars: 24000, modelName: 'qwen3:30b' }
    );

    expect(prompt).toContain('User: Hello');
    expect(prompt).toContain('Assistant: Hi there');
    expect(prompt).toContain('User: What can you do?');
    expect(prompt.endsWith('Assistant:')).toBe(true);
  });

  it('keeps prompt under approximate character limit', () => {
    const prompt = buildConversationPrompt(
      [
        { role: 'user', content: 'a'.repeat(5000) },
        { role: 'assistant', content: 'b'.repeat(5000) },
        { role: 'user', content: 'c'.repeat(5000) }
      ],
      { maxMessages: 20, maxChars: 1000, modelName: 'qwen3:30b' }
    );

    expect(prompt.length).toBeLessThanOrEqual(1050);
    expect(prompt).toContain('Assistant:');
  });

  it('strips prior assistant think blocks from prompt history', () => {
    const prompt = buildConversationPrompt(
      [
        { role: 'user', content: 'What model are you?' },
        { role: 'assistant', content: '<think>private reasoning that must not be replayed</think>\n\nI am Q8.' },
        { role: 'user', content: 'Say it briefly.' }
      ],
      { maxMessages: 20, maxChars: 24000, modelName: 'Qwen3.6-27B-Abliterated-MTP-GGUF:Q8_0' }
    );

    expect(prompt).toContain('Thinking mode is disabled for this response. Do not include chain-of-thought, internal reasoning, analysis headings, planning steps, draft/refine/checklist text, or <think> blocks in your response; provide only the final user-facing answer.');
    expect(prompt).toContain('Assistant: I am Q8.');
    expect(prompt).not.toContain('private reasoning that must not be replayed');
    expect(prompt).not.toContain('<think>private reasoning');
    expect(prompt).not.toContain('</think>');
  });


  it('strips prior assistant untagged analysis from prompt history', () => {
    const prompt = buildConversationPrompt(
      [
        { role: 'user', content: 'Give me the answer.' },
        {
          role: 'assistant',
          content: 'Analysis:\nAnalyze user input and identify key elements.\n\nFinal answer:\nVisible answer.'
        },
        { role: 'user', content: 'Repeat it.' }
      ],
      { maxMessages: 20, maxChars: 24000, modelName: 'qwen3:30b' }
    );

    expect(prompt).toContain('Assistant: Visible answer.');
    expect(prompt).not.toContain('Analyze user input');
    expect(prompt).not.toContain('Final answer:');
  });


  it('adds an explicit thinking-mode instruction when the composer toggle is enabled', () => {
    const prompt = buildConversationPrompt(
      [{ role: 'user', content: 'Think through the tradeoffs, then answer.' }],
      { maxMessages: 20, maxChars: 24000, modelName: 'qwen3:30b', enableThinking: true }
    );

    expect(prompt).toContain('Thinking mode is enabled for this response.');
    expect(prompt).toContain('keep it in a provider reasoning field or a <think> block before the final answer');
  });

  it('preserves user-provided literal think tag examples in prompt history', () => {
    const prompt = buildConversationPrompt(
      [
        { role: 'user', content: 'Explain why this string appears: <think>debug</think>' },
        { role: 'assistant', content: 'It is usually raw model reasoning markup.' }
      ],
      { maxMessages: 20, maxChars: 24000, modelName: 'qwen3:30b' }
    );

    expect(prompt).toContain('User: Explain why this string appears: <think>debug</think>');
  });

});
