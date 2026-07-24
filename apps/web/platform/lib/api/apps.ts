/**
 * App Store API
 * Uses direct database access for app management
 * Apps are now workspace-scoped (all users in workspace see same apps)
 */

// Types for frontend compatibility
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
