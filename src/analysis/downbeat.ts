// Automatic downbeat (bar-phase) estimation.
//
// The beat tracker gives us beat ticks but no notion of which beat is "1".
// Rather than guess the phase (offset 0) and rely on the user nudging it,
// we score every candidate phase with musical evidence and pick the best.
//
// The evidence is a per-beat "downbeat salience" fusing three cues that tend to
// peak on the first beat of a bar:
//   - onset strength  (spectral flux): bars usually start on a strong onset
//   - low-band energy (kick/bass):     the kick most often lands on beat 1
//   - harmonic change (chroma):        chords change on bar boundaries
// This is the classic pre-deep-learning recipe (cf. Davies & Plumbley, "A
// Spectral Difference Approach to Downbeat Extraction"): a feature function over
// beats, folded over the candidate phases, argmax wins.
//
// All functions here are pure so they can be unit-tested and cheaply recomputed
// when the meter changes; the heavy per-frame DSP lives in the worker.

// Cue weights (in normalised 0..1 units). Harmony and bass are the most reliable
// downbeat indicators in popular music, so they carry slightly more weight.
const W_ONSET = 0.8;
const W_LOW = 1.0;
const W_HARMONIC = 1.0;

// Time windows (seconds) around a beat used to sample each cue.
const ONSET_WIN = 0.06; // look for the onset peak in +/- this around the tick
const LOW_BACK = 0.03; // low-band energy window: slightly behind ...
const LOW_FWD = 0.1; //   ... to slightly ahead of the tick (kick decays forward)
const HARMONIC_WIN = 0.4; // chroma averaged over this much before/after the beat

export interface BeatFeatureFrames {
  /** Frame centre times in seconds (sorted ascending). */
  frameTimes: number[];
  /** Half-wave-rectified spectral flux per frame (onset novelty). */
  flux: number[];
  /** Low-frequency band energy per frame. */
  lowEnergy: number[];
  /** Per-frame 12-bin chroma (HPCP-style). */
  chroma: number[][];
}

/**
 * Compute a per-beat downbeat salience score, aligned 1:1 with `beats`. Higher
 * means "more likely to be a downbeat". Each cue is min-max normalised across all
 * beats before weighting so the cues are comparable regardless of absolute scale.
 */
export function beatDownbeatStrength(beats: number[], f: BeatFeatureFrames): number[] {
  const n = beats.length;
  if (n === 0 || f.frameTimes.length === 0) return new Array(n).fill(0);

  const onset = new Array(n).fill(0);
  const low = new Array(n).fill(0);
  const harmonic = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const t = beats[i];
    onset[i] = maxInWindow(f.frameTimes, f.flux, t - ONSET_WIN, t + ONSET_WIN);
    low[i] = meanInWindow(f.frameTimes, f.lowEnergy, t - LOW_BACK, t + LOW_FWD);
    harmonic[i] = harmonicChange(f.frameTimes, f.chroma, t);
  }

  const onsetN = minMaxNorm(onset);
  const lowN = minMaxNorm(low);
  const harmonicN = minMaxNorm(harmonic);

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = W_ONSET * onsetN[i] + W_LOW * lowN[i] + W_HARMONIC * harmonicN[i];
  }
  return out;
}

/**
 * Pick the bar phase (index of the first downbeat, in [0, beatsPerBar)) whose
 * beats carry the most salience. Returns 0 when there isn't enough signal to
 * decide, matching the previous default.
 */
export function estimateDownbeatOffset(
  beats: number[],
  strength: number[],
  beatsPerBar: number,
): number {
  if (beatsPerBar < 2 || beats.length < beatsPerBar * 2) return 0;

  const sum = new Array(beatsPerBar).fill(0);
  const count = new Array(beatsPerBar).fill(0);
  for (let i = 0; i < strength.length; i++) {
    const phase = i % beatsPerBar;
    sum[phase] += strength[i];
    count[phase] += 1;
  }

  let best = 0;
  let bestScore = -Infinity;
  let total = 0;
  for (let p = 0; p < beatsPerBar; p++) {
    const mean = count[p] > 0 ? sum[p] / count[p] : 0;
    total += mean;
    if (mean > bestScore) {
      bestScore = mean;
      best = p;
    }
  }
  // No usable evidence (all-zero salience) -> keep the default phase.
  if (total <= 0) return 0;
  return best;
}

// --- cue helpers -------------------------------------------------------------

/** Cosine distance (1 - cosine) between chroma just before and just after `t`. */
function harmonicChange(frameTimes: number[], chroma: number[][], t: number): number {
  const before = meanChroma(frameTimes, chroma, t - HARMONIC_WIN, t);
  const after = meanChroma(frameTimes, chroma, t, t + HARMONIC_WIN);
  return 1 - cosine(before, after);
}

function meanChroma(frameTimes: number[], chroma: number[][], t0: number, t1: number): number[] {
  const [lo, hi] = frameRange(frameTimes, t0, t1);
  const out = new Array(12).fill(0);
  if (hi <= lo) return out;
  for (let i = lo; i < hi; i++) {
    const c = chroma[i];
    for (let p = 0; p < 12; p++) out[p] += c[p];
  }
  const k = hi - lo;
  for (let p = 0; p < 12; p++) out[p] /= k;
  return out;
}

function maxInWindow(times: number[], values: number[], t0: number, t1: number): number {
  const [lo, hi] = frameRange(times, t0, t1);
  let m = 0;
  for (let i = lo; i < hi; i++) if (values[i] > m) m = values[i];
  return m;
}

function meanInWindow(times: number[], values: number[], t0: number, t1: number): number {
  const [lo, hi] = frameRange(times, t0, t1);
  if (hi <= lo) return 0;
  let s = 0;
  for (let i = lo; i < hi; i++) s += values[i];
  return s / (hi - lo);
}

/** Half-open index range [lo, hi) of `times` falling within [t0, t1). */
function frameRange(times: number[], t0: number, t1: number): [number, number] {
  return [lowerBound(times, t0), lowerBound(times, t1)];
}

/** First index whose value is >= `target` (binary search; `times` is sorted). */
function lowerBound(times: number[], target: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function minMaxNorm(arr: number[]): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of arr) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (!(range > 1e-12)) return new Array(arr.length).fill(0);
  return arr.map((v) => (v - min) / range);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na < 1e-12 || nb < 1e-12) return 0;
  return dot / Math.sqrt(na * nb);
}
