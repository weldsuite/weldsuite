/**
 * The Basin tables next to `panel.events_v1` (./event-row): identity links,
 * profile snapshots and the recording chunk index (ADR PANEL-002).
 *
 * Each table has its own stream, sink and pipeline (one per table: a pipeline
 * is billed for everything it reads, weldsuite-documentation/plans/weldpanel.md "Basin tables").
 * The stream schema files next to this one are what the streams were created
 * with; `tables.test.ts` keeps them and the row types in step. A pipeline
 * cannot be changed after creation and drops rows that do not match its
 * schema silently, so a column change means a `_v2` stream, sink, pipeline
 * and table.
 *
 * Writers:
 * - `identities_v1` and `people_v1`: the PanelProject Durable Object in
 *   panel-ingest (./project-object), whenever a link or a profile changes.
 * - `replay_chunks_v1`: panel-ingest's `POST /r`, one row per chunk stored in
 *   the EU replays bucket (./replays).
 */

/** Basin namespace and table names, per environment the bucket differs, not the names. */
export const PANEL_BASIN_NAMESPACE = 'panel';
export const PANEL_TABLES = {
  events: 'events_v1',
  identities: 'identities_v1',
  people: 'people_v1',
  replayChunks: 'replay_chunks_v1',
} as const;

/** `identities_v1`: one row per anonymous id → user id link, written on `identify()`. */
export interface PanelIdentityRow {
  workspace_id: string;
  project_id: string;
  anon_id: string;
  user_id: string;
  /** When the link was made, ISO 8601. */
  ts: string;
}

/**
 * `people_v1`: one row per profile change, so reports can filter and break
 * down by user properties. The current profile is the highest `version` per
 * `user_id`; `deleted` marks an erased or removed profile.
 */
export interface PanelPersonRow {
  workspace_id: string;
  project_id: string;
  user_id: string;
  /** Increases with every change to this profile (the Durable Object's counter). */
  version: number;
  ts: string;
  /** The whole profile after the change, JSON object as a string (`$email`, `$name` and custom keys). */
  properties: string;
  deleted: boolean;
}

/** `replay_chunks_v1`: one row per recording chunk stored in R2. */
export interface PanelReplayChunkRow {
  workspace_id: string;
  project_id: string;
  session_id: string;
  /** 0-based, per session. */
  seq: number;
  ts_start: string;
  ts_end: string;
  /** Compressed size in R2. */
  bytes: number;
  /** The chunk starts with an rrweb full snapshot, so playback (or a heatmap background) can start here. */
  has_full_snapshot: boolean;
  /** Object key in the replays bucket (./replays). */
  r2_key: string;
}

/** `Pipeline<T>` wants an index-signature type; an interface has none. */
export type PanelIdentityRecord = { [K in keyof PanelIdentityRow]: PanelIdentityRow[K] };
export type PanelPersonRecord = { [K in keyof PanelPersonRow]: PanelPersonRow[K] };
export type PanelReplayChunkRecord = { [K in keyof PanelReplayChunkRow]: PanelReplayChunkRow[K] };
