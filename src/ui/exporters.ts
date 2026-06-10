import type { AnalysisResult } from '../types';

/** Save the chart canvas as a PNG. */
export function exportPng(canvas: HTMLCanvasElement, filename: string) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    download(URL.createObjectURL(blob), filename, true);
  }, 'image/png');
}

/** Save the full analysis as JSON. */
export function exportJson(a: AnalysisResult, filename: string) {
  const payload = {
    key: a.key,
    bpm: a.bpm,
    beatsPerBar: a.beatsPerBar,
    downbeatOffset: a.downbeatOffset,
    duration: a.duration,
    bars: a.bars.map((b) => ({ index: b.index, start: b.start, end: b.end })),
    sections: a.sections,
    chords: a.chords,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  download(URL.createObjectURL(blob), filename, true);
}

function download(url: string, filename: string, revoke: boolean) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(url), 1000);
}
