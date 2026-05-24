import { useCallback, useEffect, useRef, useState } from 'react';

interface UseAudioRecorderOptions {
  onRecordingComplete: (blob: Blob) => void;
  onError: (message: string) => void;
}

const preferredMimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/wav'];

export const useAudioRecorder = ({ onRecordingComplete, onError }: UseAudioRecorderOptions) => {
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    setIsRecording(false);
  }, []);

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      onError('This browser does not expose microphone recording APIs.');
      return;
    }

    if (typeof MediaRecorder === 'undefined') {
      onError('This browser does not support MediaRecorder.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        onError('Browser recording failed. Check microphone permission and try again.');
        cleanup();
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        cleanup();
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
      onError(error instanceof Error ? error.message : 'Could not start microphone recording.');
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
