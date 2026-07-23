/**
 * Generic per-app storage for user-created apps (WeldApps).
 *
 * Apps declare collections in their manifest and get CRUD + jsonb filtering
 * here — no per-app tables or migrations, ever. Data lives in the tenant DB
 * (`app_records` / `app_kv`), grouped by appCode.
 *
 * The acting app is resolved from the session:
 * - `wsat_` app tokens act as their own app (session.appCode).
 * - `wsk_` workspace/personal keys must send an `X-App-Code` header, hold the
 *   `user-apps:manage` scope, and the app must have an ACTIVE install in the
 *   workspace — this is what lets the MCP server and agents act on an app's
 *   data with a regular API key.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { appRecords, appKv } from '@weldsuite/db/schema';
import {
  appRecordCreateSchema,
  appRecordUpdateSchema,
  appRecordListQuerySchema,
  appKvSetSchema,
} from '@weldsuite/app-api-client/schemas/user-apps';
import type { HonoEnv } from '../../types';
import { hasScope } from '../../lib/scopes';
import { generateId } from '../../lib/id';
import { createMasterDb, masterSchema } from '../../lib/master-db';
import { error, list, noContent, success, cursorPagination } from '../../lib/response';
import { listWithCursor } from '../../lib/list-helpers';

const app = new Hono<HonoEnv>();

const COLLECTION_NAME_RE = /^[a-z][a-z0-9_-]{0,99}$/;
const KV_KEY_MAX_LENGTH = 255;
const DEFAULT_RECORD_LIMIT = 25;

// Active-install verification cache TTL (wsk_ + X-App-Code path). Short so
// uninstalls cut off key-based access quickly.
const INSTALL_KV_TTL_SECONDS = 60;

interface CachedActiveInstall {
  appId: string;
  installId: string;
}

type AppCodeResolution =
  | { ok: true; appCode: string }
  | { ok: false; response: Response };

/**
 * Resolve the appCode the request acts on (see module docblock for rules).
 */
async function resolveAppCode(c: Context<HonoEnv>): Promise<AppCodeResolution> {
  const session = c.get('apiSession');

  // App tokens always act as their own app.
  if (session.keyType === 'app' && session.appCode) {
    return { ok: true, appCode: session.appCode };
  }

  // Workspace / personal keys: X-App-Code + user-apps:manage + active install.
  const appCode = c.req.header('X-App-Code');
  if (!appCode) {
    return {
      ok: false,
      response: error.badRequest(
        c,
        'X-App-Code header is required when accessing app storage with a workspace or personal API key',
      ),
    };
  }
  if (!hasScope(session.scopes, 'user-apps:manage')) {
    return {
      ok: false,
      response: error.forbidden(c, 'Missing required scope: user-apps:manage'),
    };
  }

  const install = await getActiveInstall(c, session.workspaceId, appCode);
  if (!install) {
    return {
      ok: false,
      response: error.notFound(c, 'Installed app', appCode),
    };
  }

  return { ok: true, appCode };
}

/**
 * Verify (KV-cached, 60s) that `appCode` has an ACTIVE install in the
 * workspace and belongs to an active, non-deleted app.
 */
async function getActiveInstall(
  c: Context<HonoEnv>,
  workspaceId: string,
  appCode: string,
): Promise<CachedActiveInstall | null> {
  const kv = c.env.API_CACHE;
  const cacheKey = `uai:${workspaceId}:${appCode}`;

  const cached = await kv.get(cacheKey, 'json') as CachedActiveInstall | null;
  if (cached) return cached;

  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);
  const [row] = await masterDb
    .select({
      appId: masterSchema.userApps.id,
      installId: masterSchema.userAppInstalls.id,
    })
    .from(masterSchema.userAppInstalls)
    .innerJoin(
      masterSchema.userApps,
      eq(masterSchema.userAppInstalls.appId, masterSchema.userApps.id),
    )
    .where(
      and(
        eq(masterSchema.userApps.code, appCode),
        eq(masterSchema.userAppInstalls.workspaceId, workspaceId),
        eq(masterSchema.userAppInstalls.status, 'active'),
        eq(masterSchema.userApps.isActive, true),
        isNull(masterSchema.userApps.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return null;

  const result: CachedActiveInstall = { appId: row.appId, installId: row.installId };
  await kv.put(cacheKey, JSON.stringify(result), { expirationTtl: INSTALL_KV_TTL_SECONDS });
  return result;
}

function validateCollectionName(c: Context<HonoEnv>, collection: string): Response | null {
  if (!COLLECTION_NAME_RE.test(collection)) {
    return error.badRequest(
      c,
      'Invalid collection name — lowercase letters, digits, dashes and underscores, starting with a letter (max 100 chars)',
    );
  }
  return null;
}

// ============================================================================
// Collection records
// ============================================================================

app.get('/collections/:collection/records', zValidator('query', appRecordListQuerySchema), async (c) => {
  const resolved = await resolveAppCode(c);
  if (!resolved.ok) return resolved.response;
  const collection = c.req.param('collection');
  const invalid = validateCollectionName(c, collection);
  if (invalid) return invalid;

  const q = c.req.valid('query');
  const where: (SQL | undefined)[] = [
    eq(appRecords.appCode, resolved.appCode),
    eq(appRecords.collection, collection),
  ];

  // Optional jsonb containment filter, e.g. ?filter={"status":"open"}.
  // Parse + re-stringify so only valid JSON ever reaches the query.
  if (q.filter) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(q.filter);
    } catch {
      return error.badRequest(c, 'filter must be a valid JSON string');
    }
    where.push(sql`${appRecords.data} @> ${JSON.stringify(parsed)}::jsonb`);
  }

  const db = c.get('tenantDb');
  const result = await listWithCursor({
    db,
    table: appRecords,
    where,
    cursor: q.cursor,
    limit: q.limit ?? DEFAULT_RECORD_LIMIT,
  });
  return list(c, result.data as Record<string, unknown>[], cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.post('/collections/:collection/records', zValidator('json', appRecordCreateSchema), async (c) => {
  const resolved = await resolveAppCode(c);
  if (!resolved.ok) return resolved.response;
  const collection = c.req.param('collection');
  const invalid = validateCollectionName(c, collection);
  if (invalid) return invalid;

  const session = c.get('apiSession');
  const body = c.req.valid('json');
  const db = c.get('tenantDb');
  const now = new Date();
  const [row] = await db
    .insert(appRecords)
    .values({
      id: generateId('arec'),
      appCode: resolved.appCode,
      collection,
      data: body.data,
      createdBy: session.keyId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) return error.internal(c, 'Failed to create record');
  return success(c, row, 201);
});

app.get('/collections/:collection/records/:id', async (c) => {
  const resolved = await resolveAppCode(c);
  if (!resolved.ok) return resolved.response;
  const collection = c.req.param('collection');
  const invalid = validateCollectionName(c, collection);
  if (invalid) return invalid;

  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const [row] = await db
    .select()
    .from(appRecords)
    .where(
      and(
        eq(appRecords.id, id),
        eq(appRecords.appCode, resolved.appCode),
        eq(appRecords.collection, collection),
        isNull(appRecords.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return error.notFound(c, 'Record', id);
  return success(c, row);
});

// PATCH replaces the record's `data` document wholesale (full-document
// replace, NOT a deep merge) — read-modify-write for partial updates.
app.patch('/collections/:collection/records/:id', zValidator('json', appRecordUpdateSchema), async (c) => {
  const resolved = await resolveAppCode(c);
  if (!resolved.ok) return resolved.response;
  const collection = c.req.param('collection');
  const invalid = validateCollectionName(c, collection);
  if (invalid) return invalid;

  const session = c.get('apiSession');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const db = c.get('tenantDb');
  const [row] = await db
    .update(appRecords)
    .set({ data: body.data, createdBy: session.keyId, updatedAt: new Date() })
    .where(
      and(
        eq(appRecords.id, id),
        eq(appRecords.appCode, resolved.appCode),
        eq(appRecords.collection, collection),
        isNull(appRecords.deletedAt),
      ),
    )
    .returning();
  if (!row) return error.notFound(c, 'Record', id);
  return success(c, row);
});

app.delete('/collections/:collection/records/:id', async (c) => {
  const resolved = await resolveAppCode(c);
  if (!resolved.ok) return resolved.response;
  const collection = c.req.param('collection');
  const invalid = validateCollectionName(c, collection);
  if (invalid) return invalid;

  const id = c.req.param('id');
  const db = c.get('tenantDb');
  const [row] = await db
    .update(appRecords)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(appRecords.id, id),
        eq(appRecords.appCode, resolved.appCode),
        eq(appRecords.collection, collection),
        isNull(appRecords.deletedAt),
      ),
    )
    .returning();
  if (!row) return error.notFound(c, 'Record', id);
  return noContent(c);
});

// ============================================================================
// Key-value storage
// ============================================================================

app.get('/kv/:key', async (c) => {
  const resolved = await resolveAppCode(c);
  if (!resolved.ok) return resolved.response;
  const key = c.req.param('key');
  if (key.length > KV_KEY_MAX_LENGTH) {
    return error.badRequest(c, `Key must be at most ${KV_KEY_MAX_LENGTH} characters`);
  }

  const db = c.get('tenantDb');
  const [row] = await db
    .select()
    .from(appKv)
    .where(and(eq(appKv.appCode, resolved.appCode), eq(appKv.key, key)))
    .limit(1);
  if (!row) return error.notFound(c, 'Key', key);
  return success(c, { key: row.key, value: row.value });
});

app.put('/kv/:key', zValidator('json', appKvSetSchema), async (c) => {
  const resolved = await resolveAppCode(c);
  if (!resolved.ok) return resolved.response;
  const key = c.req.param('key');
  if (key.length > KV_KEY_MAX_LENGTH) {
    return error.badRequest(c, `Key must be at most ${KV_KEY_MAX_LENGTH} characters`);
  }

  const body = c.req.valid('json');
  const db = c.get('tenantDb');
  const now = new Date();
  const [row] = await db
    .insert(appKv)
    .values({
      id: generateId('akv'),
      appCode: resolved.appCode,
      key,
      value: body.value,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [appKv.appCode, appKv.key],
      set: { value: body.value, updatedAt: now },
    })
    .returning();
  if (!row) return error.internal(c, 'Failed to set key');
  return success(c, { key: row.key, value: row.value });
});

app.delete('/kv/:key', async (c) => {
  const resolved = await resolveAppCode(c);
  if (!resolved.ok) return resolved.response;
  const key = c.req.param('key');
  if (key.length > KV_KEY_MAX_LENGTH) {
    return error.badRequest(c, `Key must be at most ${KV_KEY_MAX_LENGTH} characters`);
  }

  const db = c.get('tenantDb');
  const [row] = await db
    .delete(appKv)
    .where(and(eq(appKv.appCode, resolved.appCode), eq(appKv.key, key)))
    .returning();
  if (!row) return error.notFound(c, 'Key', key);
  return noContent(c);
});

export default app;
