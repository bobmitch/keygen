import type { DecodedAudio } from '../types';

const TARGET_SAMPLE_RATE = 44100; // Essentia algorithms default to 44.1k.

/**
 * Decode an audio File entirely in the browser, downmix to mono, and resample
 * to a fixed rate so downstream analysis is consistent across input formats.
 */
export async function decodeAudioFile(file: File): Promise<DecodedAudio> {
  const arrayBuffer = await file.arrayBuffer();

  // Decode with a throwaway context at the file's native rate.
  const decodeCtx = new AudioContext();
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    void decodeCtx.close();
  }

  const mono = await resampleToMono(audioBuffer, TARGET_SAMPLE_RATE);
  const duration = mono.length / TARGET_SAMPLE_RATE;
  const peaks = computePeaks(mono, 4000);

  return { samples: mono, sampleRate: TARGET_SAMPLE_RATE, duration, peaks };
}

/** Render the (possibly multi-channel) buffer down to a single mono channel at `rate`. */
async function resampleToMono(buffer: AudioBuffer, rate: number): Promise<Float32Array> {
  const frames = Math.ceil((buffer.duration) * rate);
  const offline = new OfflineAudioContext(1, frames, rate);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  // Copy out of the AudioBuffer so the result is a plain transferable Float32Array.
  return Float32Array.from(rendered.getChannelData(0));
}

/**
 * Reduce the signal to `buckets` peak-magnitude values for fast waveform drawing,
 * normalized to 0..1 so rendering is independent of input loudness.
 */
function computePeaks(samples: Float32Array, buckets: number): number[] {
  const blockSize = Math.max(1, Math.floor(samples.length / buckets));
  const peaks: number[] = [];
  let max = 0;
  for (let b = 0; b < buckets; b++) {
    const start = b * blockSize;
    const end = Math.min(samples.length, start + blockSize);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    peaks.push(peak);
    if (peak > max) max = peak;
  }
  // Normalize to 0..1 so rendering is consistent regardless of input loudness.
  if (max > 0) {
    for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
  }
  return peaks;
}
