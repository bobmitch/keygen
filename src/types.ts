// Shared data shapes for the analysis pipeline and UI.

export interface DecodedAudio {
  /** Mono Float32 PCM resampled to `sampleRate`. */
  samples: Float32Array;
  sampleRate: number;
  duration: number;
  /** Min/max peak pairs per pixel-ish bucket for fast waveform rendering. */
  peaks: number[];
}

export interface KeyResult {
  key: string; // e.g. "G"
  scale: 'major' | 'minor';
  /** 0..1 confidence from the estimator. */
  strength: number;
}

export interface BpmResult {
  bpm: number;
  confidence: number;
  /** Beat onset times in seconds. */
  beats: number[];
  /** Competitive half/double-time candidate from the tempo estimator, if any. */
  crossCheckBpm?: number;
  /** True when that alternative disagrees by ~2x / 0.5x (octave ambiguity). */
  octaveAmbiguous?: boolean;
}

export interface ChordSpan {
  start: number;
  end: number;
  /** e.g. "G", "Em", or "N" for no-chord/low-confidence. */
  label: string;
  confidence: number;
}

export interface Bar {
  index: number; // 1-based bar number
  start: number;
  end: number;
  beats: number[]; // beat times within this bar
}

export interface Section {
  index: number;
  start: number;
  end: number;
  /** A, B, C... reused for self-similar blocks. */
  label: string;
}

/** Raw output produced inside the worker (before bar/section post-processing). */
export interface WorkerAnalysis {
  key: KeyResult;
  bpm: number;
  bpmConfidence: number;
  /** Competitive half/double-time tempo candidate, if the estimator saw one. */
  altBpm?: number;
  beats: number[];
  /** Raw per-beat chord estimate (one span per inter-beat segment, unmerged). */
  beatChords: ChordSpan[];
  /** Per-frame 12-bin chroma + frame times, used for section detection. */
  chroma: number[][];
  chromaTimes: number[];
  /** Per-beat downbeat salience (aligned with `beats`); drives auto-phase. */
  downbeatStrength: number[];
}

/** Fully assembled analysis used by the UI. */
export interface AnalysisResult {
  key: KeyResult;
  bpm: BpmResult;
  chords: ChordSpan[];
  bars: Bar[];
  sections: Section[];
  beatsPerBar: number;
  /** Index into `beats` chosen as the first downbeat. */
  downbeatOffset: number;
  duration: number;
}

/** Messages: main thread -> worker. */
export interface AnalyzeRequest {
  type: 'analyze';
  samples: Float32Array;
  sampleRate: number;
}

/** Messages: worker -> main thread. */
export type WorkerMessage =
  | { type: 'progress'; stage: string; value?: number }
  | { type: 'result'; analysis: WorkerAnalysis }
  | { type: 'error'; message: string };
