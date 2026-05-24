import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { generateWithLlm } from './llmClient.js';

const genericConversationTitles = new Set([
  'new conversation',
  'untitled conversation',
  'untitled',
  'new chat'
]);

export interface ConversationTitleResult {
  title: string;
  generated: boolean;
  fallbackUsed: boolean;
  reason?: 'disabled' | 'empty_prompt' | 'empty_model_response' | 'llm_failed';
  model?: string;
}

export const isGenericConversationTitle = (title: string | null | undefined) => {
  const normalized = title?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
  return !normalized || genericConversationTitles.has(normalized);
};

export const buildConversationTitlePrompt = (firstUserPrompt: string) =>
  [
    'You create concise titles for AI chat conversations.',
    '',
    "Given the user's first message, create a short, descriptive title for the conversation.",
    '',
    'Rules:',
    '- Return only the title.',
    '- Do not include quotation marks.',
    '- Do not include Markdown.',
    '- Do not include a period at the end.',
    '- Keep it under 8 words if possible.',
    '- Use Title Case unless another style is clearly better.',
    '- Preserve important names, products, technologies, or proper nouns.',
    "- Do not answer the user's question.",
    '- Do not explain your reasoning.',
    '',
    'Examples:',
    '- NVIDIA History 1993 to 2000',
    '- Local AI Gateway UI Fix',
    '- PostgreSQL Setup on Ubuntu',
    '- Voice Transcription Formatting Issue',
    '- GPU Health Dashboard Layout',
    '',
    'User message:',
    firstUserPrompt
  ].join('\n');

const unwrapAccidentalFence = (value: string) => {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```(?:text|txt|title|markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return fenceMatch?.[1]?.trim() ?? trimmed;
};

const stripSurroundingQuotes = (value: string) => {
  let title = value.trim();
  let changed = true;

  while (changed && title.length >= 2) {
    changed = false;

    const first = title.at(0);
    const last = title.at(-1);
    const quoted =
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === '`' && last === '`') ||
      (first === '\u201c' && last === '\u201d') ||
      (first === '\u2018' && last === '\u2019');

    if (quoted) {
      title = title.slice(1, -1).trim();
      changed = true;
    }
  }

  return title;
};

const trimTitleToMaxLength = (title: string, maxLength: number) => {
  if (title.length <= maxLength) return title;

  return title
    .slice(0, maxLength)
    .replace(/\s+\S*$/, '')
    .replace(/[\s,;:!?.-]+$/g, '')
    .trim();
};

export const sanitizeConversationTitle = (rawTitle: string, maxLength = config.conversationTitle.maxLength) => {
  let title = unwrapAccidentalFence(rawTitle)
    .replace(/^\s*(?:conversation\s+title|title)\s*:\s*/i, '')
    .replace(/^\s{0,3}#{1,6}\s+/u, '')
    .replace(/^\s*[-*]\s+/u, '')
    .replace(/^[*_~`]+|[*_~`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  title = stripSurroundingQuotes(title)
    .replace(/^[*_~`]+|[*_~`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (title.endsWith('.') && !title.endsWith('...')) {
    title = title.slice(0, -1).trim();
  }

  title = trimTitleToMaxLength(title, maxLength);
  title = stripSurroundingQuotes(title).trim();

  return title;
};

export const makeFallbackConversationTitle = (
  firstUserPrompt: string,
  maxLength = config.conversationTitle.maxLength
) => {
  const compact = firstUserPrompt.replace(/\s+/g, ' ').trim();
  if (!compact) return 'New Conversation';

  const fallbackMaxLength = Math.min(maxLength, 60);
  const words = compact.split(' ').filter(Boolean);
  let title = words.slice(0, 10).join(' ');

  while (title.length > fallbackMaxLength && words.length > 1) {
    words.pop();
    title = words.slice(0, 10).join(' ');
  }

  if (title.length > fallbackMaxLength) {
    title = trimTitleToMaxLength(compact, fallbackMaxLength);
  }

  return sanitizeConversationTitle(title, maxLength) || 'New Conversation';
};

export const generateConversationTitle = async (firstUserPrompt: string): Promise<ConversationTitleResult> => {
  const trimmedPrompt = firstUserPrompt.trim();
  const fallbackTitle = makeFallbackConversationTitle(trimmedPrompt);

  if (!trimmedPrompt) {
    return {
      title: fallbackTitle,
      generated: false,
      fallbackUsed: true,
      reason: 'empty_prompt'
    };
  }

  if (!config.conversationTitle.enabled) {
    return {
      title: fallbackTitle,
      generated: false,
      fallbackUsed: true,
      reason: 'disabled'
    };
  }

  const promptInput = trimmedPrompt.slice(0, config.conversationTitle.maxPromptChars);

  try {
    const result = await generateWithLlm(buildConversationTitlePrompt(promptInput), {
      model: config.conversationTitle.model,
      timeoutMs: config.conversationTitle.timeoutMs
    });
    const title = sanitizeConversationTitle(result.content);

    if (!title) {
      return {
        title: fallbackTitle,
        generated: false,
        fallbackUsed: true,
        reason: 'empty_model_response',
        model: config.conversationTitle.model
      };
    }

    return {
      title,
      generated: true,
      fallbackUsed: false,
      model: config.conversationTitle.model
    };
  } catch (error) {
    logger.warn(
      {
        errorMessage: error instanceof Error ? error.message : 'Unknown title generation error',
        model: config.conversationTitle.model,
        promptLength: trimmedPrompt.length,
        maxPromptChars: config.conversationTitle.maxPromptChars
      },
      'Conversation title generation failed; using fallback title'
    );

    return {
      title: fallbackTitle,
      generated: false,
      fallbackUsed: true,
      reason: 'llm_failed',
      model: config.conversationTitle.model
    };
  }
};
