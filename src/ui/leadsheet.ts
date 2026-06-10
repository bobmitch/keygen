import type { AnalysisResult, ChordSpan } from '../types';

/**
 * Render a classic lead-sheet grid: one cell per bar showing the dominant chord,
 * grouped by section. Independent of the waveform for fast human reading.
 */
export function renderLeadsheet(el: HTMLElement, a: AnalysisResult) {
  el.innerHTML = '';
  if (a.bars.length === 0) {
    el.innerHTML = '<p class="hint">No bar grid available for this track.</p>';
    return;
  }

  for (const section of a.sections) {
    const barsInSection = a.bars.filter((b) => b.start >= section.start - 0.01 && b.start < section.end);
    if (barsInSection.length === 0) continue;

    const wrap = document.createElement('div');
    wrap.className = 'ls-section';

    const title = document.createElement('div');
    title.className = 'ls-section-title';
    title.textContent = `Section ${section.label}`;
    wrap.append(title);

    const grid = document.createElement('div');
    grid.className = 'ls-grid';
    for (const bar of barsInSection) {
      const cell = document.createElement('div');
      cell.className = 'ls-bar';
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
    wrap.append(grid);
    el.append(wrap);
  }
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
