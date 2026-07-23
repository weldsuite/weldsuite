// Types
export type {
  PermissionAction,
  PermissionDefinition,
  ObjectDefinition,
  SystemRoleDefinition,
  SystemRoleName,
  ResolvedPermissions,
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

// Catalog
export {
  PERMISSION_CATALOG_OBJECTS,
  PERMISSION_CATALOG,
  SYSTEM_ROLES,
  ROUTE_TO_APP,
  getAllPermissionKeys,
} from './catalog';

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
