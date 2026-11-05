//! GitHub App auth: the App's JWT and installation tokens come from
//! `weldsuite_connect_domain::github_app` (`@weldsuite/connect-domain/github/app-auth`,
//! which WeldMerge uses too); what is connect-api's own is here (the REST
//! headers, the installation's repository list).

use serde_json::{Value, json};
use weldsuite_ports::{HttpRequest, OutboundHttp};

pub(crate) use weldsuite_connect_domain::github_app::{
    AppCredentials, app_jwt, installation_token, installation_token_as,
};

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
