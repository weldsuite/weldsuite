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
import { buildPage, pageKindOf, type BuiltPage } from './objects-pages';

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
  return deviceClass === 'mobile' ? VIEWPORTS.mobile : deviceClass === 'tablet' ? VIEWPORTS.tablet : VIEWPORTS.desktop;
}

export function hostFor(path: string): string {
  return APP_SCREENS.some((s) => s.path === path) ? 'app.weldsuite.org' : 'weldsuite.com';
}

export function urlFor(path: string): string {
  return `https://${hostFor(path)}${path}`;
}

const PAGE_TITLES: Record<string, string> = {};
export function titleOf(path: string): string {
  if (!PAGE_TITLES[path]) {
    const built = buildPage(path, pageKindOf(path));
    const html = built.document.type === 0 ? built.document.childNodes[1] : undefined;
    let title = 'WeldSuite';
    if (html && html.type === 2) {
      const head = html.childNodes[0];
      const t = head && head.type === 2 ? head.childNodes.find((c) => c.type === 2 && c.tagName === 'title') : undefined;
      const text = t && t.type === 2 ? t.childNodes[0] : undefined;
      if (text && text.type === 3) title = text.textContent;
    }
    PAGE_TITLES[path] = title;
  }
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

function buildReplay(session: SampleSession): SessionReplay {
  const random = rng(`replay|${session.sessionId}`);
  const start = Date.parse(session.startedAt);
  const duration = session.durationSeconds * 1000;
  const view = viewportFor(session.device);
  const ratio = Math.min(0.9, Math.max(0.45, session.activeSeconds / Math.max(1, session.durationSeconds)));

  // Split the session over its pages.
  const weights = session.pages.map(() => 0.5 + random());
  const total = weights.reduce((a, b) => a + b, 0);
  let cursor = 0;
  const segments = session.pages.map((path, i) => {
    const length = Math.round((duration * weights[i]!) / total);
    const seg = { path, from: start + cursor, to: start + cursor + length };
    cursor += length;
    return seg;
  });
  const last = segments[segments.length - 1]!;
  last.to = start + duration;

  const chunks: SessionReplay['chunks'] = [];
  const activity: PanelActivityEvent[] = [];
  let eventNo = 0;
  const addActivity = (name: string, ts: number, path: string, detail: string | null, properties: PanelActivityEvent['properties'] = {}) => {
    eventNo += 1;
    activity.push({
      eventId: `${session.sessionId}_ev${String(eventNo).padStart(3, '0')}`,
      name,
      ts: new Date(ts).toISOString(),
      path,
      url: urlFor(path),
      title: titleOf(path),
      sessionId: session.sessionId,
      detail,
      properties,
    });
  };

  segments.forEach((segment, index) => {
    const page: BuiltPage = buildPage(segment.path, pageKindOf(segment.path));
    const events: RrwebEvent[] = [
      { type: 4, timestamp: segment.from, data: { href: urlFor(segment.path), width: view.width, height: view.height } },
      { type: 2, timestamp: segment.from + 1, data: { node: page.document, initialOffset: { left: 0, top: 0 } } },
    ];
    addActivity('$pageview', segment.from + 2, segment.path, null, { $referrer: index === 0 ? session.referrerHost : urlFor(segments[index - 1]!.path) });

    const bodyId = page.ids.body ?? 1;
    const targets = page.targets;
    const weightsT = targets.map((t) => t.weight);
    const maxScroll = Math.max(0, page.height - view.height);
    let scrollY = 0;
    let x = between(random, 100, view.width - 100);
    let y = between(random, 120, view.height - 100);
    let t = segment.from + 900;
    const isLast = index === segments.length - 1;
    let rageDone = false;

    while (t < segment.to - 700) {
      const burst = Math.min(between(random, 3500, 11000), segment.to - t - 300);
      const end = t + burst;
      let clicked = false;
      for (let at = t; at < end; at += 650) {
        const points: { x: number; y: number }[] = [];
        for (let k = 0; k < 3; k++) {
          x = Math.min(view.width - 4, Math.max(4, x + between(random, -140, 140)));
          y = Math.min(view.height - 4, Math.max(4, y + between(random, -90, 90)));
          points.push({ x, y });
        }
        events.push(moveEvent(at, points, bodyId));
        if (maxScroll > 0 && random() < 0.35) {
          scrollY = Math.min(maxScroll, scrollY + between(random, 80, 420));
          events.push({ type: 3, timestamp: at + 200, data: { source: 3, id: 1, x: 0, y: scrollY } });
        }
      }
      // A click at the end of most bursts, on something that exists.
      if (!clicked && targets.length > 0 && random() < 0.6) {
        const target = pick(random, targets, weightsT);
        const tx = Math.min(view.width - 10, target.x);
        const ty = Math.max(10, target.y - scrollY);
        const id = page.ids[target.htmlId] ?? bodyId;
        const ts = end + 200;
        events.push(moveEvent(ts - 150, [{ x: tx, y: ty }], bodyId));
        events.push({ type: 3, timestamp: ts, data: { source: 2, type: 2, id, x: tx, y: ty } });
        addActivity('$autocapture', ts, segment.path, eventDetail(target.label), { $el_text: target.label, $selector: `#${target.htmlId}`, $event_type: 'click' });
        clicked = true;
        x = tx;
        y = ty;
        // Signing up shows up as its own event.
        if (target.htmlId === 'signup-submit') addActivity('signup_completed', ts + 600, segment.path, null, { plan: 'trial' });
        if (target.htmlId === 'cta-trial' || target.htmlId === 'hero-cta') addActivity('signup_started', ts + 400, segment.path, null, { source: target.htmlId });
        if (target.htmlId === 'hero-secondary' || target.htmlId === 'plan-enterprise-cta') addActivity('demo_requested', ts + 800, segment.path, null);
      }
      // Frustration in the last third of the final page.
      if (isLast && !rageDone && (session.rageClicks > 0 || session.deadClicks > 0 || session.errors > 0) && t > segment.from + (segment.to - segment.from) * 0.4) {
        const dead = targets.find((c) => c.htmlId === 'hero-secondary') ?? targets[0];
        if (dead) {
          const id = page.ids[dead.htmlId] ?? bodyId;
          const ts = end + 400;
          const clicks = session.rageClicks > 0 ? 4 : 1;
          for (let c = 0; c < clicks; c++) {
            events.push({ type: 3, timestamp: ts + c * 180, data: { source: 2, type: 2, id, x: Math.min(view.width - 10, dead.x), y: Math.max(10, dead.y - scrollY) } });
          }
          if (session.rageClicks > 0) addActivity('$rageclick', ts + 3 * 180, segment.path, `Rage click on '${dead.label}'`, { $el_text: dead.label, $selector: `#${dead.htmlId}`, click_count: clicks });
          else if (session.deadClicks > 0) addActivity('$deadclick', ts, segment.path, `Dead click on '${dead.label}'`, { $el_text: dead.label, $selector: `#${dead.htmlId}` });
          if (session.errors > 0) addActivity('$exception', ts + 900, segment.path, "TypeError: Cannot read properties of undefined (reading 'plan')", { $exception_type: 'TypeError', $exception_message: "Cannot read properties of undefined (reading 'plan')" });
        }
        rageDone = true;
      }
      const gap = Math.round((burst * (1 - ratio)) / ratio * (0.6 + random() * 0.8));
      t = end + Math.max(1200, gap);
    }
    // Close the page with one last movement, so the recording runs to the end of the visit.
    events.push(moveEvent(segment.to - 5, [{ x, y }], bodyId));
    events.sort((a, b) => a.timestamp - b.timestamp);
    chunks.push({ seq: index, tsStart: new Date(segment.from).toISOString(), tsEnd: new Date(segment.to).toISOString(), events });
  });

  activity.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
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
