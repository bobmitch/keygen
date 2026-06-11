import type { AnalysisResult, Bar, ChordSpan } from '../types';

/**
 * Minimum per-beat confidence required to introduce a *mid-bar* chord change.
 * Below this, a beat inherits the running chord instead of fragmenting the bar.
 * Tunable: higher = fewer, more trustworthy splits; lower = more granular.
 */
const SPLIT_CONF = 0.55;

interface Seg {
  label: string;
  /** Number of beats this segment spans. */
  beats: number;
  /** Confidence of the segment (max over its beats). */
  conf: number;
  /** Absolute time bounds, for progress/highlight during playback. */
  start: number;
  end: number;
}

/**
 * Render a classic lead-sheet grid: one cell per bar. Bars stay 4-per-row, but a
 * bar with a confident mid-bar chord change is subdivided into beat-proportional
 * segments (e.g. "C | G" for a 2+2 split), so granularity surfaces only where the
 * detector is sure. Independent of the waveform for fast human reading.
 */
export function renderLeadsheet(el: HTMLElement, a: AnalysisResult) {
  el.innerHTML = '';
  delete el.dataset.activeBar;
  if (a.bars.length === 0) {
    el.innerHTML = '<p class="hint">No bar grid available for this track.</p>';
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'ls-grid';
  for (const bar of a.bars) {
    const cell = document.createElement('div');
    cell.className = 'ls-bar';
    cell.dataset.start = String(bar.start);
    cell.dataset.end = String(bar.end);
    cell.title = `Bar ${bar.index}`;

    // Progress sweep overlay (width driven during playback).
    const fill = document.createElement('div');
    fill.className = 'ls-fill';
    cell.append(fill);

    const segs = barSegments(a.chords, bar);
    const row = document.createElement('div');
    row.className = 'ls-segs';

    const hasChord = segs.some((s) => s.label !== 'N');
    if (!hasChord) {
      cell.classList.add('empty');
      const seg = document.createElement('div');
      seg.className = 'ls-seg';
      seg.textContent = '·';
      seg.dataset.start = String(bar.start);
      seg.dataset.end = String(bar.end);
      row.append(seg);
    } else {
      if (segs.length > 1) cell.classList.add('split');
      for (const s of segs) {
        const seg = document.createElement('div');
        seg.className = 'ls-seg';
        seg.textContent = s.label === 'N' ? '·' : s.label;
        seg.dataset.start = String(s.start);
        seg.dataset.end = String(s.end);
        // Weight width by beat count so a 2+2 split reads as two halves.
        seg.style.flexGrow = String(s.beats);
        // Dim less-certain splits, mirroring the waveform lane's confidence cue.
        if (segs.length > 1) seg.style.opacity = String(0.55 + 0.45 * s.conf);
        row.append(seg);
      }
    }

    cell.append(row);
    grid.append(cell);
  }
  el.append(grid);
}

/**
 * Highlight the lead-sheet cell whose bar contains `time`, drive a progress sweep
 * within that bar, and mark the currently-sounding segment. Cheap to call per frame.
 */
export function highlightLeadsheet(el: HTMLElement, time: number) {
  const cells = el.querySelectorAll<HTMLElement>('.ls-bar');
  let activeIdx = -1;
  for (let i = 0; i < cells.length; i++) {
    const start = Number(cells[i].dataset.start);
    const end = Number(cells[i].dataset.end);
    if (time >= start && time < end) {
      activeIdx = i;
      break;
    }
  }

  const prev = el.dataset.activeBar !== undefined ? Number(el.dataset.activeBar) : -1;
  if (activeIdx !== prev) {
    if (prev >= 0 && cells[prev]) resetBar(cells[prev]);
    if (activeIdx >= 0) {
      cells[activeIdx].classList.add('playing');
      cells[activeIdx].scrollIntoView({ block: 'nearest' });
    }
    el.dataset.activeBar = String(activeIdx);
  }

  // Per-frame: advance the progress sweep and the active segment.
  if (activeIdx >= 0 && cells[activeIdx]) updateProgress(cells[activeIdx], time);
}

/** Advance the progress fill and flag the segment under the playhead. */
function updateProgress(cell: HTMLElement, time: number) {
  const start = Number(cell.dataset.start);
  const end = Number(cell.dataset.end);
  const frac = clamp01((time - start) / (end - start || 1));
  const fill = cell.querySelector<HTMLElement>('.ls-fill');
  if (fill) fill.style.width = `${(frac * 100).toFixed(2)}%`;

  const segs = cell.querySelectorAll<HTMLElement>('.ls-seg');
  for (const seg of segs) {
    const ss = Number(seg.dataset.start);
    const se = Number(seg.dataset.end);
    seg.classList.toggle('on', time >= ss && time < se);
  }
}

/** Clear playback state when a bar is no longer active. */
function resetBar(cell: HTMLElement) {
  cell.classList.remove('playing');
  const fill = cell.querySelector<HTMLElement>('.ls-fill');
  if (fill) fill.style.width = '0%';
  for (const seg of cell.querySelectorAll<HTMLElement>('.ls-seg.on')) {
    seg.classList.remove('on');
  }
}

/**
 * Break a bar into beat-proportional chord segments, splitting only where the
 * detector is confident. Low-confidence beats (and mid-bar "no-chord") inherit the
 * running chord, so uncertain bars collapse to a single dominant chord (the prior
 * behaviour) and only sure mid-bar changes become visible splits.
 */
function barSegments(chords: ChordSpan[], bar: Bar): Seg[] {
  const beats = bar.beats;
  if (beats.length === 0) {
    const { label, conf } = beatChord(chords, bar.start, bar.end);
    return [{ label, beats: 1, conf, start: bar.start, end: bar.end }];
  }

  // Resolve each beat to a chord; carry the running chord forward across any beat
  // that is low-confidence or no-chord, so only confident beats can start a change.
  let running = dominantLabel(chords, bar);
  const per: Seg[] = [];
  for (let i = 0; i < beats.length; i++) {
    const s = beats[i];
    const e = i + 1 < beats.length ? beats[i + 1] : bar.end;
    const { label, conf } = beatChord(chords, s, e);
    const trusted = label !== 'N' && conf >= SPLIT_CONF;
    const use = trusted ? label : running;
    if (trusted) running = label;
    const last = per[per.length - 1];
    if (last && last.label === use) {
      last.end = e;
      last.beats += 1;
      last.conf = Math.max(last.conf, conf);
    } else {
      per.push({ label: use, beats: 1, conf: trusted ? conf : 0, start: s, end: e });
    }
  }
  return per;
}

/** Best chord covering [s, e), weighted by overlap; returns label + its confidence. */
function beatChord(chords: ChordSpan[], s: number, e: number): { label: string; conf: number } {
  let label = 'N';
  let conf = 0;
  let bestOverlap = 0;
  for (const c of chords) {
    if (c.label === 'N') continue;
    const overlap = Math.min(e, c.end) - Math.max(s, c.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      label = c.label;
      conf = c.confidence;
    }
  }
  return { label, conf };
}

/** Chord covering the most time within the bar (excluding no-chord), or 'N'. */
function dominantLabel(chords: ChordSpan[], bar: Bar): string {
  const totals = new Map<string, number>();
  for (const c of chords) {
    if (c.label === 'N') continue;
    const overlap = Math.min(bar.end, c.end) - Math.max(bar.start, c.start);
    if (overlap > 0) totals.set(c.label, (totals.get(c.label) ?? 0) + overlap);
  }
  let best = 'N';
  let bestVal = 0;
  for (const [label, val] of totals) {
    if (val > bestVal) {
      bestVal = val;
      best = label;
    }
  }
  return best;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
