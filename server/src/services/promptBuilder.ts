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
  enableThinking?: boolean;
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

const thinkingInstruction = (enabled?: boolean) =>
  enabled
    ? 'Thinking mode is enabled for this response. If the model emits reasoning, keep it in a provider reasoning field or a <think> block before the final answer; do not repeat that reasoning in the final answer.'
    : 'Thinking mode is disabled for this response. Do not include chain-of-thought, internal reasoning, analysis text, or <think> blocks in your response.';

export const buildConversationPrompt = (messages: PromptMessage[], options: PromptOptions): string => {
  const newestFirst = messages
    .filter((message) => message.content.trim().length > 0)
    .slice(-options.maxMessages)
    .reverse();

  const header = [
    'You are the assistant in a private local AI gateway application.',
    `The configured local model is ${options.modelName}.`,
    'Answer the latest user message naturally and helpfully.',
    thinkingInstruction(options.enableThinking),
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
