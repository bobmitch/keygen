// Dynamic-programming beat tracker (Ellis, "Beat Tracking by Dynamic
// Programming", JNMR 2007 — the algorithm behind librosa.beat.beat_track).
//
// Given an onset envelope and a tempo estimate, every frame scores how good a
// beat it would be: its onset strength plus the best previous beat's score,
// penalised by how far the spacing deviates from the target period. Backtracing
// from the best end state yields a beat grid that is locally flexible but
// globally regular.

/** Spacing penalty weight; larger values force a more rigid grid. */
const TIGHTNESS = 100;

/**
 * Track beats through an enhanced onset envelope (see `enhanceOdf`) at the
 * given tempo. `times` maps frame indices to seconds (from `onsetEnvelope`).
 * Returns beat times in seconds; empty when the signal is too short or flat.
 */
export function trackBeats(
  env: Float32Array,
  fps: number,
  bpm: number,
  times: ArrayLike<number>,
): number[] {
  const n = env.length;
  if (!(bpm > 0) || n === 0) return [];
  const period = (60 * fps) / bpm;
  if (n < period * 2) return [];

  // Normalise by the envelope's energy and smooth around the beat scale so a
  // beat slightly off an onset peak still collects its evidence.
  let energy = 0;
  for (let i = 0; i < n; i++) energy += env[i] * env[i];
  const std = Math.sqrt(energy / n);
  if (std < 1e-12) return [];
  const normalized = new Float32Array(n);
  for (let i = 0; i < n; i++) normalized[i] = env[i] / std;
  const localscore = gaussianSmooth(normalized, period / 32);

  // Forward pass: best predecessor for each frame within [period/2, 2*period].
  const pMin = Math.max(1, Math.round(period / 2));
  const pMax = Math.min(n - 1, Math.round(period * 2));
  const txcost = new Float64Array(pMax - pMin + 1);
  for (let d = pMin; d <= pMax; d++) {
    const lnr = Math.log(d / period);
    txcost[d - pMin] = -TIGHTNESS * lnr * lnr;
  }
  const backlink = new Int32Array(n).fill(-1);
  const cumscore = new Float64Array(n);
  let maxLocal = 0;
  for (let i = 0; i < n; i++) if (localscore[i] > maxLocal) maxLocal = localscore[i];
  const startThreshold = 0.01 * maxLocal;
  let beforeFirstBeat = true;
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bestScore = -Infinity;
    const dHi = Math.min(pMax, i);
    for (let d = pMin; d <= dHi; d++) {
      const sc = cumscore[i - d] + txcost[d - pMin];
      if (sc > bestScore) {
        bestScore = sc;
        best = i - d;
      }
    }
    if (best >= 0) {
      cumscore[i] = localscore[i] + bestScore;
      backlink[i] = best;
    } else {
      cumscore[i] = localscore[i];
    }
    // Don't chain beats out of the leading silence: until the first real onset,
    // every frame restarts the track.
    if (beforeFirstBeat) {
      if (localscore[i] >= startThreshold) beforeFirstBeat = false;
      else backlink[i] = -1;
    }
  }

  // Pick the last beat: the final cumscore local maximum that is still
  // competitive (>= half the median peak), so a fade-out doesn't truncate it.
  const peakIdx: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (cumscore[i] > cumscore[i - 1] && cumscore[i] >= cumscore[i + 1]) peakIdx.push(i);
  }
  if (peakIdx.length === 0) return [];
  const threshold = 0.5 * median(peakIdx.map((i) => cumscore[i]));
  let tail = -1;
  for (const i of peakIdx) if (cumscore[i] >= threshold) tail = i;
  if (tail < 0) return [];

  let frames: number[] = [];
  for (let b = tail; b >= 0; b = backlink[b]) frames.push(b);
  frames.reverse();

  frames = trimWeakEdges(frames, localscore);
  return frames.map((f) => times[f]);
}

/** Tempo implied by the median inter-beat interval; undefined for < 2 beats. */
export function bpmFromBeats(beats: number[]): number | undefined {
  if (beats.length < 2) return undefined;
  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
  const med = median(intervals);
  if (!(med > 1e-6)) return undefined;
  return 60 / med;
}

/**
 * Drop leading/trailing beats whose (locally smoothed) onset support is weak —
 * the DP otherwise happily extrapolates the grid into silence at the edges.
 */
function trimWeakEdges(frames: number[], localscore: Float32Array): number[] {
  const k = frames.length;
  if (k === 0) return frames;
  const w = hann(5);
  const smooth = new Float64Array(k);
  let sq = 0;
  for (let i = 0; i < k; i++) {
    let acc = 0;
    for (let j = 0; j < 5; j++) {
      const idx = i + j - 2;
      if (idx >= 0 && idx < k) acc += localscore[frames[idx]] * w[j];
    }
    smooth[i] = acc;
    sq += acc * acc;
  }
  const threshold = 0.5 * Math.sqrt(sq / k);
  let first = 0;
  while (first < k && smooth[first] <= threshold) first++;
  let last = k - 1;
  while (last >= 0 && smooth[last] <= threshold) last--;
  if (first > last) return frames;
  return frames.slice(first, last + 1);
}

/** Zero-padded "same" convolution with a Gaussian kernel of the given std. */
function gaussianSmooth(x: Float32Array, sigma: number): Float32Array {
  const n = x.length;
  if (sigma < 0.5) return x.slice();
  const half = Math.max(1, Math.ceil(4 * sigma));
  const kernel = new Float64Array(2 * half + 1);
  let sum = 0;
  for (let i = -half; i <= half; i++) {
    const v = Math.exp(-0.5 * (i / sigma) * (i / sigma));
    kernel[i + half] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const jLo = Math.max(-half, -i);
    const jHi = Math.min(half, n - 1 - i);
    for (let j = jLo; j <= jHi; j++) acc += x[i + j] * kernel[j + half];
    out[i] = acc;
  }
  return out;
}

function hann(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  return w;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}
