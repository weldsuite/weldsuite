/**
 * The contract between the core and the web vitals plugin. The core loads the
 * plugin from `<collector>/v.js` (dist/panel-vitals.global.js), which puts its
 * factory on `window[VITALS_GLOBAL]`, so the measuring code stays out of the
 * core script's budget; apps that bundle the SDK can pass `watchVitals` from
 * `@weldsuite/panel-sdk/vitals` to `init()` instead. The observers use
 * `buffered: true`, so a plugin that arrives after the first paint still sees it.
 */

import type { Properties } from './wire';

export const VITALS_GLOBAL = '__weldpanel_vitals';

export interface Vitals {
  /** The page view's metrics, once: null when none was observed or they were taken already. */
  take(): Properties | null;
  /** A route change: the next page view's metrics start from nothing (LCP, FCP and TTFB don't apply to it). */
  soft(): void;
  stop(): void;
}

/** `selector` turns an element into the short CSS selector autocapture uses. */
export type VitalsFactory = (selector: (el: Element) => string) => Vitals;
