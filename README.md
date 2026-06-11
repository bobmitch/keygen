# keygen

A single-page, **100% client-side** tool that analyzes an audio file in your browser and
charts its **key/mode, tempo (BPM), chords, bars, and sections** against the waveform.
Nothing is uploaded — the file is decoded and analyzed entirely on your device.

## Features

- **Drag & drop or file picker** to load any browser-decodable audio file (MP3, WAV, FLAC, M4A…).
- **Key + mode** detection (Essentia `KeyExtractor`).
- **Tempo + beat grid** (Essentia `RhythmExtractor2013`) with a `realtime-bpm-analyzer`
  cross-check and ½× / 2× correction for octave errors.
- **Chord chart** — beat-synchronous major/minor triad estimation (Essentia `ChordsDetectionBeats`
  on HPCP chroma) with **Viterbi smoothing** to suppress isolated, low-confidence flips.
- **Bars & sections** — beats grouped into bars (adjustable meter + downbeat), and structural
  sections from a chroma self-similarity / novelty curve.
- **Waveform + aligned chart lanes** rendered on one canvas (pixel-perfect alignment), plus
  a classic **lead-sheet grid** view (one chord per bar, grouped by section).
- **Playback** with a moving playhead, zoom, and **PNG / JSON export**.

## Accuracy expectations (please read)

These are estimates from lightweight in-browser DSP, not transcription-grade results:

- **Key/mode** is reliable on tonal material (~70–85%); the major/minor call is the most error-prone.
- **BPM** is reliable on steady tempos; octave (½× / 2×) errors are common — use the **½× / 2×** buttons.
- **Chords** are **major/minor triads only** and approximate (no 7ths/sus/inversions). After
  retiming the beats/key, click **Re-evaluate chords** to re-detect them on your corrected grid
  (reuses the cached chroma, so it's near-instant — no re-decode).
- **Bars** assume **4/4** by default; use the **Meter** and **Downbeat** controls to line up bar 1.
- **Sections** are approximate boundaries labelled A/B/C — not named structure (verse/chorus).

Every estimate has a manual override so you can correct it.

## Develop

Requires Node 18+.

```bash
npm install
npm run dev        # start the dev server (open the printed URL)
npm run build      # type-check + production build into dist/
npm run preview    # preview the production build
npm run typecheck  # type-check only
```

> The app uses ES modules, a Web Worker, and WebAssembly, so it must be served over HTTP —
> opening `index.html` from `file://` will not work. `npm run dev` / `npm run preview` handle this.

## Deploy (GitHub Pages)

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes `dist/`.
Enable it once under **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The Vite `base` is set to `/keygen/` for production so assets resolve under the project subpath.

## How it works

1. The file is decoded with the Web Audio API and downmixed to mono at 44.1 kHz (`src/audio/decode.ts`).
2. Heavy analysis runs in a **Web Worker** (`src/worker/analysis.worker.ts`) using Essentia.js
   (WASM): tempo + beats, key, per-frame chroma, and beat-synchronous chord detection
   (`ChordsDetectionBeats`) followed by a Viterbi smoothing pass.
3. The main thread groups beats into bars and detects sections (`src/analysis/structure.ts`),
   then renders the waveform and aligned chart lanes on a single canvas (`src/ui/chart.ts`).

## License

Uses [Essentia.js](https://github.com/MTG/essentia.js) (AGPL-3.0).
