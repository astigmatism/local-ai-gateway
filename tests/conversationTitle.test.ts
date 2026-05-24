import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway';
process.env.CONVERSATION_TITLE_GENERATION_ENABLED ||= 'false';

const titleService = () => import('../server/src/services/conversationTitle.js');

describe('conversation title helpers', () => {
  it('sanitizes model title output before saving', async () => {
    const { sanitizeConversationTitle } = await titleService();

    expect(sanitizeConversationTitle('  **"Local AI Gateway UI Fix."**  ')).toBe('Local AI Gateway UI Fix');
    expect(sanitizeConversationTitle('Title: PostgreSQL Setup on Ubuntu.')).toBe('PostgreSQL Setup on Ubuntu');
    expect(sanitizeConversationTitle('<think>private reasoning</think>GPU Health Dashboard Layout')).toBe(
      'GPU Health Dashboard Layout'
    );
  });

  it('rejects obvious model chatter so callers can use the fallback title', async () => {
    const { sanitizeConversationTitle } = await titleService();

    expect(sanitizeConversationTitle('Sure, here is a title: Local AI Gateway UI Fix')).toBe('');
    expect(sanitizeConversationTitle('The title is Local AI Gateway UI Fix')).toBe('');
  });

  it('creates bounded fallback titles from a first prompt', async () => {
    const { makeFallbackConversationTitle } = await titleService();

    expect(
      makeFallbackConversationTitle(
        'Please help me debug the optimistic chat transaction in my Bear Castle AI React app',
        48
      )
    ).toBe('Please help me debug the optimistic chat');
  });

  it('detects generic titles that should be replaced', async () => {
    const { isGenericConversationTitle } = await titleService();

    expect(isGenericConversationTitle('New conversation')).toBe(true);
    expect(isGenericConversationTitle('Untitled Conversation')).toBe(true);
    expect(isGenericConversationTitle('Conversation')).toBe(true);
    expect(isGenericConversationTitle('PostgreSQL Setup on Ubuntu')).toBe(false);
  });

  it('detects first-prompt fallback titles as placeholders for first exchanges', async () => {
    const { conversationNeedsGeneratedTitle, makeFallbackConversationTitle } = await titleService();
    const prompt = 'Explain how to configure PostgreSQL backups on Ubuntu';

    expect(
      conversationNeedsGeneratedTitle({
        title: makeFallbackConversationTitle(prompt),
        messageCount: 2,
        firstUserPrompt: prompt,
        titleGenerationEnabled: true
      })
    ).toBe(true);
    expect(
      conversationNeedsGeneratedTitle({
        title: 'PostgreSQL Backup Strategy',
        messageCount: 2,
        firstUserPrompt: prompt,
        titleGenerationEnabled: true
      })
    ).toBe(false);
    expect(
      conversationNeedsGeneratedTitle({
        title: 'New conversation',
        messageCount: 3,
        firstUserPrompt: prompt,
        titleGenerationEnabled: true
      })
    ).toBe(false);
  });

  it('includes the assistant response when building the deferred title prompt', async () => {
    const { buildConversationTitlePrompt } = await titleService();

    const prompt = buildConversationTitlePrompt('How do I tune React rendering?', 'Use memoization carefully.');

    expect(prompt).toContain('User message:\nHow do I tune React rendering?');
    expect(prompt).toContain('Assistant response:\nUse memoization carefully.');
  });
});
