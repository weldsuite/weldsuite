//! GitLab (gitlab.com and self-managed) behind the provider seam: the pure
//! mappers of `@weldsuite/merge-domain/providers/gitlab` and merge-api's
//! `services/providers/gitlab/*` (REST v4 client, connection adapter, project
//! hooks, OAuth, issues).
//!
//! Endpoints (relative to `{host}/api/v4`, `:id` the project id):
//!
//! ```text
//!   GET  /projects?membership=true&min_access_level=40&order_by=last_activity_at&per_page=100&page=N
//!   GET  /projects/:id
//!   GET  /projects/:id/merge_requests?state=opened|merged|closed[&updated_after=ISO]&order_by=updated_at&sort=desc&per_page=100&page=N
//!   GET  /projects/:id/merge_requests/:iid, …/approvals
//!   GET  /projects/:id/pipelines?sha=:sha&order_by=id&sort=desc&per_page=1
//!   POST /projects/:id/hooks, DELETE /projects/:id/hooks/:hookId
//!   GET|POST|PUT /projects/:id/issues…, GET /users?username=, POST …/notes
//! ```

use std::collections::HashSet;

use serde_json::{Map, Value, json};
use weldsuite_ports::OutboundHttp;

use super::http::{ApiClient, Body, bearer, collect_pages, credentials_from_token, request_json};
use super::shared::{
    arr, constant_time_equal, header, id_string, lower_login, nullable_date, number_of, obj,
    parse_provider_date, str_of, trim_trailing_slashes,
};
use super::{
    AdapterContext, IssueWriteInput, ListIssuesOptions, NormalizedIssue, NormalizedIssueComment,
    OAuthUser, RemoteRepository, RepositoryRef, WebhookEvent, WebhookTarget,
};
use crate::MergeError;
use crate::credentials::StoredCredentials;
use crate::github::MirrorFields;
use crate::github_client::encode_uri_component as encode;

pub(crate) const GITLAB_COM: &str = "https://gitlab.com";
const PAGE: usize = 100;
const PAGES: usize = 5;
const BACKFILL_DAYS: f64 = 30.0;
const BACKFILL_CAP: usize = 300;

/// `gitlabBase(host)`: the base URL of a host; none or empty is gitlab.com.
pub(crate) fn base(host: Option<&str>) -> String {
    let host = host
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .unwrap_or(GITLAB_COM);
    trim_trailing_slashes(host).to_owned()
}

fn client(ctx: &AdapterContext) -> ApiClient<'_> {
    ApiClient {
        ctx,
        provider: "gitlab",
        base: format!("{}/api/v4", base(ctx.host().as_deref())),
    }
}

fn project_path(repository: &RepositoryRef) -> String {
    format!("/projects/{}", encode(&repository.external_id))
}

// ── Mappers ────────────────────────────────────────────────────────────────

fn merge_request_state(state: &str) -> &'static str {
    match state {
        "merged" => "merged",
        "closed" => "closed",
        _ => "open",
    }
}

/// `labelsOf(labels)`.
fn labels_of(labels: Option<&Value>) -> Vec<Value> {
    arr(labels)
        .iter()
        .filter_map(|label| match label {
            Value::String(name) => Some(json!({ "name": name, "color": null })),
            Value::Object(fields) => {
                let name = fields
                    .get("title")
                    .filter(|v| !v.is_null())
                    .or_else(|| fields.get("name"))
                    .and_then(Value::as_str)
                    .filter(|n| !n.is_empty())?;
                Some(json!({
                    "name": name,
                    "color": fields.get("color").cloned().filter(|c| !c.is_null()).unwrap_or(Value::Null),
                }))
            }
            _ => None,
        })
        .collect()
}

/// `reviewersOf(users)`.
fn reviewers_of(users: Option<&Value>) -> Vec<Value> {
    arr(users)
        .iter()
        .filter_map(|user| {
            let login = lower_login(user.get("username"))?;
            Some(json!({
                "kind": "user",
                "login": login,
                "avatarUrl": user.get("avatar_url").cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null),
            }))
        })
        .collect()
}

fn or_null(value: Option<&Value>) -> Value {
    value
        .cloned()
        .filter(|v| !v.is_null())
        .unwrap_or(Value::Null)
}

/// `mapGitlabMergeRequest(mr)`: a merge request from the REST API.
pub(crate) fn map_merge_request(mr: &Value) -> MirrorFields {
    let state = merge_request_state(mr.get("state").and_then(Value::as_str).unwrap_or_default());
    let changes = match mr.get("changes_count") {
        None | Some(Value::Null) => None,
        Some(value) => number_of(Some(value)),
    };
    let updated = parse_provider_date(mr.get("updated_at"));
    let head_sha = mr
        .get("diff_refs")
        .and_then(|refs| refs.get("head_sha"))
        .filter(|v| !v.is_null())
        .or_else(|| mr.get("sha"))
        .cloned()
        .filter(|v| !v.is_null())
        .unwrap_or(Value::Null);
    let author = mr.get("author");
    MirrorFields {
        external_id: crate::github::js_string(mr.get("id")),
        number: or_null(mr.get("iid")),
        title: or_null(mr.get("title")),
        body: or_null(mr.get("description")),
        state,
        draft: mr.get("draft") == Some(&Value::Bool(true))
            || mr.get("work_in_progress") == Some(&Value::Bool(true)),
        url: or_null(mr.get("web_url")),
        author_login: lower_login(author.and_then(|a| a.get("username"))),
        author_avatar_url: or_null(author.and_then(|a| a.get("avatar_url"))),
        head_ref: or_null(mr.get("source_branch")),
        base_ref: or_null(mr.get("target_branch")),
        head_sha,
        additions: Value::Null,
        deletions: Value::Null,
        changed_files: changes.map_or(Value::Null, |n| json!(n)),
        requested_reviewers: reviewers_of(mr.get("reviewers")),
        labels: labels_of(mr.get("labels")),
        provider_created_at: Some(parse_provider_date(mr.get("created_at"))),
        provider_updated_at: Some(updated.clone()),
        merged_at: (state == "merged")
            .then(|| nullable_date(mr.get("merged_at")).unwrap_or_else(|| updated.clone())),
        closed_at: (state != "open")
            .then(|| nullable_date(mr.get("closed_at")).unwrap_or_else(|| updated.clone())),
    }
}

/// `gitlabReviewDecision({ approvals, blockingDiscussionsResolved, requestedReviewerCount })`.
fn review_decision_of(
    approvals: Option<&Value>,
    blocking_discussions_resolved: Option<&Value>,
    requested_reviewer_count: usize,
) -> Option<&'static str> {
    let approved_by = approvals
        .and_then(|a| a.get("approved_by"))
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let left = approvals
        .and_then(|a| a.get("approvals_left"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let approved = approvals.and_then(|a| a.get("approved")) == Some(&Value::Bool(true))
        || (approved_by > 0 && left == 0.0);
    if approved {
        return Some("approved");
    }
    if blocking_discussions_resolved == Some(&Value::Bool(false)) {
        return Some("changes_requested");
    }
    (requested_reviewer_count > 0).then_some("review_required")
}

/// `gitlabPipelineStatus(status)`.
fn pipeline_status(status: Option<&Value>) -> Option<&'static str> {
    match status.and_then(Value::as_str)? {
        "success" => Some("success"),
        "failed" => Some("failure"),
        "canceled" | "canceling" | "skipped" | "manual" => Some("neutral"),
        "created"
        | "pending"
        | "running"
        | "preparing"
        | "waiting_for_resource"
        | "scheduled"
        | "waiting_for_callback" => Some("pending"),
        _ => None,
    }
}

/// `mapGitlabIssue(issue)`.
pub(crate) fn map_issue(issue: &Value) -> NormalizedIssue {
    let assignee = issue
        .get("assignees")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .or_else(|| issue.get("assignee").filter(|a| !a.is_null()));
    let author = issue.get("author");
    NormalizedIssue {
        external_id: crate::github::js_string(issue.get("id")),
        number: issue.get("iid").and_then(Value::as_i64).unwrap_or_default(),
        url: issue
            .get("web_url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        title: issue
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        body: issue
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        state: if issue.get("state").and_then(Value::as_str) == Some("closed") {
            "closed"
        } else {
            "open"
        },
        state_reason: None,
        labels: issue
            .get("labels")
            .and_then(Value::as_array)
            .map(|labels| {
                labels
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        assignee_login: lower_login(assignee.and_then(|a| a.get("username"))),
        author_login: lower_login(author.and_then(|a| a.get("username"))),
        author_avatar_url: author
            .and_then(|a| a.get("avatar_url"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        updated_at: Some(parse_provider_date(issue.get("updated_at"))),
    }
}

/// `mapGitlabNote(note, issueNumber)`.
pub(crate) fn map_note(note: &Value, issue_number: i64) -> NormalizedIssueComment {
    let author = note.get("author");
    let updated = note
        .get("updated_at")
        .filter(|v| !v.is_null())
        .or_else(|| note.get("created_at"));
    NormalizedIssueComment {
        external_id: crate::github::js_string(note.get("id")),
        issue_number,
        body: note
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        author_login: lower_login(author.and_then(|a| a.get("username"))),
        author_avatar_url: author
            .and_then(|a| a.get("avatar_url"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        created_at: Some(parse_provider_date(note.get("created_at"))),
        updated_at: Some(parse_provider_date(updated)),
    }
}

// ── Webhooks: verification and parsing ─────────────────────────────────────

/// `verifyGitlabToken(headers, secret)`: `X-Gitlab-Token` is the secret.
pub(crate) fn verify_token(headers: &Map<String, Value>, secret: &str) -> bool {
    header(headers, "x-gitlab-token")
        .is_some_and(|token| !secret.is_empty() && constant_time_equal(token, secret))
}

/// `mapGitlabMergeRequestHook(payload)`.
fn map_merge_request_hook(payload: &Map<String, Value>) -> Option<MirrorFields> {
    let attrs = obj(payload.get("object_attributes"))?;
    let id = id_string(attrs.get("id"))?;
    let iid = number_of(attrs.get("iid"))?;
    let url = str_of(attrs.get("url"))?;
    let state = merge_request_state(
        attrs
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("opened"),
    );
    let updated = parse_provider_date(attrs.get("updated_at"));
    let actor = obj(payload.get("user"));
    let opened = attrs.get("action").and_then(Value::as_str) == Some("open");
    let last_commit = obj(attrs.get("last_commit"));
    Some(MirrorFields {
        external_id: id,
        number: json!(iid),
        title: json!(str_of(attrs.get("title")).unwrap_or_default()),
        body: str_of(attrs.get("description")).map_or(Value::Null, |d| json!(d)),
        state,
        draft: attrs.get("draft") == Some(&Value::Bool(true))
            || attrs.get("work_in_progress") == Some(&Value::Bool(true)),
        url: json!(url),
        author_login: opened
            .then(|| lower_login(actor.and_then(|a| a.get("username"))))
            .flatten(),
        author_avatar_url: if opened {
            str_of(actor.and_then(|a| a.get("avatar_url"))).map_or(Value::Null, |a| json!(a))
        } else {
            Value::Null
        },
        head_ref: str_of(attrs.get("source_branch")).map_or(Value::Null, |r| json!(r)),
        base_ref: str_of(attrs.get("target_branch")).map_or(Value::Null, |r| json!(r)),
        head_sha: str_of(last_commit.and_then(|c| c.get("id"))).map_or(Value::Null, |s| json!(s)),
        additions: Value::Null,
        deletions: Value::Null,
        changed_files: Value::Null,
        requested_reviewers: reviewers_of(payload.get("reviewers")),
        labels: labels_of(payload.get("labels")),
        provider_created_at: Some(parse_provider_date(attrs.get("created_at"))),
        provider_updated_at: Some(updated.clone()),
        merged_at: (state == "merged")
            .then(|| nullable_date(attrs.get("merged_at")).unwrap_or_else(|| updated.clone())),
        closed_at: (state != "open")
            .then(|| nullable_date(attrs.get("closed_at")).unwrap_or_else(|| updated.clone())),
    })
}

fn merge_request_events(payload: &Map<String, Value>, repository: &str) -> Vec<WebhookEvent> {
    let Some(pull_request) = map_merge_request_hook(payload) else {
        return Vec::new();
    };
    let raw = str_of(obj(payload.get("object_attributes")).and_then(|a| a.get("action")))
        .unwrap_or_else(|| "update".to_owned());
    let number = pull_request.number.as_i64().unwrap_or_default();
    let mut events = vec![WebhookEvent::PullRequest {
        repository: repository.to_owned(),
        pull_request: Box::new(pull_request),
    }];
    if matches!(
        raw.as_str(),
        "approved" | "unapproved" | "approval" | "unapproval"
    ) {
        // The hook does not carry the approvals: the receiver re-reads them.
        events.push(WebhookEvent::Review {
            repository: repository.to_owned(),
            number,
            decision: None,
        });
    }
    events
}

fn pipeline_events(payload: &Map<String, Value>, repository: &str) -> Vec<WebhookEvent> {
    let attrs = obj(payload.get("object_attributes"));
    let Some(sha) = str_of(attrs.and_then(|a| a.get("sha"))) else {
        return Vec::new();
    };
    let iid = number_of(obj(payload.get("merge_request")).and_then(|mr| mr.get("iid")));
    vec![WebhookEvent::Checks {
        repository: repository.to_owned(),
        head_sha: sha,
        status: pipeline_status(attrs.and_then(|a| a.get("status"))),
        numbers: iid.into_iter().collect(),
    }]
}

fn issue_action(raw: &str) -> String {
    match raw {
        "open" => "opened",
        "close" => "closed",
        "reopen" => "reopened",
        "update" => "edited",
        other => other,
    }
    .to_owned()
}

fn issue_events(payload: &Map<String, Value>, repository: &str) -> Vec<WebhookEvent> {
    let Some(attrs) = obj(payload.get("object_attributes")) else {
        return Vec::new();
    };
    let (Some(id), Some(iid), Some(url)) = (
        id_string(attrs.get("id")),
        number_of(attrs.get("iid")),
        str_of(attrs.get("url")),
    ) else {
        return Vec::new();
    };
    let raw = str_of(attrs.get("action")).unwrap_or_else(|| "update".to_owned());
    let actor = obj(payload.get("user"));
    let opened = raw == "open";
    let assignee = arr(payload.get("assignees")).into_iter().next();
    let labels = arr(payload.get("labels"))
        .iter()
        .filter_map(|label| str_of(label.get("title")))
        .collect();
    vec![WebhookEvent::Issue {
        repository: repository.to_owned(),
        action: issue_action(&raw),
        issue: NormalizedIssue {
            external_id: id,
            number: iid,
            url,
            title: str_of(attrs.get("title")).unwrap_or_default(),
            body: str_of(attrs.get("description")).unwrap_or_default(),
            state: if attrs.get("state").and_then(Value::as_str) == Some("closed") {
                "closed"
            } else {
                "open"
            },
            state_reason: None,
            labels,
            assignee_login: lower_login(assignee.as_ref().and_then(|a| a.get("username"))),
            author_login: opened
                .then(|| lower_login(actor.and_then(|a| a.get("username"))))
                .flatten(),
            author_avatar_url: opened
                .then(|| str_of(actor.and_then(|a| a.get("avatar_url"))))
                .flatten(),
            updated_at: Some(parse_provider_date(attrs.get("updated_at"))),
        },
    }]
}

fn note_events(payload: &Map<String, Value>, repository: &str) -> Vec<WebhookEvent> {
    let Some(attrs) = obj(payload.get("object_attributes")) else {
        return Vec::new();
    };
    if attrs.get("noteable_type").and_then(Value::as_str) != Some("Issue")
        || attrs.get("system") == Some(&Value::Bool(true))
    {
        return Vec::new();
    }
    let (Some(id), Some(issue_number)) = (
        id_string(attrs.get("id")),
        number_of(obj(payload.get("issue")).and_then(|i| i.get("iid"))),
    ) else {
        return Vec::new();
    };
    let actor = obj(payload.get("user"));
    let created = attrs.get("created_at");
    let updated = attrs.get("updated_at").filter(|v| !v.is_null()).or(created);
    vec![WebhookEvent::IssueComment {
        repository: repository.to_owned(),
        action: if attrs.get("action").and_then(Value::as_str) == Some("update") {
            "edited"
        } else {
            "created"
        },
        comment: NormalizedIssueComment {
            external_id: id,
            issue_number,
            body: str_of(attrs.get("note")).unwrap_or_default(),
            author_login: lower_login(actor.and_then(|a| a.get("username"))),
            author_avatar_url: str_of(actor.and_then(|a| a.get("avatar_url"))),
            created_at: Some(parse_provider_date(created)),
            updated_at: Some(parse_provider_date(updated)),
        },
    }]
}

/// `parseGitlabWebhook(headers, body)`.
pub(crate) fn parse_webhook(headers: &Map<String, Value>, body: &Value) -> Vec<WebhookEvent> {
    let Some(payload) = body.as_object() else {
        return Vec::new();
    };
    let kind = str_of(payload.get("object_kind")).or_else(|| {
        header(headers, "x-gitlab-event")
            .filter(|k| !k.is_empty())
            .map(str::to_owned)
    });
    let project = id_string(obj(payload.get("project")).and_then(|p| p.get("id")))
        .or_else(|| id_string(payload.get("project_id")));
    let Some(project) = project else {
        return Vec::new();
    };
    match kind.as_deref() {
        Some("merge_request") => merge_request_events(payload, &project),
        Some("pipeline") => pipeline_events(payload, &project),
        Some("issue") => issue_events(payload, &project),
        Some("note") => note_events(payload, &project),
        _ => Vec::new(),
    }
}

// ── Connection adapter ─────────────────────────────────────────────────────

fn remote_repository(project: &Value) -> RemoteRepository {
    RemoteRepository {
        external_id: crate::github::js_string(project.get("id")),
        full_name: project
            .get("path_with_namespace")
            .cloned()
            .unwrap_or(Value::Null),
        private: json!(project.get("visibility").and_then(Value::as_str) != Some("public")),
        default_branch: project
            .get("default_branch")
            .and_then(Value::as_str)
            .map(str::to_owned),
        url: project
            .get("web_url")
            .and_then(Value::as_str)
            .map(str::to_owned),
        external_project: project
            .get("namespace")
            .and_then(|n| n.get("full_path"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

pub(crate) async fn list_available_repositories(
    ctx: &AdapterContext,
) -> Result<Vec<RemoteRepository>, MergeError> {
    let api = client(ctx);
    let projects = collect_pages(
        |page| {
            let api = &api;
            async move {
                let rows = api
                    .get_list(&format!(
                        "/projects?membership=true&min_access_level=40&order_by=last_activity_at&per_page={PAGE}&page={page}"
                    ))
                    .await?;
                let more = rows.len() == PAGE;
                Ok((rows, more))
            }
        },
        PAGES,
        PAGE * PAGES,
    )
    .await?;
    Ok(projects.iter().map(remote_repository).collect())
}

pub(crate) async fn get_repository(
    ctx: &AdapterContext,
    external_id: &str,
) -> Result<Option<RemoteRepository>, MergeError> {
    Ok(client(ctx)
        .get(&format!("/projects/{}", encode(external_id)))
        .await?
        .as_ref()
        .map(remote_repository))
}

/// `mergeRequestsQuery(state, since, page)`.
fn merge_requests_query(state: &str, since: Option<&str>, page: usize) -> String {
    let updated = since
        .map(|since| format!("&updated_after={}", encode(since)))
        .unwrap_or_default();
    format!(
        "merge_requests?state={state}{updated}&order_by=updated_at&sort=desc&per_page={PAGE}&page={page}"
    )
}

pub(crate) async fn list_pull_requests_for_backfill(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
) -> Result<Vec<MirrorFields>, MergeError> {
    let api = client(ctx);
    let since = weldsuite_kit::validation::js_iso_from_millis(
        crate::now_ms() - BACKFILL_DAYS * 24.0 * 60.0 * 60.0 * 1000.0,
    )
    .unwrap_or_default();
    let mut out: Vec<Value> = Vec::new();
    for (state, from) in [
        ("opened", None),
        ("merged", Some(since.as_str())),
        ("closed", Some(since.as_str())),
    ] {
        let path = project_path(repository);
        let rows = collect_pages(
            |page| {
                let (api, path) = (&api, &path);
                async move {
                    let list = api
                        .get_list(&format!(
                            "{path}/{}",
                            merge_requests_query(state, from, page)
                        ))
                        .await?;
                    let more = list.len() == PAGE;
                    Ok((list, more))
                }
            },
            PAGES,
            BACKFILL_CAP - out.len(),
        )
        .await?;
        out.extend(rows);
        if out.len() >= BACKFILL_CAP {
            break;
        }
    }
    Ok(out.iter().map(map_merge_request).collect())
}

pub(crate) async fn get_pull_request(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Option<MirrorFields>, MergeError> {
    Ok(client(ctx)
        .get(&format!(
            "{}/merge_requests/{number}",
            project_path(repository)
        ))
        .await?
        .as_ref()
        .map(map_merge_request))
}

pub(crate) async fn review_decision(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
) -> Result<Option<&'static str>, MergeError> {
    let api = client(ctx);
    let path = format!("{}/merge_requests/{number}", project_path(repository));
    let Some(mr) = api.get(&path).await? else {
        return Ok(None);
    };
    let approvals = match api.get(&format!("{path}/approvals")).await {
        Ok(approvals) => approvals,
        // Approvals are not on every edition and plan: none, not a failure.
        Err(error) if error.is_status(&[403, 405]) => None,
        Err(error) => return Err(error),
    };
    let approvers: HashSet<Option<String>> = approvals
        .as_ref()
        .and_then(|a| a.get("approved_by"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|a| {
                    a.get("user")
                        .and_then(|u| u.get("username"))
                        .and_then(Value::as_str)
                        .map(str::to_lowercase)
                })
                .collect()
        })
        .unwrap_or_default();
    let waiting = mr
        .get("reviewers")
        .and_then(Value::as_array)
        .map_or(0, |reviewers| {
            reviewers
                .iter()
                .filter(|r| {
                    let login = r
                        .get("username")
                        .and_then(Value::as_str)
                        .map(str::to_lowercase);
                    !approvers.contains(&login)
                })
                .count()
        });
    Ok(review_decision_of(
        approvals.as_ref(),
        mr.get("blocking_discussions_resolved"),
        waiting,
    ))
}

pub(crate) async fn checks_status(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    head_sha: &str,
) -> Result<Option<&'static str>, MergeError> {
    let pipelines = client(ctx)
        .get_list(&format!(
            "{}/pipelines?sha={}&order_by=id&sort=desc&per_page=1",
            project_path(repository),
            encode(head_sha)
        ))
        .await?;
    Ok(pipelines
        .first()
        .and_then(|latest| pipeline_status(latest.get("status"))))
}

// ── Project hooks ──────────────────────────────────────────────────────────

pub(crate) async fn register_webhook(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    target: &WebhookTarget,
) -> Result<String, MergeError> {
    let hook = client(ctx)
        .send(
            "POST",
            &format!("{}/hooks", project_path(repository)),
            Some(json!({
                "url": target.url,
                "token": target.secret,
                "merge_requests_events": true,
                "issues_events": true,
                "note_events": true,
                "pipeline_events": true,
                "push_events": false,
                "enable_ssl_verification": true,
            })),
        )
        .await?;
    Ok(crate::github::js_string(
        hook.as_ref().and_then(|h| h.get("id")),
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
            &format!("{}/hooks/{}", project_path(repository), encode(webhook_id)),
            None,
        )
        .await
    {
        // Already gone (the project was removed, or someone deleted the hook).
        Err(error) if error.is_status(&[404]) => Ok(()),
        other => other.map(|_| ()),
    }
}

// ── OAuth ──────────────────────────────────────────────────────────────────

fn client_of(
    env: &(dyn Fn(&str) -> Option<String> + Sync),
) -> Result<(String, String), MergeError> {
    match (
        env("GITLAB_OAUTH_CLIENT_ID"),
        env("GITLAB_OAUTH_CLIENT_SECRET"),
    ) {
        (Some(id), Some(secret)) => Ok((id, secret)),
        _ => Err(MergeError::ProviderNotConfigured("gitlab".to_owned())),
    }
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
        ("response_type".to_owned(), "code".to_owned()),
        ("scope".to_owned(), "api".to_owned()),
        ("state".to_owned(), state.to_owned()),
    ]);
    Ok(format!("{}/oauth/authorize?{query}", base(None)))
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
        "gitlab",
        "POST",
        &format!("{}/oauth/token", base(None)),
        &[],
        Body::Form(vec![
            ("client_id".to_owned(), client_id),
            ("client_secret".to_owned(), client_secret),
            ("code".to_owned(), code.to_owned()),
            ("grant_type".to_owned(), "authorization_code".to_owned()),
            ("redirect_uri".to_owned(), redirect_uri.to_owned()),
        ]),
    )
    .await?;
    credentials_from_token(&body.unwrap_or_else(|| json!({})), "gitlab")
}

pub(crate) async fn refresh(
    http: &OutboundHttp,
    env: &(dyn Fn(&str) -> Option<String> + Sync),
    refresh_token: &str,
    host: Option<&str>,
) -> Result<StoredCredentials, MergeError> {
    let (client_id, client_secret) = client_of(env)?;
    let app_url = env("APP_URL").unwrap_or_default();
    let body = request_json(
        http,
        "gitlab",
        "POST",
        &format!("{}/oauth/token", base(host)),
        &[],
        Body::Form(vec![
            ("client_id".to_owned(), client_id),
            ("client_secret".to_owned(), client_secret),
            ("refresh_token".to_owned(), refresh_token.to_owned()),
            ("grant_type".to_owned(), "refresh_token".to_owned()),
            (
                "redirect_uri".to_owned(),
                format!("{app_url}/weldmerge/oauth/callback"),
            ),
        ]),
    )
    .await?;
    credentials_from_token(&body.unwrap_or_else(|| json!({})), "gitlab")
}

/// `gitlabCurrentUser(host, accessToken)`: validates a token and says whose
/// it is (also for typed self-managed tokens).
pub(crate) async fn current_user(
    http: &OutboundHttp,
    host: Option<&str>,
    access_token: &str,
) -> Result<OAuthUser, MergeError> {
    let body = request_json(
        http,
        "gitlab",
        "GET",
        &format!("{}/api/v4/user", base(host)),
        &bearer(access_token),
        Body::None,
    )
    .await?
    .ok_or_else(|| MergeError::Unexpected("GitLab answered /user with an empty body".to_owned()))?;
    Ok(OAuthUser {
        external_id: crate::github::js_string(body.get("id")),
        login: body
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase(),
        display_name: body.get("name").and_then(Value::as_str).map(str::to_owned),
        avatar_url: body
            .get("avatar_url")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

// ── Issue adapter ──────────────────────────────────────────────────────────

fn issue_path(repository: &RepositoryRef, number: i64) -> String {
    format!("{}/issues/{number}", project_path(repository))
}

/// The user id of a login, or `None` when GitLab has no such user.
async fn user_id(api: &ApiClient<'_>, login: &str) -> Result<Option<Value>, MergeError> {
    let users = api
        .get_list(&format!("/users?username={}", encode(login)))
        .await?;
    Ok(users
        .first()
        .and_then(|u| u.get("id"))
        .filter(|id| !id.is_null())
        .cloned())
}

/// `writeBody(client, input)`: an unknown assignee login leaves the
/// assignee unset.
async fn write_body(api: &ApiClient<'_>, input: &IssueWriteInput) -> Result<Value, MergeError> {
    let mut body = Map::new();
    if let Some(title) = &input.title {
        body.insert("title".to_owned(), json!(title));
    }
    if let Some(text) = &input.body {
        body.insert("description".to_owned(), json!(text));
    }
    if let Some(labels) = &input.labels {
        body.insert("labels".to_owned(), json!(labels.join(",")));
    }
    if let Some(state) = input.state {
        body.insert(
            "state_event".to_owned(),
            json!(if state == "closed" { "close" } else { "reopen" }),
        );
    }
    match &input.assignee_login {
        Some(None) => {
            body.insert("assignee_ids".to_owned(), json!([]));
        }
        Some(Some(login)) => {
            if let Some(id) = user_id(api, login).await? {
                body.insert("assignee_ids".to_owned(), json!([id]));
            }
        }
        None => {}
    }
    Ok(Value::Object(body))
}

pub(crate) async fn list_issues(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    options: &ListIssuesOptions,
) -> Result<Vec<NormalizedIssue>, MergeError> {
    let api = client(ctx);
    let state = match options.state {
        Some("open") => "opened",
        Some(other) => other,
        None => "all",
    };
    let cap = options.limit.unwrap_or(PAGE * PAGES);
    let path = project_path(repository);
    let rows = collect_pages(
        |page| {
            let (api, path) = (&api, &path);
            async move {
                let list = api
                    .get_list(&format!(
                        "{path}/issues?state={state}&order_by=updated_at&sort=desc&per_page={PAGE}&page={page}"
                    ))
                    .await?;
                let more = list.len() == PAGE;
                Ok((list, more))
            }
        },
        cap.div_ceil(PAGE),
        cap,
    )
    .await?;
    Ok(rows.iter().map(map_issue).collect())
}

pub(crate) async fn create_issue(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    input: IssueWriteInput,
) -> Result<NormalizedIssue, MergeError> {
    let api = client(ctx);
    let fields = IssueWriteInput {
        state: None,
        ..input.clone()
    };
    let body = write_body(&api, &fields).await?;
    let created = api
        .send(
            "POST",
            &format!("{}/issues", project_path(repository)),
            Some(body),
        )
        .await?
        .ok_or_else(|| {
            MergeError::Unexpected("GitLab answered an issue create with an empty body".to_owned())
        })?;
    if input.state != Some("closed") {
        return Ok(map_issue(&created));
    }
    let number = created
        .get("iid")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let closed = api
        .send(
            "PUT",
            &issue_path(repository, number),
            Some(json!({ "state_event": "close" })),
        )
        .await?;
    Ok(map_issue(closed.as_ref().unwrap_or(&created)))
}

pub(crate) async fn update_issue(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    input: &IssueWriteInput,
) -> Result<NormalizedIssue, MergeError> {
    let api = client(ctx);
    let body = write_body(&api, input).await?;
    let updated = api
        .send("PUT", &issue_path(repository, number), Some(body))
        .await?
        .ok_or_else(|| {
            MergeError::Unexpected("GitLab answered an issue update with an empty body".to_owned())
        })?;
    Ok(map_issue(&updated))
}

pub(crate) async fn create_comment(
    ctx: &AdapterContext,
    repository: &RepositoryRef,
    number: i64,
    body: &str,
) -> Result<NormalizedIssueComment, MergeError> {
    let note = client(ctx)
        .send(
            "POST",
            &format!("{}/notes", issue_path(repository, number)),
            Some(json!({ "body": body })),
        )
        .await?
        .ok_or_else(|| {
            MergeError::Unexpected("GitLab answered a note create with an empty body".to_owned())
        })?;
    Ok(map_note(&note, number))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_a_merge_request() {
        let mr = json!({
            "id": 900, "iid": 1, "title": "Fix", "state": "merged", "web_url": "https://gitlab.com/a/b/-/merge_requests/1",
            "created_at": "2026-11-01T10:00:00Z", "updated_at": "2026-11-02T10:00:00Z",
            "author": { "username": "Octo-Dev" }, "source_branch": "plat-1", "target_branch": "main",
            "sha": "abc", "reviewers": [{ "username": "Rev" }], "labels": ["bug"], "changes_count": "3",
        });
        let fields = map_merge_request(&mr);
        assert_eq!(fields.state, "merged");
        assert_eq!(fields.author_login.as_deref(), Some("octo-dev"));
        assert_eq!(fields.changed_files, json!(3));
        assert_eq!(
            fields.merged_at.as_deref(),
            Some("2026-11-02T10:00:00.000Z")
        );
        assert_eq!(
            fields.requested_reviewers,
            vec![json!({ "kind": "user", "login": "rev", "avatarUrl": null })]
        );
    }

    #[test]
    fn decides_reviews_and_checks() {
        assert_eq!(
            review_decision_of(Some(&json!({ "approved": true })), None, 1),
            Some("approved")
        );
        assert_eq!(
            review_decision_of(None, Some(&json!(false)), 0),
            Some("changes_requested")
        );
        assert_eq!(review_decision_of(None, None, 2), Some("review_required"));
        assert_eq!(review_decision_of(None, None, 0), None);
        assert_eq!(pipeline_status(Some(&json!("failed"))), Some("failure"));
        assert_eq!(pipeline_status(Some(&json!("bogus"))), None);
    }
}
