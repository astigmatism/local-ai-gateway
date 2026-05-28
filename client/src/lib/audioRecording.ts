export const preferredAudioMimeTypes = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/aac',
  'audio/ogg;codecs=opus',
  'audio/ogg'
] as const;

export const microphoneRecordingErrors = {
  unsupportedBrowser: 'This browser does not support microphone recording APIs.',
  insecureContext: 'Microphone recording requires HTTPS or localhost.',
  permissionDenied: 'Microphone permission was denied. Allow microphone access and try again.',
  noMicrophone: 'No microphone was found.',
  microphoneUnavailable: 'The microphone could not be started. It may be in use by another application.',
  securityPolicy: "Microphone access is blocked by the application's security policy.",
  constraints: 'No microphone matched the requested recording constraints.',
  aborted: 'Microphone recording was interrupted before it could start.',
  unsupportedRecordingFormat: 'This browser recording format is not supported.',
  startFailed: 'Could not start microphone recording.',
  recordingFailed: 'Browser recording failed. Try again.',
  noAudioCaptured: 'No audio was captured.',
  transcriptionFailed: 'Could not transcribe audio.'
} as const;

export type AudioRecordingStopReason = 'accept' | 'cancel' | 'cleanup' | 'error';

type MediaRecorderSupport = Pick<typeof MediaRecorder, 'isTypeSupported'>;

type FeaturePolicyLike = {
  allowsFeature?: (feature: string) => boolean;
};

type DocumentWithFeaturePolicy = Document & {
  permissionsPolicy?: FeaturePolicyLike;
  featurePolicy?: FeaturePolicyLike;
};

export interface BrowserAudioRecordingEnvironment {
  isSecureContext?: boolean;
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  MediaRecorder?: typeof MediaRecorder;
  document?: Document;
}

const getErrorName = (error: unknown) => {
  if (!error || typeof error !== 'object' || !('name' in error)) return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
};

const getErrorMessage = (error: unknown) => {
  if (!error || typeof error !== 'object' || !('message' in error)) return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
};

export const shouldTranscribeRecordingStop = (stopReason: AudioRecordingStopReason | null, recordingFailed: boolean) =>
  stopReason === 'accept' && !recordingFailed;

export const shouldStoreRecordingChunk = (stopReason: AudioRecordingStopReason | null) =>
  stopReason !== 'cancel' && stopReason !== 'cleanup' && stopReason !== 'error';

export const shouldShowUserCanceledRecordingStatus = (stopReason: AudioRecordingStopReason | null) => stopReason === 'cancel';

export const getBrowserAudioRecordingEnvironment = (): BrowserAudioRecordingEnvironment | null => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;

  return {
    isSecureContext: window.isSecureContext,
    mediaDevices: navigator.mediaDevices,
    MediaRecorder: typeof window.MediaRecorder === 'undefined' ? undefined : window.MediaRecorder,
    document: typeof document === 'undefined' ? undefined : document
  };
};

export const isMicrophoneBlockedByDocumentPolicy = (documentRef?: Document) => {
  const documentWithPolicy = documentRef as DocumentWithFeaturePolicy | undefined;
  const policy = documentWithPolicy?.permissionsPolicy ?? documentWithPolicy?.featurePolicy;

  if (typeof policy?.allowsFeature !== 'function') return false;

  try {
    return policy.allowsFeature('microphone') === false;
  } catch {
    return false;
  }
};

export const getMicrophoneRecordingSupportError = (
  environment: BrowserAudioRecordingEnvironment | null = getBrowserAudioRecordingEnvironment()
) => {
  if (!environment) return microphoneRecordingErrors.unsupportedBrowser;

  if (environment.isSecureContext === false) return microphoneRecordingErrors.insecureContext;

  if (isMicrophoneBlockedByDocumentPolicy(environment.document)) return microphoneRecordingErrors.securityPolicy;

  if (typeof environment.mediaDevices?.getUserMedia !== 'function') {
    return microphoneRecordingErrors.unsupportedBrowser;
  }

  if (typeof environment.MediaRecorder !== 'function') return microphoneRecordingErrors.unsupportedBrowser;

  return null;
};

export const selectSupportedAudioMimeType = (
  mediaRecorder: MediaRecorderSupport | undefined,
  candidates: readonly string[] = preferredAudioMimeTypes
) => {
  if (typeof mediaRecorder?.isTypeSupported !== 'function') return undefined;

  return candidates.find((mimeType) => {
    try {
      return mediaRecorder.isTypeSupported(mimeType);
    } catch {
      return false;
    }
  });
};

const audioMimeTypeExtensionMap: Record<string, string> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac'
};

export const audioMimeTypeToFileExtension = (mimeType: string | undefined | null) => {
  const normalizedMimeType = mimeType?.split(';')[0]?.trim().toLowerCase();
  if (!normalizedMimeType) return 'dat';

  const knownExtension = audioMimeTypeExtensionMap[normalizedMimeType];
  if (knownExtension) return knownExtension;

  if (normalizedMimeType.startsWith('audio/')) {
    const subtype = normalizedMimeType.slice('audio/'.length).replace(/^x-/, '').replace(/[^a-z0-9]/g, '');
    return subtype || 'dat';
  }

  return 'dat';
};

export const getTranscriptionFailureMessage = (error: unknown) => {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) return message;
  }

  return microphoneRecordingErrors.transcriptionFailed;
};

export const calculateAudioLevelFromTimeDomainData = (
  data: Uint8Array,
  options: { sensitivity?: number; noiseFloor?: number } = {}
) => {
  const sensitivity = options.sensitivity ?? 4.5;
  const noiseFloor = options.noiseFloor ?? 0.04;

  if (data.length === 0) return noiseFloor;

  let sumOfSquares = 0;
  for (const sample of data) {
    const centeredSample = (sample - 128) / 128;
    sumOfSquares += centeredSample * centeredSample;
  }

  const rms = Math.sqrt(sumOfSquares / data.length);
  return Math.min(1, Math.max(noiseFloor, rms * sensitivity));
};

export const mapMicrophoneStartError = (
  error: unknown,
  environment: BrowserAudioRecordingEnvironment | null = getBrowserAudioRecordingEnvironment()
) => {
  if (environment?.isSecureContext === false) return microphoneRecordingErrors.insecureContext;
  if (isMicrophoneBlockedByDocumentPolicy(environment?.document)) return microphoneRecordingErrors.securityPolicy;

  const name = getErrorName(error);
  const message = getErrorMessage(error);

  if (/permissions?[- ]policy|feature[- ]policy/i.test(message)) {
    return microphoneRecordingErrors.securityPolicy;
  }

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return microphoneRecordingErrors.permissionDenied;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return microphoneRecordingErrors.noMicrophone;
    case 'NotReadableError':
    case 'TrackStartError':
      return microphoneRecordingErrors.microphoneUnavailable;
    case 'SecurityError':
      return microphoneRecordingErrors.securityPolicy;
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return microphoneRecordingErrors.constraints;
    case 'AbortError':
      return microphoneRecordingErrors.aborted;
    case 'NotSupportedError':
      return microphoneRecordingErrors.unsupportedRecordingFormat;
    default:
      return microphoneRecordingErrors.startFailed;
  }
};
