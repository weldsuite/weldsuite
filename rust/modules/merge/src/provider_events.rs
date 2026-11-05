//! GitLab, Bitbucket and Azure DevOps event intake
//! (`routes/internal/provider-event.ts`, `services/provider-events.ts`):
//! `POST /internal/provider-event`, what the integration workers' receiver
//! (`POST /webhooks/merge/:provider/:key`) forwards once it resolved the
//! workspace from the master provider index (`MergeInternal.providerEvent`).
//!
//! The repository is found by the `webhook_key` in the URL, the delivery is
//! verified with the repository's own stored secret (`bad_signature`
//! otherwise), parsed by the provider's adapter into normalized events and
//! applied through the same code as GitHub's: the pull request mirror (with
//! the automation rules and area hooks), the review and checks columns, and
//! the issue sync engine for GitLab issues. A hook that only says "something
//! changed" is completed by a read from the provider. Moves made by the sync
//! are the system's.

use axum::body::Bytes;
use axum::extract::State;
use axum::response::IntoResponse;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Data};

use crate::credentials::adapter_context;
use crate::db::{Row, opt_text, rows_of, text};
use crate::github_events::{Intake, Outcome, applied, ignored};
use crate::hooks::{HookContext, after_pull_request_synced};
use crate::issue_sync::hooks::result_of;
use crate::issue_sync::inbound::{InboundContext, apply_inbound_comment, apply_inbound_issue};
use crate::issue_sync::targets::SyncTarget;
use crate::mappers::{pull_request_event_data, repository_event_data};
use crate::pr_sync::{UpsertStatus, upsert_mirror};
use crate::providers::{self, AdapterContext, RepositoryRef, WebhookEvent};
use crate::pull_requests::linked_issues;
use crate::webhooks::{delete_webhook_index, master_of, webhook_secret_of};
use crate::{
    Answer, MergeError, MergeState, PendingEvent, Refusal, now, publish, system_events, validate,
};

/// `MERGE_WEBHOOK_PROVIDERS`.
const WEBHOOK_PROVIDERS: [&str; 3] = ["gitlab", "bitbucket", "azure_devops"];

/// What one delivery's events act on (`Scope`).
struct Scope<'a> {
    db: &'a PgPool,
    target: SyncTarget,
    reference: RepositoryRef,
    hooks: &'a HookContext,
    context: tokio_once::Once<AdapterContext>,
}

/// A lazily built adapter context (`cached ??= adapterContextFor(...)`).
mod tokio_once {
    use std::sync::Mutex;

    pub(crate) struct Once<T>(Mutex<Option<T>>);

    impl<T: Clone> Once<T> {
        pub(crate) fn new() -> Self {
            Self(Mutex::new(None))
        }

        pub(crate) fn get(&self) -> Option<T> {
            self.0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }

        pub(crate) fn set(&self, value: T) {
            *self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(value);
        }
    }
}

impl Scope<'_> {
    fn repository(&self) -> &Row {
        &self.target.repository
    }

    async fn context(&self) -> Result<AdapterContext, MergeError> {
        if let Some(ctx) = self.context.get() {
            return Ok(ctx);
        }
        let ctx = adapter_context(
            self.db,
            &self.hooks.state,
            &self.hooks.overrides,
            &self.target.connection,
            None,
        )
        .await?;
        self.context.set(ctx.clone());
        Ok(ctx)
    }
}

/// `isReadFailure(err)`: a provider answering badly, or a connection with no
/// usable token: the delivery is kept, the re-read skipped.
fn is_read_failure(error: &MergeError) -> bool {
    matches!(
        error,
        MergeError::ProviderApi { .. } | MergeError::ProviderCredentials(_)
    )
}

/// `findByWebhookKey(db, provider, key)`.
async fn find_by_webhook_key(
    db: &PgPool,
    provider: &str,
    key: &str,
) -> Result<Option<SyncTarget>, sqlx::Error> {
    let row: Option<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(r), to_jsonb(c) from merge_repositories r \
         inner join merge_connections c on c.id = r.connection_id \
         where r.provider = $1 and r.webhook_key = $2 and r.deleted_at is null and c.deleted_at is null \
         limit 1",
    )
    .bind(provider)
    .bind(key)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(repository, connection)| SyncTarget {
        repository: js_row(repository),
        connection: js_row(connection),
    }))
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
    new: Value,
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
    changes.insert(field.to_owned(), json!({ "old": old, "new": new }));
    Ok(PendingEvent::new(
        "merge_pull_request",
        "updated",
        &id,
        pull_request_event_data(pr, &issue_ids),
    )
    .with_changes(Some(changes)))
}

fn pr_sync_on(repository: &Row) -> bool {
    repository.get("prSync") == Some(&Value::Bool(true))
}

async fn pull_request_event(
    scope: &Scope<'_>,
    fields: crate::github::MirrorFields,
) -> Result<Outcome, MergeError> {
    if !pr_sync_on(scope.repository()) {
        return Ok(ignored("pr_sync_off"));
    }
    let mut fields = fields;
    // GitLab's hook names the author by id only: complete the mirror from the provider.
    if fields.author_login.is_none() {
        let number = fields.number.as_i64().unwrap_or_default();
        let read = match scope.context().await {
            Ok(ctx) => providers::get_pull_request(&ctx, &scope.reference, number).await,
            Err(error) => Err(error),
        };
        match read {
            Ok(Some(read)) => fields = read,
            Ok(None) => {}
            Err(error) if is_read_failure(&error) => {}
            Err(error) => return Err(error),
        }
    }
    let outcome = upsert_mirror(
        scope.db,
        scope.repository(),
        fields,
        true,
        false,
        Some(scope.hooks),
    )
    .await?;
    if outcome.status == UpsertStatus::Stale {
        return Ok(ignored("stale"));
    }
    Ok(applied(outcome.events))
}

async fn review_event(
    scope: &Scope<'_>,
    number: i64,
    decision: Option<&'static str>,
) -> Result<Outcome, MergeError> {
    if !pr_sync_on(scope.repository()) {
        return Ok(ignored("pr_sync_off"));
    }
    let Some(pr) = pull_request_for(scope.db, scope.repository(), number).await? else {
        return Ok(ignored("unknown_pull_request"));
    };
    let decision = if decision.is_some() {
        decision
    } else {
        let read = match scope.context().await {
            Ok(ctx) => providers::review_decision(&ctx, &scope.reference, number).await,
            Err(error) => Err(error),
        };
        match read {
            Ok(decision) => decision,
            Err(error) if is_read_failure(&error) => {
                return Ok(ignored("provider_unavailable"));
            }
            Err(error) => return Err(error),
        }
    };
    let now = now();
    let updated: Value = sqlx::query_scalar(
        "update merge_pull_requests set review_decision = $2, synced_at = $3::timestamptz, \
           updated_at = $3::timestamptz where id = $1 returning to_jsonb(merge_pull_requests.*)",
    )
    .bind(text(&pr, "id"))
    .bind(decision)
    .bind(&now)
    .fetch_one(scope.db)
    .await?;
    let updated = js_row(updated);
    let event = update_event(
        scope.db,
        &updated,
        "reviewDecision",
        pr["reviewDecision"].clone(),
        json!(decision),
    )
    .await?;
    let events = vec![event];
    after_pull_request_synced(scope.hooks, Some(&pr), &updated, &events).await;
    Ok(applied(events))
}

async fn checks_event(
    scope: &Scope<'_>,
    head_sha: &str,
    status: Option<&'static str>,
    numbers: &[i64],
) -> Result<Outcome, MergeError> {
    if !pr_sync_on(scope.repository()) {
        return Ok(ignored("pr_sync_off"));
    }
    let tracked = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(p) from merge_pull_requests p \
             where p.repository_id = $1 and p.head_sha = $2 and p.state = 'open' \
               and (cardinality($3::int[]) = 0 or p.number = any($3::int[]))",
        )
        .bind(text(scope.repository(), "id"))
        .bind(head_sha)
        .bind(
            numbers
                .iter()
                .map(|n| i32::try_from(*n).unwrap_or(i32::MAX))
                .collect::<Vec<i32>>(),
        )
        .fetch_all(scope.db)
        .await?,
    );
    if tracked.is_empty() {
        return Ok(ignored("unknown_pull_request"));
    }
    let mut events = Vec::new();
    for pr in &tracked {
        let status = if status.is_some() {
            status
        } else {
            let number = pr.get("number").and_then(Value::as_i64);
            let read = match scope.context().await {
                Ok(ctx) => providers::checks_status(&ctx, &scope.reference, head_sha, number).await,
                Err(error) => Err(error),
            };
            match read {
                Ok(status) => status,
                Err(error) if is_read_failure(&error) => {
                    return Ok(ignored("provider_unavailable"));
                }
                Err(error) => return Err(error),
            }
        };
        let now = now();
        let updated: Value = sqlx::query_scalar(
            "update merge_pull_requests set checks_status = $2, synced_at = $3::timestamptz, \
               updated_at = $3::timestamptz where id = $1 returning to_jsonb(merge_pull_requests.*)",
        )
        .bind(text(pr, "id"))
        .bind(status)
        .bind(&now)
        .fetch_one(scope.db)
        .await?;
        let updated = js_row(updated);
        let event = update_event(
            scope.db,
            &updated,
            "checksStatus",
            pr["checksStatus"].clone(),
            json!(status),
        )
        .await?;
        after_pull_request_synced(
            scope.hooks,
            Some(pr),
            &updated,
            std::slice::from_ref(&event),
        )
        .await;
        events.push(event);
    }
    Ok(applied(events))
}

async fn remove_repository(scope: &Scope<'_>) -> Result<Outcome, MergeError> {
    let now = now();
    let row: Value = sqlx::query_scalar(
        "update merge_repositories set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where id = $1 returning to_jsonb(merge_repositories.*)",
    )
    .bind(text(scope.repository(), "id"))
    .bind(&now)
    .fetch_one(scope.db)
    .await?;
    let row = js_row(row);
    if let Some(key) = opt_text(scope.repository(), "webhookKey") {
        let removed = match master_of(&scope.hooks.state, &scope.hooks.overrides) {
            Ok(master) => delete_webhook_index(&master, text(scope.repository(), "provider"), &key)
                .await
                .map_err(MergeError::from),
            Err(error) => Err(error),
        };
        if let Err(error) = removed {
            tracing::error!(
                ?error,
                "merge: could not remove a webhook from the master index"
            );
        }
    }
    Ok(applied(vec![PendingEvent::new(
        "merge_repository",
        "deleted",
        text(&row, "id"),
        repository_event_data(&row),
    )]))
}

async fn apply_event(scope: &Scope<'_>, event: WebhookEvent) -> Result<Outcome, MergeError> {
    let gitlab = text(scope.repository(), "provider") == "gitlab";
    let inbound = || InboundContext {
        db: scope.db,
        target: &scope.target,
        user_id: &scope.hooks.user_id,
        hooks: Some(scope.hooks),
    };
    match event {
        WebhookEvent::PullRequest { pull_request, .. } => {
            pull_request_event(scope, *pull_request).await
        }
        WebhookEvent::Review {
            number, decision, ..
        } => review_event(scope, number, decision).await,
        WebhookEvent::Checks {
            head_sha,
            status,
            numbers,
            ..
        } => checks_event(scope, &head_sha, status, &numbers).await,
        WebhookEvent::Issue { action, issue, .. } if gitlab => {
            let create = matches!(action.as_str(), "opened" | "reopened");
            Ok(result_of(
                apply_inbound_issue(&inbound(), &issue, create).await?,
            ))
        }
        WebhookEvent::IssueComment {
            action, comment, ..
        } if gitlab => Ok(result_of(
            apply_inbound_comment(&inbound(), action, &comment).await?,
        )),
        WebhookEvent::Issue { .. } | WebhookEvent::IssueComment { .. } => {
            Ok(ignored("issues_unsupported"))
        }
        WebhookEvent::RepositoryRemoved { .. } => remove_repository(scope).await,
    }
}

/// `handleProviderEvent(db, env, envelope, hooks)`: verifies and applies one
/// forwarded delivery; a delivery it cannot use is `ignored` with a reason.
async fn handle(
    db: &PgPool,
    hooks: &HookContext,
    provider: &str,
    key: &str,
    headers: &Map<String, Value>,
    raw_body: &str,
) -> Result<Outcome, MergeError> {
    let Some(target) = find_by_webhook_key(db, provider, key).await? else {
        return Ok(ignored("unknown_repository"));
    };
    let keyring = hooks.overrides.keyring(&hooks.state);
    let Some(secret) = webhook_secret_of(&keyring, &target.repository) else {
        return Ok(ignored("bad_signature"));
    };
    if providers::verify_webhook(provider, headers, raw_body, &secret) != Some(true) {
        return Ok(ignored("bad_signature"));
    }
    let Ok(body) = serde_json::from_str::<Value>(raw_body) else {
        return Ok(ignored("invalid_body"));
    };
    let external_id = text(&target.repository, "externalId").to_lowercase();
    let events: Vec<WebhookEvent> = providers::parse_webhook(provider, headers, &body)
        .into_iter()
        .filter(|event| event.repository().to_lowercase() == external_id)
        .collect();
    if events.is_empty() {
        return Ok(ignored("no_event"));
    }
    let reference = RepositoryRef::of(&target.repository);
    let scope = Scope {
        db,
        target,
        reference,
        hooks,
        context: tokio_once::Once::new(),
    };
    let mut pending: Vec<PendingEvent> = Vec::new();
    let mut first_reason: Option<String> = None;
    let mut any_applied = false;
    for event in events {
        let result = apply_event(&scope, event).await?;
        pending.extend(result.events);
        match result.reason {
            None => any_applied = true,
            Some(reason) => {
                if first_reason.is_none() {
                    first_reason = Some(reason);
                }
            }
        }
    }
    Ok(if any_applied {
        applied(pending)
    } else {
        Outcome {
            reason: Some(first_reason.unwrap_or_default()),
            events: pending,
        }
    })
}

/// `POST /internal/provider-event`.
pub(crate) async fn intake(
    State(state): State<MergeState>,
    intake: Intake,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (workspace_id, provider, key, forwarded, raw) =
        validate(&headers, &body, |issues, fields| {
            let workspace_id = issues
                .text(fields, "workspaceId", Presence::Required, Some(1), None)
                .into_option()
                .unwrap_or_default();
            let provider = issues
                .choice(fields, "provider", Presence::Required, &WEBHOOK_PROVIDERS)
                .into_option()
                .unwrap_or_default();
            let key = issues
                .text(fields, "key", Presence::Required, Some(1), None)
                .into_option()
                .unwrap_or_default();
            // `z.record(z.string())`: every value a string.
            let forwarded = issues
                .nested(fields, "headers", Presence::Required, |issues, headers| {
                    let mut out: Vec<(String, String)> = Vec::new();
                    for name in headers.keys() {
                        if let Some(value) = issues
                            .text(headers, name, Presence::Required, None, None)
                            .into_option()
                        {
                            out.push((name.clone(), value));
                        }
                    }
                    out
                })
                .into_option()
                .unwrap_or_default();
            let raw = issues
                .text(fields, "body", Presence::Required, None, None)
                .into_option()
                .unwrap_or_default();
            (workspace_id, provider, key, forwarded, raw)
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
    let hooks = HookContext {
        db: tenant.db.clone(),
        state: state.clone(),
        overrides: intake.overrides,
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
    let headers_map: Map<String, Value> = forwarded
        .into_iter()
        .map(|(name, value)| (name, Value::String(value)))
        .collect();
    let outcome = handle(&tenant.db, &hooks, &provider, &key, &headers_map, &raw)
        .await
        .map_err(Refusal::from)?;
    publish(&state, &events, outcome.events);
    let body = match outcome.reason {
        Some(reason) => json!({ "outcome": "ignored", "reason": reason }),
        None => json!({ "outcome": "applied" }),
    };
    Ok(Data(body).into_response())
}
