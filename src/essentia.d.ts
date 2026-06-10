// Minimal ambient declarations for the essentia.js dist sub-modules we import.
// The package ships `dist/core_api.d.ts` describing the Essentia class, but the
// individual ES dist files have no module declarations, so we add them here.

declare module 'essentia.js/dist/essentia-wasm.es.js' {
  // Emscripten module object consumed by the Essentia wrapper constructor.
  export const EssentiaWASM: unknown;
}

declare module 'essentia.js/dist/essentia.js-core.es.js' {
  // Loosely typed: essentia algorithms are dynamically generated. We treat the
  // instance as `any` at call sites where the generated signatures are noisy.
  export default class Essentia {
    constructor(wasm: unknown, isDebug?: boolean);
    version: string;
    algorithmNames: string;
    arrayToVector(array: Float32Array | number[]): unknown;
    vectorToArray(vector: unknown): Float32Array;
    FrameGenerator(audio: Float32Array, frameSize?: number, hopSize?: number): EssentiaVectorVector;
    Windowing(frame: unknown, normalized?: boolean, size?: number, type?: string): { frame: unknown };
    Spectrum(frame: unknown, size?: number): { spectrum: unknown };
    SpectralPeaks(
      spectrum: unknown,
      magnitudeThreshold?: number,
      maxFrequency?: number,
      maxPeaks?: number,
      minFrequency?: number,
      orderBy?: string,
      sampleRate?: number,
    ): { frequencies: unknown; magnitudes: unknown };
    HPCP(
      frequencies: unknown,
      magnitudes: unknown,
      bandPreset?: boolean,
      bandSplitFrequency?: number,
      harmonics?: number,
      maxFrequency?: number,
      maxShifted?: boolean,
      minFrequency?: number,
      nonLinear?: boolean,
      normalized?: string,
      referenceFrequency?: number,
      sampleRate?: number,
      size?: number,
    ): { hpcp: unknown };
    KeyExtractor(audio: unknown, ...args: unknown[]): { key: string; scale: string; strength: number };
    RhythmExtractor2013(
      signal: unknown,
      maxTempo?: number,
      method?: string,
      minTempo?: number,
    ): { bpm: number; ticks: unknown; confidence: number };
    // Escape hatch for any algorithm not explicitly typed above.
    [key: string]: any;
  }

  export interface EssentiaVector {
    size(): number;
    get(i: number): number;
    delete(): void;
  }
  export interface EssentiaVectorVector {
    size(): number;
    get(i: number): unknown;
    delete(): void;
  }
}
