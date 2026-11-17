/**
 * Core Web Vitals for the `$webvitals` event (the `/v.js` plugin, ./vitals-api): one per page view, sent when the
 * page is hidden or left, or on a single-page-app route change. No
 * `web-vitals` dependency, to stay inside the core script's budget; the
 * measures follow its definitions closely enough for a field dashboard:
 *
 * - `$lcp`: the last largest-contentful-paint entry before the page was hidden;
 * - `$fcp`: the first-contentful-paint entry;
 * - `$ttfb`: the navigation's `responseStart`, less a prerender's activation;
 * - `$cls`: the largest session window of layout shifts (1 s gap, 5 s cap);
 * - `$inp`: the longest interaction (the true INP is the 98th percentile,
 *   which is the longest below 50 interactions, which is almost every page);
 * - `$lcp_el`, `$inp_el`, `$cls_el`: the element, as a short CSS selector;
 * - `$nav_type`: navigate, reload, back_forward, prerender, or soft for a route change.
 *
 * Only metrics the browser observed are present. Values are milliseconds,
 * `$cls` is unitless.
 */

import type { Vitals } from './vitals-api';
import type { Properties } from './wire';

export type { Vitals };

type Entry = PerformanceEntry & {
  value?: number;
  hadRecentInput?: boolean;
  element?: Element | null;
  sources?: Array<{ node?: Node | null }>;
  interactionId?: number;
  target?: Node | null;
};

const METRICS = ['$lcp', '$inp', '$fcp', '$ttfb', '$cls'];

export function watchVitals(selector: (el: Element) => string): Vitals {
  let m: Properties = {};
  let done = false;
  let cls = 0;
  let first = 0;
  let last = 0;
  const observers: PerformanceObserver[] = [];
  const el = (node: Node | null | undefined): string | undefined => (node && node.nodeType === 1 ? selector(node as Element).slice(0, 255) : undefined);
  const put = (key: string, value: number, node?: Node | null): void => {
    m[key] = value;
    const s = el(node);
    if (s) m[`${key}_el`] = s;
  };
  const watch = (type: string, fn: (e: Entry) => void, extra?: object): void => {
    try {
      const o = new PerformanceObserver((list) => {
        if (!done) list.getEntries().forEach((e) => fn(e as Entry));
      });
      o.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      observers.push(o);
    } catch {
      // This browser doesn't have that entry type.
    }
  };

  if (typeof PerformanceObserver === 'function') {
    watch('paint', (e) => {
      if (e.name === 'first-contentful-paint') m.$fcp = Math.round(e.startTime);
    });
    watch('largest-contentful-paint', (e) => put('$lcp', Math.round(e.startTime), e.element));
    watch('layout-shift', (e) => {
      if (e.hadRecentInput) return;
      const t = e.startTime;
      if (cls && t - last < 1000 && t - first < 5000) cls += e.value || 0;
      else {
        cls = e.value || 0;
        first = t;
      }
      last = t;
      if (cls > ((m.$cls as number) || 0)) put('$cls', Math.round(cls * 1e4) / 1e4, e.sources && e.sources[0] && e.sources[0].node);
    });
    watch(
      'event',
      (e) => {
        if (e.interactionId && e.duration > ((m.$inp as number) || 0)) put('$inp', Math.round(e.duration), e.target);
      },
      { durationThreshold: 40 },
    );
  }
  try {
    const n = performance.getEntriesByType('navigation')[0] as (PerformanceNavigationTiming & { activationStart?: number }) | undefined;
    if (n) {
      const activation = n.activationStart || 0;
      if (n.responseStart > 0) m.$ttfb = Math.max(0, Math.round(n.responseStart - activation));
      m.$nav_type = n.type === 'reload' || n.type === 'back_forward' ? n.type : 'navigate';
      if (activation > 0) m.$nav_type = 'prerender';
    }
  } catch {
    // No navigation timing.
  }

  return {
    take() {
      if (done || !METRICS.some((k) => k in m)) return null;
      done = true;
      return m;
    },
    soft() {
      m = { $nav_type: 'soft' };
      done = false;
      cls = 0;
    },
    stop() {
      for (const o of observers.splice(0)) o.disconnect();
    },
  };
}
