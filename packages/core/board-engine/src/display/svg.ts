/**
 * Writes a display list as an SVG document: board exports, Drive
 * thumbnails and clipboard images. Pure string building, so it runs in a
 * worker as well as in the browser.
 */

import { pathToSvg, trimTrailingZeros, type Rect } from '../geometry/path';
import type { DisplayItem } from './display';

export interface SvgOptions {
  /** Area of the board to show. */
  view: Rect;
  /** Output width in px (height follows the view's aspect). */
  width?: number;
  background?: string | null;
  /** Padding around the view, board units. */
  padding?: number;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function num(n: number): string {
  return trimTrailingZeros(n.toFixed(2));
}

type ItemOf<K extends DisplayItem['kind']> = Extract<DisplayItem, { kind: K }>;

/** The `<defs>` an SVG collects while it is written, and the clip-path ids handed out so far. */
interface SvgDefs {
  list: string[];
  clips: number;
}

function nextClipId(defs: SvgDefs): string {
  defs.clips++;
  return `wb-clip-${defs.clips}`;
}

function pathSvg(item: ItemOf<'path'>): string {
  const attrs = [
    `d="${pathToSvg(item.cmds)}"`,
    `fill="${item.fill ? escapeXml(item.fill) : 'none'}"`,
    item.stroke ? `stroke="${escapeXml(item.stroke)}" stroke-width="${num(item.width ?? 1)}"` : '',
    item.dash ? `stroke-dasharray="${item.dash.map(num).join(' ')}"` : '',
    item.round ? 'stroke-linecap="round" stroke-linejoin="round"' : '',
    item.opacity !== undefined ? `opacity="${num(item.opacity)}"` : '',
    item.shadow ? 'filter="url(#wb-shadow)"' : '',
  ].filter(Boolean);
  return `<path ${attrs.join(' ')}/>`;
}

function textSvg(item: ItemOf<'text'>): string {
  let out = '';
  if (item.highlight) {
    out += `<rect x="${num(item.x)}" y="${num(item.y - item.font.size * 0.95)}" width="${num(item.width)}" height="${num(item.font.size * 1.25)}" fill="${escapeXml(item.highlight.color)}"/>`;
  }
  const deco = [item.underline ? 'underline' : '', item.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  const text =
    `<text x="${num(item.x)}" y="${num(item.y)}" font-family="${escapeXml(item.font.family)}, sans-serif" font-size="${num(item.font.size)}"` +
    (item.font.bold ? ' font-weight="bold"' : '') +
    (item.font.italic ? ' font-style="italic"' : '') +
    (deco ? ` text-decoration="${deco}"` : '') +
    ` fill="${escapeXml(item.color)}" xml:space="preserve">${escapeXml(item.text)}</text>`;
  out += item.link ? `<a href="${escapeXml(item.link)}">${text}</a>` : text;
  return out;
}

function imageSvg(item: ItemOf<'image'>, defs: SvgDefs): string {
  const id = nextClipId(defs);
  const r = item.radius ?? 0;
  defs.list.push(`<clipPath id="${id}"><rect x="${num(item.x)}" y="${num(item.y)}" width="${num(item.w)}" height="${num(item.h)}" rx="${num(r)}"/></clipPath>`);
  if (item.crop) {
    // Scale the full image so that the cropped part fills the box.
    const fw = item.w / item.crop.w;
    const fh = item.h / item.crop.h;
    const fx = item.x - item.crop.x * fw;
    const fy = item.y - item.crop.y * fh;
    return `<image href="${escapeXml(item.src)}" x="${num(fx)}" y="${num(fy)}" width="${num(fw)}" height="${num(fh)}" preserveAspectRatio="none" clip-path="url(#${id})"/>`;
  }
  return `<image href="${escapeXml(item.src)}" x="${num(item.x)}" y="${num(item.y)}" width="${num(item.w)}" height="${num(item.h)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`;
}

function groupSvg(item: ItemOf<'group'>, defs: SvgDefs): string {
  const attrs: string[] = [];
  if (item.rotate) attrs.push(`transform="rotate(${num((item.rotate.angle * 180) / Math.PI)} ${num(item.rotate.cx)} ${num(item.rotate.cy)})"`);
  if (item.opacity !== undefined) attrs.push(`opacity="${num(item.opacity)}"`);
  if (item.clip) {
    const id = nextClipId(defs);
    defs.list.push(`<clipPath id="${id}"><path d="${pathToSvg(item.clip)}"/></clipPath>`);
    attrs.push(`clip-path="url(#${id})"`);
  }
  return `<g ${attrs.join(' ')}>${itemsSvg(item.items, defs)}</g>`;
}

function itemsSvg(list: DisplayItem[], defs: SvgDefs): string {
  let out = '';
  for (const item of list) {
    switch (item.kind) {
      case 'path':
        out += pathSvg(item);
        break;
      case 'text':
        out += textSvg(item);
        break;
      case 'image':
        out += imageSvg(item, defs);
        break;
      case 'group':
        out += groupSvg(item, defs);
        break;
    }
  }
  return out;
}

export function displayToSvg(items: DisplayItem[], options: SvgOptions): string {
  const pad = options.padding ?? 24;
  const v = { x: options.view.x - pad, y: options.view.y - pad, w: options.view.w + pad * 2, h: options.view.h + pad * 2 };
  const width = options.width ?? Math.max(1, Math.round(v.w));
  const height = Math.max(1, Math.round((width * v.h) / Math.max(1, v.w)));
  const defs: SvgDefs = {
    list: [
      '<filter id="wb-shadow" x="-10%" y="-10%" width="130%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.18"/></filter>',
    ],
    clips: 0,
  };

  const body = itemsSvg(items, defs);
  const bg = options.background === undefined ? '#ffffff' : options.background;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="${num(v.x)} ${num(v.y)} ${num(v.w)} ${num(v.h)}">` +
    `<defs>${defs.list.join('')}</defs>` +
    (bg ? `<rect x="${num(v.x)}" y="${num(v.y)}" width="${num(v.w)}" height="${num(v.h)}" fill="${escapeXml(bg)}"/>` : '') +
    body +
    '</svg>'
  );
}
