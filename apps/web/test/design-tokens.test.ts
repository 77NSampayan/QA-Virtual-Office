/**
 * Slice 5: the colours that carry text must be readable (WCAG AA, 4.5:1) on every surface they appear on. The tokens are
 * read from the real stylesheet, so a later edit to a colour cannot silently break contrast.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_STATUSES, STATUS_COLOR } from '@qavo/shared';
import { statusTextColor } from '../src/statusColor.ts';

const css = fs.readFileSync(path.resolve(__dirname, '../src/styles.css'), 'utf8');
const root = /:root\s*\{([^}]*)\}/.exec(css)![1]!;
const token = (name: string): string => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(root);
  if (!m) throw new Error(`token --${name} is not a hex colour`);
  return m[1]!;
};

const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const SURFACES = ['bg', 'bg2', 'panel', 'panel2', 'field', 'hover'];
const TEXT = ['text', 'muted', 'cyan', 'purple', 'green', 'orange', 'red', 'yellow', 'blue'];

describe('design tokens are readable', () => {
  for (const t of TEXT) {
    it(`--${t} reaches 4.5:1 on every surface`, () => {
      for (const s of SURFACES) expect(contrast(token(t), token(s)), `${t} on ${s}`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('text on the brand button reaches 4.5:1', () => {
    expect(contrast(token('on-accent'), token('cyan'))).toBeGreaterThanOrEqual(4.5);
  });

  it('every status written as text is readable on the panel and on a hovered row', () => {
    for (const status of ALL_STATUSES) {
      const c = statusTextColor(status);
      const hex = c === 'var(--muted)' ? token('muted') : c;
      for (const s of ['panel', 'hover']) expect(contrast(hex, token(s)), `${status} on ${s}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the dark "powered off" colour stays for lights and dots, only the text colour differs', () => {
    expect(STATUS_COLOR.disconnected).toBe('#4a5266');
    expect(statusTextColor('disconnected')).toBe('var(--muted)');
    expect(statusTextColor('failed')).toBe(STATUS_COLOR.failed);
  });
});
