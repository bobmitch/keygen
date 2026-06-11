// Global key/mode estimation by pitch-class profile correlation
// (Krumhansl-Schmuckler method with Temperley's corpus-derived profiles).
//
// The time-averaged chroma is Pearson-correlated against a major and a minor
// profile at all 12 transpositions; the best of the 24 wins. Pearson makes the
// match invariant to chroma scale/offset, so the unit-max per-frame
// normalisation upstream doesn't bias anything.

import type { KeyResult } from '../types';

// Bin 0 = A, matching the chroma layout (and NOTE_NAMES in analysis/chords.ts).
const NOTE_NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];

// Kostka-Payne corpus profiles (Temperley, "Music and Probability", 2007),
// indexed by semitones above the tonic. They out-perform the original
// Krumhansl-Kessler probe-tone profiles on popular music, particularly at
// separating relative major/minor pairs.
const MAJOR_PROFILE = [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400];
const MINOR_PROFILE = [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330];

/**
 * Estimate the global key from per-frame chroma. Strength is the Pearson
 * correlation of the winning profile, clamped to 0..1 (typical confident
 * matches land around 0.6-0.9).
 */
export function estimateKey(chroma: ArrayLike<number>[]): KeyResult {
  const fallback: KeyResult = { key: 'C', scale: 'major', strength: 0 };
  if (chroma.length === 0) return fallback;

  const mean = new Float64Array(12);
  for (const frame of chroma) {
    for (let p = 0; p < 12; p++) mean[p] += frame[p];
  }
  for (let p = 0; p < 12; p++) mean[p] /= chroma.length;

  let best = -Infinity;
  let bestTonic = 0;
  let bestScale: 'major' | 'minor' = 'major';
  for (const [scale, profile] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]] as const) {
    for (let tonic = 0; tonic < 12; tonic++) {
      // profile[i] sits at chroma bin (tonic + i) mod 12.
      const rotated = new Float64Array(12);
      for (let i = 0; i < 12; i++) rotated[(tonic + i) % 12] = profile[i];
      const r = pearson(mean, rotated);
      if (r > best) {
        best = r;
        bestTonic = tonic;
        bestScale = scale;
      }
    }
  }
  if (!Number.isFinite(best)) return fallback;

  return {
    key: NOTE_NAMES[bestTonic],
    scale: bestScale,
    strength: Math.max(0, Math.min(1, best)),
  };
}

/** Pearson correlation of two 12-vectors; -Infinity when either is constant. */
function pearson(a: Float64Array, b: Float64Array): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= 12;
  mb /= 12;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < 12; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va < 1e-12 || vb < 1e-12) return -Infinity;
  return cov / Math.sqrt(va * vb);
}
