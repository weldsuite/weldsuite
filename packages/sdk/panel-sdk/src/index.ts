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
import { DEFAULT_HOST, fetchConfig } from './config';
import { trimTrailingSlashes } from './host';
import { LIB_VERSION } from './event';

export interface InitOptions {
  /** The project token, `wpk_…` (Settings → Install in WeldPanel). */
  token: string;
  /** The collector. Defaults to `https://pnl.weldsuite.org`. */
  host?: string;
  /** Warn in the console about dropped events and properties. */
  debug?: boolean;
  /**
   * The recording plugin, `createRecorder` from `@weldsuite/panel-sdk/recorder`,
   * to bundle it instead of loading it from the collector when a session is recorded.
   */
  recorder?: RecorderFactory;
}

const noop = (): void => undefined;

/** What `init()` returns where there is no browser (server rendering): it does nothing. */
const inert: WeldPanel = {
  version: LIB_VERSION,
  track: noop,
  identify: noop,
  reset: noop,
  people: { set: noop, set_once: noop, unset: noop, increment: noop },
  consent: { grant: noop, revoke: noop },
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
  const client = createClient({ token: options.token, host, debug: options.debug, recorder: options.recorder });
  fetchConfig(host, options.token).then(client.start, client.fail);
  return client.api;
}

export type { WeldPanel } from './client';
export type { PanelRecorder, RecorderFactory, RecorderOptions } from './recorder-api';
export { buildBatch, buildBatches, type BatchInput } from './batch';
export { normalizeEvent, normalizePeopleOp, type EventInput, type PeopleOpInput } from './event';
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
  WirePeopleOp,
} from './wire';
