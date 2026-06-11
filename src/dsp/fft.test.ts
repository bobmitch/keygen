import { describe, expect, it } from 'vitest';
import { Fft, RealSpectrum } from './fft';
import { frameCount, stftFrames } from './stft';
import { mulberry32 } from './testSignals';

/** Brute-force DFT as the correctness reference. */
function naiveDft(re: Float64Array, im: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      const c = Math.cos(a);
      const s = Math.sin(a);
      outRe[k] += re[t] * c - im[t] * s;
      outIm[k] += re[t] * s + im[t] * c;
    }
  }
  return { re: outRe, im: outIm };
}

describe('Fft', () => {
  it('matches a naive DFT on random complex input', () => {
    const n = 256;
    const rng = mulberry32(42);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = rng() * 2 - 1;
      im[i] = rng() * 2 - 1;
    }
    const expected = naiveDft(re, im);
    const fft = new Fft(n);
    fft.transform(re, im);
    for (let k = 0; k < n; k++) {
      expect(re[k]).toBeCloseTo(expected.re[k], 7);
      expect(im[k]).toBeCloseTo(expected.im[k], 7);
    }
  });

  it('rejects non-power-of-two sizes', () => {
    expect(() => new Fft(1000)).toThrow();
  });
});

describe('RealSpectrum', () => {
  it('reads a bin-centred cosine at its amplitude', () => {
    const n = 512;
    const bin = 8;
    const amp = 0.7;
    const frame = new Float64Array(n);
    for (let i = 0; i < n; i++) frame[i] = amp * Math.cos((2 * Math.PI * bin * i) / n);
    const spec = new RealSpectrum(n);
    const mag = spec.magnitudes(frame, new Float32Array(spec.bins));
    expect(mag[bin]).toBeCloseTo(amp, 3);
    for (let b = 0; b < spec.bins; b++) {
      if (Math.abs(b - bin) > 1) expect(mag[b]).toBeLessThan(1e-6);
    }
  });
});

describe('stftFrames', () => {
  it('produces the expected frame count, times, and peak frequency', () => {
    const sampleRate = 44100;
    const freq = 440;
    const samples = new Float32Array(sampleRate); // 1 s
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    }
    const frameSize = 4096;
    const hopSize = 2048;
    const expected = frameCount(samples.length, frameSize, hopSize);
    let count = 0;
    for (const frame of stftFrames(samples, sampleRate, frameSize, hopSize)) {
      expect(frame.time).toBeCloseTo((frame.index * hopSize + frameSize / 2) / sampleRate, 9);
      let peak = 0;
      for (let b = 1; b < frame.mag.length; b++) if (frame.mag[b] > frame.mag[peak]) peak = b;
      const peakHz = (peak * sampleRate) / frameSize;
      expect(Math.abs(peakHz - freq)).toBeLessThan(sampleRate / frameSize);
      count++;
    }
    expect(count).toBe(expected);
    expect(expected).toBe(Math.floor((samples.length - frameSize) / hopSize) + 1);
  });
});
