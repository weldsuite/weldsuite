//! Online invoice payments through the legal entity's own Mollie account
//! (Rust only, edition feature `books-online-payments`; ADR BOOKS-013).
//!
//! The money is the entity's: its customers pay on Mollie's checkout into the
//! entity's own Mollie account, and WeldSuite holds nothing.
//!
//! - `connection`: the entity's connection (`accounting_payment_connections`),
//!   its sealed credentials and the Mollie client built on them.
//! - `routes`: `/api/accounting-payment-connections`, with the session.
//! - `pay`: `POST /public/weldbooks/documents/:token/pay` and what the public
//!   document shows of a payment.
//! - `webhook`: Mollie's webhook and the OAuth callback, which have no
//!   session. Their signed references are [`weldsuite_books_domain::payment_refs`].
//! - `settlements`: Mollie's payouts, read from Mollie and booked as fees and
//!   a transfer to the bank.
//!
//! A payment counts only once it is read back from Mollie as paid (COM-013):
//! the customer's redirect never marks anything paid.

pub(crate) mod connection;
pub(crate) mod pay;
mod routes;
pub(crate) mod settlements;
#[cfg(test)]
mod tests;
pub(crate) mod webhook;

use std::sync::Arc;

use axum::Router;
use http::StatusCode;
use weldsuite_books_domain::document_token;
use weldsuite_books_domain::http::{BooksState, Refusal};
use weldsuite_books_domain::posting::PostError;
use weldsuite_db::PgPool;
use weldsuite_kit::ApiError;
use weldsuite_mollie::connect::ConnectApp;
use weldsuite_mollie::{DEFAULT_API_URL, MollieError};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::OutboundHttp;

pub(crate) use webhook::public_routes;

/// The mount of the authenticated routes, under `/api`.
pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    routes::router(state, gate)
}

/// The provider this module connects (the only one yet).
pub(crate) const PROVIDER: &str = "mollie";

/// The name of the entity's money account at Mollie.
pub(crate) const ACCOUNT_NAME: &str = "Mollie";

/// What the install says about Mollie and its public addresses, from the
/// books settings (`BOOKS_ENV` in the server).
#[derive(Clone)]
pub(crate) struct Settings {
    pub api_url: String,
    /// The install's public origin: where Mollie posts its webhook and the
    /// OAuth callback lands (`CONNECTOR_WEBHOOK_BASE_URL`, `WEBHOOK_BASE_URL`
    /// or `PUBLIC_URL`).
    pub public_url: Option<String>,
    /// Where the platform is served (`PUBLIC_APP_URL`, else the public URL):
    /// the origin the OAuth callback may send the browser back to.
    pub app_url: Option<String>,
    /// The pay portal's origin (`PAY_PORTAL_PUBLIC_URL`): the origin a
    /// customer's return URL must be on.
    pub portal_url: Option<String>,
    /// The platform's Mollie Connect app (`MOLLIE_CONNECT_CLIENT_ID` and
    /// `MOLLIE_CONNECT_CLIENT_SECRET`).
    pub connect: Option<ConnectApp>,
    /// Signs the webhook references and the OAuth state: the same secret as
    /// the document links.
    pub secret: Option<Vec<u8>>,
}

fn trimmed(value: Option<&String>) -> Option<String> {
    value
        .map(|v| v.trim().trim_end_matches('/').to_owned())
        .filter(|v| v.starts_with("https://") || v.starts_with("http://"))
}

impl Settings {
    pub(crate) fn of(state: &BooksState) -> Self {
        let env = |name: &str| state.env.get(name).filter(|v| !v.trim().is_empty());
        let public_url = trimmed(env("CONNECTOR_WEBHOOK_BASE_URL"))
            .or_else(|| trimmed(env("WEBHOOK_BASE_URL")))
            .or_else(|| trimmed(env("PUBLIC_URL")));
        let connect = env("MOLLIE_CONNECT_CLIENT_ID")
            .zip(env("MOLLIE_CONNECT_CLIENT_SECRET"))
            .map(|(id, secret)| ConnectApp::new(id, secret));
        Self {
            api_url: env("MOLLIE_API_URL").map_or_else(|| DEFAULT_API_URL.to_owned(), Clone::clone),
            app_url: trimmed(env("PUBLIC_APP_URL")).or_else(|| public_url.clone()),
            public_url,
            portal_url: trimmed(env("PAY_PORTAL_PUBLIC_URL")),
            connect,
            secret: document_token::secret(
                env("BOOKS_DOCUMENT_TOKEN_SECRET").map(String::as_str),
                &state.keyring,
            ),
        }
    }

    /// Where Mollie sends the merchant back to after approving the app.
    pub(crate) fn callback_url(&self) -> Option<String> {
        self.public_url
            .as_deref()
            .map(|base| format!("{base}/public/weldbooks/mollie/callback"))
    }

    /// The webhook of a payment (the signed reference is the credential).
    pub(crate) fn webhook_url(&self, signed_ref: &str) -> Option<String> {
        self.public_url
            .as_deref()
            .map(|base| format!("{base}/public/weldbooks/mollie/webhook/{signed_ref}"))
    }
}

/// Why an online-payment step failed.
#[derive(Debug)]
pub(crate) enum PayError {
    /// The entity has no usable Mollie connection.
    NotConnected,
    /// Not set up on this install (no outbound HTTP, no public address).
    Unavailable(&'static str),
    /// Mollie refused the request itself (a 4xx): retrying won't help.
    Refused(String),
    /// Mollie could not be reached, or failed (5xx): retrying may help.
    Transient(String),
    /// The caller asked for something that cannot be done.
    Invalid(String),
    Db(sea_orm::DbErr),
    Post(PostError),
}

impl From<sea_orm::DbErr> for PayError {
    fn from(error: sea_orm::DbErr) -> Self {
        Self::Db(error)
    }
}

impl From<PostError> for PayError {
    fn from(error: PostError) -> Self {
        Self::Post(error)
    }
}

impl From<MollieError> for PayError {
    fn from(error: MollieError) -> Self {
        if error.is_refusal() {
            Self::Refused(error.to_string())
        } else {
            Self::Transient(error.to_string())
        }
    }
}

impl std::fmt::Display for PayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConnected => f.write_str("No Mollie account is connected"),
            Self::Unavailable(why) => f.write_str(why),
            Self::Invalid(why) | Self::Refused(why) | Self::Transient(why) => f.write_str(why),
            Self::Db(error) => error.fmt(f),
            Self::Post(error) => error.fmt(f),
        }
    }
}

impl PayError {
    /// The refusal an authenticated route answers with.
    pub(crate) fn refusal(self) -> Refusal {
        match self {
            Self::NotConnected => Refusal::conflict("No Mollie account is connected"),
            Self::Unavailable(why) => Refusal::unavailable(why),
            Self::Invalid(why) => Refusal::bad_request(why),
            Self::Refused(why) => {
                Refusal::bad_request(format!("Mollie refused the request: {why}"))
            }
            Self::Transient(why) => ApiError::new(
                StatusCode::BAD_GATEWAY,
                "PROVIDER_ERROR",
                format!("Mollie could not be reached: {why}"),
            )
            .into(),
            Self::Db(error) => Refusal::Database(error),
            Self::Post(error) => match error.user_message() {
                Some(message) => Refusal::bad_request(message),
                None => match error {
                    PostError::Database(error) => Refusal::Database(error),
                    other => Refusal::Internal(other.to_string()),
                },
            },
        }
    }
}

/// What every step needs: the tenant, outbound HTTP, the keys and the settings.
#[derive(Clone)]
pub(crate) struct Ctx {
    pub db: PgPool,
    pub http: OutboundHttp,
    pub books: BooksState,
    pub settings: Settings,
}

impl Ctx {
    /// `None` when the install has no outbound HTTP.
    pub(crate) fn new(books: &BooksState, db: &PgPool, http: Option<OutboundHttp>) -> Option<Self> {
        Some(Self {
            db: db.clone(),
            http: http.or_else(|| books.http.clone())?,
            books: books.clone(),
            settings: Settings::of(books),
        })
    }
}
