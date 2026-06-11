import { describe, expect, it } from 'vitest';
import { chromaFromSpectrum } from './chroma';
import { estimateKey } from './key';
import { stftFrames } from './stft';
import { progressionSignal } from './testSignals';

const SAMPLE_RATE = 44100;
const FRAME_SIZE = 4096;
const HOP_SIZE = 2048;

function chromaMatrix(samples: Float32Array): number[][] {
  const chroma: number[][] = [];
  for (const frame of stftFrames(samples, SAMPLE_RATE, FRAME_SIZE, HOP_SIZE)) {
    chroma.push(chromaFromSpectrum(frame.mag, SAMPLE_RATE, FRAME_SIZE));
  }
  return chroma;
}

describe('estimateKey', () => {
  it('hears a I-IV-V-I progression in C as C major', () => {
    const progression = [
      [60, 64, 67], // C
      [65, 69, 72], // F
      [67, 71, 74], // G
      [60, 64, 67], // C
    ];
    const result = estimateKey(chromaMatrix(progressionSignal(progression, 1, SAMPLE_RATE)));
    expect(result.key).toBe('C');
    expect(result.scale).toBe('major');
    expect(result.strength).toBeGreaterThan(0.3);
  });

  it('hears an i-iv-V-i progression in A minor as A minor (not C major)', () => {
    const progression = [
      [57, 60, 64], // Am
      [62, 65, 69], // Dm
      [64, 68, 71], // E (raised leading tone G#)
      [57, 60, 64], // Am
    ];
    const result = estimateKey(chromaMatrix(progressionSignal(progression, 1, SAMPLE_RATE)));
    expect(result.key).toBe('A');
    expect(result.scale).toBe('minor');
  });

  it('returns a zero-strength fallback for empty input', () => {
    expect(estimateKey([]).strength).toBe(0);
  });
});
