import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getBrowserAudioRecordingEnvironment,
  getMicrophoneRecordingSupportError,
  mapMicrophoneStartError,
  microphoneRecordingErrors,
  selectSupportedAudioMimeType
} from '../lib/audioRecording.js';

interface UseAudioRecorderOptions {
  onRecordingComplete: (blob: Blob) => void;
  onError: (message: string) => void;
}

export const useAudioRecorder = ({ onRecordingComplete, onError }: UseAudioRecorderOptions) => {
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingFailedRef = useRef(false);

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setIsRecording(false);
  }, []);

  const startRecording = useCallback(async () => {
    const environment = getBrowserAudioRecordingEnvironment();
    const supportError = getMicrophoneRecordingSupportError(environment);

    if (supportError) {
      onError(supportError);
      return;
    }

    const getUserMedia = environment?.mediaDevices?.getUserMedia?.bind(environment.mediaDevices);
    const MediaRecorderCtor = environment?.MediaRecorder;

    if (!getUserMedia || typeof MediaRecorderCtor !== 'function') {
      onError(microphoneRecordingErrors.unsupportedBrowser);
      return;
    }

    try {
      recordingFailedRef.current = false;
      const stream = await getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = selectSupportedAudioMimeType(MediaRecorderCtor);
      const recorder = new MediaRecorderCtor(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        recordingFailedRef.current = true;
        const recorderError = (event as Event & { error?: unknown }).error;
        onError(recorderError ? mapMicrophoneStartError(recorderError) : microphoneRecordingErrors.recordingFailed);
        cleanup();
      };

      recorder.onstop = () => {
        const recordingFailed = recordingFailedRef.current;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
        cleanup();

        if (recordingFailed) return;

        if (blob.size > 0) {
          onRecordingComplete(blob);
        } else {
          onError('No audio was captured. Try recording a longer snippet.');
        }
      };

      recorder.start();
      setIsRecording(true);
    } catch (error) {
      cleanup();
      onError(mapMicrophoneStartError(error, environment));
    }
  }, [cleanup, onError, onRecordingComplete]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  }, []);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
      return;
    }
    void startRecording();
  }, [isRecording, startRecording, stopRecording]);

  useEffect(() => cleanup, [cleanup]);

  return {
    isRecording,
    startRecording,
    stopRecording,
    toggleRecording
  };
};
