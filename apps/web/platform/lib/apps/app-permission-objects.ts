/**
 * Platform-level lookup: which permission objects grant access to which app.
 *
 * Background — after the permissions refactor, keys are 2-segment `object:action`
 * (e.g. `leads:read`). Sidebar / route gates need to ask "does this user have
 * any permission relevant to this app?". The legacy 16 apps are derived from
 * `APP_TO_OBJECTS` in the permissions package (auto-built from the migration
 * map). Apps introduced AFTER the refactor — or with renamed URL prefixes —
 * must be listed explicitly here.
 *
 * When adding a new app, declare the object keys whose permissions imply
 * access to the app. Empty array means owner-only.
 */

import { APP_TO_OBJECTS } from '@weldsuite/permissions';

/**
 * Apps that did not exist (or used a different prefix) before the
 * `app:module:action` → `object:action` refactor. The values are the
 * NEW-format object keys that grant access to the app.
 */
const POST_REFACTOR_APPS: Record<string, string[]> = {
  // WeldCall reuses CRM activity permissions for calls and the
  // telephony settings for phone-number management.
  weldcall: ['activities', 'telephony'],
  // WeldData (Lead Database) is gated by the `prospects` object — the same
  // object its app-api routes enforce (prospects:read/create/update/delete).
  // Without this entry the access guard treats it as owner-only and bounces
  // every other user to `/`.
  welddata: ['prospects'],
  // WeldKnow (workspace wiki) is gated by the `knowledge` object — the same
  // object its app-api routes enforce (knowledge:read/create/update/delete).
  weldknow: ['knowledge'],
};

/**
 * Final lookup combining the legacy migration-derived map with any
 * post-refactor app definitions. Post-refactor entries win on key
 * collisions, but there should be none in practice.
 */
const APP_PERMISSION_OBJECTS: Record<string, string[]> = {
  ...APP_TO_OBJECTS,
  ...POST_REFACTOR_APPS,
};

/**
 * Object keys whose permissions imply access to the given app.
 * Returns `[]` for unknown apps — caller decides whether unknown means
 * "open to everyone" or "owner-only".
 */
export function getAppPermissionObjects(appCode: string): string[] {
  return APP_PERMISSION_OBJECTS[appCode] ?? [];
}
