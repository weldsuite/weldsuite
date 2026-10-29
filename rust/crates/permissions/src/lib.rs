//! Permissions: the Rust port of `@weldsuite/permissions`
//! (`packages/core/permissions/src`).
//!
//! Keys are `object:action` (`leads:read`); objects that live inside apps are
//! granted per app (`weldcrm:companies:read`). A member's access is their
//! role, their teams and their own extras, minus their denies; the owner holds
//! `*`.
//!
//! `tests/parity.rs` replays cases the TypeScript package answered
//! (`tests/fixtures/permission-cases.json`, written by `pnpm rust:catalogs`),
//! so the two implementations can't drift apart unnoticed.

mod app_scope;
mod apps;
mod catalog;
mod engine;
mod grants;
mod middleware;
mod resolver;

pub use app_scope::{
    AppCheckMode, AppPermissionCheck, Grants, LEGACY_UNQUALIFIED_GRANTS, PermissionKeyParts,
    PermissionSubject, check_app_permission, has_any_app_permission, has_app_permission,
    parse_permission_key, qualify_permission,
};
pub use apps::{
    APP_CONTEXT_HEADER, WORKSPACE_APP_CONTEXT, apps_for_object, get_permission_app, is_app_code,
    is_app_scoped_object, normalize_app_code, permission_apps,
};
pub use catalog::{
    CUSTOM_OBJECT_ACTIONS, WELDOBJECTS_MODULE_PERMISSIONS, WELDOBJECTS_PREFIX, all_permission_keys,
    custom_object_permission_keys, has_any_object_access_in_app, has_object_access_in_app,
    is_custom_object_permission, role_row_permissions,
};
pub use engine::{
    expand_wildcards, has_all_permissions, has_any_object_access, has_any_permission,
    has_object_access, has_permission,
};
pub use grants::{
    PermissionGrantCheck, can_grant_permission, check_permission_grants,
    is_grantable_permission_key,
};
pub use middleware::{
    AppContext, PermissionGate, PermissionLayer, PermissionService, Permissions, app_context,
};
pub use resolver::{
    MemberRow, PermissionQueries, ResolvedPermissions, resolve_effective_permissions,
};
