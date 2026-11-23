/**
 * Office sounds, synthesized in the browser (no audio files, no network). OFF by default: nothing is created,
 * scheduled or played until a person turns sound on in Settings. Sounds mark real events only
 * (a robot arriving, finishing, failing, or needing you), each is short and quiet, and plays are rate-limited.
 */
export type SoundKind = 'arrive' | 'complete' | 'fail' | 'alert';
export interface Note {
  /** Frequency in Hz. */
  f: number;
  /** Start offset in seconds. */
  t: number;
  /** Duration in seconds. */
  d: number;
  wave: 'sine' | 'triangle' | 'square';
  /** Relative loudness 0..1 (scaled by the master volume). */
  g: number;
}

export const SOUNDS: Record<SoundKind, readonly Note[]> = {
  arrive: [
    { f: 880, t: 0, d: 0.18, wave: 'sine', g: 0.5 },
    { f: 660, t: 0.16, d: 0.3, wave: 'sine', g: 0.4 },
  ],
  complete: [
    { f: 523, t: 0, d: 0.12, wave: 'triangle', g: 0.5 },
    { f: 659, t: 0.1, d: 0.12, wave: 'triangle', g: 0.5 },
    { f: 784, t: 0.2, d: 0.12, wave: 'triangle', g: 0.5 },
    { f: 1047, t: 0.3, d: 0.28, wave: 'triangle', g: 0.5 },
  ],
  fail: [
    { f: 196, t: 0, d: 0.22, wave: 'square', g: 0.28 },
    { f: 147, t: 0.2, d: 0.34, wave: 'square', g: 0.28 },
  ],
  alert: [
    { f: 988, t: 0, d: 0.12, wave: 'sine', g: 0.55 },
    { f: 988, t: 0.2, d: 0.12, wave: 'sine', g: 0.55 },
  ],
};

export const MAX_MASTER_GAIN = 0.2; // even at 100% volume
export const MIN_GAP_MS: Record<SoundKind, number> = { arrive: 400, complete: 400, fail: 800, alert: 1500 };
export const MAX_PLAYS_PER_SECOND = 4;

type AudioFactory = () => AudioContext | null;

export class OfficeSound {
  private ctx: AudioContext | null = null;
  private enabled = false;
  private volume = 0.4;
  private lastPlayed = new Map<SoundKind, number>();
  private recent: number[] = [];

  constructor(
    private readonly create: AudioFactory,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  setEnabled(on: boolean): void {
    this.enabled = on;
  }
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  }
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Resumes a suspended audio context (browsers need a user gesture first). Does nothing while sound is off. */
  unlock(): void {
    if (!this.enabled) return;
    const c = this.context();
    if (c && c.state === 'suspended') void c.resume().catch(() => undefined);
  }

  private context(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = this.create();
      } catch {
        this.ctx = null;
      }
    }
    return this.ctx;
  }

  /** Plays a sound; returns how many notes were scheduled (0 when off, muted, rate-limited or unavailable). */
  play(kind: SoundKind): number {
    if (!this.enabled || this.volume <= 0) return 0;
    const now = this.nowMs();
    const last = this.lastPlayed.get(kind);
    if (last !== undefined && now - last < MIN_GAP_MS[kind]) return 0;
    this.recent = this.recent.filter((t) => now - t < 1000);
    if (this.recent.length >= MAX_PLAYS_PER_SECOND) return 0;
    const c = this.context();
    if (!c) return 0;
    if (c.state === 'suspended') void c.resume().catch(() => undefined);
    this.lastPlayed.set(kind, now);
    this.recent.push(now);
    const master = c.createGain();
    master.gain.value = this.volume * MAX_MASTER_GAIN;
    master.connect(c.destination);
    const t0 = c.currentTime + 0.02;
    for (const n of SOUNDS[kind]) {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = n.wave;
      osc.frequency.value = n.f;
      g.gain.setValueAtTime(0.0001, t0 + n.t);
      g.gain.exponentialRampToValueAtTime(n.g, t0 + n.t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.t + n.d);
      osc.connect(g);
      g.connect(master);
      osc.start(t0 + n.t);
      osc.stop(t0 + n.t + n.d + 0.02);
    }
    return SOUNDS[kind].length;
  }
}

export const browserAudio: AudioFactory = () => {
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? new Ctor() : null;
};
