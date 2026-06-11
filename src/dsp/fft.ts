// Minimal radix-2 FFT — the only "engine" the rest of the analysis needs.
//
// Built for offline analysis of whole tracks: twiddle factors and the
// bit-reversal permutation are precomputed once, transforms run in place, and
// nothing is allocated per call. Float64 scratch keeps the numerics well inside
// test tolerances at the frame sizes we use (2048 / 4096).

export class Fft {
  readonly size: number;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly reverse: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    const half = size / 2;
    this.cosTable = new Float64Array(half);
    this.sinTable = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      const a = (-2 * Math.PI * i) / size;
      this.cosTable[i] = Math.cos(a);
      this.sinTable[i] = Math.sin(a);
    }
    const bits = Math.round(Math.log2(size));
    this.reverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >>> b) & 1);
      this.reverse[i] = r;
    }
  }

  /** In-place complex FFT (decimation in time). */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    const rev = this.reverse;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const c = this.cosTable[k];
          const s = this.sinTable[k];
          const a = i + j;
          const b = a + half;
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

/**
 * Real-input magnitude spectrum helper that owns its scratch buffers so callers
 * can stream frames without per-frame allocation. Output is scaled by 2/size so
 * a sine landing on a bin centre reads roughly its amplitude.
 */
export class RealSpectrum {
  readonly size: number;
  /** Number of output bins: size/2 + 1 (DC .. Nyquist). */
  readonly bins: number;
  private readonly fft: Fft;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(size: number) {
    this.fft = new Fft(size);
    this.size = size;
    this.bins = size / 2 + 1;
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
  }

  /** Fill `out` (length >= bins) with the magnitude spectrum of `frame`. */
  magnitudes(frame: ArrayLike<number>, out: Float32Array): Float32Array {
    if (frame.length !== this.size) {
      throw new Error(`frame length ${frame.length} != FFT size ${this.size}`);
    }
    const { re, im } = this;
    for (let i = 0; i < this.size; i++) {
      re[i] = frame[i];
      im[i] = 0;
    }
    this.fft.transform(re, im);
    const scale = 2 / this.size;
    for (let b = 0; b < this.bins; b++) {
      out[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]) * scale;
    }
    return out;
  }
}
