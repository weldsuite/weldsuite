/**
 * Developer routes for user-created apps (WeldApps) — the weld CLI's API.
 *
 * All routes require a workspace or personal API key (`wsk_`) holding the
 * `user-apps:manage` scope; app tokens (`wsat_`) are rejected. The single
 * exception is GET /agent-tools, which is discovery for WeldAgent / the MCP
 * server and accepts both key kinds.
 *
 * App/version/install rows live in the MASTER database (public apps are
 * cross-workspace); bundles are static files in R2.
 */

import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  createUserAppSchema,
  submitUserAppSchema,
  updateUserAppSchema,
  upsertUserAppDevSessionSchema,
  userAppManifestSchema,
  isAllowedDevSessionUrl,
  DEV_SESSION_TTL_MS,
} from '@weldsuite/app-api-client/schemas/user-apps';
import type { HonoEnv } from '../../types';
import { hasScope } from '../../lib/scopes';
import { generateId } from '../../lib/id';
import { createMasterDb, masterSchema, type MasterDatabase } from '../../lib/master-db';
import { schema as tenantSchema } from '../../db';
import { error, list, noContent, success, cursorPagination } from '../../lib/response';

/** SHA-256 hex digest via Web Crypto (native to Workers). */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

const app = new Hono<HonoEnv>();

/** Codes that collide with first-party modules / platform routes.
 * Community apps cannot claim these; official publisher workspaces can
 * (so first-party hosted WeldApps like `weldcommerce` can register). */
const RESERVED_CODES = new Set([
  'weldcrm',
  'weldcommerce',
  'welddesk',
  'weldmail',
  'weldflow',
  'weldconnect',
  'weldstash',
  'weldhost',
  'weldbooks',
  'weldmeet',
  'weldchat',
  'weldagent',
  'weldapps',
  'appstore',
  'settings',
  'apps',
]);

const MAX_BUNDLE_FILES = 500;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024; // 50 MB

/** Content types for bundle files, by extension. */
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xml: 'application/xml',
  wasm: 'application/wasm',
};

function contentTypeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function isOfficialPublisher(env: { WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS?: string }, workspaceId: string): boolean {
  const raw = env.WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS ?? '';
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(workspaceId);
}

/**
 * Normalize a bundle-relative path and reject traversal. Returns null when
 * the path is unsafe or empty.
 */
function sanitizeBundlePath(raw: string): string | null {
  const path = raw.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (!path || path.length > 255) return null;
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return path;
}

// ============================================================================
// Agent tools discovery — wsk_ AND wsat_ (registered before the developer
// gate below so app tokens can discover the tools available in a workspace).
// ============================================================================

app.get('/agent-tools', async (c) => {
  const session = c.get('apiSession');
  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);

  // Workspace/personal keys (WeldAgent, the MCP server) discover every
  // installed app's tools. An app's own token is scoped to itself — one app
  // must not see another app's manifest or granted scopes.
  const conditions = [
    eq(masterSchema.userAppInstalls.workspaceId, session.workspaceId),
    eq(masterSchema.userAppInstalls.status, 'active'),
    eq(masterSchema.userApps.isActive, true),
    isNull(masterSchema.userApps.deletedAt),
  ];
  if (session.keyType === 'app' && session.appId) {
    conditions.push(eq(masterSchema.userAppInstalls.appId, session.appId));
  }

  const rows = await masterDb
    .select({
      appCode: masterSchema.userApps.code,
      appName: masterSchema.userApps.name,
      manifest: masterSchema.userApps.manifest,
      grantedScopes: masterSchema.userAppInstalls.grantedScopes,
    })
    .from(masterSchema.userAppInstalls)
    .innerJoin(
      masterSchema.userApps,
      eq(masterSchema.userAppInstalls.appId, masterSchema.userApps.id),
    )
    .where(and(...conditions));

  const tools = rows.flatMap((row) =>
    (row.manifest?.agentTools ?? []).map((tool) => ({
      appCode: row.appCode,
      appName: row.appName,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      action: tool.action,
      grantedScopes: (row.grantedScopes as string[]) ?? [],
    })),
  );

  return success(c, tools);
});

// ============================================================================
// Developer gate — wsk_ keys with user-apps:manage only; app tokens get 403.
// ============================================================================

const requireDeveloperKey: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const session = c.get('apiSession');
  if (!session) return error.unauthorized(c);
  if (session.keyType === 'app') {
    return error.forbidden(
      c,
      'App tokens cannot access developer routes — use a workspace or personal API key',
    );
  }
  if (!hasScope(session.scopes, 'user-apps:manage')) {
    return error.forbidden(c, 'Missing required scope: user-apps:manage');
  }
  await next();
};

app.use('*', requireDeveloperKey);

/** Load an app owned by the session's workspace (null when absent/foreign). */
async function getOwnedApp(masterDb: MasterDatabase, id: string, workspaceId: string) {
  const [row] = await masterDb
    .select()
    .from(masterSchema.userApps)
    .where(
      and(
        eq(masterSchema.userApps.id, id),
        eq(masterSchema.userApps.ownerWorkspaceId, workspaceId),
        isNull(masterSchema.userApps.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ============================================================================
// CRUD
// ============================================================================

app.post('/', zValidator('json', createUserAppSchema), async (c) => {
  const session = c.get('apiSession');
  const body = c.req.valid('json');
  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);

  if (RESERVED_CODES.has(body.code) && !isOfficialPublisher(c.env, session.workspaceId)) {
    return error.conflict(c, `App code '${body.code}' is reserved`);
  }

  // Codes share a global namespace (sidenav + app store) — unique across
  // ALL workspaces, including soft-deleted apps (codes are not recycled).
  const [existing] = await masterDb
    .select({ id: masterSchema.userApps.id })
    .from(masterSchema.userApps)
    .where(eq(masterSchema.userApps.code, body.code))
    .limit(1);
  if (existing) {
    return error.conflict(c, `App code '${body.code}' is already taken`);
  }

  const now = new Date();
  const [row] = await masterDb
    .insert(masterSchema.userApps)
    .values({
      id: generateId('uapp'),
      code: body.code,
      name: body.name,
      description: body.description,
      ...(body.icon ? { icon: body.icon } : {}),
      ...(body.category ? { category: body.category } : {}),
      ...(body.websiteUrl ? { websiteUrl: body.websiteUrl } : {}),
      ...(body.privacyUrl ? { privacyUrl: body.privacyUrl } : {}),
      ...(body.screenshots ? { screenshots: body.screenshots } : {}),
      ...(body.webhookUrl ? { webhookUrl: body.webhookUrl } : {}),
      ownerWorkspaceId: session.workspaceId,
      createdBy: session.userId ?? session.keyId,
      publisherType: isOfficialPublisher(c.env, session.workspaceId) ? 'weldsuite' : 'community',
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) return error.internal(c, 'Failed to create app');
  return success(c, row, 201);
});

app.get('/', async (c) => {
  const session = c.get('apiSession');
  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);
  const rows = await masterDb
    .select()
    .from(masterSchema.userApps)
    .where(
      and(
        eq(masterSchema.userApps.ownerWorkspaceId, session.workspaceId),
        isNull(masterSchema.userApps.deletedAt),
      ),
    )
    .orderBy(desc(masterSchema.userApps.createdAt), desc(masterSchema.userApps.id));
  return list(c, rows, cursorPagination(rows.length, false, null));
});

app.get('/:id', async (c) => {
  const session = c.get('apiSession');
  const id = c.req.param('id');
  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);
  const appRow = await getOwnedApp(masterDb, id, session.workspaceId);
  if (!appRow) return error.notFound(c, 'App', id);
  return success(c, appRow);
});

app.patch('/:id', zValidator('json', updateUserAppSchema), async (c) => {
  const session = c.get('apiSession');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);

  const appRow = await getOwnedApp(masterDb, id, session.workspaceId);
  if (!appRow) return error.notFound(c, 'App', id);

  const update: Partial<typeof masterSchema.userApps.$inferInsert> = { updatedAt: new Date() };
  if (data.name !== undefined) update.name = data.name;
  if (data.description !== undefined) update.description = data.description;
  if (data.icon !== undefined) update.icon = data.icon;
  if (data.category !== undefined) update.category = data.category;
  if (data.isActive !== undefined) update.isActive = data.isActive;
  if (data.websiteUrl !== undefined) update.websiteUrl = data.websiteUrl;
  if (data.privacyUrl !== undefined) update.privacyUrl = data.privacyUrl;
  if (data.screenshots !== undefined) update.screenshots = data.screenshots;
  if (data.webhookUrl !== undefined) update.webhookUrl = data.webhookUrl;

  const [updated] = await masterDb
    .update(masterSchema.userApps)
    .set(update)
    .where(eq(masterSchema.userApps.id, id))
    .returning();
  if (!updated) return error.internal(c, 'Failed to update app');
  return success(c, updated);
});

app.delete('/:id', async (c) => {
  const session = c.get('apiSession');
  const id = c.req.param('id');
  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);
  const db = c.get('tenantDb');

  const appRow = await getOwnedApp(masterDb, id, session.workspaceId);
  if (!appRow) return error.notFound(c, 'App', id);

  const [foreign] = await masterDb
    .select({ count: sql<number>`count(*)` })
    .from(masterSchema.userAppInstalls)
    .where(
      and(
        eq(masterSchema.userAppInstalls.appId, id),
        eq(masterSchema.userAppInstalls.status, 'active'),
        ne(masterSchema.userAppInstalls.workspaceId, session.workspaceId),
      ),
    );
  if (Number(foreign?.count ?? 0) > 0) {
    return error.conflict(c, 'App is still installed in other workspaces');
  }

  const now = new Date();
  await masterDb
    .update(masterSchema.userApps)
    .set({ deletedAt: now, isActive: false, updatedAt: now })
    .where(eq(masterSchema.userApps.id, id));
  await masterDb
    .update(masterSchema.userAppInstalls)
    .set({ status: 'revoked', revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(masterSchema.userAppInstalls.appId, id),
        eq(masterSchema.userAppInstalls.status, 'active'),
      ),
    );
  await masterDb
    .update(masterSchema.userAppTokens)
    .set({ revokedAt: now })
    .where(
      and(eq(masterSchema.userAppTokens.appId, id), isNull(masterSchema.userAppTokens.revokedAt)),
    );

  const wsApps = tenantSchema.workspaceInstalledApps;
  await db
    .update(wsApps)
    .set({ deletedAt: now, isActive: false, updatedAt: now })
    .where(and(eq(wsApps.userAppId, id), isNull(wsApps.deletedAt)));

  return noContent(c);
});

// ============================================================================
// Versions — list + multipart bundle upload (weld CLI)
// ============================================================================

app.get('/:id/versions', async (c) => {
  const session = c.get('apiSession');
  const id = c.req.param('id');
  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);

  const appRow = await getOwnedApp(masterDb, id, session.workspaceId);
  if (!appRow) return error.notFound(c, 'App', id);

  const rows = await masterDb
    .select()
    .from(masterSchema.userAppVersions)
    .where(eq(masterSchema.userAppVersions.appId, id))
    .orderBy(desc(masterSchema.userAppVersions.createdAt), desc(masterSchema.userAppVersions.id));
  return list(c, rows, cursorPagination(rows.length, false, null));
});

app.post('/:id/versions', async (c) => {
  const session = c.get('apiSession');
  const id = c.req.param('id');
  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);

  const appRow = await getOwnedApp(masterDb, id, session.workspaceId);
  if (!appRow) return error.notFound(c, 'App', id);

  const storage = c.env.STORAGE;
  if (!storage) return error.internal(c, 'Bundle storage is not configured');

  // multipart/form-data: 'manifest' JSON string, optional 'changelog',
  // repeated 'files' entries whose File.name is the bundle-relative path.
  let form: Record<string, string | File | (string | File)[]>;
  try {
    form = await c.req.parseBody({ all: true });
  } catch {
    return error.badRequest(c, 'Expected multipart/form-data');
  }

  const rawManifest = form['manifest'];
  if (typeof rawManifest !== 'string') {
    return error.badRequest(c, "A 'manifest' field with the weldapp.json contents is required");
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(rawManifest);
  } catch {
    return error.badRequest(c, 'manifest must be valid JSON');
  }
  const parsed = userAppManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    return error.badRequest(c, 'Invalid manifest', parsed.error.flatten());
  }
  const manifest = parsed.data;
  if (manifest.code !== appRow.code) {
    return error.badRequest(
      c,
      `Manifest code '${manifest.code}' does not match app code '${appRow.code}'`,
    );
  }

  const changelogRaw = form['changelog'];
  const changelog = typeof changelogRaw === 'string' ? changelogRaw : undefined;

  const rawFiles = form['files'];
  const fileEntries = (Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : []).filter(
    (f): f is File => f instanceof File,
  );
  if (fileEntries.length === 0) {
    return error.badRequest(c, "At least one 'files' entry is required");
  }
  if (fileEntries.length > MAX_BUNDLE_FILES) {
    return error.badRequest(c, `Bundle exceeds the ${MAX_BUNDLE_FILES}-file limit`);
  }
  const totalBytes = fileEntries.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_BUNDLE_BYTES) {
    return error.badRequest(c, 'Bundle exceeds the 50MB size limit');
  }

  // (appId, version) is unique — pre-check for a friendly 409.
  const [dupe] = await masterDb
    .select({ id: masterSchema.userAppVersions.id })
    .from(masterSchema.userAppVersions)
    .where(
      and(
        eq(masterSchema.userAppVersions.appId, appRow.id),
        eq(masterSchema.userAppVersions.version, manifest.version),
      ),
    )
    .limit(1);
  if (dupe) {
    return error.conflict(c, `Version ${manifest.version} already exists for this app`);
  }

  // Upload the bundle to R2 under user-apps/{appId}/{versionId}/
  const versionId = generateId('uav');
  const bundleKey = `user-apps/${appRow.id}/${versionId}`;
  for (const file of fileEntries) {
    const relativePath = sanitizeBundlePath(file.name);
    if (!relativePath) {
      return error.badRequest(c, `Invalid bundle file path: ${file.name}`);
    }
    await storage.put(`${bundleKey}/${relativePath}`, await file.arrayBuffer(), {
      httpMetadata: { contentType: contentTypeFor(relativePath) },
    });
  }

  // Private apps (and public apps not yet approved) publish immediately;
  // approved public apps stage a draft and go back through review — except
  // first-party (`weldsuite`) publishers, which skip the review gate.
  const publishImmediately =
    appRow.visibility === 'private' ||
    appRow.reviewStatus !== 'approved' ||
    appRow.publisherType === 'weldsuite';
  const now = new Date();

  const [versionRow] = await masterDb
    .insert(masterSchema.userAppVersions)
    .values({
      id: versionId,
      appId: appRow.id,
      version: manifest.version,
      manifest,
      requestedScopes: manifest.scopes,
      bundleKey,
      entrypoint: manifest.entrypoint ?? 'index.html',
      bundleSize: totalBytes,
      fileCount: fileEntries.length,
      status: publishImmediately ? 'published' : 'draft',
      changelog,
      createdBy: session.userId ?? session.keyId,
      publishedAt: publishImmediately ? now : null,
      createdAt: now,
    })
    .returning();
  if (!versionRow) return error.internal(c, 'Failed to create version');

  if (publishImmediately) {
    // Supersede the previously published version(s)
    await masterDb
      .update(masterSchema.userAppVersions)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(masterSchema.userAppVersions.appId, appRow.id),
          eq(masterSchema.userAppVersions.status, 'published'),
          ne(masterSchema.userAppVersions.id, versionId),
        ),
      );

    // Roll the app forward to this version
    await masterDb
      .update(masterSchema.userApps)
      .set({
        currentVersionId: versionId,
        manifest,
        requestedScopes: manifest.scopes,
        name: manifest.name,
        ...(manifest.icon ? { icon: manifest.icon } : {}),
        ...(manifest.category ? { category: manifest.category } : {}),
        description: manifest.description ?? appRow.description,
        websiteUrl: manifest.websiteUrl ?? appRow.websiteUrl,
        privacyUrl: manifest.privacyUrl ?? appRow.privacyUrl,
        screenshots: manifest.screenshots ?? appRow.screenshots,
        webhookUrl: manifest.webhookUrl ?? appRow.webhookUrl,
        updatedAt: now,
      })
      .where(eq(masterSchema.userApps.id, appRow.id));

    // New scopes gate on re-consent: every ACTIVE install gets the delta as
    // pendingScopes until an admin approves them.
    const installs = await masterDb
      .select({
        id: masterSchema.userAppInstalls.id,
        grantedScopes: masterSchema.userAppInstalls.grantedScopes,
      })
      .from(masterSchema.userAppInstalls)
      .where(
        and(
          eq(masterSchema.userAppInstalls.appId, appRow.id),
          eq(masterSchema.userAppInstalls.status, 'active'),
        ),
      );
    for (const install of installs) {
      const granted = new Set((install.grantedScopes as string[]) ?? []);
      const pending = manifest.scopes.filter((s) => !granted.has(s));
      if (pending.length > 0) {
        await masterDb
          .update(masterSchema.userAppInstalls)
          .set({ pendingScopes: pending, updatedAt: now })
          .where(eq(masterSchema.userAppInstalls.id, install.id));
      }
    }

    // NOTE: the platform caches served bundle assets under `uapp-assets:{code}`
    // in app-api's WORKSPACE_CACHE KV namespace, which this worker has no
    // binding for. We skip cross-worker invalidation and rely on that cache's
    // 60s TTL — new bundles appear within a minute of publishing.
  } else {
    // Approved public app — new version needs review before going live.
    await masterDb
      .update(masterSchema.userApps)
      .set({ reviewStatus: 'submitted', updatedAt: now })
      .where(eq(masterSchema.userApps.id, appRow.id));
  }

  return success(c, versionRow, 201);
});

// ============================================================================
// Submit for public-store review
// ============================================================================

app.post('/:id/submit', zValidator('json', submitUserAppSchema), async (c) => {
  const session = c.get('apiSession');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);

  const appRow = await getOwnedApp(masterDb, id, session.workspaceId);
  if (!appRow) return error.notFound(c, 'App', id);

  const [version] = await masterDb
    .select({ id: masterSchema.userAppVersions.id })
    .from(masterSchema.userAppVersions)
    .where(eq(masterSchema.userAppVersions.appId, appRow.id))
    .limit(1);
  if (!version) {
    return error.badRequest(c, 'Upload at least one version before submitting for review');
  }

  const now = new Date();
  const official = appRow.publisherType === 'weldsuite';
  const [row] = await masterDb
    .update(masterSchema.userApps)
    .set({
      visibility: 'public',
      reviewStatus: official ? 'approved' : 'submitted',
      ...(official
        ? {
            reviewedBy: session.userId ?? session.keyId,
            reviewedAt: now,
            reviewNotes: body.notes ?? appRow.reviewNotes,
          }
        : body.notes
          ? { reviewNotes: body.notes }
          : {}),
      updatedAt: now,
    })
    .where(eq(masterSchema.userApps.id, appRow.id))
    .returning();
  if (!row) return error.internal(c, 'Failed to submit app');
  return success(c, row);
});

// ============================================================================
// Preview sessions (`weld app dev`)
// ============================================================================

app.put('/:id/dev-session', zValidator('json', upsertUserAppDevSessionSchema), async (c) => {
  const session = c.get('apiSession');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);

  const appRow = await getOwnedApp(masterDb, id, session.workspaceId);
  if (!appRow) return error.notFound(c, 'App', id);

  const userId = session.userId ?? body.userId ?? null;
  if (!userId) {
    return error.badRequest(
      c,
      'Pass userId (your Clerk user id) or use a personal API key. The platform iframe matches the preview to the signed-in user.',
    );
  }
  if (!isAllowedDevSessionUrl(body.url)) {
    return error.badRequest(
      c,
      'Preview URL must be localhost, 127.0.0.1, a Cloudflare quick tunnel, ngrok, or pages.dev',
    );
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEV_SESSION_TTL_MS);
  const table = masterSchema.userAppDevSessions;

  const [existing] = await masterDb
    .select({ id: table.id })
    .from(table)
    .where(
      and(eq(table.appId, appRow.id), eq(table.userId, userId), eq(table.workspaceId, session.workspaceId)),
    )
    .limit(1);

  const row = existing
    ? (
        await masterDb
          .update(table)
          .set({ url: body.url, expiresAt, updatedAt: now })
          .where(eq(table.id, existing.id))
          .returning({ url: table.url, expiresAt: table.expiresAt })
      )[0]
    : (
        await masterDb
          .insert(table)
          .values({
            id: generateId('uads'),
            appId: appRow.id,
            workspaceId: session.workspaceId,
            userId,
            url: body.url,
            expiresAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ url: table.url, expiresAt: table.expiresAt })
      )[0];

  if (!row) return error.internal(c, 'Failed to save preview session');
  return success(c, row);
});

app.delete('/:id/dev-session', async (c) => {
  const session = c.get('apiSession');
  const id = c.req.param('id');
  const userId = session.userId ?? c.req.query('userId') ?? null;
  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);

  const appRow = await getOwnedApp(masterDb, id, session.workspaceId);
  if (!appRow) return error.notFound(c, 'App', id);
  if (!userId) {
    return error.badRequest(c, 'Pass userId as a query param when using a workspace API key');
  }

  const table = masterSchema.userAppDevSessions;
  await masterDb
    .delete(table)
    .where(
      and(eq(table.appId, appRow.id), eq(table.userId, userId), eq(table.workspaceId, session.workspaceId)),
    );
  return noContent(c);
});

// ============================================================================
// OAuth client (server-to-server credentials for the app backend)
// ============================================================================

app.get('/:id/oauth-client', async (c) => {
  const session = c.get('apiSession');
  const id = c.req.param('id');
  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);

  const appRow = await getOwnedApp(masterDb, id, session.workspaceId);
  if (!appRow) return error.notFound(c, 'App', id);

  const [client] = await masterDb
    .select({
      clientId: masterSchema.userAppOauthClients.clientId,
      createdAt: masterSchema.userAppOauthClients.createdAt,
    })
    .from(masterSchema.userAppOauthClients)
    .where(eq(masterSchema.userAppOauthClients.appId, id))
    .limit(1);
  if (!client) return error.notFound(c, 'OAuth client', id);
  return success(c, client);
});

app.post('/:id/oauth-client', async (c) => {
  const session = c.get('apiSession');
  const id = c.req.param('id');
  const masterDb = createMasterDb(c.env.HYPERDRIVE_MASTER);

  const appRow = await getOwnedApp(masterDb, id, session.workspaceId);
  if (!appRow) return error.notFound(c, 'App', id);

  const clientSecret = `wacs_${randomHex(20)}`;
  const clientSecretHash = await sha256Hex(clientSecret);
  const now = new Date();
  const table = masterSchema.userAppOauthClients;

  const [existing] = await masterDb.select().from(table).where(eq(table.appId, id)).limit(1);

  if (existing) {
    await masterDb
      .update(table)
      .set({ clientSecretHash, updatedAt: now })
      .where(eq(table.id, existing.id));
    return success(c, { clientId: existing.clientId, clientSecret });
  }

  const clientId = `wac_${randomHex(12)}`;
  await masterDb.insert(table).values({
    id: generateId('uaoc'),
    appId: id,
    clientId,
    clientSecretHash,
    createdAt: now,
    updatedAt: now,
  });
  return success(c, { clientId, clientSecret }, 201);
});

export default app;
