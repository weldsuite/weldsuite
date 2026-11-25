//! WeldConnect's code catalog (`rust/catalogs/weldconnect.json`, written by
//! `pnpm rust:catalogs`), read once for every crate: the workflow
//! integration definitions (`@weldsuite/workflow-integrations`) and the
//! outbound webhook event picker, which the core integration routes
//! (`weldsuite-core-integrations`) and WeldConnect's engine
//! (`weldsuite-connect`) share. WeldConnect reads its own lists (templates,
//! action and trigger pickers) from [`catalog`].

use std::sync::OnceLock;

use serde_json::Value;

/// The whole catalog; `null` if it does not parse.
pub fn catalog() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../catalogs/weldconnect.json"))
            .unwrap_or(Value::Null)
    })
}

/// The array at `key`, else empty.
pub fn list(key: &str) -> &'static [Value] {
    catalog()
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// `listIntegrations()` of `@weldsuite/workflow-integrations`.
pub fn integrations() -> &'static [Value] {
    list("integrations")
}

/// `getIntegrationDef(id)`.
pub fn integration(id: &str) -> Option<&'static Value> {
    integrations()
        .iter()
        .find(|def| def["id"].as_str() == Some(id))
}

/// `listWebhookEvents()`: the outbound webhook event picker, in catalog order.
pub fn webhook_events() -> &'static [Value] {
    list("webhookEvents")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_reads() {
        let slack = integration("slack").map(|def| def["auth"]["clientIdEnv"].clone());
        assert_eq!(slack, Some(Value::from("SLACK_CLIENT_ID")));
        assert!(integration("no-such-integration").is_none());
        assert!(integrations().iter().all(|def| def["id"].is_string()));
        assert!(
            webhook_events()
                .iter()
                .any(|event| event == "person.created")
        );
    }
}
