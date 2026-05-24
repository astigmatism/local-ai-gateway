import { describe, expect, it, vi } from 'vitest';
import {
  getMicrophoneRecordingSupportError,
  mapMicrophoneStartError,
  microphoneRecordingErrors,
  selectSupportedAudioMimeType
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
});
