/**
 * A page's content stream: PDF drawing operators, written in page
 * coordinates from the top-left (what the layout uses) and flipped here to
 * PDF's bottom-up y axis, so callers never think about it.
 */

import type { BorderLine } from '../../model/styles';
import { num } from './pdf-writer';

export type Rgb = [number, number, number];

const NAMED: Record<string, Rgb> = {
  black: [0, 0, 0],
  white: [1, 1, 1],
  red: [1, 0, 0],
  green: [0, 0.5, 0],
  blue: [0, 0, 1],
  yellow: [1, 1, 0],
  gray: [0.5, 0.5, 0.5],
  grey: [0.5, 0.5, 0.5],
};

/** A CSS colour (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`, a few names) as 0–1 RGB; null for transparent or unknown. */
export function parseColor(color: string | undefined): Rgb | null {
  if (!color) return null;
  const c = color.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4})$/.exec(c);
  if (m) {
    const h = m[1]!;
    if (h.length === 4 && h[3] === '0') return null;
    return [0, 1, 2].map((i) => parseInt(h[i]! + h[i]!, 16) / 255) as Rgb;
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(c);
  if (m) {
    if (m[2] === '00') return null;
    return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16) / 255) as Rgb;
  }
  m = rgbFunction(c);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return [m[1], m[2], m[3]].map((v) => Math.min(1, Math.max(0, parseFloat(v!) / 255))) as Rgb;
  }
  return NAMED[c] ?? null;
}

/**
 * `rgb(r, g, b)` / `rgba(r g b / a)`: red, green and blue in groups 1–3, the
 * alpha in group 4. Matched in two steps, the call and then its (trimmed)
 * arguments.
 */
function rgbFunction(c: string): RegExpExecArray | null {
  const call = /^rgba?\(([^)]*)\)$/.exec(c);
  return call ? /^([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?$/.exec(call[1]!.trim()) : null;
}

/** Bézier handle length for a quarter circle. */
const KAPPA = 0.5523;

export class ContentStream {
  /** Operators, as characters 0–255 (text strings hold WinAnsi bytes). */
  text = '';
  /** Current character and word spacing (text state outlives BT/ET, so it is tracked). */
  private tc = 0;
  private tw = 0;

  constructor(readonly pageHeight: number) {}

  op(s: string): void {
    this.text += `${s}\n`;
  }

  /** PDF y of a page y. */
  y(top: number): number {
    return this.pageHeight - top;
  }

  fillColor(c: Rgb): void {
    this.op(`${num(c[0])} ${num(c[1])} ${num(c[2])} rg`);
  }

  strokeColor(c: Rgb): void {
    this.op(`${num(c[0])} ${num(c[1])} ${num(c[2])} RG`);
  }

  /** Sets character and word spacing inside a text object, only when they change. */
  spacing(tc: number, tw: number): void {
    if (Math.abs(tc - this.tc) > 1e-6) {
      this.op(`${num(tc)} Tc`);
      this.tc = tc;
    }
    if (Math.abs(tw - this.tw) > 1e-6) {
      this.op(`${num(tw)} Tw`);
      this.tw = tw;
    }
  }

  /** A filled rectangle; rounded when `radius` is set. */
  fillRect(x: number, top: number, width: number, height: number, color: Rgb, radius = 0): void {
    if (width <= 0 || height <= 0) return;
    this.fillColor(color);
    this.rectPath(x, top, width, height, radius);
    this.op('f');
  }

  strokeRect(x: number, top: number, width: number, height: number, color: Rgb, lineWidth: number, radius = 0): void {
    this.strokeColor(color);
    this.op(`${num(lineWidth)} w 0 J [] 0 d`);
    this.rectPath(x, top, width, height, radius);
    this.op('s');
  }

  rectPath(x: number, top: number, width: number, height: number, radius = 0): void {
    const y = this.y(top + height);
    const r = Math.min(radius, width / 2, height / 2);
    if (r <= 0) {
      this.op(`${num(x)} ${num(y)} ${num(width)} ${num(height)} re`);
      return;
    }
    const k = r * KAPPA;
    const x1 = x + width;
    const y1 = y + height;
    this.op(
      [
        `${num(x + r)} ${num(y)} m`,
        `${num(x1 - r)} ${num(y)} l`,
        `${num(x1 - r + k)} ${num(y)} ${num(x1)} ${num(y + r - k)} ${num(x1)} ${num(y + r)} c`,
        `${num(x1)} ${num(y1 - r)} l`,
        `${num(x1)} ${num(y1 - r + k)} ${num(x1 - r + k)} ${num(y1)} ${num(x1 - r)} ${num(y1)} c`,
        `${num(x + r)} ${num(y1)} l`,
        `${num(x + r - k)} ${num(y1)} ${num(x)} ${num(y1 - r + k)} ${num(x)} ${num(y1 - r)} c`,
        `${num(x)} ${num(y + r)} l`,
        `${num(x)} ${num(y + r - k)} ${num(x + r - k)} ${num(y)} ${num(x + r)} ${num(y)} c`,
        'h',
      ].join(' '),
    );
  }

  /** A circle path around (cx, cy) in page coordinates. */
  circlePath(cx: number, cy: number, r: number): void {
    const y = this.y(cy);
    const k = r * KAPPA;
    this.op(
      [
        `${num(cx + r)} ${num(y)} m`,
        `${num(cx + r)} ${num(y + k)} ${num(cx + k)} ${num(y + r)} ${num(cx)} ${num(y + r)} c`,
        `${num(cx - k)} ${num(y + r)} ${num(cx - r)} ${num(y + k)} ${num(cx - r)} ${num(y)} c`,
        `${num(cx - r)} ${num(y - k)} ${num(cx - k)} ${num(y - r)} ${num(cx)} ${num(y - r)} c`,
        `${num(cx + k)} ${num(y - r)} ${num(cx + r)} ${num(y - k)} ${num(cx + r)} ${num(y)} c`,
        'h',
      ].join(' '),
    );
  }

  /**
   * A border or rule. Dashed and dotted lines scale their pattern with the
   * width; a double line is two strokes a third of the width each, a third
   * apart (as CSS draws `double`).
   */
  line(x1: number, y1: number, x2: number, y2: number, width: number, color: Rgb, style: BorderLine['style'] = 'solid'): void {
    if (width <= 0) return;
    this.strokeColor(color);
    if (style === 'double') {
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      // Unit normal, to offset the two strokes to either side.
      const nx = -(y2 - y1) / len;
      const ny = (x2 - x1) / len;
      const w = width / 3;
      this.op(`${num(w)} w 2 J [] 0 d`);
      for (const s of [-1, 1]) {
        const ox = nx * w * s;
        const oy = ny * w * s;
        this.op(`${num(x1 + ox)} ${num(this.y(y1 + oy))} m ${num(x2 + ox)} ${num(this.y(y2 + oy))} l S`);
      }
      return;
    }
    if (style === 'dashed') this.op(`${num(width)} w 0 J [${num(Math.max(2, width * 3))} ${num(Math.max(1.5, width * 2))}] 0 d`);
    else if (style === 'dotted') this.op(`${num(width)} w 1 J [0 ${num(width * 2)}] 0 d`);
    // Projecting caps close the corners where table borders meet.
    else this.op(`${num(width)} w 2 J [] 0 d`);
    this.op(`${num(x1)} ${num(this.y(y1))} m ${num(x2)} ${num(this.y(y2))} l S`);
  }

  /** A checklist box at (x, top), ticked when `checked`. */
  checkbox(x: number, top: number, size: number, checked: boolean, color: Rgb): void {
    const lw = Math.max(0.6, size * 0.08);
    this.strokeRect(x + lw / 2, top + lw / 2, size - lw, size - lw, color, lw, size * 0.15);
    if (!checked) return;
    this.op(`${num(lw * 1.4)} w 1 J 1 j [] 0 d`);
    this.op(
      `${num(x + size * 0.22)} ${num(this.y(top + size * 0.52))} m ` +
        `${num(x + size * 0.42)} ${num(this.y(top + size * 0.72))} l ` +
        `${num(x + size * 0.78)} ${num(this.y(top + size * 0.3))} l S`,
    );
    this.op('0 j');
  }

  /** Draws an image XObject over a box, cropping by fractions of the source (by clipping to the box). */
  image(resource: string, x: number, top: number, width: number, height: number, crop?: { top: number; right: number; bottom: number; left: number }): void {
    const l = crop?.left ?? 0;
    const r = crop?.right ?? 0;
    const t = crop?.top ?? 0;
    const b = crop?.bottom ?? 0;
    const fullW = width / Math.max(0.01, 1 - l - r);
    const fullH = height / Math.max(0.01, 1 - t - b);
    this.op('q');
    if (crop) {
      this.rectPath(x, top, width, height);
      this.op('W n');
    }
    this.op(`${num(fullW)} 0 0 ${num(fullH)} ${num(x - l * fullW)} ${num(this.y(top + height) - b * fullH)} cm /${resource} Do`);
    this.op('Q');
  }
}
