/**
 * Workspace API key routes — /api/workspace-api-keys/*, backed by the tenant
 * `workspace_api_keys` table. Ported from apps/api-worker
 * `GET|POST|PUT|DELETE /settings/workspace-api-keys`.
 *
 * A DIFFERENT table from `api_keys` (/api/api-keys): those are personal,
 * self-scoped credentials; these are shared workspace-wide credentials that any
 * admin can see and revoke. `created_by` records who minted the key; it is NOT
 * an ownership filter — the whole point is that the workspace shares them.
 *
 * Like the personal keys, each create/revoke is paired with a write to the
 * master `api_key_registry`, which is what apps/workers/external-api authenticates
 * against (see apps/workers/external-api/src/middleware/auth.ts).
 *
 * Permission gates mirror the legacy route exactly:
 *   GET    → apikeys:read
 *   POST   → apikeys:create
 *   PUT    → apikeys:update
 *   DELETE → apikeys:delete
 *
 * CAVEAT (pre-existing, preserved deliberately): `apikeys:update` is NOT in the
 * permission catalog — packages/core/permissions/src/catalog.ts declares the
 * `apikeys` object with only read/create/delete. So PUT resolves for OWNER
 * (wildcard `*`) but 403s for ADMIN. That is exactly what the legacy route did,
 * and widening it here would be a silent privilege change, so the gate is kept
 * as-is and the catalog gap is reported separately.
 *
 * Registered as EXEMPT in _event-coverage.test.ts: credentials are infra, not
 * a business entity, and the events catalog has no `api_key` entity type.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { getMasterDb, schema } from '../../db';
import { generateApiKey, registerApiKey, unregisterApiKey } from '../../services/api-keys';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.workspaceApiKeys;

// Strict (no .passthrough()) — the caller must never supply `keyHash`,
// `keyPrefix` or `createdBy`.
const createWorkspaceApiKeyInput = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  description: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

const updateWorkspaceApiKeyInput = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

type WorkspaceApiKeyRow = typeof t.$inferSelect;

/** Project a row for the client. `keyHash` is never exposed. */
function toSafeKey(key: WorkspaceApiKeyRow) {
  return {
    id: key.id,
    name: key.name,
    description: key.description,
    keyPrefix: key.keyPrefix,
    scopes: key.scopes,
    lastUsedAt: key.lastUsedAt?.toISOString(),
    expiresAt: key.expiresAt?.toISOString(),
    createdAt: key.createdAt?.toISOString(),
    createdBy: key.createdBy,
  };
}

/**
 * GET / — list the workspace's keys, newest first.
 *
 * Not paginated, matching the legacy route: the settings UI renders the full
 * list and a workspace's key count is inherently small.
 */
app.get('/', requirePermission('apikeys:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    const rows = await c
      .get('tenantDb')
      .select()
      .from(t)
      .where(isNull(t.deletedAt))
      .orderBy(desc(t.createdAt));

    return success(c, rows.map(toSafeKey));
  } catch (err) {
    console.error('[app-api/workspace-api-keys] list failed:', err);
    return error.internal(c, 'Failed to fetch workspace API keys');
  }
});

/** GET /:id — fetch a single workspace key. */
app.get('/:id', requirePermission('apikeys:read'), async (c) => {
  const orgId = c.get('orgId');
  const id = c.req.param('id');
  if (!orgId) return error.orgRequired(c);

  try {
    const [row] = await c
      .get('tenantDb')
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);

    if (!row) return error.notFound(c, 'Workspace API key', id);
    return success(c, toSafeKey(row));
  } catch (err) {
    console.error('[app-api/workspace-api-keys] get failed:', err);
    return error.internal(c, 'Failed to fetch workspace API key');
  }
});

/**
 * POST / — mint a workspace API key.
 *
 * The plaintext key is returned HERE AND ONLY HERE; only its SHA-256 is stored.
 */
app.post('/', requirePermission('apikeys:create'), zValidator('json', createWorkspaceApiKeyInput), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) return error.orgRequired(c);

  const data = c.req.valid('json');

  try {
    const { key, hash, prefix } = await generateApiKey();
    const id = generateId('wak');
    const now = new Date();

    await c.get('tenantDb').insert(t).values({
      id,
      name: data.name,
      description: data.description,
      keyHash: hash,
      keyPrefix: prefix,
      scopes: data.scopes || [],
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    await registerApiKey({
      masterDb: getMasterDb(c.env),
      clerkOrgId: orgId,
      keyHash: hash,
      keyType: 'workspace',
      tenantKeyId: id,
    });

    return success(
      c,
      {
        id,
        name: data.name,
        description: data.description,
        keyPrefix: prefix,
        scopes: data.scopes || [],
        // The only time the full key is ever returned.
        key,
      },
      201,
    );
  } catch (err) {
    console.error('[app-api/workspace-api-keys] create failed:', err);
    return error.internal(c, 'Failed to create workspace API key');
  }
});

/**
 * PUT /:id — rename / re-scope a workspace key.
 *
 * Metadata only: the key material itself is immutable (rotating means revoking
 * and issuing a new one, so the registry stays a 1:1 index of live hashes).
 *
 * PUT rather than PATCH to match the legacy path the settings UI already calls.
 */
app.put('/:id', requirePermission('apikeys:update'), zValidator('json', updateWorkspaceApiKeyInput), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  if (!orgId) return error.orgRequired(c);

  const data = c.req.valid('json');

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);

    if (!existing) return error.notFound(c, 'Workspace API key', id);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.scopes !== undefined) update.scopes = data.scopes;

    await db.update(t).set(update).where(eq(t.id, id));

    const [updated] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    return success(c, toSafeKey(updated));
  } catch (err) {
    console.error('[app-api/workspace-api-keys] update failed:', err);
    return error.internal(c, 'Failed to update workspace API key');
  }
});

/**
 * DELETE /:id — revoke a workspace key.
 *
 * Soft-deletes the tenant row AND drops the master registry entry, so the key
 * stops authenticating against external-api.
 */
app.delete('/:id', requirePermission('apikeys:delete'), async (c) => {
  const orgId = c.get('orgId');
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  if (!orgId) return error.orgRequired(c);

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);

    if (!existing) return error.notFound(c, 'Workspace API key', id);

    await db
      .update(t)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(t.id, id));

    await unregisterApiKey(getMasterDb(c.env), id);

    return noContent(c);
  } catch (err) {
    console.error('[app-api/workspace-api-keys] delete failed:', err);
    return error.internal(c, 'Failed to revoke workspace API key');
  }
});

export const workspaceApiKeysRoutes = app;
