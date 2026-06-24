import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');

describe('chat message scroll behavior', () => {
  it('does not auto-scroll the message thread when streaming message content updates', () => {
    const source = readSource('client/src/components/MessageThread.tsx');

    expect(source).not.toMatch(/scrollIntoView|scrollTop\s*=|bottomRef|lastMessageContentLength|requestAnimationFrame/);
    expect(source).toContain('getPromptStartSnapKey(conversation?.messages ?? [])');
    expect(source).toContain('}, [promptStartSnapKey]);');
  });

  it('keeps the only automatic scroll constrained to the initial prompt-start message pair', () => {
    const source = readSource('client/src/components/MessageThread.tsx');

    expect(source).toContain("const promptStartStatuses: DeliveryStatus[] = ['thinking', 'streaming', 'imageGenerating'];");
    expect(source).toContain("if (userMessage.role !== 'user' || assistantMessage.role !== 'assistant') return null;");
    expect(source).toContain('if (!isOptimisticMessage(userMessage) || !isOptimisticMessage(assistantMessage)) return null;');
    expect(source).toContain('if (!userSubmittedAt || userSubmittedAt !== assistantSubmittedAt) return null;');
    expect(source).toContain('return userSubmittedAt;');
    expect(source).toContain("thread.scrollTo({ top: thread.scrollHeight, behavior: 'auto' });");
  });
});

describe('chat message overflow handling', () => {
  it('wraps markdown tables in a horizontally scrollable region', () => {
    const source = readSource('client/src/components/MarkdownMessageContent.tsx');

    expect(source).toContain('className="markdown-table-scroll"');
    expect(source).toContain('aria-label="Scrollable table"');
    expect(source).toContain('tabIndex={0}');
  });

  it('keeps wide message content, tables, and preformatted blocks horizontally accessible', () => {
    const styles = readSource('client/src/styles/app.css');

    expect(styles).toMatch(/\.message-content\s*\{[\s\S]*overflow-x:\s*auto;/);
    expect(styles).toMatch(/\.markdown-content pre\s*\{[\s\S]*overflow-x:\s*auto;/);
    expect(styles).toMatch(/\.markdown-table-scroll\s*\{[\s\S]*overflow-x:\s*auto;/);
    expect(styles).toMatch(/\.mobile-chat-panel \.markdown-table-scroll\s*\{[\s\S]*overflow-x:\s*auto;/);
  });
});


describe('chat reasoning visibility surfaces', () => {
  it('sanitizes assistant display, copy, and speech content at the message component boundary', () => {
    const source = readSource('client/src/components/MessageThread.tsx');

    expect(source).toContain("import { sanitizeThinkingBlocks } from '../lib/thinkingBlocks.js';");
    expect(source).toContain('const visibleMessageContent = (message: Message) =>');
    expect(source).toContain('const copyContent = (message: Message) => generatedImageMetadata(message)?.image.prompt ?? visibleMessageContent(message);');
    expect(source).toContain('onSpeak={() => onSpeakMessage(message.id, visibleMessageContent(message))}');
    expect(source).toContain('<MarkdownMessageContent content={visibleContent} />');
  });

  it('does not render captured thinking metadata unless thinking display was explicitly enabled', () => {
    const source = readSource('client/src/components/MessageThread.tsx');

    expect(source).toContain("const messageThinkingEnabled = (message: Message) => messageMetadataRecord(message)?.thinkingEnabled === true;");
    expect(source).toContain("const shouldRender = message.role === 'assistant' && messageThinkingEnabled(message) && (content.length > 0 || isActive);");
  });
});
