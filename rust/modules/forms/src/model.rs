//! The shapes of `@weldsuite/app-api-client/schemas/weldforms` the services
//! build: the operational settings (`formSettingsSchema`), the starter
//! templates and the blank definition.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::engine::{FormDefinition, FormThemeTokens};

pub(crate) const FORM_STATUSES: &[&str] = &["draft", "published", "closed"];
pub(crate) const FORM_ACCESS_LEVELS: &[&str] = &["workspace", "restricted"];
pub(crate) const FORM_ACCESS_ROLES: &[&str] = &["editor", "results"];
pub(crate) const FORM_RESPONDENT_MODES: &[&str] = &["anyone", "verified_email", "members"];
pub(crate) const FORM_SUBSCRIPTION_MODES: &[&str] = &["instant", "daily", "off"];
pub(crate) const FORM_LAYOUTS: &[&str] = &["conversational", "classic"];
pub(crate) const FORM_ABUSE_REASONS: &[&str] = &["phishing", "spam", "illegal", "other"];
pub(crate) const DEVICES: &[&str] = &["desktop", "tablet", "phone"];

/// `formSettingsSchema` with its defaults: operational settings, not
/// versioned, applied as soon as they are saved.
#[allow(clippy::struct_excessive_bools, reason = "the schema's switches")]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FormSettings {
    #[serde(default = "anyone")]
    pub(crate) respondent_mode: String,
    #[serde(default)]
    pub(crate) one_per_respondent: bool,
    #[serde(default)]
    pub(crate) allow_edit: bool,
    #[serde(default)]
    pub(crate) hide_member_identity: bool,
    #[serde(default)]
    pub(crate) collect_partial: bool,
    #[serde(default)]
    pub(crate) opens_at: Option<String>,
    #[serde(default)]
    pub(crate) closes_at: Option<String>,
    #[serde(default)]
    pub(crate) response_limit: Option<i64>,
    #[serde(default)]
    pub(crate) closed_message: Option<String>,
    #[serde(default)]
    pub(crate) allowed_embed_domains: Vec<String>,
    #[serde(default)]
    pub(crate) send_receipt: bool,
}

fn anyone() -> String {
    "anyone".to_owned()
}

impl Default for FormSettings {
    fn default() -> Self {
        Self {
            respondent_mode: anyone(),
            one_per_respondent: false,
            allow_edit: false,
            hide_member_identity: false,
            collect_partial: false,
            opens_at: None,
            closes_at: None,
            response_limit: None,
            closed_message: None,
            allowed_embed_domains: Vec::new(),
            send_receipt: false,
        }
    }
}

impl FormSettings {
    /// `formSettingsSchema.parse(value ?? {})`.
    pub(crate) fn parse(value: &Value) -> Self {
        if value.is_null() {
            return Self::default();
        }
        serde_json::from_value(value.clone()).unwrap_or_default()
    }

    pub(crate) fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| json!({}))
    }

    /// `formSettingsSchema.parse({ ...current, ...patch })`.
    pub(crate) fn merged(&self, patch: &serde_json::Map<String, Value>) -> Self {
        let mut merged = self.to_json();
        if let Value::Object(fields) = &mut merged {
            for (key, value) in patch {
                fields.insert(key.clone(), value.clone());
            }
        }
        Self::parse(&merged)
    }
}

/// `formDefinitionSchema.parse(value)` as JSON: the parsed definition when it
/// passes, else the value as stored.
pub(crate) fn parsed_definition(value: &Value) -> Value {
    FormDefinition::parse(value)
        .ok()
        .and_then(|def| serde_json::to_value(def).ok())
        .unwrap_or_else(|| value.clone())
}

/// `formThemeTokensSchema.parse(value ?? {})` as JSON.
pub(crate) fn parsed_theme(value: &Value) -> Value {
    let value = if value.is_null() {
        json!({})
    } else {
        value.clone()
    };
    FormThemeTokens::parse(&value)
        .ok()
        .and_then(|theme| serde_json::to_value(theme).ok())
        .unwrap_or(value)
}

// ---------------------------------------------------------------------------
// Starter templates (`STARTER_TEMPLATES`, exported by `pnpm rust:catalogs`)
// ---------------------------------------------------------------------------

static TEMPLATES: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str::<Value>(include_str!("../../../catalogs/forms-templates.json"))
        .ok()
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
});

/// The starter templates in gallery order: `{ id, category, name,
/// description, definition }`, each definition as Zod parses it.
pub fn starter_templates() -> &'static [Value] {
    &TEMPLATES
}

/// A template's definition by id.
pub(crate) fn template_definition(id: &str) -> Option<Value> {
    TEMPLATES
        .iter()
        .find(|template| template["id"] == id)
        .map(|template| template["definition"].clone())
}

const BASE62: &str = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// `newBlockId(prefix)`: `<prefix>_` and 8 random base62 characters.
pub(crate) fn new_block_id(prefix: &str) -> String {
    format!("{prefix}_{}", weldsuite_kit::random_string(8, BASE62))
}

/// `createBlankDefinition()`: no blocks, one "Thank you!" ending.
pub(crate) fn blank_definition() -> Value {
    parsed_definition(&json!({
        "blocks": [],
        "endings": [{ "id": new_block_id("e"), "ref": "thank_you", "title": "Thank you!" }],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_round_trip_through_the_engine() {
        assert!(starter_templates().len() >= 5, "the catalog has templates");
        for template in starter_templates() {
            let definition = &template["definition"];
            assert_eq!(
                &parsed_definition(definition),
                definition,
                "{} reads and writes as Zod does",
                template["id"]
            );
        }
        assert!(template_definition("contact-form").is_some());
        assert!(template_definition("no-such-template").is_none());
    }

    #[test]
    fn settings_fill_their_defaults() {
        let settings = FormSettings::parse(&json!({ "collectPartial": true }));
        assert!(settings.collect_partial);
        assert_eq!(settings.respondent_mode, "anyone");
        let json = settings.to_json();
        assert_eq!(json["opensAt"], Value::Null);
        assert_eq!(json["allowedEmbedDomains"], json!([]));
        let blank = blank_definition();
        assert_eq!(blank["blocks"], json!([]));
        assert_eq!(blank["endings"][0]["title"], "Thank you!");
    }
}
