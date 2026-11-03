//! GitHub App authentication (`github/auth.ts`): the App's JWT (RS256 over
//! its private key, PKCS#1 or PKCS#8) and installation access tokens,
//! cached per installation until five minutes before they expire.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};

use serde_json::json;
use weldsuite_ports::{HttpRequest, OutboundHttp};

pub const USER_AGENT: &str = "WeldSuite-Integration-Webhooks";

/// `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`.
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

fn now_seconds() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

/// `mintAppJwt(appId, privateKeyPem)`: valid from a minute ago for ten
/// minutes, issued by the App.
pub fn mint_app_jwt(credentials: &AppCredentials) -> Result<String, String> {
    let key = import_rsa_private_key(&credentials.private_key)?;
    let now = now_seconds();
    let claims = json!({ "iat": now - 60, "exp": now + 540, "iss": credentials.app_id });
    jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &claims,
        &key,
    )
    .map_err(|error| error.to_string())
}

/// `importRsaPrivateKey(pem)`: the key's base64 body whatever its line
/// breaks (the PEM armour and all whitespace dropped), read as PKCS#8 and
/// else as PKCS#1, as the worker tries both.
fn import_rsa_private_key(pem: &str) -> Result<jsonwebtoken::EncodingKey, String> {
    let mut body = String::new();
    let mut rest = pem;
    while let Some(start) = rest.find("-----") {
        body.push_str(&rest[..start]);
        let after = &rest[start + 5..];
        rest = after.find("-----").map_or("", |end| &after[end + 5..]);
    }
    body.push_str(rest);
    let body: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    let wrapped = body
        .as_bytes()
        .chunks(64)
        .map(|line| String::from_utf8_lossy(line).into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    let mut failures = Vec::new();
    for label in ["PRIVATE KEY", "RSA PRIVATE KEY"] {
        let armoured = format!("-----BEGIN {label}-----\n{wrapped}\n-----END {label}-----\n");
        match jsonwebtoken::EncodingKey::from_rsa_pem(armoured.as_bytes()) {
            Ok(key) => return Ok(key),
            Err(error) => failures.push(error.to_string()),
        }
    }
    Err(format!(
        "Failed to import GitHub App private key (tried PKCS#8 and PKCS#1→PKCS#8). pkcs8: {}; pkcs1: {}",
        failures[0], failures[1]
    ))
}

/// The installation tokens this process holds (`tokenCache`), by App and
/// installation.
fn token_cache() -> &'static Mutex<HashMap<String, (String, i64)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (String, i64)>>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

fn cache_key(credentials: &AppCredentials, installation_id: i64) -> String {
    let key_hash = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(
        credentials.private_key.as_bytes(),
    ));
    format!("{}:{key_hash}:{installation_id}", credentials.app_id)
}

/// `getInstallationToken(appId, privateKeyPem, installationId)`.
pub async fn installation_token(
    http: Option<&OutboundHttp>,
    credentials: &AppCredentials,
    installation_id: i64,
) -> Result<String, String> {
    let key = cache_key(credentials, installation_id);
    let now = now_seconds();
    if let Some((token, expires_at)) = token_cache()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&key)
        && expires_at - now > 300
    {
        return Ok(token.clone());
    }
    let jwt = mint_app_jwt(credentials)?;
    let http = http.ok_or("fetch failed")?;
    let request = HttpRequest::empty(
        "POST",
        format!("https://api.github.com/app/installations/{installation_id}/access_tokens"),
    )
    .header("Authorization", format!("Bearer {jwt}"))
    .header("Accept", "application/vnd.github+json")
    .header("X-GitHub-Api-Version", "2022-11-28")
    .header("User-Agent", USER_AGENT);
    let response = http.send(request).await.map_err(|e| e.to_string())?;
    if !response.ok() {
        return Err(format!(
            "GitHub installation token exchange failed ({}): {}",
            response.status,
            response.text()
        ));
    }
    let data = response.json();
    let token = data
        .get("token")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let expires_at = data
        .get("expires_at")
        .and_then(serde_json::Value::as_str)
        .and_then(|at| {
            time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339).ok()
        })
        .map_or(0, time::OffsetDateTime::unix_timestamp);
    token_cache()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(key, (token.clone(), expires_at));
    Ok(token)
}
