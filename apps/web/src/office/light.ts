/**
 * Day and night from the viewer's LOCAL clock (pure: the time is passed in). No location is used or asked
 * for: sunrise and sunset are fixed (06:30 and 18:30) with a one-hour fade either side.
 */
export type LightMode = 'auto' | 'day' | 'night';
export type Phase = 'night' | 'dawn' | 'day' | 'dusk';
export interface Light {
  phase: Phase;
  /** 0 (full daylight) .. MAX_DARKNESS (deep night): the opacity of the night overlay. */
  darkness: number;
  /** 0 (night) .. 1 (day). */
  dayness: number;
  /** Sky colours for the windows, top and bottom. */
  sky: readonly [string, string];
}

export const SUNRISE = 6.5;
export const SUNSET = 18.5;
export const FADE_HOURS = 1;
/** Rooms stay readable at night: the overlay never gets darker than this. */
export const MAX_DARKNESS = 0.42;

const DAY_SKY: readonly [string, string] = ['#4aa3e8', '#a9d6f5'];
const NIGHT_SKY: readonly [string, string] = ['#0a1030', '#1a2250'];
const TWILIGHT_SKY: readonly [string, string] = ['#e8704f', '#ffcf8a'];

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const c = (sh: number) => Math.round(((pa >> sh) & 255) + (((pb >> sh) & 255) - ((pa >> sh) & 255)) * t);
  return `#${[c(16), c(8), c(0)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export const hourOf = (d: Date): number => d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;

export function daynessAt(hour: number): number {
  if (hour >= SUNRISE + FADE_HOURS && hour <= SUNSET - FADE_HOURS) return 1;
  if (hour <= SUNRISE - FADE_HOURS || hour >= SUNSET + FADE_HOURS) return 0;
  if (hour < 12) return smooth(clamp01((hour - (SUNRISE - FADE_HOURS)) / (2 * FADE_HOURS)));
  return smooth(clamp01((SUNSET + FADE_HOURS - hour) / (2 * FADE_HOURS)));
}

export function lightFor(date: Date, mode: LightMode = 'auto'): Light {
  const hour = hourOf(date);
  const dayness = mode === 'day' ? 1 : mode === 'night' ? 0 : daynessAt(hour);
  const phase: Phase = dayness > 0.95 ? 'day' : dayness < 0.05 ? 'night' : hour < 12 ? 'dawn' : 'dusk';
  const base = [mix(NIGHT_SKY[0], DAY_SKY[0], dayness), mix(NIGHT_SKY[1], DAY_SKY[1], dayness)] as const;
  const twilight = mode === 'auto' ? 4 * dayness * (1 - dayness) * 0.6 : 0; // strongest halfway through sunrise/sunset
  return {
    phase,
    dayness,
    darkness: Math.round(MAX_DARKNESS * (1 - dayness) * 1000) / 1000,
    sky: [mix(base[0], TWILIGHT_SKY[0], twilight), mix(base[1], TWILIGHT_SKY[1], twilight)] as const,
  };
}
