/**
 * panel-ingest bindings. Add a binding here and in wrangler.toml together.
 *
 * Deliberately no database, Hyperdrive or `DATABASE_ENCRYPTION_KEY`: the
 * collector reads project records from KV only (ADR PANEL-001, DATA-008).
 */

import type { Pipeline } from 'cloudflare:pipelines';
import type { PanelEventRow } from '@weldsuite/panel-domain/event-row';
import type { PanelSalt } from './durable-objects/panel-salt';
import type { PanelUsage } from './durable-objects/panel-usage';

/** `Pipeline<T>` wants an index-signature type; an interface (PanelEventRow) has none. */
export type PanelEventRecord = { [K in keyof PanelEventRow]: PanelEventRow[K] };

export interface Env {
  ENVIRONMENT: 'development' | 'test' | 'production';
  /** Shared with panel-api, which writes `panel:project:<token>` records; this worker also writes `panel:seen:<project>`. */
  WORKSPACE_CACHE: KVNamespace;
  /** Stream behind the `panel.events_v1` Basin table. */
  PANEL_EVENTS: Pipeline<PanelEventRecord>;
  /** One global instance (`idFromName('global')`): the daily salt of the cookieless visitor hash. */
  PANEL_SALT: DurableObjectNamespace<PanelSalt>;
  /** One instance per workspace: events counted per UTC day. */
  PANEL_USAGE: DurableObjectNamespace<PanelUsage>;
}
