//! GitHub App auth (`@weldsuite/connect-domain/github/app-auth`): the app
//! JWT (RS256, `iss` = the App id, nine minutes) and installation tokens,
//! cached while they have more than five minutes left. Every call goes
//! through the outbound HTTP port.
//!
//! One implementation for every module that acts as the WeldSuite GitHub
//! App: WeldConnect (connect-api, the `github.*` workflow actions) and
//! WeldMerge (merge-api), as the TypeScript workers share the package.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::{Value, json};
use weldsuite_ports::{HttpRequest, OutboundHttp};

/// The GitHub App's id and private key (PEM, PKCS#1 or PKCS#8, or a bare
/// base64 body).
#[derive(Clone)]
pub struct AppCredentials {
    pub app_id: String,
    pub private_key: String,
}

impl std::fmt::Debug for AppCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppCredentials")
            .field("app_id", &self.app_id)
            .finish_non_exhaustive()
    }
}

fn now_secs() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

/// The key, whatever armor it was stored with.
fn encoding_key(pem: &str) -> Result<EncodingKey, String> {
    let body: String = pem
        .lines()
        .filter(|line| !line.trim_start().starts_with("-----"))
        .flat_map(str::chars)
        .filter(|c| !c.is_whitespace())
        .collect();
    let wrap = |label: &str| {
        let lines: Vec<String> = body
            .as_bytes()
            .chunks(64)
            .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
            .collect();
        format!(
            "-----BEGIN {label}-----\n{}\n-----END {label}-----\n",
            lines.join("\n")
        )
    };
    EncodingKey::from_rsa_pem(wrap("PRIVATE KEY").as_bytes())
        .or_else(|pkcs8| {
            EncodingKey::from_rsa_pem(wrap("RSA PRIVATE KEY").as_bytes()).map_err(|pkcs1| {
                format!(
                    "Failed to import GitHub App private key (tried PKCS#8 and PKCS#1→PKCS#8). pkcs8: {pkcs8}; pkcs1: {pkcs1}"
                )
            })
        })
}

/// `mintGithubAppJwt(appId, privateKeyPem)`.
///
/// # Errors
///
/// The key does not import, or the token does not sign.
pub fn app_jwt(creds: &AppCredentials) -> Result<String, String> {
    let key = encoding_key(&creds.private_key)?;
    let now = now_secs();
    let claims = json!({ "iat": now - 60, "exp": now + 540, "iss": creds.app_id });
    jsonwebtoken::encode(&Header::new(Algorithm::RS256), &claims, &key)
        .map_err(|error| error.to_string())
}

/// Tokens by App and installation: the token and when it expires (seconds).
type TokenCache = Mutex<HashMap<(String, i64), (String, i64)>>;

fn token_cache() -> &'static TokenCache {
    static CACHE: OnceLock<TokenCache> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

/// `Date.parse(text)` in whole milliseconds, for an ISO time GitHub sends.
fn parse_ms(text: &str) -> Option<i64> {
    let iso = weldsuite_db::js_timestamp(text)?;
    let at =
        time::OffsetDateTime::parse(&iso, &time::format_description::well_known::Rfc3339).ok()?;
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok()
}

/// `getGithubInstallationToken(appId, privateKey, installationId)`. `cache`
/// off reads and writes no cached token (conformance runs, which start each
/// test file empty on the TypeScript side).
///
/// # Errors
///
/// The key does not import, the id is not a positive safe integer, GitHub
/// cannot be reached or refuses the exchange; the text is the worker's error.
pub async fn installation_token(
    http: &OutboundHttp,
    creds: &AppCredentials,
    installation_id: i64,
    cache: bool,
) -> Result<String, String> {
    installation_token_as(http, creds, installation_id, cache, "WeldSuite-WeldConnect").await
}

/// [`installation_token`] sent as `agent` (connect-api's own
/// `services/github/auth.ts` says `WeldSuite-Core-API`).
///
/// # Errors
///
/// As [`installation_token`].
pub async fn installation_token_as(
    http: &OutboundHttp,
    creds: &AppCredentials,
    installation_id: i64,
    cache: bool,
    agent: &str,
) -> Result<String, String> {
    let key = (creds.app_id.clone(), installation_id);
    if cache {
        let cached = token_cache()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key)
            .cloned();
        if let Some((token, expires_at)) = cached
            && expires_at - now_secs() > 300
        {
            return Ok(token);
        }
    }
    let jwt = app_jwt(creds)?;
    if installation_id <= 0 || installation_id > 9_007_199_254_740_991 {
        return Err(format!("Invalid GitHub installation id: {installation_id}"));
    }
    let response = http
        .send(
            HttpRequest::empty(
                "POST",
                format!("https://api.github.com/app/installations/{installation_id}/access_tokens"),
            )
            .header("Authorization", format!("Bearer {jwt}"))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", agent),
        )
        .await
        .map_err(|error| error.to_string())?;
    if !response.ok() {
        return Err(format!(
            "GitHub installation token exchange failed ({}): {}",
            response.status,
            response.text()
        ));
    }
    let body: Value = serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
    let token = body["token"].as_str().unwrap_or_default().to_owned();
    if cache {
        let expires_at = body["expires_at"]
            .as_str()
            .and_then(parse_ms)
            .map_or(0, |ms| ms / 1000);
        token_cache()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key, (token.clone(), expires_at));
    }
    Ok(token)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn github_times_read_as_milliseconds() {
        assert_eq!(parse_ms("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(parse_ms("not a date"), None);
    }

    #[test]
    fn a_key_that_is_not_one_refuses_to_sign() {
        let creds = AppCredentials {
            app_id: "1".to_owned(),
            private_key: "test-key".to_owned(),
        };
        assert!(
            app_jwt(&creds)
                .unwrap_err()
                .starts_with("Failed to import GitHub App private key")
        );
    }
}
