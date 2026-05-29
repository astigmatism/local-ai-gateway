import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readProjectFile = (relativePath: string) => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

describe('chat message viewport behavior', () => {
  it('does not auto-scroll the message thread when message content changes', () => {
    const source = readProjectFile('client/src/components/MessageThread.tsx');

    expect(source).not.toContain('bottomRef');
    expect(source).not.toMatch(/scrollIntoView|scrollTop|scrollTo\(|scrollHeight/);
  });
});

describe('chat message horizontal overflow behavior', () => {
  it('renders Markdown tables inside a horizontal scroll container', () => {
    const source = readProjectFile('client/src/components/MarkdownMessageContent.tsx');

    expect(source).toContain('markdown-scroll-container markdown-table-scroll');
    expect(source).toContain('aria-label="Scrollable table"');
    expect(source).toContain('tabIndex={0}');
  });

  it('keeps Markdown, tables, and code blocks horizontally scrollable', () => {
    const css = readProjectFile('client/src/styles/app.css');

    expect(css).toMatch(/\.markdown-content\s*\{[\s\S]*overflow-x:\s*auto;[\s\S]*-webkit-overflow-scrolling:\s*touch;/);
    expect(css).toMatch(/\.markdown-content\s+\.markdown-scroll-container\s*\{[\s\S]*overflow-x:\s*auto;/);
    expect(css).toMatch(/\.markdown-content\s+pre\s*\{[\s\S]*overflow-x:\s*auto;/);
    expect(css).toMatch(/\.mobile-chat-panel\s+\.markdown-content,[\s\S]*overflow-x:\s*auto;/);
  });
});
