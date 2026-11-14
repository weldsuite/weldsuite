/**
 * Heatmap helpers: the viewport width a snapshot is drawn at, resolving the
 * collector's element selectors in the rebuilt page, and the colours of the
 * heat layers. Pure, so they run (and are tested) without a browser.
 */

import type { PanelDeviceClass, PanelHeatmapElement, PanelHeatmapPoint } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { gunzip, readChunk, type ReplayEvent } from './replay';

/** The snapshot carries no Meta event, so the heatmap picks the viewport per device class. */
export const DEVICE_VIEWPORT: Record<PanelDeviceClass, { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1100 },
  mobile: { width: 390, height: 844 },
};

/** A point or box in page coordinates (pixels from the top-left of the whole page). */
export interface HeatPoint {
  x: number;
  y: number;
  /** 0-1, relative to the busiest point. */
  intensity: number;
  count: number;
}

export interface HeatBox {
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0-1 of all clicks on the page. */
  share: number;
  clicks: number;
  text: string | null;
}

/** Looks an element up by selector; a selector the page can't parse or find gives `null`. */
export function findElement(doc: Document, selector: string): Element | null {
  try {
    return doc.querySelector(selector);
  } catch {
    return null;
  }
}

/** Offsets of an element from the top-left of the page, whatever the scroll position. */
export function pageRect(el: Element, doc: Document): { x: number; y: number; width: number; height: number } {
  const rect = el.getBoundingClientRect();
  const view = doc.defaultView;
  return { x: rect.left + (view?.scrollX ?? 0), y: rect.top + (view?.scrollY ?? 0), width: rect.width, height: rect.height };
}

/** Click points resolved to page coordinates; points whose element is gone from the snapshot are counted in `unresolved`. */
export function resolvePoints(doc: Document, points: readonly PanelHeatmapPoint[]): { points: HeatPoint[]; unresolved: number } {
  const max = points.reduce((m, p) => Math.max(m, p.count), 0) || 1;
  const resolved: HeatPoint[] = [];
  let unresolved = 0;
  for (const point of points) {
    const el = findElement(doc, point.selector);
    if (!el) {
      unresolved += point.count;
      continue;
    }
    const rect = pageRect(el, doc);
    if (rect.width === 0 && rect.height === 0) {
      unresolved += point.count;
      continue;
    }
    resolved.push({ x: rect.x + point.relX * rect.width, y: rect.y + point.relY * rect.height, intensity: point.count / max, count: point.count });
  }
  return { points: resolved, unresolved };
}

/** Elements resolved to boxes for the area view. */
export function resolveBoxes(doc: Document, elements: readonly PanelHeatmapElement[]): { boxes: HeatBox[]; unresolved: number } {
  const boxes: HeatBox[] = [];
  let unresolved = 0;
  for (const element of elements) {
    const el = findElement(doc, element.selector);
    const rect = el ? pageRect(el, doc) : null;
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      unresolved += element.clicks;
      continue;
    }
    boxes.push({ selector: element.selector, ...rect, share: element.share, clicks: element.clicks, text: element.text });
  }
  return { boxes, unresolved };
}

/** Colour ramp from cool to hot, `t` in 0-1: blue, green, yellow, red. */
export function heatColor(t: number, alpha = 1): string {
  const x = Math.min(1, Math.max(0, t));
  const stops: [number, number, number][] = [
    [37, 99, 235],
    [34, 197, 94],
    [250, 204, 21],
    [239, 68, 68],
  ];
  const scaled = x * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  const mix = (k: 0 | 1 | 2) => Math.round(a[k] + (b[k] - a[k]) * f);
  return `rgba(${mix(0)}, ${mix(1)}, ${mix(2)}, ${alpha})`;
}

export interface ScrollBand {
  /** Percent of the page height where the band starts. */
  fromPercent: number;
  toPercent: number;
  /** 0-1 share of leaves that got at least this far. */
  reachedShare: number;
}

/** Scroll depth buckets as bands from one depth to the next, shallowest first. */
export function scrollBands(buckets: readonly { depth: number; reachedShare: number }[]): ScrollBand[] {
  const sorted = [...buckets].sort((a, b) => a.depth - b.depth);
  return sorted.map((bucket, i) => ({
    fromPercent: bucket.depth,
    toPercent: sorted[i + 1]?.depth ?? 100,
    reachedShare: bucket.reachedShare,
  }));
}

/** The depth (percent) at which fewer than half of the visitors are left, or null when everyone gets to the bottom. */
export function averageFold(buckets: readonly { depth: number; reachedShare: number }[]): number | null {
  const sorted = [...buckets].sort((a, b) => a.depth - b.depth);
  const below = sorted.find((b) => b.reachedShare < 0.5);
  return below ? below.depth : null;
}

/** A snapshot response: gzip of a single rrweb FullSnapshot event. */
export async function readSnapshot(buffer: ArrayBuffer): Promise<ReplayEvent> {
  const events = await readChunk(await wrapSingle(buffer));
  const snapshot = events.find((e) => e.type === 2);
  if (!snapshot) throw new TypeError('The snapshot has no full snapshot event');
  return snapshot;
}

/** The API sends one event, not a list; wrap it as a list so `readChunk` reads both shapes. */
async function wrapSingle(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(buffer);
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzip(bytes) : new TextDecoder().decode(bytes);
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return new TextEncoder().encode(JSON.stringify(list)).buffer as ArrayBuffer;
}
