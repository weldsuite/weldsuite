import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import type { KitEnv, KitVariables } from '@weldsuite/worker-kit';
import type { PanelProjectNamespace } from '@weldsuite/panel-domain/project-object';

/**
 * panel-api bindings: the kit's (auth, tenant DB, flags) plus only what
 * the panel module uses. Add a binding here and in wrangler.toml together.
 */
export interface Env extends KitEnv {
  /**
   * Public collector origin for this environment (panel-ingest), without a
   * trailing slash: what the install snippet points tracked sites at.
   */
  PANEL_COLLECTOR_URL: string;
  /** Basin bucket that holds the `panel.*` Iceberg tables (`weldsuite-panel`, `-test` for test). */
  PANEL_BASIN_BUCKET?: string;
  /** Read-only Basin SQL token (secret). Queries answer 503 when it, CF_ACCOUNT_ID or the bucket is missing. */
  R2_SQL_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /**
   * The PanelProject Durable Object, hosted by panel-ingest (`script_name`).
   * Always reach it through `projectObjectStub` (EU jurisdiction). Queries
   * need it for the erased ids and the identity-join flag, so without it they answer 503.
   */
  PANEL_PROJECT?: PanelProjectNamespace;
  /**
   * Private EU bucket with recording chunks and heatmap snapshots (ADR PANEL-005),
   * the same bucket panel-ingest writes. Without it recordings and heatmap
   * backgrounds are off: the routes answer 404 / "no recording", erasure skips R2.
   */
  PANEL_REPLAYS?: R2Bucket;
  /** Producer for the maintenance worker's queue: erasure messages (Iceberg rewrite). Missing = warn and carry on. */
  PANEL_MAINTENANCE?: Queue<PanelMaintenanceMessage>;
  /** @weldsuite/ai (session summaries): account and gateway token (secrets). */
  AI_GATEWAY_API_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CF_AI_GATEWAY?: string;
  AI_GATEWAY_PROVIDER?: string;
  /** Entity-events hub queue (publishEntityEvent). */
  ENTITY_EVENTS?: Queue<EntityEventMessage>;
  /** realtime-worker service binding for live WorkspaceHub fan-out. */
  REALTIME?: Fetcher;
  /** Sent as x-internal-secret on every realtime-worker /publish/* call. */
  REALTIME_INTERNAL_SECRET?: string;
  /** Cloudflare Email Service binding: the usage notices to workspace owners. Without it no mail is sent. */
  SEND_EMAIL?: SendEmail;
  /** Platform origin the emails link to (default https://app.weldsuite.org). */
  PLATFORM_URL?: string;
}

/** What panel-api sends the maintenance worker. */
export type PanelMaintenanceMessage = { type: 'erase'; workspaceId: string; projectId: string; ids: string[] };

export type Variables = KitVariables;
