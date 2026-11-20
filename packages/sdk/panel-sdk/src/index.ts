/**
 * @weldsuite/panel-sdk: WeldPanel analytics for websites and web apps.
 *
 *   import { init } from '@weldsuite/panel-sdk';
 *   const panel = init({ token: 'wpk_…' });
 *   panel.track('Signed up', { plan: 'pro' });
 *
 * The script snippet (`/s.js`) is the same client, started from the script
 * tag (./snippet.ts).
 */

import { createClient, type WeldPanel } from './client';
import type { RecorderFactory } from './recorder-api';
import type { VitalsFactory } from './vitals-api';
import { DEFAULT_HOST, fetchConfig } from './config';
import { trimTrailingSlashes } from './host';
import { LIB_VERSION } from './event';

export interface InitOptions {
  /** The project token, `wpk_…` (Settings → Install in WeldPanel). */
  token: string;
  /** The collector. Defaults to `https://pnl.weldsuite.org`. */
  host?: string;
  /**
   * Where events, the project config and recordings are sent, when that is not `host`: a reverse
   * proxy on your own domain (`https://example.com/wp`, see `@weldsuite/panel-sdk/install`) or a
   * custom collector domain. Defaults to `host`.
   */
  apiHost?: string;
  /** Warn in the console about dropped events and properties. */
  debug?: boolean;
  /**
   * The recording plugin, `createRecorder` from `@weldsuite/panel-sdk/recorder`,
   * to bundle it instead of loading it from the collector when a session is recorded.
   */
  recorder?: RecorderFactory;
  /**
   * `false`: don't send `$webvitals` (Core Web Vitals, one event per page view). On by default; the
   * measuring plugin is loaded from the collector (`/v.js`) unless you pass `vitals`.
   */
  webVitals?: boolean;
  /** The web vitals plugin, `watchVitals` from `@weldsuite/panel-sdk/vitals`, to bundle it instead of loading it. */
  vitals?: VitalsFactory;
}

const noop = (): void => undefined;
const none = (): null => null;

/** What `init()` returns where there is no browser (server rendering): it does nothing. */
const inert: WeldPanel = {
  version: LIB_VERSION,
  track: noop,
  identify: noop,
  reset: noop,
  people: { set: noop, set_once: noop, unset: noop, increment: noop },
  consent: { grant: noop, revoke: noop },
  register: noop,
  registerOnce: noop,
  unregister: noop,
  group: noop,
  groups: { set: noop, set_once: noop, unset: noop },
  resetGroups: noop,
  getDistinctId: none,
  getSessionId: none,
  optOut: noop,
  optIn: noop,
  flush: () => Promise.resolve(),
};

/**
 * Start collecting for a project. Returns at once; the project's settings are
 * fetched from the collector and calls made in the meantime are kept and run
 * when they arrive. If they can't be loaded, nothing is collected on this page.
 */
export function init(options: InitOptions): WeldPanel {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !options || !options.token) return inert;
  const host = trimTrailingSlashes(options.host || DEFAULT_HOST);
  // A relative `apiHost` (`/wp`) is the site's own origin.
  const apiHost = trimTrailingSlashes(options.apiHost ? new URL(options.apiHost, location.href).href : host);
  const client = createClient({ token: options.token, host, apiHost, debug: options.debug, recorder: options.recorder, webVitals: options.webVitals, vitals: options.vitals });
  fetchConfig(apiHost, options.token).then(client.start, client.fail);
  return client.api;
}

export type { WeldPanel } from './client';
export type { PanelRecorder, RecorderFactory, RecorderOptions } from './recorder-api';
export type { Vitals, VitalsFactory } from './vitals-api';
export { buildBatches, buildBatch, type BatchInput } from './batch';
export { normalizeEvent, normalizeGroupOp, normalizePeopleOp, type EventInput, type GroupOpInput, type PeopleOpInput } from './event';
export { LIB_VERSION };
export type {
  ClientConfig,
  DeviceClass,
  EventBatch,
  Properties,
  PropertyValue,
  SystemEventName,
  WireElement,
  WireEvent,
  WireGroupOp,
  WirePeopleOp,
} from './wire';
