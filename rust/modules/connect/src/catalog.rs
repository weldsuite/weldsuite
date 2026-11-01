//! WeldConnect's code catalogs (`rust/catalogs/weldconnect.json`, written by
//! `pnpm rust:catalogs`): the built-in workflow templates resolved per
//! locale, and the editor's action, trigger and entity-event pickers.

use std::sync::OnceLock;

use serde_json::Value;

fn catalog() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../catalogs/weldconnect.json"))
            .unwrap_or(Value::Null)
    })
}

fn list(key: &str) -> &'static [Value] {
    catalog()
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// `toTemplateLocale(value)`: `en` or `nl` from `nl-NL`, `NL_be`, …; `en`
/// otherwise.
pub(crate) fn template_locale(value: Option<&str>) -> &'static str {
    let base = value
        .map(|v| {
            v.to_lowercase()
                .split(['-', '_'])
                .next()
                .unwrap_or_default()
                .to_owned()
        })
        .unwrap_or_default();
    if base == "nl" { "nl" } else { "en" }
}

/// The built-in templates (`ResolvedBuiltInTemplate`) in `locale`.
pub(crate) fn templates(locale: &str) -> &'static [Value] {
    catalog()
        .get("templates")
        .and_then(|t| t.get(locale))
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// `/api/workflow-dashboard/action-types`' list.
pub(crate) fn action_types() -> &'static [Value] {
    list("actionTypes")
}

/// `/api/workflow-dashboard/trigger-types`' list.
pub(crate) fn trigger_types() -> &'static [Value] {
    list("triggerTypes")
}

/// `listIntegrations()` of `@weldsuite/workflow-integrations`.
pub(crate) fn integrations() -> &'static [Value] {
    list("integrations")
}

/// `getIntegrationDef(id)`.
pub(crate) fn integration(id: &str) -> Option<&'static Value> {
    integrations()
        .iter()
        .find(|def| def["id"].as_str() == Some(id))
}

/// `/api/workflow-dashboard/entity-events`' list.
pub(crate) fn entity_events() -> &'static [Value] {
    list("entityEvents")
}
