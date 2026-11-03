//! The connector catalog (`@weldsuite/connectors` `catalog.ts`,
//! `field-mappings.ts`), as `pnpm rust:catalogs` exports it to
//! `rust/catalogs/connectors.json`: each connector's label, category, icon,
//! auth and syncs, and the default field mappings per entity type.

use std::sync::OnceLock;

use serde_json::Value;

fn catalog() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../catalogs/connectors.json"))
            .unwrap_or(Value::Null)
    })
}

/// `DEFAULT_ENABLED_SYNCS`.
pub const DEFAULT_ENABLED_SYNCS: [&str; 3] = ["products", "orders", "customers"];

/// `listConnectors()`, in catalog order.
pub fn list_connectors() -> &'static [Value] {
    catalog()["connectors"]
        .as_array()
        .map_or(&[], Vec::as_slice)
}

/// `getConnector(provider)`.
pub fn get_connector(provider: &str) -> Option<&'static Value> {
    list_connectors()
        .iter()
        .find(|c| c["provider"].as_str() == Some(provider))
}

/// A connector's syncs (`connector.syncs`).
pub fn syncs(connector: &Value) -> &[Value] {
    connector["syncs"].as_array().map_or(&[], Vec::as_slice)
}

/// `getDefaultConnectorFieldMappings(entityType, provider)`.
pub fn default_field_mappings(entity_type: &str, provider: Option<&str>) -> Vec<Value> {
    if provider == Some("picqer") && entity_type == "product" {
        return catalog()["picqerProductFieldMappings"]
            .as_array()
            .cloned()
            .unwrap_or_default();
    }
    // Stripe's mapper owns every field.
    if provider == Some("stripe") {
        return Vec::new();
    }
    catalog()["defaultFieldMappings"][entity_type]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

/// `connectorEntityTypes(provider)`: the internal entities its syncs fill,
/// first appearance first.
pub fn entity_types(provider: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(connector) = get_connector(provider) {
        for sync in syncs(connector) {
            if let Some(entity) = sync["internalEntity"].as_str()
                && !out.iter().any(|e| e == entity)
            {
                out.push(entity.to_owned());
            }
        }
    }
    out
}

/// `normalizeEnabledSyncs(provider, enabled)` (connect-api's connectors
/// route): the requested syncs the connector knows (by sync name or setting
/// key), or all of its setting keys when none were asked for.
pub fn normalize_enabled_syncs(provider: &str, enabled: Option<&[String]>) -> Vec<String> {
    let requested = enabled.filter(|e| !e.is_empty());
    let Some(connector) = get_connector(provider) else {
        return requested.map_or_else(
            || {
                DEFAULT_ENABLED_SYNCS
                    .iter()
                    .map(|s| (*s).to_owned())
                    .collect()
            },
            <[String]>::to_vec,
        );
    };
    let syncs = syncs(connector);
    let allowed = |value: &str| {
        syncs.iter().any(|s| {
            s["syncName"].as_str() == Some(value) || s["settingKey"].as_str() == Some(value)
        })
    };
    let requested: Vec<String> = requested.map_or_else(
        || {
            syncs
                .iter()
                .filter_map(|s| s["settingKey"].as_str().map(str::to_owned))
                .collect()
        },
        <[String]>::to_vec,
    );
    requested.into_iter().filter(|v| allowed(v)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_loads() {
        let providers: Vec<&str> = list_connectors()
            .iter()
            .filter_map(|c| c["provider"].as_str())
            .collect();
        assert!(providers.contains(&"woocommerce"));
        assert!(providers.contains(&"picqer"));
        assert_ne!(default_field_mappings("product", None).len(), 0);
        assert_eq!(
            default_field_mappings("product", Some("stripe")).first(),
            None
        );
        assert_eq!(default_field_mappings("product", Some("picqer")).len(), 7);
        assert_eq!(default_field_mappings("nothing", None).first(), None);
    }

    #[test]
    fn enabled_syncs() {
        let all = normalize_enabled_syncs("woocommerce", None);
        assert_ne!(all.len(), 0);
        let picked = normalize_enabled_syncs(
            "woocommerce",
            Some(&["products".to_owned(), "x".to_owned()]),
        );
        assert_eq!(picked, vec!["products".to_owned()]);
        assert_eq!(normalize_enabled_syncs("nope", None).len(), 3);
    }
}
