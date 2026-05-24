export const appendTranscript = (draft: string, transcript: string) => {
  const cleanTranscript = transcript.trim();

  if (!cleanTranscript) return draft;
  if (!draft.trim()) return cleanTranscript;

  return `${draft.trimEnd()}\n\n${cleanTranscript}`;
};
