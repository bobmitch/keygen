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

// --- Bar-aware chord cleanup -------------------------------------------------
//
// The decoder emits one chord per beat. It frequently holds the previous bar's
// chord for the *first beat* of a new bar (the old chord's notes ring/reverb past
// the downbeat, and the decoder's stay-bias resists switching on a single noisy
// beat), so e.g. a Bm->E change on a downbeat is reported a beat late and the old
// chord "leaks" into the next bar. A boundary that late sits a whole beat past the
// bar line, beyond any safe time-snap tolerance, so we instead fix it at the
// per-beat level where each beat's confidence is still available.

/** A beat that genuinely holds the *old* chord this confidently is never de-leaked. */
const LEAK_KEEP_CONF = 0.7;
/** The incoming chord must clear this to be trusted with the downbeat. */
const LEAK_MIN_SUPPORT = 0.5;
/** Only a carry-over this short (in beats) counts as bleed rather than a real chord. */
const MAX_LEAK_BEATS = 1;
const EPS = 1e-6;

interface BeatSeg {
  start: number;
  end: number;
  label: string;
  conf: number;
}

/**
 * Build display chord spans from the per-beat chord estimate, enforcing clean
 * chord breaks at bar lines.
 *
 * We resolve a chord per beat of the *current* grid (robust to a retimed/scaled
 * grid via time-overlap, not index), then at every downbeat pull a one-beat
 * carry-over of the previous bar's chord onto the bar line whenever a different
 * chord owns the rest of the bar — UNLESS that leading beat is confidently the old
 * chord (the "the chord really is there for that beat" exception). Finally we
 * merge equal-label neighbours and stretch the ends to cover the whole track.
 *
 * Pure + cheap: recompute on every bar-grid change so the leak vanishes live as
 * the user lines up the downbeat / meter.
 */
export function buildChordSpans(
  beatChords: ChordSpan[],
  bars: Bar[],
  beats: number[],
  duration: number,
): ChordSpan[] {
  if (beatChords.length === 0) return [];

  // Resolve one (label, confidence) per beat segment of the current grid.
  const segs: BeatSeg[] = [];
  if (beats.length >= 2) {
    for (let k = 0; k < beats.length - 1; k++) {
      const { label, conf } = resolveChord(beatChords, beats[k], beats[k + 1]);
      segs.push({ start: beats[k], end: beats[k + 1], label, conf });
    }
  }
  if (segs.length === 0) {
    // No usable beat grid — fall back to the raw spans merged as-is.
    return stretchEnds(mergeSpans(beatChords.map((c) => ({ ...c }))), duration);
  }

  if (bars.length > 0) deLeakDownbeats(segs, bars);

  const spans = segs.map((s) => ({ start: s.start, end: s.end, label: s.label, confidence: s.conf }));
  return stretchEnds(mergeSpans(spans), duration);
}

/**
 * For each downbeat, drop a single-beat bleed of the previous chord onto the bar
 * line so the new bar starts on its real chord. Mutates `segs` in place.
 */
function deLeakDownbeats(segs: BeatSeg[], bars: Bar[]): void {
  let si = 0;
  for (const bar of bars) {
    // First segment whose start sits on this downbeat.
    while (si < segs.length && segs[si].start < bar.start - EPS) si++;
    const first = si;
    if (first === 0 || first >= segs.length) continue; // need a previous bar to leak from
    if (Math.abs(segs[first].start - bar.start) > EPS) continue; // no beat on this downbeat

    // Last segment that starts within this bar.
    let last = first;
    while (last + 1 < segs.length && segs[last + 1].start < bar.end - EPS) last++;

    const prevLabel = segs[first - 1].label;
    if (prevLabel === 'N') continue;
    if (segs[first].label !== prevLabel) continue; // already a clean break at the bar line

    // Count how many leading beats of the bar carry the previous chord.
    let lead = 0;
    while (first + lead <= last && segs[first + lead].label === prevLabel) lead++;
    const barBeats = last - first + 1;
    if (lead >= barBeats) continue; // chord owns the whole bar -> genuine, not bleed
    if (lead > MAX_LEAK_BEATS) continue; // carried too long to be a one-beat bleed

    // The chord that takes over after the carry-over must dominate the remainder.
    const newLabel = segs[first + lead].label;
    if (newLabel === 'N' || newLabel === prevLabel) continue;
    const newConf = segs[first + lead].conf;
    if (newConf < LEAK_MIN_SUPPORT) continue; // don't replace a chord with a weak guess
    if (countLabel(segs, first + lead, last, newLabel) <= lead) continue;

    // Reassign the leaked leading beats to the incoming chord, but stop at (and
    // keep) any beat that is confidently the old chord — that one really is there.
    for (let i = 0; i < lead; i++) {
      if (segs[first + i].conf >= LEAK_KEEP_CONF) break;
      segs[first + i].label = newLabel;
      segs[first + i].conf = newConf;
    }
  }
}

/** Count beats in [lo, hi] carrying `label`. */
function countLabel(segs: BeatSeg[], lo: number, hi: number, label: string): number {
  let n = 0;
  for (let i = lo; i <= hi; i++) if (segs[i].label === label) n++;
  return n;
}

/** Decoded chord covering most of [s, e) by time overlap; 'N'/0 when none. */
function resolveChord(chords: ChordSpan[], s: number, e: number): { label: string; conf: number } {
  let label = 'N';
  let conf = 0;
  let best = 0;
  for (const c of chords) {
    const overlap = Math.min(e, c.end) - Math.max(s, c.start);
    if (overlap > best) {
      best = overlap;
      label = c.label;
      conf = c.confidence;
    }
  }
  return { label, conf };
}

/** Merge consecutive equal-label spans into single chord blocks. */
function mergeSpans(spans: ChordSpan[]): ChordSpan[] {
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

/** Stretch the first/last span so the lane covers the whole track. */
function stretchEnds(spans: ChordSpan[], duration: number): ChordSpan[] {
  if (spans.length) {
    spans[0].start = Math.min(spans[0].start, 0);
    spans[spans.length - 1].end = Math.max(spans[spans.length - 1].end, duration);
  }
  return spans;
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
