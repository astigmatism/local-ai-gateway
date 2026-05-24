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
});
