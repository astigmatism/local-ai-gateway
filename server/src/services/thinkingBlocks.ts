export interface ThinkingBlockFilterResult {
  delta: string;
  hasThinkingBlock: boolean;
  suppressedThinkingBlock: boolean;
}

export interface ThinkingBlockMetadata {
  hasThinkingBlock: boolean;
  suppressedThinkingBlock: boolean;
}

export interface SanitizeThinkingBlocksOptions {
  trim?: boolean;
}

const thinkingOpenTagPattern = /<\s*(?:think|thinking)\b[^>]*>/i;
const thinkingCloseTagPattern = /<\s*\/\s*(?:think|thinking)\s*>/i;
const thinkingTagNames = ['think', 'thinking'];

const findPattern = (value: string, pattern: RegExp) => {
  const match = pattern.exec(value);
  if (!match) return null;
  const [text] = match;
  return { index: match.index, text };
};

const isPotentialOpenTagPrefix = (fragment: string) => {
  if (!fragment.startsWith('<') || fragment.includes('>')) return false;

  const tagPrefix = fragment.slice(1).trimStart().toLowerCase();
  if (tagPrefix.startsWith('/')) return false;
  if (tagPrefix.length === 0) return true;

  return thinkingTagNames.some(
    (tagName) => tagName.startsWith(tagPrefix) || tagPrefix.startsWith(`${tagName} `) || tagPrefix === tagName
  );
};

const isPotentialCloseTagPrefix = (fragment: string) => {
  if (!fragment.startsWith('<') || fragment.includes('>')) return false;

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

export class ThinkingBlockSuppressor {
  private pending = '';

  private insideThinkingBlock = false;

  private hasThinkingBlockValue = false;

  private suppressedThinkingBlockValue = false;

  feed(input: string): ThinkingBlockFilterResult {
    let text = `${this.pending}${input}`;
    this.pending = '';
    let visible = '';

    while (text.length > 0) {
      if (this.insideThinkingBlock) {
        const closeTag = findPattern(text, thinkingCloseTagPattern);

        if (!closeTag) {
          const keepFrom = trailingPotentialTagStart(text, isPotentialCloseTagPrefix);
          this.pending = keepFrom === -1 ? '' : text.slice(keepFrom);
          this.suppressedThinkingBlockValue = true;
          break;
        }

        this.suppressedThinkingBlockValue = true;
        text = text.slice(closeTag.index + closeTag.text.length);
        this.insideThinkingBlock = false;
        continue;
      }

      const openTag = findPattern(text, thinkingOpenTagPattern);

      if (!openTag) {
        const keepFrom = trailingPotentialTagStart(text, isPotentialOpenTagPrefix);
        if (keepFrom === -1) {
          visible += text;
        } else {
          visible += text.slice(0, keepFrom);
          this.pending = text.slice(keepFrom);
        }
        break;
      }

      visible += text.slice(0, openTag.index);
      text = text.slice(openTag.index + openTag.text.length);
      this.hasThinkingBlockValue = true;
      this.suppressedThinkingBlockValue = true;
      this.insideThinkingBlock = true;
    }

    return this.snapshot(visible);
  }

  flush(): ThinkingBlockFilterResult {
    let visible = '';

    if (this.insideThinkingBlock) {
      if (this.pending.length > 0) this.suppressedThinkingBlockValue = true;
    } else if (isPotentialOpenTagPrefix(this.pending)) {
      this.hasThinkingBlockValue = true;
      this.suppressedThinkingBlockValue = true;
    } else {
      visible = this.pending;
    }

    this.pending = '';
    return this.snapshot(visible);
  }

  private snapshot(delta: string): ThinkingBlockFilterResult {
    return {
      delta,
      hasThinkingBlock: this.hasThinkingBlockValue,
      suppressedThinkingBlock: this.suppressedThinkingBlockValue
    };
  }
}

export const sanitizeThinkingBlocks = (value: string, options: SanitizeThinkingBlocksOptions = {}) => {
  const suppressor = new ThinkingBlockSuppressor();
  const first = suppressor.feed(value);
  const flushed = suppressor.flush();
  const content = `${first.delta}${flushed.delta}`;

  return {
    content: options.trim ? content.trim() : content,
    hasThinkingBlock: first.hasThinkingBlock || flushed.hasThinkingBlock,
    suppressedThinkingBlock: first.suppressedThinkingBlock || flushed.suppressedThinkingBlock
  };
};
