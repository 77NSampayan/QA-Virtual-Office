/**
 * Pixel-grid primitives for the code-drawn sprites. A Grid is [y][x] of '#rrggbb' | null.
 * No DOM here: sprites are pure functions of (type, status, palette, frame) so they can be tested.
 */
export type Color = string | null;
export type Grid = Color[][];

export const OUTLINE = '#0b0f1a';
export const SCREEN_DARK = '#0d1220';
export const WHITE = '#e8eef9';

export function makeGrid(w: number, h: number): Grid {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => null as Color));
}

export function put(g: Grid, x: number, y: number, c: Color): void {
  if (y >= 0 && y < g.length && x >= 0 && x < g[0]!.length) g[y]![x] = c;
}

export function puts(g: Grid, pts: ReadonlyArray<readonly [number, number]>, c: Color, dx = 0, dy = 0): void {
  for (const [x, y] of pts) put(g, x + dx, y + dy, c);
}

export function rect(g: Grid, x: number, y: number, w: number, h: number, c: Color): void {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(g, x + i, y + j, c);
}

/** Outlined, filled box. */
export function box(g: Grid, x: number, y: number, w: number, h: number, fill: Color, outline: Color = OUTLINE): void {
  rect(g, x, y, w, h, outline);
  rect(g, x + 1, y + 1, w - 2, h - 2, fill);
}

/** Stamps a string matrix; each char maps to a colour ('.' and unknown chars are transparent). */
export function stamp(g: Grid, rows: readonly string[], x0: number, y0: number, colors: Record<string, string>): void {
  rows.forEach((row, j) => {
    [...row].forEach((ch, i) => {
      const c = colors[ch];
      if (c) put(g, x0 + i, y0 + j, c);
    });
  });
}

// ---------------------------------------------------------------------------- colour helpers
function parse(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
const toHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}
export const darken = (hex: string, t: number) => mix(hex, '#000000', t);
export const lighten = (hex: string, t: number) => mix(hex, '#ffffff', t);
/** Desaturate and dim (used for powered-off robots). */
export function powerOff(hex: string): string {
  const [r, g, b] = parse(hex);
  const l = 0.3 * r + 0.59 * g + 0.11 * b;
  return mix(toHex(l, l, l), '#1a1f2c', 0.45);
}

export function gridEquals(a: Grid, b: Grid): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Stable text fingerprint of a grid (for snapshot tests). */
export function gridSignature(g: Grid): string {
  return g.map((row) => row.map((c) => (c ? c.slice(1) : '------')).join(',')).join('/');
}
