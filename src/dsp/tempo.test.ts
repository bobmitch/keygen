import { describe, expect, it } from 'vitest';
import { bpmFromBeats, trackBeats } from './beats';
import { enhanceOdf, onsetEnvelope } from './onset';
import { estimateTempo, isOctaveRelated, octaveAlternative } from './tempo';
import { clickTrack } from './testSignals';

const SAMPLE_RATE = 44100;
const FRAME_SIZE = 2048;
const HOP_SIZE = 512;

function analyzeClicks(bpm: number, durationSec: number) {
  const { samples, clickTimes } = clickTrack(bpm, durationSec, SAMPLE_RATE);
  const onset = onsetEnvelope(samples, SAMPLE_RATE, FRAME_SIZE, HOP_SIZE);
  const env = enhanceOdf(onset.odf, onset.fps);
  const tempo = estimateTempo(env, onset.fps);
  const beats = trackBeats(env, onset.fps, tempo.bpm, onset.times);
  return { clickTimes, tempo, beats };
}

describe('estimateTempo', () => {
  it('recovers 120 BPM from a click track with high confidence', () => {
    const { tempo } = analyzeClicks(120, 20);
    expect(Math.abs(tempo.bpm - 120)).toBeLessThan(1.5);
    expect(tempo.confidence).toBeGreaterThan(0.4);
  });

  it('recovers an off-grid tempo (87 BPM) without octave errors', () => {
    const { tempo } = analyzeClicks(87, 20);
    expect(Math.abs(tempo.bpm - 87)).toBeLessThan(1.5);
  });

  it('returns the zero-confidence fallback on flat input', () => {
    const flat = new Float32Array(2000);
    const tempo = estimateTempo(flat, 86);
    expect(tempo.confidence).toBe(0);
    expect(tempo.candidates).toEqual([]);
  });
});

describe('trackBeats', () => {
  it('lays beats on the clicks at the right spacing', () => {
    const { clickTimes, beats } = analyzeClicks(120, 20);
    expect(beats.length).toBeGreaterThan(20);

    const ibis = beats.slice(1).map((t, i) => t - beats[i]);
    const medianIbi = ibis.sort((a, b) => a - b)[ibis.length >> 1];
    expect(Math.abs(medianIbi - 0.5)).toBeLessThan(0.02);

    // Beats land near actual click onsets (frame quantisation + the window
    // centre lag allow a few tens of milliseconds).
    let aligned = 0;
    for (const b of beats) {
      const nearest = clickTimes.reduce((best, c) => Math.min(best, Math.abs(c - b)), Infinity);
      if (nearest < 0.045) aligned++;
    }
    expect(aligned / beats.length).toBeGreaterThan(0.9);

    expect(Math.abs((bpmFromBeats(beats) ?? 0) - 120)).toBeLessThan(1.5);
  });

  it('returns no beats for silence', () => {
    const silent = new Float32Array(4000);
    expect(trackBeats(silent, 86, 120, new Float32Array(4000))).toEqual([]);
  });
});

describe('octave ambiguity helpers', () => {
  it('flags ~2x tempo pairs and tolerates slop', () => {
    expect(isOctaveRelated(120, 60)).toBe(true);
    expect(isOctaveRelated(60, 121)).toBe(true);
    expect(isOctaveRelated(120, 90)).toBe(false);
    expect(isOctaveRelated(0, 120)).toBe(false);
  });

  it('surfaces a competitive half-time candidate', () => {
    const candidates = [
      { bpm: 120, strength: 1 },
      { bpm: 60, strength: 0.6 },
    ];
    expect(octaveAlternative(120, candidates)).toBe(60);
    expect(octaveAlternative(120, [{ bpm: 120, strength: 1 }])).toBeUndefined();
    expect(octaveAlternative(120, [
      { bpm: 120, strength: 1 },
      { bpm: 60, strength: 0.1 },
    ])).toBeUndefined();
  });
});
