import type { CSSProperties } from 'react';
import type { AudioRecordingStatus } from '../hooks/useAudioRecorder.js';

interface VoiceCaptureControlsProps {
  status: AudioRecordingStatus;
  audioLevels: number[];
  onCancel: () => void;
  onStop: () => void;
}

const fallbackLevels = Array.from({ length: 24 }, () => 0.04);

const XIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L10.94 12l-5.72 5.72a.75.75 0 1 0 1.06 1.06L12 13.06l5.72 5.72a.75.75 0 1 0 1.06-1.06L13.06 12l5.72-5.72a.75.75 0 0 0-1.06-1.06L12 10.94 6.28 5.22Z" />
  </svg>
);

const StopIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M8.25 6.75h7.5a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-7.5a1.5 1.5 0 0 1-1.5-1.5v-7.5a1.5 1.5 0 0 1 1.5-1.5Z" />
  </svg>
);

const getVoiceCaptureLabel = (status: AudioRecordingStatus) => {
  switch (status) {
    case 'stopping':
      return 'Stopping…';
    case 'canceled':
      return 'Recording canceled';
    default:
      return 'Listening…';
  }
};

const clampLevel = (level: number) => Math.min(1, Math.max(0.12, Number.isFinite(level) ? level : 0.12));

export const VoiceCaptureControls = ({ status, audioLevels, onCancel, onStop }: VoiceCaptureControlsProps) => {
  const levels = audioLevels.length > 0 ? audioLevels : fallbackLevels;
  const controlsDisabled = status !== 'listening';
  const label = getVoiceCaptureLabel(status);

  return (
    <div
      className="voice-capture-panel"
      aria-label="Voice recording controls"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="voice-capture-state" aria-live="polite">
        <span className="voice-capture-pulse" aria-hidden="true" />
        <span>{label}</span>
      </div>

      <div className="voice-level-meter" aria-hidden="true">
        {levels.map((level, index) => (
          <span
            // The index is stable because this is a fixed-width live meter history.
            key={index}
            style={{ '--voice-level-scale': clampLevel(level).toFixed(3) } as CSSProperties}
          />
        ))}
      </div>

      <div className="voice-capture-actions">
        <button
          className="voice-capture-button voice-capture-cancel"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onCancel();
          }}
          disabled={controlsDisabled}
          aria-label="Cancel recording"
          title="Cancel recording"
        >
          <XIcon />
          <span>Cancel</span>
        </button>
        <button
          className="voice-capture-button voice-capture-stop"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onStop();
          }}
          disabled={controlsDisabled}
          aria-label="Stop recording and transcribe"
          title="Stop recording and transcribe"
        >
          <StopIcon />
          <span>Stop</span>
        </button>
      </div>
    </div>
  );
};
