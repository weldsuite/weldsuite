/**
 * panel-ingest bindings. Add a binding here and in wrangler.toml together.
 *
 * Deliberately no database, Hyperdrive or `DATABASE_ENCRYPTION_KEY`: the
 * collector reads project records from KV only (ADR PANEL-001, DATA-008).
 *
 * The bindings added after phase 1 (people, identities, recordings, the rate
 * limiters) are optional: a missing one switches its feature off with one
 * warning in the log (lib/warn.ts), never an error to the tracked site.
 */

import type { Pipeline } from 'cloudflare:pipelines';
import type { PanelEventRow } from '@weldsuite/panel-domain/event-row';
import type { PanelIdentityRecord, PanelPersonRecord, PanelReplayChunkRecord } from '@weldsuite/panel-domain/tables';
import type { PanelProject } from './durable-objects/panel-project';
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
  /** Stream behind `panel.identities_v1`: written by PanelProject on `identify()`. */
  PANEL_IDENTITIES?: Pipeline<PanelIdentityRecord>;
  /** Stream behind `panel.people_v1`: written by PanelProject on a profile change. */
  PANEL_PEOPLE?: Pipeline<PanelPersonRecord>;
  /** Stream behind `panel.replay_chunks_v1`: one row per chunk `POST /r` stores. */
  PANEL_REPLAY_CHUNKS?: Pipeline<PanelReplayChunkRecord>;
  /** One global instance (`idFromName('global')`): the daily salt of the cookieless visitor hash. */
  PANEL_SALT: DurableObjectNamespace<PanelSalt>;
  /** One instance per workspace: events and recordings counted per UTC day. */
  PANEL_USAGE: DurableObjectNamespace<PanelUsage>;
  /**
   * One instance per project, in the EU jurisdiction (`projectObjectStub`):
   * people, identity links, erased ids, the live view. panel-api binds the
   * same class with `script_name` pointing here.
   */
  PANEL_PROJECT?: DurableObjectNamespace<PanelProject>;
  /** Private EU-jurisdiction bucket for recording chunks and heatmap snapshots. */
  PANEL_REPLAYS?: R2Bucket;
  /**
   * panel-api's `PanelApiInternal` entrypoint (service binding, no secret): PanelUsage sends its
   * counts there to be settled against the credit wallet. Without it counts are kept, never settled.
   */
  PANEL_API?: Fetcher;
  /** Per-IP limits on the public browser routes, `[[ratelimits]]` in wrangler.toml. */
  EVENTS_RATE_LIMIT?: RateLimit;
  REPLAYS_RATE_LIMIT?: RateLimit;
  SNAPSHOTS_RATE_LIMIT?: RateLimit;
}
