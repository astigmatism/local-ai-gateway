import { describe, expect, it } from 'vitest';

process.env.DATABASE_URL ||= 'postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway';
process.env.CONVERSATION_TITLE_GENERATION_ENABLED ||= 'false';

const titleService = () => import('../server/src/services/conversationTitle.js');

describe('conversation title helpers', () => {
  it('sanitizes model title output before saving', async () => {
    const { sanitizeConversationTitle } = await titleService();

    expect(sanitizeConversationTitle('  **"Local AI Gateway UI Fix."**  ')).toBe('Local AI Gateway UI Fix');
    expect(sanitizeConversationTitle('Title: PostgreSQL Setup on Ubuntu.')).toBe('PostgreSQL Setup on Ubuntu');
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
    expect(isGenericConversationTitle('PostgreSQL Setup on Ubuntu')).toBe(false);
  });
});
