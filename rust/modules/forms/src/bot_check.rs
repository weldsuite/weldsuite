//! Bot checks behind one port (`services/bot-check.ts`, ADR FORMS-005):
//! Cloudflare Turnstile on Global, ALTCHA (self-hosted proof of work, no
//! third party) on Kubernetes, or none.
//!
//! ALTCHA: a challenge is `{ algorithm, challenge, salt, signature,
//! maxnumber }` with `challenge = SHA-256(salt + secretNumber)` and
//! `signature = HMAC-SHA-256(ALTCHA_HMAC_KEY, challenge)`. The browser finds
//! the number and sends the base64 JSON back; a solved challenge works once
//! (a marker in the cache). Both backends sign and verify the same bytes.

use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use weldsuite_ports::HttpRequest;

use crate::common::{Env, FormsResult, Svc};
use crate::crypto::{
    LENIENT_BASE64, base64_url, hmac_hex, random_bytes, random_u32, safe_equal, sha256_hex,
};

pub(crate) const ALTCHA_MAX_NUMBER: u32 = 50_000;
const ALTCHA_TTL_SECONDS: i64 = 10 * 60;
const TURNSTILE_VERIFY_URL: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/// `botCheckProvider(env)`: `turnstile`, `altcha` or `none` (the default).
pub(crate) fn provider(env: &Env) -> &'static str {
    match env
        .get("BOT_CHECK_PROVIDER")
        .unwrap_or_else(|| "none".to_owned())
        .to_lowercase()
        .as_str()
    {
        "turnstile" => "turnstile",
        "altcha" => "altcha",
        _ => "none",
    }
}

/// `AltchaChallenge`.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct AltchaChallenge {
    algorithm: &'static str,
    challenge: String,
    salt: String,
    signature: String,
    maxnumber: u32,
}

/// `createAltchaChallenge(env, now)`: `None` without `ALTCHA_HMAC_KEY`.
pub(crate) fn create_altcha_challenge(env: &Env, now_ms: i64) -> Option<AltchaChallenge> {
    let key = env.non_empty("ALTCHA_HMAC_KEY")?;
    let salt = format!(
        "{}?expires={}",
        base64_url(&random_bytes::<12>()),
        now_ms.div_euclid(1000) + ALTCHA_TTL_SECONDS
    );
    let number = random_u32() % ALTCHA_MAX_NUMBER;
    let challenge = sha256_hex(format!("{salt}{number}").as_bytes());
    Some(AltchaChallenge {
        algorithm: "SHA-256",
        signature: hmac_hex(&key, &challenge),
        challenge,
        salt,
        maxnumber: ALTCHA_MAX_NUMBER,
    })
}

struct AltchaPayload {
    challenge: String,
    number: u64,
    salt: String,
    signature: String,
}

/// `parseAltcha(token)`.
fn parse_altcha(token: &str) -> Option<AltchaPayload> {
    let standard = token.replace('-', "+").replace('_', "/");
    let bytes = LENIENT_BASE64.decode(standard.trim_end_matches('=')).ok()?;
    let raw: Value = serde_json::from_slice(&bytes).ok()?;
    if raw["algorithm"] != "SHA-256" {
        return None;
    }
    let text = |key: &str| raw[key].as_str().map(str::to_owned);
    let number = raw["number"].as_f64()?;
    if number < 0.0 || number.fract() != 0.0 || !number.is_finite() {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let number = number as u64;
    Some(AltchaPayload {
        challenge: text("challenge")?,
        number,
        salt: text("salt")?,
        signature: text("signature")?,
    })
}

/// `Number(new URLSearchParams(salt.split('?')[1] ?? '').get('expires'))`.
fn salt_expiry(salt: &str) -> Option<f64> {
    let query = salt.split('?').nth(1).unwrap_or_default();
    let expires = form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == "expires")
        .map(|(_, value)| value.into_owned());
    // `Number(null)` is 0; `Number('')` too.
    let text = expires.unwrap_or_default();
    let trimmed = weldsuite_kit::validation::js_trim(&text);
    if trimmed.is_empty() {
        return Some(0.0);
    }
    let number = weldsuite_kit::validation::js_number(trimmed);
    number.is_finite().then_some(number)
}

/// `verifyAltcha(env, token, now)`.
pub(crate) async fn verify_altcha(svc: &Svc, token: &str, now_ms: i64) -> FormsResult<bool> {
    let Some(key) = svc.env.non_empty("ALTCHA_HMAC_KEY") else {
        return Ok(false);
    };
    let Some(payload) = parse_altcha(token) else {
        return Ok(false);
    };
    #[allow(clippy::cast_precision_loss)]
    let now = now_ms as f64;
    match salt_expiry(&payload.salt) {
        Some(expires) if expires * 1000.0 >= now => {}
        _ => return Ok(false),
    }
    let hash = sha256_hex(format!("{}{}", payload.salt, payload.number).as_bytes());
    if !safe_equal(&hash, &payload.challenge) {
        return Ok(false);
    }
    if !safe_equal(&hmac_hex(&key, &payload.challenge), &payload.signature) {
        return Ok(false);
    }
    let used = format!("forms:altcha:{}", payload.challenge);
    if svc.cache.get_boxed(&used).await?.is_some() {
        return Ok(false);
    }
    svc.cache
        .put_boxed(
            &used,
            "1",
            Some(Duration::from_secs(
                u64::try_from(ALTCHA_TTL_SECONDS + 60).unwrap_or(660),
            )),
        )
        .await?;
    Ok(true)
}

/// `verifyTurnstile(env, token, ip)`: Cloudflare's siteverify.
pub(crate) async fn verify_turnstile(svc: &Svc, token: &str, ip: Option<&str>) -> bool {
    let Some(secret) = svc.env.non_empty("TURNSTILE_SECRET_KEY") else {
        return false;
    };
    let Some(http) = svc.http.as_ref() else {
        tracing::error!("forms: no outbound HTTP for Turnstile's siteverify");
        return false;
    };
    // Built in a block: the serializer holds a `&dyn Fn`, which is not `Send`.
    let body = {
        let mut body = form_urlencoded::Serializer::new(String::new());
        body.append_pair("secret", &secret);
        body.append_pair("response", token);
        if let Some(ip) = ip {
            body.append_pair("remoteip", ip);
        }
        body.finish()
    };
    let request = HttpRequest {
        method: "POST".to_owned(),
        url: TURNSTILE_VERIFY_URL.to_owned(),
        headers: vec![(
            "content-type".to_owned(),
            "application/x-www-form-urlencoded;charset=UTF-8".to_owned(),
        )],
        body: Some(body.into_bytes()),
    };
    match http.send(request).await {
        Ok(response) if response.ok() => response.json()["success"] == Value::Bool(true),
        Ok(_) => false,
        Err(error) => {
            tracing::error!(%error, "forms: turnstile verification failed");
            false
        }
    }
}

/// `passesBotCheck(env, token, ip)`: always true for `none`.
pub(crate) async fn passes(
    svc: &Svc,
    token: Option<&str>,
    ip: Option<&str>,
    now_ms: i64,
) -> FormsResult<bool> {
    let provider = provider(&svc.env);
    if provider == "none" {
        return Ok(true);
    }
    let Some(token) = token.filter(|token| !token.is_empty()) else {
        return Ok(false);
    };
    if provider == "turnstile" {
        Ok(verify_turnstile(svc, token, ip).await)
    } else {
        verify_altcha(svc, token, now_ms).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn salts_carry_their_expiry() {
        assert_eq!(salt_expiry("abc?expires=1700000600"), Some(1_700_000_600.0));
        assert_eq!(salt_expiry("abc"), Some(0.0));
        assert_eq!(salt_expiry("abc?expires=soon"), None);
    }

    #[test]
    fn payloads_parse_like_atob_json() {
        let token = base64::engine::general_purpose::STANDARD.encode(
            br#"{"algorithm":"SHA-256","challenge":"c","salt":"s?expires=1","signature":"x","maxnumber":50000,"number":12}"#,
        );
        let payload = parse_altcha(&token).expect("parses");
        assert_eq!(payload.number, 12);
        assert!(parse_altcha("bm90IGpzb24").is_none());
    }
}
