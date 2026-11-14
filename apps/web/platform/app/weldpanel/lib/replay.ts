/**
 * Pure helpers of the recording player: reading chunks, the timeline markers,
 * the inactive stretches and the page the visitor was on at a given moment.
 * Kept free of React and rrweb so they can be tested on their own.
 */

import type { PanelActivityEvent } from '@weldsuite/app-api-client/schemas/weldpanel-objects';

/** The part of an rrweb event the player reads itself; the replayer gets the rest untouched. */
export interface ReplayEvent {
  type: number;
  timestamp: number;
  data: unknown;
}

export const RRWEB_META = 4;
export const RRWEB_FULL_SNAPSHOT = 2;

/** An idle stretch longer than this is greyed out on the timeline and skipped when "skip inactivity" is on. */
export const INACTIVITY_MS = 5_000;

function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Gunzips with the platform's streams. The input goes through a Response body, as Blob.stream() is missing in some runtimes. */
export async function gunzip(bytes: Uint8Array): Promise<string> {
  const body = new Response(bytes as BodyInit).body;
  if (!body) throw new TypeError('Cannot read the chunk');
  return new Response(body.pipeThrough(new DecompressionStream('gzip'))).text();
}

/** A chunk as the API streams it: gzip of a JSON array of rrweb events (plain JSON is accepted too). */
export async function readChunk(buffer: ArrayBuffer): Promise<ReplayEvent[]> {
  const bytes = new Uint8Array(buffer);
  const text = isGzip(bytes) ? await gunzip(bytes) : new TextDecoder().decode(bytes);
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new TypeError('A recording chunk must be a list of events');
  return parsed.filter(
    (e): e is ReplayEvent => typeof e === 'object' && e !== null && typeof (e as ReplayEvent).type === 'number' && typeof (e as ReplayEvent).timestamp === 'number',
  );
}

/** Chunks in order, as one event list sorted by time (the sort is stable, so equal timestamps keep their order). */
export function mergeChunks(chunks: ReplayEvent[][]): ReplayEvent[] {
  return chunks.flat().sort((a, b) => a.timestamp - b.timestamp);
}

/** Playback needs a full snapshot; without one the replayer can only show a blank page. */
export function hasFullSnapshot(events: readonly ReplayEvent[]): boolean {
  return events.some((e) => e.type === RRWEB_FULL_SNAPSHOT);
}

export type MarkerKind = 'page' | 'click' | 'frustration' | 'error' | 'custom';

export interface TimelineMarker {
  id: string;
  kind: MarkerKind;
  /** Milliseconds from the start of the recording. */
  offsetMs: number;
  name: string;
  label: string;
  url: string | null;
}

const FRUSTRATION_EVENTS = new Set(['$rageclick', '$deadclick', '$quickback', '$excessivescroll']);

export function markerKind(name: string): MarkerKind | null {
  if (name === '$pageview') return 'page';
  if (name === '$autocapture') return 'click';
  if (FRUSTRATION_EVENTS.has(name)) return 'frustration';
  if (name === '$exception') return 'error';
  if (name === '$pageleave') return null;
  return 'custom';
}

/** The activity events of a session as markers on a timeline that starts at `startMs`; events outside the recording are dropped. */
export function buildMarkers(events: readonly PanelActivityEvent[], startMs: number, durationMs: number): TimelineMarker[] {
  const markers: TimelineMarker[] = [];
  for (const event of events) {
    const kind = markerKind(event.name);
    if (!kind) continue;
    const offsetMs = Date.parse(event.ts) - startMs;
    if (!Number.isFinite(offsetMs) || offsetMs < 0 || offsetMs > durationMs) continue;
    const label = kind === 'page' ? (event.path ?? event.url ?? event.name) : (event.detail ?? event.name);
    markers.push({ id: event.eventId, kind, offsetMs, name: event.name, label, url: event.url });
  }
  return markers.sort((a, b) => a.offsetMs - b.offsetMs);
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

/** Gaps between consecutive events longer than `thresholdMs`, as offsets from `startMs`. */
export function inactiveRanges(events: readonly ReplayEvent[], startMs: number, thresholdMs = INACTIVITY_MS): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (let i = 1; i < events.length; i++) {
    const gap = events[i]!.timestamp - events[i - 1]!.timestamp;
    if (gap > thresholdMs) ranges.push({ startMs: events[i - 1]!.timestamp - startMs, endMs: events[i]!.timestamp - startMs });
  }
  return ranges;
}

export interface PageVisit {
  offsetMs: number;
  path: string;
  url: string | null;
  title: string | null;
  /** How long the visitor stayed, up to the next page or the end. */
  durationMs: number;
}

/** The pages of the session in order, from its pageview events. */
export function buildPageVisits(events: readonly PanelActivityEvent[], startMs: number, durationMs: number): PageVisit[] {
  const views = events
    .filter((e) => e.name === '$pageview')
    .map((e) => ({ e, offsetMs: Math.max(0, Date.parse(e.ts) - startMs) }))
    .filter((v) => Number.isFinite(v.offsetMs))
    .sort((a, b) => a.offsetMs - b.offsetMs);
  return views.map(({ e, offsetMs }, index) => {
    const next = views[index + 1]?.offsetMs ?? durationMs;
    return { offsetMs, path: e.path ?? e.url ?? '/', url: e.url, title: e.title, durationMs: Math.max(0, next - offsetMs) };
  });
}

/** The page being shown at `offsetMs`. */
export function pageAt(visits: readonly PageVisit[], offsetMs: number): PageVisit | null {
  let current: PageVisit | null = null;
  for (const visit of visits) {
    if (visit.offsetMs <= offsetMs) current = visit;
    else break;
  }
  return current ?? visits[0] ?? null;
}

/** `65000` becomes "1:05"; hours appear when needed. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The scale that fits a recorded viewport inside a box, never above 1. */
export function fitScale(boxWidth: number, boxHeight: number, viewWidth: number, viewHeight: number): number {
  if (viewWidth <= 0 || viewHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) return 1;
  return Math.min(1, boxWidth / viewWidth, boxHeight / viewHeight);
}
