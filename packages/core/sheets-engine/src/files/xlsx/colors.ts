/**
 * SpreadsheetML colours: ARGB values, theme colours with a tint, and the
 * legacy indexed palette, all resolved to CSS hex (#rrggbb).
 */

import { child, type XmlElement } from '@weldsuite/zip-xml';

/** The Office 2013+ theme, in scheme order (dk1, lt1, dk2, lt2, accent1–6, hlink, folHlink). */
export const DEFAULT_THEME = [
  '000000',
  'ffffff',
  '44546a',
  'e7e6e6',
  '4472c4',
  'ed7d31',
  'a5a5a5',
  'ffc000',
  '5b9bd5',
  '70ad47',
  '0563c1',
  '954f72',
];

const SCHEME = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

/** Colours of a theme part (`xl/theme/theme1.xml`), falling back to the default theme. */
export function readTheme(root: XmlElement | null): string[] {
  const scheme = child(child(root ?? undefined, 'themeElements'), 'clrScheme');
  return SCHEME.map((name, i) => {
    const c = child(scheme, name)?.children[0];
    let hex: string | undefined;
    if (c?.name === 'srgbClr') hex = c.attrs.val;
    else if (c?.name === 'sysClr') hex = c.attrs.lastClr;
    return hex && /^[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : DEFAULT_THEME[i]!;
  });
}

/** Cell colours number the theme light-first: 0 is lt1, 1 dk1, 2 lt2, 3 dk2. */
const THEME_INDEX = [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11];

/** The legacy 64-colour palette `indexed` refers to (64 and 65 are the system text and window colours). */
const INDEXED = [
  '000000', 'ffffff', 'ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff',
  '000000', 'ffffff', 'ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff',
  '800000', '008000', '000080', '808000', '800080', '008080', 'c0c0c0', '808080',
  '9999ff', '993366', 'ffffcc', 'ccffff', '660066', 'ff8080', '0066cc', 'ccccff',
  '000080', 'ff00ff', 'ffff00', '00ffff', '800080', '800000', '008080', '0000ff',
  '00ccff', 'ccffff', 'ccffcc', 'ffff99', '99ccff', 'ff99cc', 'cc99ff', 'ffcc99',
  '3366ff', '33cccc', '99cc00', 'ffcc00', 'ff9900', 'ff6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
  '000000', 'ffffff',
];

/** A `color`, `fgColor` or `bgColor` element as #rrggbb; undefined for automatic or unreadable colours. */
export function resolveColor(el: XmlElement | undefined, theme: string[]): string | undefined {
  if (!el || el.attrs.auto === '1' || el.attrs.auto === 'true') return undefined;
  const a = el.attrs;
  let hex: string | undefined;
  if (a.rgb && /^([0-9a-f]{2})?[0-9a-f]{6}$/i.test(a.rgb)) hex = a.rgb.slice(-6).toLowerCase();
  else if (a.theme !== undefined) hex = theme[THEME_INDEX[Number(a.theme)] ?? -1];
  else if (a.indexed !== undefined) hex = INDEXED[Number(a.indexed)];
  if (!hex) return undefined;
  const tint = a.tint ? Number(a.tint) : 0;
  return `#${tint && Number.isFinite(tint) ? applyTint(hex, tint) : hex}`;
}

/** Lightens (tint > 0) or darkens (tint < 0) a colour the way Office does, on HSL lightness. */
export function applyTint(hex: string, tint: number): string {
  const [h, s, l] = rgbToHsl(Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16));
  const lum = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  return hslToHex(h, s, Math.min(1, Math.max(0, lum)));
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  return [h / 6, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  if (s === 0) return channel(l).repeat(3);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return channel(hue(p, q, h + 1 / 3)) + channel(hue(p, q, h)) + channel(hue(p, q, h - 1 / 3));
}

function hue(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

function channel(v: number): string {
  return Math.round(v * 255)
    .toString(16)
    .padStart(2, '0');
}

/** #rrggbb as the ARGB SpreadsheetML writes, or null for anything else. */
export function toArgb(color: string | undefined): string | null {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? `FF${color.slice(1).toUpperCase()}` : null;
}
