export const recommendedReferenceRecordingSeconds = 10;
export const maximumReferenceRecordingSeconds = 60;

// Chatterbox documentation recommends a short, clean reference clip but does not publish
// a fixed read-aloud script. Keep this neutral, phoneme-varied, and about ten seconds.
export const referenceAudioRecordingScript =
  'Today I am recording a clear reference sample for Chatterbox text to speech. I will speak naturally, at a steady pace, with a calm tone. The quick brown fox jumps over the lazy dog. Every bright voice carries warm rhythm, crisp consonants, and smooth vowels.';

export interface RecordedReferenceWav {
  blob: Blob;
  filename: string;
  durationSeconds: number;
  sampleRate: number;
  channelCount: 1;
}

export const flattenFloat32Chunks = (chunks: Float32Array[]) => {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const samples = new Float32Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }

  return samples;
};

const clampSample = (sample: number) => Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));

export const encodeMonoPcm16Wav = (samples: Float32Array, sampleRate: number) => {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('A valid sample rate is required to encode WAV audio.');
  }

  const channelCount = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channelCount * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataByteLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = clampSample(sample);
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return buffer;
};

const fallbackTimestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export const recordedReferenceFilename = (displayName: string | undefined, now = fallbackTimestamp()) => {
  const base = (displayName ?? '')
    .trim()
    .replace(/\.wav$/i, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._ -]+|[._ -]+$/g, '')
    .slice(0, 80);

  return `${base || `recorded-reference-${now}`}.wav`;
};

export const createRecordedReferenceWav = (
  samples: Float32Array,
  sampleRate: number,
  displayName?: string
): RecordedReferenceWav => {
  const wavBuffer = encodeMonoPcm16Wav(samples, sampleRate);
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });

  return {
    blob,
    filename: recordedReferenceFilename(displayName),
    durationSeconds: samples.length / sampleRate,
    sampleRate,
    channelCount: 1
  };
};

export const formatReferenceRecordingDuration = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
};
