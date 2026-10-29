use std::collections::HashSet;
use std::fmt;

use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde_json::{Map, Value};
use weldsuite_kit::{ApiError, is_authorized_party, parse_extra_authorized_parties};

/// Clerk's default allowance for clock drift between Clerk and us.
const CLOCK_SKEW_SECONDS: f64 = 5.0;

/// Who is calling: what `clerkMiddleware` puts on the Hono context.
#[derive(Debug, Clone, PartialEq)]
pub struct AuthContext {
    /// `sub`: the Clerk user id.
    pub user_id: String,
    /// The active organization: `o.id` (v2 session tokens) or `org_id`.
    pub org_id: Option<String>,
    /// `sid`, or an empty string when the token has none.
    pub session_id: String,
    /// Clerk's `fva` claim: minutes since the first and the second factor
    /// were verified in this session, -1 for never. `None` when the claim is
    /// missing or malformed.
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

/// The 401 `clerkMiddleware` answers a refused token with.
pub(crate) fn refusal(error: TokenError) -> ApiError {
    if error == TokenError::EmptySubject {
        ApiError::unauthorized().with_message("Invalid token payload")
    } else {
        if error != TokenError::UnauthorizedParty {
            tracing::warn!(%error, "Clerk auth: token refused");
        }
        ApiError::unauthorized().with_message("Token verification failed")
    }
}

enum Keys {
    /// `CLERK_JWT_KEY`: one PEM public key, used whatever the token's `kid`.
    Single(DecodingKey),
    /// A JWKS document; the token's `kid` picks the key.
    Set(Vec<(Option<String>, DecodingKey)>),
}

/// Verifies Clerk session tokens without a network call.
pub struct ClerkVerifier {
    keys: Keys,
    extra_authorized_parties: Vec<String>,
}

impl fmt::Debug for ClerkVerifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClerkVerifier")
            .field("extra_authorized_parties", &self.extra_authorized_parties)
            .finish_non_exhaustive()
    }
}

impl ClerkVerifier {
    /// From `CLERK_JWT_KEY` (a PEM public key) and the optional
    /// `CLERK_AUTHORIZED_PARTIES` list.
    pub fn from_pem(pem: &str, authorized_parties: Option<&str>) -> Result<Self, KeyError> {
        let key = DecodingKey::from_rsa_pem(pem.as_bytes()).map_err(|e| KeyError(e.to_string()))?;
        Ok(Self {
            keys: Keys::Single(key),
            extra_authorized_parties: parse_extra_authorized_parties(authorized_parties),
        })
    }

    /// From a JWKS document (Clerk's `/v1/jwks`). Fetching and refreshing it
    /// is the caller's job.
    pub fn from_jwks(jwks: &str, authorized_parties: Option<&str>) -> Result<Self, KeyError> {
        let set: JwkSet = serde_json::from_str(jwks).map_err(|e| KeyError(e.to_string()))?;
        let keys = set
            .keys
            .iter()
            .map(|jwk| {
                DecodingKey::from_jwk(jwk)
                    .map(|key| (jwk.common.key_id.clone(), key))
                    .map_err(|e| KeyError(e.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if keys.is_empty() {
            return Err(KeyError("the JWKS has no keys".to_owned()));
        }
        Ok(Self {
            keys: Keys::Set(keys),
            extra_authorized_parties: parse_extra_authorized_parties(authorized_parties),
        })
    }

    /// Verify a token at `now` (Unix seconds).
    pub fn verify(&self, token: &str, now: u64) -> Result<AuthContext, TokenError> {
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
        let key = self.key_for(header.kid.as_deref())?;

        let mut validation = Validation::new(header.alg);
        validation.validate_exp = false;
        validation.validate_nbf = false;
        validation.validate_aud = false;
        validation.required_spec_claims = HashSet::new();
        let claims = jsonwebtoken::decode::<Map<String, Value>>(token, key, &validation)
            .map_err(|e| match e.kind() {
                jsonwebtoken::errors::ErrorKind::InvalidSignature => TokenError::BadSignature,
                _ => TokenError::Malformed,
            })?
            .claims;

        check_times(&claims, now)?;

        let user_id = match claims.get("sub") {
            Some(Value::String(sub)) if sub.is_empty() => return Err(TokenError::EmptySubject),
            Some(Value::String(sub)) => sub.clone(),
            _ => return Err(TokenError::MissingSubject),
        };

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
        self.verify(token, now).map_err(refusal)
    }

    fn key_for(&self, kid: Option<&str>) -> Result<&DecodingKey, TokenError> {
        match &self.keys {
            Keys::Single(key) => Ok(key),
            Keys::Set(keys) => {
                let matched = match kid {
                    Some(kid) => keys.iter().find(|(id, _)| id.as_deref() == Some(kid)),
                    None if keys.len() == 1 => keys.first(),
                    None => None,
                };
                matched.map(|(_, key)| key).ok_or(TokenError::UnknownKey)
            }
        }
    }
}

/// `exp` is required; `nbf` and `iat` are checked when they are numbers.
/// All three allow `CLOCK_SKEW_SECONDS`, the way Clerk's `verifyJwt` does.
fn check_times(claims: &Map<String, Value>, now: u64) -> Result<(), TokenError> {
    // Unix seconds fit an f64 exactly until the year 285 million.
    #[allow(clippy::cast_precision_loss)]
    let now = now as f64;
    let number = |name: &str| claims.get(name).and_then(Value::as_f64);

    let exp = number("exp").ok_or(TokenError::MissingExpiry)?;
    if exp <= now - CLOCK_SKEW_SECONDS {
        return Err(TokenError::Expired);
    }
    if number("nbf").is_some_and(|nbf| nbf > now + CLOCK_SKEW_SECONDS) {
        return Err(TokenError::NotYetValid);
    }
    if number("iat").is_some_and(|iat| iat > now + CLOCK_SKEW_SECONDS) {
        return Err(TokenError::IssuedInFuture);
    }
    Ok(())
}

fn non_empty_str(value: Option<&Value>) -> Option<String> {
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
