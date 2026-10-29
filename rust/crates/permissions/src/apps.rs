//! The app registry (`apps.ts`): which permission objects each app exposes.
//! An object registered in an app is granted per app
//! (`weldcrm:companies:read`); an object in no app is workspace-level and
//! keeps its plain key (`team:read`, `weldagent:use`).

use std::collections::HashMap;
use std::sync::LazyLock;

use weldsuite_catalogs::{PermissionApp, permissions};

/// Request header carrying the caller's app code.
pub const APP_CONTEXT_HEADER: &str = "X-Weld-App";

/// Header value for a request that deliberately has no app context (the
/// workspace shell's own widgets).
pub const WORKSPACE_APP_CONTEXT: &str = "workspace";

/// Object → the apps that expose it, in registry order.
static APPS_BY_OBJECT: LazyLock<HashMap<&'static str, Vec<&'static str>>> = LazyLock::new(|| {
    let mut map: HashMap<&'static str, Vec<&'static str>> = HashMap::new();
    for app in &permissions().apps {
        for object in &app.objects {
            map.entry(object.as_str())
                .or_default()
                .push(app.code.as_str());
        }
    }
    map
});

/// Every app in the registry.
pub fn permission_apps() -> &'static [PermissionApp] {
    &permissions().apps
}

/// Is `code` a canonical app code? Aliases are not.
pub fn is_app_code(code: &str) -> bool {
    get_permission_app(code).is_some()
}

/// The registry entry for a canonical app code.
pub fn get_permission_app(code: &str) -> Option<&'static PermissionApp> {
    permission_apps().iter().find(|app| app.code == code)
}

/// The canonical app code for a code or alias, ignoring case and surrounding
/// whitespace.
pub fn normalize_app_code(code: &str) -> Option<&'static str> {
    // JavaScript's `trim()` also strips the byte order mark.
    let lower = code
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .to_lowercase();
    if let Some(app) = get_permission_app(&lower) {
        return Some(app.code.as_str());
    }
    permissions()
        .app_code_aliases
        .get(&lower)
        .map(String::as_str)
}

/// Canonical codes of every app that exposes `object`; empty for a
/// workspace-level object.
pub fn apps_for_object(object: &str) -> &'static [&'static str] {
    APPS_BY_OBJECT.get(object).map_or(&[], Vec::as_slice)
}

/// Is `object` granted per app rather than workspace-wide?
pub fn is_app_scoped_object(object: &str) -> bool {
    APPS_BY_OBJECT.contains_key(object)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_lookups() {
        assert!(is_app_code("weldcrm"));
        assert!(!is_app_code("crm"));
        assert_eq!(normalize_app_code(" CRM "), Some("weldcrm"));
        assert_eq!(normalize_app_code("parcel"), Some("weldstash"));
        assert_eq!(normalize_app_code("nope"), None);
        assert!(apps_for_object("companies").contains(&"weldhr"));
        assert!(!is_app_scoped_object("team"));
    }
}
