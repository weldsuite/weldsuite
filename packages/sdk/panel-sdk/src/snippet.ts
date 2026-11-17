/**
 * Starting the SDK from its script tag:
 *
 *   <script async src="https://pnl.weldsuite.org/s.js" data-project="wpk_…"></script>
 *
 * The token comes from `data-project`, the collector is where the script came
 * from (`https://example.com/wp` for `https://example.com/wp/s.js`, a reverse
 * proxy), or `data-api-host` when events go somewhere else than the script,
 * `data-web-vitals="false"` turns web vitals off, and calls queued on the stub
 * (./install.ts) are replayed.
 */

import type { WeldPanel } from './client';
import { init } from './index';

export type StubCall = [method: string, args: unknown[]];

interface Stub {
  q?: StubCall[];
  version?: string;
}

type Method = (...args: unknown[]) => unknown;

/** What the stub (./install.ts) queues; nothing else is replayed. */
const METHODS = [
  'track',
  'identify',
  'reset',
  'flush',
  'optOut',
  'optIn',
  'consent.grant',
  'consent.revoke',
  'people.set',
  'people.set_once',
  'people.unset',
  'people.increment',
  'register',
  'registerOnce',
  'unregister',
  'group',
  'resetGroups',
  'groups.set',
  'groups.set_once',
  'groups.unset',
];

function method(api: WeldPanel, name: string): Method | undefined {
  if (METHODS.indexOf(name) < 0) return undefined;
  const [first, second] = name.split('.');
  const value = (api as unknown as Record<string, unknown>)[first];
  return (second ? (value as Record<string, Method>)[second] : value) as Method;
}

/** Run the stub's queued calls against the real client, in order. */
export function replay(api: WeldPanel, queue: StubCall[]): void {
  for (const entry of queue) {
    const fn = Array.isArray(entry) ? method(api, entry[0]) : undefined;
    if (fn) fn(...(Array.isArray(entry[1]) ? entry[1] : []));
  }
}

/**
 * Start from a script element (normally `document.currentScript`). The stub
 * object is upgraded in place rather than replaced, so code that kept a
 * reference to `window.weldpanel` from before the load keeps working.
 */
export function bootSnippet(current: Element | null): WeldPanel | undefined {
  const w = window as unknown as { weldpanel?: Stub };
  const existing = w.weldpanel;
  // Loaded twice: the first copy is in charge.
  if (existing && typeof existing.version === 'string') return existing as unknown as WeldPanel;

  const script = (current && current.hasAttribute('data-project') ? current : document.querySelector('script[data-project]')) as
    | HTMLScriptElement
    | null;
  const token = script ? script.getAttribute('data-project') : null;
  if (!script || !token || !script.src) {
    console.warn('[weldpanel] add data-project="wpk_…" to the WeldPanel script tag');
    return undefined;
  }

  // `…/s.js` behind a path on the site's own domain (`/wp/s.js`, a reverse proxy) keeps the path.
  const src = new URL(script.src, location.href);
  const api = init({
    token,
    host: src.origin + (/\/s\.js$/.test(src.pathname) ? src.pathname.slice(0, -5) : ''),
    apiHost: script.getAttribute('data-api-host') || undefined,
    debug: script.hasAttribute('data-debug'),
    webVitals: script.getAttribute('data-web-vitals') !== 'false',
  });
  const target: Stub = existing && typeof existing === 'object' ? existing : {};
  const queue = Array.isArray(target.q) ? target.q : [];
  delete target.q;
  Object.assign(target, api);
  w.weldpanel = target;
  replay(api, queue);
  return api;
}
