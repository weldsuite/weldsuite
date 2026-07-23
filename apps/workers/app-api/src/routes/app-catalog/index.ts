/**
 * App catalog routes — /api/app-catalog/*. First-party module store:
 * browse the published app catalog and install/uninstall apps for the
 * active workspace.
 *
 * Ported from apps/mobile-api-worker:
 *   - GET /, /categories, /:code  ← src/routes/v1/apps/index.ts
 *   - install / uninstall         ← src/routes/v1/workspace/index.ts:186,:315
 *
 * Surface:
 *   - GET    /              — published apps + per-workspace isInstalled
 *   - GET    /categories    — distinct catalog categories
 *   - GET    /:code         — single app detail + installation info
 *   - POST   /:code/install — install app (OWNER/ADMIN only)
 *   - DELETE /:code/install — uninstall app, soft delete (OWNER/ADMIN only)
 *
 * Reads are open to every authenticated workspace member (same stance as
 * the dashboard installed-apps read — the catalog is not an object-permission
 * surface). Mutations are role-gated on the tenant `workspaceMembers` row
 * (OWNER/ADMIN) rather than a `requirePermission(<entity>:<action>)` gate,
 * for the same reason as workspace-settings: Clerk's `org:admin` is broader
 * than WeldSuite's OWNER, so the canonical role is read from the tenant DB.
 *
 * Legacy app-code shim: mobile clients still send `helpdesk` / `mail` —
 * `:code` params are normalised via toDbCode(), and (matching the mobile
 * original) the catalog `code` field in GET / and GET /:code responses is
 * translated back via toLegacyCode() so weldsuite-app's legacy-code string
 * comparisons keep working. weldsuite-app IS live on this route
 * (services/modules/core-user.ts), so that default must not change. The
 * install response's `appCode` stays the canonical DB code, as in the
 * original.
 *
 * `?codes=canonical` opts out of that back-translation on GET / and
 * GET /:code. The platform App Store needs it: the master catalog stores
 * `welddesk` / `weldmail`, which is what api-worker
 * `GET /settings/available-apps` returned and what the platform's UI is
 * keyed on. Serving it `helpdesk` / `mail` instead would silently reroute
 * `/appstore/:code` links and flip app-store-client's APP_CODE_OVERRIDES
 * (which keys on `mail`). Default stays legacy — mobile is unaffected.
 *
 * Entity events: none — `workspace_app` is not in the packages/core/entity-events
 * catalog (see services/app-catalog.ts), so install/uninstall intentionally
 * publish nothing.
 */

import { Hono, type Context } from 'hono';
import { installCatalogAppSchema, type InstallCatalogAppInput } from '@weldsuite/app-api-client/schemas/app-catalog';
import type { Env, Variables } from '../../types';
import { error, success, noContent } from '../../lib/response';
import { toDbCode, toLegacyCode } from '../../lib/legacy-app-codes';
import { getMasterDb } from '../../db';
import { isAdminOrOwner } from '../../services/mail/access';
import {
  listCatalogApps,
  listCatalogCategories,
  getCatalogApp,
  installCatalogApp,
  uninstallCatalogApp,
} from '../../services/app-catalog';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * `?codes=canonical` → emit the raw DB code; anything else (including absent)
 * → legacy back-translation, the pre-existing default weldsuite-app relies on.
 */
function emitCode(c: Context, code: string): string {
  return c.req.query('codes') === 'canonical' ? code : toLegacyCode(code);
}

// ============================================================================
// GET / — published catalog apps with installation status
// ============================================================================

app.get('/', async (c) => {
  const masterDb = getMasterDb(c.env);
  const tenantDb = c.get('tenantDb');

  const apps = await listCatalogApps(masterDb, tenantDb);
  return success(
    c,
    apps.map((app) => ({ ...app, code: emitCode(c, app.code) })),
  );
});

// ============================================================================
// GET /categories — unique app categories
// ============================================================================

app.get('/categories', async (c) => {
  const masterDb = getMasterDb(c.env);
  const categories = await listCatalogCategories(masterDb);
  return success(c, categories);
});

// ============================================================================
// GET /:code — single app details (accepts legacy codes)
// ============================================================================

app.get('/:code', async (c) => {
  const code = toDbCode(c.req.param('code'));
  const masterDb = getMasterDb(c.env);
  const tenantDb = c.get('tenantDb');

  const catalogApp = await getCatalogApp(masterDb, tenantDb, code);
  if (!catalogApp) return error.notFound(c, 'App', code);

  return success(c, { ...catalogApp, code: emitCode(c, catalogApp.code) });
});

// ============================================================================
// POST /:code/install — install an app to the workspace (OWNER/ADMIN)
// ============================================================================

app.post('/:code/install', async (c) => {
  const appCode = toDbCode(c.req.param('code'));
  const userId = c.get('userId');
  const tenantDb = c.get('tenantDb');
  const masterDb = getMasterDb(c.env);

  const isAdmin = await isAdminOrOwner(tenantDb, userId);
  if (!isAdmin) {
    return error.forbidden(c, 'Only workspace admins can install apps');
  }

  // Body is optional — `{ settings }` when present.
  let input: InstallCatalogAppInput = {};
  const raw = await c.req.text();
  if (raw.trim() !== '') {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return error.badRequest(c, 'Invalid JSON body');
    }
    const parsed = installCatalogAppSchema.safeParse(json);
    if (!parsed.success) {
      return error.badRequest(c, 'Invalid install payload', parsed.error.flatten());
    }
    input = parsed.data;
  }

  const result = await installCatalogApp({
    masterDb,
    tenantDb,
    userId,
    appCode,
    settings: input.settings,
  });

  if (!result.ok) return error.notFound(c, 'App', appCode);

  return success(c, result.app, 201);
});

// ============================================================================
// DELETE /:code/install — uninstall an app (soft delete, OWNER/ADMIN)
// ============================================================================

app.delete('/:code/install', async (c) => {
  const appCode = toDbCode(c.req.param('code'));
  const userId = c.get('userId');
  const tenantDb = c.get('tenantDb');

  const isAdmin = await isAdminOrOwner(tenantDb, userId);
  if (!isAdmin) {
    return error.forbidden(c, 'Only workspace admins can uninstall apps');
  }

  const uninstalled = await uninstallCatalogApp(tenantDb, appCode);
  if (!uninstalled) return error.notFound(c, 'Installed app', appCode);

  return noContent(c);
});

export const appCatalogRoutes = app;
