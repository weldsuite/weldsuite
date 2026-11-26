/**
 * The rooms this service hosts: the same classes the workers run as Durable
 * Objects, from the modules' domain packages. A room is abstract over its
 * tenant database, so each is subclassed here to open CloudNativePG through
 * ./runtime/tenant-db (the workers open Neon through worker-kit).
 *
 *   DOC_ROOM    DocRoom   (@weldsuite/docs-domain/room/doc-room)
 *   DOC_ENGINE  docEngine (@weldsuite/docs-domain/engine-ops)
 *   SHEET_ROOM  SheetRoom (@weldsuite/sheets-domain/room/sheet-room)
 *   SHEET_ENGINE  sheetEngineFor(tenantDb) (@weldsuite/sheets-domain/engine-ops)
 *   BOARD_ROOM  BoardRoom (@weldsuite/board-domain/room/board-room)
 *   BOARD_ENGINE  boardEngine (@weldsuite/board-domain/engine-ops)
 *
 * The build bundles them with this service's runtime in place of
 * `cloudflare:workers`, and refuses worker-kit, which goes with the workers
 * (build.mjs).
 */

import { DocRoom, type DocRoomEnv } from '@weldsuite/docs-domain/room/doc-room';
import { docEngine } from '@weldsuite/docs-domain/engine-ops';
import { SheetRoom, type SheetRoomEnv } from '@weldsuite/sheets-domain/room/sheet-room';
import { sheetEngineFor } from '@weldsuite/sheets-domain/engine-ops';
import { BoardRoom, type BoardRoomEnv } from '@weldsuite/board-domain/room/board-room';
import { boardEngine } from '@weldsuite/board-domain/engine-ops';
import { RoomNamespace, type RoomFactory } from './runtime/host';
import { r2Bucket, type ObjectStore } from './runtime/objects';
import { getTenantDbForWorkspace, type DbEnv } from './runtime/tenant-db';
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

class NodeDocRoom extends DocRoom<DocRoomEnv & DbEnv> {
  protected tenantDb(workspaceId: string) {
    return getTenantDbForWorkspace(this.env, workspaceId);
  }
}

class NodeSheetRoom extends SheetRoom<SheetRoomEnv & DbEnv> {
  protected tenantDb(workspaceId: string) {
    return getTenantDbForWorkspace(this.env, workspaceId);
  }
}

class NodeBoardRoom extends BoardRoom<BoardRoomEnv & DbEnv> {
  protected tenantDb(workspaceId: string) {
    return getTenantDbForWorkspace(this.env, workspaceId);
  }
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
    DOC_ROOM: namespace('DOC_ROOM', (ctx, roomEnv) => new NodeDocRoom(ctx as DurableObjectState, roomEnv as never)),
    SHEET_ROOM: namespace('SHEET_ROOM', (ctx, roomEnv) => new NodeSheetRoom(ctx as DurableObjectState, roomEnv as never)),
    BOARD_ROOM: namespace('BOARD_ROOM', (ctx, roomEnv) => new NodeBoardRoom(ctx as DurableObjectState, roomEnv as never)),
  };
  return createCollabServer({
    rooms,
    engines: { DOC_ENGINE: docEngine, SHEET_ENGINE: sheetEngineFor((workspaceId) => getTenantDbForWorkspace(env as DbEnv, workspaceId)), BOARD_ENGINE: boardEngine },
    connectPaths: { '/api/docs/connect': 'DOC_ROOM', '/api/sheets/connect': 'SHEET_ROOM', '/api/boards/connect': 'BOARD_ROOM' },
    secret: config.secret,
    owns: config.owns,
    sweepMs: config.sweepMs,
  });
}
