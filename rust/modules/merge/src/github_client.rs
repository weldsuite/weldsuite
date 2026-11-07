//! GitHub REST access (`services/github-client.ts`). Installation tokens are
//! minted per client, on its first call, through the one shared helper
//! (`weldsuite_connect_domain::github_app`, the same GitHub App as
//! WeldConnect); nothing long-lived is stored.

use std::sync::{Mutex, PoisonError};

use serde_json::Value;
use weldsuite_connect_domain::github_app::{AppCredentials, installation_token};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::MergeError;

pub(crate) const GITHUB_API: &str = "https://api.github.com";
const PAGE: usize = 100;

/// A client for one installation (`createGithubClient(env, installationId)`).
pub(crate) struct GithubClient {
    http: Option<OutboundHttp>,
    credentials: Option<AppCredentials>,
    installation_id: String,
    /// Whether a minted token may be cached in the process (not in
    /// conformance runs, which carry their own HTTP stub).
    cache: bool,
    token: OnceToken,
}

impl GithubClient {
    pub(crate) fn new(
        http: Option<OutboundHttp>,
        credentials: Option<AppCredentials>,
        installation_id: &str,
        cache: bool,
    ) -> Self {
        Self {
            http,
            credentials,
            installation_id: installation_id.to_owned(),
            cache,
            token: OnceToken::default(),
        }
    }

    /// Sends one call with the installation's token (minted on first use):
    /// a JSON body when given. The answer as it came.
    pub(crate) async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<weldsuite_ports::HttpResponse, MergeError> {
        let Some(credentials) = &self.credentials else {
            return Err(MergeError::GithubNotConfigured);
        };
        let http = self
            .http
            .as_ref()
            .ok_or_else(|| MergeError::Unexpected("fetch failed".to_owned()))?;
        let token = if let Some(token) = self.token.get() {
            token
        } else {
            // `Number(installationId)`: not a number fails the mint.
            let installation = self.installation_id.trim().parse::<i64>().map_err(|_| {
                MergeError::Unexpected(format!(
                    "Invalid GitHub installation id: {}",
                    self.installation_id
                ))
            })?;
            let minted = installation_token(http, credentials, installation, self.cache)
                .await
                .map_err(MergeError::Unexpected)?;
            self.token.set(minted.clone());
            minted
        };
        let request = match body {
            Some(body) => HttpRequest::json(method, format!("{GITHUB_API}{path}"), body),
            None => HttpRequest::empty(method, format!("{GITHUB_API}{path}")),
        };
        http.send(
            request
                .header("Authorization", format!("Bearer {token}"))
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .header("User-Agent", "WeldSuite-WeldMerge"),
        )
        .await
        .map_err(|error| MergeError::Unexpected(error.to_string()))
    }

    /// `client.get(path)`: the parsed JSON body, or `None` on a 404.
    pub(crate) async fn get(&self, path: &str) -> Result<Option<Value>, MergeError> {
        let response = self.send("GET", path, None).await?;
        if response.status == 404 {
            return Ok(None);
        }
        if !response.ok() {
            return Err(MergeError::GithubApi(response.status));
        }
        serde_json::from_slice(&response.body)
            .map(Some)
            .map_err(|error| MergeError::Unexpected(error.to_string()))
    }
}

/// The token a client minted, kept for its later calls.
#[derive(Default)]
struct OnceToken(Mutex<Option<String>>);

impl OnceToken {
    fn get(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn set(&self, token: String) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(token);
    }
}

/// `encodeURIComponent(text)`.
pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            out.push('%');
            out.push(char::from(HEX[usize::from(byte >> 4)]));
            out.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    out
}

/// `listInstallationRepositories(client)`: what the installation can see,
/// up to 500.
pub(crate) async fn list_installation_repositories(
    client: &GithubClient,
) -> Result<Vec<Value>, MergeError> {
    let mut out = Vec::new();
    for page in 1..=5 {
        let body = client
            .get(&format!(
                "/installation/repositories?per_page={PAGE}&page={page}"
            ))
            .await?;
        let repos = body
            .as_ref()
            .and_then(|b| b.get("repositories"))
            .filter(|r| !r.is_null())
            .map(array_of)
            .transpose()?
            .unwrap_or_default();
        let count = repos.len();
        out.extend(repos);
        if count < PAGE {
            break;
        }
    }
    Ok(out)
}

/// `for (const x of value)`: an array's items; anything else throws.
fn array_of(value: &Value) -> Result<Vec<Value>, MergeError> {
    value
        .as_array()
        .cloned()
        .ok_or_else(|| MergeError::Unexpected("not iterable".to_owned()))
}

/// `getRepositoryById(client, externalId)`: one repository by its provider
/// id, or `None` when the installation cannot see it.
pub(crate) async fn get_repository_by_id(
    client: &GithubClient,
    external_id: &str,
) -> Result<Option<Value>, MergeError> {
    client
        .get(&format!(
            "/repositories/{}",
            encode_uri_component(external_id)
        ))
        .await
}

const BACKFILL_DAYS: f64 = 30.0;
const BACKFILL_CAP: usize = 300;

/// `listPullRequestsForBackfill(client, fullName)`: open pull requests, and
/// those closed or merged in the last 30 days, newest update first, at most
/// ~300 in all.
pub(crate) async fn list_pull_requests_for_backfill(
    client: &GithubClient,
    full_name: &str,
    now_ms: f64,
) -> Result<Vec<Value>, MergeError> {
    let since = now_ms - BACKFILL_DAYS * 24.0 * 60.0 * 60.0 * 1000.0;
    let mut out = Vec::new();
    let mut taken = 0;
    for state in ["open", "closed"] {
        let mut page = 1;
        'pages: while taken < BACKFILL_CAP {
            let rows = match client
                .get(&format!(
                    "/repos/{full_name}/pulls?state={state}&sort=updated&direction=desc&per_page={PAGE}&page={page}"
                ))
                .await?
            {
                None | Some(Value::Null) => Vec::new(),
                Some(value) => array_of(&value)?,
            };
            for pr in &rows {
                if state == "closed" {
                    let updated = crate::github::iso_of(pr.get("updated_at"))
                        .and_then(|iso| crate::github::millis_of(&iso))
                        .unwrap_or(f64::NAN);
                    if updated < since {
                        break 'pages;
                    }
                }
                out.push(pr.clone());
                taken += 1;
                if taken >= BACKFILL_CAP {
                    break 'pages;
                }
            }
            if rows.len() < PAGE {
                break;
            }
            page += 1;
        }
    }
    Ok(out)
}

/// `listPullRequestReviews(client, fullName, number)`.
pub(crate) async fn list_pull_request_reviews(
    client: &GithubClient,
    full_name: &str,
    number: i64,
) -> Result<Vec<Value>, MergeError> {
    match client
        .get(&format!(
            "/repos/{full_name}/pulls/{number}/reviews?per_page={PAGE}"
        ))
        .await?
    {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => array_of(&value),
    }
}

/// `listCheckSuites(client, fullName, sha)`.
pub(crate) async fn list_check_suites(
    client: &GithubClient,
    full_name: &str,
    sha: &str,
) -> Result<Vec<Value>, MergeError> {
    let body = client
        .get(&format!(
            "/repos/{full_name}/commits/{}/check-suites?per_page={PAGE}",
            encode_uri_component(sha)
        ))
        .await?;
    match body.as_ref().and_then(|b| b.get("check_suites")) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => array_of(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_uri_component("abc123"), "abc123");
        assert_eq!(encode_uri_component("a/b c"), "a%2Fb%20c");
        assert_eq!(encode_uri_component("é"), "%C3%A9");
    }
}
