/**
 * App Store API
 * Uses direct database access for app management
 * Apps are now workspace-scoped (all users in workspace see same apps)
 */

import { getScopedDb, getUserId } from '@/lib/db/auth';
import { APP_CATALOG, AVAILABLE_APPS, getCategories as getCatalogCategories } from '@/lib/apps/catalog';

// Types for frontend compatibility
interface AvailableApp {
  code: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  provider: string;
  verified: boolean;
  isInstalled: boolean;
  path?: string;
}

export interface InstalledApp {
  id: string;
  workspaceId: string;
  appCode: string;
  name: string;
  description?: string;
  icon?: string;
  category?: string;
  status: string;
  settings?: Record<string, unknown>;
  installedAt: string;
  installedBy?: string;
  lastAccessedAt?: string;
  displayOrder: number;
  /**
   * Distinguishes first-party system apps (weldcrm, welddesk, …) from
   * WeldApps — workspace-created apps hosted in a sandboxed iframe at
   * `/apps/{code}` instead of the app's own first-party route. Undefined
   * (falsy) for system apps so every existing call site keeps working
   * without a migration.
   */
  appType?: 'system' | 'user';
}

interface InstallAppRequest {
  appCode: string;
  settings?: Record<string, unknown>;
}

async function getAvailableApps(): Promise<AvailableApp[]> {
  try {
    const db = await getScopedDb();
    // Now using workspace-level installed apps
    const installedApps = await db.workspaceInstalledApps.findMany();
    const installedCodes = new Set(installedApps.map((a: any) => a.appCode));

    return AVAILABLE_APPS.map((app) => ({
      code: app.code,
      name: app.name,
      description: app.description,
      icon: app.icon,
      category: app.category,
      provider: 'WeldSuite',
      verified: true,
      isInstalled: installedCodes.has(app.code),
      path: app.path,
    }));
  } catch {
    // Return catalog apps as fallback
    return AVAILABLE_APPS.map((app) => ({
      code: app.code,
      name: app.name,
      description: app.description,
      icon: app.icon,
      category: app.category,
      provider: 'WeldSuite',
      verified: true,
      isInstalled: false,
      path: app.path,
    }));
  }
}

async function getCategories(): Promise<string[]> {
  return getCatalogCategories();
}

async function getInstalledApps(): Promise<InstalledApp[]> {
  try {
    const db = await getScopedDb();
    // Now using workspace-level installed apps
    const installedApps = await db.workspaceInstalledApps.findMany();

    return installedApps.map((app: any) => {
      const catalogApp = APP_CATALOG[app.appCode];
      return {
        id: app.id,
        workspaceId: app.workspaceId,
        appCode: app.appCode,
        name: catalogApp?.name || app.appCode,
        description: catalogApp?.description,
        icon: catalogApp?.icon,
        category: catalogApp?.category,
        status: app.isActive ? 'active' : 'inactive',
        settings: app.settings,
        installedAt: app.installedAt?.toISOString() || app.createdAt.toISOString(),
        installedBy: app.installedBy || undefined,
        displayOrder: app.displayOrder || 0,
      };
    });
  } catch {
    return [];
  }
}

async function installApp(
  appCode: string,
  settings?: Record<string, unknown>
): Promise<InstalledApp> {
  const db = await getScopedDb();
  const userId = await getUserId();

  if (!(appCode in APP_CATALOG)) {
    throw new Error(`Invalid app code: ${appCode}`);
  }

  // Now installing at workspace level
  const installed = await db.workspaceInstalledApps.install(appCode, userId);

  // If settings provided, update them
  if (settings) {
    await db.workspaceInstalledApps.updateSettings(appCode, settings);
  }

  const catalogApp = APP_CATALOG[appCode];

  return {
    id: installed.id,
    workspaceId: installed.workspaceId,
    appCode: installed.appCode,
    name: catalogApp?.name || appCode,
    description: catalogApp?.description,
    icon: catalogApp?.icon,
    category: catalogApp?.category,
    status: 'active',
    settings: installed.settings,
    installedAt: installed.installedAt?.toISOString() || new Date().toISOString(),
    installedBy: installed.installedBy || undefined,
    displayOrder: installed.displayOrder || 0,
  };
}

async function uninstallApp(appCode: string): Promise<void> {
  const db = await getScopedDb();
  // Now uninstalling at workspace level
  await db.workspaceInstalledApps.uninstall(appCode);
}

async function updateAppAccess(_appCode: string): Promise<void> {
  // No longer tracking app access - this is a no-op for backwards compatibility
}

/**
 * Check if an app is installed for the workspace
 */
async function isAppInstalled(appCode: string): Promise<boolean> {
  try {
    const db = await getScopedDb();
    const app = await db.workspaceInstalledApps.findByAppCode(appCode);
    return !!app && app.isActive;
  } catch {
    return false;
  }
}
