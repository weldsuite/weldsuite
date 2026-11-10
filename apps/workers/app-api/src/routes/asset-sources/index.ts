/**
 * Asset sources: device imports into the asset register (Microsoft Intune).
 * `/api/asset-sources`.
 *
 * Permissions: every route needs `weldobjects:manage`, the reads included.
 *
 * The customer connects their own Entra app registration (tenant id, client id,
 * client secret), so there is no WeldSuite-wide Microsoft app. The client
 * secret is write-only: stored field-encrypted with the tenant keyring
 * (`secret_encrypted`), never returned, never put in an entity event or a log.
 * Rows carry `hasSecret` instead.
 *
 * This worker only manages the sources and starts imports. The imports run in
 * desk-api's minute cron (`@weldsuite/core-domain/asset-sources`), found
 * through the due index (kind `asset_import`): every route that changes when a
 * source has work marks the workspace due, so a workspace without a source is
 * never opened.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { asc, eq, and } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  createAssetSourceSchema,
  testAssetSourceSchema,
  testSavedAssetSourceSchema,
  updateAssetSourceSchema,
  type AssetSource as AssetSourceBody,
} from '@weldsuite/core-api-client/schemas/asset-sources';
import {
  ASSET_OBJECT_SLUG,
  INTUNE_DEVICE_ENTITY_TYPE,
  assetSourceDueAt,
  assetSourceView,
  markAssetImportDue,
  startAssetImport,
  testAssetSource,
} from '@weldsuite/core-domain/asset-sources';
import { getCustomObjectBySlug } from '@weldsuite/core-domain/custom-objects';
import { decryptField, encryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import type { Context } from 'hono';
import type { Env, Variables } from '../../types';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.assetSources;
const mappings = schema.integrationEntityMappings;

type SourceRow = typeof t.$inferSelect;

/** The row as the API shows it (never the secret); the domain owns the shape. */
export const toView = (row: SourceRow): AssetSourceBody => assetSourceView(row);

const asData = (row: SourceRow) => toView(row) as unknown as Record<string, unknown>;
const HOUR_MS = 60 * 60_000;

const sameApp = (a: { tenantId: string; clientId: string }, b: { tenantId: string; clientId: string }) =>
  a.tenantId.toLowerCase() === b.tenantId.toLowerCase() && a.clientId.toLowerCase() === b.clientId.toLowerCase();

/** Tell the sweep when this workspace next has work for the source. Best-effort, after the response. */
function markDue(c: AppContext, row: SourceRow, now: Date): void {
  if (!c.env.SCHEDULE_INDEX) return;
  c.executionCtx.waitUntil(markAssetImportDue(c.env.SCHEDULE_INDEX, c.get('clerkOrgId'), assetSourceDueAt(row, now)));
}

function notFound(c: AppContext, id: string) {
  return error.notFound(c, 'Asset source', id);
}

app.get('/', requirePermission('weldobjects:manage'), async (c) => {
  const rows = await c.get('tenantDb').select().from(t).orderBy(asc(t.createdAt), asc(t.id));
  return list(c, rows.map(toView), cursorPagination(rows.length, false, null));
});

/** Try a connection that is not saved yet. Declared before `/:id`. Saves nothing; a refusal is HTTP 200 `ok: false`. */
app.post('/test', requirePermission('weldobjects:manage'), zValidator('json', testAssetSourceSchema), async (c) => {
  const body = c.req.valid('json');
  return success(c, await testAssetSource(body.config, body.secret));
});

app.post('/', requirePermission('weldobjects:manage'), zValidator('json', createAssetSourceSchema), async (c) => {
  const db = c.get('tenantDb');
  const body = c.req.valid('json');

  const object = await getCustomObjectBySlug(db, ASSET_OBJECT_SLUG);
  if (!object) {
    return c.json(
      { error: { code: 'asset_register_missing', message: 'The asset register is not set up. Set it up before connecting a device source.' } },
      409,
    );
  }

  const existing = await db.select().from(t).where(eq(t.type, body.type));
  if (existing.some((row) => sameApp(row.config, body.config))) {
    return error.conflict(c, 'This app registration is already connected', { code: 'duplicate_source' });
  }

  const now = new Date();
  const [row] = await db
    .insert(t)
    .values({
      id: generateId('asrc'),
      type: body.type,
      name: body.name,
      objectSlug: object.slug,
      config: { tenantId: body.config.tenantId, clientId: body.config.clientId },
      secretEncrypted: await encryptField(body.secret, keyringFromEnv(c.env)),
      enabled: body.enabled,
      intervalHours: body.intervalHours,
      // The first import starts on the next tick.
      nextSyncAt: body.enabled ? now : null,
      createdById: c.get('userId'),
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  markDue(c, row, now);
  publishEntityEvent({ c, entityType: 'asset_source', action: 'created', entityId: row.id, data: asData(row) });
  return success(c, toView(row), 201);
});

app.get('/:id', requirePermission('weldobjects:manage'), async (c) => {
  const id = c.req.param('id');
  const [row] = await c.get('tenantDb').select().from(t).where(eq(t.id, id)).limit(1);
  if (!row) return notFound(c, id);
  return success(c, toView(row));
});

app.patch('/:id', requirePermission('weldobjects:manage'), zValidator('json', updateAssetSourceSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const body = c.req.valid('json');

  const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
  if (!existing) return notFound(c, id);

  const now = new Date();
  const update: Partial<typeof t.$inferInsert> = { updatedAt: now };
  if (body.name !== undefined) update.name = body.name;

  if (body.config !== undefined && !sameApp(body.config, existing.config)) {
    // The stored secret belongs to the other app registration.
    if (body.secret === undefined) {
      return error.badRequest(c, 'A different tenant or application needs its client secret', { field: 'secret' });
    }
    const others = await db.select().from(t).where(and(eq(t.type, existing.type)));
    if (others.some((row) => row.id !== id && sameApp(row.config, body.config!))) {
      return error.conflict(c, 'This app registration is already connected', { code: 'duplicate_source' });
    }
  }
  if (body.config !== undefined) update.config = { tenantId: body.config.tenantId, clientId: body.config.clientId };
  if (body.secret !== undefined) update.secretEncrypted = await encryptField(body.secret, keyringFromEnv(c.env));

  const enabled = body.enabled ?? existing.enabled;
  const intervalHours = body.intervalHours ?? existing.intervalHours;
  if (body.enabled !== undefined) update.enabled = body.enabled;
  if (body.intervalHours !== undefined) update.intervalHours = body.intervalHours;
  if (body.enabled !== undefined || body.intervalHours !== undefined) {
    // The next import is one interval after the last; never imported yet: now.
    update.nextSyncAt = enabled
      ? existing.lastSyncAt
        ? new Date(existing.lastSyncAt.getTime() + intervalHours * HOUR_MS)
        : now
      : null;
  }

  const [row] = await db.update(t).set(update).where(eq(t.id, id)).returning();
  markDue(c, row, now);
  publishEntityEvent({ c, entityType: 'asset_source', action: 'updated', entityId: id, data: asData(row) });
  return success(c, toView(row));
});

/** The source goes with its mappings; the asset records it imported stay. */
app.delete('/:id', requirePermission('weldobjects:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
  if (!existing) return notFound(c, id);

  await atomically(db, (handle) => [
    handle
      .delete(mappings)
      .where(and(eq(mappings.connectionId, id), eq(mappings.externalEntityType, INTUNE_DEVICE_ENTITY_TYPE))),
    handle.delete(t).where(eq(t.id, id)),
  ]);
  publishEntityEvent({ c, entityType: 'asset_source', action: 'deleted', entityId: id, data: asData(existing) });
  return noContent(c);
});

/**
 * Try the saved connection (or, with a body, a replacement secret or config)
 * without saving anything. The answer is Microsoft's, not ours: a refusal is
 * HTTP 200 `{ ok: false, code, message }`.
 */
app.post('/:id/test', requirePermission('weldobjects:manage'), async (c) => {
  const id = c.req.param('id');
  const [row] = await c.get('tenantDb').select().from(t).where(eq(t.id, id)).limit(1);
  if (!row) return notFound(c, id);

  const parsed = testSavedAssetSourceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return error.badRequest(c, 'Invalid request body', parsed.error.flatten());
  const body = parsed.data;

  let secret = body.secret;
  if (secret === undefined) {
    if (!row.secretEncrypted) {
      return success(c, { ok: false, code: 'invalid_secret', message: 'No client secret is stored; enter it again.' });
    }
    try {
      secret = await decryptField(row.secretEncrypted, keyringFromEnv(c.env));
    } catch {
      return success(c, { ok: false, code: 'invalid_secret', message: 'The stored client secret cannot be read; enter it again.' });
    }
  }
  return success(c, await testAssetSource(body.config ?? row.config, secret));
});

/** Start an import now. 202 with the source; 409 `already_running` while one is under way. */
app.post('/:id/sync', requirePermission('weldobjects:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
  if (!existing) return notFound(c, id);

  const now = new Date();
  const row = await startAssetImport(db, existing, { now, startedById: c.get('userId') });
  if (!row) {
    return c.json({ error: { code: 'already_running', message: 'An import is already running for this source' } }, 409);
  }
  markDue(c, row, now);
  publishEntityEvent({ c, entityType: 'asset_source', action: 'updated', entityId: id, data: asData(row) });
  return c.json({ data: toView(row) }, 202);
});

export const assetSourcesRoutes = app;
