//! The backend of WeldSuite's own sign-in screens on an OIDC provider
//! (`/api/sign-in`, ADR SEC-016), for the Kubernetes editions.
//!
//! Global signs in on Clerk from the browser and has no such routes: this
//! module has no TypeScript twin and is not in the conformance suite. On EU
//! and self-hosted the platform shows the same screens, and these routes
//! stand behind them as the provider's login client (the
//! [`SignInProvider`] port; Zitadel in `weldsuite-adapters-oss`):
//!
//! 1. The platform starts an OIDC authorization, as before. The provider's
//!    sign-in for the platform's application points at the platform's
//!    `/auth/login`, so the browser lands there with `?authRequest=…`.
//! 2. The screens call these routes. Each answers the next step
//!    ([`flow::Step`]): a form to show, or, once the session has everything
//!    the account and the provider's policy need, the provider's callback
//!    URL.
//! 3. The browser follows that URL to `/auth/sso-callback` and the OIDC
//!    sign-in finishes exactly as it does from the provider's own pages:
//!    code, PKCE, tokens. Nothing downstream of sign-in changes.
//!
//! | Route | Does |
//! |---|---|
//! | `GET /request` | where a sign-in stands; continues with the browser's session |
//! | `POST /password` | checks the password, opens the session |
//! | `POST /second-factor` | checks an authenticator or emailed code |
//! | `POST /second-factor/email-code` | emails the second-factor code |
//! | `POST /email-verification` | verifies the address with the emailed code |
//! | `POST /email-verification/resend`, `/link` | sends the code again; verifies from the email's link |
//! | `POST /sign-up` | creates the account, emails the code |
//! | `GET /password-policy` | the provider's rules for a new password |
//! | `POST /password-reset`, `/confirm` | emails a reset code; sets the new password |
//! | `POST /invitation/accept` | checks an invitation's code, sets the first password, opens the session |
//! | `POST /sign-out` | ends the provider session |
//!
//! No route takes a session token, so each counts its attempts
//! ([`limits`]). The provider session is kept in an `HttpOnly` cookie
//! ([`cookie`]); passwords and codes pass through to the provider and are
//! never stored or logged.
//!
//! The codes are emailed in WeldSuite's own templates when the server has
//! system mail and the platform's address; otherwise the provider sends its
//! own ([`mail`]).

mod cookie;
mod flow;
mod limits;
mod mail;
mod routes;

use std::sync::Arc;

use axum::Router;
use axum::routing::{get, post};
use weldsuite_ports::{DynCache, DynSystemMail, SignInProvider};

use crate::limits::Limits;

/// Where the links in the sign-in emails point: the platform's pages.
/// `{user}` and `{code}` are the provider's to fill in, or ours when
/// WeldSuite sends the email.
#[derive(Debug, Default)]
struct Links {
    verification: Option<String>,
    second_factor: Option<String>,
    password_reset: Option<String>,
}

impl Links {
    fn new(platform_url: Option<&str>) -> Self {
        let Some(platform) = platform_url
            .map(|url| url.trim().trim_end_matches('/'))
            .filter(|url| !url.is_empty())
        else {
            // No platform address: the provider's own links.
            return Self::default();
        };
        Self {
            verification: Some(format!(
                "{platform}/auth/login?verifyUser={{user}}&verifyCode={{code}}"
            )),
            second_factor: Some(format!("{platform}/auth/login")),
            password_reset: Some(format!(
                "{platform}/auth/reset-password?userId={{user}}&code={{code}}"
            )),
        }
    }

    fn verification(&self) -> Option<&str> {
        self.verification.as_deref()
    }

    fn second_factor(&self) -> Option<&str> {
        self.second_factor.as_deref()
    }

    fn password_reset(&self) -> Option<&str> {
        self.password_reset.as_deref()
    }

    /// The verification link for `user` and `code`.
    fn verification_for(&self, user: &str, code: &str) -> Option<String> {
        Some(fill(self.verification()?, user, code))
    }

    /// The reset link for `user` and `code`.
    fn password_reset_for(&self, user: &str, code: &str) -> Option<String> {
        Some(fill(self.password_reset()?, user, code))
    }
}

/// A link template with the account's id and the code written in.
fn fill(template: &str, user: &str, code: &str) -> String {
    template
        .replace("{user}", &percent(user))
        .replace("{code}", &percent(code))
}

/// Percent-encodes everything but unreserved characters.
fn percent(value: &str) -> String {
    use std::fmt::Write as _;
    value.bytes().fold(String::new(), |mut out, byte| {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
        out
    })
}

/// What the routes run on.
#[derive(Clone)]
pub struct SignInState {
    provider: Arc<dyn SignInProvider>,
    limits: Limits,
    links: Arc<Links>,
    /// The system mail, when WeldSuite emails the codes itself.
    mail: Option<Arc<dyn DynSystemMail>>,
}

impl SignInState {
    /// `cache` holds the attempt counters (the shared cache, so every
    /// replica counts together). `platform_url` is the platform's origin,
    /// for the links in the provider's emails; without it they point at the
    /// provider's own pages. `trusted_proxies` is how many proxies stand in
    /// front of the server (`TRUSTED_PROXIES`), to find the caller's address.
    pub fn new(
        provider: Arc<dyn SignInProvider>,
        cache: Arc<dyn DynCache>,
        platform_url: Option<&str>,
        trusted_proxies: usize,
    ) -> Self {
        Self {
            provider,
            limits: Limits::new(cache, trusted_proxies),
            links: Arc::new(Links::new(platform_url)),
            mail: None,
        }
    }

    /// Email the codes in WeldSuite's templates through `mail` (with a
    /// platform address for the links); without it the provider sends its
    /// own.
    #[must_use]
    pub fn with_mail(mut self, mail: Option<Arc<dyn DynSystemMail>>) -> Self {
        self.mail = mail;
        self
    }
}

impl std::fmt::Debug for SignInState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignInState")
            .field("links", &self.links)
            .field("mail", &self.mail.is_some())
            .finish_non_exhaustive()
    }
}

/// The routes, relative to `/api/sign-in`. They go in ahead of the session
/// check: nobody calling them is signed in.
pub fn router<S>(state: SignInState) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/request", get(routes::request))
        .route("/password", post(routes::password))
        .route("/second-factor", post(routes::second_factor))
        .route(
            "/second-factor/email-code",
            post(routes::send_second_factor_code),
        )
        .route("/email-verification", post(routes::verify_email))
        .route(
            "/email-verification/resend",
            post(routes::resend_verification),
        )
        .route("/email-verification/link", post(routes::verify_email_link))
        .route("/sign-up", post(routes::sign_up))
        .route("/password-policy", get(routes::password_policy))
        .route("/password-reset", post(routes::password_reset))
        .route(
            "/password-reset/confirm",
            post(routes::password_reset_confirm),
        )
        .route("/invitation/accept", post(routes::accept_invitation))
        .route("/sign-out", post(routes::sign_out))
        .with_state(state)
}

#[cfg(test)]
mod tests;
