// Tempo estimation from an onset envelope.
//
// Classic autocorrelation recipe: normalise the (enhanced) envelope, take its
// autocorrelation over the musically plausible lag range, weight it with a
// log-normal perceptual prior centred near 120 BPM, and read tempo candidates
// off the surviving peaks. Because the half/double-time relatives of the winner
// show up as ranked candidates with their own strengths, octave ambiguity falls
// out of the same analysis — no second estimator needed.

export interface TempoCandidate {
  bpm: number;
  /** Prior-weighted autocorrelation score; compare candidates by ratio. */
  strength: number;
}

export interface TempoEstimate {
  bpm: number;
  /** 0..1: normalised autocorrelation at the chosen lag (periodicity strength). */
  confidence: number;
  /** Candidates sorted by descending strength; first is the chosen tempo. */
  candidates: TempoCandidate[];
}

export interface TempoOptions {
  minBpm?: number;
  maxBpm?: number;
  /** Centre of the log-normal tempo prior. */
  priorBpm?: number;
  /** Width of the prior, in octaves. */
  priorOctaveStd?: number;
}

/**
 * Estimate tempo from an enhanced onset envelope (see `enhanceOdf`). Returns a
 * neutral low-confidence default when the signal is too short or too flat to
 * carry a periodicity.
 */
export function estimateTempo(env: Float32Array, fps: number, opts?: TempoOptions): TempoEstimate {
  const { minBpm = 40, maxBpm = 208, priorBpm = 120, priorOctaveStd = 1.0 } = opts ?? {};
  const fallback: TempoEstimate = { bpm: priorBpm, confidence: 0, candidates: [] };

  const n = env.length;
  const lagMin = Math.max(1, Math.floor((60 * fps) / maxBpm));
  const lagMax = Math.min(Math.ceil((60 * fps) / minBpm), Math.floor(n / 2));
  if (lagMax <= lagMin + 2) return fallback;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = env[i] - mean;
    variance += d * d;
  }
  variance /= n;
  if (variance < 1e-12) return fallback;

  // Normalised autocorrelation r[lag] in [-1, 1] over the plausible lag range.
  const lags = lagMax - lagMin + 1;
  const r = new Float64Array(lags);
  const score = new Float64Array(lags);
  const priorLag = (60 * fps) / priorBpm;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let acc = 0;
    const limit = n - lag;
    for (let t = 0; t < limit; t++) acc += (env[t] - mean) * (env[t + lag] - mean);
    const rv = acc / (limit * variance);
    const z = Math.log2(lag / priorLag) / priorOctaveStd;
    r[lag - lagMin] = rv;
    score[lag - lagMin] = Math.max(0, rv) * Math.exp(-0.5 * z * z);
  }

  // Peaks of the weighted score, refined with parabolic interpolation.
  const peaks: Array<{ lag: number; strength: number; r: number }> = [];
  for (let i = 1; i < lags - 1; i++) {
    if (score[i] > score[i - 1] && score[i] >= score[i + 1] && score[i] > 0) {
      const denom = score[i - 1] - 2 * score[i] + score[i + 1];
      const delta = denom !== 0 ? clamp(0.5 * ((score[i - 1] - score[i + 1]) / denom), -0.5, 0.5) : 0;
      peaks.push({ lag: lagMin + i + delta, strength: score[i], r: r[i] });
    }
  }
  if (peaks.length === 0) return fallback;
  peaks.sort((a, b) => b.strength - a.strength);

  const best = peaks[0];
  return {
    bpm: round1((60 * fps) / best.lag),
    confidence: clamp(best.r, 0, 1),
    candidates: peaks.slice(0, 5).map((p) => ({ bpm: round1((60 * fps) / p.lag), strength: p.strength })),
  };
}

/**
 * Strongest candidate roughly 2x or 0.5x of `bpm` that is competitive with the
 * winner — the tempo the track might "really" be at if the octave call is wrong.
 */
export function octaveAlternative(
  bpm: number,
  candidates: TempoCandidate[],
  minRelativeStrength = 0.4,
): number | undefined {
  if (candidates.length === 0) return undefined;
  const top = candidates[0].strength;
  for (const c of candidates) {
    if (isOctaveRelated(bpm, c.bpm) && c.strength >= minRelativeStrength * top) {
      return c.bpm;
    }
  }
  return undefined;
}

/** True when two tempi differ by roughly a factor of two (octave ambiguity). */
export function isOctaveRelated(a: number, b: number): boolean {
  if (!a || !b) return false;
  const ratio = a > b ? a / b : b / a;
  return Math.abs(ratio - 2) < 0.1;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
