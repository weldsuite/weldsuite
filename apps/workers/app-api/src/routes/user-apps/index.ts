/**
 * WeldApps (user-created apps) management routes — /api/user-apps/*.
 *
 * Apps live in the MASTER database (public apps are discoverable across
 * workspaces; external-api authenticates wsat_ tokens without knowing the
 * tenant up front). Install state is mirrored into the tenant
 * workspace_installed_apps table so the sidenav renders without a master
 * round-trip.
 *
 * Permissions: weldapps:read | weldapps:develop | weldapps:publish |
 * weldapps:manage. The review endpoint is gated on master adminUsers
 * (platform staff), not on a workspace permission.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  consentUserAppScopesSchema,
  createUserAppSchema,
  installUserAppSchema,
  reviewUserAppSchema,
  submitUserAppSchema,
  updateUserAppSchema,
  userAppManifestSchema,
} from '@weldsuite/app-api-client/schemas/user-apps';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { UserApp } from '@weldsuite/db/schema/master';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { getMasterDb, masterSchema, schema, type MasterDatabase } from '../../db';
import {
  RESERVED_APP_CODES,
  assetCacheKey,
  contentTypeFor,
  diffScopes,
  isSafeBundlePath,
  isScopeSuperset,
  mintAppToken,
  publishAppVersion,
  randomHex,
  sha256Hex,
  unionScopes,
} from '../../services/user-apps';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const uApps = masterSchema.userApps;
const uVersions = masterSchema.userAppVersions;
const uInstalls = masterSchema.userAppInstalls;
const uTokens = masterSchema.userAppTokens;
const uOauthClients = masterSchema.userAppOauthClients;
const wsApps = schema.workspaceInstalledApps;

const MAX_BUNDLE_FILES = 100;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024; // 10MB

/** Load an app owned by the calling workspace (soft-deleted excluded). */
async function getOwnedApp(
  master: MasterDatabase,
  id: string,
  workspaceId: string,
): Promise<UserApp | undefined> {
  const [row] = await master
    .select()
    .from(uApps)
    .where(and(eq(uApps.id, id), eq(uApps.ownerWorkspaceId, workspaceId), isNull(uApps.deletedAt)))
    .limit(1);
  return row;
}

/** Store visibility rule: own apps always, foreign apps only when live. */
function isInstallableHere(row: UserApp, workspaceId: string): boolean {
  if (row.deletedAt) return false;
  if (row.ownerWorkspaceId === workspaceId) return true;
  return row.visibility === 'public' && row.reviewStatus === 'approved' && row.isActive;
}

async function invalidateAssetCache(c: { env: Env }, code: string): Promise<void> {
  try {
    await c.env.WORKSPACE_CACHE.delete(assetCacheKey(code));
  } catch (err) {
    console.error('[app-api/user-apps] asset cache invalidation failed:', err);
  }
}

// ============================================================================
// GET / — apps owned by the calling workspace
// ============================================================================

app.get('/', requirePermission('weldapps:read'), async (c) => {
  const master = getMasterDb(c.env);
  const workspaceId = c.get('workspaceId');
  const q = c.req.query();
  const parsedLimit = q.limit ? parseInt(q.limit, 10) : 25;
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 25;

  const conditions = [eq(uApps.ownerWorkspaceId, workspaceId), isNull(uApps.deletedAt)];
  const countWhere = and(...conditions);
  if (q.cursor) {
    // Workspace-scoped: a cursor pointing at another workspace's app must
    // not leak that row's existence or timestamp.
    const [cur] = await master
      .select({ createdAt: uApps.createdAt, id: uApps.id })
      .from(uApps)
      .where(and(eq(uApps.id, q.cursor), eq(uApps.ownerWorkspaceId, workspaceId)))
      .limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${uApps.createdAt} < ${cur.createdAt} OR (${uApps.createdAt} = ${cur.createdAt} AND ${uApps.id} < ${cur.id}))`,
      );
    }
  }

  try {
    const [rows, countRes] = await Promise.all([
      master
        .select()
        .from(uApps)
        .where(and(...conditions))
        .orderBy(desc(uApps.createdAt), desc(uApps.id))
        .limit(limit + 1),
      master.select({ count: sql<number>`count(*)` }).from(uApps).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/user-apps] list failed:', err);
    return error.internal(c, 'Failed to list apps');
  }
});

// ============================================================================
// POST / — create an app shell (versions are uploaded separately)
// ============================================================================

app.post('/', requirePermission('weldapps:develop'), zValidator('json', createUserAppSchema), async (c) => {
  const master = getMasterDb(c.env);
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const data = c.req.valid('json');

  if (RESERVED_APP_CODES.includes(data.code)) {
    return error.conflict(c, `App code '${data.code}' is reserved`);
  }

  try {
    const [existing] = await master
      .select({ id: uApps.id })
      .from(uApps)
      .where(eq(uApps.code, data.code))
      .limit(1);
    if (existing) return error.conflict(c, `App code '${data.code}' is already taken`);

    const now = new Date();
    const [created] = await master
      .insert(uApps)
      .values({
        id: generateId('uapp'),
        code: data.code,
        name: data.name,
        description: data.description ?? null,
        ...(data.icon ? { icon: data.icon } : {}),
        ...(data.category ? { category: data.category } : {}),
        ownerWorkspaceId: workspaceId,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    publishEntityEvent({
      c,
      entityType: 'user_app',
      action: 'created',
      entityId: created.id,
      data: created as unknown as Record<string, unknown>,
    });
    return success(c, created, 201);
  } catch (err) {
    console.error('[app-api/user-apps] create failed:', err);
    return error.internal(c, 'Failed to create app');
  }
});

// ============================================================================
// GET /store — installable apps for this workspace (+install state)
// ============================================================================

const storeVisibilityWhere = (workspaceId: string) =>
  or(
    and(
      eq(uApps.visibility, 'public'),
      eq(uApps.reviewStatus, 'approved'),
      eq(uApps.isActive, true),
      isNull(uApps.deletedAt),
    ),
    and(eq(uApps.ownerWorkspaceId, workspaceId), isNull(uApps.deletedAt)),
  );

app.get('/store', requirePermission('weldapps:read'), async (c) => {
  const master = getMasterDb(c.env);
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');

  try {
    const apps = await master
      .select()
      .from(uApps)
      .where(storeVisibilityWhere(workspaceId))
      .orderBy(desc(uApps.createdAt), desc(uApps.id));

    const tenantRows = await db
      .select()
      .from(wsApps)
      .where(and(eq(wsApps.appType, 'user'), isNull(wsApps.deletedAt)));
    const tenantByAppId = new Map<string, (typeof tenantRows)[number]>();
    for (const row of tenantRows) if (row.userAppId) tenantByAppId.set(row.userAppId, row);

    const appIds = apps.map((a) => a.id);
    const installs = appIds.length
      ? await master
          .select()
          .from(uInstalls)
          .where(and(eq(uInstalls.workspaceId, workspaceId), inArray(uInstalls.appId, appIds)))
      : [];
    const installByAppId = new Map<string, (typeof installs)[number]>();
    for (const install of installs) installByAppId.set(install.appId, install);

    const data = apps.map((a) => {
      const tenantRow = tenantByAppId.get(a.id);
      const install = installByAppId.get(a.id);
      return {
        ...a,
        isInstalled: Boolean(tenantRow?.isActive) && install?.status === 'active',
        pendingScopes: install?.status === 'active' ? (install.pendingScopes ?? null) : null,
      };
    });
    return list(c, data, cursorPagination(data.length, false, null));
  } catch (err) {
    console.error('[app-api/user-apps] store list failed:', err);
    return error.internal(c, 'Failed to list app store');
  }
});

// ============================================================================
// GET /store/:code — store detail
// ============================================================================

app.get('/store/:code', requirePermission('weldapps:read'), async (c) => {
  const master = getMasterDb(c.env);
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const code = c.req.param('code');

  try {
    const [row] = await master
      .select()
      .from(uApps)
      .where(and(eq(uApps.code, code), storeVisibilityWhere(workspaceId)))
      .limit(1);
    if (!row) return error.notFound(c, 'App', code);

    const [tenantRow] = await db
      .select()
      .from(wsApps)
      .where(and(eq(wsApps.userAppId, row.id), isNull(wsApps.deletedAt)))
      .limit(1);
    const [install] = await master
      .select()
      .from(uInstalls)
      .where(and(eq(uInstalls.appId, row.id), eq(uInstalls.workspaceId, workspaceId)))
      .limit(1);

    return success(c, {
      ...row,
      isInstalled: Boolean(tenantRow?.isActive) && install?.status === 'active',
      pendingScopes: install?.status === 'active' ? (install.pendingScopes ?? null) : null,
    });
  } catch (err) {
    console.error('[app-api/user-apps] store detail failed:', err);
    return error.internal(c, 'Failed to fetch app');
  }
});

// ============================================================================
// GET /installed — user apps installed in this workspace (sidenav + iframe host)
// ============================================================================

app.get('/installed', requirePermission('weldapps:read'), async (c) => {
  const master = getMasterDb(c.env);
  const db = c.get('tenantDb');

  try {
    const tenantRows = await db
      .select()
      .from(wsApps)
      .where(and(eq(wsApps.appType, 'user'), eq(wsApps.isActive, true), isNull(wsApps.deletedAt)));

    const appIds = tenantRows.map((r) => r.userAppId).filter((id): id is string => Boolean(id));
    const apps = appIds.length
      ? await master.select().from(uApps).where(inArray(uApps.id, appIds))
      : [];
    const appById = new Map<string, (typeof apps)[number]>();
    for (const a of apps) appById.set(a.id, a);

    const data = tenantRows.flatMap((row) => {
      const appRow = row.userAppId ? appById.get(row.userAppId) : undefined;
      if (!appRow || appRow.deletedAt || !appRow.isActive) return [];
      return [
        {
          ...row,
          app: {
            id: appRow.id,
            code: appRow.code,
            name: appRow.name,
            description: appRow.description,
            icon: appRow.icon,
            category: appRow.category,
            manifest: appRow.manifest,
            currentVersionId: appRow.currentVersionId,
          },
        },
      ];
    });
    return list(c, data, cursorPagination(data.length, false, null));
  } catch (err) {
    console.error('[app-api/user-apps] installed list failed:', err);
    return error.internal(c, 'Failed to list installed apps');
  }
});

// ============================================================================
// GET /developer-account — Stripe Connect payout account (read-only here)
// ============================================================================

app.get('/developer-account', requirePermission('weldapps:develop'), async (c) => {
  const master = getMasterDb(c.env);
  const workspaceId = c.get('workspaceId');
  try {
    const [row] = await master
      .select()
      .from(masterSchema.appDeveloperAccounts)
      .where(eq(masterSchema.appDeveloperAccounts.workspaceId, workspaceId))
      .limit(1);
    return success(c, row ?? null);
  } catch (err) {
    console.error('[app-api/user-apps] developer-account failed:', err);
    return error.internal(c, 'Failed to fetch developer account');
  }
});

// ============================================================================
// POST /code/:code/session-token — short-lived token for the iframe bridge
// ============================================================================

app.post('/code/:code/session-token', requirePermission('weldapps:read'), async (c) => {
  const master = getMasterDb(c.env);
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const code = c.req.param('code');

  try {
    const [appRow] = await master
      .select()
      .from(uApps)
      .where(and(eq(uApps.code, code), eq(uApps.isActive, true), isNull(uApps.deletedAt)))
      .limit(1);
    if (!appRow) return error.notFound(c, 'App', code);

    const [tenantRow] = await db
      .select()
      .from(wsApps)
      .where(
        and(
          eq(wsApps.appCode, code),
          eq(wsApps.appType, 'user'),
          eq(wsApps.isActive, true),
          isNull(wsApps.deletedAt),
        ),
      )
      .limit(1);
    if (!tenantRow) return error.notFound(c, 'App install', code);

    const [install] = await master
      .select()
      .from(uInstalls)
      .where(
        and(
          eq(uInstalls.appId, appRow.id),
          eq(uInstalls.workspaceId, workspaceId),
          eq(uInstalls.status, 'active'),
        ),
      )
      .limit(1);
    if (!install) return error.notFound(c, 'App install', code);

    const { token, expiresAt } = await mintAppToken(master, {
      installId: install.id,
      appId: appRow.id,
      workspaceId,
      tokenType: 'session',
      scopes: install.grantedScopes ?? [],
    });

    return success(c, {
      token,
      expiresAt,
      apiBaseUrl: c.env.EXTERNAL_API_URL || 'https://api.weldsuite.org',
    });
  } catch (err) {
    console.error('[app-api/user-apps] session-token failed:', err);
    return error.internal(c, 'Failed to mint session token');
  }
});

// ============================================================================
// GET /:id — detail (owner workspace only)
// ============================================================================

app.get('/:id', requirePermission('weldapps:read'), async (c) => {
  const master = getMasterDb(c.env);
  const id = c.req.param('id');
  try {
    const appRow = await getOwnedApp(master, id, c.get('workspaceId'));
    if (!appRow) return error.notFound(c, 'App', id);
    return success(c, appRow);
  } catch (err) {
    console.error('[app-api/user-apps] get failed:', err);
    return error.internal(c, 'Failed to fetch app');
  }
});

// ============================================================================
// PATCH /:id — update metadata (owner only)
// ============================================================================

app.patch('/:id', requirePermission('weldapps:develop'), zValidator('json', updateUserAppSchema), async (c) => {
  const master = getMasterDb(c.env);
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const appRow = await getOwnedApp(master, id, c.get('workspaceId'));
    if (!appRow) return error.notFound(c, 'App', id);

    const update: Partial<typeof uApps.$inferInsert> = { updatedAt: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.description !== undefined) update.description = data.description;
    if (data.icon !== undefined) update.icon = data.icon;
    if (data.category !== undefined) update.category = data.category;
    if (data.isActive !== undefined) update.isActive = data.isActive;
    const [updated] = await master
      .update(uApps)
      .set(update)
      .where(eq(uApps.id, id))
      .returning();

    publishEntityEvent({
      c,
      entityType: 'user_app',
      action: 'updated',
      entityId: id,
      data: updated as unknown as Record<string, unknown>,
    });
    if (data.isActive !== undefined) await invalidateAssetCache(c, appRow.code);
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/user-apps] update failed:', err);
    return error.internal(c, 'Failed to update app');
  }
});

// ============================================================================
// DELETE /:id — soft delete (refused while other workspaces have it installed)
// ============================================================================

app.delete('/:id', requirePermission('weldapps:develop'), async (c) => {
  const master = getMasterDb(c.env);
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  try {
    const appRow = await getOwnedApp(master, id, workspaceId);
    if (!appRow) return error.notFound(c, 'App', id);

    const [foreign] = await master
      .select({ count: sql<number>`count(*)` })
      .from(uInstalls)
      .where(
        and(
          eq(uInstalls.appId, id),
          eq(uInstalls.status, 'active'),
          ne(uInstalls.workspaceId, workspaceId),
        ),
      );
    if (Number(foreign?.count ?? 0) > 0) {
      return error.conflict(c, 'App is still installed in other workspaces');
    }

    const now = new Date();
    await master
      .update(uApps)
      .set({ deletedAt: now, isActive: false, updatedAt: now })
      .where(eq(uApps.id, id));
    await master
      .update(uInstalls)
      .set({ status: 'revoked', revokedAt: now, updatedAt: now })
      .where(and(eq(uInstalls.appId, id), eq(uInstalls.status, 'active')));
    await master
      .update(uTokens)
      .set({ revokedAt: now })
      .where(and(eq(uTokens.appId, id), isNull(uTokens.revokedAt)));
    await db
      .update(wsApps)
      .set({ deletedAt: now, isActive: false, updatedAt: now })
      .where(and(eq(wsApps.userAppId, id), isNull(wsApps.deletedAt)));

    publishEntityEvent({
      c,
      entityType: 'user_app',
      action: 'deleted',
      entityId: id,
      data: { id, code: appRow.code, name: appRow.name },
    });
    await invalidateAssetCache(c, appRow.code);
    return noContent(c);
  } catch (err) {
    console.error('[app-api/user-apps] delete failed:', err);
    return error.internal(c, 'Failed to delete app');
  }
});

// ============================================================================
// GET /:id/versions — version history (owner only)
// ============================================================================

app.get('/:id/versions', requirePermission('weldapps:read'), async (c) => {
  const master = getMasterDb(c.env);
  const id = c.req.param('id');
  try {
    const appRow = await getOwnedApp(master, id, c.get('workspaceId'));
    if (!appRow) return error.notFound(c, 'App', id);
    const rows = await master
      .select()
      .from(uVersions)
      .where(eq(uVersions.appId, id))
      .orderBy(desc(uVersions.createdAt), desc(uVersions.id));
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    console.error('[app-api/user-apps] versions list failed:', err);
    return error.internal(c, 'Failed to list versions');
  }
});

// ============================================================================
// POST /:id/versions — upload a bundle version (multipart)
// ============================================================================

app.post('/:id/versions', requirePermission('weldapps:develop'), async (c) => {
  const master = getMasterDb(c.env);
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const id = c.req.param('id');

  try {
    const appRow = await getOwnedApp(master, id, workspaceId);
    if (!appRow) return error.notFound(c, 'App', id);
    if (!c.env.STORAGE) return error.internal(c, 'Storage is not configured');

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return error.badRequest(c, 'Expected multipart/form-data');
    }

    const manifestRaw = form.get('manifest');
    if (typeof manifestRaw !== 'string') {
      return error.badRequest(c, "Missing 'manifest' field (JSON string)");
    }
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestRaw);
    } catch {
      return error.badRequest(c, "Field 'manifest' is not valid JSON");
    }
    const parsed = userAppManifestSchema.safeParse(manifestJson);
    if (!parsed.success) {
      return error.badRequest(c, 'Invalid manifest', parsed.error.flatten());
    }
    const manifest = parsed.data;
    if (manifest.code !== appRow.code) {
      return error.badRequest(c, `Manifest code '${manifest.code}' does not match app code '${appRow.code}'`);
    }
    const changelogRaw = form.get('changelog');
    const changelog = typeof changelogRaw === 'string' && changelogRaw ? changelogRaw : null;

    // workers-types types FormData entries as string; multipart file parts are File at runtime
    const files = (form.getAll('files') as unknown as (string | File)[]).filter(
      (f): f is File => typeof f !== 'string',
    );
    if (files.length === 0) return error.badRequest(c, 'At least one bundle file is required');
    if (files.length > MAX_BUNDLE_FILES) {
      return error.badRequest(c, `Bundle exceeds the ${MAX_BUNDLE_FILES}-file limit`);
    }
    const bundleSize = files.reduce((sum, f) => sum + f.size, 0);
    if (bundleSize > MAX_BUNDLE_BYTES) {
      return error.badRequest(c, `Bundle exceeds the ${MAX_BUNDLE_BYTES / (1024 * 1024)}MB size limit`);
    }
    const seen = new Set<string>();
    for (const f of files) {
      if (!isSafeBundlePath(f.name)) return error.badRequest(c, `Invalid bundle file path: '${f.name}'`);
      if (seen.has(f.name)) return error.badRequest(c, `Duplicate bundle file path: '${f.name}'`);
      seen.add(f.name);
    }

    const [dupe] = await master
      .select({ id: uVersions.id })
      .from(uVersions)
      .where(and(eq(uVersions.appId, id), eq(uVersions.version, manifest.version)))
      .limit(1);
    if (dupe) return error.conflict(c, `Version ${manifest.version} already exists`);

    const versionId = generateId('uav');
    const bundleKey = `user-apps/${appRow.id}/${versionId}`;
    for (const f of files) {
      await c.env.STORAGE.put(`${bundleKey}/${f.name}`, f, {
        httpMetadata: { contentType: contentTypeFor(f.name) ?? (f.type || 'application/octet-stream') },
      });
    }

    const [version] = await master
      .insert(uVersions)
      .values({
        id: versionId,
        appId: appRow.id,
        version: manifest.version,
        manifest,
        requestedScopes: manifest.scopes ?? [],
        bundleKey,
        entrypoint: manifest.entrypoint || 'index.html',
        bundleSize,
        fileCount: files.length,
        status: 'draft',
        changelog,
        createdBy: userId,
      })
      .returning();

    // Public apps that already passed review must be re-reviewed before the
    // new version goes live; everything else publishes immediately.
    const reviewGate = appRow.visibility === 'public' && appRow.reviewStatus === 'approved';
    if (reviewGate) {
      await master
        .update(uApps)
        .set({ reviewStatus: 'submitted', updatedAt: new Date() })
        .where(eq(uApps.id, appRow.id));
      publishEntityEvent({
        c,
        entityType: 'user_app',
        action: 'updated',
        entityId: appRow.id,
        data: { id: appRow.id, code: appRow.code, versionId, reviewStatus: 'submitted' },
      });
    } else {
      const { installsNeedingConsent } = await publishAppVersion(master, appRow, version);
      // Mirror the owner workspace's tenant row (other tenants sync lazily —
      // pendingScopes stays master-side; the tenant row keeps the granted copy).
      const ownerPending = installsNeedingConsent.find((i) => i.workspaceId === workspaceId);
      if (ownerPending) {
        const [ownerInstall] = await master
          .select({ grantedScopes: uInstalls.grantedScopes })
          .from(uInstalls)
          .where(eq(uInstalls.id, ownerPending.installId))
          .limit(1);
        await db
          .update(wsApps)
          .set({ grantedScopes: ownerInstall?.grantedScopes ?? [], updatedAt: new Date() })
          .where(and(eq(wsApps.userAppId, appRow.id), isNull(wsApps.deletedAt)));
      }
      publishEntityEvent({
        c,
        entityType: 'user_app',
        action: 'published',
        entityId: appRow.id,
        data: { id: appRow.id, code: appRow.code, versionId, version: manifest.version },
      });
    }

    await invalidateAssetCache(c, appRow.code);
    return success(c, version, 201);
  } catch (err) {
    console.error('[app-api/user-apps] version upload failed:', err);
    return error.internal(c, 'Failed to upload version');
  }
});

// ============================================================================
// POST /:id/submit — submit for public-store review
// ============================================================================

app.post('/:id/submit', requirePermission('weldapps:publish'), zValidator('json', submitUserAppSchema), async (c) => {
  const master = getMasterDb(c.env);
  const id = c.req.param('id');
  const { notes } = c.req.valid('json');
  try {
    const appRow = await getOwnedApp(master, id, c.get('workspaceId'));
    if (!appRow) return error.notFound(c, 'App', id);

    const [version] = await master
      .select({ id: uVersions.id })
      .from(uVersions)
      .where(eq(uVersions.appId, id))
      .limit(1);
    if (!version) return error.badRequest(c, 'Upload a version before submitting for review');

    const [updated] = await master
      .update(uApps)
      .set({
        visibility: 'public',
        reviewStatus: 'submitted',
        ...(notes ? { reviewNotes: notes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(uApps.id, id))
      .returning();

    publishEntityEvent({
      c,
      entityType: 'user_app',
      action: 'updated',
      entityId: id,
      data: updated as unknown as Record<string, unknown>,
    });
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/user-apps] submit failed:', err);
    return error.internal(c, 'Failed to submit app for review');
  }
});

// ============================================================================
// POST /:id/review — approve / reject (PLATFORM STAFF only)
// ============================================================================

app.post('/:id/review', zValidator('json', reviewUserAppSchema), async (c) => {
  const master = getMasterDb(c.env);
  const userId = c.get('userId');
  const id = c.req.param('id');
  const { decision, notes } = c.req.valid('json');

  try {
    const [admin] = await master
      .select({ id: masterSchema.adminUsers.id })
      .from(masterSchema.adminUsers)
      .where(and(eq(masterSchema.adminUsers.userId, userId), eq(masterSchema.adminUsers.isActive, true)))
      .limit(1);
    if (!admin) return error.forbidden(c, 'Platform staff only');

    const [appRow] = await master
      .select()
      .from(uApps)
      .where(and(eq(uApps.id, id), isNull(uApps.deletedAt)))
      .limit(1);
    if (!appRow) return error.notFound(c, 'App', id);

    const now = new Date();
    if (decision === 'approved') {
      await master
        .update(uApps)
        .set({
          reviewStatus: 'approved',
          reviewNotes: notes ?? null,
          reviewedBy: userId,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(eq(uApps.id, id));

      const [candidate] = await master
        .select()
        .from(uVersions)
        .where(and(eq(uVersions.appId, id), inArray(uVersions.status, ['draft', 'submitted'])))
        .orderBy(desc(uVersions.createdAt), desc(uVersions.id))
        .limit(1);
      if (candidate) {
        // Same live-publish block as the upload route — supersede, move
        // currentVersionId, refresh app columns, queue pendingScopes on
        // installs. Tenant rows sync lazily (the reviewer's tenant DB is not
        // the owner's).
        await publishAppVersion(master, appRow, candidate);
      }
      await invalidateAssetCache(c, appRow.code);
    } else {
      await master
        .update(uApps)
        .set({
          reviewStatus: 'rejected',
          reviewNotes: notes ?? null,
          reviewedBy: userId,
          reviewedAt: now,
          updatedAt: now,
        })
        .where(eq(uApps.id, id));
    }

    const [updated] = await master.select().from(uApps).where(eq(uApps.id, id)).limit(1);
    publishEntityEvent({
      c,
      entityType: 'user_app',
      action: 'updated',
      entityId: id,
      data: updated as unknown as Record<string, unknown>,
    });
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/user-apps] review failed:', err);
    return error.internal(c, 'Failed to review app');
  }
});

// ============================================================================
// POST /:id/install — install into the calling workspace
// ============================================================================

app.post('/:id/install', requirePermission('weldapps:manage'), zValidator('json', installUserAppSchema), async (c) => {
  const master = getMasterDb(c.env);
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  const id = c.req.param('id');
  const { grantedScopes } = c.req.valid('json');

  try {
    const [appRow] = await master
      .select()
      .from(uApps)
      .where(and(eq(uApps.id, id), isNull(uApps.deletedAt)))
      .limit(1);
    if (!appRow || !isInstallableHere(appRow, workspaceId)) return error.notFound(c, 'App', id);

    const requested = appRow.requestedScopes ?? [];
    if (!isScopeSuperset(grantedScopes, requested)) {
      return error.conflict(c, 'grantedScopes must cover all scopes requested by the app');
    }

    const [existing] = await master
      .select()
      .from(uInstalls)
      .where(and(eq(uInstalls.appId, id), eq(uInstalls.workspaceId, workspaceId)))
      .limit(1);

    // Paid gate — foreign subscription apps need an active/trialing sub first.
    if (appRow.pricingType === 'subscription' && appRow.ownerWorkspaceId !== workspaceId) {
      const sub = existing?.subscriptionStatus;
      if (!sub || !['active', 'trialing'].includes(sub)) {
        return c.json(
          {
            error: {
              code: 'SUBSCRIPTION_REQUIRED',
              message: 'This app requires an active subscription',
              details: { appId: id, priceMonthly: appRow.priceMonthly, currency: appRow.currency },
            },
          },
          402,
        );
      }
    }

    const now = new Date();
    let install: typeof uInstalls.$inferSelect;
    if (existing) {
      const [revived] = await master
        .update(uInstalls)
        .set({
          status: 'active',
          grantedScopes,
          pendingScopes: null,
          installedBy: userId,
          installedAt: now,
          revokedAt: null,
          updatedAt: now,
        })
        .where(eq(uInstalls.id, existing.id))
        .returning();
      install = revived;
    } else {
      const [created] = await master
        .insert(uInstalls)
        .values({
          id: generateId('uai'),
          appId: id,
          workspaceId,
          status: 'active',
          grantedScopes,
          installedBy: userId,
          installedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      install = created;
    }

    const { token } = await mintAppToken(master, {
      installId: install.id,
      appId: id,
      workspaceId,
      tokenType: 'install',
      scopes: grantedScopes,
    });

    const [tenantRow] = await db
      .select()
      .from(wsApps)
      .where(eq(wsApps.appCode, appRow.code))
      .limit(1);
    if (tenantRow) {
      await db
        .update(wsApps)
        .set({
          appType: 'user',
          userAppId: appRow.id,
          grantedScopes,
          isActive: true,
          installedBy: userId,
          installedAt: now,
          deletedAt: null,
          updatedAt: now,
        })
        .where(eq(wsApps.id, tenantRow.id));
    } else {
      await db.insert(wsApps).values({
        id: generateId('wsapp'),
        appCode: appRow.code,
        appType: 'user',
        userAppId: appRow.id,
        grantedScopes,
        isActive: true,
        installedBy: userId,
        installedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Fresh installs and revived (previously revoked) installs count.
    if (!existing || existing.status === 'revoked') {
      await master
        .update(uApps)
        .set({ installCount: sql`${uApps.installCount} + 1`, updatedAt: now })
        .where(eq(uApps.id, id));
    }

    publishEntityEvent({
      c,
      entityType: 'user_app',
      action: 'installed',
      entityId: id,
      data: { id, code: appRow.code, name: appRow.name, installId: install.id, grantedScopes },
    });
    return success(c, { install, token }, 201);
  } catch (err) {
    console.error('[app-api/user-apps] install failed:', err);
    return error.internal(c, 'Failed to install app');
  }
});

// ============================================================================
// DELETE /:id/install — uninstall from the calling workspace
// ============================================================================

app.delete('/:id/install', requirePermission('weldapps:manage'), async (c) => {
  const master = getMasterDb(c.env);
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');

  try {
    const [install] = await master
      .select()
      .from(uInstalls)
      .where(
        and(eq(uInstalls.appId, id), eq(uInstalls.workspaceId, workspaceId), eq(uInstalls.status, 'active')),
      )
      .limit(1);
    if (!install) return error.notFound(c, 'App install', id);

    const now = new Date();
    await master
      .update(uInstalls)
      .set({ status: 'revoked', revokedAt: now, updatedAt: now })
      .where(eq(uInstalls.id, install.id));
    await master
      .update(uTokens)
      .set({ revokedAt: now })
      .where(and(eq(uTokens.installId, install.id), isNull(uTokens.revokedAt)));
    await db
      .update(wsApps)
      .set({ isActive: false, deletedAt: now, updatedAt: now })
      .where(and(eq(wsApps.userAppId, id), isNull(wsApps.deletedAt)));
    await master
      .update(uApps)
      .set({ installCount: sql`GREATEST(${uApps.installCount} - 1, 0)`, updatedAt: now })
      .where(eq(uApps.id, id));

    publishEntityEvent({
      c,
      entityType: 'user_app',
      action: 'uninstalled',
      entityId: id,
      data: { id, installId: install.id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/user-apps] uninstall failed:', err);
    return error.internal(c, 'Failed to uninstall app');
  }
});

// ============================================================================
// POST /:id/consent — approve pending scopes after an update requested more
// ============================================================================

app.post('/:id/consent', requirePermission('weldapps:manage'), zValidator('json', consentUserAppScopesSchema), async (c) => {
  const master = getMasterDb(c.env);
  const db = c.get('tenantDb');
  const workspaceId = c.get('workspaceId');
  const id = c.req.param('id');
  const { approvedScopes } = c.req.valid('json');

  try {
    const [install] = await master
      .select()
      .from(uInstalls)
      .where(
        and(eq(uInstalls.appId, id), eq(uInstalls.workspaceId, workspaceId), eq(uInstalls.status, 'active')),
      )
      .limit(1);
    if (!install) return error.notFound(c, 'App install', id);

    const pending = install.pendingScopes ?? [];
    if (!approvedScopes.every((s) => pending.includes(s))) {
      return error.badRequest(c, 'approvedScopes must be a subset of the pending scopes');
    }

    const grantedScopes = unionScopes(install.grantedScopes ?? [], approvedScopes);
    const remainder = diffScopes(pending, approvedScopes);
    const now = new Date();

    const [updated] = await master
      .update(uInstalls)
      .set({
        grantedScopes,
        pendingScopes: remainder.length > 0 ? remainder : null,
        updatedAt: now,
      })
      .where(eq(uInstalls.id, install.id))
      .returning();

    await master
      .update(uTokens)
      .set({ scopes: grantedScopes })
      .where(and(eq(uTokens.installId, install.id), isNull(uTokens.revokedAt)));
    await db
      .update(wsApps)
      .set({ grantedScopes, updatedAt: now })
      .where(and(eq(wsApps.userAppId, id), isNull(wsApps.deletedAt)));

    publishEntityEvent({
      c,
      entityType: 'user_app',
      action: 'updated',
      entityId: id,
      data: { id, installId: install.id, grantedScopes, pendingScopes: updated.pendingScopes },
    });
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/user-apps] consent failed:', err);
    return error.internal(c, 'Failed to record consent');
  }
});

// ============================================================================
// OAuth client — create-or-rotate (secret shown once) + read
// ============================================================================

app.post('/:id/oauth-client', requirePermission('weldapps:develop'), async (c) => {
  const master = getMasterDb(c.env);
  const id = c.req.param('id');
  try {
    const appRow = await getOwnedApp(master, id, c.get('workspaceId'));
    if (!appRow) return error.notFound(c, 'App', id);

    const clientSecret = `wacs_${randomHex(20)}`;
    const clientSecretHash = await sha256Hex(clientSecret);
    const now = new Date();

    const [existing] = await master
      .select()
      .from(uOauthClients)
      .where(eq(uOauthClients.appId, id))
      .limit(1);

    if (existing) {
      // Rotate: keep the clientId, replace the secret.
      await master
        .update(uOauthClients)
        .set({ clientSecretHash, updatedAt: now })
        .where(eq(uOauthClients.id, existing.id));
      publishEntityEvent({
        c,
        entityType: 'user_app',
        action: 'updated',
        entityId: appRow.id,
        data: { event: 'oauth_client_rotated', clientId: existing.clientId },
      });
      return success(c, { clientId: existing.clientId, clientSecret });
    }

    const clientId = `wac_${randomHex(12)}`;
    await master.insert(uOauthClients).values({
      id: generateId('uaoc'),
      appId: id,
      clientId,
      clientSecretHash,
      createdAt: now,
      updatedAt: now,
    });
    publishEntityEvent({
      c,
      entityType: 'user_app',
      action: 'updated',
      entityId: appRow.id,
      data: { event: 'oauth_client_created', clientId },
    });
    return success(c, { clientId, clientSecret }, 201);
  } catch (err) {
    console.error('[app-api/user-apps] oauth-client create failed:', err);
    return error.internal(c, 'Failed to create OAuth client');
  }
});

app.get('/:id/oauth-client', requirePermission('weldapps:develop'), async (c) => {
  const master = getMasterDb(c.env);
  const id = c.req.param('id');
  try {
    const appRow = await getOwnedApp(master, id, c.get('workspaceId'));
    if (!appRow) return error.notFound(c, 'App', id);
    const [client] = await master
      .select({ clientId: uOauthClients.clientId, createdAt: uOauthClients.createdAt })
      .from(uOauthClients)
      .where(eq(uOauthClients.appId, id))
      .limit(1);
    if (!client) return error.notFound(c, 'OAuth client', id);
    return success(c, client);
  } catch (err) {
    console.error('[app-api/user-apps] oauth-client get failed:', err);
    return error.internal(c, 'Failed to fetch OAuth client');
  }
});

export const userAppsRoutes = app;
