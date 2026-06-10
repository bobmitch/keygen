/// <reference lib="webworker" />
import { EssentiaWASM } from 'essentia.js/dist/essentia-wasm.es.js';
import Essentia from 'essentia.js/dist/essentia.js-core.es.js';
import type {
  AnalyzeRequest,
  ChordSpan,
  WorkerAnalysis,
  WorkerMessage,
} from '../types';

const FRAME_SIZE = 4096;
const HOP_SIZE = 2048;

// HPCP size-12 bins start at the reference pitch class (A = 440 Hz default).
const NOTE_NAMES = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'];

let essentia: any = null;

function post(msg: WorkerMessage) {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

/**
 * Instantiate Essentia, tolerating the different shapes the WASM backend can take
 * across builds: a ready Emscripten module, an async factory, or a UMD-nested object.
 */
async function ensureEssentia(): Promise<any> {
  if (!essentia) {
    let wasm: any = EssentiaWASM;
    if (typeof wasm === 'function') wasm = await wasm();
    if (wasm && wasm.EssentiaWASM) wasm = wasm.EssentiaWASM;
    essentia = new Essentia(wasm);
  }
  return essentia;
}

self.onmessage = async (e: MessageEvent<AnalyzeRequest>) => {
  const msg = e.data;
  if (msg.type !== 'analyze') return;
  try {
    const analysis = await analyze(msg.samples, msg.sampleRate);
    post({ type: 'result', analysis });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

async function analyze(samples: Float32Array, sampleRate: number): Promise<WorkerAnalysis> {
  post({ type: 'progress', stage: 'Loading analysis engine' });
  const es = await ensureEssentia();
  const signalVector = es.arrayToVector(samples);

  // --- Tempo + beat grid ---
  post({ type: 'progress', stage: 'Detecting tempo & beats' });
  const rhythm = es.RhythmExtractor2013(signalVector, 208, 'multifeature', 40);
  const bpm = round1(rhythm.bpm);
  const bpmConfidence = clamp01(rhythm.confidence / 5.32); // estimator confidence is ~0..5.32
  const beats = vectorToArray(es, rhythm.ticks);
  safeDelete(rhythm.ticks);

  // --- Key + mode ---
  post({ type: 'progress', stage: 'Detecting key & mode' });
  const keyRes = es.KeyExtractor(signalVector);
  const key = {
    key: keyRes.key,
    scale: (keyRes.scale === 'minor' ? 'minor' : 'major') as 'major' | 'minor',
    strength: clamp01(keyRes.strength),
  };
  safeDelete(signalVector);

  // --- Per-frame chroma (HPCP) ---
  post({ type: 'progress', stage: 'Computing chroma features' });
  const { chroma, chromaTimes } = computeChroma(es, samples, sampleRate);

  // --- Chords (Essentia beat-synchronous detection + Viterbi smoothing) ---
  post({ type: 'progress', stage: 'Estimating chords' });
  const chords = estimateChords(es, beats, chroma, samples.length / sampleRate, sampleRate);

  return {
    key,
    bpm,
    bpmConfidence,
    beats,
    chords,
    chroma,
    chromaTimes,
  };
}

function computeChroma(es: any, samples: Float32Array, sampleRate: number) {
  const frames = es.FrameGenerator(samples, FRAME_SIZE, HOP_SIZE);
  const chroma: number[][] = [];
  const chromaTimes: number[] = [];
  const count = frames.size();
  for (let i = 0; i < count; i++) {
    const frame = frames.get(i);
    const win = es.Windowing(frame, true, FRAME_SIZE, 'hann');
    const spec = es.Spectrum(win.frame, FRAME_SIZE);
    const peaks = es.SpectralPeaks(spec.spectrum, -1000, 5000, 100, 40, 'magnitude', sampleRate);
    const hpcpRes = es.HPCP(
      peaks.frequencies,
      peaks.magnitudes,
      true, 500, 8, 5000, true, 40, false, 'unitMax', 440, sampleRate, 12,
    );
    chroma.push(Array.from(vectorToArray(es, hpcpRes.hpcp)));
    chromaTimes.push((i * HOP_SIZE + FRAME_SIZE / 2) / sampleRate);

    safeDelete(win.frame);
    safeDelete(spec.spectrum);
    safeDelete(peaks.frequencies);
    safeDelete(peaks.magnitudes);
    safeDelete(hpcpRes.hpcp);

    if (i % 200 === 0) {
      post({ type: 'progress', stage: 'Computing chroma features', value: i / count });
    }
  }
  safeDelete(frames);
  return { chroma, chromaTimes };
}

// Chord state space for smoothing: 24 major/minor triads + a "no-chord" state.
// Labels use the same A-first sharp spelling Essentia's ChordsDetection emits.
function buildChordLabels(): string[] {
  const labels: string[] = [];
  for (let root = 0; root < 12; root++) {
    labels.push(NOTE_NAMES[root]);
    labels.push(NOTE_NAMES[root] + 'm');
  }
  return labels;
}
const CHORD_LABELS = buildChordLabels();
const LABEL_TO_INDEX = new Map(CHORD_LABELS.map((label, i) => [label, i] as const));
const NO_CHORD_INDEX = CHORD_LABELS.length; // 24
const NUM_STATES = CHORD_LABELS.length + 1; // 25

// Viterbi hyper-parameters.
const STAY_PROB = 0.9; // probability a chord persists into the next beat segment
const NO_CHORD_PRIOR = 0.05; // share of leftover mass assigned to "no chord"
const LOG_EPS = Math.log(1e-6);

function estimateChords(
  es: any,
  beats: number[],
  chroma: number[][],
  duration: number,
  sampleRate: number,
): ChordSpan[] {
  // ChordsDetectionBeats estimates one chord per inter-beat segment, so we need
  // at least two ticks. Fall back to a fixed 0.5 s grid when beats are missing.
  let ticks: number[];
  if (beats.length >= 2) {
    ticks = beats;
  } else {
    ticks = [];
    for (let t = 0; t <= duration; t += 0.5) ticks.push(t);
  }
  if (ticks.length < 2 || chroma.length === 0) return [];

  const { labels, strengths } = detectChordsBeats(es, chroma, ticks, sampleRate);
  if (labels.length === 0) return [];

  const path = viterbiSmooth(labels, strengths);

  // Segment k spans [ticks[k], ticks[k + 1]] (Essentia output length is ticks - 1).
  const raw: ChordSpan[] = [];
  const segments = Math.min(path.length, ticks.length - 1);
  for (let k = 0; k < segments; k++) {
    const start = ticks[k];
    const end = ticks[k + 1];
    if (end - start < 0.05) continue;
    const label = path[k] === NO_CHORD_INDEX ? 'N' : CHORD_LABELS[path[k]];
    raw.push({ start, end, label, confidence: clamp01(strengths[k]) });
  }

  const merged = mergeChords(raw);
  // Stretch the first/last span so the lane covers the whole track (pre-roll /
  // tail that fell outside the beat grid).
  if (merged.length) {
    merged[0].start = Math.min(merged[0].start, 0);
    merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, duration);
  }
  return merged;
}

/** Run Essentia's ChordsDetectionBeats over the per-frame chroma + beat grid. */
function detectChordsBeats(
  es: any,
  chroma: number[][],
  ticks: number[],
  sampleRate: number,
): { labels: string[]; strengths: number[] } {
  const pcp = new es.module.VectorVectorFloat();
  for (let i = 0; i < chroma.length; i++) {
    const v = new es.module.VectorFloat();
    const frame = chroma[i];
    for (let p = 0; p < 12; p++) v.push_back(frame[p]);
    pcp.push_back(v); // push_back copies into the C++ container
    safeDelete(v);
  }
  const tickVec = new es.module.VectorFloat();
  for (const t of ticks) tickVec.push_back(t);

  const res = es.ChordsDetectionBeats(pcp, tickVec, 'interbeat_median', HOP_SIZE, sampleRate);

  const labels: string[] = [];
  const strengths: number[] = [];
  const n = res.chords.size();
  for (let i = 0; i < n; i++) {
    labels.push(res.chords.get(i));
    strengths.push(res.strength.get(i));
  }

  safeDelete(pcp);
  safeDelete(tickVec);
  safeDelete(res.chords);
  safeDelete(res.strength);
  return { labels, strengths };
}

/**
 * Viterbi smoothing over the per-segment chord estimates. Emission mass is
 * concentrated on the detected triad (scaled by its strength) but spread enough
 * that a self-transition bias can override isolated, low-confidence flips while
 * still allowing genuine, strong chord changes through. Essentia signals
 * "no confident chord" with a negative strength, which maps to the N state.
 */
function viterbiSmooth(labels: string[], strengths: number[]): number[] {
  const T = labels.length;
  if (T === 0) return [];

  const logStay = Math.log(STAY_PROB);
  const logSwitch = Math.log((1 - STAY_PROB) / (NUM_STATES - 1));

  const emit: number[][] = new Array(T);
  for (let t = 0; t < T; t++) emit[t] = buildEmission(labels[t], strengths[t]);

  const dp: number[][] = new Array(T);
  const back: number[][] = new Array(T);
  dp[0] = emit[0].slice(); // uniform prior over states
  for (let t = 1; t < T; t++) {
    dp[t] = new Array(NUM_STATES);
    back[t] = new Array(NUM_STATES);
    for (let s = 0; s < NUM_STATES; s++) {
      let bestPrev = 0;
      let bestScore = -Infinity;
      for (let p = 0; p < NUM_STATES; p++) {
        const score = dp[t - 1][p] + (p === s ? logStay : logSwitch);
        if (score > bestScore) {
          bestScore = score;
          bestPrev = p;
        }
      }
      dp[t][s] = bestScore + emit[t][s];
      back[t][s] = bestPrev;
    }
  }

  let last = 0;
  let bestEnd = -Infinity;
  for (let s = 0; s < NUM_STATES; s++) {
    if (dp[T - 1][s] > bestEnd) {
      bestEnd = dp[T - 1][s];
      last = s;
    }
  }
  const path = new Array<number>(T);
  path[T - 1] = last;
  for (let t = T - 1; t > 0; t--) path[t - 1] = back[t][path[t]];
  return path;
}

/** Per-segment emission log-probabilities over the 25-state chord space. */
function buildEmission(label: string, strength: number): number[] {
  const e = new Array<number>(NUM_STATES).fill(LOG_EPS);
  const idx = LABEL_TO_INDEX.get(label);
  if (strength <= 0 || idx === undefined) {
    e[NO_CHORD_INDEX] = 0; // log(1): no confident chord here
    return e;
  }
  const s = clamp01(strength);
  // Leftover mass after the detected triad, split between "no chord" and the
  // other 23 triads so Viterbi retains a path through them.
  const rest = ((1 - s) * (1 - NO_CHORD_PRIOR)) / (NUM_STATES - 2);
  for (let i = 0; i < NUM_STATES; i++) {
    if (i === idx) e[i] = Math.log(Math.max(s, 1e-6));
    else if (i === NO_CHORD_INDEX) e[i] = Math.log(Math.max((1 - s) * NO_CHORD_PRIOR, 1e-6));
    else e[i] = Math.log(Math.max(rest, 1e-6));
  }
  return e;
}

/** Merge consecutive equal-label spans into single chord blocks. */
function mergeChords(spans: ChordSpan[]): ChordSpan[] {
  const merged: ChordSpan[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && last.label === s.label) {
      last.end = s.end;
      last.confidence = Math.max(last.confidence, s.confidence);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

// --- small numeric helpers ---
function vectorToArray(es: any, v: unknown): number[] {
  const arr = es.vectorToArray(v);
  return Array.from(arr as Float32Array);
}
function safeDelete(v: any) {
  try {
    if (v && typeof v.delete === 'function') v.delete();
  } catch {
    /* ignore double-free */
  }
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
