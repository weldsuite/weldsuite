//! GitHub App auth (`@weldsuite/connect-domain/github/app-auth`): the app
//! JWT (RS256, `iss` = the App id, nine minutes) and installation tokens,
//! cached while they have more than five minutes left. Every call goes
//! through the outbound HTTP port.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};

use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::{Value, json};
use weldsuite_ports::{HttpRequest, OutboundHttp};

/// The GitHub App's id and private key (PEM, PKCS#1 or PKCS#8, or a bare
/// base64 body).
#[derive(Clone)]
pub(crate) struct AppCredentials {
    pub(crate) app_id: String,
    pub(crate) private_key: String,
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
pub(crate) fn app_jwt(creds: &AppCredentials) -> Result<String, String> {
    let key = encoding_key(&creds.private_key)?;
    let now = now_secs();
    let claims = json!({ "iat": now - 60, "exp": now + 540, "iss": creds.app_id });
    jsonwebtoken::encode(&Header::new(Algorithm::RS256), &claims, &key)
        .map_err(|error| error.to_string())
}

fn token_cache() -> &'static Mutex<HashMap<(String, i64), (String, i64)>> {
    static CACHE: OnceLock<Mutex<HashMap<(String, i64), (String, i64)>>> = OnceLock::new();
    CACHE.get_or_init(Mutex::default)
}

/// `getGithubInstallationToken(appId, privateKey, installationId)`. `cache`
/// off reads and writes no cached token (conformance runs, which start each
/// test file empty on the TypeScript side).
pub(crate) async fn installation_token(
    http: &OutboundHttp,
    creds: &AppCredentials,
    installation_id: i64,
    cache: bool,
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
            .header("User-Agent", "WeldSuite-WeldConnect"),
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
            .and_then(crate::cron::parse_ms)
            .map_or(0, |ms| ms / 1000);
        token_cache()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key, (token.clone(), expires_at));
    }
    Ok(token)
}

/// GitHub's REST headers with a bearer token.
pub(crate) fn github_get(url: String, token: &str, agent: &str) -> HttpRequest {
    HttpRequest::empty("GET", url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", agent)
}

/// `listAvailableRepos(installationToken)`: every repository the
/// installation can reach, 100 a page.
pub(crate) async fn list_available_repos(
    http: &OutboundHttp,
    token: &str,
) -> Result<Vec<Value>, String> {
    let mut repos = Vec::new();
    let mut page = 1;
    loop {
        let response = http
            .send(github_get(
                format!(
                    "https://api.github.com/installation/repositories?per_page=100&page={page}"
                ),
                token,
                "WeldSuite-Core-API",
            ))
            .await
            .map_err(|error| error.to_string())?;
        if !response.ok() {
            return Err(format!(
                "Failed to list installation repositories ({}): {}",
                response.status,
                response.text()
            ));
        }
        let data: Value =
            serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
        let page_repos = data["repositories"].as_array().cloned().unwrap_or_default();
        for r in &page_repos {
            repos.push(json!({
                "id": r["id"],
                "fullName": r["full_name"],
                "defaultBranch": r["default_branch"],
                "private": r["private"],
            }));
        }
        let total = data["total_count"].as_f64().unwrap_or(f64::NAN);
        #[allow(clippy::cast_precision_loss)]
        if repos.len() as f64 >= total || page_repos.len() < 100 {
            break;
        }
        page += 1;
    }
    Ok(repos)
}
