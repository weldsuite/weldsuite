/**
 * The writes behind `POST /r` and `POST /snap`, run in `waitUntil` after the
 * 204: the chunk to the EU replays bucket, its row to `replay_chunks_v1`, and
 * (for a session's first chunk) the recording to PanelUsage.
 */

import type { PanelProjectRecord } from '@weldsuite/panel-domain/registry';
import { replayChunkKey } from '@weldsuite/panel-domain/replays';
import type { PanelReplayChunkRecord } from '@weldsuite/panel-domain/tables';
import type { Env } from '../env';
import { utcDate } from './time';
import { warnOnce } from './warn';

export interface ChunkParams {
  sessionId: string;
  seq: number;
  /** Chunk start and end, ms since the epoch, already inside a believable window. */
  tsStart: number;
  tsEnd: number;
  hasFullSnapshot: boolean;
  receivedAt: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const BLOB_METADATA = { httpMetadata: { contentType: 'application/gzip' } } as const;

/** Stores one chunk. Failures are logged with ids only, never thrown into the runtime. */
export async function storeChunk(env: Env, project: PanelProjectRecord, params: ChunkParams, bytes: Uint8Array): Promise<void> {
  const bucket = env.PANEL_REPLAYS;
  if (!bucket) return;

  const key = replayChunkKey({
    tier: project.replayTier ?? '30d',
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    // The chunk's own start day: a session that runs past midnight keeps its later chunks under the new day, and
    // `replay_chunks_v1.r2_key` is what finds them.
    day: utcDate(params.tsStart),
    sessionId: params.sessionId,
    seq: params.seq,
  });

  try {
    await bucket.put(key, bytes, BLOB_METADATA);
  } catch (error) {
    console.error(`[panel-ingest] Recording chunk write failed for project ${project.projectId}: ${messageOf(error)}`);
    return;
  }

  const row: PanelReplayChunkRecord = {
    workspace_id: project.workspaceId,
    project_id: project.projectId,
    session_id: params.sessionId,
    seq: params.seq,
    ts_start: new Date(params.tsStart).toISOString(),
    ts_end: new Date(params.tsEnd).toISOString(),
    bytes: bytes.byteLength,
    has_full_snapshot: params.hasFullSnapshot,
    r2_key: key,
  };

  const bookkeeping = await Promise.allSettled([
    (async () => {
      if (!env.PANEL_REPLAY_CHUNKS) {
        warnOnce('binding:PANEL_REPLAY_CHUNKS', 'PANEL_REPLAY_CHUNKS is not bound: recording chunks are stored but not indexed');
        return;
      }
      await env.PANEL_REPLAY_CHUNKS.send([row]);
    })(),
    // A recording is counted when its first chunk arrives.
    params.seq === 0
      ? env.PANEL_USAGE.get(env.PANEL_USAGE.idFromName(project.workspaceId)).addRecordings(utcDate(params.receivedAt), 1, project.workspaceId)
      : Promise.resolve(),
  ]);
  for (const result of bookkeeping) {
    if (result.status === 'rejected') {
      console.error(`[panel-ingest] Recording index or count failed for project ${project.projectId}: ${messageOf(result.reason)}`);
    }
  }
}

/** Stores a heatmap snapshot (overwriting the previous one of the page group and device class). */
export async function storeSnapshot(env: Env, key: string, bytes: Uint8Array): Promise<void> {
  if (!env.PANEL_REPLAYS) return;
  await env.PANEL_REPLAYS.put(key, bytes, BLOB_METADATA);
}
