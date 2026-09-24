// Types
export type {
  PermissionAction,
  PermissionDefinition,
  ObjectDefinition,
  SystemRoleDefinition,
  SystemRoleName,
  ResolvedPermissions,
  PermissionAppDefinition,
} from './types';

export { PERMISSION_ACTIONS } from './types';

// Engine (zero deps — works on server and client)
export {
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  hasObjectAccess,
  hasAnyObjectAccess,
  expandWildcards,
} from './engine';

// App registry + app-scoped checks (per-app permission matrix)
export {
  APP_CONTEXT_HEADER,
  WORKSPACE_APP_CONTEXT,
  PERMISSION_APPS,
  APP_CODE_ALIASES,
  isAppCode,
  normalizeAppCode,
  getPermissionApp,
  getAppsForObject,
  isAppScopedObject,
} from './apps';
export {
  LEGACY_UNQUALIFIED_GRANTS,
  parsePermissionKey,
  qualifyPermission,
  checkAppPermission,
  hasAppPermission,
  hasAnyAppPermission,
  type PermissionKeyParts,
  type PermissionSubject,
  type AppCheckMode,
  type AppPermissionCheck,
} from './app-scope';
export { toAppScopedKeys } from './app-migration';
export {
  buildAppPermissionCatalog,
  hasObjectAccessInApp,
  hasAnyObjectAccessInApp,
  type AppPermissionCatalog,
  type AppPermissionCatalogEntry,
} from './app-catalog';

// Catalog
export {
  PERMISSION_CATALOG_OBJECTS,
  PERMISSION_CATALOG,
  SYSTEM_ROLES,
  ROUTE_TO_APP,
  getAllPermissionKeys,
} from './catalog';

// WeldObjects — runtime-generated per-object permission keys
export {
  WELDOBJECTS_PREFIX,
  WELDOBJECTS_MODULE_PERMISSIONS,
  CUSTOM_OBJECT_ACTIONS,
  customObjectPermission,
  customObjectScopeAllPermission,
  customObjectPermissionKeys,
  customObjectPermissionObject,
  buildCustomObjectPermissionCatalog,
  isCustomObjectPermission,
  type CustomObjectPermissionAction,
  type CustomObjectPermissionSource,
} from './custom-objects';

// Migration map (single source of truth for old → new key migration)
export {
  OLD_MODULE_TO_NEW_OBJECT,
  OLD_APP_KEYS,
  APP_TO_OBJECTS,
  ALL_OBJECT_KEYS,
  OBJECT_ACTIONS,
  migratePermissionKey,
  migratePermissionKeys,
} from './migration-map';
