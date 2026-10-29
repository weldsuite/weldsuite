//! Where the session token keys come from, as `verifyToken` in
//! `@clerk/backend` gets them:
//!
//! - a fixed key: `CLERK_JWT_KEY` (PEM) or a mounted JWKS document;
//! - fetched keys: the instance's JWKS from Clerk's Backend API with
//!   `CLERK_SECRET_KEY`, or from any JWKS URL. Fetched on first use, reused
//!   for an hour, and fetched again (at most every 30 seconds) when a token
//!   names a key id the cached set doesn't have, which is how a key rotation
//!   reaches us.

use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use weldsuite_kit::ApiError;

use crate::verifier::{AuthContext, ClerkVerifier, KeyError, TokenError};

/// Clerk's Backend API JWKS endpoint.
pub const CLERK_JWKS_URL: &str = "https://api.clerk.com/v1/jwks";

/// How long a fetched key set is reused.
const KEYS_TTL: Duration = Duration::from_secs(3600);

/// The least time between two fetches triggered by unknown key ids.
const REFETCH_INTERVAL: Duration = Duration::from_secs(30);

/// Fetched keys and when they were fetched.
struct Fetched {
    verifier: Arc<ClerkVerifier>,
    at: Instant,
}

struct Remote {
    url: String,
    bearer: Option<String>,
    authorized_parties: Option<String>,
    client: reqwest::Client,
    current: RwLock<Option<Fetched>>,
    /// Serialises fetches, so a burst of requests fetches once.
    fetching: Mutex<()>,
}

/// Verifies session tokens with a fixed key or keys fetched from a JWKS URL.
pub struct SessionVerifier {
    keys: Keys,
}

enum Keys {
    Fixed(Arc<ClerkVerifier>),
    Remote(Box<Remote>),
}

impl std::fmt::Debug for SessionVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = match &self.keys {
            Keys::Fixed(_) => "fixed",
            Keys::Remote(remote) => remote.url.as_str(),
        };
        f.debug_struct("SessionVerifier")
            .field("keys", &kind)
            .finish()
    }
}

impl From<ClerkVerifier> for SessionVerifier {
    fn from(verifier: ClerkVerifier) -> Self {
        Self {
            keys: Keys::Fixed(Arc::new(verifier)),
        }
    }
}

impl SessionVerifier {
    /// Keys fetched from `url`, with `Authorization: Bearer <bearer>` when
    /// given (Clerk's Backend API wants the secret key).
    pub fn remote(
        url: impl Into<String>,
        bearer: Option<String>,
        authorized_parties: Option<String>,
    ) -> Result<Self, KeyError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| KeyError::new(error.to_string()))?;
        Ok(Self {
            keys: Keys::Remote(Box::new(Remote {
                url: url.into(),
                bearer,
                authorized_parties,
                client,
                current: RwLock::new(None),
                fetching: Mutex::new(()),
            })),
        })
    }

    /// Keys from Clerk's Backend API, authenticated with `CLERK_SECRET_KEY`.
    pub fn clerk_backend_api(
        secret_key: String,
        authorized_parties: Option<String>,
    ) -> Result<Self, KeyError> {
        Self::remote(CLERK_JWKS_URL, Some(secret_key), authorized_parties)
    }

    /// Verify a token at `now` (Unix seconds).
    pub async fn verify(&self, token: &str, now: u64) -> Result<AuthContext, TokenError> {
        let remote = match &self.keys {
            Keys::Fixed(verifier) => return verifier.verify(token, now),
            Keys::Remote(remote) => remote,
        };
        let verifier = remote.verifier(false).await?;
        match verifier.verify(token, now) {
            // A key we don't have yet: the instance may have rotated keys.
            Err(TokenError::UnknownKey) => remote.verifier(true).await?.verify(token, now),
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
            .map_err(crate::verifier::refusal)
    }
}

impl Remote {
    /// The current key set; fetched when there is none, when it is older than
    /// [`KEYS_TTL`], or when `refresh` asks and the last fetch is older than
    /// [`REFETCH_INTERVAL`].
    async fn verifier(&self, refresh: bool) -> Result<Arc<ClerkVerifier>, TokenError> {
        if let Some(verifier) = self.usable(refresh) {
            return Ok(verifier);
        }
        let _guard = self.fetching.lock().await;
        // Another request may have fetched while this one waited.
        if let Some(verifier) = self.usable(refresh) {
            return Ok(verifier);
        }
        match self.fetch().await {
            Ok(verifier) => {
                let verifier = Arc::new(verifier);
                *self
                    .current
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Fetched {
                    verifier: Arc::clone(&verifier),
                    at: Instant::now(),
                });
                Ok(verifier)
            }
            Err(error) => {
                tracing::error!(%error, url = %self.url, "session keys: fetching the JWKS failed");
                // Keep serving with the keys we have, if any.
                self.current
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .as_ref()
                    .map(|fetched| Arc::clone(&fetched.verifier))
                    .ok_or(TokenError::UnknownKey)
            }
        }
    }

    fn usable(&self, refresh: bool) -> Option<Arc<ClerkVerifier>> {
        let current = self
            .current
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let fetched = current.as_ref()?;
        let age = fetched.at.elapsed();
        let fresh = if refresh {
            age < REFETCH_INTERVAL
        } else {
            age < KEYS_TTL
        };
        fresh.then(|| Arc::clone(&fetched.verifier))
    }

    async fn fetch(&self) -> Result<ClerkVerifier, KeyError> {
        let mut request = self.client.get(&self.url);
        if let Some(bearer) = &self.bearer {
            request = request.bearer_auth(bearer);
        }
        let response = request
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| KeyError::new(error.without_url().to_string()))?;
        let body = response
            .text()
            .await
            .map_err(|error| KeyError::new(error.to_string()))?;
        ClerkVerifier::from_jwks(&body, self.authorized_parties.as_deref())
    }
}
