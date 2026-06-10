export interface ControlHandlers {
  togglePlay(): void;
  zoom(factor: number): void;
  halveTempo(): void;
  doubleTempo(): void;
  setKey(key: string, scale: 'major' | 'minor'): void;
  setBeatsPerBar(n: number): void;
  nudgeDownbeat(delta: number): void;
  autoDownbeat(): void;
  exportPng(): void;
  exportJson(): void;
}

const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export class Controls {
  private playBtn!: HTMLButtonElement;

  constructor(
    private el: HTMLElement,
    private h: ControlHandlers,
  ) {}

  render(currentKey: string, currentScale: string, beatsPerBar: number) {
    this.el.innerHTML = '';

    this.playBtn = this.button('▶ Play', () => this.h.togglePlay());

    const zoomOut = this.button('−', () => this.h.zoom(1 / 1.5), 'small');
    const zoomIn = this.button('+', () => this.h.zoom(1.5), 'small');

    const halve = this.button('½×', () => this.h.halveTempo(), 'small');
    const dbl = this.button('2×', () => this.h.doubleTempo(), 'small');

    const keySel = this.select(ROOTS, currentKey, () => emitKey());
    const scaleSel = this.select(['major', 'minor'], currentScale, () => emitKey());
    const emitKey = () =>
      this.h.setKey(keySel.value, scaleSel.value === 'minor' ? 'minor' : 'major');

    const meterSel = this.select(['2', '3', '4', '6'], String(beatsPerBar), (v) =>
      this.h.setBeatsPerBar(parseInt(v, 10)),
    );

    const dbBack = this.button('◀', () => this.h.nudgeDownbeat(-1), 'small');
    const dbAuto = this.button('Auto', () => this.h.autoDownbeat(), 'small');
    const dbFwd = this.button('▶', () => this.h.nudgeDownbeat(1), 'small');

    const pngBtn = this.button('⬇ PNG', () => this.h.exportPng());
    const jsonBtn = this.button('⬇ JSON', () => this.h.exportJson());

    this.el.append(
      this.group('', [this.playBtn]),
      this.group('Zoom', [zoomOut, zoomIn]),
      this.group('Tempo', [halve, dbl]),
      this.group('Key', [keySel, scaleSel]),
      this.group('Meter', [meterSel]),
      this.group('Downbeat', [dbBack, dbAuto, dbFwd]),
      this.group('Export', [pngBtn, jsonBtn]),
    );
  }

  setPlaying(playing: boolean) {
    if (this.playBtn) this.playBtn.textContent = playing ? '❚❚ Pause' : '▶ Play';
  }

  private group(label: string, nodes: HTMLElement[]): HTMLElement {
    const g = document.createElement('div');
    g.className = 'ctrl-group';
    if (label) {
      const l = document.createElement('span');
      l.className = 'glabel';
      l.textContent = label;
      g.append(l);
    }
    nodes.forEach((n) => g.append(n));
    return g;
  }

  private button(text: string, onClick: () => void, extra = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `btn ${extra}`.trim();
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  private select(opts: string[], value: string, onChange: (v: string) => void): HTMLSelectElement {
    const s = document.createElement('select');
    for (const o of opts) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      if (o === value) opt.selected = true;
      s.append(opt);
    }
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
}
