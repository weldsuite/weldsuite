//! Catalog lookups (`catalog.ts`, `app-catalog.ts`, `custom-objects.ts`).

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use weldsuite_catalogs::permissions;

use crate::app_scope::{PermissionSubject, check_app_permission};
use crate::apps::is_app_scoped_object;
use crate::engine::has_object_access;

/// Permission prefix of user-defined custom objects (WeldObjects).
pub const WELDOBJECTS_PREFIX: &str = "weldobjects";

/// Module-level WeldObjects keys, present however many objects exist.
pub const WELDOBJECTS_MODULE_PERMISSIONS: [&str; 2] = ["weldobjects:read", "weldobjects:manage"];

/// Per-object record actions of a custom object.
pub const CUSTOM_OBJECT_ACTIONS: [&str; 4] = ["read", "create", "update", "delete"];

/// Every key one custom object contributes:
/// `weldobjects:<slug>:{read,create,update,delete,scope:all}`.
pub fn custom_object_permission_keys(slug: &str) -> Vec<String> {
    CUSTOM_OBJECT_ACTIONS
        .iter()
        .map(|action| format!("{WELDOBJECTS_PREFIX}:{slug}:{action}"))
        .chain(std::iter::once(format!(
            "{WELDOBJECTS_PREFIX}:{slug}:scope:all"
        )))
        .collect()
}

/// Is `key` a per-object custom-object key (`weldobjects:<slug>:<action>`),
/// as opposed to a module-level `weldobjects:read`?
pub fn is_custom_object_permission(key: &str) -> bool {
    key.split(':').count() >= 3 && key.split(':').next() == Some(WELDOBJECTS_PREFIX)
}

/// Every key in the object catalog, in catalog order (`getAllPermissionKeys`).
pub fn all_permission_keys() -> impl Iterator<Item = &'static str> {
    permissions()
        .objects
        .iter()
        .flat_map(|object| object.permissions.iter().map(|p| p.key.as_str()))
}

/// The permissions a role row grants (`getRoleRowPermissions`): a system row
/// takes its permissions from code, by name; a custom row from its column.
pub fn role_row_permissions(is_system: bool, name: &str, stored: Option<&[String]>) -> Vec<String> {
    if is_system && let Some(role) = permissions().system_roles.get(&name.to_uppercase()) {
        return role.permissions.clone();
    }
    stored.map(<[String]>::to_vec).unwrap_or_default()
}

static CATALOG_KEYS_BY_OBJECT: LazyLock<HashMap<&'static str, Vec<&'static str>>> =
    LazyLock::new(|| {
        permissions()
            .objects
            .iter()
            .map(|object| {
                (
                    object.key.as_str(),
                    object.permissions.iter().map(|p| p.key.as_str()).collect(),
                )
            })
            .collect()
    });

/// Every key a role or member could hold: catalog keys plain and
/// app-qualified, the system roles' and employee keys, and the WeldObjects
/// module keys. `*` is not in it.
pub(crate) static KNOWN_KEYS: LazyLock<HashSet<String>> = LazyLock::new(|| {
    let catalog = permissions();
    let mut keys: HashSet<String> = all_permission_keys().map(str::to_owned).collect();
    for app in &catalog.apps {
        for object in &app.objects {
            for key in CATALOG_KEYS_BY_OBJECT
                .get(object.as_str())
                .into_iter()
                .flatten()
            {
                keys.insert(format!("{}:{key}", app.code));
            }
        }
    }
    for role in catalog.system_roles.values() {
        keys.extend(role.permissions.iter().filter(|k| *k != "*").cloned());
    }
    keys.extend(catalog.employee_member_permissions.iter().cloned());
    keys.extend(WELDOBJECTS_MODULE_PERMISSIONS.map(str::to_owned));
    keys
});

/// Any permission on `object` in `app`, deny-aware (`hasObjectAccessInApp`).
/// App-scoped objects check each catalog key through
/// [`check_app_permission`]; workspace-level objects keep the plain prefix
/// match, since they carry runtime keys the catalog doesn't list.
pub fn has_object_access_in_app<P: PermissionSubject + ?Sized>(
    subject: &P,
    object: &str,
    app: Option<&str>,
) -> bool {
    if subject.denies().is_empty() && subject.permissions().iter().any(|p| p == "*") {
        return true;
    }
    match CATALOG_KEYS_BY_OBJECT.get(object) {
        Some(keys) if is_app_scoped_object(object) => keys
            .iter()
            .any(|key| check_app_permission(subject, key, app).allowed),
        _ => has_object_access(subject.permissions(), object),
    }
}

/// Any access to at least one of `objects` in `app`.
pub fn has_any_object_access_in_app<P: PermissionSubject + ?Sized, O: AsRef<str>>(
    subject: &P,
    objects: &[O],
    app: Option<&str>,
) -> bool {
    objects
        .iter()
        .any(|object| has_object_access_in_app(subject, object.as_ref(), app))
}
