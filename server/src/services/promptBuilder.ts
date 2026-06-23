import type { MessageRole } from '@prisma/client';

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

const stripThinkingBlocks = (value: string) =>
  value
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<thinking>[\s\S]*$/gi, '');

const sanitizeMessage = (content: string) => stripThinkingBlocks(content.replace(/\r\n/g, '\n')).trim();

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
    const chunk = `${roleLabel(message.role)}: ${sanitizeMessage(message.content)}`;
    const extraChars = chunk.length + 2;

    if (selected.length > 0 && usedChars + extraChars > options.maxChars) {
      continue;
    }

    if (selected.length === 0 && usedChars + extraChars > options.maxChars) {
      const available = Math.max(200, options.maxChars - usedChars - 20);
      selected.push(`${roleLabel(message.role)}: ${sanitizeMessage(message.content).slice(0, available)}`);
      usedChars = options.maxChars;
      break;
    }

    selected.push(chunk);
    usedChars += extraChars;
  }

  const chronological = selected.reverse();
  return `${header}\n${chronological.join('\n\n')}${footer}`;
};
