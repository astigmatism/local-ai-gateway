import { useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from '../lib/clipboard.js';
import type { MessageRole } from '../lib/types.js';
import type { TextToSpeechMessageState } from '../hooks/useTextToSpeechPlayback.js';

interface MessageActionsProps {
  role: MessageRole;
  content: string;
  canCopy: boolean;
  canSpeak: boolean;
  speechState: TextToSpeechMessageState;
  speechError?: string | null;
  canReusePrompt: boolean;
  onSpeak?: () => void;
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

const SpeakerIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M4.75 9.25h3.06l4.26-3.72a.85.85 0 0 1 1.41.64v11.66a.85.85 0 0 1-1.41.64l-4.26-3.72H4.75A1.75 1.75 0 0 1 3 13V11a1.75 1.75 0 0 1 1.75-1.75Zm7.23-1.21-3.39 2.96a.85.85 0 0 1-.56.21H4.75a.25.25 0 0 0-.25.25v1.08c0 .14.11.25.25.25h3.28c.2 0 .4.08.56.21l3.39 2.96V8.04Z" />
    <path d="M16.25 8.15a.75.75 0 0 1 1.06 0 5.44 5.44 0 0 1 0 7.7.75.75 0 0 1-1.06-1.06 3.94 3.94 0 0 0 0-5.58.75.75 0 0 1 0-1.06Z" />
    <path d="M18.72 5.68a.75.75 0 0 1 1.06 0 8.94 8.94 0 0 1 0 12.64.75.75 0 0 1-1.06-1.06 7.44 7.44 0 0 0 0-10.52.75.75 0 0 1 0-1.06Z" />
  </svg>
);

const StopIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M7.75 5h8.5A2.75 2.75 0 0 1 19 7.75v8.5A2.75 2.75 0 0 1 16.25 19h-8.5A2.75 2.75 0 0 1 5 16.25v-8.5A2.75 2.75 0 0 1 7.75 5Zm0 1.5c-.69 0-1.25.56-1.25 1.25v8.5c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25v-8.5c0-.69-.56-1.25-1.25-1.25h-8.5Z" />
  </svg>
);

const LoadingIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M12 3a9 9 0 1 0 8.49 12.01.75.75 0 0 0-1.41-.5A7.5 7.5 0 1 1 12 4.5a.75.75 0 0 0 0-1.5Z" />
  </svg>
);

const copyStatusLabel = (status: CopyStatus, role: MessageRole) => {
  if (status === 'copied') return role === 'assistant' ? 'Response copied' : 'Prompt copied';
  if (status === 'failed') return 'Could not copy';
  return '';
};

const speakStatusLabel = (speechState: TextToSpeechMessageState, speechError?: string | null) => {
  if (speechState === 'loading') return 'Generating speech…';
  if (speechState === 'playing') return 'Speaking…';
  if (speechState === 'error') return speechError || 'Could not generate speech.';
  return '';
};

export const MessageActions = ({
  role,
  content,
  canCopy,
  canSpeak,
  speechState,
  speechError,
  canReusePrompt,
  onSpeak,
  onReusePrompt
}: MessageActionsProps) => {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  const resetTimerRef = useRef<number | null>(null);
  const hasActions = canCopy || canSpeak || canReusePrompt;
  const copyLabel = role === 'assistant' ? 'Copy response' : 'Copy prompt';
  const speakLabel = role === 'assistant' ? 'Speak response' : 'Speak prompt';
  const stopSpeakLabel = role === 'assistant' ? 'Stop speaking response' : 'Stop speaking prompt';
  const copyFeedback = copyStatusLabel(copyStatus, role);
  const speechFeedback = speakStatusLabel(speechState, speechError);
  const copyButtonClassName = [
    'message-action-button',
    copyStatus === 'copied' ? 'copied' : '',
    copyStatus === 'failed' ? 'failed' : ''
  ]
    .filter(Boolean)
    .join(' ');
  const speakButtonClassName = [
    'message-action-button',
    'speak-action',
    speechState === 'loading' ? 'loading' : '',
    speechState === 'playing' ? 'playing' : '',
    speechState === 'error' ? 'failed' : ''
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

      {canSpeak && (
        <button
          className={speakButtonClassName}
          type="button"
          onClick={onSpeak}
          aria-label={speechState === 'playing' ? stopSpeakLabel : speakLabel}
          aria-pressed={speechState === 'playing'}
          aria-busy={speechState === 'loading'}
          title={speechState === 'playing' ? stopSpeakLabel : speakLabel}
        >
          {speechState === 'loading' ? <LoadingIcon /> : speechState === 'playing' ? <StopIcon /> : <SpeakerIcon />}
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

      {speechFeedback && (
        <span
          className={`message-action-feedback ${speechState === 'error' ? 'error' : ''}`}
          role={speechState === 'error' ? 'alert' : 'status'}
        >
          {speechFeedback}
        </span>
      )}
    </div>
  );
};
