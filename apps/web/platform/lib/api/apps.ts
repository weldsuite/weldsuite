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
   * `/apps/{code}` instead of the app's own first-party route — and from
   * WeldObjects, user-defined custom objects rendered natively at
   * `/objects/{slug}`. Undefined (falsy) for system apps so every existing
   * call site keeps working without a migration.
   *
   * `'object'` differs from `'user'` in an important way: a WeldApp is
   * sandboxed third-party code in an iframe, whereas a custom object is
   * first-party platform UI over user-defined SCHEMA. Same rail, very
   * different trust model.
   */
  appType?: 'system' | 'user' | 'object';
}
