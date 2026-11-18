//! The AI settings email (`packages/core/emails/src/templates/ai/`): the
//! function takes the template's props, picks the variant its React component
//! would render and fills it in. It never carries a key.

use std::collections::BTreeMap;

use minijinja::Value;

use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, render};

/// `AiProviderEnabledEmailProps`: an admin enabled a provider outside the EU.
/// Sent to the workspace owners.
#[derive(Debug, Clone, Default)]
pub struct ProviderEnabled {
    pub recipient_name: Option<String>,
    pub workspace_name: String,
    /// Display name of the provider, e.g. `Anthropic`.
    pub provider_name: String,
    /// Who enabled it: a name, or an email address when there is no name.
    pub enabled_by: String,
    /// The workspace's own key pays for the calls (else WeldSuite's account,
    /// charged as AI credits).
    pub own_key: bool,
    /// The AI settings page (`/settings/ai` on the workspace's platform).
    pub settings_url: String,
}

/// Renders `ai.provider-enabled`.
///
/// # Errors
///
/// [`EmailError`] when the exported template cannot be rendered.
pub fn provider_enabled(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &ProviderEnabled,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = BTreeMap::new();
    for (key, value) in [
        ("workspace_name", props.workspace_name.as_str()),
        ("provider_name", props.provider_name.as_str()),
        ("enabled_by", props.enabled_by.as_str()),
        ("url", props.settings_url.as_str()),
    ] {
        values.insert(key.to_owned(), Value::from(value));
    }
    // `props.recipientName?.trim()`
    if let Some(name) = props
        .recipient_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        flags.push("name");
        values.insert("recipient_name".to_owned(), Value::from(name));
    }
    if props.own_key {
        flags.push("own");
    }
    render("ai.provider-enabled", locale, brand, &flags, values)
}
