import { analyzeFullBuffer } from 'realtime-bpm-analyzer';

/**
 * Independent BPM estimate (realtime-bpm-analyzer) used to sanity-check the
 * Essentia tempo and flag octave (2x / 0.5x) ambiguity. Best-effort: returns
 * undefined if the estimator fails or finds nothing.
 */
export async function crossCheckBpm(
  samples: Float32Array,
  sampleRate: number,
): Promise<number | undefined> {
  try {
    const buffer = new AudioBuffer({
      length: samples.length,
      sampleRate,
      numberOfChannels: 1,
    });
    // Fresh ArrayBuffer-backed copy to satisfy copyToChannel's typing.
    buffer.copyToChannel(new Float32Array(samples), 0);
    const tempos = await analyzeFullBuffer(buffer);
    if (tempos.length > 0) return Math.round(tempos[0].tempo * 10) / 10;
  } catch {
    /* estimator is optional — ignore failures */
  }
  return undefined;
}

/** True when two tempi differ by roughly a factor of two (octave ambiguity). */
export function isOctaveRelated(a: number, b: number): boolean {
  if (!a || !b) return false;
  const ratio = a > b ? a / b : b / a;
  return Math.abs(ratio - 2) < 0.1;
}
