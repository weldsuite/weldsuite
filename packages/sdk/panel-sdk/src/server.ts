/**
 * `@weldsuite/panel-sdk/server`: events and profile updates from your own
 * server, with a secret key. Plain `fetch`, so it runs on Node 18+,
 * Cloudflare Workers, Deno and Bun.
 *
 *   import { createPanelServer } from '@weldsuite/panel-sdk/server';
 *
 *   const panel = createPanelServer({ secretKey: process.env.WELDPANEL_SECRET_KEY });
 *   panel.track({ name: 'Subscription renewed', distinctId: user.id, props: { plan: 'pro' } });
 *   panel.people.set(user.id, { email: user.email, plan: 'pro' });
 *   await panel.flush();
 *
 * Nothing is sent until `flush()` (or until 100 events are waiting): call it
 * before the process or request ends, e.g. `ctx.waitUntil(panel.flush())` on
 * Workers. Never use a secret key in a browser.
 */

import {
  cleanProps,
  cleanUserId,
  clampUrl,
  isCustomEventName,
  isoTime,
  isSystemEvent,
  LIB_VERSION,
  normalizePeopleOp,
  str,
  type PeopleOpInput,
} from './event';
import { DEFAULT_HOST, trimTrailingSlashes } from './host';
import {
  EVENT_PROPERTY_KEY,
  MAX_ID,
  MAX_IMPORT_EVENTS,
  MAX_PEOPLE_OPS_PER_BATCH,
  MAX_TITLE,
  MAX_TRACK_EVENTS,
  PROPERTY_KEY,
  type ServerBatch,
  type ServerEvent,
  type WirePeopleOp,
} from './wire';

export type { ServerBatch, ServerEvent, WirePeopleOp } from './wire';

const RETRY_DELAY_MS = 1000;

export interface PanelServerOptions {
  /** A secret key, `wps_…` (WeldPanel → project settings → Secret keys). Keep it on the server. */
  secretKey: string;
  /** The collector. Defaults to `https://pnl.weldsuite.org`. */
  collectorUrl?: string;
  /** The `fetch` to use. Defaults to the global one. */
  fetch?: typeof fetch;
  /** Called when a send started by a full queue fails (an explicit `flush()` rejects instead). Defaults to `console.error`. */
  onError?: (error: unknown) => void;
}

export interface ServerEventInput {
  /** A custom event name (as in the browser's `track()`), or one of the `$` system events. */
  name: string;
  /** Who did it: your user id, or an anonymous id you keep. 1 to 255 characters. */
  distinctId: string;
  userId?: string;
  /** The browser's anonymous id, to tie this event to the visitor's web events. */
  anonId?: string;
  /** The page, if there is one. */
  url?: string;
  title?: string;
  props?: Record<string, unknown>;
  /** When it happened. Defaults to now. `track()` takes the last 7 days, `import()` up to 5 years. */
  timestamp?: Date | string | number;
  /** Your id for the event (8 to 64 characters), so sending it twice counts once. Generated when missing. */
  eventId?: string;
}

/** What the collector says it kept, summed over the requests; invalid input dropped here counts too. */
export interface PanelServerResult {
  accepted: number;
  dropped: number;
}

export class PanelServerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PanelServerError';
    this.status = status;
    this.code = code;
  }
}

export interface PanelServer {
  /** Queue an event. Sent with `flush()`, or as soon as 100 are waiting. */
  track(event: ServerEventInput): void;
  /** Link the browser's anonymous id (`anonId`) to your user id, like the browser's `identify()`. */
  identify(input: { userId: string; anonId: string; timestamp?: Date | string | number }): void;
  /** A user's profile. `email` and `name` are the profile's own. */
  people: {
    set(userId: string, props: Record<string, unknown>): void;
    set_once(userId: string, props: Record<string, unknown>): void;
    unset(userId: string, keys: string | string[]): void;
    increment(userId: string, props: string | Record<string, number>, by?: number): void;
  };
  /** Send historical events now (timestamps up to 5 years old), in requests of 1000. */
  import(events: ServerEventInput[]): Promise<PanelServerResult>;
  /** Send everything queued. Rejects with a {@link PanelServerError} when the collector refuses (401: bad or revoked key). */
  flush(): Promise<PanelServerResult>;
}

function eventId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Node 18 without the global Web Crypto: an id only has to be unique, not secret.
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

/** The event as the collector accepts it, or null when it can't be (bad name or distinct id). */
export function toServerEvent(input: ServerEventInput): ServerEvent | null {
  if (!input || typeof input !== 'object') return null;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const distinct = cleanUserId(input.distinctId);
  if ((!isSystemEvent(name) && !isCustomEventName(name)) || !distinct) return null;
  const id = input.eventId;
  const event: ServerEvent = {
    event_id: typeof id === 'string' && id.length >= 8 && id.length <= MAX_ID ? id : eventId(),
    name,
    ts: isoTime(input.timestamp),
    distinct_id: distinct,
  };
  const userId = cleanUserId(input.userId);
  if (userId) event.user_id = userId;
  const anonId = str(input.anonId, MAX_ID);
  if (anonId) event.anon_id = anonId;
  const url = typeof input.url === 'string' ? clampUrl(input.url) : null;
  if (url) event.url = url;
  const title = str(input.title, MAX_TITLE);
  if (title) event.title = title;
  const props = cleanProps(input.props, undefined, isSystemEvent(name) ? EVENT_PROPERTY_KEY : PROPERTY_KEY);
  if (props) event.props = props;
  return event;
}

export function createPanelServer(options: PanelServerOptions): PanelServer {
  if (!options || typeof options.secretKey !== 'string' || !/^wps_[0-9a-f]{32}$/.test(options.secretKey)) {
    throw new TypeError('createPanelServer: secretKey must be a WeldPanel secret key (wps_…)');
  }
  const base = trimTrailingSlashes(options.collectorUrl || DEFAULT_HOST);
  const doFetch = options.fetch || ((...args: Parameters<typeof fetch>) => fetch(...args));
  const onError = options.onError || ((error: unknown) => console.error('[weldpanel]', error));

  let events: ServerEvent[] = [];
  let people: WirePeopleOp[] = [];
  /** Invalid input dropped here, and what sends started by a full queue got back, since the last flush(). */
  let carried: PanelServerResult = { accepted: 0, dropped: 0 };
  /** A send for a full queue is on its way. */
  let autoFlush = false;
  /** Sends run one after the other. */
  let chain: Promise<unknown> = Promise.resolve();

  async function post(path: '/v1/track' | '/v1/import', body: ServerBatch): Promise<PanelServerResult> {
    const init: RequestInit = {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, init);
      } catch (error) {
        if (attempt > 0) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      // Busy or briefly down: one more go. Events carry their ids, so a repeat counts once.
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      const json = (await res.json().catch(() => ({}))) as Partial<PanelServerResult> & {
        error?: { code?: string; message?: string };
      };
      if (!res.ok) {
        throw new PanelServerError(res.status, json.error?.code || 'error', json.error?.message || `WeldPanel answered ${res.status}`);
      }
      return { accepted: Number(json.accepted) || 0, dropped: Number(json.dropped) || 0 };
    }
  }

  /** Send everything queued, in requests of at most 100 events and 50 profile operations. */
  async function drain(): Promise<PanelServerResult> {
    autoFlush = false;
    const total: PanelServerResult = { accepted: 0, dropped: 0 };
    while (events.length || people.length) {
      const body: ServerBatch = { lib: 'server', lib_version: LIB_VERSION, events: events.splice(0, MAX_TRACK_EVENTS) };
      const ops = people.splice(0, MAX_PEOPLE_OPS_PER_BATCH);
      if (ops.length) body.people = ops;
      const result = await post('/v1/track', body);
      total.accepted += result.accepted;
      total.dropped += result.dropped;
    }
    return total;
  }

  function flush(): Promise<PanelServerResult> {
    const run = chain.then(drain, drain).then((result) => {
      const total = { accepted: carried.accepted + result.accepted, dropped: carried.dropped + result.dropped };
      carried = { accepted: 0, dropped: 0 };
      return total;
    });
    chain = run.catch(() => undefined);
    return run;
  }

  /** A full queue goes without waiting for flush(); its result is added to the next flush()'s. */
  function sendFull(): void {
    if (autoFlush) return;
    autoFlush = true;
    const run = chain.then(drain, drain).then(
      (result) => {
        carried = { accepted: carried.accepted + result.accepted, dropped: carried.dropped + result.dropped };
      },
      onError,
    );
    chain = run;
  }

  function queueEvent(event: ServerEvent | null): void {
    if (!event) {
      carried.dropped++;
      return;
    }
    events.push(event);
    if (events.length >= MAX_TRACK_EVENTS) sendFull();
  }

  function profile(input: PeopleOpInput): void {
    const op = normalizePeopleOp(input);
    if (!op) {
      carried.dropped++;
      return;
    }
    people.push(op);
    if (people.length >= MAX_PEOPLE_OPS_PER_BATCH) sendFull();
  }

  return {
    track: (event) => queueEvent(toServerEvent(event)),
    identify: ({ userId, anonId, timestamp }) => {
      const anon = str(anonId, MAX_ID);
      queueEvent(anon ? toServerEvent({ name: '$identify', distinctId: userId, userId, anonId: anon, timestamp }) : null);
    },
    people: {
      set: (userId, props) => profile({ op: 'set', user_id: userId, props }),
      set_once: (userId, props) => profile({ op: 'set_once', user_id: userId, props }),
      unset: (userId, keys) => profile({ op: 'unset', user_id: userId, keys: typeof keys === 'string' ? [keys] : keys }),
      increment: (userId, props, by) =>
        profile({ op: 'increment', user_id: userId, props: typeof props === 'string' ? { [props]: by === undefined ? 1 : by } : props }),
    },
    import: (list) => {
      const run = chain.then(async () => {
        const valid: ServerEvent[] = [];
        let dropped = 0;
        for (const input of Array.isArray(list) ? list : []) {
          const event = toServerEvent(input);
          if (event) valid.push(event);
          else dropped++;
        }
        const total: PanelServerResult = { accepted: 0, dropped };
        for (let i = 0; i < valid.length; i += MAX_IMPORT_EVENTS) {
          const result = await post('/v1/import', { lib: 'server', lib_version: LIB_VERSION, events: valid.slice(i, i + MAX_IMPORT_EVENTS) });
          total.accepted += result.accepted;
          total.dropped += result.dropped;
        }
        return total;
      });
      chain = run.catch(() => undefined);
      return run;
    },
    flush,
  };
}
