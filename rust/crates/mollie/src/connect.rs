//! Mollie Connect (OAuth 2): a platform acts for a merchant's own Mollie
//! organisation with an access token the merchant granted (ADR COM-013).
//!
//! The merchant is sent to [`ConnectApp::authorize_url`]; Mollie redirects
//! back with a `code`, which [`ConnectApp::exchange_code`] turns into an
//! access token (valid an hour) and a refresh token. [`ConnectApp::refresh`]
//! gets a new access token; [`ConnectApp::revoke`] ends the grant. The
//! access token goes to [`crate::Mollie::new`] like an API key does.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::{Mollie as Client, MollieError};

/// Where the merchant approves the app.
pub const DEFAULT_AUTHORIZE_URL: &str = "https://my.mollie.com/oauth2/authorize";
/// Where codes and refresh tokens are exchanged for access tokens.
pub const DEFAULT_TOKEN_URL: &str = "https://api.mollie.com/oauth2/tokens";

/// What WeldCommerce asks the merchant for: take payments and refund them,
/// and read the organisation and its website profiles.
pub const COMMERCE_SCOPES: &[&str] = &[
    "payments.read",
    "payments.write",
    "refunds.read",
    "refunds.write",
    "profiles.read",
    "organizations.read",
];

/// The platform's Mollie Connect app: its client id and secret.
#[derive(Clone)]
pub struct ConnectApp {
    client_id: String,
    client_secret: String,
    authorize_url: String,
    token_url: String,
}

impl std::fmt::Debug for ConnectApp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectApp")
            .field("client_id", &self.client_id)
            .finish_non_exhaustive()
    }
}

/// An access token and what comes with it.
#[derive(Clone, PartialEq, Eq)]
pub struct Tokens {
    pub access_token: String,
    /// Absent when Mollie keeps the old refresh token valid.
    pub refresh_token: Option<String>,
    /// Seconds the access token lasts.
    pub expires_in: i64,
    /// The scopes granted, space separated.
    pub scope: Option<String>,
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tokens")
            .field("expires_in", &self.expires_in)
            .finish_non_exhaustive()
    }
}

impl Tokens {
    fn from_json(body: &Value) -> Option<Self> {
        let text = |key: &str| {
            body.get(key)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        Some(Self {
            access_token: text("access_token")?,
            refresh_token: text("refresh_token"),
            expires_in: body
                .get("expires_in")
                .and_then(Value::as_i64)
                .unwrap_or(3600),
            scope: text("scope"),
        })
    }
}

impl ConnectApp {
    /// The app with `client_id` and `client_secret`, on Mollie's own hosts.
    pub fn new(client_id: &str, client_secret: &str) -> Self {
        Self {
            client_id: client_id.trim().to_owned(),
            client_secret: client_secret.trim().to_owned(),
            authorize_url: DEFAULT_AUTHORIZE_URL.to_owned(),
            token_url: DEFAULT_TOKEN_URL.to_owned(),
        }
    }

    /// The app on other hosts (a test double).
    #[must_use]
    pub fn with_urls(mut self, authorize_url: &str, token_url: &str) -> Self {
        authorize_url.trim().clone_into(&mut self.authorize_url);
        token_url.trim().clone_into(&mut self.token_url);
        self
    }

    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    /// The page the merchant approves the app on; Mollie redirects to
    /// `redirect_uri` with `code` and `state`. `None` when the app's
    /// authorize URL is not a URL.
    pub fn authorize_url(
        &self,
        redirect_uri: &str,
        state: &str,
        scopes: &[&str],
    ) -> Option<String> {
        let mut url = url::Url::parse(&self.authorize_url).ok()?;
        url.query_pairs_mut()
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("state", state)
            .append_pair("scope", &scopes.join(" "))
            .append_pair("response_type", "code")
            .append_pair("approval_prompt", "auto");
        Some(url.into())
    }

    fn form(&self, method: &str, fields: &[(&str, &str)]) -> HttpRequest {
        let mut body = url::form_urlencoded::Serializer::new(String::new());
        for (name, value) in fields {
            body.append_pair(name, value);
        }
        let credentials = STANDARD.encode(format!("{}:{}", self.client_id, self.client_secret));
        HttpRequest {
            method: method.to_owned(),
            url: self.token_url.clone(),
            headers: vec![
                (
                    "content-type".to_owned(),
                    "application/x-www-form-urlencoded".to_owned(),
                ),
                ("authorization".to_owned(), format!("Basic {credentials}")),
            ],
            body: Some(body.finish().into_bytes()),
        }
    }

    /// `POST /oauth2/tokens` with the `code` of the redirect.
    pub async fn exchange_code(
        &self,
        http: &OutboundHttp,
        code: &str,
        redirect_uri: &str,
    ) -> Result<Tokens, MollieError> {
        let request = self.form(
            "POST",
            &[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", redirect_uri),
            ],
        );
        let body = Client::json_of(http.send(request).await)?;
        Tokens::from_json(&body).ok_or(MollieError::Malformed)
    }

    /// `POST /oauth2/tokens` with a refresh token: a new access token.
    pub async fn refresh(
        &self,
        http: &OutboundHttp,
        refresh_token: &str,
    ) -> Result<Tokens, MollieError> {
        let request = self.form(
            "POST",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
            ],
        );
        let body = Client::json_of(http.send(request).await)?;
        Tokens::from_json(&body).ok_or(MollieError::Malformed)
    }

    /// `DELETE /oauth2/tokens`: ends the grant of a token (`access_token` or
    /// `refresh_token`). A token Mollie no longer knows counts as revoked.
    pub async fn revoke(
        &self,
        http: &OutboundHttp,
        token: &str,
        hint: &str,
    ) -> Result<(), MollieError> {
        let request = self.form("DELETE", &[("token", token), ("token_type_hint", hint)]);
        match Client::json_of(http.send(request).await) {
            Ok(_) => Ok(()),
            Err(error) if error.is_not_found() || error.is_unauthorized() => Ok(()),
            Err(error) => Err(error),
        }
    }
}
