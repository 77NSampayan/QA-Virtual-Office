/**
 * Office appearance preferences: per viewer (this browser or the desktop window), stored locally, validated on
 * read, never sent anywhere. Sound is OFF by default.
 */
import { useSyncExternalStore } from 'react';
import type { LightMode } from './light.ts';
import { THEME_PREFS, type ThemePref } from './theme.ts';

export interface OfficePrefs {
  light: LightMode;
  theme: ThemePref;
  sound: boolean;
  /** 0..1 */
  volume: number;
}
export const DEFAULT_PREFS: OfficePrefs = { light: 'auto', theme: 'auto', sound: false, volume: 0.4 };
const KEY = 'qavo.office.prefs';
const EVENT = 'qavo-office-prefs';
const LIGHT_MODES: readonly LightMode[] = ['auto', 'day', 'night'];

/** Accepts only known values; anything else falls back to the default (a hand-edited or corrupt value is harmless). */
export function sanitizePrefs(raw: unknown): OfficePrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const volume = typeof r.volume === 'number' && Number.isFinite(r.volume) ? Math.max(0, Math.min(1, r.volume)) : DEFAULT_PREFS.volume;
  return {
    light: LIGHT_MODES.includes(r.light as LightMode) ? (r.light as LightMode) : DEFAULT_PREFS.light,
    theme: THEME_PREFS.includes(r.theme as ThemePref) ? (r.theme as ThemePref) : DEFAULT_PREFS.theme,
    sound: r.sound === true,
    volume,
  };
}

let cache: { raw: string | null; prefs: OfficePrefs } | null = null;
export function readPrefs(): OfficePrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    /* storage unavailable: defaults */
  }
  if (cache && cache.raw === raw) return cache.prefs;
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  cache = { raw, prefs: sanitizePrefs(parsed) };
  return cache.prefs;
}

export function setPrefs(patch: Partial<OfficePrefs>): OfficePrefs {
  const next = sanitizePrefs({ ...readPrefs(), ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the choice lasts until reload (the event below still updates this page) */
    cache = { raw: null, prefs: next };
  }
  window.dispatchEvent(new Event(EVENT));
  return next;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}

export const useOfficePrefs = (): OfficePrefs => useSyncExternalStore(subscribe, readPrefs, () => DEFAULT_PREFS);
