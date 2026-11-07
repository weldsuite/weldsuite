//! Whether the person at the GitHub App's install redirect can reach the
//! installation it names (`@weldsuite/connect-domain/github/user-installations`).
//! GitHub documents the redirect's `installation_id` as spoofable, and the
//! App JWT reads every installation, so an install route records one only
//! once a GitHub user token proves access to it: `GET /user/installations`
//! lists it for that user.
//!
//! The token comes from the `code` GitHub adds to the redirect when the App
//! requests user authorization during installation, else from the member's
//! linked GitHub account. WeldMerge's setup route and WeldConnect's callback
//! and recover all ask [`prove_github_installation_access`], so both backends
//! make the same calls.

use std::future::Future;

use serde_json::{Value, json};
use weldsuite_ports::{HttpRequest, OutboundHttp};

pub const GITHUB_OAUTH_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
pub const GITHUB_USER_INSTALLATIONS_URL: &str = "https://api.github.com/user/installations";
/// Installations per page of `GET /user/installations` (GitHub's maximum).
pub const USER_INSTALLATIONS_PER_PAGE: usize = 100;
/// Pages read at most: a thousand installations per user.
pub const USER_INSTALLATIONS_MAX_PAGES: usize = 10;

const USER_AGENT: &str = "WeldSuite-WeldMerge";

/// `exchangeGithubUserCode(clientId, clientSecret, code)`: the App's user
/// token for the install redirect's `code`; `None` when GitHub refuses it
/// (it answers 200 with an `error` field for a bad or used code).
///
/// # Errors
///
/// GitHub cannot be reached.
pub async fn exchange_github_user_code(
    http: &OutboundHttp,
    client_id: &str,
    client_secret: &str,
    code: &str,
) -> Result<Option<String>, String> {
    let response = http
        .send(
            HttpRequest::json(
                "POST",
                GITHUB_OAUTH_TOKEN_URL,
                &json!({ "client_id": client_id, "client_secret": client_secret, "code": code }),
            )
            .header("Accept", "application/json")
            .header("User-Agent", USER_AGENT),
        )
        .await
        .map_err(|error| error.to_string())?;
    if !response.ok() {
        return Ok(None);
    }
    let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    Ok(body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_owned))
}

/// `String(id)` as JavaScript writes a JSON id.
fn id_text(id: Option<&Value>) -> String {
    match id {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

/// `githubUserCanAccessInstallation(userToken, installationId)`: whether the
/// installation is among those the user token reaches, page by page (at
/// most [`USER_INSTALLATIONS_MAX_PAGES`]). A token GitHub refuses reaches none.
///
/// # Errors
///
/// GitHub cannot be reached.
pub async fn github_user_can_access_installation(
    http: &OutboundHttp,
    user_token: &str,
    installation_id: &str,
) -> Result<bool, String> {
    for page in 1..=USER_INSTALLATIONS_MAX_PAGES {
        let url = format!(
            "{GITHUB_USER_INSTALLATIONS_URL}?per_page={USER_INSTALLATIONS_PER_PAGE}&page={page}"
        );
        let response = http
            .send(
                HttpRequest::empty("GET", url)
                    .header("Authorization", format!("Bearer {user_token}"))
                    .header("Accept", "application/vnd.github+json")
                    .header("X-GitHub-Api-Version", "2022-11-28")
                    .header("User-Agent", USER_AGENT),
            )
            .await
            .map_err(|error| error.to_string())?;
        if !response.ok() {
            return Ok(false);
        }
        let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
        let installations = body
            .get("installations")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        if installations
            .iter()
            .any(|installation| id_text(installation.get("id")) == installation_id)
        {
            return Ok(true);
        }
        if installations.len() < USER_INSTALLATIONS_PER_PAGE {
            return Ok(false);
        }
    }
    Ok(false)
}

/// What an install route has to prove access with (`InstallationAccessEvidence`).
#[derive(Debug, Clone, Copy, Default)]
pub struct InstallationAccessEvidence<'a> {
    /// The install redirect's `code`, if GitHub sent one.
    pub code: Option<&'a str>,
    /// The App's OAuth client; without it a `code` is not exchanged.
    pub client_id: Option<&'a str>,
    pub client_secret: Option<&'a str>,
}

/// `proveGithubInstallationAccess(installationId, evidence)`: true when a
/// GitHub user token proves access to the installation, the one the `code`
/// is exchanged for, else the member's own (`member_token`, asked for only
/// when the code proved nothing). False when neither does (the caller
/// refuses with `installation_unverified`).
///
/// # Errors
///
/// GitHub cannot be reached, or `member_token` fails.
pub async fn prove_github_installation_access<F, Fut>(
    http: &OutboundHttp,
    installation_id: &str,
    evidence: InstallationAccessEvidence<'_>,
    member_token: F,
) -> Result<bool, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Option<String>, String>>,
{
    let present = |value: Option<&str>| value.filter(|v| !v.is_empty()).map(str::to_owned);
    if let (Some(code), Some(client_id), Some(client_secret)) = (
        present(evidence.code),
        present(evidence.client_id),
        present(evidence.client_secret),
    ) && let Some(token) =
        exchange_github_user_code(http, &client_id, &client_secret, &code).await?
        && github_user_can_access_installation(http, &token, installation_id).await?
    {
        return Ok(true);
    }
    match member_token().await? {
        Some(token) if !token.is_empty() => {
            github_user_can_access_installation(http, &token, installation_id).await
        }
        _ => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_id_as_javascript_writes_it() {
        assert_eq!(id_text(Some(&json!(4242))), "4242");
        assert_eq!(id_text(Some(&json!("4242"))), "4242");
        assert_eq!(id_text(None), "");
    }
}
