//! GitHub event intake (`routes/internal` and `services/github-events.ts`):
//! `POST /internal/github-event`, what integration-webhook-worker forwards
//! once it has verified the App's HMAC and resolved the workspace (merge-api's
//! `MergeInternal.githubEvent`). Trusted by topology: no session and no
//! secret; here only the integration workers' receiver calls it, in process.
//!
//! A repository WeldMerge doesn't track, or tracks with `pr_sync` off, is
//! ignored. A copy older than the stored one is ignored (`isNotOlder`).
//! Moves made by the sync are the system's, not a member's.

use axum::body::Bytes;
use axum::extract::{FromRequestParts, State};
use axum::response::IntoResponse;
use http::HeaderMap;
use http::request::Parts;
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, Tenant, js_row};
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Data};

use crate::db::{Row, rows_of, text};
use crate::github::{combine_check_suites, js_string, review_decision_from_reviews};
use crate::github_client::{GithubClient, list_check_suites, list_pull_request_reviews};
use crate::hooks::{HookContext, after_pull_request_synced};
use crate::mappers::{pull_request_event_data, repository_event_data};
use crate::pr_sync::{UpsertStatus, upsert_pull_request};
use crate::pull_requests::linked_issues;
use crate::{
    Answer, MergeError, MergeState, Overrides, PendingEvent, Refusal, now, publish, system_events,
    validate,
};

/// `MERGE_GITHUB_FORWARDED_EVENTS`.
pub(crate) const FORWARDED_EVENTS: [&str; 7] = [
    "pull_request",
    "pull_request_review",
    "check_suite",
    "installation_repositories",
    "issues",
    "issue_comment",
    "installation",
];

/// What the intake reads off its request: the tenant when a layer opened it
/// (conformance), and the overrides.
pub(crate) struct Intake {
    pub(crate) tenant: Option<Tenant>,
    pub(crate) overrides: Overrides,
}

impl<S: Send + Sync> FromRequestParts<S> for Intake {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(Ok(Self {
            tenant: parts.extensions.get::<Tenant>().cloned(),
            overrides: Overrides::from_extensions(&parts.extensions),
        }))
    }
}

/// What an event did (`GithubEventResult`): `reason` set when it was dropped.
pub(crate) struct Outcome {
    pub(crate) reason: Option<String>,
    pub(crate) events: Vec<PendingEvent>,
}

pub(crate) fn ignored(reason: &str) -> Outcome {
    Outcome {
        reason: Some(reason.to_owned()),
        events: Vec::new(),
    }
}

pub(crate) const fn applied(events: Vec<PendingEvent>) -> Outcome {
    Outcome {
        reason: None,
        events,
    }
}

/// `obj(value)`: an object, not an array.
pub(crate) fn obj(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// A string or number id, as `String(id)`.
pub(crate) fn id_of(value: Option<&Value>) -> Option<String> {
    match value {
        Some(id @ (Value::Number(_) | Value::String(_))) => Some(js_string(Some(id))),
        _ => None,
    }
}

/// `installationOf(payload)`: the installation, as the string
/// `merge_connections.external_account_id` holds.
fn installation_of(payload: &Map<String, Value>) -> Option<String> {
    id_of(obj(payload.get("installation")).and_then(|i| i.get("id")))
}

/// `trackedRepository(db, payload)`: a tracked repository by the provider's
/// id (live, on a live connection).
async fn tracked_repository(
    db: &PgPool,
    payload: &Map<String, Value>,
) -> Result<Option<Row>, sqlx::Error> {
    let Some(repo_id) = id_of(obj(payload.get("repository")).and_then(|r| r.get("id"))) else {
        return Ok(None);
    };
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from merge_repositories r \
         inner join merge_connections c on c.id = r.connection_id \
         where r.provider = 'github' and r.external_id = $1 and r.deleted_at is null \
           and c.deleted_at is null limit 1",
    )
    .bind(repo_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

async fn installation_repositories(
    db: &PgPool,
    payload: &Map<String, Value>,
) -> Result<Outcome, MergeError> {
    let Some(installation) = installation_of(payload) else {
        return Ok(ignored("no_installation"));
    };
    let removed = payload
        .get("repositories_removed")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let ids: Vec<String> = removed
        .iter()
        .filter_map(|r| id_of(r.as_object().and_then(|r| r.get("id"))))
        .collect();
    if ids.is_empty() {
        return Ok(applied(Vec::new()));
    }
    let connections: Vec<String> = sqlx::query_scalar(
        "select id from merge_connections where provider = 'github' and external_account_id = $1 \
         and deleted_at is null",
    )
    .bind(&installation)
    .fetch_all(db)
    .await?;
    if connections.is_empty() {
        return Ok(ignored("untracked_repository"));
    }
    let now = now();
    let rows = rows_of(
        sqlx::query_scalar(
            "update merge_repositories set deleted_at = $3::timestamptz, updated_at = $3::timestamptz \
             where connection_id = any($1) and external_id = any($2) and deleted_at is null \
             returning to_jsonb(merge_repositories.*)",
        )
        .bind(&connections)
        .bind(&ids)
        .bind(&now)
        .fetch_all(db)
        .await?,
    );
    Ok(applied(
        rows.iter()
            .map(|row| {
                PendingEvent::new(
                    "merge_repository",
                    "deleted",
                    text(row, "id"),
                    repository_event_data(row),
                )
            })
            .collect(),
    ))
}

async fn pull_request(
    db: &PgPool,
    payload: &Map<String, Value>,
    hooks: Option<&HookContext>,
) -> Result<Outcome, MergeError> {
    let Some(pull) = obj(payload.get("pull_request")) else {
        return Ok(ignored("no_payload"));
    };
    let Some(repository) = tracked_repository(db, payload).await? else {
        return Ok(ignored("untracked_repository"));
    };
    if repository.get("prSync") != Some(&Value::Bool(true)) {
        return Ok(ignored("pr_sync_off"));
    }
    let outcome = upsert_pull_request(
        db,
        &repository,
        &Value::Object(pull.clone()),
        true,
        false,
        hooks,
    )
    .await?;
    if outcome.status == UpsertStatus::Stale {
        return Ok(ignored("stale"));
    }
    Ok(applied(outcome.events))
}

async fn pull_request_for(
    db: &PgPool,
    repository: &Row,
    number: i64,
) -> Result<Option<Row>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(p) from merge_pull_requests p where p.repository_id = $1 and p.number = $2 limit 1",
    )
    .bind(text(repository, "id"))
    .bind(number)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `updateEvent(db, pr)`: `merge_pull_request:updated` with its issues.
async fn update_event(
    db: &PgPool,
    pr: &Row,
    field: &str,
    old: Value,
) -> Result<PendingEvent, sqlx::Error> {
    let id = text(pr, "id").to_owned();
    let mut issues = linked_issues(db, std::slice::from_ref(&id)).await?;
    let issue_ids: Vec<String> = issues
        .remove(&id)
        .unwrap_or_default()
        .iter()
        .map(|issue| text(issue, "id").to_owned())
        .collect();
    let mut changes = Map::new();
    changes.insert(field.to_owned(), json!({ "old": old, "new": pr[field] }));
    Ok(PendingEvent::new(
        "merge_pull_request",
        "updated",
        &id,
        pull_request_event_data(pr, &issue_ids),
    )
    .with_changes(Some(changes)))
}

async fn review(
    db: &PgPool,
    payload: &Map<String, Value>,
    client: &GithubClient,
    hooks: Option<&HookContext>,
) -> Result<Outcome, MergeError> {
    let number = obj(payload.get("pull_request")).and_then(|p| p.get("number"));
    let Some(number) = number.and_then(Value::as_f64) else {
        return Ok(ignored("no_payload"));
    };
    let Some(repository) = tracked_repository(db, payload).await? else {
        return Ok(ignored("untracked_repository"));
    };
    if repository.get("prSync") != Some(&Value::Bool(true)) {
        return Ok(ignored("pr_sync_off"));
    }
    // A number that is not a whole one finds no pull request.
    #[allow(clippy::cast_possible_truncation)]
    let whole = (number.fract() == 0.0).then_some(number as i64);
    let pr = match whole {
        Some(number) => pull_request_for(db, &repository, number).await?,
        None => None,
    };
    let (Some(pr), Some(number)) = (pr, whole) else {
        return Ok(ignored("unknown_pull_request"));
    };
    let reviews = list_pull_request_reviews(client, text(&repository, "fullName"), number).await?;
    let requested = pr
        .get("requestedReviewers")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let decision = review_decision_from_reviews(&reviews, requested);
    let now = now();
    let updated: Value = sqlx::query_scalar(
        "update merge_pull_requests set review_decision = $2, synced_at = $3::timestamptz, \
           updated_at = $3::timestamptz where id = $1 returning to_jsonb(merge_pull_requests.*)",
    )
    .bind(text(&pr, "id"))
    .bind(decision)
    .bind(&now)
    .fetch_one(db)
    .await?;
    let updated = js_row(updated);
    let event = update_event(db, &updated, "reviewDecision", pr["reviewDecision"].clone()).await?;
    let events = vec![event];
    if let Some(hooks) = hooks {
        after_pull_request_synced(hooks, Some(&pr), &updated, &events).await;
    }
    Ok(applied(events))
}

async fn check_suite(
    db: &PgPool,
    payload: &Map<String, Value>,
    client: &GithubClient,
    hooks: Option<&HookContext>,
) -> Result<Outcome, MergeError> {
    let sha = obj(payload.get("check_suite"))
        .and_then(|s| s.get("head_sha"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let Some(sha) = sha else {
        return Ok(ignored("no_payload"));
    };
    let Some(repository) = tracked_repository(db, payload).await? else {
        return Ok(ignored("untracked_repository"));
    };
    if repository.get("prSync") != Some(&Value::Bool(true)) {
        return Ok(ignored("pr_sync_off"));
    }
    let tracked = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(p) from merge_pull_requests p \
             where p.repository_id = $1 and p.head_sha = $2 and p.state = 'open'",
        )
        .bind(text(&repository, "id"))
        .bind(sha)
        .fetch_all(db)
        .await?,
    );
    if tracked.is_empty() {
        return Ok(ignored("unknown_pull_request"));
    }
    let suites = list_check_suites(client, text(&repository, "fullName"), sha).await?;
    let status = combine_check_suites(&suites);
    let mut events = Vec::new();
    for pr in &tracked {
        let now = now();
        let updated: Value = sqlx::query_scalar(
            "update merge_pull_requests set checks_status = $2, synced_at = $3::timestamptz, \
               updated_at = $3::timestamptz where id = $1 returning to_jsonb(merge_pull_requests.*)",
        )
        .bind(text(pr, "id"))
        .bind(status)
        .bind(&now)
        .fetch_one(db)
        .await?;
        let updated = js_row(updated);
        let event = update_event(db, &updated, "checksStatus", pr["checksStatus"].clone()).await?;
        if let Some(hooks) = hooks {
            after_pull_request_synced(hooks, Some(pr), &updated, std::slice::from_ref(&event))
                .await;
        }
        events.push(event);
    }
    Ok(applied(events))
}

/// `handleGithubEvent(db, envelope, makeClient)`: applies one forwarded
/// GitHub event to the workspace's tenant database. A client is made only
/// when an event needs GitHub (reviews, check suites).
async fn handle(
    db: &PgPool,
    event: &str,
    payload: &Map<String, Value>,
    client_for: impl Fn(&str) -> GithubClient,
    hooks: Option<&HookContext>,
) -> Result<Outcome, MergeError> {
    match event {
        "pull_request" => pull_request(db, payload, hooks).await,
        "pull_request_review" => match installation_of(payload) {
            Some(installation) => review(db, payload, &client_for(&installation), hooks).await,
            None => Ok(ignored("no_installation")),
        },
        "check_suite" => match installation_of(payload) {
            Some(installation) => check_suite(db, payload, &client_for(&installation), hooks).await,
            None => Ok(ignored("no_installation")),
        },
        // Issue sync (issues, issue_comment) and the installation lifecycle.
        "issues" | "issue_comment" | "installation" => {
            crate::issue_sync::hooks::handle_github_event(db, event, payload, hooks).await
        }
        _ => installation_repositories(db, payload).await,
    }
}

/// `POST /internal/github-event`.
pub(crate) async fn intake(
    State(state): State<MergeState>,
    intake: Intake,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (workspace_id, event, payload) = validate(&headers, &body, |issues, fields| {
        let workspace_id = issues
            .text(fields, "workspaceId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default();
        let event = issues
            .choice(fields, "event", Presence::Required, &FORWARDED_EVENTS)
            .into_option()
            .unwrap_or_default();
        issues.text(fields, "deliveryId", Presence::Nullish, None, None);
        let payload = issues
            .nested(fields, "payload", Presence::Required, |_, payload| {
                payload.clone()
            })
            .into_option()
            .unwrap_or_default();
        (workspace_id, event, payload)
    })?;

    // The entrypoint has no auth middleware: resolve the workspace here, by
    // either of its ids.
    let tenant = if let Some(tenant) = intake.tenant {
        tenant
    } else {
        let resolved = match &state.tenants {
            Some(tenants) => tenants(workspace_id.clone()).await.ok(),
            None => None,
        };
        let Some(tenant) = resolved else {
            return Err(ApiError::not_found("Workspace", Some(&workspace_id)).into());
        };
        if tenant.suspended {
            return Ok(
                Data(json!({ "outcome": "ignored", "reason": "workspace_suspended" }))
                    .into_response(),
            );
        }
        tenant
    };
    let events = system_events(&tenant);
    let overrides = intake.overrides;
    let hooks = HookContext {
        db: tenant.db.clone(),
        state: state.clone(),
        overrides: overrides.clone(),
        user_id: "system".to_owned(),
        workspace_id: tenant.workspace_id.clone(),
        clerk_org_id: Some(
            tenant
                .clerk_org_id
                .clone()
                .unwrap_or_else(|| workspace_id.clone()),
        ),
        events: events.clone(),
    };
    let outcome = handle(
        &tenant.db,
        &event,
        &payload,
        |installation| overrides.github(&state, installation),
        Some(&hooks),
    )
    .await
    .map_err(Refusal::from)?;
    publish(&state, &events, outcome.events);
    let body = match outcome.reason {
        Some(reason) => json!({ "outcome": "ignored", "reason": reason }),
        None => json!({ "outcome": "applied" }),
    };
    Ok(Data(body).into_response())
}
