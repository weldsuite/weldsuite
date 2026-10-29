use std::collections::HashSet;
use std::fmt;

use jsonwebtoken::jwk::{Jwk, JwkSet, PublicKeyUse};
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde_json::{Map, Value};
use weldsuite_kit::{ApiError, is_authorized_party, parse_extra_authorized_parties};

/// Clerk's default allowance for clock drift between Clerk and us.
const CLOCK_SKEW_SECONDS: f64 = 5.0;

/// Who is calling: what `clerkMiddleware` puts on the Hono context. The OIDC
/// verifier fills the same fields from the provider's claims (`oidc.rs`).
#[derive(Debug, Clone, PartialEq)]
pub struct AuthContext {
    /// `sub`: the user id (Clerk's, or the OIDC provider's).
    pub user_id: String,
    /// The active organization: `o.id` (v2 session tokens) or `org_id` for
    /// Clerk; the configured organization claim for OIDC.
    pub org_id: Option<String>,
    /// `sid`, or an empty string when the token has none.
    pub session_id: String,
    /// Clerk's `fva` claim: minutes since the first and the second factor
    /// were verified in this session, -1 for never. `None` when the claim is
    /// missing or malformed. OIDC derives it from `auth_time` and `amr`.
    pub factor_verification_age: Option<[f64; 2]>,
}

/// Why a token was refused. Never contains the token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenError {
    Malformed,
    UnsupportedAlgorithm,
    UnsupportedType,
    UnknownKey,
    BadSignature,
    MissingExpiry,
    Expired,
    NotYetValid,
    IssuedInFuture,
    MissingSubject,
    EmptySubject,
    UnauthorizedParty,
    /// OIDC: `iss` is not the configured issuer.
    WrongIssuer,
    /// OIDC: no `aud` value is a configured audience.
    WrongAudience,
}

impl fmt::Display for TokenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            Self::Malformed => "malformed token",
            Self::UnsupportedAlgorithm => "unsupported signing algorithm",
            Self::UnsupportedType => "unsupported token type",
            Self::UnknownKey => "no key matches the token",
            Self::BadSignature => "invalid signature",
            Self::MissingExpiry => "no expiry claim",
            Self::Expired => "token expired",
            Self::NotYetValid => "token not valid yet",
            Self::IssuedInFuture => "token issued in the future",
            Self::MissingSubject => "no subject claim",
            Self::EmptySubject => "empty subject claim",
            Self::UnauthorizedParty => "azp is not an authorized party",
            Self::WrongIssuer => "iss is not the configured issuer",
            Self::WrongAudience => "aud names none of the configured audiences",
        };
        f.write_str(text)
    }
}

impl std::error::Error for TokenError {}

/// The verification key could not be loaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyError(String);

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid verification key: {}", self.0)
    }
}

impl std::error::Error for KeyError {}

impl KeyError {
    pub(crate) fn new(reason: String) -> Self {
        Self(reason)
    }
}

/// The 401 `clerkMiddleware` answers a refused token with. `provider` only
/// names the log line.
pub(crate) fn refusal(error: TokenError, provider: &str) -> ApiError {
    if error == TokenError::EmptySubject {
        ApiError::unauthorized().with_message("Invalid token payload")
    } else {
        if error != TokenError::UnauthorizedParty {
            tracing::warn!(%error, "{provider} auth: token refused");
        }
        ApiError::unauthorized().with_message("Token verification failed")
    }
}

/// Verification keys: one PEM key, or a JWKS document whose `kid` picks the
/// key. Shared by the Clerk and OIDC rules, fixed or fetched (`keys.rs`).
pub(crate) enum KeySet {
    /// `CLERK_JWT_KEY`: one PEM public key, used whatever the token's `kid`.
    Single(DecodingKey),
    /// A JWKS document: key id, the key's declared `alg`, the key.
    Set(Vec<(Option<String>, Option<String>, DecodingKey)>),
}

impl KeySet {
    pub(crate) fn from_rsa_pem(pem: &str) -> Result<Self, KeyError> {
        DecodingKey::from_rsa_pem(pem.as_bytes())
            .map(Self::Single)
            .map_err(|e| KeyError(e.to_string()))
    }

    /// Every key of the document must load (Clerk's `/v1/jwks`).
    pub(crate) fn from_jwks_strict(jwks: &str) -> Result<Self, KeyError> {
        let set: JwkSet = serde_json::from_str(jwks).map_err(|e| KeyError(e.to_string()))?;
        let keys = set
            .keys
            .iter()
            .map(|jwk| {
                DecodingKey::from_jwk(jwk)
                    .map(|key| (jwk.common.key_id.clone(), declared_alg(jwk), key))
                    .map_err(|e| KeyError(e.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Self::non_empty(keys)
    }

    /// The signing keys of an OIDC provider's JWKS. Encryption keys and keys
    /// this crate can't use (another `kty`, a symmetric key) are skipped, as
    /// a provider may publish them next to its signing keys; at least one
    /// must remain.
    pub(crate) fn from_jwks_signing(jwks: &str) -> Result<Self, KeyError> {
        let document: Value = serde_json::from_str(jwks).map_err(|e| KeyError(e.to_string()))?;
        let Some(entries) = document.get("keys").and_then(Value::as_array) else {
            return Err(KeyError("the JWKS has no keys array".to_owned()));
        };
        let keys = entries
            .iter()
            .filter_map(|entry| {
                // `oct` keys are shared secrets: never a provider's signing key.
                if entry.get("kty").and_then(Value::as_str) == Some("oct") {
                    return None;
                }
                let jwk: Jwk = serde_json::from_value(entry.clone()).ok()?;
                if matches!(
                    jwk.common.public_key_use,
                    Some(PublicKeyUse::Encryption | PublicKeyUse::Other(_))
                ) {
                    return None;
                }
                let key = DecodingKey::from_jwk(&jwk).ok()?;
                Some((jwk.common.key_id.clone(), declared_alg(&jwk), key))
            })
            .collect();
        Self::non_empty(keys)
    }

    fn non_empty(
        keys: Vec<(Option<String>, Option<String>, DecodingKey)>,
    ) -> Result<Self, KeyError> {
        if keys.is_empty() {
            return Err(KeyError("the JWKS has no keys".to_owned()));
        }
        Ok(Self::Set(keys))
    }

    /// The key for `kid` and the `alg` it declares. A set of one key also
    /// serves a token without a `kid`.
    pub(crate) fn key_for(
        &self,
        kid: Option<&str>,
    ) -> Result<(&DecodingKey, Option<&str>), TokenError> {
        match self {
            Self::Single(key) => Ok((key, None)),
            Self::Set(keys) => {
                let matched = match kid {
                    Some(kid) => keys.iter().find(|(id, _, _)| id.as_deref() == Some(kid)),
                    None if keys.len() == 1 => keys.first(),
                    None => None,
                };
                matched
                    .map(|(_, alg, key)| (key, alg.as_deref()))
                    .ok_or(TokenError::UnknownKey)
            }
        }
    }
}

/// The JWK's `alg`, spelled as in a JWT header (`RS256`, `EdDSA`).
fn declared_alg(jwk: &Jwk) -> Option<String> {
    jwk.common.key_algorithm.map(|alg| format!("{alg:?}"))
}

/// Check the signature with `key` and return the claims; no claim is
/// validated here.
pub(crate) fn decode_claims(
    token: &str,
    alg: Algorithm,
    key: &DecodingKey,
) -> Result<Map<String, Value>, TokenError> {
    let mut validation = Validation::new(alg);
    validation.validate_exp = false;
    validation.validate_nbf = false;
    validation.validate_aud = false;
    validation.required_spec_claims = HashSet::new();
    jsonwebtoken::decode::<Map<String, Value>>(token, key, &validation)
        .map(|data| data.claims)
        .map_err(|e| match e.kind() {
            jsonwebtoken::errors::ErrorKind::InvalidSignature => TokenError::BadSignature,
            _ => TokenError::Malformed,
        })
}

/// Verifies Clerk session tokens without a network call.
pub struct ClerkVerifier {
    pub(crate) keys: std::sync::Arc<KeySet>,
    pub(crate) rules: ClerkRules,
}

/// What Clerk's tokens are checked against besides the key.
#[derive(Debug, Clone)]
pub(crate) struct ClerkRules {
    pub(crate) extra_authorized_parties: Vec<String>,
}

impl ClerkRules {
    pub(crate) fn new(authorized_parties: Option<&str>) -> Self {
        Self {
            extra_authorized_parties: parse_extra_authorized_parties(authorized_parties),
        }
    }
}

impl fmt::Debug for ClerkVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClerkVerifier")
            .field(
                "extra_authorized_parties",
                &self.rules.extra_authorized_parties,
            )
            .finish_non_exhaustive()
    }
}

impl ClerkVerifier {
    /// From `CLERK_JWT_KEY` (a PEM public key) and the optional
    /// `CLERK_AUTHORIZED_PARTIES` list.
    pub fn from_pem(pem: &str, authorized_parties: Option<&str>) -> Result<Self, KeyError> {
        Ok(Self {
            keys: std::sync::Arc::new(KeySet::from_rsa_pem(pem)?),
            rules: ClerkRules::new(authorized_parties),
        })
    }

    /// From a JWKS document (Clerk's `/v1/jwks`). Fetching and refreshing it
    /// is the caller's job.
    pub fn from_jwks(jwks: &str, authorized_parties: Option<&str>) -> Result<Self, KeyError> {
        Ok(Self {
            keys: std::sync::Arc::new(KeySet::from_jwks_strict(jwks)?),
            rules: ClerkRules::new(authorized_parties),
        })
    }

    /// Verify a token at `now` (Unix seconds).
    pub fn verify(&self, token: &str, now: u64) -> Result<AuthContext, TokenError> {
        self.rules.verify(&self.keys, token, now)
    }

    /// Check an `Authorization` header value, with the same 401 responses
    /// as `clerkMiddleware`.
    pub fn authenticate(
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
            .map_err(|error| refusal(error, "Clerk"))
    }
}

impl ClerkRules {
    /// Verify a Clerk session token with `keys` at `now` (Unix seconds).
    pub(crate) fn verify(
        &self,
        keys: &KeySet,
        token: &str,
        now: u64,
    ) -> Result<AuthContext, TokenError> {
        let header = jsonwebtoken::decode_header(token).map_err(|_| TokenError::Malformed)?;
        if !matches!(
            header.alg,
            Algorithm::RS256 | Algorithm::RS384 | Algorithm::RS512
        ) {
            return Err(TokenError::UnsupportedAlgorithm);
        }
        if header.typ.as_deref().is_some_and(|typ| typ != "JWT") {
            return Err(TokenError::UnsupportedType);
        }
        let (key, _) = keys.key_for(header.kid.as_deref())?;
        let claims = decode_claims(token, header.alg, key)?;

        check_times(&claims, now, CLOCK_SKEW_SECONDS)?;

        let user_id = subject(&claims)?;

        if !is_authorized_party(claims.get("azp"), &self.extra_authorized_parties) {
            // The origin only, never the token; truncated, as the claim is
            // client-influenced.
            let azp = claims.get("azp").map(Value::to_string).unwrap_or_default();
            tracing::warn!(
                azp = %azp.chars().take(200).collect::<String>(),
                "Clerk auth: token refused, azp is not an authorized party"
            );
            return Err(TokenError::UnauthorizedParty);
        }

        let org_id = non_empty_str(claims.get("o").and_then(|o| o.get("id")))
            .or_else(|| non_empty_str(claims.get("org_id")));
        let session_id = non_empty_str(claims.get("sid")).unwrap_or_default();

        Ok(AuthContext {
            user_id,
            org_id,
            session_id,
            factor_verification_age: parse_factor_verification_age(claims.get("fva")),
        })
    }
}

/// `sub`: required and not empty.
pub(crate) fn subject(claims: &Map<String, Value>) -> Result<String, TokenError> {
    match claims.get("sub") {
        Some(Value::String(sub)) if sub.is_empty() => Err(TokenError::EmptySubject),
        Some(Value::String(sub)) => Ok(sub.clone()),
        _ => Err(TokenError::MissingSubject),
    }
}

/// `exp` is required; `nbf` and `iat` are checked when they are numbers.
/// All three allow `skew` seconds, the way Clerk's `verifyJwt` does.
pub(crate) fn check_times(
    claims: &Map<String, Value>,
    now: u64,
    skew: f64,
) -> Result<(), TokenError> {
    // Unix seconds fit an f64 exactly until the year 285 million.
    #[allow(clippy::cast_precision_loss)]
    let now = now as f64;
    let number = |name: &str| claims.get(name).and_then(Value::as_f64);

    let exp = number("exp").ok_or(TokenError::MissingExpiry)?;
    if exp <= now - skew {
        return Err(TokenError::Expired);
    }
    if number("nbf").is_some_and(|nbf| nbf > now + skew) {
        return Err(TokenError::NotYetValid);
    }
    if number("iat").is_some_and(|iat| iat > now + skew) {
        return Err(TokenError::IssuedInFuture);
    }
    Ok(())
}

pub(crate) fn non_empty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `parseFactorVerificationAge`: two finite numbers, each -1 or more.
fn parse_factor_verification_age(fva: Option<&Value>) -> Option<[f64; 2]> {
    let [first, second] = fva?.as_array()?.as_slice() else {
        return None;
    };
    let age = |value: &Value| value.as_f64().filter(|age| age.is_finite() && *age >= -1.0);
    Some([age(first)?, age(second)?])
}
