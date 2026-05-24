import { useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from '../lib/clipboard.js';
import type { MessageRole } from '../lib/types.js';

interface MessageActionsProps {
  role: MessageRole;
  content: string;
  canCopy: boolean;
  canReusePrompt: boolean;
  onReusePrompt?: (content: string) => void;
}

type CopyStatus = 'idle' | 'copied' | 'failed';

const CopyIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M8.75 3.25A2.75 2.75 0 0 1 11.5.5h6.75A2.75 2.75 0 0 1 21 3.25V10a2.75 2.75 0 0 1-2.75 2.75H11.5A2.75 2.75 0 0 1 8.75 10V3.25Zm2.75-1.25c-.69 0-1.25.56-1.25 1.25V10c0 .69.56 1.25 1.25 1.25h6.75c.69 0 1.25-.56 1.25-1.25V3.25c0-.69-.56-1.25-1.25-1.25H11.5Z" />
    <path d="M5.75 7.25c-.69 0-1.25.56-1.25 1.25v6.75c0 .69.56 1.25 1.25 1.25h6.75c.69 0 1.25-.56 1.25-1.25v-.5a.75.75 0 0 1 1.5 0v.5A2.75 2.75 0 0 1 12.5 18H5.75A2.75 2.75 0 0 1 3 15.25V8.5a2.75 2.75 0 0 1 2.75-2.75h.5a.75.75 0 0 1 0 1.5h-.5Z" />
  </svg>
);

const CheckIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M9.55 16.32a.9.9 0 0 1-.64-.27l-3.1-3.12a.9.9 0 1 1 1.28-1.27l2.46 2.47 7.36-7.36a.9.9 0 1 1 1.27 1.27l-8 8a.9.9 0 0 1-.63.28Z" />
  </svg>
);

const PencilIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M16.86 3.64a2.2 2.2 0 0 1 3.11 3.11l-9.7 9.71a.75.75 0 0 1-.36.2l-4.05 1.02a.75.75 0 0 1-.91-.91l1.02-4.05a.75.75 0 0 1 .2-.36l9.69-9.72Zm2.05 2.05a.7.7 0 0 0-.99-.99l-.94.94.99.99.94-.94Zm-2 2-1-.99-8.53 8.53-.54 2.16 2.16-.54 8.53-8.53Z" />
    <path d="M4.75 20.5a.75.75 0 0 1 0-1.5h14.5a.75.75 0 0 1 0 1.5H4.75Z" />
  </svg>
);

const copyStatusLabel = (status: CopyStatus, role: MessageRole) => {
  if (status === 'copied') return role === 'assistant' ? 'Response copied' : 'Prompt copied';
  if (status === 'failed') return 'Could not copy';
  return '';
};

export const MessageActions = ({
  role,
  content,
  canCopy,
  canReusePrompt,
  onReusePrompt
}: MessageActionsProps) => {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  const resetTimerRef = useRef<number | null>(null);
  const hasActions = canCopy || canReusePrompt;
  const copyLabel = role === 'assistant' ? 'Copy response' : 'Copy prompt';
  const copyFeedback = copyStatusLabel(copyStatus, role);
  const copyButtonClassName = [
    'message-action-button',
    copyStatus === 'copied' ? 'copied' : '',
    copyStatus === 'failed' ? 'failed' : ''
  ]
    .filter(Boolean)
    .join(' ');

  useEffect(
    () => () => {
      if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
    },
    []
  );

  const showCopyStatus = (status: CopyStatus) => {
    if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
    setCopyStatus(status);
    resetTimerRef.current = window.setTimeout(() => setCopyStatus('idle'), 1800);
  };

  const handleCopy = async () => {
    const copied = await copyTextToClipboard(content);
    showCopyStatus(copied ? 'copied' : 'failed');
  };

  if (!hasActions) return null;

  return (
    <div className="message-actions" aria-label="Message actions">
      {canCopy && (
        <button
          className={copyButtonClassName}
          type="button"
          onClick={() => void handleCopy()}
          aria-label={copyLabel}
          title={copyLabel}
        >
          {copyStatus === 'copied' ? <CheckIcon /> : <CopyIcon />}
        </button>
      )}

      {canReusePrompt && (
        <button
          className="message-action-button"
          type="button"
          onClick={() => onReusePrompt?.(content)}
          aria-label="Edit prompt"
          title="Edit prompt"
        >
          <PencilIcon />
        </button>
      )}

      {copyFeedback && (
        <span className={`message-action-feedback ${copyStatus === 'failed' ? 'error' : ''}`} role="status">
          {copyFeedback}
        </span>
      )}
    </div>
  );
};
