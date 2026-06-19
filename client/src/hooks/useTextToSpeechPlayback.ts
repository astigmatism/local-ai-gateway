import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiClientError } from '../lib/api.js';
import { normalizeTextForSpeech } from '../lib/speechText.js';
import { normalizeUserTtsPreference, ttsSpeakOptionsFromPreference } from '../lib/ttsPreferences.js';

export type TextToSpeechMessageState = 'idle' | 'loading' | 'playing' | 'error';

interface SpeechErrorState {
  messageId: string;
  message: string;
}

const errorMessageForSpeech = (error: unknown) => {
  if (error instanceof ApiClientError) {
    if (error.status === 502 || error.status === 503) return error.message || 'The selected TTS provider is unavailable.';
    if (error.status === 504) return error.message || 'The selected TTS provider timed out.';
    return error.message || 'Could not generate speech.';
  }

  if (error instanceof Error) return error.message || 'Could not generate speech.';
  return 'Could not generate speech.';
};

export const useTextToSpeechPlayback = (resetKey: string | null | undefined) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const errorTimerRef = useRef<number | null>(null);
  const [loadingMessageId, setLoadingMessageId] = useState<string | null>(null);
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  const [speechError, setSpeechError] = useState<SpeechErrorState | null>(null);

  const clearSpeechError = useCallback(() => {
    if (errorTimerRef.current) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    setSpeechError(null);
  }, []);

  const showSpeechError = useCallback((messageId: string, message: string) => {
    if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current);
    setSpeechError({ messageId, message });
    errorTimerRef.current = window.setTimeout(() => {
      setSpeechError((current) => (current?.messageId === messageId ? null : current));
      errorTimerRef.current = null;
    }, 5000);
  }, []);

  const stopPlaybackResources = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
      audioRef.current = null;
    }

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const stopSpeaking = useCallback(() => {
    requestIdRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    stopPlaybackResources();
    setLoadingMessageId(null);
    setPlayingMessageId(null);
  }, [stopPlaybackResources]);

  const speakMessage = useCallback(
    async (messageId: string, content: string) => {
      if (playingMessageId === messageId || loadingMessageId === messageId) {
        stopSpeaking();
        return;
      }

      const speechText = normalizeTextForSpeech(content);
      if (!speechText) {
        showSpeechError(messageId, 'There is no text to speak.');
        return;
      }

      stopSpeaking();
      clearSpeechError();

      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setLoadingMessageId(messageId);

      try {
        const preference = normalizeUserTtsPreference(await api.getVoiceTtsPreference());
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;

        const audioBlob = await api.speakText(speechText, {
          ...ttsSpeakOptionsFromPreference(preference),
          signal: controller.signal
        });
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;

        const objectUrl = URL.createObjectURL(audioBlob);
        objectUrlRef.current = objectUrl;

        const audio = new Audio(objectUrl);
        audioRef.current = audio;
        audio.onended = () => {
          if (requestIdRef.current !== requestId) return;
          stopPlaybackResources();
          setPlayingMessageId(null);
        };
        audio.onerror = () => {
          if (requestIdRef.current !== requestId) return;
          stopPlaybackResources();
          setPlayingMessageId(null);
          showSpeechError(messageId, 'Audio playback failed.');
        };

        setLoadingMessageId(null);
        setPlayingMessageId(messageId);
        await audio.play();
      } catch (error) {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;

        stopPlaybackResources();
        setLoadingMessageId(null);
        setPlayingMessageId(null);
        showSpeechError(messageId, errorMessageForSpeech(error));
      }
    },
    [clearSpeechError, loadingMessageId, playingMessageId, showSpeechError, stopPlaybackResources, stopSpeaking]
  );

  const getMessageSpeechState = useCallback(
    (messageId: string): TextToSpeechMessageState => {
      if (loadingMessageId === messageId) return 'loading';
      if (playingMessageId === messageId) return 'playing';
      if (speechError?.messageId === messageId) return 'error';
      return 'idle';
    },
    [loadingMessageId, playingMessageId, speechError]
  );

  useEffect(() => {
    stopSpeaking();
    clearSpeechError();
  }, [clearSpeechError, resetKey, stopSpeaking]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      stopPlaybackResources();
      if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current);
    },
    [stopPlaybackResources]
  );

  return {
    speakMessage,
    stopSpeaking,
    getMessageSpeechState,
    speechError
  };
};
