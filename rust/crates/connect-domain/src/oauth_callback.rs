//! Where OAuth providers send the browser back (ADR INT-014).
//!
//! On the Kubernetes editions every flow returns to Settings → Integrations'
//! callback page, which finishes connectors (Moneybird, Stripe) and workflow
//! providers (Google, Slack) alike. Global's TypeScript backend still sends
//! WeldConnect's old pages, and the conformance builds (edition `"global"`)
//! answer as it does. Drop the Global paths when Global is retired.

/// The return page on the Kubernetes editions, for every OAuth flow.
pub const SETTINGS_CALLBACK_PATH: &str = "/settings/integrations/callback";
/// Global's return page for connectors (Moneybird, Stripe).
pub const GLOBAL_CONNECTOR_CALLBACK_PATH: &str = "/weldconnect/connectors/callback";
/// Global's return page for workflow providers (Google, Slack).
pub const GLOBAL_WORKFLOW_CALLBACK_PATH: &str = "/weldconnect/integrations/callback";
/// The `connector_edition` that answers as Global's TypeScript backend.
pub const GLOBAL_EDITION: &str = "global";

/// The return page of a connector's OAuth flow on `edition`.
#[must_use]
pub fn connector_callback_path(edition: &str) -> &'static str {
    if edition == GLOBAL_EDITION {
        GLOBAL_CONNECTOR_CALLBACK_PATH
    } else {
        SETTINGS_CALLBACK_PATH
    }
}

/// The return page of a workflow provider's OAuth flow on `edition`.
#[must_use]
pub fn workflow_callback_path(edition: &str) -> &'static str {
    if edition == GLOBAL_EDITION {
        GLOBAL_WORKFLOW_CALLBACK_PATH
    } else {
        SETTINGS_CALLBACK_PATH
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kubernetes_editions_return_to_settings() {
        assert_eq!(
            connector_callback_path("kubernetes"),
            "/settings/integrations/callback"
        );
        assert_eq!(
            workflow_callback_path("kubernetes"),
            "/settings/integrations/callback"
        );
    }

    #[test]
    fn global_keeps_the_weldconnect_pages() {
        assert_eq!(
            connector_callback_path("global"),
            "/weldconnect/connectors/callback"
        );
        assert_eq!(
            workflow_callback_path("global"),
            "/weldconnect/integrations/callback"
        );
    }
}
