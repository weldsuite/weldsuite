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
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import {
  createUserAppSchema,
  submitUserAppSchema,
  userAppManifestSchema,
} from '@weldsuite/app-api-client/schemas/user-apps';
import type { HonoEnv } from '../../types';
import { hasScope } from '../../lib/scopes';
import { generateId } from '../../lib/id';
import { createMasterDb, masterSchema, type MasterDatabase } from '../../lib/master-db';
import { error, list, noContent, success, cursorPagination } from '../../lib/response';

const app = new Hono<HonoEnv>();

/** Codes that collide with first-party modules / platform routes. */
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

const MAX_BUNDLE_FILES = 100;
const MAX_BUNDLE_BYTES = 10 * 1024 * 1024; // 10 MB

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

  if (RESERVED_CODES.has(body.code)) {
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
      ownerWorkspaceId: session.workspaceId,
      createdBy: session.userId ?? session.keyId,
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

// ============================================================================
// Versions — multipart bundle upload (weld CLI `weld deploy`)
// ============================================================================

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
    return error.badRequest(c, 'Bundle exceeds the 10MB size limit');
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
  // approved public apps stage a draft and go back through review.
  const publishImmediately = appRow.visibility === 'private' || appRow.reviewStatus !== 'approved';
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

  const [row] = await masterDb
    .update(masterSchema.userApps)
    .set({
      visibility: 'public',
      reviewStatus: 'submitted',
      ...(body.notes ? { reviewNotes: body.notes } : {}),
      updatedAt: new Date(),
    })
    .where(eq(masterSchema.userApps.id, appRow.id))
    .returning();
  if (!row) return error.internal(c, 'Failed to submit app');
  return success(c, row);
});

export default app;
