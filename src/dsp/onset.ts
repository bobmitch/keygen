// Onset / novelty features.
//
// Two flavours of spectral flux live here:
//   - `onsetEnvelope`: log-compressed flux on a fine time grid, feeding tempo
//     estimation and beat tracking (log compression keeps soft onsets visible
//     next to loud ones).
//   - `spectralFluxRaw` / `lowBandEnergy`: per-frame cues on the coarse chroma
//     grid, consumed by the downbeat scorer (which min-max normalises them, so
//     raw magnitudes are fine there).

import { frameCount, stftFrames } from './stft';

/** Gamma for log1p magnitude compression in the onset envelope. */
const LOG_COMPRESSION = 1000;

export interface OnsetEnvelope {
  /** Onset strength per frame (half-wave-rectified log-spectral flux). */
  odf: Float32Array;
  /** Frame centre times in seconds, aligned 1:1 with `odf`. */
  times: Float32Array;
  /** Frames per second of the envelope. */
  fps: number;
}

/**
 * Half-wave-rectified spectral flux of log-compressed magnitudes over the whole
 * signal. `onProgress` (0..1) lets the caller surface progress for long tracks.
 */
export function onsetEnvelope(
  samples: Float32Array,
  sampleRate: number,
  frameSize: number,
  hopSize: number,
  onProgress?: (fraction: number) => void,
): OnsetEnvelope {
  const n = frameCount(samples.length, frameSize, hopSize);
  const odf = new Float32Array(n);
  const times = new Float32Array(n);
  let prev: Float32Array | null = null;
  for (const frame of stftFrames(samples, sampleRate, frameSize, hopSize)) {
    times[frame.index] = frame.time;
    const mag = frame.mag;
    if (prev === null) {
      prev = new Float32Array(mag.length);
      for (let b = 0; b < mag.length; b++) prev[b] = Math.log1p(LOG_COMPRESSION * mag[b]);
    } else {
      let sum = 0;
      for (let b = 0; b < mag.length; b++) {
        const c = Math.log1p(LOG_COMPRESSION * mag[b]);
        const d = c - prev[b];
        if (d > 0) sum += d;
        prev[b] = c;
      }
      odf[frame.index] = sum;
    }
    if (onProgress && frame.index % 256 === 0) onProgress(frame.index / n);
  }
  return { odf, times, fps: sampleRate / hopSize };
}

/**
 * Enhance an onset envelope for periodicity analysis: subtract a moving local
 * mean (removes slow loudness trends) and half-wave rectify, so only onset
 * peaks survive.
 */
export function enhanceOdf(odf: Float32Array, fps: number, windowSec = 0.5): Float32Array {
  const n = odf.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const half = Math.max(1, Math.round((windowSec * fps) / 2));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + odf[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    const mean = (prefix[hi] - prefix[lo]) / (hi - lo);
    const v = odf[i] - mean;
    out[i] = v > 0 ? v : 0;
  }
  return out;
}

/** Half-wave-rectified spectral flux between consecutive raw magnitude spectra. */
export function spectralFluxRaw(mag: Float32Array, prev: Float32Array): number {
  const len = Math.min(mag.length, prev.length);
  let sum = 0;
  for (let b = 0; b < len; b++) {
    const d = mag[b] - prev[b];
    if (d > 0) sum += d;
  }
  return sum;
}

/** Sum of magnitude^2 in (0, maxHz] — the kick/bass band cue. DC is excluded. */
export function lowBandEnergy(
  mag: Float32Array,
  sampleRate: number,
  frameSize: number,
  maxHz: number,
): number {
  const maxBin = Math.max(1, Math.round((maxHz * frameSize) / sampleRate));
  let sum = 0;
  for (let b = 1; b <= maxBin && b < mag.length; b++) sum += mag[b] * mag[b];
  return sum;
}
