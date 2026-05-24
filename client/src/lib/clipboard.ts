const fallbackCopyTextToClipboard = (text: string): boolean => {
  if (typeof document === 'undefined' || !document.body) return false;

  const activeElement = document.activeElement;
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.top = '0';
  textArea.style.left = '0';
  textArea.style.width = '1px';
  textArea.style.height = '1px';
  textArea.style.padding = '0';
  textArea.style.border = '0';
  textArea.style.opacity = '0';
  textArea.style.pointerEvents = 'none';

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  textArea.setSelectionRange(0, text.length);

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textArea);
    if (typeof HTMLElement !== 'undefined' && activeElement instanceof HTMLElement) {
      activeElement.focus({ preventScroll: true });
    }
  }
};

export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  if (text.trim().length === 0) return false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to the legacy copy path below when clipboard permissions are unavailable.
  }

  return fallbackCopyTextToClipboard(text);
};
