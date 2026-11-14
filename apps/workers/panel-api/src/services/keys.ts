/**
 * Secret keys (`wps_` + 32 hex) for server-side ingest and imports.
 *
 * The master `panel_key_registry` row is the source of truth and holds only the
 * SHA-256 of the key; the collector reads KV `panel:key:<hash>` (written here,
 * deleted on revoke) so it never opens a database. The whole key is shown once,
 * in the response that creates it.
 *
 * Each KV record also carries the project's status: a paused project must stop
 * `/v1/*` too, so pausing, resuming or deleting a project rewrites its keys'
 * records (`syncKeyRecords`, called from ./projects).
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { masterSchema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelProject } from '@weldsuite/db/schema';
import type { PanelKeyDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { keyKvKey, type PanelKeyRecord } from '@weldsuite/panel-domain/registry';
import type { ProjectRegistry } from './project-registry';

const { panelKeyRegistry } = masterSchema;

/** A row of the master `panel_key_registry`. */
export type PanelKey = typeof panelKeyRegistry.$inferSelect;

/** Keys a project may hold at once (revoked ones do not count). */
export const MAX_ACTIVE_KEYS = 20;

/** `wps_` and the first four hex digits: what the UI shows to tell keys apart. */
const PREFIX_LENGTH = 8;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateSecretKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `wps_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function toKeyDto(row: PanelKey): PanelKeyDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    prefix: `${row.keyPrefix}…`,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/** The payload of a `panel_key` entity event: never the key. */
export function keyEventData(row: PanelKey) {
  return { id: row.id, projectId: row.projectId, name: row.name, prefix: `${row.keyPrefix}…` };
}

function keyRecord(row: Pick<PanelKey, 'id' | 'projectId'>, workspaceId: string, status: PanelProject['status']): PanelKeyRecord {
  return { v: 1, keyId: row.id, workspaceId, projectId: row.projectId, status };
}

/** Every key of the project, oldest first (revoked keys stay listed, greyed out). */
export async function listKeys(registry: ProjectRegistry, projectId: string): Promise<PanelKey[]> {
  return registry.masterDb
    .select()
    .from(panelKeyRegistry)
    .where(and(eq(panelKeyRegistry.workspaceId, registry.workspaceId), eq(panelKeyRegistry.projectId, projectId)))
    .orderBy(asc(panelKeyRegistry.createdAt), asc(panelKeyRegistry.id));
}

async function activeKeys(registry: ProjectRegistry, projectId: string): Promise<PanelKey[]> {
  return registry.masterDb
    .select()
    .from(panelKeyRegistry)
    .where(
      and(
        eq(panelKeyRegistry.workspaceId, registry.workspaceId),
        eq(panelKeyRegistry.projectId, projectId),
        isNull(panelKeyRegistry.revokedAt),
      ),
    );
}

export type CreateKeyResult = { row: PanelKey; key: string } | 'limit';

/**
 * Creates a key. The registry row is written first and the KV record second;
 * when KV fails the row is taken out again, so a key the collector cannot see
 * is never shown to anyone.
 */
export async function createKey(registry: ProjectRegistry, project: PanelProject, name: string, createdByUserId: string): Promise<CreateKeyResult> {
  if ((await activeKeys(registry, project.id)).length >= MAX_ACTIVE_KEYS) return 'limit';

  const key = generateSecretKey();
  const keyHash = await sha256Hex(key);
  const [row] = await registry.masterDb
    .insert(panelKeyRegistry)
    .values({
      id: generateId('pnk'),
      keyHash,
      keyPrefix: key.slice(0, PREFIX_LENGTH),
      name,
      workspaceId: registry.workspaceId,
      projectId: project.id,
      createdByUserId,
    })
    .returning();
  if (!row) throw new Error('panel_key_registry insert returned no row');

  try {
    await registry.kv.put(keyKvKey(keyHash), JSON.stringify(keyRecord(row, registry.workspaceId, project.status)));
  } catch (err) {
    await registry.masterDb.delete(panelKeyRegistry).where(eq(panelKeyRegistry.id, row.id)).catch((cleanup: unknown) => {
      console.error('[panel-api] cleanup after a failed key registration:', cleanup);
    });
    throw err;
  }
  return { row, key };
}

/**
 * Revokes a key: stamps `revokedAt` and deletes the KV record, so the collector
 * refuses it at once (after its own one-minute read cache). Safe to repeat: a
 * revoked key is answered again and its KV record deleted again, in case that
 * failed the first time. Null when the key is not this project's.
 */
export async function revokeKey(registry: ProjectRegistry, projectId: string, keyId: string): Promise<PanelKey | null> {
  const match = and(
    eq(panelKeyRegistry.id, keyId),
    eq(panelKeyRegistry.workspaceId, registry.workspaceId),
    eq(panelKeyRegistry.projectId, projectId),
  );
  const [revoked] = await registry.masterDb
    .update(panelKeyRegistry)
    .set({ revokedAt: new Date() })
    .where(and(match, isNull(panelKeyRegistry.revokedAt)))
    .returning();
  const row =
    revoked ??
    (await registry.masterDb.select().from(panelKeyRegistry).where(match).limit(1))[0] ??
    null;
  if (!row) return null;
  await registry.kv.delete(keyKvKey(row.keyHash));
  return row;
}

/**
 * Rewrites the KV records of the project's active keys with its current status
 * (`paused` makes the collector drop their traffic). A deleted project's keys
 * are taken out of KV altogether. Repeating it is harmless.
 */
export async function syncKeyRecords(registry: ProjectRegistry, project: Pick<PanelProject, 'id' | 'status'>, deleted = false): Promise<void> {
  for (const row of await activeKeys(registry, project.id)) {
    if (deleted) await registry.kv.delete(keyKvKey(row.keyHash));
    else await registry.kv.put(keyKvKey(row.keyHash), JSON.stringify(keyRecord(row, registry.workspaceId, project.status)));
  }
}
