/**
 * Sample recordings: for a session of the made-up dataset, the rrweb chunks
 * the player loads (one chunk per page visit: a Meta event, a full snapshot
 * and mouse moves, clicks and scrolls in bursts with quiet stretches between
 * them) and the activity events the timeline markers come from. Both are made
 * together, so a marker sits where the click really happens.
 */

import type { PanelActivityEvent, PanelChunkManifestEntry } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelDeviceClass } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { APP_SCREENS, between, pick, rng, sessionById, type SampleSession } from '../dataset';
import { buildPage, pageKindOf, type BuiltPage, type SerializedNode } from './objects-pages';

export interface RrwebEvent {
  type: number;
  timestamp: number;
  data: unknown;
}

const VIEWPORTS: Record<'desktop' | 'tablet' | 'mobile', { width: number; height: number }> = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1100 },
  mobile: { width: 390, height: 844 },
};

export function viewportFor(deviceClass: PanelDeviceClass | string): { width: number; height: number } {
  if (deviceClass === 'mobile') return VIEWPORTS.mobile;
  return deviceClass === 'tablet' ? VIEWPORTS.tablet : VIEWPORTS.desktop;
}

export function hostFor(path: string): string {
  return APP_SCREENS.some((s) => s.path === path) ? 'app.weldsuite.org' : 'weldsuite.com';
}

export function urlFor(path: string): string {
  return `https://${hostFor(path)}${path}`;
}

const PAGE_TITLES: Record<string, string> = {};
/** The text of the <title> in a page document, or a plain default. */
function documentTitle(document: SerializedNode): string {
  const fallback = 'WeldSuite';
  const html = document.type === 0 ? document.childNodes[1] : undefined;
  if (!html || html.type !== 2) return fallback;
  const head = html.childNodes[0];
  if (!head || head.type !== 2) return fallback;
  const title = head.childNodes.find((c) => c.type === 2 && c.tagName === 'title');
  const text = title && title.type === 2 ? title.childNodes[0] : undefined;
  return text && text.type === 3 ? text.textContent : fallback;
}

export function titleOf(path: string): string {
  if (!PAGE_TITLES[path]) PAGE_TITLES[path] = documentTitle(buildPage(path, pageKindOf(path)).document);
  return PAGE_TITLES[path]!;
}

/** The rrweb full snapshot event of a page, as the heatmap snapshot route returns it. */
export function snapshotEvent(path: string, timestamp: number): RrwebEvent {
  const built = buildPage(path, pageKindOf(path));
  return { type: 2, timestamp, data: { node: built.document, initialOffset: { left: 0, top: 0 } } };
}

export interface SessionReplay {
  chunks: { seq: number; tsStart: string; tsEnd: string; events: RrwebEvent[] }[];
  activity: PanelActivityEvent[];
}

const CACHE = new Map<string, SessionReplay>();

function eventDetail(label: string): string {
  return `Clicked '${label}'`;
}

function moveEvent(ts: number, positions: { x: number; y: number }[], id: number): RrwebEvent {
  return {
    type: 3,
    timestamp: ts,
    data: { source: 1, positions: positions.map((p, i) => ({ x: Math.round(p.x), y: Math.round(p.y), id, timeOffset: -(positions.length - 1 - i) * 150 })) },
  };
}

interface PageSegment {
  path: string;
  from: number;
  to: number;
}

/** What building one session's replay needs to carry from page to page. */
interface ReplayBuilder {
  session: SampleSession;
  random: () => number;
  view: { width: number; height: number };
  /** Share of the time the visitor is active (0.45 to 0.9). */
  ratio: number;
  activity: PanelActivityEvent[];
}

/** Where the pointer and scroll are on the page being built, and what it has recorded so far. */
interface PageWalk {
  builder: ReplayBuilder;
  segment: PageSegment;
  page: BuiltPage;
  events: RrwebEvent[];
  bodyId: number;
  maxScroll: number;
  isLast: boolean;
  x: number;
  y: number;
  scrollY: number;
  rageDone: boolean;
}

function addActivity(builder: ReplayBuilder, name: string, ts: number, path: string, detail: string | null, properties: PanelActivityEvent['properties'] = {}): void {
  const eventNo = builder.activity.length + 1;
  builder.activity.push({
    eventId: `${builder.session.sessionId}_ev${String(eventNo).padStart(3, '0')}`,
    name,
    ts: new Date(ts).toISOString(),
    path,
    url: urlFor(path),
    title: titleOf(path),
    sessionId: builder.session.sessionId,
    detail,
    properties,
  });
}

/** Splits the session over its pages, each as long as its random share of the visit. */
function splitSegments(session: SampleSession, random: () => number, start: number, duration: number): PageSegment[] {
  const weights = session.pages.map(() => 0.5 + random());
  const total = weights.reduce((a, b) => a + b, 0);
  let cursor = 0;
  const segments = session.pages.map((path, i) => {
    const length = Math.round((duration * weights[i]!) / total);
    const seg = { path, from: start + cursor, to: start + cursor + length };
    cursor += length;
    return seg;
  });
  segments[segments.length - 1]!.to = start + duration;
  return segments;
}

/** Mouse moves, now and then a scroll, through one burst of activity. */
function wander(walk: PageWalk, from: number, end: number): void {
  const { random, view } = walk.builder;
  for (let at = from; at < end; at += 650) {
    const points: { x: number; y: number }[] = [];
    for (let k = 0; k < 3; k++) {
      walk.x = Math.min(view.width - 4, Math.max(4, walk.x + between(random, -140, 140)));
      walk.y = Math.min(view.height - 4, Math.max(4, walk.y + between(random, -90, 90)));
      points.push({ x: walk.x, y: walk.y });
    }
    walk.events.push(moveEvent(at, points, walk.bodyId));
    if (walk.maxScroll > 0 && random() < 0.35) {
      walk.scrollY = Math.min(walk.maxScroll, walk.scrollY + between(random, 80, 420));
      walk.events.push({ type: 3, timestamp: at + 200, data: { source: 3, id: 1, x: 0, y: walk.scrollY } });
    }
  }
}

/** Signing up, starting to and asking for a demo show up as their own events. */
function followUpEvents(walk: PageWalk, htmlId: string, ts: number): void {
  const { builder, segment } = walk;
  if (htmlId === 'signup-submit') addActivity(builder, 'signup_completed', ts + 600, segment.path, null, { plan: 'trial' });
  if (htmlId === 'cta-trial' || htmlId === 'hero-cta') addActivity(builder, 'signup_started', ts + 400, segment.path, null, { source: htmlId });
  if (htmlId === 'hero-secondary' || htmlId === 'plan-enterprise-cta') addActivity(builder, 'demo_requested', ts + 800, segment.path, null);
}

/** A click at the end of most bursts, on something that exists. */
function clickSomething(walk: PageWalk, end: number): void {
  const { builder, page, segment } = walk;
  const { random, view } = builder;
  if (page.targets.length === 0 || random() >= 0.6) return;
  const target = pick(random, page.targets, page.targets.map((t) => t.weight));
  const tx = Math.min(view.width - 10, target.x);
  const ty = Math.max(10, target.y - walk.scrollY);
  const id = page.ids[target.htmlId] ?? walk.bodyId;
  const ts = end + 200;
  walk.events.push(moveEvent(ts - 150, [{ x: tx, y: ty }], walk.bodyId));
  walk.events.push({ type: 3, timestamp: ts, data: { source: 2, type: 2, id, x: tx, y: ty } });
  addActivity(builder, '$autocapture', ts, segment.path, eventDetail(target.label), { $el_text: target.label, $selector: `#${target.htmlId}`, $event_type: 'click' });
  walk.x = tx;
  walk.y = ty;
  followUpEvents(walk, target.htmlId, ts);
}

/** Frustration (rage or dead clicks, an error) in the last third of the final page. */
function isFrustrated(walk: PageWalk, t: number): boolean {
  const { session } = walk.builder;
  const unhappy = session.rageClicks > 0 || session.deadClicks > 0 || session.errors > 0;
  return walk.isLast && !walk.rageDone && unhappy && t > walk.segment.from + (walk.segment.to - walk.segment.from) * 0.4;
}

function frustrate(walk: PageWalk, end: number): void {
  const { builder, page, segment } = walk;
  const { session, view } = builder;
  const dead = page.targets.find((c) => c.htmlId === 'hero-secondary') ?? page.targets[0];
  walk.rageDone = true;
  if (!dead) return;
  const id = page.ids[dead.htmlId] ?? walk.bodyId;
  const ts = end + 400;
  const clicks = session.rageClicks > 0 ? 4 : 1;
  for (let c = 0; c < clicks; c++) {
    walk.events.push({ type: 3, timestamp: ts + c * 180, data: { source: 2, type: 2, id, x: Math.min(view.width - 10, dead.x), y: Math.max(10, dead.y - walk.scrollY) } });
  }
  const selector = { $el_text: dead.label, $selector: `#${dead.htmlId}` };
  if (session.rageClicks > 0) addActivity(builder, '$rageclick', ts + 3 * 180, segment.path, `Rage click on '${dead.label}'`, { ...selector, click_count: clicks });
  else if (session.deadClicks > 0) addActivity(builder, '$deadclick', ts, segment.path, `Dead click on '${dead.label}'`, selector);
  if (session.errors > 0) addActivity(builder, '$exception', ts + 900, segment.path, "TypeError: Cannot read properties of undefined (reading 'plan')", { $exception_type: 'TypeError', $exception_message: "Cannot read properties of undefined (reading 'plan')" });
}

/** The chunk of one page visit: the page, then bursts of activity with quiet stretches between. */
function buildChunk(builder: ReplayBuilder, segments: PageSegment[], index: number): SessionReplay['chunks'][number] {
  const { session, random, view, ratio } = builder;
  const segment = segments[index]!;
  const page: BuiltPage = buildPage(segment.path, pageKindOf(segment.path));
  const events: RrwebEvent[] = [
    { type: 4, timestamp: segment.from, data: { href: urlFor(segment.path), width: view.width, height: view.height } },
    { type: 2, timestamp: segment.from + 1, data: { node: page.document, initialOffset: { left: 0, top: 0 } } },
  ];
  addActivity(builder, '$pageview', segment.from + 2, segment.path, null, { $referrer: index === 0 ? session.referrerHost : urlFor(segments[index - 1]!.path) });

  const walk: PageWalk = {
    builder,
    segment,
    page,
    events,
    bodyId: page.ids.body ?? 1,
    maxScroll: Math.max(0, page.height - view.height),
    isLast: index === segments.length - 1,
    x: between(random, 100, view.width - 100),
    y: between(random, 120, view.height - 100),
    scrollY: 0,
    rageDone: false,
  };
  let t = segment.from + 900;
  while (t < segment.to - 700) {
    const burst = Math.min(between(random, 3500, 11000), segment.to - t - 300);
    const end = t + burst;
    wander(walk, t, end);
    clickSomething(walk, end);
    if (isFrustrated(walk, t)) frustrate(walk, end);
    const gap = Math.round((burst * (1 - ratio)) / ratio * (0.6 + random() * 0.8));
    t = end + Math.max(1200, gap);
  }
  // Close the page with one last movement, so the recording runs to the end of the visit.
  events.push(moveEvent(segment.to - 5, [{ x: walk.x, y: walk.y }], walk.bodyId));
  events.sort((a, b) => a.timestamp - b.timestamp);
  return { seq: index, tsStart: new Date(segment.from).toISOString(), tsEnd: new Date(segment.to).toISOString(), events };
}

function buildReplay(session: SampleSession): SessionReplay {
  const random = rng(`replay|${session.sessionId}`);
  const start = Date.parse(session.startedAt);
  const duration = session.durationSeconds * 1000;
  const ratio = Math.min(0.9, Math.max(0.45, session.activeSeconds / Math.max(1, session.durationSeconds)));
  const builder: ReplayBuilder = { session, random, view: viewportFor(session.device), ratio, activity: [] };
  const segments = splitSegments(session, random, start, duration);
  const chunks = segments.map((_, index) => buildChunk(builder, segments, index));
  const activity = builder.activity.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return { chunks, activity };
}

/** The replay of a session, made once per session and then kept. */
export function replayFor(sessionId: string): SessionReplay {
  const cached = CACHE.get(sessionId);
  if (cached) return cached;
  const built = buildReplay(sessionById(sessionId));
  CACHE.set(sessionId, built);
  return built;
}

/** The manifest the session detail lists: one entry per chunk. */
export function chunkManifest(sessionId: string): PanelChunkManifestEntry[] {
  return replayFor(sessionId).chunks.map((c) => ({
    seq: c.seq,
    tsStart: c.tsStart,
    tsEnd: c.tsEnd,
    bytes: JSON.stringify(c.events).length,
    hasFullSnapshot: true,
  }));
}

/** A raw JSON response: the player and heatmap read plain JSON as well as gzip. */
export function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
