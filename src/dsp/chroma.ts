// Spectral-peak chroma (HPCP-style; Gómez 2006).
//
// Instead of binning raw FFT magnitudes (which smears energy across pitch
// classes), only spectral peaks contribute, each spread over nearby pitch-class
// bins with a cosine^2 window and folded down from its possible harmonic
// positions (a peak at 3f is evidence for a fundamental at f). Bin 0 is A
// (440 Hz reference) — the layout the chord templates, key profiles, and
// section similarity all assume. Peak positions keep their absolute pitch-class
// mapping; nothing here is rotated per frame.

export interface ChromaOptions {
  minFreq?: number;
  maxFreq?: number;
  /** Strongest peaks kept per frame. */
  maxPeaks?: number;
  /** Subharmonic positions each peak contributes to (1 = fundamental only). */
  harmonics?: number;
  /** Geometric weight decay across those harmonic positions. */
  harmonicDecay?: number;
  /** Half-width, in semitones, of the cosine^2 spreading window. */
  windowSemitones?: number;
  referenceHz?: number;
}

/**
 * 12-bin chroma (bin 0 = A) for one magnitude spectrum frame, unit-max
 * normalised. Returns all zeros for (near-)silent frames.
 */
export function chromaFromSpectrum(
  mag: Float32Array,
  sampleRate: number,
  frameSize: number,
  opts?: ChromaOptions,
): number[] {
  const {
    minFreq = 40,
    maxFreq = 5000,
    maxPeaks = 60,
    harmonics = 8,
    harmonicDecay = 0.6,
    windowSemitones = 1,
    referenceHz = 440,
  } = opts ?? {};

  const out = new Array<number>(12).fill(0);
  const binHz = sampleRate / frameSize;
  const bLo = Math.max(1, Math.ceil(minFreq / binHz));
  const bHi = Math.min(mag.length - 2, Math.floor(maxFreq / binHz));

  // Local maxima with parabolic refinement of frequency and magnitude.
  const peaks: Array<{ freq: number; mag: number }> = [];
  for (let b = bLo; b <= bHi; b++) {
    const m = mag[b];
    if (m <= 1e-9 || m <= mag[b - 1] || m < mag[b + 1]) continue;
    const denom = mag[b - 1] - 2 * m + mag[b + 1];
    const delta = denom !== 0 ? clamp(0.5 * ((mag[b - 1] - mag[b + 1]) / denom), -0.5, 0.5) : 0;
    peaks.push({
      freq: (b + delta) * binHz,
      mag: m - 0.25 * (mag[b - 1] - mag[b + 1]) * delta,
    });
  }
  if (peaks.length === 0) return out;
  peaks.sort((a, b) => b.mag - a.mag);
  if (peaks.length > maxPeaks) peaks.length = maxPeaks;

  for (const peak of peaks) {
    const energy = peak.mag * peak.mag;
    for (let h = 1; h <= harmonics; h++) {
      const f0 = peak.freq / h;
      if (f0 < 27.5) break; // below A0: not a plausible fundamental
      const weight = Math.pow(harmonicDecay, h - 1);
      // Fractional pitch-class position of f0, in semitones above A.
      const pos = mod12(12 * Math.log2(f0 / referenceHz));
      for (let k = Math.ceil(pos - windowSemitones); k <= Math.floor(pos + windowSemitones); k++) {
        const d = (pos - k) / windowSemitones;
        const w = Math.cos((Math.PI / 2) * d);
        out[((k % 12) + 12) % 12] += energy * weight * w * w;
      }
    }
  }

  let max = 0;
  for (let p = 0; p < 12; p++) if (out[p] > max) max = out[p];
  if (max > 1e-12) for (let p = 0; p < 12; p++) out[p] /= max;
  return out;
}

function mod12(v: number): number {
  return ((v % 12) + 12) % 12;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
