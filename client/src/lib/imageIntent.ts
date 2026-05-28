const commandPattern = /^\s*\/(image|chat)(?:\s+|$)/i;

const conceptualGuardPatterns = [
  /\b(explain|describe|define|what\s+is|what\s+are|how\s+does|how\s+do|why\s+does|can\s+ollama|can\s+you\s+explain)\b.{0,80}\b(image\s+generation|generat(?:e|ing)\s+images?|text[-\s]?to[-\s]?image|picture|drawing|rendering)\b/i,
  /\b(write|draft|create|generate|make|give\s+me)\b.{0,60}\b(prompt|prompts|prompt\s+ideas|list|ideas|examples)\b.{0,80}\b(image|picture|artwork|drawing|render)/i,
  /\b(code|api|function|component|workflow|bug|debug|fix|models?|model\s+for|best\s+model)\b.{0,100}\b(draw|image|picture|photo|artwork|render|generate\s+images?)\b/i
];

const directImageRequestPatterns = [
  /\b(generate|create|make|render)\b.{0,40}\b(an?\s+)?(image|picture|photo|photograph|artwork|illustration|drawing|visual)\b/i,
  /\b(draw|paint|sketch)\s+(me\s+)?(an?\s+)?\S+/i,
  /\bgive\s+me\s+(an?\s+)?(image|picture|photo|illustration|drawing|visual)\b/i,
  /\bcan\s+you\s+(generate|create|make|render|draw|paint|sketch)\b.{0,80}\b(image|picture|photo|artwork|illustration|drawing|visual|of)\b/i,
  /\b(make|create)\b.{0,40}\bartwork\s+of\b/i,
  /\brender\s+(an?\s+)?(scene|image|picture|visual)\b/i
];

export function isLikelyImageGenerationRequest(content: string): boolean {
  const trimmed = content.trim();
  const commandMatch = trimmed.match(commandPattern);
  if (commandMatch?.[1]?.toLowerCase() === 'image') return true;
  if (commandMatch?.[1]?.toLowerCase() === 'chat') return false;
  if (conceptualGuardPatterns.some((pattern) => pattern.test(trimmed))) return false;
  return directImageRequestPatterns.some((pattern) => pattern.test(trimmed));
}
