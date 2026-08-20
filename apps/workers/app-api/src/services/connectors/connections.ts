/**
 * Connector connection lifecycle — the tenant-facing half of the first-party
 * connector layer.
 *
 * Credentials are stored encrypted on the row. The provider client
 * (WooCommerce / Shopify) is constructed from the decrypted pair at sync/test time.
 *
 * Imported rows and their `integration_entity_mappings` survive disconnect:
 * removing a connector must never delete the customer's data, and keeping the
 * mappings means a later reconnect updates those rows instead of duplicating.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { encryptField, maybeDecryptField, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { getConnector } from '@weldsuite/connectors';
import type { ConnectorSyncRunStatus, ConnectorSyncTrigger, ConnectorWebhookRegistration } from '@weldsuite/db/schema';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

export type ConnectorConnectionRow = typeof schema.connectorConnections.$inferSelect;

export function keyringFromEnv(env: {
  DATABASE_ENCRYPTION_KEY?: string;
  DATABASE_ENCRYPTION_KEY_V2?: string;
}): EncryptionKeyring {
  return { v1: env.DATABASE_ENCRYPTION_KEY, v2: env.DATABASE_ENCRYPTION_KEY_V2 };
}

export async function encryptCredentials(
  credentials: Record<string, string>,
  keyring: EncryptionKeyring,
): Promise<Record<string, string>> {
  const encrypted: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (!value) continue;
    encrypted[key] = keyring.v1 || keyring.v2 ? await encryptField(value, keyring) : value;
  }
  return encrypted;
}

export async function decryptCredentials(
  credentials: Record<string, string> | null | undefined,
  keyring: EncryptionKeyring,
): Promise<Record<string, string>> {
  if (!credentials) return {};
  const decrypted: Record<string, string> = {};
  for (const [key, value] of Object.entries(credentials)) {
    if (!value) continue;
    decrypted[key] = await maybeDecryptField(value, keyring);
  }
  return decrypted;
}

export async function encryptWebhookSecret(secret: string, keyring: EncryptionKeyring): Promise<string> {
  return keyring.v1 || keyring.v2 ? encryptField(secret, keyring) : secret;
}

export async function maybeDecryptWebhookSecret(
  secret: string | null | undefined,
  keyring: EncryptionKeyring,
): Promise<string | null> {
  if (!secret) return null;
  return maybeDecryptField(secret, keyring);
}

/**
 * The connection as the client may see it.
 *
 * Explicitly allow-listed rather than spread-and-delete: a column added later
 * cannot leak by default, which matters on a table that holds credentials.
 */
export function sanitizeConnection(row: ConnectorConnectionRow) {
  const connector = getConnector(row.provider);
  return {
    id: row.id,
    provider: row.provider,
    label: connector?.label ?? row.provider,
    icon: connector?.icon ?? 'plug',
    category: connector?.category ?? 'ecommerce',
    displayName: row.displayName,
    status: row.status,
    externalAccountId: row.externalAccountId,
    enabledSyncs: row.enabledSyncs ?? connector?.syncs.map((s) => s.settingKey) ?? [],
    authFields: connector?.auth.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      placeholder: f.placeholder,
      required: f.required ?? true,
    })) ?? [],
    syncs: (connector?.syncs ?? []).map((s) => ({
      syncName: s.syncName,
      model: s.model,
      internalEntity: s.internalEntity,
      settingKey: s.settingKey,
    })),
    lastSyncAt: row.lastSyncAt,
    lastSyncStatus: row.lastSyncStatus,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    recordsSynced: row.recordsSynced,
    connectedAt: row.connectedAt,
    connectedBy: row.connectedBy,
    isConnected: row.status !== 'pending' && !row.deletedAt,
    webhookCount: row.webhookRegistrations?.length ?? 0,
  };
}

export async function findConnectionByProviderAccount(
  db: Database,
  provider: string,
  externalAccountId: string,
): Promise<ConnectorConnectionRow | null> {
  const [row] = await db
    .select()
    .from(schema.connectorConnections)
    .where(
      and(
        eq(schema.connectorConnections.provider, provider),
        eq(schema.connectorConnections.externalAccountId, externalAccountId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listConnectionsByProvider(
  db: Database,
  provider: string,
): Promise<ConnectorConnectionRow[]> {
  return db
    .select()
    .from(schema.connectorConnections)
    .where(
      and(eq(schema.connectorConnections.provider, provider), isNull(schema.connectorConnections.deletedAt)),
    )
    .orderBy(desc(schema.connectorConnections.createdAt));
}

export async function getConnectionById(
  db: Database,
  id: string,
): Promise<ConnectorConnectionRow | null> {
  const [row] = await db
    .select()
    .from(schema.connectorConnections)
    .where(and(eq(schema.connectorConnections.id, id), isNull(schema.connectorConnections.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function listConnections(db: Database): Promise<ConnectorConnectionRow[]> {
  return db
    .select()
    .from(schema.connectorConnections)
    .where(isNull(schema.connectorConnections.deletedAt))
    .orderBy(desc(schema.connectorConnections.createdAt));
}

export async function upsertConnection(args: {
  db: Database;
  provider: string;
  displayName: string;
  userId: string;
  credentials: Record<string, string>;
  enabledSyncs: string[];
  externalAccountId: string | null;
  webhookSecret?: string | null;
}): Promise<ConnectorConnectionRow> {
  const now = new Date();
  const existing = args.externalAccountId
    ? await findConnectionByProviderAccount(args.db, args.provider, args.externalAccountId)
    : null;

  if (existing) {
    await args.db
      .update(schema.connectorConnections)
      .set({
        displayName: args.displayName,
        credentials: args.credentials,
        enabledSyncs: args.enabledSyncs,
        externalAccountId: args.externalAccountId,
        webhookSecret: args.webhookSecret ?? existing.webhookSecret,
        status: 'active',
        deletedAt: null,
        disconnectedAt: null,
        lastError: null,
        lastErrorAt: null,
        connectedAt: now,
        connectedBy: args.userId,
        updatedAt: now,
      })
      .where(eq(schema.connectorConnections.id, existing.id));
    const updated = await getConnectionById(args.db, existing.id);
    return updated!;
  }

  const id = generateId('conn');
  await args.db.insert(schema.connectorConnections).values({
    id,
    provider: args.provider,
    displayName: args.displayName,
    credentials: args.credentials,
    enabledSyncs: args.enabledSyncs,
    externalAccountId: args.externalAccountId,
    webhookSecret: args.webhookSecret ?? null,
    status: 'active',
    connectedAt: now,
    connectedBy: args.userId,
  });
  const created = await getConnectionById(args.db, id);
  return created!;
}

export async function updateConnectionSettings(args: {
  db: Database;
  connectionId: string;
  enabledSyncs?: string[];
  credentials?: Record<string, string>;
  displayName?: string;
  externalAccountId?: string | null;
  webhookSecret?: string | null;
  webhookRegistrations?: ConnectorWebhookRegistration[] | null;
}): Promise<void> {
  const now = new Date();
  await args.db
    .update(schema.connectorConnections)
    .set({
      ...(args.enabledSyncs ? { enabledSyncs: args.enabledSyncs } : {}),
      ...(args.credentials ? { credentials: args.credentials } : {}),
      ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
      ...(args.externalAccountId !== undefined ? { externalAccountId: args.externalAccountId } : {}),
      ...(args.webhookSecret !== undefined ? { webhookSecret: args.webhookSecret } : {}),
      ...(args.webhookRegistrations !== undefined ? { webhookRegistrations: args.webhookRegistrations } : {}),
      lastError: null,
      lastErrorAt: null,
      status: 'active',
      updatedAt: now,
    })
    .where(eq(schema.connectorConnections.id, args.connectionId));
}

export async function markConnectionError(args: {
  db: Database;
  connectionId: string;
  status: 'auth_error' | 'sync_error';
  message: string;
}): Promise<void> {
  const now = new Date();
  await args.db
    .update(schema.connectorConnections)
    .set({
      status: args.status,
      lastError: args.message.slice(0, 2000),
      lastErrorAt: now,
      updatedAt: now,
    })
    .where(eq(schema.connectorConnections.id, args.connectionId));
}

export async function markConnectionDisconnected(db: Database, connectionId: string): Promise<void> {
  const now = new Date();
  await db
    .update(schema.connectorConnections)
    .set({
      deletedAt: now,
      disconnectedAt: now,
      status: 'paused',
      credentials: null,
      webhookSecret: null,
      webhookRegistrations: null,
      updatedAt: now,
    })
    .where(eq(schema.connectorConnections.id, connectionId));
  await db
    .update(schema.productSalesChannels)
    .set({ status: 'disconnected', updatedAt: now })
    .where(eq(schema.productSalesChannels.connectionId, connectionId));
}

export async function startSyncRun(args: {
  db: Database;
  connectionId: string;
  syncName: string;
  model: string;
  trigger: ConnectorSyncTrigger;
  syncType?: string | null;
}): Promise<string> {
  const id = generateId('crun');
  await args.db.insert(schema.connectorSyncRuns).values({
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
  status: ConnectorSyncRunStatus;
  reported?: { added?: number; updated?: number; deleted?: number };
  applied?: { created: number; modified: number; skipped: number; deleted: number; failed: number };
  error?: string | null;
  errorSamples?: Array<{ externalId: string; message: string }>;
  watermark?: { model: string; at: string } | null;
}): Promise<void> {
  const now = new Date();
  const [run] = await args.db
    .select({ startedAt: schema.connectorSyncRuns.startedAt })
    .from(schema.connectorSyncRuns)
    .where(eq(schema.connectorSyncRuns.id, args.runId))
    .limit(1);

  await args.db
    .update(schema.connectorSyncRuns)
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
    .where(eq(schema.connectorSyncRuns.id, args.runId));

  const applied = (args.applied?.created ?? 0) + (args.applied?.modified ?? 0);
  const [connection] = await args.db
    .select({ status: schema.connectorConnections.status })
    .from(schema.connectorConnections)
    .where(eq(schema.connectorConnections.id, args.connectionId))
    .limit(1);

  const advanceWatermark = args.watermark && args.status === 'success';

  await args.db
    .update(schema.connectorConnections)
    .set({
      lastSyncAt: now,
      lastSyncStatus: args.status,
      lastError: args.error ? args.error.slice(0, 2000) : null,
      lastErrorAt: args.error ? now : null,
      recordsSynced: sql`${schema.connectorConnections.recordsSynced} + ${applied}`,
      ...(advanceWatermark
        ? {
            syncWatermarks: sql`COALESCE(${schema.connectorConnections.syncWatermarks}, '{}'::jsonb) || ${JSON.stringify(
              { [args.watermark!.model]: args.watermark!.at },
            )}::jsonb`,
          }
        : {}),
      status:
        connection?.status === 'auth_error'
          ? 'auth_error'
          : args.status === 'error'
            ? 'sync_error'
            : connection?.status === 'paused'
              ? 'paused'
              : 'active',
      updatedAt: now,
    })
    .where(eq(schema.connectorConnections.id, args.connectionId));
}

export async function listSyncRuns(
  db: Database,
  connectionId: string,
  limit = 25,
): Promise<Array<typeof schema.connectorSyncRuns.$inferSelect>> {
  return db
    .select()
    .from(schema.connectorSyncRuns)
    .where(eq(schema.connectorSyncRuns.connectionId, connectionId))
    .orderBy(desc(schema.connectorSyncRuns.createdAt))
    .limit(Math.min(limit, 100));
}
