import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { generateWithLlm } from './llmClient.js';
import { resolveOptionalLlmFeatureModel } from './modelSettingsService.js';
import { sanitizeThinkingBlocks } from './thinkingBlocks.js';

const genericConversationTitles = new Set([
  'new conversation',
  'untitled conversation',
  'untitled',
  'conversation',
  'new chat'
]);

const modelChatterTitlePatterns = [
  /^sure\b/i,
  /^here(?:'s| is)\b.*\btitle\b/i,
  /^the\s+title\s+is\b/i,
  /^a\s+(?:good|concise|short)\s+title\b/i,
  /^i\s+(?:would|would\s+suggest|suggest)\s+(?:title|calling)\b/i
];

export interface ConversationTitleResult {
  title: string;
  generated: boolean;
  fallbackUsed: boolean;
  reason?: 'disabled' | 'empty_prompt' | 'model_unavailable' | 'empty_model_response' | 'invalid_model_response' | 'llm_failed';
  model?: string;
}

export interface ConversationTitleEligibilityInput {
  title: string | null | undefined;
  messageCount: number;
  firstUserPrompt?: string | null;
  titleGenerationEnabled?: boolean;
}

const normalizeTitleForComparison = (title: string) => title.replace(/\s+/g, ' ').trim().toLowerCase();

export const isGenericConversationTitle = (title: string | null | undefined) => {
  const normalized = normalizeTitleForComparison(title ?? '');
  return !normalized || genericConversationTitles.has(normalized);
};

export const isPlaceholderConversationTitle = (
  title: string | null | undefined,
  firstUserPrompt?: string | null
) => {
  if (isGenericConversationTitle(title)) return true;
  if (!title || !firstUserPrompt?.trim()) return false;

  const normalizedTitle = normalizeTitleForComparison(title);
  const fallbackTitle = normalizeTitleForComparison(makeFallbackConversationTitle(firstUserPrompt));
  return normalizedTitle === fallbackTitle;
};

export const conversationNeedsGeneratedTitle = ({
  title,
  messageCount,
  firstUserPrompt,
  titleGenerationEnabled = config.conversationTitle.enabled
}: ConversationTitleEligibilityInput) => {
  if (!titleGenerationEnabled) return false;
  if (messageCount > 2) return false;
  return isPlaceholderConversationTitle(title, firstUserPrompt);
};

export const buildConversationTitlePrompt = (firstUserPrompt: string, firstAssistantResponse?: string | null) => {
  const trimmedAssistantResponse = firstAssistantResponse
    ? sanitizeThinkingBlocks(firstAssistantResponse, { trim: true }).content
    : undefined;

  return [
    'You create concise titles for AI chat conversations.',
    '',
    "Given the user's first message and, if available, the assistant's first response, create a short, descriptive title for the conversation.",
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
    firstUserPrompt,
    '',
    'Assistant response:',
    trimmedAssistantResponse || '(not available)'
  ].join('\n');
};

const unwrapAccidentalFence = (value: string) => {
  const trimmed = sanitizeThinkingBlocks(value, { trim: true }).content;
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

const isModelChatterTitle = (title: string) => modelChatterTitlePatterns.some((pattern) => pattern.test(title));

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

  if (!title || isModelChatterTitle(title)) return '';

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

export const generateConversationTitle = async (
  firstUserPrompt: string,
  firstAssistantResponse?: string | null
): Promise<ConversationTitleResult> => {
  const trimmedPrompt = firstUserPrompt.trim();
  const sanitizedAssistantResponse = firstAssistantResponse
    ? sanitizeThinkingBlocks(firstAssistantResponse, { trim: true }).content
    : undefined;
  const trimmedAssistantResponse = sanitizedAssistantResponse?.trim();
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
  const assistantInput = trimmedAssistantResponse?.slice(0, config.conversationTitle.maxPromptChars);

  let model: string | undefined;
  try {
    model = await resolveOptionalLlmFeatureModel(config.conversationTitle.model);
    if (!model) {
      logger.warn(
        {
          promptLength: trimmedPrompt.length,
          assistantResponseLength: trimmedAssistantResponse?.length ?? 0,
          maxPromptChars: config.conversationTitle.maxPromptChars
        },
        'Conversation title generation unavailable because no LLM model could be resolved; using fallback title'
      );

      return {
        title: fallbackTitle,
        generated: false,
        fallbackUsed: true,
        reason: 'model_unavailable'
      };
    }

    const result = await generateWithLlm(buildConversationTitlePrompt(promptInput, assistantInput), {
      model,
      timeoutMs: config.conversationTitle.timeoutMs
    });
    const title = sanitizeConversationTitle(result.content);

    if (!title) {
      return {
        title: fallbackTitle,
        generated: false,
        fallbackUsed: true,
        reason: result.content.trim() ? 'invalid_model_response' : 'empty_model_response',
        model
      };
    }

    return {
      title,
      generated: true,
      fallbackUsed: false,
      model
    };
  } catch (error) {
    logger.warn(
      {
        errorMessage: error instanceof Error ? error.message : 'Unknown title generation error',
        model,
        promptLength: trimmedPrompt.length,
        assistantResponseLength: trimmedAssistantResponse?.length ?? 0,
        maxPromptChars: config.conversationTitle.maxPromptChars
      },
      'Conversation title generation failed; using fallback title'
    );

    return {
      title: fallbackTitle,
      generated: false,
      fallbackUsed: true,
      reason: 'llm_failed',
      model
    };
  }
};
