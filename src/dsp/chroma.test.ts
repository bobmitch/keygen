import { describe, expect, it } from 'vitest';
import { chromaFromSpectrum } from './chroma';
import { stftFrames } from './stft';
import { chordSignal, midiToChromaBin } from './testSignals';

const SAMPLE_RATE = 44100;
const FRAME_SIZE = 4096;
const HOP_SIZE = 2048;

/** Chroma of a frame from the middle of the signal. */
function chromaOf(samples: Float32Array): number[] {
  let result: number[] | null = null;
  let mid = 0;
  for (const frame of stftFrames(samples, SAMPLE_RATE, FRAME_SIZE, HOP_SIZE)) {
    mid = frame.index; // count frames; keep recomputing chroma on the latest
    if (frame.index === 3) result = chromaFromSpectrum(frame.mag, SAMPLE_RATE, FRAME_SIZE);
  }
  expect(mid).toBeGreaterThanOrEqual(3);
  expect(result).not.toBeNull();
  return result!;
}

function topBins(chroma: number[], k: number): number[] {
  return chroma
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v - a.v)
    .slice(0, k)
    .map((e) => e.i)
    .sort((a, b) => a - b);
}

describe('chromaFromSpectrum', () => {
  it('maps an A440 tone to bin 0 with unit-max normalisation', () => {
    const chroma = chromaOf(chordSignal([69], 0.6, SAMPLE_RATE));
    expect(chroma[0]).toBe(1);
    for (let p = 1; p < 12; p++) expect(chroma[p]).toBeLessThan(1);
  });

  it('puts a C major triad on the C, E, and G bins', () => {
    const chroma = chromaOf(chordSignal([60, 64, 67], 0.6, SAMPLE_RATE)); // C4 E4 G4
    const expected = [60, 64, 67].map(midiToChromaBin).sort((a, b) => a - b);
    expect(topBins(chroma, 3)).toEqual(expected);
  });

  it('tolerates mild detuning (+20 cents stays on the same bin)', () => {
    const detuned = 69 + 0.2; // 20 cents sharp of A4
    const chroma = chromaOf(chordSignal([detuned], 0.6, SAMPLE_RATE));
    expect(chroma.indexOf(Math.max(...chroma))).toBe(0);
  });

  it('returns all zeros for silence', () => {
    const chroma = chromaOf(new Float32Array(SAMPLE_RATE));
    expect(chroma).toEqual(new Array(12).fill(0));
  });
});
