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

  // --- Chords (template match on beat-synchronous chroma) ---
  post({ type: 'progress', stage: 'Estimating chords' });
  const chords = estimateChords(beats, chroma, chromaTimes, samples.length / sampleRate);

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

/** 24 binary triad templates (12 major + 12 minor) in HPCP (A-first) index space. */
function buildChordTemplates(): { label: string; vec: number[] }[] {
  const templates: { label: string; vec: number[] }[] = [];
  for (let root = 0; root < 12; root++) {
    const major = new Array(12).fill(0);
    major[root] = major[(root + 4) % 12] = major[(root + 7) % 12] = 1;
    templates.push({ label: NOTE_NAMES[root], vec: major });

    const minor = new Array(12).fill(0);
    minor[root] = minor[(root + 3) % 12] = minor[(root + 7) % 12] = 1;
    templates.push({ label: NOTE_NAMES[root] + 'm', vec: minor });
  }
  return templates;
}

const CHORD_TEMPLATES = buildChordTemplates();

function estimateChords(
  beats: number[],
  chroma: number[][],
  chromaTimes: number[],
  duration: number,
): ChordSpan[] {
  // Build the segment boundaries from beats; fall back to a fixed grid if no beats.
  let bounds: number[];
  if (beats.length >= 2) {
    bounds = [0, ...beats, duration];
  } else {
    bounds = [];
    for (let t = 0; t <= duration; t += 0.5) bounds.push(t);
  }
  // De-dup / sort.
  bounds = Array.from(new Set(bounds)).sort((a, b) => a - b);

  const raw: ChordSpan[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (end - start < 0.05) continue;
    const avg = averageChroma(chroma, chromaTimes, start, end);
    const match = matchChord(avg);
    raw.push({ start, end, label: match.label, confidence: match.confidence });
  }

  return mergeChords(raw);
}

function averageChroma(
  chroma: number[][],
  times: number[],
  start: number,
  end: number,
): number[] {
  const sum = new Array(12).fill(0);
  let n = 0;
  for (let i = 0; i < chroma.length; i++) {
    if (times[i] >= start && times[i] < end) {
      for (let p = 0; p < 12; p++) sum[p] += chroma[i][p];
      n++;
    }
  }
  if (n === 0) return sum;
  for (let p = 0; p < 12; p++) sum[p] /= n;
  return sum;
}

function matchChord(chroma: number[]): { label: string; confidence: number } {
  const norm = l2norm(chroma);
  if (norm < 1e-6) return { label: 'N', confidence: 0 };

  let best = -Infinity;
  let second = -Infinity;
  let bestLabel = 'N';
  for (const t of CHORD_TEMPLATES) {
    const score = dot(chroma, t.vec) / (norm * Math.sqrt(3));
    if (score > best) {
      second = best;
      best = score;
      bestLabel = t.label;
    } else if (score > second) {
      second = score;
    }
  }
  // Confidence: how much the winner stands out from the runner-up.
  const confidence = clamp01(best - Math.max(0, second));
  if (best < 0.5) return { label: 'N', confidence: 0 };
  return { label: bestLabel, confidence };
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
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function l2norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
