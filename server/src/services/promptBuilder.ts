import type { MessageRole } from '@prisma/client';
import { sanitizeThinkingBlocks } from './thinkingBlocks.js';

export interface PromptMessage {
  role: MessageRole;
  content: string;
}

export interface PromptOptions {
  maxMessages: number;
  maxChars: number;
  modelName: string;
}

const roleLabel = (role: MessageRole) => {
  switch (role) {
    case 'assistant':
      return 'Assistant';
    case 'system':
      return 'System';
    case 'user':
    default:
      return 'User';
  }
};

const sanitizeMessage = (message: PromptMessage) => {
  const normalizedContent = message.content.replace(/\r\n/g, '\n');
  if (message.role !== 'assistant') return normalizedContent.trim();
  return sanitizeThinkingBlocks(normalizedContent, { trim: true }).content;
};

export const buildConversationPrompt = (messages: PromptMessage[], options: PromptOptions): string => {
  const newestFirst = messages
    .filter((message) => message.content.trim().length > 0)
    .slice(-options.maxMessages)
    .reverse();

  const header = [
    'You are the assistant in a private local AI gateway application.',
    `The configured local model is ${options.modelName}.`,
    'Answer the latest user message naturally and helpfully.',
    'Do not include chain-of-thought, internal reasoning, or <think> blocks in your response.',
    'Use the recent conversation only as context. Do not invent system capabilities.',
    '',
    'Recent conversation:'
  ].join('\n');

  const footer = '\n\nAssistant:';
  const selected: string[] = [];
  let usedChars = header.length + footer.length;

  for (const message of newestFirst) {
    const sanitizedContent = sanitizeMessage(message);
    if (sanitizedContent.length === 0) continue;

    const chunk = `${roleLabel(message.role)}: ${sanitizedContent}`;
    const extraChars = chunk.length + 2;

    if (selected.length > 0 && usedChars + extraChars > options.maxChars) {
      continue;
    }

    if (selected.length === 0 && usedChars + extraChars > options.maxChars) {
      const available = Math.max(200, options.maxChars - usedChars - 20);
      selected.push(`${roleLabel(message.role)}: ${sanitizedContent.slice(0, available)}`);
      usedChars = options.maxChars;
      break;
    }

    selected.push(chunk);
    usedChars += extraChars;
  }

  const chronological = selected.reverse();
  return `${header}\n${chronological.join('\n\n')}${footer}`;
};
