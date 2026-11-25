//! WeldConnect's code catalogs (`rust/catalogs/weldconnect.json`, written by
//! `pnpm rust:catalogs`, read through
//! [`weldsuite_connect_domain::workflow_catalog`]): the built-in workflow
//! templates resolved per locale, and the editor's action, trigger and
//! entity-event pickers.

use serde_json::Value;
use weldsuite_connect_domain::workflow_catalog::{catalog, list};

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

/// `/api/workflow-dashboard/entity-events`' list.
pub(crate) fn entity_events() -> &'static [Value] {
    list("entityEvents")
}
