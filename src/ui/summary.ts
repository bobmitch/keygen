import type { AnalysisResult } from '../types';

function confClass(v: number): string {
  if (v >= 0.66) return 'high';
  if (v >= 0.4) return 'mid';
  return 'low';
}

function confChip(label: string, v: number): string {
  return `<span class="conf"><span class="dot ${confClass(v)}"></span>${label} ${Math.round(v * 100)}%</span>`;
}

export function renderSummary(el: HTMLElement, a: AnalysisResult) {
  const k = a.key;
  const bpm = a.bpm;
  const octaveWarn = bpm.octaveAmbiguous
    ? `<span class="conf"><span class="dot mid"></span>cross-check ${bpm.crossCheckBpm} — try ½/2×</span>`
    : bpm.crossCheckBpm
      ? `<span class="conf"><span class="dot high"></span>cross-check ${bpm.crossCheckBpm}</span>`
      : '';

  el.innerHTML = `
    <div class="stat primary">
      <div class="label">Key / Mode</div>
      <div class="value">${k.key}<span class="unit">${k.scale}</span></div>
      ${confChip('confidence', k.strength)}
    </div>
    <div class="stat primary">
      <div class="label">Tempo</div>
      <div class="value">${bpm.bpm}<span class="unit">BPM</span></div>
      ${confChip('confidence', bpm.confidence)}
      ${octaveWarn}
    </div>
    <div class="stat">
      <div class="label">Meter</div>
      <div class="value">${a.beatsPerBar}<span class="unit">/4</span></div>
      <span class="conf"><span class="dot mid"></span>assumed</span>
    </div>
    <div class="stat">
      <div class="label">Bars</div>
      <div class="value">${a.bars.length}</div>
    </div>
    <div class="stat">
      <div class="label">Sections</div>
      <div class="value">${a.sections.length}</div>
    </div>
    <div class="stat">
      <div class="label">Duration</div>
      <div class="value">${formatDuration(a.duration)}</div>
    </div>
  `;
}

function formatDuration(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
