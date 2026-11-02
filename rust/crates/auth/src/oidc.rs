//! OIDC access and ID tokens from the Kubernetes editions' identity provider:
//! Zitadel in EU and bundled self-host, the customer's own provider otherwise
//! (ADR SEC-012). The token is checked the way the Clerk verifier checks a
//! session token, against the provider's rules:
//!
//! - signed with an asymmetric algorithm (`RS*`, `PS*`, `ES256`, `ES384`,
//!   `EdDSA`; never `HS*` or `none`) by a key of the provider's JWKS, whose
//!   declared `alg`, when it has one, is the token's;
//! - `typ`, when present, is `JWT` or `at+jwt` (RFC 9068);
//! - `iss` is the configured issuer exactly, and `aud` (a string or an
//!   array) names one of the configured audiences;
//! - `exp` is required and not past, `nbf` and `iat` not in the future, each
//!   with [`OIDC_CLOCK_SKEW_SECONDS`];
//! - `sub` names the user.
//!
//! The claims become an [`AuthContext`]:
//!
//! | `AuthContext` | Claim |
//! |---|---|
//! | `user_id` | `sub` |
//! | `org_id` | the organization claim ([`OidcSettings::org_claim`], see [`organization`]) |
//! | `session_id` | `sid`, else empty |
//! | `factor_verification_age` | from `auth_time` and `amr`, see [`factor_verification_age`] |

use std::collections::BTreeSet;

use jsonwebtoken::Algorithm;
use serde_json::{Map, Value};

use crate::verifier::{
    AuthContext, KeySet, TokenError, check_times, decode_claims, non_empty_str, subject,
};

/// Zitadel's claim for the organization a token was issued for, when the
/// client asks for it with the `urn:zitadel:iam:org:id:{id}` scope.
pub const ZITADEL_ORG_CLAIM: &str = "urn:zitadel:iam:org:id";

/// Allowed clock drift between the provider and us. Wider than Clerk's 5
/// seconds: a customer's own provider may run on another clock.
pub const OIDC_CLOCK_SKEW_SECONDS: f64 = 30.0;

/// How an OIDC provider's tokens are checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcSettings {
    /// `OIDC_ISSUER`: compared with `iss` exactly, and where discovery reads
    /// `/.well-known/openid-configuration`.
    pub issuer: String,
    /// `OIDC_AUDIENCE`: a token's `aud` must name one of these (Zitadel: the
    /// project id, added with the `urn:zitadel:iam:org:project:id:{id}:aud`
    /// scope, or a client id).
    pub audiences: Vec<String>,
    /// `OIDC_ORG_CLAIM`: the claim naming the session's organization.
    pub org_claim: String,
    /// `OIDC_JWKS_URL`: fetch the keys here instead of the discovery
    /// document's `jwks_uri`.
    pub jwks_url: Option<String>,
}

impl OidcSettings {
    /// Zitadel's defaults for `issuer` and `audiences`.
    pub fn new(issuer: impl Into<String>, audiences: Vec<String>) -> Self {
        Self {
            issuer: issuer.into(),
            audiences,
            org_claim: ZITADEL_ORG_CLAIM.to_owned(),
            jwks_url: None,
        }
    }

    /// The discovery document's URL: `{issuer}/.well-known/openid-configuration`.
    pub fn discovery_url(&self) -> String {
        format!(
            "{}/.well-known/openid-configuration",
            self.issuer.trim_end_matches('/')
        )
    }
}

/// The checks of the module docs, with the settings.
#[derive(Debug, Clone)]
pub(crate) struct OidcRules {
    pub(crate) settings: OidcSettings,
}

impl OidcRules {
    pub(crate) fn verify(
        &self,
        keys: &KeySet,
        token: &str,
        now: u64,
    ) -> Result<AuthContext, TokenError> {
        let header = jsonwebtoken::decode_header(token).map_err(|_| TokenError::Malformed)?;
        if !matches!(
            header.alg,
            Algorithm::RS256
                | Algorithm::RS384
                | Algorithm::RS512
                | Algorithm::PS256
                | Algorithm::PS384
                | Algorithm::PS512
                | Algorithm::ES256
                | Algorithm::ES384
                | Algorithm::EdDSA
        ) {
            return Err(TokenError::UnsupportedAlgorithm);
        }
        if header.typ.as_deref().is_some_and(|typ| {
            !["jwt", "at+jwt", "application/at+jwt"].contains(&typ.to_ascii_lowercase().as_str())
        }) {
            return Err(TokenError::UnsupportedType);
        }
        let (key, declared) = keys.key_for(header.kid.as_deref())?;
        if declared.is_some_and(|alg| alg != format!("{:?}", header.alg)) {
            return Err(TokenError::UnsupportedAlgorithm);
        }
        let claims = decode_claims(token, header.alg, key)?;

        check_times(&claims, now, OIDC_CLOCK_SKEW_SECONDS)?;
        if claims.get("iss").and_then(Value::as_str) != Some(self.settings.issuer.as_str()) {
            return Err(TokenError::WrongIssuer);
        }
        if !audience_matches(claims.get("aud"), &self.settings.audiences) {
            return Err(TokenError::WrongAudience);
        }
        let user_id = subject(&claims)?;

        Ok(AuthContext {
            user_id,
            org_id: organization(claims.get(&self.settings.org_claim)),
            session_id: non_empty_str(claims.get("sid")).unwrap_or_default(),
            factor_verification_age: factor_verification_age(&claims, now),
        })
    }
}

/// `aud` is one string or an array of strings; one must be configured.
fn audience_matches(aud: Option<&Value>, audiences: &[String]) -> bool {
    let named = |value: &Value| {
        value
            .as_str()
            .is_some_and(|aud| audiences.iter().any(|allowed| allowed == aud))
    };
    match aud {
        Some(Value::Array(values)) => values.iter().any(named),
        Some(value) => named(value),
        None => false,
    }
}

/// The organization from the configured claim's value:
///
/// - a string: the organization id (Zitadel's `urn:zitadel:iam:org:id`,
///   `urn:zitadel:iam:user:resourceowner:id`, or a claim an Action adds);
/// - an array: its one distinct string;
/// - an object shaped like Zitadel's project roles claim
///   (`urn:zitadel:iam:org:project:roles`, `{ role: { orgId: domain } }`):
///   the one organization it grants roles in, which the client narrows to
///   the active workspace with the `urn:zitadel:iam:org:roles:id:{id}` scope.
///
/// Anything else, and more than one organization, is none: the request then
/// meets `ORG_REQUIRED`, never a guessed workspace.
pub fn organization(value: Option<&Value>) -> Option<String> {
    let single = |ids: BTreeSet<&str>| {
        let mut ids = ids.into_iter().filter(|id| !id.is_empty());
        match (ids.next(), ids.next()) {
            (Some(id), None) => Some(id.to_owned()),
            _ => None,
        }
    };
    match value? {
        Value::String(id) => Some(id.clone()).filter(|id| !id.is_empty()),
        Value::Array(items) => single(items.iter().filter_map(Value::as_str).collect()),
        Value::Object(roles) => single(
            roles
                .values()
                .filter_map(Value::as_object)
                .flat_map(Map::keys)
                .map(String::as_str)
                .collect(),
        ),
        _ => None,
    }
}

/// Clerk's `fva` from OIDC claims: minutes since `auth_time` for the first
/// factor, the same for the second when `amr` has `mfa`, else -1 (none in
/// this session). Without `auth_time` there is nothing to go on (`None`,
/// which step-up answers with `REVERIFICATION_REQUIRED`).
///
/// Zitadel puts `mfa` in `amr` when two factors were checked, and for a
/// passkey (`["user", "mfa"]`), which Clerk's `fva` would not count. An OIDC
/// client gets a fresh `auth_time` by signing in again (`prompt=login` or
/// `max_age`).
pub fn factor_verification_age(claims: &Map<String, Value>, now: u64) -> Option<[f64; 2]> {
    let auth_time = claims.get("auth_time")?.as_f64()?;
    // Unix seconds fit an f64 exactly until the year 285 million.
    #[allow(clippy::cast_precision_loss)]
    let minutes = ((now as f64 - auth_time) / 60.0).max(0.0).floor();
    let mfa = claims
        .get("amr")
        .and_then(Value::as_array)
        .is_some_and(|amr| amr.iter().any(|method| method.as_str() == Some("mfa")));
    Some([minutes, if mfa { minutes } else { -1.0 }])
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn organization_from_strings_arrays_and_role_maps() {
        assert_eq!(organization(Some(&json!("291"))), Some("291".to_owned()));
        assert_eq!(organization(Some(&json!(""))), None);
        assert_eq!(
            organization(Some(&json!(["291", "291"]))),
            Some("291".to_owned())
        );
        assert_eq!(organization(Some(&json!(["291", "292"]))), None);
        let roles = json!({
            "admin": { "291": "acme.auth.example" },
            "member": { "291": "acme.auth.example" }
        });
        assert_eq!(organization(Some(&roles)), Some("291".to_owned()));
        let two = json!({ "member": { "291": "a", "292": "b" } });
        assert_eq!(organization(Some(&two)), None);
        assert_eq!(organization(Some(&json!(291))), None);
        assert_eq!(organization(None), None);
    }

    #[test]
    fn second_factor_age_from_auth_time_and_amr() {
        let claims = |value: Value| value.as_object().cloned().expect("object");
        let now = 10_000;
        assert_eq!(
            factor_verification_age(
                &claims(json!({"auth_time": 9_400, "amr": ["pwd", "otp", "mfa"]})),
                now
            ),
            Some([10.0, 10.0])
        );
        assert_eq!(
            factor_verification_age(&claims(json!({"auth_time": 9_400, "amr": ["pwd"]})), now),
            Some([10.0, -1.0])
        );
        assert_eq!(
            factor_verification_age(&claims(json!({"auth_time": 9_970})), now),
            Some([0.0, -1.0])
        );
        assert_eq!(
            factor_verification_age(&claims(json!({"amr": ["mfa"]})), now),
            None
        );
    }

    #[test]
    fn audiences_are_a_string_or_an_array() {
        let allowed = vec!["project".to_owned()];
        assert!(audience_matches(Some(&json!("project")), &allowed));
        assert!(audience_matches(
            Some(&json!(["client", "project"])),
            &allowed
        ));
        assert!(!audience_matches(Some(&json!(["client"])), &allowed));
        assert!(!audience_matches(None, &allowed));
    }
}
