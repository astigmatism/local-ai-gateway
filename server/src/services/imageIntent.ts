export type ImageRequestKind = 'chat' | 'image';

export interface ImageIntentDetection {
  kind: ImageRequestKind;
  prompt: string;
  originalPrompt: string;
  forcedBy?: '/image' | '/chat';
  reason: string;
}

const imageCommandPattern = /^\/image(?:\s+|$)/iu;
const chatCommandPattern = /^\/chat(?:\s+|$)/iu;

const conceptualPatterns = [
  /^(?:explain|describe|tell\s+me|what\s+(?:is|are|does)|how\s+(?:does|do|can)|why\s+(?:does|do)|can\s+ollama|does\s+ollama)\b[\s\S]*\b(?:image\s+generation|generat(?:e|ing)\s+images?|image\s+generator|images?)\b/iu,
  /\b(?:write|draft|create|generate|give\s+me)\s+(?:a\s+|an\s+|some\s+)?(?:prompt|prompts|list|ideas|code|regex|workflow|plan|strategy|instructions)\b[\s\S]*\b(?:image|picture|photo|draw|drawing|generate|generation)\b/iu,
  /\b(?:debug|fix|troubleshoot|document|explain)\b[\s\S]*\b(?:image\s+generation|image-generation|generate\s+images?|generated\s+image)\b/iu,
  /\b(?:graphics\s+api|canvas\s+api|svg|html|css|javascript|typescript|react|node)\b[\s\S]*\b(?:draw|drawing|displays?\s+(?:a\s+)?picture|image\s+generation)\b/iu,
  /^what\s+(?:models?|model)\b[\s\S]*\b(?:generate|generates|generation)\b[\s\S]*\bimages?\b/iu
];

const directImagePatterns = [
  /^(?:please\s+)?(?:generate|create|make|render|produce)\s+(?:me\s+|an?\s+|some\s+)?(?:image|picture|photo|photograph|artwork|art|illustration|drawing|wallpaper|portrait|logo|icon|poster|concept\s+art)\b/iu,
  /^(?:please\s+)?(?:draw|paint|sketch|illustrate)\s+(?:me\s+)?(?:an?\s+)?[\s\S]+/iu,
  /^(?:please\s+)?give\s+me\s+(?:an?\s+|some\s+)?(?:image|picture|photo|photograph|artwork|illustration|drawing|wallpaper|portrait|logo|icon|poster)\b/iu,
  /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:generate|create|make|render|produce)\s+(?:me\s+|an?\s+|some\s+)?(?:image|picture|photo|photograph|artwork|art|illustration|drawing|wallpaper|portrait|logo|icon|poster|concept\s+art)\b/iu,
  /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:draw|paint|sketch|illustrate)\s+(?:me\s+)?(?:an?\s+)?[\s\S]+/iu,
  /\b(?:generate|create|make|render|produce)\s+(?:an?\s+|some\s+)?(?:image|picture|photo|photograph|artwork|illustration|drawing|wallpaper|portrait|poster)\s+(?:of|showing|for|with)\b/iu,
  /\b(?:draw|paint|sketch|illustrate)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|scene|character|portrait|landscape)?\s*(?:of|showing|with)\b/iu
];

const stripCommand = (prompt: string, pattern: RegExp) => prompt.replace(pattern, '').trim();

export function detectImageIntent(input: string): ImageIntentDetection {
  const originalPrompt = input;
  const trimmed = input.trim();

  if (imageCommandPattern.test(trimmed)) {
    return {
      kind: 'image',
      prompt: stripCommand(trimmed, imageCommandPattern),
      originalPrompt,
      forcedBy: '/image',
      reason: 'slash_command_image'
    };
  }

  if (chatCommandPattern.test(trimmed)) {
    return {
      kind: 'chat',
      prompt: stripCommand(trimmed, chatCommandPattern),
      originalPrompt,
      forcedBy: '/chat',
      reason: 'slash_command_chat'
    };
  }

  if (conceptualPatterns.some((pattern) => pattern.test(trimmed))) {
    return {
      kind: 'chat',
      prompt: trimmed,
      originalPrompt,
      reason: 'conceptual_or_tooling_image_discussion'
    };
  }

  if (directImagePatterns.some((pattern) => pattern.test(trimmed))) {
    return {
      kind: 'image',
      prompt: trimmed,
      originalPrompt,
      reason: 'explicit_image_generation_request'
    };
  }

  return {
    kind: 'chat',
    prompt: trimmed,
    originalPrompt,
    reason: 'default_chat'
  };
}
