/**
 * Personal API key routes — /api/api-keys/*, backed by the tenant `api_keys`
 * table. Ported from apps/api-worker `GET|POST|DELETE /settings/api-keys`.
 *
 * These are the CALLER'S OWN keys. Every query is scoped by the JWT `userId`
 * and never by a client-supplied id, so one member can never list, read or
 * revoke another member's key.
 *
 * NO `requirePermission()` gate — deliberately, and matching the legacy route.
 * This is a personal, self-scoped resource: any authenticated member may manage
 * their own keys. The `apikeys:*` permissions in packages/core/permissions gate the
 * WORKSPACE-wide keys (/api/workspace-api-keys) and are NOT held by the MEMBER
 * system role, so gating this surface on them would 403 every non-admin out of
 * their own credentials.
 *
 * What the previous generic-CRUD version of this file got wrong, and why each
 * matters:
 *   - it never called generateApiKey(), so POST violated the NOT NULL
 *     `key_hash` and never returned the one-time plaintext;
 *   - it spread a `.passthrough()` body straight into the insert, letting a
 *     caller set `keyHash` / `userId` themselves;
 *   - it was not user-scoped;
 *   - it never wrote the master `api_key_registry`, so keys could not
 *     authenticate against apps/workers/external-api.
 *
 * Registered as EXEMPT in _event-coverage.test.ts: credentials are infra, not
 * a business entity, and the events catalog has no `api_key` entity type.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { getMasterDb, schema } from '../../db';
import { generateApiKey, registerApiKey, unregisterApiKey } from '../../services/api-keys';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.apiKeys;

// Strict (no .passthrough()) — the caller must never be able to supply
// `keyHash`, `keyPrefix` or `userId`.
const createApiKeyInput = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  description: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

const updateApiKeyInput = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

type ApiKeyRow = typeof t.$inferSelect;

/** Project a row for the client. `keyHash` is never exposed. */
function toSafeKey(key: ApiKeyRow) {
  return {
    id: key.id,
    name: key.name,
    description: key.description,
    keyPrefix: key.keyPrefix,
    scopes: key.scopes,
    lastUsedAt: key.lastUsedAt?.toISOString(),
    expiresAt: key.expiresAt?.toISOString(),
    createdAt: key.createdAt?.toISOString(),
  };
}

/**
 * GET / — list the caller's own keys, newest first.
 *
 * Not paginated: the legacy route returned the full list and the UI renders it
 * whole. A user's personal key count is inherently small.
 */
app.get('/', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) return error.orgRequired(c);

  try {
    const rows = await c
      .get('tenantDb')
      .select()
      .from(t)
      .where(and(eq(t.userId, userId), isNull(t.deletedAt)))
      .orderBy(desc(t.createdAt));

    return success(c, rows.map(toSafeKey));
  } catch (err) {
    console.error('[app-api/api-keys] list failed:', err);
    return error.internal(c, 'Failed to fetch API keys');
  }
});

/** GET /:id — fetch one of the caller's own keys. */
app.get('/:id', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const id = c.req.param('id');
  if (!orgId) return error.orgRequired(c);

  try {
    const [row] = await c
      .get('tenantDb')
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.userId, userId), isNull(t.deletedAt)))
      .limit(1);

    if (!row) return error.notFound(c, 'API key', id);
    return success(c, toSafeKey(row));
  } catch (err) {
    console.error('[app-api/api-keys] get failed:', err);
    return error.internal(c, 'Failed to fetch API key');
  }
});

/**
 * POST / — mint a personal API key.
 *
 * The plaintext key is returned HERE AND ONLY HERE; only its SHA-256 is stored.
 * The key is also registered in the master `api_key_registry` so external-api
 * can authenticate it.
 */
app.post('/', zValidator('json', createApiKeyInput), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) return error.orgRequired(c);

  const data = c.req.valid('json');

  try {
    const { key, hash, prefix } = await generateApiKey();
    const id = generateId('ak');
    const now = new Date();

    await c.get('tenantDb').insert(t).values({
      id,
      userId,
      name: data.name,
      description: data.description,
      keyHash: hash,
      keyPrefix: prefix,
      scopes: data.scopes || [],
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      createdAt: now,
      updatedAt: now,
    });

    await registerApiKey({
      masterDb: getMasterDb(c.env),
      clerkOrgId: orgId,
      keyHash: hash,
      keyType: 'personal',
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
    console.error('[app-api/api-keys] create failed:', err);
    return error.internal(c, 'Failed to create API key');
  }
});

/**
 * PATCH /:id — rename / re-scope one of the caller's own keys.
 *
 * Metadata only: the key material itself is immutable (rotating means revoking
 * and issuing a new one, so the registry stays a 1:1 index of live hashes).
 */
app.patch('/:id', zValidator('json', updateApiKeyInput), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  if (!orgId) return error.orgRequired(c);

  const data = c.req.valid('json');

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.userId, userId), isNull(t.deletedAt)))
      .limit(1);

    if (!existing) return error.notFound(c, 'API key', id);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.scopes !== undefined) update.scopes = data.scopes;

    await db.update(t).set(update).where(and(eq(t.id, id), eq(t.userId, userId)));

    const [updated] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    return success(c, toSafeKey(updated));
  } catch (err) {
    console.error('[app-api/api-keys] update failed:', err);
    return error.internal(c, 'Failed to update API key');
  }
});

/**
 * DELETE /:id — revoke one of the caller's own keys.
 *
 * Soft-deletes the tenant row AND drops the master registry entry, so the key
 * stops authenticating against external-api.
 */
app.delete('/:id', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  if (!orgId) return error.orgRequired(c);

  try {
    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.userId, userId), isNull(t.deletedAt)))
      .limit(1);

    if (!existing) return error.notFound(c, 'API key', id);

    await db
      .update(t)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(t.id, id), eq(t.userId, userId)));

    await unregisterApiKey(getMasterDb(c.env), id);

    return noContent(c);
  } catch (err) {
    console.error('[app-api/api-keys] delete failed:', err);
    return error.internal(c, 'Failed to revoke API key');
  }
});

export const apiKeysRoutes = app;
