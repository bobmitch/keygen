import type { AnalysisResult, ChordSpan } from '../types';

/**
 * Render a classic lead-sheet grid: one cell per bar showing the dominant chord.
 * Independent of the waveform for fast human reading.
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
    const chord = dominantChord(a.chords, bar.start, bar.end);
    if (chord && chord !== 'N') {
      cell.textContent = chord;
    } else {
      cell.classList.add('empty');
      cell.textContent = '·';
    }
    cell.title = `Bar ${bar.index}`;
    grid.append(cell);
  }
  el.append(grid);
}

/** Highlight the lead-sheet cell whose bar contains `time`. Cheap to call per frame. */
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
  if (activeIdx === prev) return;
  if (prev >= 0 && cells[prev]) cells[prev].classList.remove('playing');
  if (activeIdx >= 0) {
    cells[activeIdx].classList.add('playing');
    cells[activeIdx].scrollIntoView({ block: 'nearest' });
  }
  el.dataset.activeBar = String(activeIdx);
}

/** The chord covering the most time within [start, end). */
function dominantChord(chords: ChordSpan[], start: number, end: number): string | null {
  const totals = new Map<string, number>();
  for (const c of chords) {
    const overlap = Math.min(end, c.end) - Math.max(start, c.start);
    if (overlap > 0) totals.set(c.label, (totals.get(c.label) ?? 0) + overlap);
  }
  let best: string | null = null;
  let bestVal = 0;
  for (const [label, val] of totals) {
    if (label !== 'N' && val > bestVal) {
      bestVal = val;
      best = label;
    }
  }
  return best;
}
