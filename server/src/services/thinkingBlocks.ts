export interface ThinkingBlockMetadata {
  hasThinkingBlock: boolean;
  suppressedThinkingBlock: boolean;
  hasUntaggedReasoning?: boolean;
  suppressedUntaggedReasoning?: boolean;
}

export interface ThinkingBlockFilterResult extends ThinkingBlockMetadata {
  delta: string;
}

export interface ThinkingBlockExtractionResult extends ThinkingBlockMetadata {
  delta: string;
  contentDelta: string;
  thinkingDelta: string;
}

export interface ThinkingBlockExtractorOptions {
  assumeLeadingThinking?: boolean;
  extractUntaggedReasoning?: boolean;
  maxUntaggedReasoningPreambleChars?: number;
}

export interface SanitizeThinkingBlocksOptions extends ThinkingBlockExtractorOptions {
  trim?: boolean;
}

type UntaggedReasoningMode = 'undecided' | 'reasoning' | 'passthrough' | 'done';
type UntaggedReasoningClassification = 'reasoning' | 'possible' | 'not-reasoning';

const thinkingTagNames = ['think', 'thinking'];
const thinkingOpenTokenMarkers = ['<|begin_of_thought|>', '<|start_of_thought|>', '<|begin▁of▁thought|>'];
const thinkingCloseTokenMarkers = ['<|end_of_thought|>', '<|stop_of_thought|>', '<|end▁of▁thought|>'];
const reasoningHeadingNames = [
  'analysis',
  'reasoning',
  'thinking',
  'thought process',
  'chain of thought',
  'chain-of-thought',
  'scratchpad',
  'internal analysis',
  'internal reasoning',
  'model analysis',
  'assistant analysis'
];
const finalMarkerNames = [
  'final',
  'final answer',
  'final response',
  'final output',
  'final result',
  'answer',
  'response',
  'result',
  'user-facing response',
  'user facing response',
  'output'
];
const leakedReasoningPhrasePatterns = [
  /analy[sz]e\s+(?:the\s+)?user\s+input/i,
  /identify\s+key\s+elements/i,
  /determine\s+best\s+practices/i,
  /check\s+against\s+constraints/i,
  /final\s+output\s+generation/i,
  /draft\s+(?:the\s+)?(?:response|answer|output)/i,
  /refine\s+(?:the\s+)?(?:response|answer|output|draft)/i
];

const escapeRegExp = (value: string) => value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
const normalizeWhitespaceForPattern = (value: string) => value.replace(/[\s_-]+/g, '[\\s_-]+');

const thinkingOpenTagPattern = new RegExp(
  '<\\s*(?:' + thinkingTagNames.join('|') + ')\\b[^>]*>|' + thinkingOpenTokenMarkers.map(escapeRegExp).join('|'),
  'i'
);
const thinkingCloseTagPattern = new RegExp(
  '<\\s*\\/\\s*(?:' + thinkingTagNames.join('|') + ')\\s*>|' + thinkingCloseTokenMarkers.map(escapeRegExp).join('|'),
  'i'
);
const reasoningHeadingPattern = new RegExp(
  '^(?:[\\s>\\-*#_]+)?(?:#{1,6}\\s*)?(?:' +
    reasoningHeadingNames.map((heading) => normalizeWhitespaceForPattern(escapeRegExp(heading))).join('|') +
    ')(?:\\s*:|\\s*[\\r\\n]|\\s*$)',
  'i'
);
const finalMarkerColonPattern = new RegExp(
  '(?:^|\\n)[ \\t>\\-*]*(?:#{1,6}\\s*)?(?:' +
    finalMarkerNames.map((marker) => normalizeWhitespaceForPattern(escapeRegExp(marker))).join('|') +
    ')\\s*:\\s*',
  'gi'
);
const finalMarkerLinePattern = new RegExp(
  '(?:^|\\n)[ \\t>\\-*]*(?:#{1,6}\\s*)?(?:' +
    finalMarkerNames.map((marker) => normalizeWhitespaceForPattern(escapeRegExp(marker))).join('|') +
    ')\\s*(?:\\r?\\n|$)',
  'gi'
);

interface UntaggedReasoningSplit {
  content: string;
  thinking: string;
}

const findPattern = (value: string, pattern: RegExp) => {
  const match = pattern.exec(value);
  if (!match) return null;
  const [text] = match;
  return { index: match.index, text };
};

const matchesTokenPrefix = (fragment: string, markers: string[]) => {
  const normalizedFragment = fragment.toLowerCase();
  return markers.some((marker) => marker.toLowerCase().startsWith(normalizedFragment));
};

const isPotentialOpenTagPrefix = (fragment: string) => {
  if (!fragment.startsWith('<') || fragment.includes('>')) return false;
  if (matchesTokenPrefix(fragment, thinkingOpenTokenMarkers)) return true;

  const tagPrefix = fragment.slice(1).trimStart().toLowerCase();
  if (tagPrefix.startsWith('/')) return false;
  if (tagPrefix.length === 0) return true;

  return thinkingTagNames.some(
    (tagName) => tagName.startsWith(tagPrefix) || tagPrefix.startsWith(tagName + ' ') || tagPrefix === tagName
  );
};

const isPotentialCloseTagPrefix = (fragment: string) => {
  if (!fragment.startsWith('<') || fragment.includes('>')) return false;
  if (matchesTokenPrefix(fragment, thinkingCloseTokenMarkers)) return true;

  const afterOpeningBracket = fragment.slice(1).trimStart().toLowerCase();
  if (afterOpeningBracket.length === 0) return true;
  if (!afterOpeningBracket.startsWith('/')) return false;

  const tagPrefix = afterOpeningBracket.slice(1).trimStart();
  if (tagPrefix.length === 0) return true;

  return thinkingTagNames.some((tagName) => tagName.startsWith(tagPrefix) || tagPrefix === tagName);
};

const trailingPotentialTagStart = (value: string, predicate: (fragment: string) => boolean) => {
  const lastOpenBracket = value.lastIndexOf('<');
  if (lastOpenBracket === -1) return -1;

  const fragment = value.slice(lastOpenBracket);
  return predicate(fragment) ? lastOpenBracket : -1;
};

const trailingPotentialThinkingTagStart = (value: string) => {
  const openTagStart = trailingPotentialTagStart(value, isPotentialOpenTagPrefix);
  const closeTagStart = trailingPotentialTagStart(value, isPotentialCloseTagPrefix);

  if (openTagStart === -1) return closeTagStart;
  if (closeTagStart === -1) return openTagStart;
  return Math.min(openTagStart, closeTagStart);
};

const leakedReasoningPhraseScore = (value: string) =>
  leakedReasoningPhrasePatterns.reduce((score, pattern) => score + (pattern.test(value) ? 1 : 0), 0);

const firstMeaningfulLine = (value: string) => value.trimStart().split(/\r?\n/, 1)[0]?.trim().replace(/^#{1,6}\s*/, '') ?? '';

const isPotentialReasoningHeadingPrefix = (value: string) => {
  const firstLine = firstMeaningfulLine(value).toLowerCase();
  if (firstLine.length < 3 || firstLine.length > 28) return false;
  if (/\s/.test(firstLine) && !reasoningHeadingNames.some((heading) => heading.startsWith(firstLine))) return false;
  return reasoningHeadingNames.some((heading) => heading.startsWith(firstLine));
};

const looksLikeReasoningPreamble = (value: string) => {
  const preamble = value.trimStart().slice(0, 1600);
  if (preamble.length === 0) return false;
  if (reasoningHeadingPattern.test(preamble)) return true;
  return leakedReasoningPhraseScore(preamble) >= 2;
};

const classifyUntaggedReasoningBuffer = (value: string): UntaggedReasoningClassification => {
  const preamble = value.trimStart().slice(0, 1600);
  if (preamble.length === 0) return 'possible';
  if (looksLikeReasoningPreamble(preamble)) return 'reasoning';
  if (isPotentialReasoningHeadingPrefix(preamble)) return 'possible';
  if (/^\d+[).]\s*(?:analy[sz]e|identify|determine|draft|refine|check)\b/i.test(preamble)) return 'possible';
  return 'not-reasoning';
};

const findFirstFinalMarker = (value: string) => {
  finalMarkerColonPattern.lastIndex = 0;
  finalMarkerLinePattern.lastIndex = 0;
  const colonMatch = finalMarkerColonPattern.exec(value);
  const lineMatch = finalMarkerLinePattern.exec(value);

  if (!colonMatch && !lineMatch) return null;
  if (!colonMatch) return { index: lineMatch!.index, text: lineMatch![0] };
  if (!lineMatch) return { index: colonMatch.index, text: colonMatch[0] };
  return colonMatch.index <= lineMatch.index
    ? { index: colonMatch.index, text: colonMatch[0] }
    : { index: lineMatch.index, text: lineMatch[0] };
};

const splitUntaggedReasoning = (value: string): UntaggedReasoningSplit | null => {
  if (!looksLikeReasoningPreamble(value)) return null;

  const marker = findFirstFinalMarker(value);
  if (!marker) return null;

  const thinking = value.slice(0, marker.index);
  const content = value.slice(marker.index + marker.text.length);
  return { thinking, content };
};

const fallbackSplitUntaggedReasoning = (value: string): UntaggedReasoningSplit | null => {
  if (!looksLikeReasoningPreamble(value)) return null;

  const normalized = value.replace(/\r\n/g, '\n');
  const paragraphBreaks = Array.from(normalized.matchAll(/\n{2,}/g));
  const lastBreak = paragraphBreaks.at(-1);
  if (!lastBreak || lastBreak.index === undefined) return null;

  const breakEnd = lastBreak.index + lastBreak[0].length;
  const thinking = normalized.slice(0, lastBreak.index);
  const content = normalized.slice(breakEnd);
  if (thinking.trim().length === 0 || content.trim().length === 0) return null;

  return { thinking, content };
};

export class ThinkingBlockExtractor {
  private pending = '';

  private insideThinkingBlock = false;

  private hasThinkingBlockValue = false;

  private suppressedThinkingBlockValue = false;

  private hasUntaggedReasoningValue = false;

  private suppressedUntaggedReasoningValue = false;

  private hasEmittedContentValue = false;

  private leadingThinkingCandidate: boolean;

  private readonly extractUntaggedReasoning: boolean;

  private readonly maxUntaggedReasoningPreambleChars: number;

  private untaggedReasoningMode: UntaggedReasoningMode = 'undecided';

  private untaggedReasoningBuffer = '';

  constructor(options: ThinkingBlockExtractorOptions = {}) {
    this.leadingThinkingCandidate = options.assumeLeadingThinking === true;
    this.extractUntaggedReasoning = options.extractUntaggedReasoning === true;
    this.maxUntaggedReasoningPreambleChars = options.maxUntaggedReasoningPreambleChars ?? 2400;
  }

  feed(input: string): ThinkingBlockExtractionResult {
    let text = this.pending + input;
    this.pending = '';
    let contentDelta = '';
    let thinkingDelta = '';

    const appendContent = (value: string) => {
      if (value.length === 0) return;
      contentDelta += value;
      this.hasEmittedContentValue = true;
      this.leadingThinkingCandidate = false;
    };

    const appendThinking = (value: string) => {
      if (value.length === 0) return;
      thinkingDelta += value;
      this.suppressedThinkingBlockValue = true;
    };

    while (text.length > 0) {
      if (this.insideThinkingBlock) {
        const closeTag = findPattern(text, thinkingCloseTagPattern);

        if (!closeTag) {
          const keepFrom = trailingPotentialTagStart(text, isPotentialCloseTagPrefix);
          appendThinking(keepFrom === -1 ? text : text.slice(0, keepFrom));
          this.pending = keepFrom === -1 ? '' : text.slice(keepFrom);
          break;
        }

        appendThinking(text.slice(0, closeTag.index));
        this.suppressedThinkingBlockValue = true;
        text = text.slice(closeTag.index + closeTag.text.length);
        this.insideThinkingBlock = false;
        continue;
      }

      if (this.leadingThinkingCandidate && !this.hasEmittedContentValue) {
        const openTag = findPattern(text, thinkingOpenTagPattern);
        const closeTag = findPattern(text, thinkingCloseTagPattern);

        if (openTag && (!closeTag || openTag.index <= closeTag.index)) {
          appendContent(text.slice(0, openTag.index));
          text = text.slice(openTag.index + openTag.text.length);
          this.hasThinkingBlockValue = true;
          this.suppressedThinkingBlockValue = true;
          this.insideThinkingBlock = true;
          continue;
        }

        if (closeTag) {
          appendThinking(text.slice(0, closeTag.index));
          this.hasThinkingBlockValue = true;
          this.suppressedThinkingBlockValue = true;
          text = text.slice(closeTag.index + closeTag.text.length);
          this.leadingThinkingCandidate = false;
          continue;
        }

        this.pending = text;
        break;
      }

      const openTag = findPattern(text, thinkingOpenTagPattern);
      const leadingCloseTag = !this.hasEmittedContentValue && contentDelta.trim().length === 0
        ? findPattern(text, thinkingCloseTagPattern)
        : null;

      if (leadingCloseTag && (!openTag || leadingCloseTag.index < openTag.index)) {
        appendThinking(text.slice(0, leadingCloseTag.index));
        this.hasThinkingBlockValue = true;
        this.suppressedThinkingBlockValue = true;
        text = text.slice(leadingCloseTag.index + leadingCloseTag.text.length);
        continue;
      }

      if (!openTag) {
        const keepFrom = trailingPotentialThinkingTagStart(text);
        if (keepFrom === -1) {
          appendContent(text);
        } else {
          appendContent(text.slice(0, keepFrom));
          this.pending = text.slice(keepFrom);
        }
        break;
      }

      appendContent(text.slice(0, openTag.index));
      text = text.slice(openTag.index + openTag.text.length);
      this.hasThinkingBlockValue = true;
      this.suppressedThinkingBlockValue = true;
      this.insideThinkingBlock = true;
    }

    const untagged = this.filterUntaggedReasoning(contentDelta);
    return this.snapshot(untagged.contentDelta, thinkingDelta + untagged.thinkingDelta);
  }

  flush(): ThinkingBlockExtractionResult {
    let contentDelta = '';
    let thinkingDelta = '';

    if (this.insideThinkingBlock) {
      if (this.pending.length > 0) {
        thinkingDelta = this.pending;
        this.suppressedThinkingBlockValue = true;
      }
      this.hasThinkingBlockValue = true;
    } else if (this.leadingThinkingCandidate && !this.hasThinkingBlockValue) {
      contentDelta = this.pending;
      if (contentDelta.length > 0) this.hasEmittedContentValue = true;
    } else if (isPotentialOpenTagPrefix(this.pending) || (!this.hasEmittedContentValue && isPotentialCloseTagPrefix(this.pending))) {
      this.hasThinkingBlockValue = true;
      this.suppressedThinkingBlockValue = true;
    } else {
      contentDelta = this.pending;
    }

    this.pending = '';
    this.leadingThinkingCandidate = false;

    const untaggedFromContent = this.filterUntaggedReasoning(contentDelta);
    const untaggedFromBuffer = this.flushUntaggedReasoning();

    return this.snapshot(
      untaggedFromContent.contentDelta + untaggedFromBuffer.contentDelta,
      thinkingDelta + untaggedFromContent.thinkingDelta + untaggedFromBuffer.thinkingDelta
    );
  }

  private filterUntaggedReasoning(contentDelta: string): { contentDelta: string; thinkingDelta: string } {
    if (!this.extractUntaggedReasoning || contentDelta.length === 0) return { contentDelta, thinkingDelta: '' };
    if (this.untaggedReasoningMode === 'passthrough' || this.untaggedReasoningMode === 'done') {
      return { contentDelta, thinkingDelta: '' };
    }

    this.untaggedReasoningBuffer += contentDelta;

    const split = splitUntaggedReasoning(this.untaggedReasoningBuffer);
    if (split) {
      this.markUntaggedReasoningSuppressed();
      this.untaggedReasoningMode = 'done';
      this.untaggedReasoningBuffer = '';
      return { contentDelta: split.content, thinkingDelta: split.thinking };
    }

    const classification = classifyUntaggedReasoningBuffer(this.untaggedReasoningBuffer);
    if (this.untaggedReasoningMode === 'reasoning' || classification === 'reasoning') {
      this.untaggedReasoningMode = 'reasoning';
      return { contentDelta: '', thinkingDelta: '' };
    }

    if (
      classification === 'possible' &&
      this.untaggedReasoningBuffer.length <= this.maxUntaggedReasoningPreambleChars
    ) {
      return { contentDelta: '', thinkingDelta: '' };
    }

    this.untaggedReasoningMode = 'passthrough';
    const visible = this.untaggedReasoningBuffer;
    this.untaggedReasoningBuffer = '';
    return { contentDelta: visible, thinkingDelta: '' };
  }

  private flushUntaggedReasoning(): { contentDelta: string; thinkingDelta: string } {
    if (!this.extractUntaggedReasoning || this.untaggedReasoningBuffer.length === 0) {
      this.untaggedReasoningBuffer = '';
      return { contentDelta: '', thinkingDelta: '' };
    }

    const split = splitUntaggedReasoning(this.untaggedReasoningBuffer) ?? fallbackSplitUntaggedReasoning(this.untaggedReasoningBuffer);
    if (split) {
      this.markUntaggedReasoningSuppressed();
      this.untaggedReasoningBuffer = '';
      this.untaggedReasoningMode = 'done';
      return { contentDelta: split.content, thinkingDelta: split.thinking };
    }

    const visible = this.untaggedReasoningBuffer;
    this.untaggedReasoningBuffer = '';
    this.untaggedReasoningMode = visible.length > 0 ? 'passthrough' : this.untaggedReasoningMode;
    return { contentDelta: visible, thinkingDelta: '' };
  }

  private markUntaggedReasoningSuppressed() {
    this.hasUntaggedReasoningValue = true;
    this.suppressedUntaggedReasoningValue = true;
  }

  private snapshot(contentDelta: string, thinkingDelta: string): ThinkingBlockExtractionResult {
    return {
      delta: contentDelta,
      contentDelta,
      thinkingDelta,
      hasThinkingBlock: this.hasThinkingBlockValue,
      suppressedThinkingBlock: this.suppressedThinkingBlockValue,
      hasUntaggedReasoning: this.hasUntaggedReasoningValue,
      suppressedUntaggedReasoning: this.suppressedUntaggedReasoningValue
    };
  }
}

export class ThinkingBlockSuppressor {
  private extractor: ThinkingBlockExtractor;

  constructor(options: ThinkingBlockExtractorOptions = {}) {
    this.extractor = new ThinkingBlockExtractor(options);
  }

  feed(input: string): ThinkingBlockFilterResult {
    const result = this.extractor.feed(input);
    return this.snapshot(result);
  }

  flush(): ThinkingBlockFilterResult {
    const result = this.extractor.flush();
    return this.snapshot(result);
  }

  private snapshot(result: ThinkingBlockExtractionResult): ThinkingBlockFilterResult {
    return {
      delta: result.contentDelta,
      hasThinkingBlock: result.hasThinkingBlock,
      suppressedThinkingBlock: result.suppressedThinkingBlock,
      hasUntaggedReasoning: result.hasUntaggedReasoning,
      suppressedUntaggedReasoning: result.suppressedUntaggedReasoning
    };
  }
}

export const sanitizeThinkingBlocks = (value: string, options: SanitizeThinkingBlocksOptions = {}) => {
  const extractor = new ThinkingBlockExtractor(options);
  const first = extractor.feed(value);
  const flushed = extractor.flush();
  const content = first.contentDelta + flushed.contentDelta;
  const thinking = first.thinkingDelta + flushed.thinkingDelta;

  return {
    content: options.trim ? content.trim() : content,
    thinking: options.trim ? thinking.trim() : thinking,
    hasThinkingBlock: first.hasThinkingBlock || flushed.hasThinkingBlock,
    suppressedThinkingBlock: first.suppressedThinkingBlock || flushed.suppressedThinkingBlock,
    hasUntaggedReasoning: Boolean(first.hasUntaggedReasoning || flushed.hasUntaggedReasoning),
    suppressedUntaggedReasoning: Boolean(first.suppressedUntaggedReasoning || flushed.suppressedUntaggedReasoning)
  };
};
