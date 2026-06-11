/// <reference lib="webworker" />
import { EssentiaWASM } from 'essentia.js/dist/essentia-wasm.es.js';
import Essentia from 'essentia.js/dist/essentia.js-core.es.js';
import type {
  AnalyzeRequest,
  WorkerAnalysis,
  WorkerMessage,
} from '../types';
import { beatDownbeatStrength } from '../analysis/downbeat';
import { estimateChords } from '../analysis/chords';

const FRAME_SIZE = 4096;
const HOP_SIZE = 2048;

// Upper edge of the "kick/bass" band used for the downbeat low-energy cue.
const LOW_BAND_HZ = 150;

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

  // --- Per-frame chroma (HPCP) + onset/low-band features for downbeat scoring ---
  post({ type: 'progress', stage: 'Computing chroma features' });
  const { chroma, chromaTimes, flux, lowEnergy } = computeChroma(es, samples, sampleRate);

  // --- Per-beat downbeat salience (onset + bass + harmonic change) ---
  const downbeatStrength = beatDownbeatStrength(beats, {
    frameTimes: chromaTimes,
    flux,
    lowEnergy,
    chroma,
  });

  // --- Chords (template-matched beat-synchronous chroma + Viterbi smoothing) ---
  post({ type: 'progress', stage: 'Estimating chords' });
  const chords = estimateChords(beats, chroma, chromaTimes, samples.length / sampleRate, key);

  return {
    key,
    bpm,
    bpmConfidence,
    beats,
    chords,
    chroma,
    chromaTimes,
    downbeatStrength,
  };
}

function computeChroma(es: any, samples: Float32Array, sampleRate: number) {
  const frames = es.FrameGenerator(samples, FRAME_SIZE, HOP_SIZE);
  const chroma: number[][] = [];
  const chromaTimes: number[] = [];
  // Onset / bass cues for downbeat scoring, derived from the same magnitude
  // spectrum we already compute for chroma (no extra FFTs).
  const flux: number[] = [];
  const lowEnergy: number[] = [];
  const lowBin = Math.max(1, Math.round((LOW_BAND_HZ * FRAME_SIZE) / sampleRate));
  let prevSpec: Float32Array | null = null;
  const count = frames.size();
  for (let i = 0; i < count; i++) {
    const frame = frames.get(i);
    const win = es.Windowing(frame, true, FRAME_SIZE, 'hann');
    const spec = es.Spectrum(win.frame, FRAME_SIZE);
    const specArr = es.vectorToArray(spec.spectrum) as Float32Array;
    // Low-band (kick/bass) energy: sum of magnitude^2 below LOW_BAND_HZ (skip DC).
    let lowSum = 0;
    for (let b = 1; b <= lowBin && b < specArr.length; b++) lowSum += specArr[b] * specArr[b];
    lowEnergy.push(lowSum);
    // Half-wave-rectified spectral flux vs the previous frame (onset novelty).
    let fluxSum = 0;
    if (prevSpec) {
      const len = Math.min(specArr.length, prevSpec.length);
      for (let b = 0; b < len; b++) {
        const d = specArr[b] - prevSpec[b];
        if (d > 0) fluxSum += d;
      }
    }
    flux.push(fluxSum);
    prevSpec = specArr;
    const peaks = es.SpectralPeaks(spec.spectrum, -1000, 5000, 100, 40, 'magnitude', sampleRate);
    // NB: maxShifted MUST stay false. When true, HPCP rotates every frame so its
    // peak lands on bin 0, which destroys the absolute pitch-class mapping the
    // chord templates (and cross-frame section similarity) depend on.
    const hpcpRes = es.HPCP(
      peaks.frequencies,
      peaks.magnitudes,
      true, 500, 8, 5000, false, 40, false, 'unitMax', 440, sampleRate, 12,
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
  return { chroma, chromaTimes, flux, lowEnergy };
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
