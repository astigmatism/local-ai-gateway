import { describe, expect, it, vi } from 'vitest';
import {
  calculateAudioLevelFromTimeDomainData,
  audioMimeTypeToFileExtension,
  getMicrophoneRecordingSupportError,
  getSupportedAudioMimeTypes,
  getTranscriptionFailureMessage,
  mapMicrophoneStartError,
  microphoneRecordingErrors,
  selectSupportedAudioMimeType,
  shouldShowUserCanceledRecordingStatus,
  shouldStoreRecordingChunk,
  shouldTranscribeRecordingStop
} from '../client/src/lib/audioRecording.js';
import type { BrowserAudioRecordingEnvironment } from '../client/src/lib/audioRecording.js';

const makeMediaDevices = () =>
  ({
    getUserMedia: vi.fn()
  }) as unknown as Pick<MediaDevices, 'getUserMedia'>;

const makeMediaRecorder = (supportedTypes: string[] = []) => {
  class MockMediaRecorder {
    static isTypeSupported = vi.fn((mimeType: string) => supportedTypes.includes(mimeType));
  }

  return MockMediaRecorder as unknown as typeof MediaRecorder;
};

const makeSupportedEnvironment = (
  overrides: Partial<BrowserAudioRecordingEnvironment> = {}
): BrowserAudioRecordingEnvironment => ({
  isSecureContext: true,
  mediaDevices: makeMediaDevices(),
  MediaRecorder: makeMediaRecorder(['audio/webm;codecs=opus']),
  ...overrides
});

describe('audio recording browser support detection', () => {
  it('reports supported when getUserMedia and MediaRecorder are available in a secure context', () => {
    expect(getMicrophoneRecordingSupportError(makeSupportedEnvironment())).toBeNull();
  });

  it('reports insecure contexts separately from unsupported browser APIs', () => {
    expect(
      getMicrophoneRecordingSupportError(
        makeSupportedEnvironment({ isSecureContext: false, mediaDevices: undefined, MediaRecorder: undefined })
      )
    ).toBe(microphoneRecordingErrors.insecureContext);
  });

  it('reports missing getUserMedia as unsupported browser APIs', () => {
    expect(getMicrophoneRecordingSupportError(makeSupportedEnvironment({ mediaDevices: undefined }))).toBe(
      microphoneRecordingErrors.unsupportedBrowser
    );
  });

  it('reports missing MediaRecorder as unsupported browser APIs', () => {
    expect(getMicrophoneRecordingSupportError(makeSupportedEnvironment({ MediaRecorder: undefined }))).toBe(
      microphoneRecordingErrors.unsupportedBrowser
    );
  });

  it('does not treat unsupported preferred MIME types as missing microphone APIs', () => {
    const MediaRecorder = makeMediaRecorder([]);

    expect(getMicrophoneRecordingSupportError(makeSupportedEnvironment({ MediaRecorder }))).toBeNull();
    expect(selectSupportedAudioMimeType(MediaRecorder)).toBeUndefined();
  });

  it('selects the first supported recording MIME type', () => {
    const MediaRecorder = makeMediaRecorder(['audio/webm']);

    expect(selectSupportedAudioMimeType(MediaRecorder)).toBe('audio/webm');
    expect(getSupportedAudioMimeTypes(MediaRecorder)).toEqual(['audio/webm']);
  });

  it('selects iOS-compatible MP4 or AAC recording MIME types when WebM is not supported', () => {
    expect(selectSupportedAudioMimeType(makeMediaRecorder(['audio/mp4']))).toBe('audio/mp4');
    expect(selectSupportedAudioMimeType(makeMediaRecorder(['audio/mp4;codecs=mp4a.40.2']))).toBe(
      'audio/mp4;codecs=mp4a.40.2'
    );
    expect(
      selectSupportedAudioMimeType(makeMediaRecorder(['audio/mp4', 'audio/mp4;codecs=mp4a.40.2']))
    ).toBe('audio/mp4;codecs=mp4a.40.2');
    expect(selectSupportedAudioMimeType(makeMediaRecorder(['audio/aac']))).toBe('audio/aac');
  });

  it('maps recording MIME types to matching file extensions', () => {
    expect(audioMimeTypeToFileExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(audioMimeTypeToFileExtension('audio/mp4')).toBe('m4a');
    expect(audioMimeTypeToFileExtension('video/mp4')).toBe('mp4');
    expect(audioMimeTypeToFileExtension('audio/aac')).toBe('aac');
    expect(audioMimeTypeToFileExtension('audio/mpeg')).toBe('mp3');
    expect(audioMimeTypeToFileExtension('audio/wav')).toBe('wav');
    expect(audioMimeTypeToFileExtension('audio/ogg;codecs=opus')).toBe('ogg');
    expect(audioMimeTypeToFileExtension(undefined)).toBe('dat');
    expect(audioMimeTypeToFileExtension('application/octet-stream')).toBe('dat');
  });

  it('maps permission denial to a permission-specific message', () => {
    expect(mapMicrophoneStartError(new DOMException('Permission denied', 'NotAllowedError'), makeSupportedEnvironment())).toBe(
      microphoneRecordingErrors.permissionDenied
    );
  });

  it('maps missing devices to a no-microphone message', () => {
    expect(mapMicrophoneStartError(new DOMException('No devices found', 'NotFoundError'), makeSupportedEnvironment())).toBe(
      microphoneRecordingErrors.noMicrophone
    );
  });

  it('maps unsupported recorder formats to a format-specific message', () => {
    expect(
      mapMicrophoneStartError(new DOMException('Unsupported MIME type', 'NotSupportedError'), makeSupportedEnvironment())
    ).toBe(microphoneRecordingErrors.unsupportedRecordingFormat);
  });

  it('maps document Permissions-Policy blocks to a security-policy message', () => {
    const policyDocument = {
      permissionsPolicy: {
        allowsFeature: vi.fn(() => false)
      }
    } as unknown as Document;

    expect(getMicrophoneRecordingSupportError(makeSupportedEnvironment({ document: policyDocument }))).toBe(
      microphoneRecordingErrors.securityPolicy
    );
  });

  it('preserves safe transcription error messages from the API client', () => {
    expect(getTranscriptionFailureMessage(new Error('The voice service rejected the audio format.'))).toBe(
      'The voice service rejected the audio format.'
    );
    expect(getTranscriptionFailureMessage({})).toBe(microphoneRecordingErrors.transcriptionFailed);
  });
});

describe('audio level analysis', () => {
  it('keeps silent time-domain samples at the visualizer noise floor', () => {
    expect(calculateAudioLevelFromTimeDomainData(new Uint8Array([128, 128, 128, 128]))).toBe(0.04);
  });

  it('reports a high level for loud time-domain samples', () => {
    expect(calculateAudioLevelFromTimeDomainData(new Uint8Array([0, 255, 0, 255]))).toBeGreaterThan(0.9);
  });
});

describe('audio recording stop reason handling', () => {
  it('transcribes only an accepted recording that did not fail', () => {
    expect(shouldTranscribeRecordingStop('accept', false)).toBe(true);
    expect(shouldTranscribeRecordingStop('accept', true)).toBe(false);
    expect(shouldTranscribeRecordingStop('cancel', false)).toBe(false);
    expect(shouldTranscribeRecordingStop('cleanup', false)).toBe(false);
    expect(shouldTranscribeRecordingStop('error', false)).toBe(false);
    expect(shouldTranscribeRecordingStop(null, false)).toBe(false);
  });

  it('shows the canceled state only for explicit user cancellation', () => {
    expect(shouldShowUserCanceledRecordingStatus('cancel')).toBe(true);
    expect(shouldShowUserCanceledRecordingStatus('cleanup')).toBe(false);
    expect(shouldShowUserCanceledRecordingStatus('error')).toBe(false);
    expect(shouldShowUserCanceledRecordingStatus('accept')).toBe(false);
    expect(shouldShowUserCanceledRecordingStatus(null)).toBe(false);
  });

  it('discards media chunks for cancel, cleanup, and error stop paths', () => {
    expect(shouldStoreRecordingChunk(null)).toBe(true);
    expect(shouldStoreRecordingChunk('accept')).toBe(true);
    expect(shouldStoreRecordingChunk('cancel')).toBe(false);
    expect(shouldStoreRecordingChunk('cleanup')).toBe(false);
    expect(shouldStoreRecordingChunk('error')).toBe(false);
  });
});
