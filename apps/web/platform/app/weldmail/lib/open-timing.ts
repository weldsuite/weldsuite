/**
 * How long opening WeldMail takes, measured in the browser (phase 0 of
 * docs/plans/weldmail-mailbox-storage.md).
 *
 * An open starts when the router enters `/weldmail`, or at page load when the
 * page itself was loaded on a mail URL. It ends when the thread list shows data
 * fetched from the server during this open. On the way it notes:
 *
 * - `gate`: the module's access check passed and the mail layout rendered;
 * - `firstList`: the list first showed threads, possibly from the persisted
 *   query cache (`listFromCache`).
 *
 * The result goes to Mixpanel as one `Mail Open Timing` event, together with
 * the API requests made during the open: path, host, duration, transfer size
 * and the `Server-Timing` values the API workers send (KV, master, perm, db,
 * db-first). It also leaves `performance.measure()` entries for DevTools.
 *
 * An open the user leaves before it ends, or that takes over a minute, is
 * dropped without an event.
 */

import { track } from '@/lib/analytics';

type OpenKind = 'page-load' | 'navigation';

interface MailOpen {
  kind: OpenKind;
  /** `performance.now()` at the start; 0 for a page load. */
  start: number;
  gate?: number;
  firstList?: number;
  listFromCache?: boolean;
  /** The tab was hidden at some point: timers and rendering were throttled. */
  wasHidden: boolean;
  requests: PerformanceResourceTiming[];
  /** Take the resource entries the observer has queued but not delivered yet. */
  flush: () => void;
  stop: () => void;
}

/** Longer than this and the open is dropped: someone walked away. */
const MAX_OPEN_MS = 60_000;
/** Requests reported per open; a mail open makes about ten. */
const MAX_REQUESTS = 25;

let current: MailOpen | null = null;

function supported(): boolean {
  return typeof performance !== 'undefined' && typeof performance.now === 'function';
}

/**
 * Start timing an open. `pageLoad` is true when this is the first route the
 * app resolves, so the open is measured from the page's time origin and
 * includes downloading the app and signing in.
 */
export function startMailOpen(pageLoad: boolean): void {
  if (!supported()) return;
  current?.stop();

  const open: MailOpen = {
    kind: pageLoad ? 'page-load' : 'navigation',
    start: pageLoad ? 0 : performance.now(),
    wasHidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
    requests: [],
    flush: () => {},
    stop: () => {},
  };

  const collect = (entries: PerformanceEntryList) => {
    for (const entry of entries as PerformanceResourceTiming[]) {
      if (entry.startTime >= open.start && isApiRequest(entry)) open.requests.push(entry);
    }
  };
  let observer: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== 'undefined') {
    observer = new PerformanceObserver((list) => collect(list.getEntries()));
    try {
      // `buffered` replays what the page loaded before this point, which for a
      // page load is the whole open so far.
      observer.observe({ type: 'resource', buffered: true });
    } catch {
      observer = null;
    }
  }
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') open.wasHidden = true;
  };
  document.addEventListener('visibilitychange', onVisibility);
  const timeout = setTimeout(() => open.stop(), MAX_OPEN_MS);

  open.flush = () => {
    if (observer) collect(observer.takeRecords());
  };
  open.stop = () => {
    observer?.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    clearTimeout(timeout);
    if (current === open) current = null;
  };
  current = open;
}

/** The mail layout rendered: the module access check passed. */
export function markMailGatePassed(): void {
  if (current && current.gate === undefined) current.gate = performance.now();
}

/**
 * The thread list has data to show. `fromServer` is true once that data was
 * fetched during this open; the first call with `fromServer` ends the open.
 */
export function markMailListShown(fromServer: boolean): void {
  const open = current;
  if (!open) return;
  const now = performance.now();
  if (open.firstList === undefined) {
    open.firstList = now;
    open.listFromCache = !fromServer;
  }
  if (fromServer) finish(open, now, 'loaded');
}

/** The thread list failed to load: report what the open got to. */
export function markMailListFailed(): void {
  if (current) finish(current, performance.now(), 'error');
}

/** Drop the current open, e.g. when the user leaves mail before the list loads. */
export function abandonMailOpen(): void {
  current?.stop();
}

function finish(open: MailOpen, end: number, outcome: 'loaded' | 'error'): void {
  open.flush();
  open.stop();

  addMeasure('weldmail: open', open.start, end);
  if (open.gate !== undefined) addMeasure('weldmail: access check', open.start, open.gate);
  if (open.firstList !== undefined) addMeasure('weldmail: first list', open.start, open.firstList);

  track('Mail Open Timing', {
    kind: open.kind,
    outcome,
    wasHidden: open.wasHidden,
    totalMs: Math.round(end - open.start),
    gateMs: relative(open.gate, open.start),
    firstListMs: relative(open.firstList, open.start),
    listFromCache: open.listFromCache ?? false,
    requests: summarizeRequests(open.requests, open.start),
  });
}

function relative(at: number | undefined, start: number): number | null {
  return at === undefined ? null : Math.round(at - start);
}

function addMeasure(name: string, start: number, end: number): void {
  try {
    performance.measure(name, { start, end });
  } catch {
    // Older browsers without the options form: DevTools just misses the entry.
  }
}

function isApiRequest(entry: PerformanceResourceTiming): boolean {
  if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest') return false;
  try {
    return new URL(entry.name).pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

export interface RequestSummary {
  /** First label of the host: `mail-api`, `app-api`, … */
  host: string;
  /** Path with record ids replaced by `:id`; no query string. */
  path: string;
  startMs: number;
  ms: number;
  /** Bytes over the wire; 0 when the response came from cache. */
  bytes: number;
  /** `Server-Timing` metrics by name, in ms. Empty when the API did not send them. */
  server: Record<string, number>;
}

export function summarizeRequests(entries: readonly PerformanceResourceTiming[], start: number): RequestSummary[] {
  return [...entries]
    .sort((a, b) => a.startTime - b.startTime)
    .slice(0, MAX_REQUESTS)
    .map((entry) => {
      const url = new URL(entry.name);
      return {
        host: url.hostname.split('.')[0] ?? url.hostname,
        path: normalizePath(url.pathname),
        startMs: Math.round(entry.startTime - start),
        ms: Math.round(entry.duration),
        bytes: entry.transferSize ?? 0,
        server: Object.fromEntries((entry.serverTiming ?? []).map((metric) => [metric.name, Math.round(metric.duration)])),
      };
    });
}

/** `/api/mail-accounts/macc_01HX…/labels` → `/api/mail-accounts/:id/labels`. */
export function normalizePath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (segment.length >= 10 && /\d/.test(segment) ? ':id' : segment))
    .join('/');
}
