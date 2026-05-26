import { describe, expect, it, vi } from 'vitest';
import {
  calculateAudioLevelFromTimeDomainData,
  getAudioRecordingStopDisposition,
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

describe('audio level analysis', () => {
  it('keeps silent time-domain samples at the visualizer noise floor', () => {
    expect(calculateAudioLevelFromTimeDomainData(new Uint8Array([128, 128, 128, 128]))).toBe(0.04);
  });

  it('reports a high level for loud time-domain samples', () => {
    expect(calculateAudioLevelFromTimeDomainData(new Uint8Array([0, 255, 0, 255]))).toBeGreaterThan(0.9);
  });
});

describe('audio recording stop disposition', () => {
  it('transcribes only explicit accepted recordings that did not fail', () => {
    expect(getAudioRecordingStopDisposition('accept')).toBe('transcribe');
    expect(getAudioRecordingStopDisposition('accept', true)).toBe('error');
  });

  it('treats user cancellation separately from silent cleanup', () => {
    expect(getAudioRecordingStopDisposition('user-cancel')).toBe('user-canceled');
    expect(getAudioRecordingStopDisposition('cleanup')).toBe('discard');
    expect(getAudioRecordingStopDisposition(null)).toBe('discard');
  });

  it('does not report recorder failures as user cancellations', () => {
    expect(getAudioRecordingStopDisposition('error')).toBe('error');
  });
});
