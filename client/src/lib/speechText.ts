import { sanitizeThinkingBlocks } from './thinkingBlocks.js';

export const normalizeTextForSpeech = (content: string) => {
  const visibleContent = sanitizeThinkingBlocks(content, { trim: true, extractUntaggedReasoning: true }).content;
  const withoutFences = visibleContent.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_match, code: string) => `\n${code.trim()}\n`);

  return withoutFences
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, '')
    .replace(/^[ \t]*[-:|]{3,}[ \t]*$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,!?;:])/g, '$1$2')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
