/**
 * App catalog service — first-party module store browse + install/uninstall.
 *
 * Ported from apps/mobile-api-worker:
 *   - catalog browse: src/routes/v1/apps/index.ts (list / categories / detail)
 *   - install/uninstall: src/routes/v1/workspace/index.ts:186,:315
 *
 * Pure functions — no Hono context. The catalog lives in the master DB
 * (`app_catalog`); installations live in the tenant DB
 * (`workspace_installed_apps`, unique per appCode — the tenant DB itself is
 * the workspace scope, there is no workspaceId column on the table).
 *
 * NOTE: install/uninstall publish NO entity event — `workspace_app` is not
 * an entity type in the packages/core/entity-events catalog (the mobile worker
 * published it through its own loose-typed local publisher; the shared
 * catalog-typed publisher would reject it at compile time).
 */

import { and, eq, isNull, max } from 'drizzle-orm';
import { schema, masterSchema, type Database, type MasterDatabase } from '../db';
import { generateId } from '../lib/id';

const { workspaceInstalledApps } = schema;
const { appCatalog } = masterSchema;

export interface CatalogAppItem {
  id: string;
  code: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  path: string;
  overview: string | null;
  features: string[];
  howItWorks: { title: string; description: string }[];
  version: string | null;
  provider: string | null;
  isInstalled: boolean;
  /**
   * Store-listing fields below. Added in W5b so the platform App Store can
   * read this route instead of api-worker `GET /settings/available-apps` —
   * that route projected all five and `app/appstore/[code]` renders
   * `releasedAt` (next to the version) plus the three resource links in the
   * detail sidebar. Omitting them here blanked those.
   *
   * `verified` is non-null in the schema; the rest are nullable columns and
   * are passed through as-is.
   *
   * `provider` is deliberately NOT changed here: legacy coalesced it to
   * 'WeldSuite', this route passes the column through (as the mobile original
   * did). The column defaults to 'WeldSuite', so the two agree in practice and
   * repointing mobile's shape for a hypothetical null is out of scope.
   *
   * NOT included: `screenshots`. Legacy never projected it either — the rows
   * live in a separate master table (`app_screenshots`) that no catalog read
   * has ever joined, so the platform's `AvailableApp.screenshots?: any[]` has
   * always been undefined and nothing renders it.
   */
  verified: boolean;
  releasedAt: Date | null;
  websiteUrl: string | null;
  documentationUrl: string | null;
  contactUrl: string | null;
}

export interface InstalledCatalogApp {
  id: string;
  appCode: string;
  isActive: boolean;
  displayOrder: number | null;
  settings: Record<string, unknown> | null;
  installedAt: Date | null;
}

function toCatalogItem(
  app: typeof appCatalog.$inferSelect,
  installedCodes: Set<string>,
): CatalogAppItem {
  return {
    id: app.id,
    code: app.code,
    name: app.name,
    description: app.description,
    icon: app.icon,
    category: app.category,
    path: app.path,
    overview: app.overview,
    features: app.features || [],
    howItWorks: app.howItWorks || [],
    version: app.version,
    provider: app.provider,
    isInstalled: installedCodes.has(app.code),
    verified: app.verified,
    releasedAt: app.releasedAt,
    websiteUrl: app.websiteUrl,
    documentationUrl: app.documentationUrl,
    contactUrl: app.contactUrl,
  };
}

async function getInstalledCodes(tenantDb: Database): Promise<Set<string>> {
  const installed = await tenantDb
    .select({ appCode: workspaceInstalledApps.appCode })
    .from(workspaceInstalledApps)
    .where(
      and(
        eq(workspaceInstalledApps.isActive, true),
        isNull(workspaceInstalledApps.deletedAt),
      ),
    );
  return new Set(installed.map((a) => a.appCode));
}

/** All published catalog apps with per-workspace installation status. */
export async function listCatalogApps(
  masterDb: MasterDatabase,
  tenantDb: Database,
): Promise<CatalogAppItem[]> {
  const catalogApps = await masterDb
    .select()
    .from(appCatalog)
    .where(and(eq(appCatalog.isActive, true), eq(appCatalog.isPublished, true)))
    .orderBy(appCatalog.sortOrder);

  const installedCodes = await getInstalledCodes(tenantDb);
  return catalogApps.map((app) => toCatalogItem(app, installedCodes));
}

/** Distinct categories across published catalog apps, sorted. */
export async function listCatalogCategories(masterDb: MasterDatabase): Promise<string[]> {
  const apps = await masterDb
    .select({ category: appCatalog.category })
    .from(appCatalog)
    .where(and(eq(appCatalog.isActive, true), eq(appCatalog.isPublished, true)));

  return [...new Set(apps.map((a) => a.category))].filter(Boolean).sort();
}

/** Single published catalog app + installation info, or null when unknown. */
export async function getCatalogApp(
  masterDb: MasterDatabase,
  tenantDb: Database,
  code: string,
): Promise<
  | (CatalogAppItem & {
      installation: { id: string; installedAt: Date | null; settings: Record<string, unknown> | null } | null;
    })
  | null
> {
  const apps = await masterDb
    .select()
    .from(appCatalog)
    .where(
      and(
        eq(appCatalog.code, code),
        eq(appCatalog.isActive, true),
        eq(appCatalog.isPublished, true),
      ),
    )
    .limit(1);

  if (apps.length === 0) return null;
  const app = apps[0];

  const installedApps = await tenantDb
    .select({
      id: workspaceInstalledApps.id,
      installedAt: workspaceInstalledApps.installedAt,
      settings: workspaceInstalledApps.settings,
    })
    .from(workspaceInstalledApps)
    .where(
      and(
        eq(workspaceInstalledApps.appCode, code),
        eq(workspaceInstalledApps.isActive, true),
        isNull(workspaceInstalledApps.deletedAt),
      ),
    )
    .limit(1);

  const installation = installedApps[0];
  return {
    ...toCatalogItem(app, new Set(installation ? [code] : [])),
    installation: installation
      ? {
          id: installation.id,
          installedAt: installation.installedAt,
          settings: installation.settings,
        }
      : null,
  };
}

export type InstallCatalogAppResult =
  | { ok: true; app: InstalledCatalogApp }
  | { ok: false; reason: 'app_not_found' };

/**
 * Install a catalog app into the workspace. Validates the code against the
 * published catalog, then re-activates a soft-deleted row or inserts a new
 * one at the end of the display order.
 */
export async function installCatalogApp(params: {
  masterDb: MasterDatabase;
  tenantDb: Database;
  userId: string;
  appCode: string;
  settings?: Record<string, unknown>;
}): Promise<InstallCatalogAppResult> {
  const { masterDb, tenantDb, userId, appCode, settings } = params;

  // Validate app exists in catalog and is published.
  const catalogApps = await masterDb
    .select({ code: appCatalog.code })
    .from(appCatalog)
    .where(
      and(
        eq(appCatalog.code, appCode),
        eq(appCatalog.isActive, true),
        eq(appCatalog.isPublished, true),
      ),
    )
    .limit(1);

  if (catalogApps.length === 0) {
    return { ok: false, reason: 'app_not_found' };
  }

  // Get max display order for positioning.
  const maxOrderResult = await tenantDb
    .select({ maxOrder: max(workspaceInstalledApps.displayOrder) })
    .from(workspaceInstalledApps);
  const nextDisplayOrder = (maxOrderResult[0]?.maxOrder ?? -1) + 1;

  // Check if app already exists (including soft-deleted).
  const existingApps = await tenantDb
    .select()
    .from(workspaceInstalledApps)
    .where(eq(workspaceInstalledApps.appCode, appCode))
    .limit(1);

  let installedApp;

  if (existingApps.length > 0) {
    // Re-activate existing app.
    const updated = await tenantDb
      .update(workspaceInstalledApps)
      .set({
        isActive: true,
        deletedAt: null,
        settings: settings ?? existingApps[0].settings,
        installedAt: new Date(),
        installedBy: userId,
        updatedAt: new Date(),
      })
      .where(eq(workspaceInstalledApps.id, existingApps[0].id))
      .returning();
    installedApp = updated[0];
  } else {
    // Insert new app.
    const inserted = await tenantDb
      .insert(workspaceInstalledApps)
      .values({
        id: generateId('wia'),
        appCode,
        isActive: true,
        displayOrder: nextDisplayOrder,
        settings: settings ?? {},
        installedAt: new Date(),
        installedBy: userId,
      })
      .returning();
    installedApp = inserted[0];
  }

  return {
    ok: true,
    app: {
      id: installedApp.id,
      appCode: installedApp.appCode,
      isActive: installedApp.isActive,
      displayOrder: installedApp.displayOrder,
      settings: installedApp.settings,
      installedAt: installedApp.installedAt,
    },
  };
}

/**
 * Uninstall (soft-delete) an installed app. Returns the uninstalled row's
 * id + code, or null when the app is not actively installed.
 */
export async function uninstallCatalogApp(
  tenantDb: Database,
  appCode: string,
): Promise<{ id: string; appCode: string } | null> {
  const installedApps = await tenantDb
    .select({ id: workspaceInstalledApps.id, appCode: workspaceInstalledApps.appCode })
    .from(workspaceInstalledApps)
    .where(
      and(
        eq(workspaceInstalledApps.appCode, appCode),
        eq(workspaceInstalledApps.isActive, true),
        isNull(workspaceInstalledApps.deletedAt),
      ),
    )
    .limit(1);

  if (installedApps.length === 0) return null;

  await tenantDb
    .update(workspaceInstalledApps)
    .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(workspaceInstalledApps.id, installedApps[0].id));

  return installedApps[0];
}
