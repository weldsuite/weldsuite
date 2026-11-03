/**
 * The rooms this service hosts: the workers' own classes, unchanged.
 *
 *   DOC_ROOM    DocRoom   (apps/workers/docs-api/src/room/doc-room.ts)
 *   DOC_ENGINE  docEngine (apps/workers/docs-api/src/engine-ops.ts)
 *   SHEET_ROOM  SheetRoom (apps/workers/sheets-api/src/room/sheet-room.ts)
 *   SHEET_ENGINE  sheetEngine (apps/workers/sheets-api/src/engine-ops.ts)
 *
 * They are imported by path: the build bundles them with this service's
 * runtime in place of `cloudflare:workers` and Neon (build.mjs).
 */

import { DocRoom } from '../../../workers/docs-api/src/room/doc-room';
import { docEngine } from '../../../workers/docs-api/src/engine-ops';
import { SheetRoom } from '../../../workers/sheets-api/src/room/sheet-room';
import { sheetEngine } from '../../../workers/sheets-api/src/engine-ops';
import { RoomNamespace, type RoomFactory } from './runtime/host';
import { r2Bucket, type ObjectStore } from './runtime/objects';
import { createCollabServer, type CollabServer } from './server';

export interface CollabConfig {
  /** The private bucket (checkpoints, versions, the rooms' own storage). */
  privateStore: ObjectStore;
  /** The public bucket, read for imports of old drive files (optional). */
  publicStore?: ObjectStore;
  /** Where the rooms' entity events go: the Rust server's `/internal/collab/events`. */
  eventsUrl?: string;
  secret?: string;
  /** The master database and the keyring for workspace URLs (rooms record checkpoints). */
  database: { masterUrl?: string; encryptionKey?: string; encryptionKeyV2?: string; tenantPoolMax?: string };
  owns?: (id: string) => boolean;
  idleMs?: number;
  sweepMs?: number;
  environment?: string;
}

/** The `ENTITY_EVENTS` queue binding: each message goes to the Rust server's bus. */
function eventQueue(url: string | undefined, secret: string | undefined) {
  const send = async (message: unknown) => {
    if (!url) return;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { 'x-internal-secret': secret } : {}) },
      body: JSON.stringify(message),
    });
    if (!res.ok) throw new Error(`publishing an entity event answered ${res.status}`);
  };
  return {
    send,
    sendBatch: async (messages: { body: unknown }[]) => {
      for (const message of messages) await send(message.body);
    },
  };
}

export function roomEnv(config: CollabConfig): Record<string, unknown> {
  return {
    PRIVATE_STORAGE: r2Bucket(config.privateStore),
    STORAGE: config.publicStore ? r2Bucket(config.publicStore) : undefined,
    ENTITY_EVENTS: eventQueue(config.eventsUrl, config.secret),
    DATABASE_URL_MASTER: config.database.masterUrl,
    DATABASE_ENCRYPTION_KEY: config.database.encryptionKey,
    DATABASE_ENCRYPTION_KEY_V2: config.database.encryptionKeyV2,
    TENANT_POOL_MAX_CONNECTIONS: config.database.tenantPoolMax,
    ENVIRONMENT: config.environment ?? 'production',
  };
}

export function createCollabApp(config: CollabConfig): CollabServer {
  const env = roomEnv(config);
  const namespace = (binding: string, factory: RoomFactory) =>
    new RoomNamespace({ binding, factory, env, store: config.privateStore, idleMs: config.idleMs });
  const rooms = {
    DOC_ROOM: namespace('DOC_ROOM', (ctx, roomEnv) => new DocRoom(ctx as DurableObjectState, roomEnv as never)),
    SHEET_ROOM: namespace('SHEET_ROOM', (ctx, roomEnv) => new SheetRoom(ctx as DurableObjectState, roomEnv as never)),
  };
  return createCollabServer({
    rooms,
    engines: { DOC_ENGINE: docEngine, SHEET_ENGINE: sheetEngine },
    connectPaths: { '/api/docs/connect': 'DOC_ROOM', '/api/sheets/connect': 'SHEET_ROOM' },
    secret: config.secret,
    owns: config.owns,
    sweepMs: config.sweepMs,
  });
}
