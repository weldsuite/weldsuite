//! Where the session token keys come from, as `verifyToken` in
//! `@clerk/backend` gets them:
//!
//! - a fixed key: `CLERK_JWT_KEY` (PEM) or a mounted JWKS document;
//! - fetched keys: the instance's JWKS from Clerk's Backend API with
//!   `CLERK_SECRET_KEY`, or from any JWKS URL. Fetched on first use, reused
//!   for an hour, and fetched again (at most every 30 seconds) when a token
//!   names a key id the cached set doesn't have, which is how a key rotation
//!   reaches us.
//!
//! An OIDC provider's keys are fetched the same way, from the `jwks_uri` of
//! its discovery document (`{issuer}/.well-known/openid-configuration`, read
//! on first use and again after a failed key fetch) or a configured JWKS URL.
//! Which rules a token is checked against, Clerk's or OIDC's, is part of the
//! verifier too, so the middleware is the same for both.

use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::Mutex;
use weldsuite_kit::ApiError;

use crate::oidc::{OidcRules, OidcSettings};
use crate::verifier::{AuthContext, ClerkRules, ClerkVerifier, KeyError, KeySet, TokenError};

/// Clerk's Backend API JWKS endpoint.
pub const CLERK_JWKS_URL: &str = "https://api.clerk.com/v1/jwks";

/// How long a fetched key set is reused.
const KEYS_TTL: Duration = Duration::from_secs(3600);

/// The least time between two fetches triggered by unknown key ids.
const REFETCH_INTERVAL: Duration = Duration::from_secs(30);

/// Fetched keys and when they were fetched.
struct Fetched {
    keys: Arc<KeySet>,
    at: Instant,
}

/// Where fetched keys come from.
enum Source {
    /// A JWKS URL, with `Authorization: Bearer` when set.
    Url { url: String, bearer: Option<String> },
    /// The `jwks_uri` of the issuer's discovery document, cached once read.
    Discovery {
        discovery_url: String,
        issuer: String,
        jwks_uri: RwLock<Option<String>>,
    },
}

struct Remote {
    source: Source,
    /// [`REFETCH_INTERVAL`] unless changed with
    /// [`SessionVerifier::with_refetch_interval`].
    refetch_interval: Duration,
    client: reqwest::Client,
    current: RwLock<Option<Fetched>>,
    /// Serialises fetches, so a burst of requests fetches once.
    fetching: Mutex<()>,
}

/// Which provider's rules a token is checked against.
enum Rules {
    Clerk(ClerkRules),
    Oidc(OidcRules),
}

impl Rules {
    fn verify(&self, keys: &KeySet, token: &str, now: u64) -> Result<AuthContext, TokenError> {
        match self {
            Self::Clerk(rules) => rules.verify(keys, token, now),
            Self::Oidc(rules) => rules.verify(keys, token, now),
        }
    }

    fn provider(&self) -> &'static str {
        match self {
            Self::Clerk(_) => "Clerk",
            Self::Oidc(_) => "OIDC",
        }
    }

    /// Clerk's documents must load whole; an OIDC provider's may carry keys
    /// that aren't for signing.
    fn parse_jwks(&self, jwks: &str) -> Result<KeySet, KeyError> {
        match self {
            Self::Clerk(_) => KeySet::from_jwks_strict(jwks),
            Self::Oidc(_) => KeySet::from_jwks_signing(jwks),
        }
    }
}

/// Verifies session tokens with a fixed key or keys fetched from a JWKS URL,
/// against Clerk's rules or an OIDC provider's.
pub struct SessionVerifier {
    keys: Keys,
    rules: Rules,
}

enum Keys {
    Fixed(Arc<KeySet>),
    Remote(Box<Remote>),
}

impl std::fmt::Debug for SessionVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = match &self.keys {
            Keys::Fixed(_) => "fixed",
            Keys::Remote(remote) => match &remote.source {
                Source::Url { url, .. } => url.as_str(),
                Source::Discovery { discovery_url, .. } => discovery_url.as_str(),
            },
        };
        f.debug_struct("SessionVerifier")
            .field("provider", &self.rules.provider())
            .field("keys", &kind)
            .finish()
    }
}

impl From<ClerkVerifier> for SessionVerifier {
    fn from(verifier: ClerkVerifier) -> Self {
        Self {
            keys: Keys::Fixed(verifier.keys),
            rules: Rules::Clerk(verifier.rules),
        }
    }
}

fn http_client() -> Result<reqwest::Client, KeyError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| KeyError::new(error.to_string()))
}

impl SessionVerifier {
    /// Keys fetched from `url`, with `Authorization: Bearer <bearer>` when
    /// given (Clerk's Backend API wants the secret key).
    // `authorized_parties` stays owned: the signature callers already use.
    #[allow(clippy::needless_pass_by_value)]
    pub fn remote(
        url: impl Into<String>,
        bearer: Option<String>,
        authorized_parties: Option<String>,
    ) -> Result<Self, KeyError> {
        Ok(Self {
            keys: Keys::Remote(Box::new(Remote::new(Source::Url {
                url: url.into(),
                bearer,
            })?)),
            rules: Rules::Clerk(ClerkRules::new(authorized_parties.as_deref())),
        })
    }

    /// Keys from Clerk's Backend API, authenticated with `CLERK_SECRET_KEY`.
    pub fn clerk_backend_api(
        secret_key: String,
        authorized_parties: Option<String>,
    ) -> Result<Self, KeyError> {
        Self::remote(CLERK_JWKS_URL, Some(secret_key), authorized_parties)
    }

    /// An OIDC provider's tokens, with its keys fetched from
    /// `settings.jwks_url` or, without one, through discovery. Nothing is
    /// fetched until the first token arrives, so the server starts while the
    /// provider is still coming up.
    pub fn oidc(settings: OidcSettings) -> Result<Self, KeyError> {
        Self::check_oidc(&settings)?;
        let source = match &settings.jwks_url {
            Some(url) => Source::Url {
                url: url.clone(),
                bearer: None,
            },
            None => Source::Discovery {
                discovery_url: settings.discovery_url(),
                issuer: settings.issuer.clone(),
                jwks_uri: RwLock::new(None),
            },
        };
        Ok(Self {
            keys: Keys::Remote(Box::new(Remote::new(source)?)),
            rules: Rules::Oidc(OidcRules { settings }),
        })
    }

    /// An OIDC provider's tokens against a fixed JWKS document (a mounted
    /// file, or tests).
    pub fn oidc_with_jwks(settings: OidcSettings, jwks: &str) -> Result<Self, KeyError> {
        Self::check_oidc(&settings)?;
        Ok(Self {
            keys: Keys::Fixed(Arc::new(KeySet::from_jwks_signing(jwks)?)),
            rules: Rules::Oidc(OidcRules { settings }),
        })
    }

    fn check_oidc(settings: &OidcSettings) -> Result<(), KeyError> {
        if settings.issuer.is_empty() {
            return Err(KeyError::new("the OIDC issuer is empty".to_owned()));
        }
        if settings.audiences.iter().all(String::is_empty) {
            return Err(KeyError::new("no OIDC audience is configured".to_owned()));
        }
        if settings.org_claim.is_empty() {
            return Err(KeyError::new(
                "the OIDC organization claim is empty".to_owned(),
            ));
        }
        Ok(())
    }

    /// How soon after a fetch a token with an unknown key id may trigger the
    /// next one (30 seconds by default). No effect on fixed keys.
    #[must_use]
    pub fn with_refetch_interval(mut self, interval: Duration) -> Self {
        if let Keys::Remote(remote) = &mut self.keys {
            remote.refetch_interval = interval;
        }
        self
    }

    /// `Clerk` or `OIDC`.
    pub fn provider(&self) -> &'static str {
        self.rules.provider()
    }

    /// Verify a token at `now` (Unix seconds).
    pub async fn verify(&self, token: &str, now: u64) -> Result<AuthContext, TokenError> {
        let remote = match &self.keys {
            Keys::Fixed(keys) => return self.rules.verify(keys, token, now),
            Keys::Remote(remote) => remote,
        };
        let keys = remote.keys(false, &self.rules).await?;
        match self.rules.verify(&keys, token, now) {
            // A key we don't have yet: the provider may have rotated keys.
            Err(TokenError::UnknownKey) => {
                let keys = remote.keys(true, &self.rules).await?;
                self.rules.verify(&keys, token, now)
            }
            result => result,
        }
    }

    /// Check an `Authorization` header value, answering as `clerkMiddleware`
    /// does.
    pub async fn authenticate(
        &self,
        authorization: Option<&str>,
        now: u64,
    ) -> Result<AuthContext, ApiError> {
        let Some(token) = authorization.and_then(|value| value.strip_prefix("Bearer ")) else {
            return Err(
                ApiError::unauthorized().with_message("Missing or invalid Authorization header")
            );
        };
        self.verify(token, now)
            .await
            .map_err(|error| crate::verifier::refusal(error, self.rules.provider()))
    }
}

impl Remote {
    fn new(source: Source) -> Result<Self, KeyError> {
        Ok(Self {
            source,
            client: http_client()?,
            current: RwLock::new(None),
            fetching: Mutex::new(()),
            refetch_interval: REFETCH_INTERVAL,
        })
    }

    /// The current key set; fetched when there is none, when it is older than
    /// [`KEYS_TTL`], or when `refresh` asks and the last fetch is older than
    /// the refetch interval.
    async fn keys(&self, refresh: bool, rules: &Rules) -> Result<Arc<KeySet>, TokenError> {
        if let Some(keys) = self.usable(refresh) {
            return Ok(keys);
        }
        let _guard = self.fetching.lock().await;
        // Another request may have fetched while this one waited.
        if let Some(keys) = self.usable(refresh) {
            return Ok(keys);
        }
        match self.fetch(rules).await {
            Ok(keys) => {
                let keys = Arc::new(keys);
                *self
                    .current
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Fetched {
                    keys: Arc::clone(&keys),
                    at: Instant::now(),
                });
                Ok(keys)
            }
            Err(error) => {
                tracing::error!(%error, source = %self.describe(), "session keys: fetching the JWKS failed");
                // Keep serving with the keys we have, if any.
                self.current
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .as_ref()
                    .map(|fetched| Arc::clone(&fetched.keys))
                    .ok_or(TokenError::UnknownKey)
            }
        }
    }

    fn describe(&self) -> &str {
        match &self.source {
            Source::Url { url, .. } => url,
            Source::Discovery { discovery_url, .. } => discovery_url,
        }
    }

    fn usable(&self, refresh: bool) -> Option<Arc<KeySet>> {
        let current = self
            .current
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fetched = current.as_ref()?;
        let age = fetched.at.elapsed();
        let fresh = if refresh {
            age < self.refetch_interval
        } else {
            age < KEYS_TTL
        };
        fresh.then(|| Arc::clone(&fetched.keys))
    }

    async fn fetch(&self, rules: &Rules) -> Result<KeySet, KeyError> {
        match &self.source {
            Source::Url { url, bearer } => {
                let body = self.get(url, bearer.as_deref()).await?;
                rules.parse_jwks(&body)
            }
            Source::Discovery {
                discovery_url,
                issuer,
                jwks_uri,
            } => {
                let cached = jwks_uri
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone();
                let url = if let Some(url) = cached {
                    url
                } else {
                    let url = self.discover(discovery_url, issuer).await?;
                    *jwks_uri
                        .write()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(url.clone());
                    url
                };
                let keys = self
                    .get(&url, None)
                    .await
                    .and_then(|body| rules.parse_jwks(&body));
                if keys.is_err() {
                    // The provider may have moved its keys: discover again
                    // next time.
                    *jwks_uri
                        .write()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
                }
                keys
            }
        }
    }

    /// The discovery document's `jwks_uri`, after checking it describes the
    /// configured issuer (`OpenID` Connect Discovery 1.0, section 4.3).
    async fn discover(&self, discovery_url: &str, issuer: &str) -> Result<String, KeyError> {
        let body = self.get(discovery_url, None).await?;
        let document: Value = serde_json::from_str(&body)
            .map_err(|error| KeyError::new(format!("discovery document: {error}")))?;
        let announced = document.get("issuer").and_then(Value::as_str);
        if announced != Some(issuer) {
            return Err(KeyError::new(format!(
                "the discovery document names issuer {}, not the configured {issuer}",
                announced.unwrap_or("(none)")
            )));
        }
        document
            .get("jwks_uri")
            .and_then(Value::as_str)
            .filter(|uri| !uri.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| KeyError::new("the discovery document has no jwks_uri".to_owned()))
    }

    async fn get(&self, url: &str, bearer: Option<&str>) -> Result<String, KeyError> {
        let mut request = self.client.get(url);
        if let Some(bearer) = bearer {
            request = request.bearer_auth(bearer);
        }
        let response = request
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| KeyError::new(error.without_url().to_string()))?;
        response
            .text()
            .await
            .map_err(|error| KeyError::new(error.to_string()))
    }
}
