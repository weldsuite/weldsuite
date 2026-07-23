/**
 * WeldApps (user-created apps) entity events.
 *
 * Emitted by app-api's /api/user-apps management surface. `published`
 * fires when a version goes live (private apps publish immediately;
 * public apps publish on review approval), `installed` / `uninstalled`
 * track per-workspace install grants.
 */
export const USER_APPS_ENTITY_EVENTS = {
  user_app: ['created', 'updated', 'deleted', 'published', 'installed', 'uninstalled'],
} as const;
