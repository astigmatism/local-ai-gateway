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
type UnsafeContinuationClassification = 'unsafe' | 'pending' | 'safe';

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

const unsafeContinuationLookaheadChars = 768;
const unsafeContinuationReasoningBufferLimitChars = 64_000;
const fakeRoleContinuationLabels = ['assistant:', 'assistant response:'];
const fakeRoleContinuationPattern = /(^|\r?\n)([ \t>]*(?:#{1,6}[ \t]*)?(?:assistant(?:[ \t]+response)?)[ \t]*:[ \t]*)/gi;

const thinkingOpenTagPattern = new RegExp(
  '<\\s*(?:' + thinkingTagNames.join('|') + ')\\b[^>]*>|' + thinkingOpenTokenMarkers.map(escapeRegExp).join('|'),
  'i'
);
const anchoredThinkingOpenTagPattern = new RegExp(
  '^(?:<\\s*(?:' + thinkingTagNames.join('|') + ')\\b[^>]*>|' + thinkingOpenTokenMarkers.map(escapeRegExp).join('|') + ')',
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
const completeReasoningHeadingPattern = new RegExp(
  '^(?:[\\s>\\-*#_]+)?(?:#{1,6}\\s*)?(?:' +
    reasoningHeadingNames.map((heading) => normalizeWhitespaceForPattern(escapeRegExp(heading))).join('|') +
    ')(?:\\s*:|\\s*[\\r\\n])',
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
const markdownCodeFenceLinePattern = /^[ \t]{0,3}(`{3,}|~{3,})/;
const markdownCodeFenceProtectedLessThan = '\uE000';
const markdownCodeFenceProtectedColon = '\uE001';

interface MarkdownCodeFenceProtectionState {
  insideCodeFence: boolean;
  fenceChar: string;
  fenceLength: number;
  pendingFenceLine: string;
}

const createMarkdownCodeFenceProtectionState = (): MarkdownCodeFenceProtectionState => ({
  insideCodeFence: false,
  fenceChar: '',
  fenceLength: 0,
  pendingFenceLine: ''
});

const protectMarkdownCodeLine = (value: string) =>
  value.replace(/</g, markdownCodeFenceProtectedLessThan).replace(/:/g, markdownCodeFenceProtectedColon);

const isPotentialMarkdownFenceLinePrefix = (value: string) => /^[ \t]{0,3}(?:`{1,2}|~{1,2})$/.test(value);
const hasPotentialTrailingMarkdownFenceLine = (value: string) =>
  isPotentialMarkdownFenceLinePrefix(value.slice(value.lastIndexOf('\n') + 1));

const protectMarkdownCodeFenceContent = (value: string, state = createMarkdownCodeFenceProtectionState()) => {
  if (
    !state.insideCodeFence &&
    state.pendingFenceLine.length === 0 &&
    !value.includes('```') &&
    !value.includes('~~~') &&
    !hasPotentialTrailingMarkdownFenceLine(value)
  ) {
    return value;
  }

  const combined = state.pendingFenceLine + value;
  state.pendingFenceLine = '';

  const lines = combined.match(/[^\n]*\n|[^\n]+/g);
  if (!lines) return combined;

  const lastLine = lines.at(-1) ?? '';
  if (!lastLine.endsWith('\n') && isPotentialMarkdownFenceLinePrefix(lastLine)) {
    state.pendingFenceLine = lastLine;
    lines.pop();
  }

  let { insideCodeFence, fenceChar, fenceLength } = state;

  const protectedValue = lines
    .map((line) => {
      const fenceMatch = markdownCodeFenceLinePattern.exec(line);
      if (fenceMatch) {
        const fence = fenceMatch[1] ?? '';
        const currentFenceChar = fence[0] ?? '';

        if (!insideCodeFence) {
          insideCodeFence = true;
          fenceChar = currentFenceChar;
          fenceLength = fence.length;
          return line;
        }

        if (currentFenceChar === fenceChar && fence.length >= fenceLength) {
          insideCodeFence = false;
          fenceChar = '';
          fenceLength = 0;
          return line;
        }
      }

      return insideCodeFence ? protectMarkdownCodeLine(line) : line;
    })
    .join('');

  state.insideCodeFence = insideCodeFence;
  state.fenceChar = fenceChar;
  state.fenceLength = fenceLength;

  return protectedValue;
};

const flushMarkdownCodeFenceProtection = (state: MarkdownCodeFenceProtectionState) => {
  const pending = state.pendingFenceLine;
  state.pendingFenceLine = '';
  return state.insideCodeFence ? protectMarkdownCodeLine(pending) : pending;
};

const restoreMarkdownCodeFenceContent = (value: string) =>
  value
    .replace(new RegExp(markdownCodeFenceProtectedLessThan, 'g'), '<')
    .replace(new RegExp(markdownCodeFenceProtectedColon, 'g'), ':');

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


interface FakeRoleContinuationMatch {
  markerStart: number;
  markerEnd: number;
}

const findFakeRoleContinuation = (value: string, startIndex = 0): FakeRoleContinuationMatch | null => {
  fakeRoleContinuationPattern.lastIndex = startIndex;
  const match = fakeRoleContinuationPattern.exec(value);
  if (!match) return null;

  const linePrefix = match[1] ?? '';
  const markerText = match[2] ?? '';
  const markerStart = match.index + linePrefix.length;
  return {
    markerStart,
    markerEnd: markerStart + markerText.length
  };
};

const trailingWhitespaceStartBefore = (value: string, index: number) => {
  let start = index;
  while (start > 0 && /[\s]/.test(value[start - 1] ?? '')) start -= 1;
  return start;
};

const trailingWhitespaceStart = (value: string) => trailingWhitespaceStartBefore(value, value.length);

const normalizeFakeRoleContinuationCandidate = (value: string) =>
  value
    .replace(/^[ \t>]*/, '')
    .replace(/^#{1,6}[ \t]*/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

const isPotentialFakeRoleContinuationPrefix = (value: string) => {
  if (/\r?\n/.test(value)) return false;

  const normalized = normalizeFakeRoleContinuationCandidate(value);
  if (normalized.length === 0) return /^[ \t>]*#{1,6}[ \t]*$/.test(value);

  return fakeRoleContinuationLabels.some((label) => label.startsWith(normalized));
};

const trailingPotentialFakeRoleContinuationStart = (value: string) => {
  const lastLineStart = value.lastIndexOf('\n') + 1;
  const trailingLine = value.slice(lastLineStart);
  if (trailingLine.length > 96) return -1;
  if (!isPotentialFakeRoleContinuationPrefix(trailingLine)) return -1;
  return trailingWhitespaceStartBefore(value, lastLineStart);
};

const normalizeUnsafeContinuationReasoningLine = (value: string) =>
  firstMeaningfulLine(value)
    .replace(/^\d+[).]\s*/, '')
    .replace(/^\*+\s*/, '')
    .replace(/\*+\s*:?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const unsafeContinuationReasoningPrefixPhrases = [
  "here's a thinking process:",
  'here is a thinking process:',
  "here's a reasoning process:",
  'here is a reasoning process:',
  "here's a thought process:",
  'here is a thought process:',
  "here's my reasoning:",
  'here is my reasoning:',
  "here's my analysis:",
  'here is my analysis:',
  'analyze user input',
  'analyze the user input',
  'analyse user input',
  'analyse the user input',
  'identify key elements',
  'determine best practices',
  'check against constraints',
  'draft the response',
  'draft response',
  'refine the response',
  'refine response'
];

const unsafeContinuationNumberedReasoningPattern =
  /^\d+[).]\s*(?:\*+\s*)?(?:analy[sz]e\s+(?:the\s+)?user\s+input|identify\s+key\s+elements|determine\s+best\s+practices|check\s+against\s+constraints|draft\b|refine\b)/i;
const unsafeContinuationDirectReasoningPattern =
  /^(?:\*+\s*)?(?:analy[sz]e\s+(?:the\s+)?user\s+input|identify\s+key\s+elements|determine\s+best\s+practices|check\s+against\s+constraints)/i;
const unsafeContinuationThinkingProcessPattern =
  /^here(?:'s|\s+is)\s+(?:(?:a|the|my)\s+)?(?:thinking|reasoning|thought|analysis)\s+process\s*:/i;
const unsafeContinuationMyReasoningPattern = /^here(?:'s|\s+is)\s+my\s+(?:reasoning|analysis)\s*:/i;

const looksLikeUnsafeContinuationReasoningPreamble = (value: string) => {
  const preamble = value.trimStart().slice(0, 1600);
  if (preamble.length === 0) return false;
  if (completeReasoningHeadingPattern.test(preamble)) return true;
  if (unsafeContinuationThinkingProcessPattern.test(preamble)) return true;
  if (unsafeContinuationMyReasoningPattern.test(preamble)) return true;
  if (unsafeContinuationNumberedReasoningPattern.test(preamble)) return true;
  if (unsafeContinuationDirectReasoningPattern.test(preamble)) return true;
  return leakedReasoningPhraseScore(preamble) >= 2;
};

const isPotentialUnsafeContinuationReasoningPrefix = (value: string) => {
  const normalized = normalizeUnsafeContinuationReasoningLine(value);
  if (normalized.length === 0) return true;
  if (isPotentialReasoningHeadingPrefix(value)) return true;
  if (normalized.length < 3) {
    return unsafeContinuationReasoningPrefixPhrases.some((phrase) => phrase.startsWith(normalized));
  }
  return unsafeContinuationReasoningPrefixPhrases.some((phrase) => phrase.startsWith(normalized));
};

const classifyUnsafeContinuationAfterRoleMarker = (
  afterMarker: string,
  options: { flush: boolean; thinkingStartedAfterContent: boolean }
): UnsafeContinuationClassification => {
  const leadingWhitespace = afterMarker.match(/^\s*/)?.[0] ?? '';
  const remainder = afterMarker.slice(leadingWhitespace.length);

  if (remainder.length === 0) {
    if (options.thinkingStartedAfterContent) return 'unsafe';
    if (options.flush || afterMarker.length > unsafeContinuationLookaheadChars) return 'safe';
    return 'pending';
  }

  if (anchoredThinkingOpenTagPattern.test(remainder)) return 'unsafe';
  if (isPotentialOpenTagPrefix(remainder)) return options.flush ? 'unsafe' : 'pending';
  if (looksLikeUnsafeContinuationReasoningPreamble(remainder)) return 'unsafe';
  if (isPotentialUnsafeContinuationReasoningPrefix(remainder)) return options.flush ? 'unsafe' : 'pending';

  return 'safe';
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

const splitUnsafeContinuationReasoning = (value: string): UntaggedReasoningSplit | null => {
  const marker = findFakeRoleContinuation(value, 0);
  if (!marker) return splitUntaggedReasoning(value);

  const afterMarker = value.slice(marker.markerEnd);
  const split = splitUntaggedReasoning(afterMarker);
  if (!split) return null;

  return {
    thinking: value.slice(0, marker.markerEnd) + split.thinking,
    content: split.content
  };
};

const findRoleIntroducedThinkingBoundary = (
  value: string,
  marker: FakeRoleContinuationMatch,
  suppressedThinkingOpenBoundaries: number[]
) => {
  for (const boundary of suppressedThinkingOpenBoundaries) {
    if (boundary < marker.markerEnd) continue;
    if (/^\s*$/.test(value.slice(marker.markerEnd, boundary))) return boundary;
    break;
  }

  return null;
};

export class ThinkingBlockExtractor {
  private pending = '';

  private insideThinkingBlock = false;

  private hasThinkingBlockValue = false;

  private suppressedThinkingBlockValue = false;

  private hasUntaggedReasoningValue = false;

  private suppressedUntaggedReasoningValue = false;

  private hasEmittedContentValue = false;

  private lastVisibleOutputChar = '';

  private pendingVisibleContinuationSeparator = false;

  private readonly markdownCodeFenceProtectionState = createMarkdownCodeFenceProtectionState();

  private leadingThinkingCandidate: boolean;

  private readonly extractUntaggedReasoning: boolean;

  private readonly maxUntaggedReasoningPreambleChars: number;

  private untaggedReasoningMode: UntaggedReasoningMode = 'undecided';

  private untaggedReasoningBuffer = '';

  private unsafeContinuationBuffer = '';

  private unsafeContinuationReasoningBuffer = '';

  private suppressingUnsafeContinuation = false;

  constructor(options: ThinkingBlockExtractorOptions = {}) {
    this.leadingThinkingCandidate = options.assumeLeadingThinking === true;
    this.extractUntaggedReasoning = options.extractUntaggedReasoning === true;
    this.maxUntaggedReasoningPreambleChars = options.maxUntaggedReasoningPreambleChars ?? 2400;
  }

  feed(input: string): ThinkingBlockExtractionResult {
    let text = this.pending + protectMarkdownCodeFenceContent(input, this.markdownCodeFenceProtectionState);
    this.pending = '';
    let contentDelta = '';
    let thinkingDelta = '';
    let thinkingStartedAfterContent = false;
    const suppressedThinkingOpenBoundaries: number[] = [];

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
          suppressedThinkingOpenBoundaries.push(contentDelta.length);
          text = text.slice(openTag.index + openTag.text.length);
          this.hasThinkingBlockValue = true;
          this.suppressedThinkingBlockValue = true;
          this.insideThinkingBlock = true;
          thinkingStartedAfterContent = true;
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
      suppressedThinkingOpenBoundaries.push(contentDelta.length);
      text = text.slice(openTag.index + openTag.text.length);
      this.hasThinkingBlockValue = true;
      this.suppressedThinkingBlockValue = true;
      this.insideThinkingBlock = true;
      thinkingStartedAfterContent = true;
    }

    const continuation = this.filterUnsafeContinuation(contentDelta, {
      thinkingStartedAfterContent,
      suppressedThinkingOpenBoundaries
    });
    const untagged = this.filterUntaggedReasoning(continuation.contentDelta);
    return this.snapshot(untagged.contentDelta, continuation.thinkingDelta + thinkingDelta + untagged.thinkingDelta);
  }

  flush(): ThinkingBlockExtractionResult {
    let contentDelta = '';
    let thinkingDelta = '';
    let thinkingStartedAfterContent = false;

    this.pending += flushMarkdownCodeFenceProtection(this.markdownCodeFenceProtectionState);

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
      thinkingStartedAfterContent = isPotentialOpenTagPrefix(this.pending);
      this.hasThinkingBlockValue = true;
      this.suppressedThinkingBlockValue = true;
    } else {
      contentDelta = this.pending;
    }

    this.pending = '';
    this.leadingThinkingCandidate = false;

    const continuation = this.filterUnsafeContinuation(contentDelta, { flush: true, thinkingStartedAfterContent });
    const untaggedFromContent = this.filterUntaggedReasoning(continuation.contentDelta);
    const untaggedFromBuffer = this.flushUntaggedReasoning();

    return this.snapshot(
      untaggedFromContent.contentDelta + untaggedFromBuffer.contentDelta,
      continuation.thinkingDelta + thinkingDelta + untaggedFromContent.thinkingDelta + untaggedFromBuffer.thinkingDelta
    );
  }

  private filterUnsafeContinuation(
    contentDelta: string,
    options: {
      flush?: boolean;
      thinkingStartedAfterContent?: boolean;
      suppressedThinkingOpenBoundaries?: number[];
    } = {}
  ): { contentDelta: string; thinkingDelta: string } {
    if (this.suppressingUnsafeContinuation) {
      if (contentDelta.length > 0) {
        this.unsafeContinuationReasoningBuffer += contentDelta;
      }

      const split = splitUnsafeContinuationReasoning(this.unsafeContinuationReasoningBuffer);
      if (split) {
        const thinkingDelta = split.thinking;
        this.unsafeContinuationReasoningBuffer = '';
        this.suppressingUnsafeContinuation = false;
        this.unsafeContinuationBuffer += this.visibleContinuationFromCurrentOutput('', split.content);
        const drained = this.drainUnsafeContinuationBuffer({
          flush: options.flush === true,
          thinkingStartedAfterContent: options.thinkingStartedAfterContent === true,
          suppressedThinkingOpenBoundaries: []
        });
        return { contentDelta: drained.contentDelta, thinkingDelta: thinkingDelta + drained.thinkingDelta };
      }

      if (options.flush === true) {
        const thinkingDelta = this.unsafeContinuationReasoningBuffer;
        this.unsafeContinuationReasoningBuffer = '';
        this.suppressingUnsafeContinuation = false;
        if (thinkingDelta.length > 0) this.markUnsafeContinuationSuppressed();
        return { contentDelta: '', thinkingDelta };
      }

      if (this.unsafeContinuationReasoningBuffer.length > unsafeContinuationReasoningBufferLimitChars) {
        const drainLength = this.unsafeContinuationReasoningBuffer.length - unsafeContinuationReasoningBufferLimitChars;
        const thinkingDelta = this.unsafeContinuationReasoningBuffer.slice(0, drainLength);
        this.unsafeContinuationReasoningBuffer = this.unsafeContinuationReasoningBuffer.slice(drainLength);
        this.markUnsafeContinuationSuppressed();
        return { contentDelta: '', thinkingDelta };
      }

      return { contentDelta: '', thinkingDelta: '' };
    }

    const previousBufferLength = this.unsafeContinuationBuffer.length;
    if (contentDelta.length > 0) {
      this.unsafeContinuationBuffer += contentDelta;
    }

    const suppressedThinkingOpenBoundaries = (options.suppressedThinkingOpenBoundaries ?? [])
      .map((boundary) => previousBufferLength + boundary)
      .filter((boundary) => boundary >= 0 && boundary <= this.unsafeContinuationBuffer.length)
      .sort((left, right) => left - right);

    return this.drainUnsafeContinuationBuffer({
      flush: options.flush === true,
      thinkingStartedAfterContent: options.thinkingStartedAfterContent === true,
      suppressedThinkingOpenBoundaries
    });
  }

  private drainUnsafeContinuationBuffer(options: {
    flush: boolean;
    thinkingStartedAfterContent: boolean;
    suppressedThinkingOpenBoundaries: number[];
  }): { contentDelta: string; thinkingDelta: string } {
    let contentDelta = '';
    let thinkingDelta = '';
    let searchIndex = 0;
    let suppressedThinkingOpenBoundaries = options.suppressedThinkingOpenBoundaries;

    const shiftSuppressedThinkingOpenBoundaries = (removedChars: number) => {
      suppressedThinkingOpenBoundaries = suppressedThinkingOpenBoundaries
        .filter((boundary) => boundary >= removedChars)
        .map((boundary) => boundary - removedChars);
    };

    while (searchIndex < this.unsafeContinuationBuffer.length) {
      const marker = findFakeRoleContinuation(this.unsafeContinuationBuffer, searchIndex);
      if (!marker) break;

      const roleIntroducedThinkingBoundary = findRoleIntroducedThinkingBoundary(
        this.unsafeContinuationBuffer,
        marker,
        suppressedThinkingOpenBoundaries
      );

      if (roleIntroducedThinkingBoundary !== null) {
        const suppressFrom = trailingWhitespaceStartBefore(this.unsafeContinuationBuffer, marker.markerStart);
        contentDelta += this.visibleBufferedContentFromUnsafeBuffer(
          contentDelta,
          this.unsafeContinuationBuffer.slice(0, suppressFrom)
        );
        thinkingDelta += this.unsafeContinuationBuffer.slice(suppressFrom, roleIntroducedThinkingBoundary);
        this.unsafeContinuationBuffer = this.visibleContinuationFromCurrentOutput(
          contentDelta,
          this.unsafeContinuationBuffer.slice(roleIntroducedThinkingBoundary)
        );
        shiftSuppressedThinkingOpenBoundaries(roleIntroducedThinkingBoundary);
        this.markUnsafeContinuationSuppressed();
        searchIndex = 0;
        continue;
      }

      const afterMarker = this.unsafeContinuationBuffer.slice(marker.markerEnd);
      const classification = classifyUnsafeContinuationAfterRoleMarker(afterMarker, options);

      if (classification === 'unsafe') {
        const suppressFrom = trailingWhitespaceStartBefore(this.unsafeContinuationBuffer, marker.markerStart);
        contentDelta += this.visibleBufferedContentFromUnsafeBuffer(
          contentDelta,
          this.unsafeContinuationBuffer.slice(0, suppressFrom)
        );
        const unsafeTail = this.unsafeContinuationBuffer.slice(suppressFrom);
        const split = splitUnsafeContinuationReasoning(unsafeTail);
        this.unsafeContinuationBuffer = '';
        suppressedThinkingOpenBoundaries = [];
        this.markUnsafeContinuationSuppressed();

        if (split) {
          thinkingDelta += split.thinking;
          this.unsafeContinuationBuffer = this.visibleContinuationFromCurrentOutput(contentDelta, split.content);
          searchIndex = 0;
          continue;
        }

        if (options.flush) {
          thinkingDelta += unsafeTail;
          return { contentDelta, thinkingDelta };
        }

        this.unsafeContinuationReasoningBuffer = unsafeTail;
        this.suppressingUnsafeContinuation = true;
        return { contentDelta, thinkingDelta };
      }

      if (classification === 'pending') {
        const holdFrom = trailingWhitespaceStartBefore(this.unsafeContinuationBuffer, marker.markerStart);
        contentDelta += this.visibleBufferedContentFromUnsafeBuffer(
          contentDelta,
          this.unsafeContinuationBuffer.slice(0, holdFrom)
        );
        this.unsafeContinuationBuffer = this.unsafeContinuationBuffer.slice(holdFrom);
        shiftSuppressedThinkingOpenBoundaries(holdFrom);
        return { contentDelta, thinkingDelta };
      }

      searchIndex = marker.markerEnd;
    }

    if (options.flush) {
      contentDelta += this.visibleBufferedContentFromUnsafeBuffer(contentDelta, this.unsafeContinuationBuffer);
      this.unsafeContinuationBuffer = '';
      return { contentDelta, thinkingDelta };
    }

    const potentialRoleStart = trailingPotentialFakeRoleContinuationStart(this.unsafeContinuationBuffer);
    if (potentialRoleStart !== -1) {
      contentDelta += this.visibleBufferedContentFromUnsafeBuffer(
        contentDelta,
        this.unsafeContinuationBuffer.slice(0, potentialRoleStart)
      );
      this.unsafeContinuationBuffer = this.unsafeContinuationBuffer.slice(potentialRoleStart);
      shiftSuppressedThinkingOpenBoundaries(potentialRoleStart);
      return { contentDelta, thinkingDelta };
    }

    const keepFrom = trailingWhitespaceStart(this.unsafeContinuationBuffer);
    contentDelta += this.visibleBufferedContentFromUnsafeBuffer(
      contentDelta,
      this.unsafeContinuationBuffer.slice(0, keepFrom)
    );
    this.unsafeContinuationBuffer = this.unsafeContinuationBuffer.slice(keepFrom);
    shiftSuppressedThinkingOpenBoundaries(keepFrom);
    return { contentDelta, thinkingDelta };
  }

  private visibleContinuationFromCurrentOutput(currentContentDelta: string, continuation: string) {
    if (continuation.length === 0) {
      if (this.hasVisibleOutputBefore(currentContentDelta)) {
        this.pendingVisibleContinuationSeparator = true;
      }
      return continuation;
    }

    const previousVisibleChar = currentContentDelta.length > 0
      ? currentContentDelta.at(-1)
      : this.lastVisibleOutputChar;

    this.pendingVisibleContinuationSeparator = false;

    if (!previousVisibleChar || /\s/.test(previousVisibleChar) || /^\s/.test(continuation)) return continuation;
    return `\n\n${continuation}`;
  }

  private visibleBufferedContentFromUnsafeBuffer(currentContentDelta: string, value: string) {
    if (value.length === 0 || !this.pendingVisibleContinuationSeparator) return value;
    return this.visibleContinuationFromCurrentOutput(currentContentDelta, value);
  }

  private hasVisibleOutputBefore(currentContentDelta: string) {
    return currentContentDelta.length > 0 || this.lastVisibleOutputChar.length > 0;
  }

  private markUnsafeContinuationSuppressed() {
    this.hasUntaggedReasoningValue = true;
    this.suppressedUntaggedReasoningValue = true;
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
    const visibleContentDelta = restoreMarkdownCodeFenceContent(contentDelta);
    const visibleThinkingDelta = restoreMarkdownCodeFenceContent(thinkingDelta);

    if (visibleContentDelta.length > 0) {
      this.lastVisibleOutputChar = visibleContentDelta.at(-1) ?? this.lastVisibleOutputChar;
    }

    return {
      delta: visibleContentDelta,
      contentDelta: visibleContentDelta,
      thinkingDelta: visibleThinkingDelta,
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
