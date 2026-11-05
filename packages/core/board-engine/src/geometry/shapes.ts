/**
 * Outlines of the shape library, in a box at (0, 0) of size w × h. Every
 * shape is a path, so the canvas, SVG and PDF draw it the same way, and
 * hit-testing uses the same outline the user sees.
 */

import type { ShapeKind } from '../model/types';
import { ellipsePath, polygonPath, roundedRectPath, type PathCmd } from './path';

export function shapeOutline(kind: ShapeKind, w: number, h: number, radius = 0): PathCmd[] {
  switch (kind) {
    case 'rectangle':
      return roundedRectPath(0, 0, w, h, radius);
    case 'rounded':
      return roundedRectPath(0, 0, w, h, radius || Math.min(w, h) * 0.2);
    case 'ellipse':
      return ellipsePath(0, 0, w, h);
    case 'triangle':
      return polygonPath([[w / 2, 0], [w, h], [0, h]]);
    case 'diamond':
      return polygonPath([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
    case 'parallelogram': {
      const o = Math.min(w * 0.25, h * 0.5);
      return polygonPath([[o, 0], [w, 0], [w - o, h], [0, h]]);
    }
    case 'trapezoid': {
      const o = Math.min(w * 0.2, h);
      return polygonPath([[o, 0], [w - o, 0], [w, h], [0, h]]);
    }
    case 'pentagon':
      return regular(5, w, h, -Math.PI / 2);
    case 'hexagon': {
      const o = Math.min(w * 0.25, h * 0.5);
      return polygonPath([[o, 0], [w - o, 0], [w, h / 2], [w - o, h], [o, h], [0, h / 2]]);
    }
    case 'octagon': {
      const ox = w * 0.29;
      const oy = h * 0.29;
      return polygonPath([[ox, 0], [w - ox, 0], [w, oy], [w, h - oy], [w - ox, h], [ox, h], [0, h - oy], [0, oy]]);
    }
    case 'star':
      return star(w, h);
    case 'cross': {
      const tx = w / 3;
      const ty = h / 3;
      return polygonPath([
        [tx, 0], [w - tx, 0], [w - tx, ty], [w, ty], [w, h - ty], [w - tx, h - ty],
        [w - tx, h], [tx, h], [tx, h - ty], [0, h - ty], [0, ty], [tx, ty],
      ]);
    }
    case 'cylinder': {
      const ry = Math.min(h * 0.15, w * 0.25);
      const k = 0.5522847498;
      const rx = w / 2;
      return [
        ['M', 0, ry],
        ['C', 0, ry - ry * k, rx - rx * k, 0, rx, 0],
        ['C', rx + rx * k, 0, w, ry - ry * k, w, ry],
        ['L', w, h - ry],
        ['C', w, h - ry + ry * k, rx + rx * k, h, rx, h],
        ['C', rx - rx * k, h, 0, h - ry + ry * k, 0, h - ry],
        ['Z'],
        ['M', 0, ry],
        ['C', 0, ry + ry * k, rx - rx * k, ry * 2, rx, ry * 2],
        ['C', rx + rx * k, ry * 2, w, ry + ry * k, w, ry],
      ];
    }
    case 'cloud':
      return cloud(w, h);
    case 'callout': {
      const body = h * 0.78;
      return [
        ...roundedRectPath(0, 0, w, body, Math.min(w, body) * 0.12).slice(0, -1),
        ['M', w * 0.2, body],
        ['L', w * 0.15, h],
        ['L', w * 0.35, body],
      ];
    }
    case 'arrow-right': {
      const head = Math.min(w * 0.4, h);
      return polygonPath([[0, h * 0.25], [w - head, h * 0.25], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h * 0.75], [0, h * 0.75]]);
    }
    case 'arrow-left': {
      const head = Math.min(w * 0.4, h);
      return polygonPath([[w, h * 0.25], [head, h * 0.25], [head, 0], [0, h / 2], [head, h], [head, h * 0.75], [w, h * 0.75]]);
    }
    case 'chevron': {
      const o = Math.min(w * 0.3, h * 0.5);
      return polygonPath([[0, 0], [w - o, 0], [w, h / 2], [w - o, h], [0, h], [o, h / 2]]);
    }
    case 'document': {
      const wave = h * 0.1;
      return [
        ['M', 0, 0],
        ['L', w, 0],
        ['L', w, h - wave],
        ['C', w * 0.75, h - wave * 3, w * 0.5, h + wave, 0, h - wave],
        ['Z'],
      ];
    }
    case 'predefined': {
      const inset = Math.min(w * 0.1, 16);
      return [
        ...polygonPath([[0, 0], [w, 0], [w, h], [0, h]]),
        ['M', inset, 0],
        ['L', inset, h],
        ['M', w - inset, 0],
        ['L', w - inset, h],
      ];
    }
    case 'data': {
      const o = Math.min(w * 0.2, h * 0.5);
      return polygonPath([[o, 0], [w, 0], [w - o, h], [0, h]]);
    }
    case 'terminator':
      return roundedRectPath(0, 0, w, h, h / 2);
    case 'delay': {
      const r = Math.min(h / 2, w / 2);
      const k = 0.5522847498;
      return [
        ['M', 0, 0],
        ['L', w - r, 0],
        ['C', w - r + r * k, 0, w, h / 2 - r * k, w, h / 2],
        ['C', w, h / 2 + r * k, w - r + r * k, h, w - r, h],
        ['L', 0, h],
        ['Z'],
      ];
    }
    case 'manual-input':
      return polygonPath([[0, h * 0.25], [w, 0], [w, h], [0, h]]);
  }
}

function regular(sides: number, w: number, h: number, start: number): PathCmd[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < sides; i++) {
    const a = start + (i * 2 * Math.PI) / sides;
    pts.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)]);
  }
  return polygonPath(pts);
}

function star(w: number, h: number): PathCmd[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? 1 : 0.45;
    pts.push([w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a)]);
  }
  return polygonPath(pts);
}

function cloud(w: number, h: number): PathCmd[] {
  // Bumps on an ellipse, each a quadratic curve bulging outwards.
  const bumps = 9;
  const cmds: PathCmd[] = [];
  const cx = w / 2;
  const cy = h / 2;
  const point = (a: number, r: number): [number, number] => [cx + (w / 2) * r * Math.cos(a), cy + (h / 2) * r * Math.sin(a)];
  for (let i = 0; i <= bumps; i++) {
    const a = (i * 2 * Math.PI) / bumps;
    const p = point(a, 0.82);
    if (i === 0) cmds.push(['M', p[0], p[1]]);
    else {
      const mid = point(a - Math.PI / bumps, 1.08);
      cmds.push(['Q', mid[0], mid[1], p[0], p[1]]);
    }
  }
  cmds.push(['Z']);
  return cmds;
}

/** The part of a shape text goes in, as a box inside the shape's box. */
export function textBox(kind: ShapeKind | undefined, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const pad = 8;
  switch (kind) {
    case 'ellipse':
    case 'cloud':
      return { x: w * 0.15, y: h * 0.15, w: w * 0.7, h: h * 0.7 };
    case 'diamond':
      return { x: w * 0.25, y: h * 0.25, w: w * 0.5, h: h * 0.5 };
    case 'triangle':
      return { x: w * 0.25, y: h * 0.45, w: w * 0.5, h: h * 0.5 };
    case 'star':
    case 'pentagon':
      return { x: w * 0.3, y: h * 0.35, w: w * 0.4, h: h * 0.4 };
    case 'callout':
      return { x: pad, y: pad, w: w - pad * 2, h: h * 0.78 - pad * 2 };
    case 'cylinder': {
      const ry = Math.min(h * 0.15, w * 0.25);
      return { x: pad, y: ry * 2 + pad / 2, w: w - pad * 2, h: h - ry * 3 - pad };
    }
    default:
      return { x: pad, y: pad, w: Math.max(0, w - pad * 2), h: Math.max(0, h - pad * 2) };
  }
}
