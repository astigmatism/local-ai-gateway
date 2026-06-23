export interface ThinkingBlockMetadata {
  hasThinkingBlock: boolean;
  suppressedThinkingBlock: boolean;
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
}

export interface SanitizeThinkingBlocksOptions extends ThinkingBlockExtractorOptions {
  trim?: boolean;
}

const thinkingTagNames = ['think', 'thinking'];
const thinkingOpenTokenMarkers = ['<|begin_of_thought|>', '<|start_of_thought|>', '<|begin▁of▁thought|>'];
const thinkingCloseTokenMarkers = ['<|end_of_thought|>', '<|stop_of_thought|>', '<|end▁of▁thought|>'];

const escapeRegExp = (value: string) => value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');

const thinkingOpenTagPattern = new RegExp(
  String.raw`<\s*(?:${thinkingTagNames.join('|')})\b[^>]*>|${thinkingOpenTokenMarkers.map(escapeRegExp).join('|')}`,
  'i'
);
const thinkingCloseTagPattern = new RegExp(
  String.raw`<\s*\/\s*(?:${thinkingTagNames.join('|')})\s*>|${thinkingCloseTokenMarkers.map(escapeRegExp).join('|')}`,
  'i'
);

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
    (tagName) => tagName.startsWith(tagPrefix) || tagPrefix.startsWith(`${tagName} `) || tagPrefix === tagName
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

export class ThinkingBlockExtractor {
  private pending = '';

  private insideThinkingBlock = false;

  private hasThinkingBlockValue = false;

  private suppressedThinkingBlockValue = false;

  private hasEmittedContentValue = false;

  private leadingThinkingCandidate: boolean;

  constructor(options: ThinkingBlockExtractorOptions = {}) {
    this.leadingThinkingCandidate = options.assumeLeadingThinking === true;
  }

  feed(input: string): ThinkingBlockExtractionResult {
    let text = `${this.pending}${input}`;
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

    return this.snapshot(contentDelta, thinkingDelta);
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
    return this.snapshot(contentDelta, thinkingDelta);
  }

  private snapshot(contentDelta: string, thinkingDelta: string): ThinkingBlockExtractionResult {
    return {
      delta: contentDelta,
      contentDelta,
      thinkingDelta,
      hasThinkingBlock: this.hasThinkingBlockValue,
      suppressedThinkingBlock: this.suppressedThinkingBlockValue
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
      suppressedThinkingBlock: result.suppressedThinkingBlock
    };
  }
}

export const sanitizeThinkingBlocks = (value: string, options: SanitizeThinkingBlocksOptions = {}) => {
  const extractor = new ThinkingBlockExtractor(options);
  const first = extractor.feed(value);
  const flushed = extractor.flush();
  const content = `${first.contentDelta}${flushed.contentDelta}`;
  const thinking = `${first.thinkingDelta}${flushed.thinkingDelta}`;

  return {
    content: options.trim ? content.trim() : content,
    thinking: options.trim ? thinking.trim() : thinking,
    hasThinkingBlock: first.hasThinkingBlock || flushed.hasThinkingBlock,
    suppressedThinkingBlock: first.suppressedThinkingBlock || flushed.suppressedThinkingBlock
  };
};
