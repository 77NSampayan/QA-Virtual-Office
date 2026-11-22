/** Desktop preferences, stored in Electron's userData and validated on every load and write. */
import fs from 'node:fs';
import path from 'node:path';

export const TOAST_PRIORITIES = ['high', 'warning', 'low', 'info'] as const;
export type ToastPriority = (typeof TOAST_PRIORITIES)[number];

export interface Prefs {
  /** Closing or minimizing hides the window to the tray instead of quitting. */
  minimizeToTray: boolean;
  /** Play the system beep with high-priority alerts. */
  sound: boolean;
  /** Which notification priorities raise a Windows toast. */
  toastPriorities: ToastPriority[];
  /** Registered as a login item (mirrors the OS setting). */
  startWithWindows: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  minimizeToTray: true,
  sound: false,
  toastPriorities: ['high', 'warning'],
  startWithWindows: false,
};

export const PREF_KEYS = Object.keys(DEFAULT_PREFS) as Array<keyof Prefs>;

/** Returns a fully valid Prefs object: unknown or invalid fields fall back to defaults. */
export function sanitizePrefs(input: unknown): Prefs {
  const r = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pri = Array.isArray(r.toastPriorities) ? r.toastPriorities.filter((p): p is ToastPriority => (TOAST_PRIORITIES as readonly string[]).includes(p as string)) : null;
  return {
    minimizeToTray: typeof r.minimizeToTray === 'boolean' ? r.minimizeToTray : DEFAULT_PREFS.minimizeToTray,
    sound: typeof r.sound === 'boolean' ? r.sound : DEFAULT_PREFS.sound,
    toastPriorities: pri ? [...new Set(pri)] : [...DEFAULT_PREFS.toastPriorities],
    startWithWindows: typeof r.startWithWindows === 'boolean' ? r.startWithWindows : DEFAULT_PREFS.startWithWindows,
  };
}

export function loadPrefs(dir: string): Prefs {
  try {
    return sanitizePrefs(JSON.parse(fs.readFileSync(path.join(dir, 'desktop-prefs.json'), 'utf8')));
  } catch {
    return sanitizePrefs({});
  }
}

export function savePrefs(dir: string, prefs: Prefs): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'desktop-prefs.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2));
  fs.renameSync(tmp, file);
}

/** Validates a single-key update coming over IPC; returns null when the key or value is invalid. */
export function applyPrefUpdate(current: Prefs, key: unknown, value: unknown): Prefs | null {
  if (typeof key !== 'string' || !(PREF_KEYS as string[]).includes(key)) return null;
  const next = sanitizePrefs({ ...current, [key]: value });
  // reject values that sanitizing silently replaced (wrong type)
  if (JSON.stringify(next[key as keyof Prefs]) !== JSON.stringify(value)) {
    if (key === 'toastPriorities' && Array.isArray(value) && value.every((v) => (TOAST_PRIORITIES as readonly string[]).includes(v as string))) return next;
    return null;
  }
  return next;
}
