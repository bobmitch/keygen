/** Thin wrapper around a hidden <audio> element for playback + playhead sync. */
export class Player {
  private audio: HTMLAudioElement;
  private url: string | null = null;
  private raf = 0;
  private onTick: (time: number, playing: boolean) => void = () => {};

  constructor(audio: HTMLAudioElement) {
    this.audio = audio;
    this.audio.addEventListener('play', () => this.loop());
    this.audio.addEventListener('pause', () => this.stopLoop());
    this.audio.addEventListener('ended', () => this.stopLoop());
  }

  load(file: File) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    this.audio.src = this.url;
  }

  /** Stop playback and release the current audio buffer/URL. */
  stop() {
    this.audio.pause();
    this.stopLoop();
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  onUpdate(cb: (time: number, playing: boolean) => void) {
    this.onTick = cb;
  }

  toggle() {
    if (this.audio.paused) void this.audio.play();
    else this.audio.pause();
  }

  get playing() {
    return !this.audio.paused;
  }

  get currentTime() {
    return this.audio.currentTime;
  }

  seek(t: number) {
    this.audio.currentTime = Math.max(0, t);
    this.onTick(this.audio.currentTime, !this.audio.paused);
  }

  private loop = () => {
    this.onTick(this.audio.currentTime, true);
    this.raf = requestAnimationFrame(this.loop);
  };

  private stopLoop() {
    cancelAnimationFrame(this.raf);
    this.onTick(this.audio.currentTime, false);
  }
}
