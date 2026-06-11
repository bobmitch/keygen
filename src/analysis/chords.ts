// Beat-synchronous chord estimation over precomputed HPCP chroma.
//
// Pure math (no Essentia / no FFTs): given a beat grid, per-frame chroma, and the
// detected key, it template-matches a chord per inter-beat segment and Viterbi-
// smooths the sequence. Living outside the worker lets the main thread re-run it on
// demand (e.g. after the user retimes the beats) without re-decoding the audio.

import type { ChordSpan } from '../types';

// HPCP size-12 bins start at the reference pitch class (A = 440 Hz default).
const NOTE_NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];

// --- Chord state space -------------------------------------------------------
//
// Each state is (root pitch class, quality). Pitch class 0 == A, matching the
// HPCP bin layout / NOTE_NAMES. We support the four qualities that dominate
// popular music; richer ones (sus, dim, aug, 9ths) tend to *lower* accuracy on
// a plain 12-bin chroma because they share too many tones with their triads.
interface Quality {
  suffix: string; // appended to the root name to form the label ('' = major)
  intervals: number[]; // semitone offsets of the chord tones, relative to root
  seventh: boolean; // used to bias the model gently toward plain triads
}
const QUALITIES: Quality[] = [
  { suffix: '', intervals: [0, 4, 7], seventh: false }, // major triad
  { suffix: 'm', intervals: [0, 3, 7], seventh: false }, // minor triad
  { suffix: '7', intervals: [0, 4, 7, 10], seventh: true }, // dominant 7th
  { suffix: 'm7', intervals: [0, 3, 7, 10], seventh: true }, // minor 7th
];
const QUAL_INDEX: Record<string, number> = { '': 0, m: 1, '7': 2, m7: 3 };
const NUM_QUAL = QUALITIES.length;
const NUM_CHORD_STATES = 12 * NUM_QUAL;
const NO_CHORD_INDEX = NUM_CHORD_STATES;
const NUM_STATES = NUM_CHORD_STATES + 1;

// L2-normalised binary templates, one per chord state, indexed root * NUM_QUAL + q.
const CHORD_LABELS: string[] = new Array(NUM_CHORD_STATES);
const TEMPLATES: Float64Array[] = new Array(NUM_CHORD_STATES);
for (let root = 0; root < 12; root++) {
  for (let q = 0; q < NUM_QUAL; q++) {
    const state = root * NUM_QUAL + q;
    CHORD_LABELS[state] = NOTE_NAMES[root] + QUALITIES[q].suffix;
    const tpl = new Float64Array(12);
    for (const iv of QUALITIES[q].intervals) tpl[(root + iv) % 12] = 1;
    let norm = 0;
    for (let i = 0; i < 12; i++) norm += tpl[i] * tpl[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 12; i++) tpl[i] /= norm;
    TEMPLATES[state] = tpl;
  }
}

// --- Scoring hyper-parameters (all in cosine-similarity units, 0..1) ---------
// Viterbi maximises the sum, over segments, of (emission + self/key/triad bias).
const SELF_BONUS = 0.15; // reward for keeping the same chord; suppresses flicker
// How much a strong harmonic change relaxes SELF_BONUS (0..1). The self-reward is
// what suppresses flicker, but at a real chord change it also delays the switch by
// up to one beat (the old chord "leaks" into the next bar). Shrinking the reward in
// proportion to inter-segment chroma novelty lets genuine changes land on time
// while keeping full stickiness on stable/noisy segments.
const SELF_RELAX = 0.7;
const KEY_BONUS = 0.08; // reward for chords diatonic to the detected key
const TRIAD_BIAS = 0.05; // penalty on 7th chords so they only win when supported
const NO_CHORD_SIM = 0.5; // similarity floor a chord must clear to beat "no chord"

/**
 * Decode one chord per inter-beat segment (the raw, *unmerged* per-beat estimate),
 * each carrying its own confidence. Kept per-beat (rather than merged into spans)
 * so downstream bar-aware cleanup can reason about the confidence of an individual
 * beat — in particular, whether the first beat of a bar genuinely holds the
 * previous chord or is just bleed leaking across the bar line. Span merging and
 * track-edge coverage happen later, in `buildChordSpans`.
 */
export function estimateBeatChords(
  beats: number[],
  chroma: number[][],
  chromaTimes: number[],
  duration: number,
  key: { key: string; scale: 'major' | 'minor' },
): ChordSpan[] {
  // One chord per inter-beat segment; fall back to a fixed 0.5 s grid if the
  // beat tracker produced nothing usable.
  let ticks: number[];
  if (beats.length >= 2) {
    ticks = beats;
  } else {
    ticks = [];
    for (let t = 0; t <= duration; t += 0.5) ticks.push(t);
  }
  if (ticks.length < 2 || chroma.length === 0) return [];

  // Beat-synchronous chroma: a robust (median) vector per segment. Frames are in
  // time order, so a single advancing cursor walks them across all segments.
  const segChroma: Float64Array[] = [];
  const cursor = { i: 0 };
  for (let k = 0; k < ticks.length - 1; k++) {
    segChroma.push(segmentChroma(chroma, chromaTimes, ticks[k], ticks[k + 1], cursor));
  }

  const prior = buildKeyPrior(key);
  const path = viterbiSmooth(segChroma, prior);

  const raw: ChordSpan[] = [];
  for (let k = 0; k < path.length; k++) {
    const start = ticks[k];
    const end = ticks[k + 1];
    if (end - start < 0.05) continue;
    const state = path[k];
    const label = state === NO_CHORD_INDEX ? 'N' : CHORD_LABELS[state];
    const conf = state === NO_CHORD_INDEX ? 0 : clamp01(cosine(segChroma[k], TEMPLATES[state]));
    raw.push({ start, end, label, confidence: conf });
  }
  return raw;
}

/**
 * Median-aggregate the per-frame chroma whose centre falls in [start, end), then
 * L2-normalise. Median is robust to transients/percussive frames. Frames arrive
 * in time order, so we advance a shared cursor instead of rescanning each time.
 */
function segmentChroma(
  chroma: number[][],
  chromaTimes: number[],
  start: number,
  end: number,
  cursor: { i: number },
): Float64Array {
  let i = cursor.i;
  while (i < chromaTimes.length && chromaTimes[i] < start) i++;
  const startIdx = i;
  while (i < chromaTimes.length && chromaTimes[i] < end) i++;
  cursor.i = i > startIdx ? i : startIdx;

  const out = new Float64Array(12);
  if (i === startIdx) {
    // No frame centre landed inside the segment; use the nearest single frame.
    const mid = (start + end) / 2;
    let near = Math.min(startIdx, chromaTimes.length - 1);
    if (near < 0) return out;
    if (near + 1 < chromaTimes.length &&
        Math.abs(chromaTimes[near + 1] - mid) < Math.abs(chromaTimes[near] - mid)) near++;
    for (let p = 0; p < 12; p++) out[p] = chroma[near][p];
  } else {
    const scratch: number[] = [];
    for (let p = 0; p < 12; p++) {
      scratch.length = 0;
      for (let f = startIdx; f < i; f++) scratch.push(chroma[f][p]);
      scratch.sort((a, b) => a - b);
      const m = scratch.length >> 1;
      out[p] = scratch.length % 2 ? scratch[m] : (scratch[m - 1] + scratch[m]) / 2;
    }
  }
  let norm = 0;
  for (let p = 0; p < 12; p++) norm += out[p] * out[p];
  norm = Math.sqrt(norm);
  if (norm > 1e-9) for (let p = 0; p < 12; p++) out[p] /= norm;
  return out;
}

/**
 * Viterbi decoding over the chord state space. Emissions are the cosine
 * similarity between each segment's chroma and the chord templates (so the model
 * can pick the *correct* chord, not just smooth a pre-made decision). A
 * self-transition reward suppresses single-segment flicker, a key prior favours
 * diatonic chords, and a small triad bias keeps 7ths from over-reaching.
 */
function viterbiSmooth(segChroma: Float64Array[], prior: Float64Array): number[] {
  const T = segChroma.length;
  if (T === 0) return [];

  const emit: Float64Array[] = new Array(T);
  for (let t = 0; t < T; t++) {
    const e = new Float64Array(NUM_STATES);
    const c = segChroma[t];
    for (let s = 0; s < NUM_CHORD_STATES; s++) {
      e[s] = cosine(c, TEMPLATES[s]) + prior[s];
      if (QUALITIES[s % NUM_QUAL].seventh) e[s] -= TRIAD_BIAS;
    }
    e[NO_CHORD_INDEX] = NO_CHORD_SIM;
    emit[t] = e;
  }

  const dp: Float64Array[] = new Array(T);
  const back: Int32Array[] = new Array(T);
  dp[0] = emit[0].slice();
  for (let t = 1; t < T; t++) {
    const cur = new Float64Array(NUM_STATES);
    const bk = new Int32Array(NUM_STATES);
    const prev = dp[t - 1];
    // Relax the stay-reward in proportion to how much this segment's chroma differs
    // from the previous one, so a clear chord change isn't held a beat too long.
    const novelty = clamp01(1 - cosine(segChroma[t], segChroma[t - 1]));
    const selfBonus = SELF_BONUS * (1 - SELF_RELAX * novelty);
    // Best previous state ignoring the self bonus, computed once for all targets.
    let globalBest = 0;
    let globalBestScore = -Infinity;
    for (let p = 0; p < NUM_STATES; p++) {
      if (prev[p] > globalBestScore) { globalBestScore = prev[p]; globalBest = p; }
    }
    for (let s = 0; s < NUM_STATES; s++) {
      // Staying in s earns selfBonus; switching takes the unconstrained best.
      const stay = prev[s] + selfBonus;
      if (stay >= globalBestScore) { cur[s] = stay + emit[t][s]; bk[s] = s; }
      else { cur[s] = globalBestScore + emit[t][s]; bk[s] = globalBest; }
    }
    dp[t] = cur;
    back[t] = bk;
  }

  let last = 0;
  let bestEnd = -Infinity;
  for (let s = 0; s < NUM_STATES; s++) {
    if (dp[T - 1][s] > bestEnd) { bestEnd = dp[T - 1][s]; last = s; }
  }
  const path = new Array<number>(T);
  path[T - 1] = last;
  for (let t = T - 1; t > 0; t--) path[t - 1] = back[t][path[t]];
  return path;
}

/** Per-state additive bonus that favours chords diatonic to the detected key. */
function buildKeyPrior(key: { key: string; scale: 'major' | 'minor' }): Float64Array {
  const prior = new Float64Array(NUM_STATES);
  const tonic = noteToPc(key.key);
  if (tonic < 0) return prior; // unknown key spelling -> no prior

  // (scale-degree offset, quality suffix). Roman-numeral harmony of the key,
  // including the common secondary dominant (V7) so it isn't penalised.
  const major: Array<[number, string]> = [
    [0, ''], [2, 'm'], [4, 'm'], [5, ''], [7, ''], [9, 'm'], [7, '7'],
  ];
  const minor: Array<[number, string]> = [
    [0, 'm'], [3, ''], [5, 'm'], [7, 'm'], [8, ''], [10, ''], [7, ''], [7, '7'],
  ];
  const degrees = key.scale === 'minor' ? minor : major;
  for (const [offset, suffix] of degrees) {
    const root = (tonic + offset) % 12;
    const q = QUAL_INDEX[suffix];
    if (q !== undefined) prior[root * NUM_QUAL + q] += KEY_BONUS;
  }
  return prior;
}

/** Cosine similarity between an L2-normalised chroma and an L2-normalised template. */
function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  for (let i = 0; i < 12; i++) dot += a[i] * b[i];
  return dot;
}

// Pitch-class lookup with both sharp and flat spellings (KeyExtractor may emit
// either). Returns -1 for anything unrecognised.
const PC_BY_NAME: Record<string, number> = {};
NOTE_NAMES.forEach((n, i) => { PC_BY_NAME[n] = i; });
Object.assign(PC_BY_NAME, {
  Bb: PC_BY_NAME['A#'], Db: PC_BY_NAME['C#'], Eb: PC_BY_NAME['D#'],
  Gb: PC_BY_NAME['F#'], Ab: PC_BY_NAME['G#'], Cb: PC_BY_NAME.B, Fb: PC_BY_NAME.E,
  'E#': PC_BY_NAME.F, 'B#': PC_BY_NAME.C,
});
function noteToPc(name: string): number {
  const pc = PC_BY_NAME[name.trim()];
  return pc === undefined ? -1 : pc;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
