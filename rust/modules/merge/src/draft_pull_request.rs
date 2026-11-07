//! `merge_open_draft_pull_request` (WeldAgent, `services/draft-pull-request.ts`):
//! commits files to a new branch through GitHub's Git Data API and opens a
//! draft pull request. GitHub only.
//!
//! The calls, in order (the worker makes the same ones, the conformance suite
//! compares them): read the base branch's sha, read its commit for the tree,
//! one blob per file, a tree on top of the base tree, a commit, the branch
//! ref, the pull request. They go out with the installation token, so GitHub
//! shows the WeldSuite App as the author. The mirror row arrives with
//! GitHub's `pull_request` webhook like any other pull request.

use serde_json::{Map, Value, json};
use weldsuite_connect_domain::github_app::{AppCredentials, installation_token};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::connections::find_connection;
use crate::db::{opt_text, text};
use crate::github_client::GITHUB_API;
use crate::{MergeError, MergeState, Overrides};

/// What the tool needs of the internal call's scope.
pub(crate) struct ToolScope<'a> {
    pub(crate) state: &'a MergeState,
    pub(crate) db: &'a PgPool,
    pub(crate) overrides: &'a Overrides,
}

/// `mergeDraftPullRequestInputSchema`, as validated.
struct DraftInput {
    repository_id: String,
    title: String,
    body: Option<String>,
    branch: String,
    base_branch: Option<String>,
    commit_message: String,
    files: Vec<(String, String)>,
    issue_key: Option<String>,
}

fn read_input(issues: &mut Issues, fields: &Map<String, Value>) -> DraftInput {
    let req = |issues: &mut Issues, key: &str, rules: Text| {
        issues
            .text_with(fields, key, Presence::Required, rules)
            .into_option()
            .unwrap_or_default()
    };
    let repository_id = req(issues, "repositoryId", Text::length(Some(1), None));
    let title = req(issues, "title", Text::trimmed(Some(1), Some(1000)));
    let body = issues
        .text(fields, "body", Presence::Optional, None, Some(65_000))
        .into_option();
    let branch = req(issues, "branch", Text::trimmed(Some(1), Some(250)));
    let base_branch = issues
        .text_with(
            fields,
            "baseBranch",
            Presence::Optional,
            Text::trimmed(None, Some(250)),
        )
        .into_option();
    let commit_message = req(issues, "commitMessage", Text::trimmed(Some(1), Some(1000)));
    let files = issues
        .list(
            fields,
            "files",
            Presence::Required,
            Some(1),
            Some(50),
            |issues, item| {
                let file = issues.object(item)?;
                let before = issues.count();
                let path = issues
                    .text(file, "path", Presence::Required, Some(1), Some(1000))
                    .into_option();
                let content = issues
                    .text(file, "content", Presence::Required, None, Some(1_000_000))
                    .into_option();
                if issues.count() > before {
                    return None;
                }
                Some((path?, content?))
            },
        )
        .into_option()
        .unwrap_or_default();
    let issue_key = issues
        .text(fields, "issueKey", Presence::Optional, None, None)
        .into_option();
    DraftInput {
        repository_id,
        title,
        body,
        branch,
        base_branch,
        commit_message,
        files,
        issue_key,
    }
}

/// `BRANCH_NAME`: a conservative subset of what git accepts as a branch name
/// (`^(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._/-]+$`).
fn usable_branch(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.contains("..")
        && !name.contains("//")
        && !name.ends_with('/')
        && name.strip_suffix(".lock").is_none()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
}

/// Why the tool refused (`DraftPullRequestError`, `GithubNotConfiguredError`,
/// `GithubApiError`), as the agent reads it.
enum DraftError {
    Refused(String),
    Failed(MergeError),
}

impl From<MergeError> for DraftError {
    fn from(error: MergeError) -> Self {
        Self::Failed(error)
    }
}

/// One call to GitHub with the installation token; a non-2xx answer is
/// `GitHub answered <status> for <METHOD> <path>[: <message>]`.
async fn github(
    http: &OutboundHttp,
    token: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, DraftError> {
    let url = format!("{GITHUB_API}{path}");
    let request = match body {
        Some(body) => HttpRequest::json(method, url, body),
        None => HttpRequest::empty(method, url),
    }
    .header("Authorization", format!("Bearer {token}"))
    .header("Accept", "application/vnd.github+json")
    .header("X-GitHub-Api-Version", "2022-11-28")
    .header("User-Agent", "WeldSuite-WeldMerge");
    let response = http
        .send(request)
        .await
        .map_err(|error| DraftError::Failed(MergeError::Unexpected(error.to_string())))?;
    if !response.ok() {
        let detail = serde_json::from_slice::<Value>(&response.body)
            .ok()
            .and_then(|body| {
                body.get("message")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .filter(|m| !m.is_empty());
        let reason = detail.map(|d| format!(": {d}")).unwrap_or_default();
        let path = path.split('?').next().unwrap_or(path);
        return Err(DraftError::Refused(format!(
            "GitHub answered {} for {method} {path}{reason}",
            response.status
        )));
    }
    serde_json::from_slice(&response.body)
        .map_err(|error| DraftError::Failed(MergeError::Unexpected(error.to_string())))
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// `openDraftPullRequest(env, installationId, repository, input)`.
async fn open_draft_pull_request(
    scope: &ToolScope<'_>,
    installation_id: &str,
    repository: &Value,
    input: &DraftInput,
) -> Result<Value, DraftError> {
    let set = |name: &str| scope.overrides.env_set(scope.state, name);
    let (Some(app_id), Some(private_key)) = (set("GITHUB_APP_ID"), set("GITHUB_APP_PRIVATE_KEY"))
    else {
        return Err(DraftError::Refused(
            "GitHub is not configured for WeldMerge".to_owned(),
        ));
    };
    if !usable_branch(&input.branch) {
        return Err(DraftError::Refused(format!(
            "\"{}\" is not a usable branch name",
            input.branch
        )));
    }
    let base_branch = input
        .base_branch
        .clone()
        .filter(|b| !b.is_empty())
        .or_else(|| opt_text(repository, "defaultBranch").filter(|b| !b.is_empty()))
        .unwrap_or_else(|| "main".to_owned());
    let repo = format!("/repos/{}", text(repository, "fullName"));
    let http = scope
        .overrides
        .outbound(scope.state)
        .ok_or_else(|| DraftError::Failed(MergeError::Unexpected("fetch failed".to_owned())))?;
    // `Number(installationId)`.
    let installation = installation_id.trim().parse::<i64>().map_err(|_| {
        DraftError::Failed(MergeError::Unexpected(format!(
            "Invalid GitHub installation id: {installation_id}"
        )))
    })?;
    let token = installation_token(
        &http,
        &AppCredentials {
            app_id,
            private_key,
        },
        installation,
        // Conformance runs carry their own HTTP stub: no process cache.
        scope.overrides.http.is_none(),
    )
    .await
    .map_err(|error| DraftError::Failed(MergeError::Unexpected(error)))?;

    let reference = github(
        &http,
        &token,
        "GET",
        &format!("{repo}/git/ref/heads/{base_branch}"),
        None,
    )
    .await?;
    let base_sha = str_at(&reference, "/object/sha").to_owned();
    let base_commit = github(
        &http,
        &token,
        "GET",
        &format!("{repo}/git/commits/{base_sha}"),
        None,
    )
    .await?;
    let base_tree = str_at(&base_commit, "/tree/sha").to_owned();

    let mut entries: Vec<Value> = Vec::with_capacity(input.files.len());
    for (path, content) in &input.files {
        let blob = github(
            &http,
            &token,
            "POST",
            &format!("{repo}/git/blobs"),
            Some(&json!({ "content": content, "encoding": "utf-8" })),
        )
        .await?;
        entries.push(
            json!({ "path": path, "mode": "100644", "type": "blob", "sha": str_at(&blob, "/sha") }),
        );
    }
    let tree = github(
        &http,
        &token,
        "POST",
        &format!("{repo}/git/trees"),
        Some(&json!({ "base_tree": base_tree, "tree": entries })),
    )
    .await?;
    let commit = github(
        &http,
        &token,
        "POST",
        &format!("{repo}/git/commits"),
        Some(&json!({
            "message": input.commit_message,
            "tree": str_at(&tree, "/sha"),
            "parents": [base_sha],
        })),
    )
    .await?;
    github(
        &http,
        &token,
        "POST",
        &format!("{repo}/git/refs"),
        Some(&json!({ "ref": format!("refs/heads/{}", input.branch), "sha": str_at(&commit, "/sha") })),
    )
    .await?;

    let issue_key = input
        .issue_key
        .as_deref()
        .map(weldsuite_kit::validation::js_trim)
        .filter(|k| !k.is_empty());
    let text_body = input.body.clone().unwrap_or_default();
    let body = match issue_key {
        Some(key) if !text_body.contains(key) => {
            let separator = if text_body.is_empty() { "" } else { "\n\n" };
            format!("{text_body}{separator}Refs {key}")
        }
        _ => text_body,
    };
    let pull = github(
        &http,
        &token,
        "POST",
        &format!("{repo}/pulls"),
        Some(&json!({
            "title": input.title,
            "head": input.branch,
            "base": base_branch,
            "body": body,
            "draft": true,
        })),
    )
    .await?;
    Ok(json!({
        "number": pull.get("number").cloned().unwrap_or(Value::Null),
        "url": pull.get("html_url").cloned().unwrap_or(Value::Null),
        "branch": input.branch,
        "baseBranch": base_branch,
        "draft": true,
    }))
}

fn ok(result: Value) -> Value {
    let mut out = Map::new();
    out.insert("ok".to_owned(), Value::Bool(true));
    out.insert("result".to_owned(), result);
    out.insert("error".to_owned(), Value::Null);
    Value::Object(out)
}

fn refuse(error: String) -> Value {
    let mut out = Map::new();
    out.insert("ok".to_owned(), Value::Bool(false));
    out.insert("result".to_owned(), Value::Null);
    out.insert("error".to_owned(), Value::String(error));
    Value::Object(out)
}

/// The `merge_open_draft_pull_request` tool: `{ ok, result, error }`.
pub(crate) async fn tool(
    scope: ToolScope<'_>,
    input: &Map<String, Value>,
) -> Result<Value, MergeError> {
    let mut issues = Issues::default();
    let parsed = read_input(&mut issues, input);
    if let Err(invalid) = issues.finish() {
        let lines: Vec<String> = invalid
            .issues()
            .iter()
            .map(|issue| {
                let path = issue
                    .get("path")
                    .and_then(Value::as_array)
                    .map(|p| {
                        p.iter()
                            .map(|s| s.as_str().map_or_else(|| s.to_string(), str::to_owned))
                            .collect::<Vec<_>>()
                            .join(".")
                    })
                    .unwrap_or_default();
                let message = issue
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if path.is_empty() {
                    message.to_owned()
                } else {
                    format!("{path}: {message}")
                }
            })
            .collect();
        return Ok(refuse(lines.join("; ")));
    }
    let repository: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from merge_repositories r where r.id = $1 and r.deleted_at is null limit 1",
    )
    .bind(&parsed.repository_id)
    .fetch_optional(scope.db)
    .await?;
    let Some(repository) = repository.map(weldsuite_db::js_row) else {
        return Ok(refuse(format!(
            "Repository {} was not found",
            parsed.repository_id
        )));
    };
    if text(&repository, "provider") != "github" {
        return Ok(refuse(
            "Opening a draft pull request is only supported for GitHub repositories".to_owned(),
        ));
    }
    let Some(connection) = find_connection(scope.db, text(&repository, "connectionId")).await?
    else {
        return Ok(refuse("The repository connection was not found".to_owned()));
    };
    match open_draft_pull_request(
        &scope,
        text(&connection, "externalAccountId"),
        &repository,
        &parsed,
    )
    .await
    {
        Ok(result) => Ok(ok(result)),
        Err(DraftError::Refused(message)) => Ok(refuse(message)),
        Err(DraftError::Failed(error)) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_names_follow_the_conservative_subset() {
        assert!(usable_branch("agent/plat-1"));
        assert!(usable_branch("v1.2_fix"));
        for bad in [
            "bad..name",
            "/lead",
            "trail/",
            "a//b",
            "x.lock",
            "sp ace",
            "",
        ] {
            assert!(!usable_branch(bad), "{bad}");
        }
    }
}
