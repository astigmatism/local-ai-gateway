import { forwardRef } from 'react';

interface ChatInputProps {
  draft: string;
  setDraft: (value: string) => void;
  onSend: () => Promise<void>;
  onToggleRecording: () => void;
  isRecording: boolean;
  isTranscribing: boolean;
  isSending: boolean;
  disabled: boolean;
  composerNotice?: string | null;
}

const MicrophoneIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M12 14.75a3.25 3.25 0 0 0 3.25-3.25v-5a3.25 3.25 0 0 0-6.5 0v5A3.25 3.25 0 0 0 12 14.75Z" />
    <path d="M6.75 10.5a.75.75 0 0 0-1.5 0 6.76 6.76 0 0 0 6 6.72v2.03H8.5a.75.75 0 0 0 0 1.5h7a.75.75 0 0 0 0-1.5h-2.75v-2.03a6.76 6.76 0 0 0 6-6.72.75.75 0 0 0-1.5 0 5.25 5.25 0 0 1-10.5 0Z" />
  </svg>
);

const SendIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M3.48 11.08 20.1 3.55a.85.85 0 0 1 1.16.98l-3.77 16.6a.85.85 0 0 1-1.5.34l-3.81-5.08-4.88 3.62a.85.85 0 0 1-1.35-.7l.18-5.6-2.82-1.05a.85.85 0 0 1 .07-1.58Zm4.36 2.34-.12 3.85 8.96-10.6-8.84 6.75Zm9.22 5.46 2.79-12.29-6.67 7.9 3.88 4.39Z" />
  </svg>
);

export const ChatInput = forwardRef<HTMLTextAreaElement, ChatInputProps>(function ChatInput(
  {
    draft,
    setDraft,
    onSend,
    onToggleRecording,
    isRecording,
    isTranscribing,
    isSending,
    disabled,
    composerNotice
  },
  ref
) {
  const canSend = draft.trim().length > 0 && !isSending && !disabled;
  const activityStatusText = isRecording
    ? 'Recording…'
    : isTranscribing
      ? 'Transcribing…'
      : isSending
        ? 'Thinking…'
        : 'Press Enter to send. Shift+Enter inserts a new line.';
  const statusText =
    composerNotice && !isRecording && !isTranscribing && !isSending ? composerNotice : activityStatusText;

  return (
    <footer className="composer">
      <div className="composer-box">
        <textarea
          ref={ref}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (canSend) void onSend();
            }
          }}
          placeholder="Message Bear Castle AI..."
          rows={5}
          disabled={disabled || isSending}
        />
        <div className="composer-actions" aria-label="Message actions">
          <button
            className={`icon-button ${isRecording ? 'recording' : ''}`}
            type="button"
            onClick={onToggleRecording}
            disabled={disabled || isTranscribing || isSending}
            aria-label={isRecording ? 'Stop recording' : 'Record voice snippet'}
            title={isRecording ? 'Stop recording' : 'Record voice snippet'}
          >
            <MicrophoneIcon />
          </button>
          <button
            className="icon-button send-button"
            type="button"
            onClick={() => void onSend()}
            disabled={!canSend}
            aria-label="Send message"
            title="Send message"
          >
            <SendIcon />
          </button>
        </div>
      </div>
      <div className="composer-status" aria-live="polite">
        <span className={isRecording ? 'recording-dot' : ''}>{statusText}</span>
      </div>
    </footer>
  );
});
