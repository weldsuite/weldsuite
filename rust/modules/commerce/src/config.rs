//! What payments need beyond the database: the keys that open stored
//! credentials, the install's public URLs, its Mollie Connect app, and
//! WeldBooks. The server fills it from its config; the default is an install
//! with none of it (no OAuth, no invoicing), as the tests start from.

use std::sync::Arc;

use weldsuite_commerce_domain::payments::Env;
use weldsuite_commerce_domain::payments::books::Invoicing;
use weldsuite_db::{Keyring, PgPool};
use weldsuite_mollie::DEFAULT_API_URL;
use weldsuite_mollie::connect::ConnectApp;
use weldsuite_ports::OutboundHttp;

/// Payments settings (ADR COM-013).
#[derive(Clone)]
pub struct PaymentsConfig {
    /// `DATABASE_ENCRYPTION_KEY` / `_V2`: opens the stored tokens and keys.
    pub keyring: Keyring,
    /// The install's public origin: where Mollie posts webhooks and the OAuth
    /// callback lands (`CONNECTOR_WEBHOOK_BASE_URL`, else `PUBLIC_URL`).
    pub public_url: Option<String>,
    /// Where the platform is served (`PUBLIC_APP_URL`, else `public_url`):
    /// where the callback sends the merchant back to.
    pub app_url: Option<String>,
    /// Mollie's API.
    pub api_url: String,
    /// `MOLLIE_CONNECT_CLIENT_ID` and `MOLLIE_CONNECT_CLIENT_SECRET`.
    pub connect: Option<ConnectApp>,
    /// Signs the OAuth `state` (`CLERK_SECRET_KEY`, else `INTERNAL_API_SECRET`).
    pub state_secret: Option<String>,
    /// WeldBooks, for invoices and credit notes; without it nothing is
    /// invoiced and every order says so.
    pub invoicing: Option<Arc<dyn Invoicing>>,
}

impl Default for PaymentsConfig {
    fn default() -> Self {
        Self {
            keyring: Keyring::default(),
            public_url: None,
            app_url: None,
            api_url: DEFAULT_API_URL.to_owned(),
            connect: None,
            state_secret: None,
            invoicing: None,
        }
    }
}

impl std::fmt::Debug for PaymentsConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PaymentsConfig")
            .field("public_url", &self.public_url)
            .field("connect", &self.connect.is_some())
            .field("invoicing", &self.invoicing.is_some())
            .finish_non_exhaustive()
    }
}

impl PaymentsConfig {
    /// The install has a Mollie Connect app.
    #[must_use]
    pub fn oauth_available(&self) -> bool {
        self.connect.is_some()
    }

    /// Where Mollie sends the merchant back to after approving the app.
    #[must_use]
    pub fn callback_url(&self) -> Option<String> {
        self.public_url.as_deref().map(|base| {
            format!(
                "{}/api/commerce-payments/connection/mollie/callback",
                base.trim_end_matches('/')
            )
        })
    }

    /// The domain's environment on `db` and `http`.
    #[must_use]
    pub fn env<'a>(&'a self, db: &'a PgPool, http: &'a OutboundHttp) -> Env<'a> {
        Env {
            db,
            http,
            keyring: &self.keyring,
            api_url: &self.api_url,
            connect: self.connect.as_ref(),
        }
    }
}
