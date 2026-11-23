/**
 * V3: day/night, seasonal themes, sounds and preferences. All pure or injectable, so no browser is needed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { daynessAt, FADE_HOURS, lightFor, MAX_DARKNESS, SUNRISE, SUNSET } from '../src/office/light.ts';
import { DEFAULT_PREFS, readPrefs, sanitizePrefs, setPrefs } from '../src/office/prefs.ts';
import { MAX_MASTER_GAIN, MAX_PLAYS_PER_SECOND, MIN_GAP_MS, OfficeSound, SOUNDS, type SoundKind } from '../src/office/sound.ts';
import { autoTheme, themeFor } from '../src/office/theme.ts';

const at = (h: number, m = 0, month = 6, day = 15) => new Date(2026, month - 1, day, h, m, 0);

describe('day and night from the local clock', () => {
  it('is full daylight at midday and full night at midnight', () => {
    expect(lightFor(at(12))).toMatchObject({ phase: 'day', dayness: 1, darkness: 0 });
    expect(lightFor(at(0))).toMatchObject({ phase: 'night', dayness: 0, darkness: MAX_DARKNESS });
    expect(lightFor(at(23, 30)).phase).toBe('night');
    expect(lightFor(at(3)).phase).toBe('night');
  });

  it('fades smoothly through dawn and dusk and never gets darker than the maximum', () => {
    expect(lightFor(at(7)).phase).toBe('dawn');
    expect(lightFor(at(18)).phase).toBe('dusk');
    let prev = -1;
    for (let m = 0; m <= 24 * 60; m += 5) {
      const l = lightFor(at(Math.floor(m / 60) % 24, m % 60));
      expect(l.darkness).toBeGreaterThanOrEqual(0);
      expect(l.darkness).toBeLessThanOrEqual(MAX_DARKNESS);
      expect(l.dayness).toBeGreaterThanOrEqual(0);
      expect(l.dayness).toBeLessThanOrEqual(1);
      if (m < SUNRISE * 60 - 60 * FADE_HOURS) expect(l.phase).toBe('night');
      prev = l.dayness;
    }
    expect(prev).toBe(0);
    // sunrise is halfway between night and day; the morning ramp rises and the evening ramp falls
    expect(daynessAt(SUNRISE)).toBeCloseTo(0.5, 2);
    expect(daynessAt(SUNSET)).toBeCloseTo(0.5, 2);
    expect(daynessAt(6)).toBeLessThan(daynessAt(7));
    expect(daynessAt(18)).toBeGreaterThan(daynessAt(19));
  });

  it('"always day" and "always night" ignore the clock', () => {
    for (const h of [0, 6, 12, 18, 23]) {
      expect(lightFor(at(h), 'day')).toMatchObject({ phase: 'day', darkness: 0 });
      expect(lightFor(at(h), 'night')).toMatchObject({ phase: 'night', darkness: MAX_DARKNESS });
    }
  });

  it('the window sky changes colour, with an orange glow at sunrise/sunset only in automatic mode', () => {
    const hex = /^#[0-9a-f]{6}$/;
    for (const h of [0, 7, 12, 18]) for (const c of lightFor(at(h)).sky) expect(c).toMatch(hex);
    expect(lightFor(at(12)).sky[0]).not.toBe(lightFor(at(0)).sky[0]);
    const red = (c: string) => parseInt(c.slice(1, 3), 16);
    expect(red(lightFor(at(6, 30)).sky[0])).toBeGreaterThan(red(lightFor(at(12)).sky[0]));
    expect(lightFor(at(6, 30), 'day').sky).toEqual(lightFor(at(12), 'day').sky);
  });
});

describe('seasonal themes', () => {
  it('automatic: Halloween from 15 Oct to 2 Nov, Christmas from 1 Dec to 6 Jan, otherwise none', () => {
    const t = (m: number, d: number) => autoTheme(new Date(2026, m - 1, d, 12));
    expect([t(10, 14), t(10, 15), t(10, 31), t(11, 2), t(11, 3)]).toEqual(['none', 'halloween', 'halloween', 'halloween', 'none']);
    expect([t(11, 30), t(12, 1), t(12, 25), t(12, 31), t(1, 1), t(1, 6), t(1, 7)]).toEqual(['none', 'christmas', 'christmas', 'christmas', 'christmas', 'christmas', 'none']);
    expect([t(3, 10), t(7, 4), t(9, 30)]).toEqual(['none', 'none', 'none']);
  });
  it('a chosen theme always wins over the date, and "none" turns decorations off', () => {
    const summer = new Date(2026, 6, 4);
    expect(themeFor(summer, 'christmas')).toBe('christmas');
    expect(themeFor(summer, 'halloween')).toBe('halloween');
    expect(themeFor(new Date(2026, 11, 20), 'none')).toBe('none');
    expect(themeFor(new Date(2026, 11, 20), 'auto')).toBe('christmas');
  });
});

describe('sounds', () => {
  class FakeAudio {
    state = 'suspended';
    currentTime = 0;
    oscillators = 0;
    gains = 0;
    masterGain: number[] = [];
    resumed = 0;
    destination = {};
    createOscillator() {
      this.oscillators++;
      return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
    }
    createGain() {
      this.gains++;
      const g = { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
      this.masterGain.push(0);
      const idx = this.masterGain.length - 1;
      Object.defineProperty(g.gain, 'value', { set: (v: number) => (this.masterGain[idx] = v), get: () => this.masterGain[idx] });
      return g;
    }
    resume() {
      this.resumed++;
      return Promise.resolve();
    }
  }
  let audio: FakeAudio;
  let created: number;
  let clock: number;
  const make = () => new OfficeSound(() => ((created++, audio) as unknown as AudioContext), () => clock);
  beforeEach(() => {
    audio = new FakeAudio();
    created = 0;
    clock = 1_000_000;
  });

  it('is silent by default: no audio context is created and nothing plays', () => {
    const s = make();
    for (const k of Object.keys(SOUNDS) as SoundKind[]) expect(s.play(k)).toBe(0);
    s.unlock();
    expect(created).toBe(0);
    expect(audio.oscillators).toBe(0);
  });

  it('when enabled, each sound schedules its notes at a capped, quiet volume', () => {
    const s = make();
    s.setEnabled(true);
    s.setVolume(1);
    expect(s.play('complete')).toBe(SOUNDS.complete.length);
    expect(audio.oscillators).toBe(SOUNDS.complete.length);
    expect(Math.max(...audio.masterGain.filter((g) => g > 0.01))).toBeLessThanOrEqual(MAX_MASTER_GAIN);
    expect(audio.resumed).toBeGreaterThan(0); // a suspended context is resumed
  });

  it('is rate-limited per kind and overall, and a volume of zero is silent', () => {
    const s = make();
    s.setEnabled(true);
    expect(s.play('arrive')).toBeGreaterThan(0);
    expect(s.play('arrive')).toBe(0);
    clock += MIN_GAP_MS.arrive + 1;
    expect(s.play('arrive')).toBeGreaterThan(0);
    clock += 5000;
    let played = 0;
    for (const k of ['arrive', 'complete', 'fail', 'alert'] as SoundKind[]) if (s.play(k) > 0) played++;
    for (let i = 0; i < 3; i++) for (const k of ['arrive', 'complete', 'fail', 'alert'] as SoundKind[]) if (s.play(k) > 0) played++;
    expect(played).toBeLessThanOrEqual(MAX_PLAYS_PER_SECOND);
    clock += 10_000;
    s.setVolume(0);
    expect(s.play('fail')).toBe(0);
  });

  it('turning it off silences it again, and a missing or failing audio system never throws', () => {
    const s = make();
    s.setEnabled(true);
    s.play('alert');
    s.setEnabled(false);
    clock += 10_000;
    expect(s.play('alert')).toBe(0);
    const broken = new OfficeSound(() => {
      throw new Error('no audio');
    });
    broken.setEnabled(true);
    expect(broken.play('complete')).toBe(0);
    const none = new OfficeSound(() => null);
    none.setEnabled(true);
    expect(none.play('complete')).toBe(0);
  });

  it('every sound is short, in a pleasant range and bounded', () => {
    for (const [kind, notes] of Object.entries(SOUNDS)) {
      const end = Math.max(...notes.map((n) => n.t + n.d));
      expect(end, kind).toBeLessThan(1);
      for (const n of notes) {
        expect(n.f).toBeGreaterThanOrEqual(100);
        expect(n.f).toBeLessThanOrEqual(2000);
        expect(n.g).toBeGreaterThan(0);
        expect(n.g).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('preferences', () => {
  it('sound is OFF by default and the defaults are automatic', () => {
    expect(DEFAULT_PREFS).toEqual({ light: 'auto', theme: 'auto', sound: false, volume: 0.4 });
  });
  it('only known values are accepted; anything else falls back (hand-edited or corrupt storage is harmless)', () => {
    expect(sanitizePrefs({ light: 'night', theme: 'halloween', sound: true, volume: 0.7 })).toEqual({ light: 'night', theme: 'halloween', sound: true, volume: 0.7 });
    expect(sanitizePrefs({ light: 'purple', theme: 'easter', sound: 'yes', volume: 9 })).toEqual({ light: 'auto', theme: 'auto', sound: false, volume: 1 });
    expect(sanitizePrefs({ volume: -3 }).volume).toBe(0);
    expect(sanitizePrefs({ volume: NaN }).volume).toBe(DEFAULT_PREFS.volume);
    expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(sanitizePrefs('x')).toEqual(DEFAULT_PREFS);
    expect(sanitizePrefs({ sound: 1 }).sound).toBe(false);
  });

  describe('storage', () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    beforeEach(() => {
      store.clear();
      g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
      g.window = { dispatchEvent: () => true, addEventListener: () => undefined, removeEventListener: () => undefined };
    });
    afterEach(() => {
      delete g.localStorage;
      delete g.window;
    });
    it('round-trips, merges patches and survives garbage', () => {
      expect(readPrefs()).toEqual(DEFAULT_PREFS);
      setPrefs({ theme: 'christmas' });
      setPrefs({ sound: true, volume: 0.25 });
      expect(readPrefs()).toEqual({ light: 'auto', theme: 'christmas', sound: true, volume: 0.25 });
      store.set('qavo.office.prefs', '{not json');
      expect(readPrefs()).toEqual(DEFAULT_PREFS);
      store.set('qavo.office.prefs', JSON.stringify({ theme: '<script>', sound: true }));
      expect(readPrefs()).toMatchObject({ theme: 'auto', sound: true });
    });
  });
});
