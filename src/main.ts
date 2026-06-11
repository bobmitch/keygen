import './styles.css';
import type {
  AnalysisResult,
  AnalyzeRequest,
  ChordSpan,
  DecodedAudio,
  KeyResult,
  WorkerAnalysis,
  WorkerMessage,
} from './types';
import { decodeAudioFile } from './audio/decode';
import { buildBars, detectSections, snapChordsToBars } from './analysis/structure';
import { estimateChords } from './analysis/chords';
import { estimateDownbeatOffset } from './analysis/downbeat';
import { crossCheckBpm, isOctaveRelated } from './analysis/bpmCrossCheck';
import { setupDropzone } from './ui/dropzone';
import { Player } from './ui/player';
import { Chart } from './ui/chart';
import { Controls } from './ui/controls';
import { renderSummary } from './ui/summary';
import { renderLeadsheet, highlightLeadsheet } from './ui/leadsheet';
import { exportPng, exportJson } from './ui/exporters';

// ---- DOM ----
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dropzone = $('dropzone');
const chooseBtn = $<HTMLButtonElement>('chooseBtn');
const fileInput = $<HTMLInputElement>('fileInput');
const progressEl = $('progress');
const progressStage = $('progressStage');
const progressFill = $<HTMLDivElement>('progressFill');
const errorEl = $('error');
const resultsEl = $('results');
const summaryEl = $('summary');
const controlsEl = $('controls');
const stageScroll = $('stageScroll');
const stage = $('stage');
const lanes = $<HTMLCanvasElement>('lanes');
const leadsheetEl = $('leadsheet');
const leadsheetToggle = $<HTMLButtonElement>('leadsheetToggle');
const fileBar = $('fileBar');
const audioEl = $<HTMLAudioElement>('player');
const playheadEl = $('playhead');

// ---- singletons ----
const player = new Player(audioEl);
const chart = new Chart(stageScroll, stage, lanes, playheadEl);
let worker: Worker | null = null;

// ---- mutable analysis state ----
interface State {
  fileName: string;
  decoded: DecodedAudio;
  raw: WorkerAnalysis;
  crossCheckBpm?: number;
  tempoFactor: number;
  beatsPerBar: number;
  downbeatOffset: number;
  keyOverride: KeyResult | null;
  /** Chords re-estimated against the edited beat grid, or null to use raw. */
  chordsOverride: ChordSpan[] | null;
  /** True when beats/key changed since chords were last estimated. */
  chordsStale: boolean;
}
let state: State | null = null;

const controls = new Controls(controlsEl, {
  togglePlay: () => player.toggle(),
  zoom: (f) => chart.setZoom(clampZoom(chart.zoom * f)),
  halveTempo: () => setTempoFactor(0.5),
  doubleTempo: () => setTempoFactor(2),
  setKey: (key, scale) => {
    if (!state) return;
    state.keyOverride = { key, scale, strength: 1 };
    markChordsStale();
    rebuild();
  },
  setBeatsPerBar: (n) => {
    if (!state) return;
    state.beatsPerBar = n;
    // Phase meaning changes with the meter, so re-run the auto estimate.
    state.downbeatOffset = autoDownbeatOffset(state.raw, n);
    markChordsStale();
    rebuild();
  },
  nudgeDownbeat: (d) => {
    if (!state) return;
    state.downbeatOffset += d;
    markChordsStale();
    rebuild();
  },
  autoDownbeat: () => {
    if (!state) return;
    state.downbeatOffset = autoDownbeatOffset(state.raw, state.beatsPerBar);
    markChordsStale();
    rebuild();
  },
  reevaluateChords: () => reevaluateChords(),
  exportPng: () => state && exportPng(chart.element, `${baseName(state.fileName)}-chart.png`),
  exportJson: () => {
    if (!state) return;
    exportJson(buildResult(state), `${baseName(state.fileName)}-analysis.json`);
  },
});

player.onUpdate((t, playing) => {
  chart.setPlayhead(t);
  highlightLeadsheet(leadsheetEl, t);
  controls.setPlaying(playing);
});
chart.onSeek((t) => player.seek(t));

setupDropzone(dropzone, chooseBtn, fileInput, handleFile);
leadsheetToggle.addEventListener('click', () => {
  const hidden = leadsheetEl.classList.toggle('hidden');
  leadsheetToggle.textContent = hidden ? 'Show lead-sheet grid' : 'Hide lead-sheet grid';
});
window.addEventListener('resize', () => chart.redraw());

// ---- pipeline ----
async function handleFile(file: File) {
  showProgress('Decoding audio', 0.05);
  setError('');
  resultsEl.classList.add('hidden');
  try {
    const decoded = await decodeAudioFile(file);
    player.load(file);

    showProgress('Analyzing', 0.15);
    const raw = await runWorker(decoded);
    const crossBpm = await crossCheckBpm(decoded.samples, decoded.sampleRate);

    state = {
      fileName: file.name,
      decoded,
      raw,
      crossCheckBpm: crossBpm,
      tempoFactor: 1,
      beatsPerBar: 4,
      downbeatOffset: autoDownbeatOffset(raw, 4),
      keyOverride: null,
      chordsOverride: null,
      chordsStale: false,
    };

    progressEl.classList.add('hidden');
    showFileBar(file.name);
    dropzone.classList.add('hidden');
    resultsEl.classList.remove('hidden');

    const result = buildResult(state);
    chart.setData(decoded, result);
    controls.render(result.key.key, result.key.scale, state.beatsPerBar);
    renderViews(result);
  } catch (err) {
    progressEl.classList.add('hidden');
    setError(err instanceof Error ? err.message : String(err));
  }
}

function runWorker(decoded: DecodedAudio): Promise<WorkerAnalysis> {
  if (!worker) {
    worker = new Worker(new URL('./worker/analysis.worker.ts', import.meta.url), { type: 'module' });
  }
  const w = worker;
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        showProgress(msg.stage, msg.value !== undefined ? 0.15 + msg.value * 0.8 : undefined);
      } else if (msg.type === 'result') {
        w.removeEventListener('message', onMessage);
        resolve(msg.analysis);
      } else if (msg.type === 'error') {
        w.removeEventListener('message', onMessage);
        reject(new Error(msg.message));
      }
    };
    w.addEventListener('message', onMessage);
    const req: AnalyzeRequest = {
      type: 'analyze',
      samples: decoded.samples,
      sampleRate: decoded.sampleRate,
    };
    w.postMessage(req);
  });
}

// ---- derive AnalysisResult from current controls ----
function buildResult(s: State): AnalysisResult {
  const beats = applyTempoFactor(s.raw.beats, s.tempoFactor);
  const bars = buildBars(beats, s.beatsPerBar, s.downbeatOffset, s.decoded.duration);
  const sections = detectSections(s.raw.chroma, s.raw.chromaTimes, bars, s.decoded.duration);
  // Re-align chord-span edges to the current bar grid so a slightly-late detected
  // change doesn't leak the previous chord into the next bar. Prefer chords the user
  // re-evaluated against the edited beats, falling back to the original estimate.
  const chords = snapChordsToBars(s.chordsOverride ?? s.raw.chords, bars, beats);
  const bpmVal = Math.round(s.raw.bpm * s.tempoFactor * 10) / 10;
  const octaveAmbiguous = s.crossCheckBpm ? isOctaveRelated(bpmVal, s.crossCheckBpm) : false;

  return {
    key: s.keyOverride ?? s.raw.key,
    bpm: {
      bpm: bpmVal,
      confidence: s.raw.bpmConfidence,
      beats,
      crossCheckBpm: s.crossCheckBpm,
      octaveAmbiguous,
    },
    chords,
    bars,
    sections,
    beatsPerBar: s.beatsPerBar,
    downbeatOffset: s.downbeatOffset,
    duration: s.decoded.duration,
  };
}

/** Auto-pick the bar phase from the worker's per-beat downbeat salience. */
function autoDownbeatOffset(raw: WorkerAnalysis, beatsPerBar: number): number {
  return estimateDownbeatOffset(raw.beats, raw.downbeatStrength, beatsPerBar);
}

function rebuild() {
  if (!state) return;
  const result = buildResult(state);
  chart.setAnalysis(result);
  renderViews(result);
  controls.setReevaluateEnabled(state.chordsStale);
}

function renderViews(result: AnalysisResult) {
  renderSummary(summaryEl, result);
  renderLeadsheet(leadsheetEl, result);
}

function setTempoFactor(mult: number) {
  if (!state) return;
  state.tempoFactor = clampFactor(state.tempoFactor * mult);
  markChordsStale();
  rebuild();
}

/** Flag that the current chord estimate no longer matches the edited beats/key. */
function markChordsStale() {
  if (state) state.chordsStale = true;
}

/**
 * Re-run beat-synchronous chord estimation against the *current* beat grid and key
 * (using the chroma already computed at load time — no re-decode). This is the
 * expensive-to-do-by-hand step the user opts into once the timing looks right, so
 * chord boundaries are derived from their corrected beats rather than the original.
 */
function reevaluateChords() {
  if (!state) return;
  const beats = applyTempoFactor(state.raw.beats, state.tempoFactor);
  const key = state.keyOverride ?? state.raw.key;
  state.chordsOverride = estimateChords(
    beats,
    state.raw.chroma,
    state.raw.chromaTimes,
    state.decoded.duration,
    key,
  );
  state.chordsStale = false;
  rebuild();
}

/** Double = interpolate midpoints; halve = drop every other beat. */
function applyTempoFactor(beats: number[], factor: number): number[] {
  if (factor === 1 || beats.length < 2) return beats.slice();
  let out = beats.slice();
  let f = factor;
  while (f > 1.0001) {
    const next: number[] = [];
    for (let i = 0; i < out.length - 1; i++) {
      next.push(out[i], (out[i] + out[i + 1]) / 2);
    }
    next.push(out[out.length - 1]);
    out = next;
    f /= 2;
  }
  while (f < 0.9999) {
    out = out.filter((_, i) => i % 2 === 0);
    f *= 2;
  }
  return out;
}

// ---- ui helpers ----
function showProgress(stage: string, value?: number) {
  progressEl.classList.remove('hidden');
  progressStage.textContent = stage + '…';
  if (value !== undefined) progressFill.style.width = `${Math.round(value * 100)}%`;
}
function setError(msg: string) {
  if (!msg) {
    errorEl.classList.add('hidden');
    return;
  }
  errorEl.textContent = `Could not analyze this file: ${msg}`;
  errorEl.classList.remove('hidden');
}
function showFileBar(name: string) {
  fileBar.classList.remove('hidden');
  fileBar.innerHTML = `<span class="fname">${escapeHtml(name)}</span>`;
  const btn = document.createElement('button');
  btn.className = 'btn small';
  btn.textContent = 'Analyze another';
  btn.addEventListener('click', () => {
    player.stop();
    chart.clear();
    state = null;
    fileInput.value = '';
    resultsEl.classList.add('hidden');
    fileBar.classList.add('hidden');
    dropzone.classList.remove('hidden');
  });
  fileBar.append(btn);
}
function escapeHtml(s: string) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '');
}
function clampZoom(px: number) {
  return Math.max(4, Math.min(600, px));
}
function clampFactor(f: number) {
  return Math.max(0.25, Math.min(4, f));
}
