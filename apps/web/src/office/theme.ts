/** Seasonal office themes (pure: the date is passed in). */
export type ThemePref = 'auto' | 'none' | 'christmas' | 'halloween';
export type Theme = 'none' | 'christmas' | 'halloween';
export const THEME_PREFS: readonly ThemePref[] = ['auto', 'none', 'christmas', 'halloween'];
export const THEME_LABEL: Record<ThemePref, string> = { auto: 'Automatic (by date)', none: 'None', christmas: 'Christmas', halloween: 'Halloween' };

/** Automatic dates: Halloween from 15 October to 2 November; Christmas from 1 December to 6 January. */
export function autoTheme(d: Date): Theme {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if ((m === 10 && day >= 15) || (m === 11 && day <= 2)) return 'halloween';
  if (m === 12 || (m === 1 && day <= 6)) return 'christmas';
  return 'none';
}

export const themeFor = (d: Date, pref: ThemePref): Theme => (pref === 'auto' ? autoTheme(d) : pref);
