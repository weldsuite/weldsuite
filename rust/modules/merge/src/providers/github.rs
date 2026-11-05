//! GitHub behind the provider seam (`services/providers/github/*`):
//!
//! - the connection adapter wraps the App's REST client
//!   ([`crate::github_client`]); each adapter call makes its own client, so
//!   each mints its own installation token, as the worker's `clientFor(ctx)`;
//! - the issue adapter (two-way issue sync): issues and comments, a token
//!   minted per call, pull requests left out of every read;
//! - the App's user authorization (user-to-server OAuth), for members.

use serde_json::{Map, Value, json};
use weldsuite_ports::OutboundHttp;

use super::http::{Body, bearer, credentials_from_token, request_json};
use super::{
    AdapterContext, IssueWriteInput, ListIssuesOptions, NormalizedIssue, NormalizedIssueComment,
    OAuthUser, RemoteRepository, RepositoryRef,
};
use crate::MergeError;
use crate::credentials::StoredCredentials;
use crate::github::{
    MirrorFields, combine_check_suites, iso_of, js_string, map_github_pull_request,
    review_decision_from_reviews,
};
use crate::github_client::{
    get_repository_by_id, list_check_suites, list_installation_repositories,
    list_pull_request_reviews, list_pull_requests_for_backfill as backfill,
};

// ── Connection adapter ─────────────────────────────────────────────────────

/// `remoteRepository(repo)`.
fn remote_repository(repo: &Value) -> RemoteRepository {
    RemoteRepository {
        external_id: js_string(repo.get("id")),
        full_name: repo.get("full_name").cloned().unwrap_or(Value::Null),
        private: repo.get("private").cloned().unwrap_or(Value::Null),
        default_branch: repo
            .get("default_branch")
            .and_then(Value::as_str)
            .map(str::to_owned),
        url: repo
            .get("html_url")
            .and_then(Value::as_str)
            .map(str::to_owned),
        external_project: None,
    }
}

pub(crate) async fn list_available_repositories(
    ctx: &AdapterContext,
) -> Result<Vec<RemoteRepository>, MergeError> {
    Ok(list_installation_repositories(&ctx.github())
        .await?
        .iter()
        .map(remote_repository)
        .collect())
}

pub(crate) async fn get_repository(
    ctx: &AdapterContext,
    external_id: &str,
) -> Result<Option<RemoteRepository>, MergeError> {
    Ok(get_repository_by_id(&ctx.github(), external_id)
        .await?
        .as_ref()
        .map(remote_repository))
}

pub(crate) async fn list_pull_requests_for_backfill(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
) -> Result<Vec<MirrorFields>, MergeError> {
    Ok(
        backfill(&ctx.github(), &repository.full_name, crate::now_ms())
            .await?
            .iter()
            .map(map_github_pull_request)
            .collect(),
    )
}

pub(crate) async fn get_pull_request(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Option<MirrorFields>, MergeError> {
    Ok(ctx
        .github()
        .get(&format!("/repos/{}/pulls/{number}", repository.full_name))
        .await?
        .as_ref()
        .map(map_github_pull_request))
}

pub(crate) async fn review_decision(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Option<&'static str>, MergeError> {
    let client = ctx.github();
    let Some(pull) = client
        .get(&format!("/repos/{}/pulls/{number}", repository.full_name))
        .await?
    else {
        return Ok(None);
    };
    let reviews = list_pull_request_reviews(&client, &repository.full_name, number).await?;
    Ok(review_decision_from_reviews(
        &reviews,
        map_github_pull_request(&pull).requested_reviewers.len(),
    ))
}

pub(crate) async fn checks_status(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    head_sha: &str,
) -> Result<Option<&'static str>, MergeError> {
    Ok(combine_check_suites(
        &list_check_suites(&ctx.github(), &repository.full_name, head_sha).await?,
    ))
}

// ── Issue payloads ─────────────────────────────────────────────────────────

/// `isGithubPullRequest(issue)`.
pub(crate) fn is_pull_request(issue: &Map<String, Value>) -> bool {
    issue
        .get("pull_request")
        .is_some_and(|value| !value.is_null())
}

fn opt_str(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

/// `new Date(value ?? 0)` as ISO (`None` when invalid).
fn date_of(first: Option<&Value>, second: Option<&Value>) -> Option<String> {
    let first = first.filter(|v| !v.is_null());
    let second = second.filter(|v| !v.is_null());
    match first.or(second) {
        Some(value) => iso_of(Some(value)),
        None => weldsuite_kit::validation::js_iso_from_millis(0.0),
    }
}

/// `normalizeGithubIssue(issue)`.
pub(crate) fn normalize_issue(issue: &Map<String, Value>) -> NormalizedIssue {
    let closed = issue.get("state").and_then(Value::as_str) == Some("closed");
    let labels = issue
        .get("labels")
        .and_then(Value::as_array)
        .map(|labels| {
            labels
                .iter()
                .map(|label| match label {
                    Value::String(name) => name.clone(),
                    other => opt_str(other.get("name")).unwrap_or_default(),
                })
                .filter(|name| !name.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let login_of = |user: Option<&Value>| user.and_then(|u| opt_str(u.get("login")));
    let assignee = login_of(issue.get("assignee")).or_else(|| {
        issue
            .get("assignees")
            .and_then(Value::as_array)
            .and_then(|list| login_of(list.first()))
    });
    let state_reason = closed.then(|| {
        if issue.get("state_reason").and_then(Value::as_str) == Some("not_planned") {
            "not_planned"
        } else {
            "completed"
        }
    });
    NormalizedIssue {
        external_id: js_string(issue.get("id")),
        number: issue
            .get("number")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        url: opt_str(issue.get("html_url")).unwrap_or_default(),
        title: opt_str(issue.get("title")).unwrap_or_default(),
        body: opt_str(issue.get("body")).unwrap_or_default(),
        state: if closed { "closed" } else { "open" },
        state_reason,
        labels,
        assignee_login: assignee,
        author_login: login_of(issue.get("user")),
        author_avatar_url: issue.get("user").and_then(|u| opt_str(u.get("avatar_url"))),
        updated_at: date_of(issue.get("updated_at"), issue.get("created_at")),
    }
}

/// `normalizeGithubComment(comment, issueNumber?)`.
pub(crate) fn normalize_comment(
    comment: &Map<String, Value>,
    issue_number: Option<i64>,
) -> NormalizedIssueComment {
    let from_url = || {
        let url = comment
            .get("issue_url")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let (_, tail) = url.rsplit_once("/issues/")?;
        (!tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()))
            .then(|| tail.parse::<i64>().ok())
            .flatten()
    };
    NormalizedIssueComment {
        external_id: js_string(comment.get("id")),
        issue_number: issue_number.or_else(from_url).unwrap_or_default(),
        body: opt_str(comment.get("body")).unwrap_or_default(),
        author_login: comment.get("user").and_then(|u| opt_str(u.get("login"))),
        author_avatar_url: comment
            .get("user")
            .and_then(|u| opt_str(u.get("avatar_url"))),
        created_at: date_of(comment.get("created_at"), None),
        updated_at: date_of(comment.get("updated_at"), comment.get("created_at")),
    }
}

// ── Issue adapter ──────────────────────────────────────────────────────────

const PAGE: usize = 100;
/// Pages of issues read at most (pull requests share the pages).
const MAX_PAGES: usize = 30;

/// GitHub's own `message` for a refusal.
fn refusal(status: u16, text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|body| {
            body.get("message")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| format!("GitHub answered {status}"))
}

/// `request(ctx, method, path, body?)`: a token minted for the call; a 404
/// on a read is `None`, any other refusal a `ProviderApiError` with GitHub's
/// message.
async fn request(
    ctx: &AdapterContext,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Option<Value>, MergeError> {
    let response = ctx.github().send(method, path, body).await?;
    if response.status == 404 && method == "GET" {
        return Ok(None);
    }
    if !response.ok() {
        return Err(MergeError::provider_api(
            "github",
            response.status,
            refusal(response.status, &response.text()),
        ));
    }
    serde_json::from_slice(&response.body)
        .map(Some)
        .map_err(|error| MergeError::Unexpected(error.to_string()))
}

fn issues_path(repository: &RepositoryRef) -> String {
    format!("/repos/{}/issues", repository.full_name)
}

/// `issueBody(input)`.
fn issue_body(input: &IssueWriteInput) -> Value {
    let mut body = Map::new();
    if let Some(title) = &input.title {
        body.insert("title".to_owned(), json!(title));
    }
    if let Some(text) = &input.body {
        body.insert("body".to_owned(), json!(text));
    }
    if let Some(labels) = &input.labels {
        body.insert("labels".to_owned(), json!(labels));
    }
    if let Some(assignee) = &input.assignee_login {
        body.insert(
            "assignees".to_owned(),
            assignee
                .as_ref()
                .map_or_else(|| json!([]), |login| json!([login])),
        );
    }
    if let Some(state) = input.state {
        body.insert("state".to_owned(), json!(state));
        if state == "closed"
            && let Some(Some(reason)) = input.state_reason
        {
            body.insert("state_reason".to_owned(), json!(reason));
        }
    }
    Value::Object(body)
}

fn as_issue(value: Option<&Value>) -> NormalizedIssue {
    normalize_issue(value.and_then(Value::as_object).unwrap_or(&Map::new()))
}

pub(crate) async fn list_issues(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    options: &ListIssuesOptions,
) -> Result<Vec<NormalizedIssue>, MergeError> {
    let limit = options.limit.unwrap_or(500);
    let mut out: Vec<NormalizedIssue> = Vec::new();
    for page in 1..=MAX_PAGES {
        let state = options.state.unwrap_or("open");
        let path = format!(
            "{}?state={state}&sort=updated&direction=desc&per_page={PAGE}&page={page}",
            issues_path(repository)
        );
        let rows = match request(ctx, "GET", &path, None).await? {
            Some(Value::Array(rows)) => rows,
            _ => Vec::new(),
        };
        for row in &rows {
            let Some(issue) = row.as_object() else {
                continue;
            };
            if !is_pull_request(issue) {
                out.push(normalize_issue(issue));
            }
            if out.len() >= limit {
                break;
            }
        }
        if rows.len() < PAGE || out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

pub(crate) async fn update_issue(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &IssueWriteInput,
) -> Result<NormalizedIssue, MergeError> {
    let body = issue_body(input);
    let row = request(
        ctx,
        "PATCH",
        &format!("{}/{number}", issues_path(repository)),
        Some(&body),
    )
    .await?;
    Ok(as_issue(row.as_ref()))
}

/// GitHub creates issues open: a closed one is closed with a second call.
pub(crate) async fn create_issue(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    input: IssueWriteInput,
) -> Result<NormalizedIssue, MergeError> {
    let open = IssueWriteInput {
        state: None,
        state_reason: None,
        ..input.clone()
    };
    let body = issue_body(&open);
    let row = request(ctx, "POST", &issues_path(repository), Some(&body)).await?;
    let created = as_issue(row.as_ref());
    if input.state == Some("closed") {
        let close = IssueWriteInput {
            state: input.state,
            state_reason: input.state_reason,
            ..IssueWriteInput::default()
        };
        return update_issue(ctx, repository, created.number, &close).await;
    }
    Ok(created)
}

pub(crate) async fn create_comment(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    body: &str,
) -> Result<NormalizedIssueComment, MergeError> {
    let row = request(
        ctx,
        "POST",
        &format!("{}/{number}/comments", issues_path(repository)),
        Some(&json!({ "body": body })),
    )
    .await?;
    Ok(normalize_comment(
        row.as_ref()
            .and_then(Value::as_object)
            .unwrap_or(&Map::new()),
        Some(number),
    ))
}

// ── OAuth (the App's user authorization) ───────────────────────────────────

const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

fn client_of(
    env: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Result<(String, String), MergeError> {
    match (env("GITHUB_APP_CLIENT_ID"), env("GITHUB_APP_CLIENT_SECRET")) {
        (Some(id), Some(secret)) => Ok((id, secret)),
        _ => Err(MergeError::ProviderNotConfigured("github".to_owned())),
    }
}

/// `checked(body)`: GitHub answers a failed code exchange with 200 and an
/// `error` field.
fn checked(body: Option<Value>) -> Result<StoredCredentials, MergeError> {
    let body = body.unwrap_or_else(|| json!({}));
    if let Some(error) = body
        .get("error")
        .and_then(Value::as_str)
        .filter(|e| !e.is_empty())
    {
        let message = body
            .get("error_description")
            .and_then(Value::as_str)
            .unwrap_or(error);
        return Err(MergeError::provider_api("github", 400, message));
    }
    credentials_from_token(&body, "github")
}

pub(crate) fn authorize_url(
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    state: &str,
    redirect_uri: &str,
) -> Result<String, MergeError> {
    let (client_id, _) = client_of(env)?;
    let query = super::http::form_encode(&[
        ("client_id".to_owned(), client_id),
        ("redirect_uri".to_owned(), redirect_uri.to_owned()),
        ("state".to_owned(), state.to_owned()),
    ]);
    Ok(format!("https://github.com/login/oauth/authorize?{query}"))
}

pub(crate) async fn exchange_code(
    http: &OutboundHttp,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    code: &str,
    redirect_uri: &str,
) -> Result<StoredCredentials, MergeError> {
    let (client_id, client_secret) = client_of(env)?;
    checked(
        request_json(
            http,
            "github",
            "POST",
            TOKEN_URL,
            &[],
            Body::Json(json!({
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
            })),
        )
        .await?,
    )
}

pub(crate) async fn refresh(
    http: &OutboundHttp,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    refresh_token: &str,
) -> Result<StoredCredentials, MergeError> {
    let (client_id, client_secret) = client_of(env)?;
    checked(
        request_json(
            http,
            "github",
            "POST",
            TOKEN_URL,
            &[],
            Body::Json(json!({
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            })),
        )
        .await?,
    )
}

pub(crate) async fn current_user(
    http: &OutboundHttp,
    access_token: &str,
) -> Result<OAuthUser, MergeError> {
    let mut headers = bearer(access_token);
    headers.push((
        "Accept".to_owned(),
        "application/vnd.github+json".to_owned(),
    ));
    headers.push(("X-GitHub-Api-Version".to_owned(), "2022-11-28".to_owned()));
    let user = request_json(
        http,
        "github",
        "GET",
        "https://api.github.com/user",
        &headers,
        Body::None,
    )
    .await?
    .ok_or_else(|| MergeError::Unexpected("GitHub answered /user with an empty body".to_owned()))?;
    Ok(OAuthUser {
        external_id: js_string(user.get("id")),
        login: user
            .get("login")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase(),
        display_name: opt_str(user.get("name")),
        avatar_url: opt_str(user.get("avatar_url")),
    })
}
