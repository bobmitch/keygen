// Streaming short-time Fourier transform.
//
// Whole-track spectrograms at our frame sizes would hold tens of megabytes, so
// instead of materialising one we stream Hann-windowed magnitude frames through
// a generator and let consumers reduce each frame to the few numbers they keep
// (12 chroma bins, one flux value, ...). The yielded buffer is REUSED between
// frames — copy it if you need to keep it.

import { RealSpectrum } from './fft';

export interface StftFrame {
  /** Magnitude spectrum, bins 0..frameSize/2. Reused between frames. */
  mag: Float32Array;
  /** Frame centre time in seconds. */
  time: number;
  index: number;
}

/** Number of full frames produced for a signal of `numSamples`. */
export function frameCount(numSamples: number, frameSize: number, hopSize: number): number {
  if (numSamples < frameSize) return 0;
  return Math.floor((numSamples - frameSize) / hopSize) + 1;
}

/** Symmetric Hann window. */
export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}

/**
 * Stream Hann-windowed magnitude spectra of consecutive frames. Frames start at
 * i*hopSize and are reported at their centre time, matching how the chroma /
 * onset frame times are interpreted downstream.
 */
export function* stftFrames(
  samples: Float32Array,
  sampleRate: number,
  frameSize: number,
  hopSize: number,
): Generator<StftFrame> {
  const spectrum = new RealSpectrum(frameSize);
  const window = hannWindow(frameSize);
  const windowed = new Float64Array(frameSize);
  const mag = new Float32Array(spectrum.bins);
  const count = frameCount(samples.length, frameSize, hopSize);
  for (let f = 0; f < count; f++) {
    const off = f * hopSize;
    for (let i = 0; i < frameSize; i++) windowed[i] = samples[off + i] * window[i];
    spectrum.magnitudes(windowed, mag);
    yield { mag, time: (off + frameSize / 2) / sampleRate, index: f };
  }
}
