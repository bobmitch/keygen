/// <reference lib="webworker" />
// Analysis pipeline worker — pure TypeScript DSP (src/dsp/), no external engine.
//
// Two STFT passes over the decoded mono signal:
//   - a fine one (2048/512) for the onset envelope, since beat placement needs
//     ~10 ms resolution;
//   - a coarse one (4096/2048) for chroma plus the flux / low-band cues the
//     downbeat scorer reads on the chroma time grid.
// Tempo, beats, key, downbeat salience, and per-beat chords all derive from
// those two passes; nothing is recomputed elsewhere.

import type {
  AnalyzeRequest,
  WorkerAnalysis,
  WorkerMessage,
} from '../types';
import { beatDownbeatStrength } from '../analysis/downbeat';
import { estimateBeatChords } from '../analysis/chords';
import { bpmFromBeats, trackBeats } from '../dsp/beats';
import { chromaFromSpectrum } from '../dsp/chroma';
import { estimateKey } from '../dsp/key';
import { enhanceOdf, lowBandEnergy, onsetEnvelope, spectralFluxRaw } from '../dsp/onset';
import { frameCount, stftFrames } from '../dsp/stft';
import { estimateTempo, octaveAlternative } from '../dsp/tempo';

// Chroma framing. The chord decoder's beat-segment aggregation was tuned
// against this grid, so it stays at the legacy 46 ms hop.
const CHROMA_FRAME_SIZE = 4096;
const CHROMA_HOP_SIZE = 2048;

// Finer framing for the onset/beat path (~11.6 ms hops at 44.1 kHz).
const ONSET_FRAME_SIZE = 2048;
const ONSET_HOP_SIZE = 512;

// Upper edge of the "kick/bass" band used for the downbeat low-energy cue.
const LOW_BAND_HZ = 150;

// Tempo search range (BPM).
const MIN_BPM = 40;
const MAX_BPM = 208;

function post(msg: WorkerMessage) {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

self.onmessage = (e: MessageEvent<AnalyzeRequest>) => {
  const msg = e.data;
  if (msg.type !== 'analyze') return;
  try {
    const analysis = analyze(msg.samples, msg.sampleRate);
    post({ type: 'result', analysis });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

function analyze(samples: Float32Array, sampleRate: number): WorkerAnalysis {
  // --- Tempo + beat grid ---
  post({ type: 'progress', stage: 'Detecting tempo & beats' });
  const onset = onsetEnvelope(samples, sampleRate, ONSET_FRAME_SIZE, ONSET_HOP_SIZE, (v) =>
    post({ type: 'progress', stage: 'Detecting tempo & beats', value: v * 0.35 }),
  );
  const env = enhanceOdf(onset.odf, onset.fps);
  const tempo = estimateTempo(env, onset.fps, { minBpm: MIN_BPM, maxBpm: MAX_BPM });
  const beats = trackBeats(env, onset.fps, tempo.bpm, onset.times);
  const bpm = round1(bpmFromBeats(beats) ?? tempo.bpm);
  const altBpm = octaveAlternative(bpm, tempo.candidates);

  // --- Per-frame chroma + onset/low-band features for downbeat scoring ---
  post({ type: 'progress', stage: 'Computing chroma features' });
  const { chroma, chromaTimes, flux, lowEnergy } = chromaFeatures(samples, sampleRate);

  // --- Key + mode ---
  post({ type: 'progress', stage: 'Detecting key & mode' });
  const key = estimateKey(chroma);

  // --- Per-beat downbeat salience (onset + bass + harmonic change) ---
  const downbeatStrength = beatDownbeatStrength(beats, {
    frameTimes: chromaTimes,
    flux,
    lowEnergy,
    chroma,
  });

  // --- Chords (template-matched beat-synchronous chroma + Viterbi smoothing) ---
  // Kept per-beat here; merging + bar-aware boundary cleanup happen on the main
  // thread so they re-run live as the user retimes the bar grid.
  post({ type: 'progress', stage: 'Estimating chords' });
  const beatChords = estimateBeatChords(beats, chroma, chromaTimes, samples.length / sampleRate, key);

  return {
    key,
    bpm,
    bpmConfidence: tempo.confidence,
    altBpm,
    beats,
    beatChords,
    chroma,
    chromaTimes,
    downbeatStrength,
  };
}

/** Single coarse STFT pass shared by the chroma, flux, and low-band features. */
function chromaFeatures(samples: Float32Array, sampleRate: number) {
  const total = frameCount(samples.length, CHROMA_FRAME_SIZE, CHROMA_HOP_SIZE);
  const chroma: number[][] = [];
  const chromaTimes: number[] = [];
  const flux: number[] = [];
  const lowEnergy: number[] = [];
  const prev = new Float32Array(CHROMA_FRAME_SIZE / 2 + 1);
  let first = true;
  for (const frame of stftFrames(samples, sampleRate, CHROMA_FRAME_SIZE, CHROMA_HOP_SIZE)) {
    lowEnergy.push(lowBandEnergy(frame.mag, sampleRate, CHROMA_FRAME_SIZE, LOW_BAND_HZ));
    flux.push(first ? 0 : spectralFluxRaw(frame.mag, prev));
    prev.set(frame.mag);
    first = false;
    chroma.push(chromaFromSpectrum(frame.mag, sampleRate, CHROMA_FRAME_SIZE));
    chromaTimes.push(frame.time);
    if (frame.index % 200 === 0) {
      post({
        type: 'progress',
        stage: 'Computing chroma features',
        value: 0.35 + (total > 0 ? (frame.index / total) * 0.6 : 0),
      });
    }
  }
  return { chroma, chromaTimes, flux, lowEnergy };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
