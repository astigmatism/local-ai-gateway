import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createRecordedReferenceWav,
  flattenFloat32Chunks,
  maximumReferenceRecordingSeconds,
  type RecordedReferenceWav
} from '../lib/referenceAudioRecording.js';

export type ReferenceWavRecorderStatus = 'idle' | 'requesting-permission' | 'recording' | 'encoding' | 'canceled' | 'error';

interface UseReferenceWavRecorderOptions {
  displayName: string;
  onRecordingComplete: (recording: RecordedReferenceWav) => void | Promise<void>;
  onError: (message: string) => void;
}

type AudioContextConstructor = typeof AudioContext;
type WindowWithWebkitAudioContext = Window &
  typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor;
  };

export const referenceRecorderLevelBarCount = 48;

const processorBufferSize = 4096;
const levelUpdateIntervalMs = 45;
const errorResetDelayMs = 1200;
const canceledResetDelayMs = 500;
const elapsedUpdateIntervalMs = 250;

const createIdleAudioLevels = () => Array.from({ length: referenceRecorderLevelBarCount }, () => 0.04);

const getAudioContextConstructor = () => {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext ?? (window as WindowWithWebkitAudioContext).webkitAudioContext;
};

const stopTracks = (stream: MediaStream | null) => {
  stream?.getTracks().forEach((track) => track.stop());
};

const rmsLevel = (samples: Float32Array) => {
  if (samples.length === 0) return 0.04;
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.min(1, Math.max(0.04, Math.sqrt(sum / samples.length) * 4.5));
};

const microphoneSupportError = () => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'This browser does not support microphone recording APIs.';
  }
  if (window.isSecureContext === false) {
    return 'Microphone recording requires HTTPS or localhost.';
  }
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    return 'This browser does not support microphone recording APIs.';
  }
  if (typeof getAudioContextConstructor() !== 'function') {
    return 'This browser does not support browser-side WAV recording.';
  }
  return null;
};

const mapStartError = (error: unknown) => {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name ?? '') : '';
  const message = error && typeof error === 'object' && 'message' in error ? String((error as { message?: unknown }).message ?? '') : '';

  if (/permissions?[- ]policy|feature[- ]policy/i.test(message)) {
    return "Microphone access is blocked by the application's security policy.";
  }

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Microphone permission was denied. Allow microphone access and try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The microphone could not be started. It may be in use by another application.';
    case 'SecurityError':
      return 'Microphone recording requires HTTPS or localhost.';
    case 'AbortError':
      return 'Microphone recording was interrupted before it could start.';
    default:
      return 'Could not start microphone recording.';
  }
};

export const useReferenceWavRecorder = ({ displayName, onRecordingComplete, onError }: UseReferenceWavRecorderOptions) => {
  const [status, setStatus] = useState<ReferenceWavRecorderStatus>('idle');
  const [audioLevels, setAudioLevels] = useState<number[]>(() => createIdleAudioLevels());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const statusRef = useRef<ReferenceWavRecorderStatus>('idle');
  const finalizingRef = useRef(false);
  const startedAtRef = useRef(0);
  const startRequestIdRef = useRef(0);
  const sampleRateRef = useRef(0);
  const lastLevelUpdateRef = useRef(0);
  const elapsedTimerRef = useRef<number | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  const maxTimerRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  const displayNameRef = useRef(displayName);
  const onRecordingCompleteRef = useRef(onRecordingComplete);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    displayNameRef.current = displayName;
  }, [displayName]);

  useEffect(() => {
    onRecordingCompleteRef.current = onRecordingComplete;
  }, [onRecordingComplete]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const setRecorderStatus = useCallback((nextStatus: ReferenceWavRecorderStatus) => {
    statusRef.current = nextStatus;
    if (isMountedRef.current) setStatus(nextStatus);
  }, []);

  const clearTimers = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (elapsedTimerRef.current !== null) window.clearInterval(elapsedTimerRef.current);
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    if (maxTimerRef.current !== null) window.clearTimeout(maxTimerRef.current);
    elapsedTimerRef.current = null;
    resetTimerRef.current = null;
    maxTimerRef.current = null;
  }, []);

  const resetStatusSoon = useCallback(
    (fromStatus: ReferenceWavRecorderStatus, delayMs: number) => {
      if (typeof window === 'undefined') {
        setRecorderStatus('idle');
        return;
      }
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null;
        if (statusRef.current === fromStatus) setRecorderStatus('idle');
      }, delayMs);
    },
    [setRecorderStatus]
  );

  const disconnectAudioGraph = useCallback(() => {
    const processor = processorRef.current;
    processorRef.current = null;
    if (processor) {
      processor.onaudioprocess = null;
      try {
        processor.disconnect();
      } catch {
        // Node may already be disconnected.
      }
    }

    const source = sourceRef.current;
    sourceRef.current = null;
    try {
      source?.disconnect();
    } catch {
      // Node may already be disconnected.
    }

    const silentGain = silentGainRef.current;
    silentGainRef.current = null;
    try {
      silentGain?.disconnect();
    } catch {
      // Node may already be disconnected.
    }
  }, []);

  const cleanupStream = useCallback(() => {
    clearTimers();
    disconnectAudioGraph();
    stopTracks(streamRef.current);
    streamRef.current = null;

    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext && audioContext.state !== 'closed') {
      void audioContext.close().catch(() => undefined);
    }
  }, [clearTimers, disconnectAudioGraph]);

  const resetBuffers = useCallback(() => {
    chunksRef.current = [];
    sampleRateRef.current = 0;
    startedAtRef.current = 0;
    finalizingRef.current = false;
    lastLevelUpdateRef.current = 0;
    if (isMountedRef.current) {
      setAudioLevels(createIdleAudioLevels());
      setElapsedSeconds(0);
    }
  }, []);

  const cancelRecording = useCallback(() => {
    if (statusRef.current === 'idle') return;
    startRequestIdRef.current += 1;
    cleanupStream();
    resetBuffers();
    setRecorderStatus('canceled');
    resetStatusSoon('canceled', canceledResetDelayMs);
  }, [cleanupStream, resetBuffers, resetStatusSoon, setRecorderStatus]);

  const stopRecording = useCallback(async () => {
    if (finalizingRef.current || statusRef.current !== 'recording') return;
    finalizingRef.current = true;
    setRecorderStatus('encoding');

    const chunks = chunksRef.current.slice();
    const sampleRate = sampleRateRef.current;
    cleanupStream();
    chunksRef.current = [];

    try {
      const samples = flattenFloat32Chunks(chunks);
      if (samples.length === 0) {
        throw new Error('No audio was captured. Check your microphone and try recording again.');
      }

      const recording = createRecordedReferenceWav(samples, sampleRate, displayNameRef.current);
      if (recording.durationSeconds < 1) {
        throw new Error('The recording was too short. Record at least a few seconds of speech.');
      }

      await onRecordingCompleteRef.current(recording);
      resetBuffers();
      setRecorderStatus('idle');
    } catch (error) {
      resetBuffers();
      const message = error instanceof Error && error.message.trim() ? error.message : 'Could not prepare the reference WAV recording.';
      onErrorRef.current(message);
      setRecorderStatus('error');
      resetStatusSoon('error', errorResetDelayMs);
    }
  }, [cleanupStream, resetBuffers, resetStatusSoon, setRecorderStatus]);

  const startRecording = useCallback(async () => {
    if (statusRef.current !== 'idle') return;

    const supportError = microphoneSupportError();
    if (supportError) {
      onErrorRef.current(supportError);
      setRecorderStatus('error');
      resetStatusSoon('error', errorResetDelayMs);
      return;
    }

    const requestId = startRequestIdRef.current + 1;
    startRequestIdRef.current = requestId;
    setRecorderStatus('requesting-permission');
    resetBuffers();

    try {
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const stream = await getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: { ideal: false },
          noiseSuppression: { ideal: false },
          autoGainControl: { ideal: false }
        }
      });
      if (!isMountedRef.current || requestId !== startRequestIdRef.current) {
        stopTracks(stream);
        return;
      }

      const AudioContextCtor = getAudioContextConstructor();
      if (typeof AudioContextCtor !== 'function') {
        stopTracks(stream);
        throw new Error('This browser does not support browser-side WAV recording.');
      }

      const audioContext = new AudioContextCtor();
      await audioContext.resume().catch(() => undefined);
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(processorBufferSize, source.channelCount || 1, 1);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;

      processor.onaudioprocess = (event) => {
        if (statusRef.current !== 'recording') return;
        const inputBuffer = event.inputBuffer;
        const frameCount = inputBuffer.length;
        const channelCount = Math.max(1, inputBuffer.numberOfChannels);
        const monoSamples = new Float32Array(frameCount);

        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
          const channelData = inputBuffer.getChannelData(channelIndex);
          for (let sampleIndex = 0; sampleIndex < frameCount; sampleIndex += 1) {
            monoSamples[sampleIndex] += channelData[sampleIndex] / channelCount;
          }
        }

        chunksRef.current.push(monoSamples);

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - lastLevelUpdateRef.current >= levelUpdateIntervalMs) {
          lastLevelUpdateRef.current = now;
          const level = rmsLevel(monoSamples);
          if (isMountedRef.current) {
            setAudioLevels((current) => {
              const next = current.length === referenceRecorderLevelBarCount ? current.slice(1) : createIdleAudioLevels().slice(1);
              next.push(level);
              return next;
            });
          }
        }
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);

      streamRef.current = stream;
      audioContextRef.current = audioContext;
      sourceRef.current = source;
      processorRef.current = processor;
      silentGainRef.current = silentGain;
      sampleRateRef.current = audioContext.sampleRate;
      startedAtRef.current = Date.now();
      setRecorderStatus('recording');

      if (typeof window !== 'undefined') {
        elapsedTimerRef.current = window.setInterval(() => {
          if (startedAtRef.current && isMountedRef.current) {
            setElapsedSeconds((Date.now() - startedAtRef.current) / 1000);
          }
        }, elapsedUpdateIntervalMs);
        maxTimerRef.current = window.setTimeout(() => {
          void stopRecording();
        }, maximumReferenceRecordingSeconds * 1000);
      }
    } catch (error) {
      cleanupStream();
      resetBuffers();
      onErrorRef.current(error instanceof Error && error.message ? error.message : mapStartError(error));
      setRecorderStatus('error');
      resetStatusSoon('error', errorResetDelayMs);
    }
  }, [cleanupStream, resetBuffers, resetStatusSoon, setRecorderStatus, stopRecording]);

  useEffect(
    () => () => {
      isMountedRef.current = false;
      startRequestIdRef.current += 1;
      cleanupStream();
      resetBuffers();
    },
    [cleanupStream, resetBuffers]
  );

  return {
    status,
    audioLevels,
    elapsedSeconds,
    isRequestingPermission: status === 'requesting-permission',
    isRecording: status === 'recording',
    isEncoding: status === 'encoding',
    startRecording,
    stopRecording,
    cancelRecording
  };
};
