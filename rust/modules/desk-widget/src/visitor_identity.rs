//! `lib/visitor-identity.ts`: who a widget visitor is (ADR DESK-010).
//!
//! Visitor token: issued by `POST /api/visitor`, never made up by the
//! browser. An HS256 JWT under a key derived from `WIDGET_TOKEN_SECRET`,
//! naming the visitor row and bound to one workspace (`workspaces.id`) and
//! widget. The widget sends it as `Authorization: Bearer`; every
//! conversation route takes the visitor from it.
//!
//! Identity token: signed by the customer's own server with the widget's
//! identity secret. Its `sub` (their user id) picks the visitor row and its
//! `email` becomes that visitor's verified email, so the email is covered by
//! the signature too.
//!
//! An identified visitor's token lives no longer than the identity token it
//! came from, and carries a fingerprint of the widget's identity secret:
//! rotating or removing the secret ends every identified session at once.

use serde_json::{Value, json};

use crate::tokens::{JwtFailure, derive_secret, sign_jwt, verify_jwt};

/// A year for an anonymous visitor; every widget load refreshes it.
pub(crate) const VISITOR_TOKEN_TTL_SECONDS: i64 = 365 * 24 * 60 * 60;
const VISITOR_TOKEN_AUDIENCE: &str = "desk-visitor";
const VISITOR_KEY_LABEL: &str = "weldsuite:desk-visitor-token:v1";
const FINGERPRINT_LABEL: &str = "weldsuite:desk-identity-fingerprint:v1";
/// Longest a customer may let one identity token live.
const IDENTITY_TOKEN_MAX_TTL_SECONDS: i64 = 30 * 24 * 60 * 60;

/// `VisitorTokenClaims`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VisitorClaims {
    pub(crate) visitor_id: String,
    /// `workspaces.id`.
    pub(crate) workspace_id: String,
    pub(crate) widget_id: String,
    /// Identified visitors: fingerprint of the identity secret the token was
    /// issued under.
    pub(crate) secret_fingerprint: Option<String>,
}

fn visitor_key(secret: &str) -> String {
    derive_secret(secret, VISITOR_KEY_LABEL)
}

/// `identitySecretFingerprint(identitySecret)`: a short, non-reversible tag
/// of an identity secret, to tell whether it changed.
pub(crate) fn identity_secret_fingerprint(identity_secret: &str) -> String {
    derive_secret(identity_secret, FINGERPRINT_LABEL)
        .chars()
        .take(16)
        .collect()
}

/// A number as `JSON.stringify` writes it: whole numbers without a fraction.
fn js_number_json(number: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 9.0e15 {
        json!(number as i64)
    } else {
        json!(number)
    }
}

/// `issueVisitorToken(secret, claims, now)`. `expires_at` (epoch seconds,
/// the identity token's `exp`) caps it below the anonymous year.
pub(crate) fn issue_visitor_token(
    secret: &str,
    claims: &VisitorClaims,
    expires_at: Option<f64>,
    now: i64,
) -> String {
    #[allow(clippy::cast_precision_loss)] // seconds since 1970 fit an f64 exactly
    let year = (now + VISITOR_TOKEN_TTL_SECONDS) as f64;
    let exp = expires_at.map_or(year, |expires_at| expires_at.min(year));
    let mut fields = vec![
        ("aud", json!(VISITOR_TOKEN_AUDIENCE)),
        ("sub", json!(claims.visitor_id)),
        ("ws", json!(claims.workspace_id)),
        ("wid", json!(claims.widget_id)),
    ];
    if let Some(fingerprint) = claims
        .secret_fingerprint
        .as_deref()
        .filter(|fingerprint| !fingerprint.is_empty())
    {
        fields.push(("sfp", json!(fingerprint)));
    }
    fields.push(("iat", json!(now)));
    fields.push(("exp", js_number_json(exp)));
    sign_jwt(&visitor_key(secret), &fields)
}

/// `readVisitorToken(secret, token)`: the visitor a token names, or `None`
/// when it is not one of ours (or expired).
pub(crate) fn read_visitor_token(secret: &str, token: &str, now: i64) -> Option<VisitorClaims> {
    let claims = verify_jwt(&visitor_key(secret), token, now).ok()?;
    if claims.get("aud").and_then(Value::as_str) != Some(VISITOR_TOKEN_AUDIENCE)
        || !claims.get("exp").is_some_and(Value::is_number)
    {
        return None;
    }
    let text = |key: &str| claims.get(key).and_then(Value::as_str).map(str::to_owned);
    let visitor_id = text("sub").filter(|sub| !sub.is_empty())?;
    Some(VisitorClaims {
        visitor_id,
        workspace_id: text("ws")?,
        widget_id: text("wid")?,
        secret_fingerprint: text("sfp"),
    })
}

/// The widget's identity secret (`desk_widget_settings.identity_secret`),
/// when it has one.
pub(crate) fn identity_secret(config: &Value) -> Option<&str> {
    config["identity_secret"]
        .as_str()
        .filter(|secret| !secret.is_empty())
}

/// `requiresIdentity(config)`: identity verification is on and anonymous
/// visitors are refused (needs a secret to mean anything).
pub(crate) fn requires_identity(config: &Value) -> bool {
    identity_secret(config).is_some() && config["identity_required"] == Value::Bool(true)
}

/// `VerifiedIdentity`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct VerifiedIdentity {
    pub(crate) external_id: String,
    pub(crate) email: Option<String>,
    pub(crate) name: Option<String>,
    /// The identity token's `exp` (epoch seconds).
    pub(crate) expires_at: f64,
}

/// JavaScript's `\s` and what `String.prototype.trim` removes: `WhiteSpace`
/// and `LineTerminator`.
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `text.length`: UTF-16 code units.
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, max)` in UTF-16 code units. A surrogate pair the cut
/// would split is left out whole (JavaScript keeps its first half).
fn js_prefix(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (at, c) in text.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &text[..at];
        }
    }
    text
}

/// `String(number)`.
fn js_number_string(number: f64) -> String {
    if number == 0.0 {
        return "0".to_owned();
    }
    let size = number.abs();
    if (1e-6..1e21).contains(&size) {
        return format!("{number}");
    }
    let text = format!("{number:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

/// `isPlausibleEmail(value)`: one `@`, something on both sides, a dot
/// inside the domain, no whitespace.
fn is_plausible_email(value: &str) -> bool {
    if value.chars().any(is_js_space) {
        return false;
    }
    let mut parts = value.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let dot = domain.rfind('.');
    !local.is_empty() && dot.is_some_and(|dot| dot > 0 && dot + 1 < domain.len())
}

/// `verifyIdentityToken(secret, token, now)`: `sub` and `exp` are required,
/// and `exp` may be at most 30 days out, so a leaked token stops working.
/// The refusal's reason: a [`JwtFailure`]'s, or `claims`.
pub(crate) fn verify_identity_token(
    secret: &str,
    token: &str,
    now: i64,
) -> Result<VerifiedIdentity, &'static str> {
    let claims = verify_jwt(secret, token, now).map_err(JwtFailure::as_str)?;
    let external_id = match claims.get("sub") {
        Some(Value::String(sub)) => js_trim(sub).to_owned(),
        Some(Value::Number(sub)) => {
            js_trim(&js_number_string(sub.as_f64().unwrap_or_default())).to_owned()
        }
        _ => String::new(),
    };
    if external_id.is_empty() || js_length(&external_id) > 255 {
        return Err("claims");
    }
    #[allow(clippy::cast_precision_loss)] // seconds since 1970 fit an f64 exactly
    let latest = (now + IDENTITY_TOKEN_MAX_TTL_SECONDS) as f64;
    let Some(expires_at) = claims
        .get("exp")
        .and_then(Value::as_f64)
        .filter(|exp| *exp <= latest)
    else {
        return Err("claims");
    };
    let email = match claims.get("email") {
        None | Some(Value::Null) => None,
        Some(Value::String(email)) if email.is_empty() => None,
        Some(Value::String(email))
            if js_length(email) <= 255 && is_plausible_email(js_trim(email)) =>
        {
            Some(js_trim(email).to_lowercase())
        }
        Some(_) => return Err("claims"),
    };
    let name = match claims.get("name") {
        Some(Value::String(name)) => {
            Some(js_prefix(js_trim(name), 255).to_owned()).filter(|name| !name.is_empty())
        }
        _ => None,
    };
    Ok(VerifiedIdentity {
        external_id,
        email,
        name,
        expires_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn identity(claims: &Value) -> String {
        let fields: Vec<(&str, Value)> = claims
            .as_object()
            .expect("object")
            .iter()
            .map(|(key, value)| (key.as_str(), value.clone()))
            .collect();
        sign_jwt("site", &fields)
    }

    #[test]
    fn visitor_tokens_round_trip_and_cap_their_expiry() {
        let claims = VisitorClaims {
            visitor_id: "dvis_1".to_owned(),
            workspace_id: "ws_1".to_owned(),
            widget_id: "wdg_1".to_owned(),
            secret_fingerprint: None,
        };
        let token = issue_visitor_token("worker", &claims, None, NOW);
        assert_eq!(
            read_visitor_token("worker", &token, NOW),
            Some(claims.clone())
        );
        assert_eq!(read_visitor_token("other", &token, NOW), None);
        // Not readable as a plain worker-secret token, and not the other way round.
        assert!(verify_jwt("worker", &token, NOW).is_err());
        let payload = token.split('.').nth(1).expect("payload");
        let body: Value = serde_json::from_slice(
            &base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, payload)
                .expect("base64"),
        )
        .expect("json");
        assert_eq!(body["exp"], json!(NOW + VISITOR_TOKEN_TTL_SECONDS));
        assert!(body.get("sfp").is_none());

        let identified = VisitorClaims {
            secret_fingerprint: Some(identity_secret_fingerprint("site")),
            ..claims
        };
        #[allow(clippy::cast_precision_loss)]
        let token = issue_visitor_token("worker", &identified, Some((NOW + 600) as f64), NOW);
        assert_eq!(read_visitor_token("worker", &token, NOW), Some(identified));
        assert_eq!(read_visitor_token("worker", &token, NOW + 661), None);
    }

    #[test]
    fn identity_tokens_are_checked_claim_by_claim() {
        let exp = NOW + 3600;
        let ok = verify_identity_token(
            "site",
            &identity(&json!({ "sub": " u-1 ", "email": " Ada@Site.TEST ", "name": "  Ada  ", "exp": exp })),
            NOW,
        )
        .expect("valid");
        assert_eq!(ok.external_id, "u-1");
        assert_eq!(ok.email.as_deref(), Some("ada@site.test"));
        assert_eq!(ok.name.as_deref(), Some("Ada"));
        #[allow(clippy::cast_precision_loss)]
        let expected = exp as f64;
        assert!((ok.expires_at - expected).abs() < f64::EPSILON);

        let numeric =
            verify_identity_token("site", &identity(&json!({ "sub": 42, "exp": exp })), NOW);
        assert_eq!(numeric.expect("valid").external_id, "42");

        for claims in [
            json!({ "exp": exp }),
            json!({ "sub": "  ", "exp": exp }),
            json!({ "sub": true, "exp": exp }),
            json!({ "sub": "u" }),
            json!({ "sub": "u", "exp": NOW + 31 * 24 * 3600 }),
            json!({ "sub": "u", "exp": exp, "email": "nope" }),
            json!({ "sub": "u", "exp": exp, "email": "a@b@c.d" }),
            json!({ "sub": "u", "exp": exp, "email": "a b@c.d" }),
            json!({ "sub": "u", "exp": exp, "email": "a@c." }),
            json!({ "sub": "u", "exp": exp, "email": 7 }),
        ] {
            assert_eq!(
                verify_identity_token("site", &identity(&claims), NOW),
                Err("claims"),
                "{claims}"
            );
        }
        assert_eq!(
            verify_identity_token("other", &identity(&json!({ "sub": "u", "exp": exp })), NOW),
            Err("signature")
        );
        // An empty email is no email.
        let blank = verify_identity_token(
            "site",
            &identity(&json!({ "sub": "u", "exp": exp, "email": "", "name": 5 })),
            NOW,
        )
        .expect("valid");
        assert_eq!((blank.email, blank.name), (None, None));
    }

    #[test]
    fn numbers_read_as_javascript_writes_them() {
        assert_eq!(js_number_string(42.0), "42");
        assert_eq!(js_number_string(-0.0), "0");
        assert_eq!(js_number_string(1.5), "1.5");
        assert_eq!(js_number_string(1e21), "1e+21");
        assert_eq!(js_number_string(1.5e-7), "1.5e-7");
        assert_eq!(js_number_string(123_456_789_012.0), "123456789012");
    }

    #[test]
    fn names_are_cut_in_utf16_units() {
        assert_eq!(js_prefix("abc", 2), "ab");
        assert_eq!(js_prefix("a😀b", 2), "a");
        assert_eq!(js_prefix("a😀b", 3), "a😀");
    }
}
