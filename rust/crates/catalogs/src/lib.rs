//! The TypeScript catalogs the backend shares with the rest of WeldSuite, as
//! Rust types. Source of truth stays in TypeScript; `pnpm rust:catalogs`
//! exports it to `rust/catalogs/*.json`, CI fails when the export is stale,
//! and `build.rs` turns the JSON into the constants below.
//!
//! | Module | TypeScript source |
//! |---|---|
//! | [`entity_events`] | `packages/core/entity-events/src/events/` |
//! | [`permission_keys`], [`permissions()`] | `packages/core/permissions/src/{catalog,apps}.ts` |
//! | [`flags`] | `packages/core/feature-flags/src/flags.ts` |
//! | [`api_modules()`] | `packages/core/api-modules/src/index.ts` |
//! | [`FIRST_PARTY_ORIGINS`] | `packages/core/worker-kit/src/cors.ts` |

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::Deserialize;

include!(concat!(env!("OUT_DIR"), "/origins.rs"));

/// Entity events: one constant per `entity_type:action` pair
/// (`CUSTOMER_CREATED`), and [`entity_events::ALL`] for runtime checks.
pub mod entity_events {
    /// One entity event name, `customer:created` on the wire.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub struct EventName {
        pub entity_type: &'static str,
        pub action: &'static str,
    }

    impl EventName {
        /// `customer:created`, the wire format.
        pub fn wire(&self) -> String {
            format!("{}:{}", self.entity_type, self.action)
        }

        /// `customer.created`, the format of agent subscriptions and workflow
        /// triggers.
        pub fn dotted(&self) -> String {
            format!("{}.{}", self.entity_type, self.action)
        }
    }

    include!(concat!(env!("OUT_DIR"), "/entity_events.rs"));

    /// Whether `entity_type` is in the catalog (`isKnownEntityType`, without
    /// the runtime custom-object types).
    pub fn is_known_entity_type(entity_type: &str) -> bool {
        ALL.iter().any(|(known, _)| *known == entity_type)
    }

    /// Whether `action` is in the catalog for `entity_type` (`isKnownAction`).
    pub fn is_known_action(entity_type: &str, action: &str) -> bool {
        ALL.iter()
            .find(|(known, _)| *known == entity_type)
            .is_some_and(|(_, actions)| actions.contains(&action))
    }
}

/// Permission keys: one constant per key (`LEADS_READ` = `"leads:read"`) and
/// [`permission_keys::ALL`].
pub mod permission_keys {
    include!(concat!(env!("OUT_DIR"), "/permission_keys.rs"));
}

/// Feature flags with their type and the default used when the flag service
/// can't answer.
pub mod flags {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct BoolFlag {
        pub key: &'static str,
        pub default: bool,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct StringFlag {
        pub key: &'static str,
        pub default: &'static str,
    }

    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct NumberFlag {
        pub key: &'static str,
        pub default: f64,
    }

    /// A JSON flag; `default_json` is the default, serialised.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct JsonFlag {
        pub key: &'static str,
        pub default_json: &'static str,
    }

    include!(concat!(env!("OUT_DIR"), "/flags.rs"));
}

/// One permission in the catalog.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Permission {
    pub key: String,
    pub label: String,
    pub description: Option<String>,
}

/// A permission object (`leads`, `team`, …) and its permissions.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PermissionObject {
    pub key: String,
    pub label: String,
    pub permissions: Vec<Permission>,
}

/// A system role (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemRole {
    pub name: String,
    pub description: String,
    pub is_system: bool,
    /// Plain or app-qualified keys; `*` grants everything.
    pub permissions: Vec<String>,
}

/// An app and the permission objects its screens use (`PERMISSION_APPS`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PermissionApp {
    pub code: String,
    pub label: String,
    pub objects: Vec<String>,
}

/// `permissions.json`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionCatalog {
    pub objects: Vec<PermissionObject>,
    /// Keyed by role code: `OWNER`, `ADMIN`, `MEMBER`, `VIEWER`.
    pub system_roles: BTreeMap<String, SystemRole>,
    /// The fixed access of a member with `memberType = 'EMPLOYEE'`.
    pub employee_member_permissions: Vec<String>,
    pub apps: Vec<PermissionApp>,
    /// Old and alternative app codes (`crm`, `wms`, …) → canonical code
    /// (`APP_CODE_ALIASES`).
    pub app_code_aliases: BTreeMap<String, String>,
}

/// One API module and the paths it owns (`API_MODULES`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiModule {
    pub id: String,
    /// Worker folder under `apps/workers/`, and the hostname prefix.
    pub worker: String,
    /// Service binding app-api forwards through.
    pub binding: String,
    pub dev_port: u16,
    /// Whole-segment path prefixes; the longest match wins.
    pub prefixes: Vec<String>,
    /// Apps whose licence opens the module; `None` = never gated.
    pub apps: Option<Vec<String>>,
    /// Ported to Rust: the Kubernetes editions serve it (`RUST_PORTED_MODULES`).
    pub rust: bool,
}

/// `record-chat.json`: a record's chat opens to the apps of the record's
/// module too.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RecordChat {
    /// `/api/chat-entity-channels/`.
    pub prefix: String,
    /// Entity type → owning module id.
    pub owners: BTreeMap<String, String>,
}

static PERMISSIONS: LazyLock<PermissionCatalog> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../catalogs/permissions.json"))
        .expect("permissions.json matches PermissionCatalog (checked by the tests)")
});

static RECORD_CHAT: LazyLock<RecordChat> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../catalogs/record-chat.json"))
        .expect("record-chat.json matches RecordChat (checked by the tests)")
});

static API_MODULES: LazyLock<Vec<ApiModule>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../catalogs/api-modules.json"))
        .expect("api-modules.json matches ApiModule (checked by the tests)")
});

/// The permission catalog: objects, system roles, the employee member set and
/// the app registry.
pub fn permissions() -> &'static PermissionCatalog {
    &PERMISSIONS
}

/// Every API module, `core` first.
pub fn api_modules() -> &'static [ApiModule] {
    &API_MODULES
}

/// The module with this id.
pub fn api_module(id: &str) -> Option<&'static ApiModule> {
    api_modules().iter().find(|module| module.id == id)
}

/// The apps that open a path for a licensed workspace (`licenceAppsForPath`);
/// `None` when it is never gated.
pub fn licence_apps_for_path(path: &str) -> Option<Vec<&'static str>> {
    let apps: Vec<&'static str> = find_module_for_path(path)
        .apps
        .as_ref()?
        .iter()
        .map(String::as_str)
        .collect();
    let Some(rest) = path.strip_prefix(RECORD_CHAT.prefix.as_str()) else {
        return Some(apps);
    };
    let entity = rest.split(['/', '?']).next().unwrap_or("");
    let Some(owner) = RECORD_CHAT.owners.get(entity).and_then(|id| api_module(id)) else {
        return Some(apps);
    };
    let mut merged = apps;
    for app in owner.apps.iter().flatten() {
        if !merged.contains(&app.as_str()) {
            merged.push(app.as_str());
        }
    }
    Some(merged)
}

/// The app a licensed workspace lacks for `path` (`missingLicensedAppForPath`):
/// `None` when allowed, else the owning module's own app.
pub fn missing_licensed_app_for_path<S: AsRef<str>>(
    path: &str,
    licensed_apps: &[S],
) -> Option<&'static str> {
    let apps = licence_apps_for_path(path)?;
    let licensed = |code: &&str| licensed_apps.iter().any(|app| app.as_ref() == *code);
    if apps.iter().any(licensed) {
        None
    } else {
        apps.first().copied()
    }
}

/// The module that owns `path` (`findModuleForPath`): longest whole-segment
/// prefix wins, and anything unclaimed belongs to `core`.
///
/// # Panics
///
/// Never with the exported catalog, which always has a `core` module.
pub fn find_module_for_path(path: &str) -> &'static ApiModule {
    let modules = api_modules();
    modules
        .iter()
        .flat_map(|module| module.prefixes.iter().map(move |prefix| (prefix, module)))
        .filter(|(prefix, _)| {
            path.strip_prefix(prefix.as_str())
                .is_some_and(|rest| rest.is_empty() || rest.starts_with(['/', '?']))
        })
        .max_by_key(|(prefix, _)| prefix.len())
        .map_or_else(
            || {
                modules
                    .iter()
                    .find(|m| m.id == "core")
                    .expect("the catalog has a core module")
            },
            |(_, module)| module,
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_catalogs_parse() {
        assert_ne!(permissions().objects.len(), 0);
        assert_eq!(api_modules()[0].id, "core");
    }

    #[test]
    fn constants_carry_the_catalog_values() {
        assert_eq!(permission_keys::GENERAL_READ, "general:read");
        assert_eq!(
            entity_events::SIGN_ENVELOPE_COMPLETED.wire(),
            "sign_envelope:completed"
        );
        assert_eq!(
            entity_events::SIGN_ENVELOPE_COMPLETED.dotted(),
            "sign_envelope.completed"
        );
        assert_eq!(flags::WELDMAIL_OUTBOUND_GUARD.default, "shadow");
        assert!(FIRST_PARTY_ORIGINS.contains(&"https://app.weldsuite.org"));
    }

    #[test]
    fn every_catalog_key_has_a_constant() {
        let from_json: Vec<&str> = permissions()
            .objects
            .iter()
            .flat_map(|o| o.permissions.iter().map(|p| p.key.as_str()))
            .collect();
        assert_eq!(from_json, permission_keys::ALL);
    }

    #[test]
    fn runtime_event_checks() {
        assert!(entity_events::is_known_entity_type("sign_template"));
        assert!(entity_events::is_known_action("sign_template", "created"));
        assert!(!entity_events::is_known_action("sign_template", "signed"));
        assert!(!entity_events::is_known_entity_type("co_machine"));
    }

    #[test]
    fn system_roles_are_present() {
        let roles = &permissions().system_roles;
        assert_eq!(roles["OWNER"].permissions, vec!["*".to_owned()]);
        for role in ["ADMIN", "MEMBER", "VIEWER"] {
            assert!(roles.contains_key(role), "{role}");
        }
    }

    #[test]
    fn licences_follow_the_owning_module_and_record_chats() {
        let crm = api_module("crm").expect("crm");
        let own = crm.apps.as_ref().expect("gated")[0].clone();
        let path = format!("{}/1", crm.prefixes[0]);
        assert_eq!(missing_licensed_app_for_path(&path, &[own.as_str()]), None);
        assert_eq!(
            missing_licensed_app_for_path::<&str>(&path, &[]),
            Some(own.as_str())
        );
        // Core paths are never gated.
        assert_eq!(licence_apps_for_path("/api/me/permissions"), None);
        // A company's chat also opens to the CRM's apps.
        let chat = licence_apps_for_path("/api/chat-entity-channels/company/c_1").expect("gated");
        assert!(chat.contains(&own.as_str()));
    }

    /// A module served by Rust must have a conformance suite that proves it.
    #[test]
    fn every_ported_module_has_a_conformance_suite() {
        let suites: serde_json::Value =
            serde_json::from_str(include_str!("../../../conformance/suites.json"))
                .expect("suites.json");
        let covered: Vec<&str> = suites["suites"]
            .as_array()
            .expect("suites")
            .iter()
            .filter_map(|suite| suite["module"].as_str())
            .collect();
        for module in api_modules().iter().filter(|m| m.rust) {
            assert!(
                covered.contains(&module.id.as_str()),
                "{} has no conformance suite",
                module.id
            );
        }
    }

    #[test]
    fn paths_resolve_to_their_module_on_whole_segments() {
        let crm = api_modules()
            .iter()
            .find(|m| m.id == "crm")
            .expect("crm module");
        let prefix = crm.prefixes[0].clone();
        assert_eq!(find_module_for_path(&prefix).id, "crm");
        assert_eq!(find_module_for_path(&format!("{prefix}/123")).id, "crm");
        assert_eq!(find_module_for_path(&format!("{prefix}?limit=5")).id, "crm");
        assert_eq!(
            find_module_for_path(&format!("{prefix}-not-a-segment")).id,
            "core"
        );
        assert_eq!(find_module_for_path("/api/nobody-owns-this").id, "core");
    }
}
