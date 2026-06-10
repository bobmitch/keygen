import type { AnalysisResult, DecodedAudio } from '../types';

// Lane heights (CSS px), top to bottom.
const WAVE_H = 130;
const CHORD_H = 46;
const BARS_H = 30;
const SECTION_H = 34;
const AXIS_H = 22;
const TOTAL_H = WAVE_H + CHORD_H + BARS_H + SECTION_H + AXIS_H;

const WAVE_TOP = 0;
const CHORD_TOP = WAVE_H;
const BARS_TOP = CHORD_H + WAVE_H;
const SECTION_TOP = BARS_TOP + BARS_H;
const AXIS_TOP = SECTION_TOP + SECTION_H;

// Section label -> hue palette (distinct, reused per repeated section).
const SECTION_HUES = [170, 265, 30, 330, 200, 95, 50, 305];

export class Chart {
  private scrollEl: HTMLElement;
  private stageEl: HTMLElement;
  private canvas: HTMLCanvasElement;
  private playheadEl: HTMLElement;
  private ctx: CanvasRenderingContext2D;

  private decoded: DecodedAudio | null = null;
  private analysis: AnalysisResult | null = null;
  private pxPerSec = 0; // 0 => fit to container on first data load
  private playhead = 0;
  private seekCb: (t: number) => void = () => {};

  constructor(
    scrollEl: HTMLElement,
    stageEl: HTMLElement,
    canvas: HTMLCanvasElement,
    playheadEl: HTMLElement,
  ) {
    this.scrollEl = scrollEl;
    this.stageEl = stageEl;
    this.canvas = canvas;
    this.playheadEl = playheadEl;
    this.ctx = canvas.getContext('2d')!;
    canvas.addEventListener('click', (e) => this.handleClick(e));
  }

  /** Default zoom that fits the whole track in the visible scroll width. */
  fitZoom(duration: number): number {
    const w = this.scrollEl.clientWidth || 900;
    return Math.max(8, w / Math.max(1, duration));
  }

  setData(decoded: DecodedAudio, analysis: AnalysisResult) {
    this.decoded = decoded;
    this.analysis = analysis;
    if (this.pxPerSec <= 0) this.pxPerSec = this.fitZoom(decoded.duration);
    this.redraw();
  }

  setAnalysis(analysis: AnalysisResult) {
    this.analysis = analysis;
    this.redraw();
  }

  setZoom(pxPerSec: number) {
    const old = this.pxPerSec;
    const center = (this.scrollEl.scrollLeft + this.scrollEl.clientWidth / 2) / old;
    this.pxPerSec = pxPerSec;
    this.redraw();
    // Keep the previously centered time roughly centered after zoom.
    this.scrollEl.scrollLeft = center * this.pxPerSec - this.scrollEl.clientWidth / 2;
  }

  get zoom() {
    return this.pxPerSec;
  }

  setPlayhead(t: number) {
    this.playhead = t;
    this.updatePlayhead();
    this.followPlayhead();
  }

  /** Cheap per-frame update: just move the playhead element, no canvas redraw. */
  private updatePlayhead() {
    this.playheadEl.style.transform = `translateX(${this.timeToX(this.playhead)}px)`;
  }

  onSeek(cb: (t: number) => void) {
    this.seekCb = cb;
  }

  get element() {
    return this.canvas;
  }

  private timeToX(t: number): number {
    return t * this.pxPerSec;
  }

  private xToTime(x: number): number {
    return x / this.pxPerSec;
  }

  private handleClick(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    this.seekCb(Math.max(0, this.xToTime(x)));
  }

  private followPlayhead() {
    if (!this.decoded) return;
    const x = this.timeToX(this.playhead);
    const left = this.scrollEl.scrollLeft;
    const right = left + this.scrollEl.clientWidth;
    if (x < left || x > right - 40) {
      this.scrollEl.scrollLeft = x - this.scrollEl.clientWidth / 2;
    }
  }

  redraw() {
    if (!this.decoded || !this.analysis) return;
    const { duration } = this.decoded;
    const cssWidth = Math.max(this.scrollEl.clientWidth, Math.ceil(duration * this.pxPerSec));

    // HiDPI backing store, clamped so we never exceed canvas size limits.
    const maxDim = 32000;
    const dpr = Math.min(window.devicePixelRatio || 1, maxDim / cssWidth);
    this.stageEl.style.width = `${cssWidth}px`;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${TOTAL_H}px`;
    this.canvas.width = Math.floor(cssWidth * dpr);
    this.canvas.height = Math.floor(TOTAL_H * dpr);

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, TOTAL_H);

    this.drawSectionTint(ctx, cssWidth);
    this.drawWaveform(ctx, cssWidth);
    this.drawChords(ctx);
    this.drawBars(ctx, cssWidth);
    this.drawSections(ctx);
    this.drawAxis(ctx, cssWidth, duration);
    this.updatePlayhead();
  }

  private sectionColor(label: string, alpha: number): string {
    const idx = (label.charCodeAt(0) - 65) % SECTION_HUES.length;
    const hue = SECTION_HUES[(idx + SECTION_HUES.length) % SECTION_HUES.length];
    return `hsla(${hue}, 60%, 55%, ${alpha})`;
  }

  private drawSectionTint(ctx: CanvasRenderingContext2D, _w: number) {
    if (!this.analysis) return;
    for (const s of this.analysis.sections) {
      const x = this.timeToX(s.start);
      const w = this.timeToX(s.end) - x;
      ctx.fillStyle = this.sectionColor(s.label, 0.08);
      ctx.fillRect(x, WAVE_TOP, w, WAVE_H);
    }
  }

  private drawWaveform(ctx: CanvasRenderingContext2D, w: number) {
    if (!this.decoded) return;
    const peaks = this.decoded.peaks;
    const mid = WAVE_TOP + WAVE_H / 2;
    const amp = WAVE_H / 2 - 6;
    ctx.strokeStyle = '#4b94c4';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const p = peaks[Math.min(peaks.length - 1, Math.floor((x / w) * peaks.length))] || 0;
      const h = p * amp;
      ctx.moveTo(x + 0.5, mid - h);
      ctx.lineTo(x + 0.5, mid + h);
    }
    ctx.stroke();
    // baseline
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
  }

  private drawChords(ctx: CanvasRenderingContext2D) {
    if (!this.analysis) return;
    ctx.font = '13px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'middle';
    let i = 0;
    for (const c of this.analysis.chords) {
      if (c.label === 'N') {
        i++;
        continue;
      }
      const x = this.timeToX(c.start);
      const w = this.timeToX(c.end) - x;
      if (w < 1) {
        i++;
        continue;
      }
      const shade = i % 2 === 0 ? 'rgba(56,189,248,0.16)' : 'rgba(56,189,248,0.10)';
      ctx.fillStyle = shade;
      ctx.fillRect(x, CHORD_TOP + 2, Math.max(1, w - 1), CHORD_H - 4);
      ctx.fillStyle = `rgba(230,237,243,${0.5 + 0.5 * c.confidence})`;
      if (w > 16) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, CHORD_TOP, w, CHORD_H);
        ctx.clip();
        ctx.textAlign = 'left';
        ctx.fillText(c.label, x + 5, CHORD_TOP + CHORD_H / 2);
        ctx.restore();
      }
      i++;
    }
    // lane label
    ctx.fillStyle = 'rgba(154,167,180,0.5)';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'left';
  }

  private drawBars(ctx: CanvasRenderingContext2D, _w: number) {
    if (!this.analysis) return;
    const { bars } = this.analysis;
    // beat ticks
    ctx.strokeStyle = 'rgba(180,195,210,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const bar of bars) {
      for (const b of bar.beats) {
        const x = this.timeToX(b);
        ctx.moveTo(x + 0.5, BARS_TOP + BARS_H - 8);
        ctx.lineTo(x + 0.5, BARS_TOP + BARS_H);
      }
    }
    ctx.stroke();

    // bar (downbeat) lines through waveform + chord lanes
    ctx.font = '11px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (const bar of bars) {
      const x = this.timeToX(bar.start);
      ctx.strokeStyle = 'rgba(120,140,160,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, WAVE_TOP);
      ctx.lineTo(x + 0.5, BARS_TOP + BARS_H);
      ctx.stroke();
      // bar number every bar if room, else every 4
      const showEvery = this.pxPerSec * estimateBarSeconds(bars) > 26 ? 1 : 4;
      if ((bar.index - 1) % showEvery === 0) {
        ctx.fillStyle = 'rgba(154,167,180,0.85)';
        ctx.fillText(String(bar.index), x + 3, BARS_TOP + 3);
      }
    }
  }

  private drawSections(ctx: CanvasRenderingContext2D) {
    if (!this.analysis) return;
    ctx.font = '12px system-ui';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const s of this.analysis.sections) {
      const x = this.timeToX(s.start);
      const w = this.timeToX(s.end) - x;
      ctx.fillStyle = this.sectionColor(s.label, 0.5);
      ctx.fillRect(x, SECTION_TOP + 3, Math.max(1, w - 2), SECTION_H - 6);
      ctx.fillStyle = '#0e1116';
      if (w > 14) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, SECTION_TOP, w, SECTION_H);
        ctx.clip();
        ctx.fillText(s.label, x + 6, SECTION_TOP + SECTION_H / 2);
        ctx.restore();
      }
    }
  }

  private drawAxis(ctx: CanvasRenderingContext2D, w: number, duration: number) {
    ctx.fillStyle = 'rgba(154,167,180,0.7)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    // choose a label interval that gives ~80px spacing
    const targetPx = 80;
    const rawSec = targetPx / this.pxPerSec;
    const step = niceTime(rawSec);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let t = 0; t <= duration; t += step) {
      const x = this.timeToX(t);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, AXIS_TOP);
      ctx.lineTo(x + 0.5, AXIS_TOP + 4);
      ctx.stroke();
      ctx.fillText(formatTime(t), x + 3, AXIS_TOP + AXIS_H - 2);
    }
    void w;
  }

}

function estimateBarSeconds(bars: { start: number; end: number }[]): number {
  if (bars.length === 0) return 2;
  return bars[0].end - bars[0].start || 2;
}

function niceTime(sec: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const s of steps) if (s >= sec) return s;
  return 600;
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
