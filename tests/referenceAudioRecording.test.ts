import { describe, expect, it } from 'vitest';
import {
  createRecordedReferenceWav,
  encodeMonoPcm16Wav,
  formatReferenceRecordingDuration,
  recordedReferenceFilename
} from '../client/src/lib/referenceAudioRecording.js';

const ascii = (buffer: ArrayBuffer, offset: number, length: number) =>
  String.fromCharCode(...new Uint8Array(buffer, offset, length));

describe('reference audio recording helpers', () => {
  it('encodes mono 16-bit PCM WAV audio that the VoiceVM reference upload accepts', () => {
    const buffer = encodeMonoPcm16Wav(new Float32Array([0, 1, -1]), 24_000);
    const view = new DataView(buffer);

    expect(ascii(buffer, 0, 4)).toBe('RIFF');
    expect(ascii(buffer, 8, 4)).toBe('WAVE');
    expect(ascii(buffer, 12, 4)).toBe('fmt ');
    expect(ascii(buffer, 36, 4)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
  });

  it('creates safe WAV filenames from display names', () => {
    expect(recordedReferenceFilename('../Eric Sample.wav', '2026-05-28T00-00-00-000Z')).toBe('Eric-Sample.wav');
    expect(recordedReferenceFilename('', '2026-05-28T00-00-00-000Z')).toBe(
      'recorded-reference-2026-05-28T00-00-00-000Z.wav'
    );
  });

  it('wraps recorded microphone samples in a WAV blob with useful metadata', () => {
    const recording = createRecordedReferenceWav(new Float32Array(24_000), 24_000, 'Living Room Reference');

    expect(recording.filename).toBe('Living-Room-Reference.wav');
    expect(recording.blob.type).toBe('audio/wav');
    expect(recording.durationSeconds).toBe(1);
    expect(recording.sampleRate).toBe(24_000);
    expect(recording.channelCount).toBe(1);
  });

  it('formats recording durations for the recorder dialog', () => {
    expect(formatReferenceRecordingDuration(0)).toBe('0:00');
    expect(formatReferenceRecordingDuration(9.9)).toBe('0:09');
    expect(formatReferenceRecordingDuration(65.2)).toBe('1:05');
  });
});
