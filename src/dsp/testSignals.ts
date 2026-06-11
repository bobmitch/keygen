// Deterministic synthetic signals for DSP tests: known tempi, known keys,
// known partials — ground truth the estimators must recover.

/** Mulberry32 PRNG: tiny, seedable, deterministic across platforms. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Chroma bin (0 = A) of a MIDI note, matching the analysis pitch-class layout. */
export function midiToChromaBin(midi: number): number {
  return (((midi - 69) % 12) + 12) % 12;
}

/** Sum of sines with a few decaying harmonics per note — a synthetic "chord". */
export function chordSignal(
  midiNotes: number[],
  durationSec: number,
  sampleRate: number,
): Float32Array {
  const n = Math.round(durationSec * sampleRate);
  const out = new Float32Array(n);
  const harmonicAmps = [1, 0.4, 0.2];
  const scale = 0.3 / midiNotes.length;
  for (const midi of midiNotes) {
    const f = midiToFreq(midi);
    for (let h = 0; h < harmonicAmps.length; h++) {
      const w = (2 * Math.PI * f * (h + 1)) / sampleRate;
      const amp = harmonicAmps[h] * scale;
      for (let i = 0; i < n; i++) out[i] += amp * Math.sin(w * i);
    }
  }
  return out;
}

/** Concatenate one synthetic chord per entry of `progression`. */
export function progressionSignal(
  progression: number[][],
  secondsEach: number,
  sampleRate: number,
): Float32Array {
  const chordLen = Math.round(secondsEach * sampleRate);
  const out = new Float32Array(chordLen * progression.length);
  progression.forEach((notes, i) => {
    out.set(chordSignal(notes, secondsEach, sampleRate), i * chordLen);
  });
  return out;
}

export interface ClickTrack {
  samples: Float32Array;
  /** Exact onset time (s) of each click. */
  clickTimes: number[];
}

/**
 * Metronome-like track: an identical short decaying noise burst at every beat
 * (identical bursts keep the autocorrelation peaks sharp and the test stable).
 */
export function clickTrack(
  bpm: number,
  durationSec: number,
  sampleRate: number,
  seed = 1,
): ClickTrack {
  const rng = mulberry32(seed);
  const burstLen = Math.round(0.02 * sampleRate);
  const burst = new Float32Array(burstLen);
  const tau = 0.005 * sampleRate;
  for (let i = 0; i < burstLen; i++) burst[i] = (rng() * 2 - 1) * Math.exp(-i / tau);

  const n = Math.round(durationSec * sampleRate);
  const samples = new Float32Array(n);
  const clickTimes: number[] = [];
  const step = 60 / bpm;
  for (let t = 0.1; t < durationSec - 0.1; t += step) {
    const start = Math.round(t * sampleRate);
    for (let i = 0; i < burstLen && start + i < n; i++) samples[start + i] += burst[i];
    clickTimes.push(start / sampleRate);
  }
  return { samples, clickTimes };
}
