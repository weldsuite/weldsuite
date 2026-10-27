/**
 * Starting the SDK from its script tag:
 *
 *   <script async src="https://pnl.weldsuite.org/s.js" data-project="wpk_…"></script>
 *
 * The token comes from `data-project`, the collector is the script's own
 * origin, and calls queued on the stub (./install.ts) are replayed.
 */

import type { WeldPanel } from './client';
import { init } from './index';

export type StubCall = [method: string, args: unknown[]];

interface Stub {
  q?: StubCall[];
  version?: string;
}

type Method = (...args: unknown[]) => unknown;

function method(api: WeldPanel, name: string): Method | undefined {
  switch (name) {
    case 'track':
      return api.track as Method;
    case 'flush':
      return api.flush;
    case 'optOut':
      return api.optOut;
    case 'optIn':
      return api.optIn;
    case 'consent.grant':
      return api.consent.grant;
    case 'consent.revoke':
      return api.consent.revoke;
    default:
      return undefined;
  }
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

  const api = init({ token, host: new URL(script.src, location.href).origin, debug: script.hasAttribute('data-debug') });
  const target: Stub = existing && typeof existing === 'object' ? existing : {};
  const queue = Array.isArray(target.q) ? target.q : [];
  delete target.q;
  Object.assign(target, api);
  w.weldpanel = target;
  replay(api, queue);
  return api;
}
