import type { Bar, ChordSpan, Section } from '../types';

/**
 * Group detected beats into bars assuming a fixed meter. `downbeatOffset` is the
 * index of the beat treated as the first downbeat, so the user can fix the phase.
 * Cheap to recompute — call again whenever the offset / beatsPerBar changes.
 */
export function buildBars(
  beats: number[],
  beatsPerBar: number,
  downbeatOffset: number,
  duration: number,
): Bar[] {
  if (beats.length < 2) return [];
  const offset = ((downbeatOffset % beatsPerBar) + beatsPerBar) % beatsPerBar;
  const bars: Bar[] = [];
  let barIndex = 1;

  for (let i = offset; i < beats.length; i += beatsPerBar) {
    const barBeats = beats.slice(i, i + beatsPerBar);
    if (barBeats.length === 0) break;
    const start = barBeats[0];
    // Bar ends at the next downbeat, or extrapolate one beat past the last beat.
    const nextDownbeat = beats[i + beatsPerBar];
    const meanInterval = estimateBeatInterval(beats);
    const end = nextDownbeat ?? Math.min(duration, barBeats[barBeats.length - 1] + meanInterval);
    bars.push({ index: barIndex++, start, end, beats: barBeats });
  }
  return bars;
}

/**
 * Pull chord-span boundaries that sit just past a bar line back onto it.
 *
 * Beat-synchronous chord detection and the bar grid are derived independently
 * (and, once the user retimes the bars, can drift further apart), so a change the
 * detector places a fraction of a beat late leaves the previous chord "leaking"
 * into the start of the next bar. Snapping near-boundary edges to the bar line
 * removes that leak without disturbing genuine mid-bar changes: the tolerance is a
 * fraction of the local beat interval, so it scales with tempo and never reaches a
 * whole beat. Pure + cheap — recompute whenever the bar grid changes.
 */
export function snapChordsToBars(
  chords: ChordSpan[],
  bars: Bar[],
  beats: number[],
  tolBeats = 0.5,
): ChordSpan[] {
  if (chords.length < 2 || bars.length === 0) return chords;
  const tol = estimateBeatInterval(beats) * tolBeats;
  if (!(tol > 0)) return chords;

  const lines = bars.map((b) => b.start);
  // Spans are contiguous (each end equals the next start), so a single boundary
  // value is shared by neighbours; move both sides together.
  const out = chords.map((c) => ({ ...c }));
  const MIN_LEN = 1e-3;
  for (let i = 0; i < out.length - 1; i++) {
    const boundary = out[i].end;
    const line = nearestLine(lines, boundary, tol);
    if (line === null) continue;
    // Keep both adjacent spans non-degenerate and in order after the move.
    if (line - out[i].start < MIN_LEN || out[i + 1].end - line < MIN_LEN) continue;
    out[i].end = line;
    out[i + 1].start = line;
  }
  return out;
}

/** Nearest bar line to `t` within `tol`, or null when none is close enough. */
function nearestLine(lines: number[], t: number, tol: number): number | null {
  let best: number | null = null;
  let bestDist = tol;
  for (const line of lines) {
    const d = Math.abs(line - t);
    if (d <= bestDist) {
      bestDist = d;
      best = line;
    }
  }
  return best;
}

function estimateBeatInterval(beats: number[]): number {
  if (beats.length < 2) return 0.5;
  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)]; // median
}

/**
 * Detect structural section boundaries from a chroma self-similarity matrix using
 * a checkerboard-kernel novelty curve, then snap boundaries to the nearest bar.
 * Returns coarse blocks labelled A, B, C... with reuse for self-similar sections.
 */
export function detectSections(
  chroma: number[][],
  chromaTimes: number[],
  bars: Bar[],
  duration: number,
): Section[] {
  if (chroma.length < 8 || duration <= 0) {
    return [{ index: 1, start: 0, end: duration, label: 'A' }];
  }

  // Downsample chroma to keep the similarity matrix small (~one vector per ~0.5s).
  const targetFrames = Math.min(400, chroma.length);
  const step = chroma.length / targetFrames;
  const feat: number[][] = [];
  const featTimes: number[] = [];
  for (let i = 0; i < targetFrames; i++) {
    const idx = Math.floor(i * step);
    feat.push(normalizeVec(chroma[idx]));
    featTimes.push(chromaTimes[idx]);
  }

  const novelty = noveltyCurve(feat, kernelSize(feat.length));
  const peaks = pickPeaks(novelty, featTimes);

  // Convert novelty peak times into boundaries, snap to bars.
  const boundaries = [0];
  for (const t of peaks) {
    const snapped = snapToBar(t, bars);
    if (snapped - boundaries[boundaries.length - 1] > 4) boundaries.push(snapped); // min 4s sections
  }
  boundaries.push(duration);

  // Build sections and label by self-similarity of their mean chroma.
  const sections: Section[] = [];
  const labelVectors: { label: string; vec: number[] }[] = [];
  let nextLabel = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end - start < 1) continue;
    const meanVec = meanChromaBetween(chroma, chromaTimes, start, end);
    const label = assignLabel(meanVec, labelVectors, () => String.fromCharCode(65 + nextLabel++));
    sections.push({ index: sections.length + 1, start, end, label });
  }
  if (sections.length === 0) return [{ index: 1, start: 0, end: duration, label: 'A' }];
  return sections;
}

function kernelSize(n: number): number {
  // Odd kernel, ~8% of the track length, clamped to a sensible range.
  const k = Math.max(8, Math.min(48, Math.round(n * 0.08)));
  return k % 2 === 0 ? k + 1 : k;
}

/** Checkerboard-kernel novelty along the diagonal of the cosine self-similarity matrix. */
function noveltyCurve(feat: number[][], kSize: number): number[] {
  const n = feat.length;
  const half = Math.floor(kSize / 2);
  const novelty = new Array(n).fill(0);
  for (let c = 0; c < n; c++) {
    let sum = 0;
    for (let i = -half; i <= half; i++) {
      for (let j = -half; j <= half; j++) {
        const a = c + i;
        const b = c + j;
        if (a < 0 || b < 0 || a >= n || b >= n) continue;
        const sign = Math.sign(i) === Math.sign(j) ? 1 : -1; // checkerboard
        sum += sign * cosine(feat[a], feat[b]);
      }
    }
    novelty[c] = sum;
  }
  // Normalize 0..1.
  const max = Math.max(...novelty, 1e-9);
  const min = Math.min(...novelty, 0);
  return novelty.map((v) => (v - min) / (max - min));
}

function pickPeaks(novelty: number[], times: number[]): number[] {
  const peaks: number[] = [];
  const mean = novelty.reduce((a, b) => a + b, 0) / novelty.length;
  const threshold = mean + 0.15;
  for (let i = 2; i < novelty.length - 2; i++) {
    if (
      novelty[i] > threshold &&
      novelty[i] >= novelty[i - 1] &&
      novelty[i] >= novelty[i + 1] &&
      novelty[i] > novelty[i - 2] &&
      novelty[i] > novelty[i + 2]
    ) {
      peaks.push(times[i]);
    }
  }
  return peaks;
}

function snapToBar(t: number, bars: Bar[]): number {
  if (bars.length === 0) return t;
  let best = bars[0].start;
  let bestDist = Math.abs(t - best);
  for (const bar of bars) {
    const d = Math.abs(t - bar.start);
    if (d < bestDist) {
      bestDist = d;
      best = bar.start;
    }
  }
  return best;
}

function meanChromaBetween(chroma: number[][], times: number[], start: number, end: number): number[] {
  const sum = new Array(12).fill(0);
  let n = 0;
  for (let i = 0; i < chroma.length; i++) {
    if (times[i] >= start && times[i] < end) {
      for (let p = 0; p < 12; p++) sum[p] += chroma[i][p];
      n++;
    }
  }
  if (n > 0) for (let p = 0; p < 12; p++) sum[p] /= n;
  return normalizeVec(sum);
}

function assignLabel(
  vec: number[],
  known: { label: string; vec: number[] }[],
  mint: () => string,
): string {
  for (const k of known) {
    if (cosine(vec, k.vec) > 0.9) return k.label;
  }
  const label = mint();
  known.push({ label, vec });
  return label;
}

// --- vector helpers ---
function normalizeVec(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm < 1e-9) return v.slice();
  return v.map((x) => x / norm);
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
