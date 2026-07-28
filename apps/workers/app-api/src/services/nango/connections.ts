/**
 * Nango connection lifecycle — the tenant-facing half of the connector layer.
 *
 * Responsibilities split as follows:
 *   - Nango owns credentials, refresh and the provider API calls.
 *   - This file owns the WeldSuite-side row: which workspace a connection
 *     belongs to, its health, and the audit trail of its sync runs.
 *
 * Workspace resolution deserves a note. Sync webhooks carry only
 * `(providerConfigKey, connectionId)` — no tenant. We therefore record a KV
 * mapping the moment a connection becomes real (auth webhook, or the client
 * finalising a connect), and the public webhook route resolves the tenant
 * through it. The mapping is written, never read, on the authenticated paths,
 * so a missing entry can always be repaired by reconnecting.
 */

import { and, desc, eq, isNull } from 'drizzle-orm';
import { NangoClient, createNangoClient, getConnector } from '@weldsuite/nango';
import type { NangoSyncRunStatus, NangoSyncTrigger } from '@weldsuite/db/schema';
import type { Env } from '../../types';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

/** KV key mapping a Nango connection to the workspace that owns it. */
function workspaceKey(providerConfigKey: string, nangoConnectionId: string): string {
  return `nango:conn:${providerConfigKey}:${nangoConnectionId}`;
}

/** 400 days — comfortably longer than any connection's useful life. */
const WORKSPACE_MAPPING_TTL_SECONDS = 400 * 24 * 60 * 60;

// ============================================================================
// Client
// ============================================================================

/** Nango client for this worker, or null when Nango is not configured. */
export function getNangoClient(env: Env): NangoClient | null {
  return createNangoClient(env as unknown as { NANGO_SECRET_KEY?: string });
}

// ============================================================================
// Workspace mapping
// ============================================================================

export async function rememberConnectionWorkspace(
  env: Env,
  providerConfigKey: string,
  nangoConnectionId: string,
  clerkOrgId: string,
): Promise<void> {
  await env.WORKSPACE_CACHE.put(workspaceKey(providerConfigKey, nangoConnectionId), clerkOrgId, {
    expirationTtl: WORKSPACE_MAPPING_TTL_SECONDS,
  });
}

export async function resolveConnectionWorkspace(
  env: Env,
  providerConfigKey: string,
  nangoConnectionId: string,
): Promise<string | null> {
  return env.WORKSPACE_CACHE.get(workspaceKey(providerConfigKey, nangoConnectionId));
}

export async function forgetConnectionWorkspace(
  env: Env,
  providerConfigKey: string,
  nangoConnectionId: string,
): Promise<void> {
  await env.WORKSPACE_CACHE.delete(workspaceKey(providerConfigKey, nangoConnectionId));
}

// ============================================================================
// Connection rows
// ============================================================================

export type NangoConnectionRow = typeof schema.nangoConnections.$inferSelect;

/**
 * The connection as the client may see it.
 *
 * Explicitly allow-listed rather than spread-and-delete: a column added later
 * cannot leak by default, which matters on a table that sits next to
 * credentials.
 */
export function sanitizeConnection(row: NangoConnectionRow) {
  const connector = getConnector(row.providerConfigKey);
  return {
    id: row.id,
    providerConfigKey: row.providerConfigKey,
    provider: row.provider,
    label: connector?.label ?? row.provider,
    icon: connector?.icon ?? 'plug',
    category: connector?.category ?? 'crm',
    displayName: row.displayName,
    status: row.status,
    scopes: row.scopes ?? [],
    externalAccountId: row.externalAccountId,
    enabledSyncs: row.enabledSyncs ?? connector?.syncs.map((s) => s.syncName) ?? [],
    lastSyncAt: row.lastSyncAt,
    lastSyncStatus: row.lastSyncStatus,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    recordsSynced: row.recordsSynced,
    connectedAt: row.connectedAt,
    connectedBy: row.connectedBy,
    /** True once Nango holds credentials for this connection. */
    isConnected: row.status !== 'pending' && Boolean(row.nangoConnectionId),
  };
}

/** Live (non-deleted) connection for an integration, if the tenant has one. */
export async function findConnectionByProvider(
  db: Database,
  providerConfigKey: string,
): Promise<NangoConnectionRow | null> {
  const [row] = await db
    .select()
    .from(schema.nangoConnections)
    .where(
      and(
        eq(schema.nangoConnections.providerConfigKey, providerConfigKey),
        isNull(schema.nangoConnections.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Resolve the local row a Nango webhook refers to. */
export async function findConnectionByNangoId(
  db: Database,
  providerConfigKey: string,
  nangoConnectionId: string,
): Promise<NangoConnectionRow | null> {
  const [row] = await db
    .select()
    .from(schema.nangoConnections)
    .where(
      and(
        eq(schema.nangoConnections.providerConfigKey, providerConfigKey),
        eq(schema.nangoConnections.nangoConnectionId, nangoConnectionId),
        isNull(schema.nangoConnections.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listConnections(db: Database): Promise<NangoConnectionRow[]> {
  return db
    .select()
    .from(schema.nangoConnections)
    .where(isNull(schema.nangoConnections.deletedAt))
    .orderBy(desc(schema.nangoConnections.createdAt));
}

/**
 * Create (or revive) the pending row for a connect attempt.
 *
 * Reconnecting reuses the existing row so every `integration_entity_mappings`
 * row that points at it stays valid — otherwise a reauth would re-import every
 * record as a duplicate.
 */
export async function upsertPendingConnection(args: {
  db: Database;
  providerConfigKey: string;
  provider: string;
  displayName: string;
  userId: string;
}): Promise<NangoConnectionRow> {
  const existing = await findConnectionByProvider(args.db, args.providerConfigKey);
  if (existing) return existing;

  // A previously disconnected row is soft-deleted; revive it rather than
  // inserting a second row for the same integration (unique index).
  const [softDeleted] = await args.db
    .select()
    .from(schema.nangoConnections)
    .where(eq(schema.nangoConnections.providerConfigKey, args.providerConfigKey))
    .limit(1);

  if (softDeleted) {
    const [revived] = await args.db
      .update(schema.nangoConnections)
      .set({
        deletedAt: null,
        status: 'pending',
        displayName: args.displayName,
        lastError: null,
        lastErrorAt: null,
        disconnectedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.nangoConnections.id, softDeleted.id))
      .returning();
    return revived!;
  }

  const [created] = await args.db
    .insert(schema.nangoConnections)
    .values({
      id: generateId('nconn'),
      providerConfigKey: args.providerConfigKey,
      provider: args.provider,
      displayName: args.displayName,
      status: 'pending',
      connectedBy: args.userId,
    })
    .returning();
  return created!;
}

/** Mark a connection live after Nango confirms the authorisation. */
export async function markConnectionActive(args: {
  db: Database;
  connectionId: string;
  nangoConnectionId: string;
  scopes?: string[];
  externalAccountId?: string | null;
}): Promise<void> {
  await args.db
    .update(schema.nangoConnections)
    .set({
      nangoConnectionId: args.nangoConnectionId,
      status: 'active',
      scopes: args.scopes,
      externalAccountId: args.externalAccountId ?? undefined,
      connectedAt: new Date(),
      lastError: null,
      lastErrorAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.nangoConnections.id, args.connectionId));
}

/** Record a connection-level failure so the UI can surface it without the DB. */
export async function markConnectionError(args: {
  db: Database;
  connectionId: string;
  status: 'auth_error' | 'sync_error';
  message: string;
}): Promise<void> {
  await args.db
    .update(schema.nangoConnections)
    .set({
      status: args.status,
      lastError: args.message.slice(0, 2000),
      lastErrorAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.nangoConnections.id, args.connectionId));
}

/** Soft-delete the local row. Deleting inside Nango is the caller's job. */
export async function markConnectionDisconnected(db: Database, connectionId: string): Promise<void> {
  const now = new Date();
  await db
    .update(schema.nangoConnections)
    .set({ deletedAt: now, disconnectedAt: now, status: 'paused', updatedAt: now })
    .where(eq(schema.nangoConnections.id, connectionId));
}

// ============================================================================
// Sync runs — the observability trail
// ============================================================================

export async function startSyncRun(args: {
  db: Database;
  connectionId: string;
  syncName: string;
  model: string;
  trigger: NangoSyncTrigger;
  syncType?: string | null;
}): Promise<string> {
  const id = generateId('nrun');
  await args.db.insert(schema.nangoSyncRuns).values({
    id,
    connectionId: args.connectionId,
    syncName: args.syncName,
    model: args.model,
    status: 'running',
    trigger: args.trigger,
    syncType: args.syncType ?? undefined,
    startedAt: new Date(),
  });
  return id;
}

export async function finishSyncRun(args: {
  db: Database;
  runId: string;
  connectionId: string;
  status: NangoSyncRunStatus;
  reported?: { added?: number; updated?: number; deleted?: number };
  applied?: { created: number; modified: number; skipped: number; deleted: number; failed: number };
  error?: string | null;
  errorSamples?: Array<{ externalId: string; message: string }>;
  /** Watermark to advance for this model, when the run succeeded. */
  watermark?: { model: string; at: string } | null;
}): Promise<void> {
  const now = new Date();
  const [run] = await args.db
    .select({ startedAt: schema.nangoSyncRuns.startedAt })
    .from(schema.nangoSyncRuns)
    .where(eq(schema.nangoSyncRuns.id, args.runId))
    .limit(1);

  await args.db
    .update(schema.nangoSyncRuns)
    .set({
      status: args.status,
      recordsAdded: args.reported?.added ?? 0,
      recordsUpdated: args.reported?.updated ?? 0,
      recordsDeleted: args.reported?.deleted ?? 0,
      recordsCreated: args.applied?.created ?? 0,
      recordsModified: args.applied?.modified ?? 0,
      recordsSkipped: args.applied?.skipped ?? 0,
      recordsFailed: args.applied?.failed ?? 0,
      finishedAt: now,
      durationMs: run?.startedAt ? now.getTime() - new Date(run.startedAt).getTime() : null,
      error: args.error ? args.error.slice(0, 2000) : null,
      errorSamples: args.errorSamples?.length ? args.errorSamples : null,
    })
    .where(eq(schema.nangoSyncRuns.id, args.runId));

  const applied = (args.applied?.created ?? 0) + (args.applied?.modified ?? 0);
  const [connection] = await args.db
    .select({
      recordsSynced: schema.nangoConnections.recordsSynced,
      syncWatermarks: schema.nangoConnections.syncWatermarks,
      status: schema.nangoConnections.status,
    })
    .from(schema.nangoConnections)
    .where(eq(schema.nangoConnections.id, args.connectionId))
    .limit(1);

  const watermarks = { ...(connection?.syncWatermarks ?? {}) };
  if (args.watermark && args.status !== 'error') {
    watermarks[args.watermark.model] = args.watermark.at;
  }

  await args.db
    .update(schema.nangoConnections)
    .set({
      lastSyncAt: now,
      lastSyncStatus: args.status,
      lastError: args.error ? args.error.slice(0, 2000) : null,
      lastErrorAt: args.error ? now : null,
      recordsSynced: (connection?.recordsSynced ?? 0) + applied,
      syncWatermarks: watermarks,
      // A failing sync must not silently downgrade an auth error — the tenant
      // still needs to reconnect in that case.
      status:
        connection?.status === 'auth_error'
          ? 'auth_error'
          : args.status === 'error'
            ? 'sync_error'
            : 'active',
      updatedAt: now,
    })
    .where(eq(schema.nangoConnections.id, args.connectionId));
}

export async function listSyncRuns(
  db: Database,
  connectionId: string,
  limit = 25,
): Promise<Array<typeof schema.nangoSyncRuns.$inferSelect>> {
  return db
    .select()
    .from(schema.nangoSyncRuns)
    .where(eq(schema.nangoSyncRuns.connectionId, connectionId))
    .orderBy(desc(schema.nangoSyncRuns.createdAt))
    .limit(Math.min(limit, 100));
}
