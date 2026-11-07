//! Bitbucket Cloud behind the provider seam: the pure mappers of
//! `@weldsuite/merge-domain/providers/bitbucket` and merge-api's
//! `services/providers/bitbucket/*` (REST 2.0 client, connection adapter,
//! repository hooks, OAuth). A repository's `externalId` is its uuid,
//! `fullName` is `workspace/slug`, `externalProject` the workspace slug.
//!
//! ```text
//!   GET /repositories?role=admin&pagelen=50                       (follows `next`)
//!   GET /repositories/{workspace}/{uuid}
//!   GET /repositories/{workspace}/{repo}/pullrequests?state=OPEN&pagelen=50
//!   GET /repositories/{workspace}/{repo}/pullrequests?state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on&pagelen=50
//!   GET /repositories/{workspace}/{repo}/pullrequests/{id}
//!   GET /repositories/{workspace}/{repo}/commit/{sha}/statuses?pagelen=50
//!   POST /repositories/{workspace}/{repo}/hooks, DELETE …/hooks/{uuid}
//! ```

use base64::Engine as _;
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::js_date_parse;
use weldsuite_ports::OutboundHttp;

use super::http::{ApiClient, Body, bearer, credentials_from_token, request_json};
use super::shared::{
    constant_time_equal, header, hmac_sha256_hex, id_string, lower_login, obj, parse_provider_date,
    str_of,
};
use super::{
    AdapterContext, OAuthUser, RemoteRepository, RepositoryRef, WebhookEvent, WebhookTarget,
};
use crate::MergeError;
use crate::credentials::StoredCredentials;
use crate::github::MirrorFields;
use crate::github_client::encode_uri_component as encode;

const API: &str = "https://api.bitbucket.org/2.0";
const PAGE: usize = 50;
const PAGES: usize = 6;
const BACKFILL_DAYS: f64 = 30.0;
const BACKFILL_CAP: usize = 300;

fn client(ctx: &AdapterContext) -> ApiClient<'_> {
    ApiClient {
        ctx,
        provider: "bitbucket",
        base: API.to_owned(),
    }
}

fn repo_path(repository: &RepositoryRef) -> String {
    format!("/repositories/{}", repository.full_name)
}

/// `walkPages(client, firstPath, maxPages, cap, stop?)`: the first path,
/// then each page's `next`; `stop` ends the walk early.
async fn walk_pages(
    api: &ApiClient<'_>,
    first_path: &str,
    max_pages: usize,
    cap: usize,
    stop: Option<&(dyn Fn(&Value) -> bool + Sync)>,
) -> Result<Vec<Value>, MergeError> {
    let mut out: Vec<Value> = Vec::new();
    let mut next = Some(first_path.to_owned());
    let mut page = 0;
    while let Some(path) = next.take() {
        if page >= max_pages || out.len() >= cap {
            break;
        }
        let body = api.get(&path).await?;
        for row in body
            .as_ref()
            .and_then(|b| b.get("values"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            if stop.is_some_and(|stop| stop(&row)) {
                return Ok(out);
            }
            out.push(row);
            if out.len() >= cap {
                return Ok(out);
            }
        }
        next = body
            .as_ref()
            .and_then(|b| b.get("next"))
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty())
            .map(str::to_owned);
        page += 1;
    }
    Ok(out)
}

// ── Mappers ────────────────────────────────────────────────────────────────

/// `bitbucketLogin(user)`: the handle stored as the login.
pub(crate) fn login_of(user: Option<&Value>) -> Option<String> {
    let user = user?;
    lower_login(user.get("nickname"))
        .or_else(|| lower_login(user.get("username")))
        .or_else(|| lower_login(user.get("account_id")))
}

fn avatar_of(user: Option<&Value>) -> Value {
    user.and_then(|u| u.get("links"))
        .and_then(|l| l.get("avatar"))
        .and_then(|a| a.get("href"))
        .cloned()
        .filter(|v| !v.is_null())
        .unwrap_or(Value::Null)
}

fn pr_state(state: &str) -> &'static str {
    match state {
        "MERGED" => "merged",
        "OPEN" => "open",
        _ => "closed",
    }
}

/// `pendingReviewers(pr)`: reviewers who have not voted yet.
fn pending_reviewers(pr: &Value) -> Vec<Value> {
    let voted: Vec<String> = pr
        .get("participants")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|p| {
                    p.get("approved") == Some(&Value::Bool(true))
                        || matches!(
                            p.get("state").and_then(Value::as_str),
                            Some("approved" | "changes_requested")
                        )
                })
                .filter_map(|p| login_of(p.get("user")))
                .collect()
        })
        .unwrap_or_default();
    pr.get("reviewers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|user| {
                    let login = login_of(Some(user))?;
                    (!voted.contains(&login)).then(|| {
                        json!({ "kind": "user", "login": login, "avatarUrl": avatar_of(Some(user)) })
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `mapBitbucketPullRequest(pr)`.
pub(crate) fn map_pull_request(pr: &Value) -> MirrorFields {
    let state = pr_state(pr.get("state").and_then(Value::as_str).unwrap_or_default());
    let updated = parse_provider_date(pr.get("updated_on"));
    let nested = |path: &[&str]| -> Value {
        let mut value = Some(pr);
        for key in path {
            value = value.and_then(|v| v.get(*key));
        }
        value
            .cloned()
            .filter(|v| !v.is_null())
            .unwrap_or(Value::Null)
    };
    let url = match nested(&["links", "html", "href"]) {
        Value::Null => json!(""),
        other => other,
    };
    MirrorFields {
        external_id: crate::github::js_string(pr.get("id")),
        number: pr.get("id").cloned().unwrap_or(Value::Null),
        title: pr.get("title").cloned().unwrap_or(Value::Null),
        body: str_of(pr.get("description")).map_or(Value::Null, |d| json!(d)),
        state,
        draft: pr.get("draft") == Some(&Value::Bool(true)),
        url,
        author_login: login_of(pr.get("author")),
        author_avatar_url: avatar_of(pr.get("author")),
        head_ref: nested(&["source", "branch", "name"]),
        base_ref: nested(&["destination", "branch", "name"]),
        head_sha: nested(&["source", "commit", "hash"]),
        additions: Value::Null,
        deletions: Value::Null,
        changed_files: Value::Null,
        requested_reviewers: pending_reviewers(pr),
        labels: Vec::new(),
        provider_created_at: Some(parse_provider_date(pr.get("created_on"))),
        provider_updated_at: Some(updated.clone()),
        merged_at: (state == "merged").then(|| updated.clone()),
        closed_at: (state != "open").then_some(updated),
    }
}

/// `bitbucketReviewDecision(pr)`.
fn review_decision_of(pr: &Value) -> Option<&'static str> {
    let reviewers: Vec<&Value> = pr
        .get("participants")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|p| p.get("role").and_then(Value::as_str) == Some("REVIEWER"))
                .collect()
        })
        .unwrap_or_default();
    if reviewers
        .iter()
        .any(|p| p.get("state").and_then(Value::as_str) == Some("changes_requested"))
    {
        return Some("changes_requested");
    }
    if reviewers.iter().any(|p| {
        p.get("approved") == Some(&Value::Bool(true))
            || p.get("state").and_then(Value::as_str) == Some("approved")
    }) {
        return Some("approved");
    }
    (!pending_reviewers(pr).is_empty()).then_some("review_required")
}

/// `bitbucketChecksStatus(statuses)`.
fn checks_status_of(statuses: &[Value]) -> Option<&'static str> {
    if statuses.is_empty() {
        return None;
    }
    let states: Vec<&str> = statuses
        .iter()
        .map(|s| s.get("state").and_then(Value::as_str).unwrap_or_default())
        .collect();
    if states.contains(&"FAILED") {
        return Some("failure");
    }
    if states.contains(&"INPROGRESS") {
        return Some("pending");
    }
    Some(if states.contains(&"SUCCESSFUL") {
        "success"
    } else {
        "neutral"
    })
}

// ── Webhooks: verification and parsing ─────────────────────────────────────

/// `verifyBitbucketSignature(headers, rawBody, secret)`: `X-Hub-Signature:
/// sha256=<hex HMAC of the raw body>`.
pub(crate) fn verify_signature(headers: &Map<String, Value>, raw_body: &str, secret: &str) -> bool {
    let Some(value) = header(headers, "x-hub-signature").filter(|v| !v.is_empty()) else {
        return false;
    };
    if secret.is_empty() {
        return false;
    }
    let expected = format!("sha256={}", hmac_sha256_hex(secret, raw_body));
    constant_time_equal(&value.trim().to_lowercase(), &expected)
}

const REVIEW_EVENTS: [&str; 4] = [
    "pullrequest:approved",
    "pullrequest:unapproved",
    "pullrequest:changes_request_created",
    "pullrequest:changes_request_removed",
];

/// `parseBitbucketWebhook(headers, body)`: `X-Event-Key` names the event.
pub(crate) fn parse_webhook(headers: &Map<String, Value>, body: &Value) -> Vec<WebhookEvent> {
    let (Some(payload), Some(event_key)) = (
        body.as_object(),
        header(headers, "x-event-key").filter(|k| !k.is_empty()),
    ) else {
        return Vec::new();
    };
    let Some(repository) = id_string(obj(payload.get("repository")).and_then(|r| r.get("uuid")))
    else {
        return Vec::new();
    };
    if event_key.starts_with("pullrequest:") {
        if event_key.ends_with(":comment_created")
            || event_key.ends_with(":comment_updated")
            || event_key.ends_with(":comment_deleted")
        {
            return Vec::new();
        }
        let Some(raw) = obj(payload.get("pullrequest")) else {
            return Vec::new();
        };
        let pull_request = map_pull_request(&Value::Object(raw.clone()));
        let number = pull_request.number.as_i64().unwrap_or_default();
        let mut events = vec![WebhookEvent::PullRequest {
            repository: repository.clone(),
            pull_request: Box::new(pull_request),
        }];
        if REVIEW_EVENTS.contains(&event_key) {
            // The hook's participant list is not always complete: re-read the decision.
            events.push(WebhookEvent::Review {
                repository,
                number,
                decision: None,
            });
        }
        return events;
    }
    if event_key == "repo:commit_status_created" || event_key == "repo:commit_status_updated" {
        let status = obj(payload.get("commit_status"));
        let Some(sha) =
            str_of(obj(status.and_then(|s| s.get("commit"))).and_then(|c| c.get("hash")))
        else {
            return Vec::new();
        };
        // One build's state is not the commit's status: re-read all of them.
        return vec![WebhookEvent::Checks {
            repository,
            head_sha: sha,
            status: None,
            numbers: Vec::new(),
        }];
    }
    Vec::new()
}

// ── Connection adapter ─────────────────────────────────────────────────────

fn remote_repository(repo: &Value) -> RemoteRepository {
    let full_name = repo
        .get("full_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    RemoteRepository {
        external_id: repo
            .get("uuid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        full_name: json!(full_name),
        private: json!(repo.get("is_private") != Some(&Value::Bool(false))),
        default_branch: repo
            .get("mainbranch")
            .and_then(|b| b.get("name"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        url: repo
            .get("links")
            .and_then(|l| l.get("html"))
            .and_then(|h| h.get("href"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        external_project: repo
            .get("workspace")
            .and_then(|w| w.get("slug"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| full_name.split('/').next().map(str::to_owned)),
    }
}

pub(crate) async fn list_available_repositories(
    ctx: &AdapterContext,
) -> Result<Vec<RemoteRepository>, MergeError> {
    let repos = walk_pages(
        &client(ctx),
        &format!("/repositories?role=admin&pagelen={PAGE}"),
        PAGES,
        PAGE * PAGES,
        None,
    )
    .await?;
    Ok(repos.iter().map(remote_repository).collect())
}

pub(crate) async fn get_repository(
    ctx: &AdapterContext,
    external_id: &str,
    external_project: Option<&str>,
) -> Result<Option<RemoteRepository>, MergeError> {
    let Some(project) = external_project.filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    Ok(client(ctx)
        .get(&format!(
            "/repositories/{}/{}",
            encode(project),
            encode(external_id)
        ))
        .await?
        .as_ref()
        .map(remote_repository))
}

pub(crate) async fn list_pull_requests_for_backfill(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
) -> Result<Vec<MirrorFields>, MergeError> {
    let api = client(ctx);
    let since = crate::now_ms() - BACKFILL_DAYS * 24.0 * 60.0 * 60.0 * 1000.0;
    let open = walk_pages(
        &api,
        &format!(
            "{}/pullrequests?state=OPEN&pagelen={PAGE}",
            repo_path(repository)
        ),
        PAGES,
        BACKFILL_CAP,
        None,
    )
    .await?;
    let older = |pr: &Value| {
        // `new Date(pr.updated_on).getTime() < since`: NaN compares false.
        pr.get("updated_on")
            .and_then(Value::as_str)
            .and_then(js_date_parse)
            .is_some_and(|ms| ms < since)
    };
    let closed = walk_pages(
        &api,
        &format!(
            "{}/pullrequests?state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on&pagelen={PAGE}",
            repo_path(repository)
        ),
        PAGES,
        BACKFILL_CAP - open.len(),
        Some(&older),
    )
    .await?;
    Ok(open.iter().chain(&closed).map(map_pull_request).collect())
}

pub(crate) async fn get_pull_request(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Option<MirrorFields>, MergeError> {
    Ok(client(ctx)
        .get(&format!("{}/pullrequests/{number}", repo_path(repository)))
        .await?
        .as_ref()
        .map(map_pull_request))
}

pub(crate) async fn review_decision(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Option<&'static str>, MergeError> {
    Ok(client(ctx)
        .get(&format!("{}/pullrequests/{number}", repo_path(repository)))
        .await?
        .as_ref()
        .and_then(review_decision_of))
}

pub(crate) async fn checks_status(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    head_sha: &str,
) -> Result<Option<&'static str>, MergeError> {
    let statuses = walk_pages(
        &client(ctx),
        &format!(
            "{}/commit/{}/statuses?pagelen={PAGE}",
            repo_path(repository),
            encode(head_sha)
        ),
        PAGES,
        PAGE * PAGES,
        None,
    )
    .await?;
    Ok(checks_status_of(&statuses))
}

// ── Repository hooks ───────────────────────────────────────────────────────

/// `BITBUCKET_HOOK_EVENTS`.
const HOOK_EVENTS: [&str; 10] = [
    "pullrequest:created",
    "pullrequest:updated",
    "pullrequest:approved",
    "pullrequest:unapproved",
    "pullrequest:changes_request_created",
    "pullrequest:changes_request_removed",
    "pullrequest:fulfilled",
    "pullrequest:rejected",
    "repo:commit_status_created",
    "repo:commit_status_updated",
];

pub(crate) async fn register_webhook(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    target: &WebhookTarget,
) -> Result<String, MergeError> {
    let hook = client(ctx)
        .send(
            "POST",
            &format!("{}/hooks", repo_path(repository)),
            Some(json!({
                "description": "WeldMerge",
                "url": target.url,
                "active": true,
                "secret": target.secret,
                "events": HOOK_EVENTS,
            })),
        )
        .await?;
    Ok(crate::github::js_string(
        hook.as_ref().and_then(|h| h.get("uuid")),
    ))
}

pub(crate) async fn delete_webhook(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    webhook_id: &str,
) -> Result<(), MergeError> {
    match client(ctx)
        .send(
            "DELETE",
            &format!("{}/hooks/{}", repo_path(repository), encode(webhook_id)),
            None,
        )
        .await
    {
        Err(error) if error.is_status(&[404]) => Ok(()),
        other => other.map(|_| ()),
    }
}

// ── OAuth ──────────────────────────────────────────────────────────────────

const TOKEN_URL: &str = "https://bitbucket.org/site/oauth2/access_token";

fn client_of(
    env: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Result<(String, String), MergeError> {
    match (
        env("BITBUCKET_OAUTH_CLIENT_ID"),
        env("BITBUCKET_OAUTH_CLIENT_SECRET"),
    ) {
        (Some(id), Some(secret)) => Ok((id, secret)),
        _ => Err(MergeError::ProviderNotConfigured("bitbucket".to_owned())),
    }
}

fn basic(client_id: &str, client_secret: &str) -> Vec<(String, String)> {
    let pair =
        base64::engine::general_purpose::STANDARD.encode(format!("{client_id}:{client_secret}"));
    vec![("Authorization".to_owned(), format!("Basic {pair}"))]
}

pub(crate) fn authorize_url(
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    state: &str,
    redirect_uri: &str,
) -> Result<String, MergeError> {
    let (client_id, _) = client_of(env)?;
    let query = super::http::form_encode(&[
        ("client_id".to_owned(), client_id),
        ("response_type".to_owned(), "code".to_owned()),
        ("state".to_owned(), state.to_owned()),
        ("redirect_uri".to_owned(), redirect_uri.to_owned()),
    ]);
    Ok(format!(
        "https://bitbucket.org/site/oauth2/authorize?{query}"
    ))
}

pub(crate) async fn exchange_code(
    http: &OutboundHttp,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    code: &str,
    redirect_uri: &str,
) -> Result<StoredCredentials, MergeError> {
    let (client_id, client_secret) = client_of(env)?;
    let body = request_json(
        http,
        "bitbucket",
        "POST",
        TOKEN_URL,
        &basic(&client_id, &client_secret),
        Body::Form(vec![
            ("grant_type".to_owned(), "authorization_code".to_owned()),
            ("code".to_owned(), code.to_owned()),
            ("redirect_uri".to_owned(), redirect_uri.to_owned()),
        ]),
    )
    .await?;
    credentials_from_token(&body.unwrap_or_else(|| json!({})), "bitbucket")
}

pub(crate) async fn refresh(
    http: &OutboundHttp,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    refresh_token: &str,
) -> Result<StoredCredentials, MergeError> {
    let (client_id, client_secret) = client_of(env)?;
    let body = request_json(
        http,
        "bitbucket",
        "POST",
        TOKEN_URL,
        &basic(&client_id, &client_secret),
        Body::Form(vec![
            ("grant_type".to_owned(), "refresh_token".to_owned()),
            ("refresh_token".to_owned(), refresh_token.to_owned()),
        ]),
    )
    .await?;
    credentials_from_token(&body.unwrap_or_else(|| json!({})), "bitbucket")
}

pub(crate) async fn current_user(
    http: &OutboundHttp,
    access_token: &str,
) -> Result<OAuthUser, MergeError> {
    let user = request_json(
        http,
        "bitbucket",
        "GET",
        &format!("{API}/user"),
        &bearer(access_token),
        Body::None,
    )
    .await?
    .ok_or_else(|| {
        MergeError::Unexpected("Bitbucket answered /user with an empty body".to_owned())
    })?;
    let text = |key: &str| user.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(OAuthUser {
        external_id: text("uuid")
            .or_else(|| text("account_id"))
            .unwrap_or_default(),
        login: login_of(Some(&user)).unwrap_or_default(),
        display_name: text("display_name"),
        avatar_url: avatar_of(Some(&user)).as_str().map(str::to_owned),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_the_hub_signature() {
        let body = r#"{"a":1}"#;
        let signature = format!("sha256={}", hmac_sha256_hex("s3cret", body));
        let headers = json!({ "X-Hub-Signature": signature });
        let headers = headers.as_object().expect("an object");
        assert!(verify_signature(headers, body, "s3cret"));
        assert!(!verify_signature(headers, body, "other"));
        assert!(!verify_signature(&Map::new(), body, "s3cret"));
    }

    #[test]
    fn leaves_voted_reviewers_out() {
        let pr = json!({
            "reviewers": [{ "nickname": "Ann" }, { "nickname": "Bob" }],
            "participants": [{ "user": { "nickname": "Ann" }, "role": "REVIEWER", "approved": true }],
        });
        assert_eq!(
            pending_reviewers(&pr),
            vec![json!({ "kind": "user", "login": "bob", "avatarUrl": null })]
        );
        assert_eq!(review_decision_of(&pr), Some("approved"));
    }
}
