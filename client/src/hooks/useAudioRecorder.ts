import { useCallback, useEffect, useRef, useState } from 'react';
import {
  calculateAudioLevelFromTimeDomainData,
  getBrowserAudioRecordingEnvironment,
  getMicrophoneRecordingSupportError,
  getTranscriptionFailureMessage,
  mapMicrophoneStartError,
  microphoneRecordingErrors,
  selectSupportedAudioMimeType,
  shouldShowUserCanceledRecordingStatus,
  shouldStoreRecordingChunk,
  shouldTranscribeRecordingStop
} from '../lib/audioRecording.js';
import type { AudioRecordingStopReason } from '../lib/audioRecording.js';

export type AudioRecordingStatus =
  | 'idle'
  | 'requesting-permission'
  | 'listening'
  | 'stopping'
  | 'transcribing'
  | 'canceled'
  | 'error';

type AudioContextConstructor = typeof AudioContext;
type WindowWithWebkitAudioContext = Window &
  typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor;
  };

interface UseAudioRecorderOptions {
  onRecordingComplete: (blob: Blob) => void | Promise<void>;
  onError: (message: string) => void;
}

export const audioLevelBarCount = 64;
const visualizerFrameIntervalMs = 45;
const canceledStatusResetDelayMs = 350;
const errorStatusResetDelayMs = 1100;

const createIdleAudioLevels = () => Array.from({ length: audioLevelBarCount }, () => 0.04);

const stopTracks = (stream: MediaStream | null) => {
  stream?.getTracks().forEach((track) => track.stop());
};

const waitForPendingRecorderEvents = () =>
  new Promise<void>((resolve) => {
    if (typeof window === 'undefined') {
      resolve();
      return;
    }

    window.setTimeout(resolve, 0);
  });

export const useAudioRecorder = ({ onRecordingComplete, onError }: UseAudioRecorderOptions) => {
  const [status, setStatus] = useState<AudioRecordingStatus>('idle');
  const [audioLevels, setAudioLevels] = useState<number[]>(() => createIdleAudioLevels());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingFailedRef = useRef(false);
  const stopReasonRef = useRef<AudioRecordingStopReason | null>(null);
  const actionInProgressRef = useRef(false);
  const statusRef = useRef<AudioRecordingStatus>('idle');
  const startRequestIdRef = useRef(0);
  const isMountedRef = useRef(true);
  const statusResetTimerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastVisualizerUpdateRef = useRef(0);
  const onRecordingCompleteRef = useRef(onRecordingComplete);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onRecordingCompleteRef.current = onRecordingComplete;
  }, [onRecordingComplete]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const setRecorderStatus = useCallback((nextStatus: AudioRecordingStatus) => {
    statusRef.current = nextStatus;
    if (isMountedRef.current) {
      setStatus(nextStatus);
    }
  }, []);

  const clearStatusResetTimer = useCallback(() => {
    if (statusResetTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(statusResetTimerRef.current);
    }
    statusResetTimerRef.current = null;
  }, []);

  const transitionToIdleSoon = useCallback(
    (fromStatus: AudioRecordingStatus, delayMs: number) => {
      clearStatusResetTimer();

      if (typeof window === 'undefined') {
        setRecorderStatus('idle');
        return;
      }

      statusResetTimerRef.current = window.setTimeout(() => {
        statusResetTimerRef.current = null;
        if (statusRef.current === fromStatus) {
          setRecorderStatus('idle');
        }
      }, delayMs);
    },
    [clearStatusResetTimer, setRecorderStatus]
  );

  const stopVisualizer = useCallback(() => {
    if (animationFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(animationFrameRef.current);
    }
    animationFrameRef.current = null;
    lastVisualizerUpdateRef.current = 0;

    const sourceNode = sourceNodeRef.current;
    sourceNodeRef.current = null;
    try {
      sourceNode?.disconnect();
    } catch {
      // The node may already be disconnected by the browser.
    }

    const analyser = analyserRef.current;
    analyserRef.current = null;
    try {
      analyser?.disconnect();
    } catch {
      // The node may already be disconnected by the browser.
    }

    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext && audioContext.state !== 'closed') {
      void audioContext.close().catch(() => undefined);
    }

    if (isMountedRef.current) {
      setAudioLevels(createIdleAudioLevels());
    }
  }, []);

  const stopMediaStream = useCallback(() => {
    stopTracks(streamRef.current);
    streamRef.current = null;
  }, []);

  const resetRecordingRefs = useCallback(() => {
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    recordingFailedRef.current = false;
    stopReasonRef.current = null;
    actionInProgressRef.current = false;
  }, []);

  const startVisualizer = useCallback(
    (stream: MediaStream) => {
      stopVisualizer();

      if (typeof window === 'undefined') return;

      const AudioContextCtor = window.AudioContext ?? (window as WindowWithWebkitAudioContext).webkitAudioContext;
      if (typeof AudioContextCtor !== 'function') return;

      try {
        const audioContext = new AudioContextCtor();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.78;

        const sourceNode = audioContext.createMediaStreamSource(stream);
        sourceNode.connect(analyser);

        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        sourceNodeRef.current = sourceNode;

        const timeDomainData = new Uint8Array(analyser.fftSize);

        const updateAudioLevels = (timestamp: number) => {
          if (!analyserRef.current) return;

          animationFrameRef.current = window.requestAnimationFrame(updateAudioLevels);

          if (timestamp - lastVisualizerUpdateRef.current < visualizerFrameIntervalMs) return;
          lastVisualizerUpdateRef.current = timestamp;

          analyserRef.current.getByteTimeDomainData(timeDomainData);
          const level = calculateAudioLevelFromTimeDomainData(timeDomainData);

          setAudioLevels((currentLevels) => {
            const nextLevels = currentLevels.length === audioLevelBarCount ? currentLevels.slice(1) : createIdleAudioLevels().slice(1);
            nextLevels.push(level);
            return nextLevels;
          });
        };

        void audioContext.resume().catch(() => undefined);
        animationFrameRef.current = window.requestAnimationFrame(updateAudioLevels);
      } catch {
        stopVisualizer();
      }
    },
    [stopVisualizer]
  );

  const finishRecorderStop = useCallback(
    async (recorder: MediaRecorder, fallbackMimeType?: string) => {
      if (mediaRecorderRef.current !== recorder) return;

      await waitForPendingRecorderEvents();

      if (mediaRecorderRef.current !== recorder) return;

      const stopReason = stopReasonRef.current;
      const recordingFailed = recordingFailedRef.current;
      const shouldTranscribe = shouldTranscribeRecordingStop(stopReason, recordingFailed);
      const shouldShowCanceledStatus = shouldShowUserCanceledRecordingStatus(stopReason);
      const stoppedStatus = statusRef.current;
      const chunkMimeType = chunksRef.current.find((chunk) => chunk.type)?.type;
      const blobType = recorder.mimeType || chunkMimeType || fallbackMimeType || undefined;
      const chunks = chunksRef.current.slice();
      const blob = shouldTranscribe
        ? new Blob(chunks, blobType ? { type: blobType } : undefined)
        : null;

      stopVisualizer();
      stopMediaStream();
      resetRecordingRefs();

      if (!shouldTranscribe) {
        if (shouldShowCanceledStatus && stoppedStatus === 'canceled') {
          transitionToIdleSoon('canceled', canceledStatusResetDelayMs);
        } else if (stoppedStatus === 'error' || stopReason === 'error') {
          transitionToIdleSoon('error', errorStatusResetDelayMs);
        } else {
          setRecorderStatus('idle');
        }
        return;
      }

      if (!blob || blob.size <= 0) {
        onErrorRef.current(microphoneRecordingErrors.noAudioCaptured);
        setRecorderStatus('error');
        transitionToIdleSoon('error', errorStatusResetDelayMs);
        return;
      }

      setRecorderStatus('transcribing');

      try {
        await onRecordingCompleteRef.current(blob);
        if (statusRef.current === 'transcribing') {
          setRecorderStatus('idle');
        }
      } catch (error) {
        onErrorRef.current(getTranscriptionFailureMessage(error));
        setRecorderStatus('error');
        transitionToIdleSoon('error', errorStatusResetDelayMs);
      }
    },
    [resetRecordingRefs, setRecorderStatus, stopMediaStream, stopVisualizer, transitionToIdleSoon]
  );

  const failRecording = useCallback(
    (message: string) => {
      stopReasonRef.current = 'error';
      stopVisualizer();
      stopMediaStream();
      resetRecordingRefs();
      onErrorRef.current(message);
      setRecorderStatus('error');
      transitionToIdleSoon('error', errorStatusResetDelayMs);
    },
    [resetRecordingRefs, setRecorderStatus, stopMediaStream, stopVisualizer, transitionToIdleSoon]
  );

  const settlePendingStart = useCallback(
    (reason: AudioRecordingStopReason) => {
      startRequestIdRef.current += 1;
      clearStatusResetTimer();
      stopReasonRef.current = reason;
      stopVisualizer();
      stopMediaStream();
      resetRecordingRefs();

      if (reason === 'cancel') {
        setRecorderStatus('canceled');
        transitionToIdleSoon('canceled', canceledStatusResetDelayMs);
        return;
      }

      setRecorderStatus('idle');
    },
    [clearStatusResetTimer, resetRecordingRefs, setRecorderStatus, stopMediaStream, stopVisualizer, transitionToIdleSoon]
  );

  const requestRecorderStop = useCallback(
    (reason: AudioRecordingStopReason) => {
      if (actionInProgressRef.current || statusRef.current !== 'listening') return;

      const recorder = mediaRecorderRef.current;
      if (!recorder) {
        stopReasonRef.current = reason;
        stopVisualizer();
        stopMediaStream();
        resetRecordingRefs();
        setRecorderStatus(reason === 'cancel' ? 'canceled' : 'idle');
        if (reason === 'cancel') transitionToIdleSoon('canceled', canceledStatusResetDelayMs);
        return;
      }

      actionInProgressRef.current = true;
      stopReasonRef.current = reason;
      clearStatusResetTimer();

      if (reason === 'accept') {
        setRecorderStatus('stopping');
      } else if (reason === 'cancel') {
        setRecorderStatus('canceled');
      } else if (reason === 'error') {
        setRecorderStatus('error');
      } else {
        setRecorderStatus('idle');
      }

      stopVisualizer();

      try {
        if (reason === 'accept') {
          recorder.requestData();
        }
      } catch {
        // requestData can throw if the browser has already stopped the recorder.
      }

      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        } else {
          void finishRecorderStop(recorder);
        }
      } catch {
        recordingFailedRef.current = true;
        stopReasonRef.current = 'error';
        onErrorRef.current(microphoneRecordingErrors.recordingFailed);
        setRecorderStatus('error');
        void finishRecorderStop(recorder);
      } finally {
        if (reason !== 'accept') {
          stopMediaStream();
        }
      }
    },
    [clearStatusResetTimer, finishRecorderStop, resetRecordingRefs, setRecorderStatus, stopMediaStream, stopVisualizer, transitionToIdleSoon]
  );

  const startRecording = useCallback(async () => {
    if (statusRef.current !== 'idle') return;

    clearStatusResetTimer();
    setRecorderStatus('requesting-permission');

    const environment = getBrowserAudioRecordingEnvironment();
    const supportError = getMicrophoneRecordingSupportError(environment);

    if (supportError) {
      failRecording(supportError);
      return;
    }

    const getUserMedia = environment?.mediaDevices?.getUserMedia?.bind(environment.mediaDevices);
    const MediaRecorderCtor = environment?.MediaRecorder;

    if (!getUserMedia || typeof MediaRecorderCtor !== 'function') {
      failRecording(microphoneRecordingErrors.unsupportedBrowser);
      return;
    }

    const requestId = startRequestIdRef.current + 1;
    startRequestIdRef.current = requestId;

    try {
      recordingFailedRef.current = false;
      stopReasonRef.current = null;
      actionInProgressRef.current = false;
      chunksRef.current = [];

      const stream = await getUserMedia({ audio: true });

      if (!isMountedRef.current || requestId !== startRequestIdRef.current) {
        stopTracks(stream);
        return;
      }

      streamRef.current = stream;

      const mimeType = selectSupportedAudioMimeType(MediaRecorderCtor);
      const recorder = new MediaRecorderCtor(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && shouldStoreRecordingChunk(stopReasonRef.current)) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        if (recordingFailedRef.current) return;

        recordingFailedRef.current = true;
        stopReasonRef.current = 'error';
        const recorderError = (event as Event & { error?: unknown }).error;
        onErrorRef.current(recorderError ? mapMicrophoneStartError(recorderError) : microphoneRecordingErrors.recordingFailed);
        setRecorderStatus('error');
        stopVisualizer();
        stopMediaStream();

        try {
          if (recorder.state !== 'inactive') {
            recorder.stop();
          } else {
            void finishRecorderStop(recorder, mimeType);
          }
        } catch {
          void finishRecorderStop(recorder, mimeType);
        }
      };

      recorder.onstop = () => {
        void finishRecorderStop(recorder, mimeType);
      };

      startVisualizer(stream);
      recorder.start();
      setRecorderStatus('listening');
    } catch (error) {
      if (!isMountedRef.current || requestId !== startRequestIdRef.current) return;
      failRecording(mapMicrophoneStartError(error, environment));
    }
  }, [clearStatusResetTimer, failRecording, finishRecorderStop, setRecorderStatus, startVisualizer, stopMediaStream, stopVisualizer]);

  const stopRecording = useCallback(() => {
    requestRecorderStop('accept');
  }, [requestRecorderStop]);

  const cancelRecording = useCallback(() => {
    if (statusRef.current === 'requesting-permission') {
      settlePendingStart('cancel');
      return;
    }

    requestRecorderStop('cancel');
  }, [requestRecorderStop, settlePendingStart]);

  const cleanupRecording = useCallback(() => {
    if (statusRef.current === 'requesting-permission') {
      settlePendingStart('cleanup');
      return;
    }

    if (statusRef.current === 'listening') {
      requestRecorderStop('cleanup');
    }
  }, [requestRecorderStop, settlePendingStart]);

  const toggleRecording = useCallback(() => {
    if (statusRef.current === 'listening') {
      stopRecording();
      return;
    }
    void startRecording();
  }, [startRecording, stopRecording]);

  useEffect(
    () => () => {
      isMountedRef.current = false;
      startRequestIdRef.current += 1;
      clearStatusResetTimer();
      stopReasonRef.current = 'cleanup';
      stopVisualizer();
      stopMediaStream();

      const recorder = mediaRecorderRef.current;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;

        if (recorder.state !== 'inactive') {
          try {
            recorder.stop();
          } catch {
            // The component is unmounting, so there is nothing else to surface.
          }
        }
      }

      resetRecordingRefs();
    },
    [clearStatusResetTimer, resetRecordingRefs, stopMediaStream, stopVisualizer]
  );

  return {
    status,
    audioLevels,
    isRecording: status === 'listening' || status === 'stopping',
    isListening: status === 'listening',
    isRequestingPermission: status === 'requesting-permission',
    isTranscribing: status === 'transcribing',
    startRecording,
    stopRecording,
    cancelRecording,
    cleanupRecording,
    toggleRecording
  };
};
