//! The explicit issue-sync routes (`routes/repositories/import.ts`,
//! `routes/issues/external.ts`):
//!
//! ```text
//!   POST   /repositories/:id/import-issues → { imported, updated, skipped }: the open provider issues (up to 500)
//!   POST   /issues/:id/external {repositoryId} → create the issue on the provider and link it   (merge_issues:update)
//!   DELETE /issues/:id/external                → stop syncing; the provider issue stays            (merge_issues:update)
//! ```
//!
//! The provider calls run inside the request. A refusal is 502
//! `provider_error` (the provider's message), a provider without issues 422,
//! a worker without the GitHub App's credentials 503 (`syncFailure`).

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::IntoResponse;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{Created, Data, NoContent};

use super::inbound::{InboundContext, import_provider_issues};
use super::outbound::{CreateExternal, create_external_issue, remove_external_issue};
use super::targets::load_target;
use crate::credentials::adapter_context;
use crate::db::{Row, col, opt_text, text};
use crate::issues::{find_issue, team_key_of};
use crate::mappers::issue_event_data;
use crate::providers::{self, ListIssuesOptions, RepositoryRef};
use crate::{Answer, Caller, MergeError, MergeState, PendingEvent, Refusal, publish, validate};

/// `MERGE_IMPORT_ISSUES_LIMIT`.
const IMPORT_LIMIT: usize = 500;

/// `syncFailure(c, err)`.
fn sync_failure(error: MergeError) -> Refusal {
    Refusal::Error(error.for_sync())
}

/// `POST /repositories/:id/import-issues`.
pub(crate) async fn import_issues(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let db = &caller.db;
    let Some(target) = load_target(db, &id).await? else {
        return Err(Refusal::not_found("Repository", Some(&id)));
    };
    let repository = &target.repository;
    let provider = text(repository, "provider");
    if !providers::has_issues(provider) {
        return Err(Refusal::unprocessable(&format!(
            "{provider} does not support issue sync"
        )));
    }
    if text(repository, "issueSync") == "off" {
        return Err(Refusal::unprocessable(
            "Turn issue sync on for this repository first",
        ));
    }
    if opt_text(repository, "teamId").is_none() {
        return Err(Refusal::unprocessable(
            "Give this repository a team first: imported issues belong to it",
        ));
    }
    let run = async {
        let ctx = adapter_context(db, &state, &caller.overrides, &target.connection, None).await?;
        let issues = providers::list_issues(
            &ctx,
            &RepositoryRef::of(repository),
            &ListIssuesOptions {
                state: Some("open"),
                limit: Some(IMPORT_LIMIT),
            },
        )
        .await?;
        let inbound = InboundContext {
            db,
            target: &target,
            user_id: &caller.user_id,
            hooks: None,
        };
        import_provider_issues(&inbound, &issues).await
    };
    let (counts, events) = run.await.map_err(sync_failure)?;
    publish(&state, &caller.events, events);
    Ok(Data(json!({
        "imported": counts.imported,
        "updated": counts.updated,
        "skipped": counts.skipped,
    }))
    .into_response())
}

/// `merge_issue` updated with the `external` change.
async fn external_change_event(
    caller: &Caller,
    issue: &Row,
    old: Value,
    new: Value,
) -> Result<PendingEvent, sqlx::Error> {
    let team_key = team_key_of(&caller.db, text(issue, "teamId")).await?;
    let mut changes = Map::new();
    changes.insert("external".to_owned(), json!({ "old": old, "new": new }));
    Ok(PendingEvent::new(
        "merge_issue",
        "updated",
        text(issue, "id"),
        issue_event_data(issue, &team_key, None),
    )
    .with_changes(Some(changes)))
}

/// `POST /issues/:id/external {repositoryId}`.
pub(crate) async fn create_external(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let repository_id = validate(&headers, &body, |issues, fields| {
        issues
            .text(fields, "repositoryId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    })?;
    let db = &caller.db;
    let Some(issue) = find_issue(db, &id).await? else {
        return Err(Refusal::not_found("Issue", Some(&id)));
    };
    let created = create_external_issue(db, &state, &caller.overrides, &issue, &repository_id)
        .await
        .map_err(sync_failure)?;
    let (link, repository_full_name) = match created {
        CreateExternal::Linked {
            link,
            repository_full_name,
        } => (link, repository_full_name),
        CreateExternal::AlreadyLinked => {
            return Err(Refusal::conflict(
                "The issue is already linked to a provider issue",
            ));
        }
        CreateExternal::Unsupported => {
            return Err(Refusal::unprocessable(
                "This provider does not support issue sync",
            ));
        }
        CreateExternal::RepositoryNotFound => {
            return Err(Refusal::not_found("Repository", Some(&repository_id)));
        }
    };
    let event = external_change_event(
        &caller,
        &issue,
        Value::Null,
        json!({ "provider": link["provider"], "number": link["number"] }),
    )
    .await?;
    publish(&state, &caller.events, vec![event]);
    Ok(Created(json!({
        "provider": col(&link, "provider"),
        "number": col(&link, "number"),
        "url": col(&link, "url"),
        "state": col(&link, "state"),
        "repositoryId": col(&link, "repositoryId"),
        "repositoryFullName": repository_full_name,
    }))
    .into_response())
}

/// `DELETE /issues/:id/external`.
pub(crate) async fn remove_external(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let db = &caller.db;
    let Some(issue) = find_issue(db, &id).await? else {
        return Err(Refusal::not_found("Issue", Some(&id)));
    };
    if !remove_external_issue(db, &id).await? {
        return Err(Refusal::not_found("External issue", Some(&id)));
    }
    let event =
        external_change_event(&caller, &issue, json!({ "linked": true }), Value::Null).await?;
    publish(&state, &caller.events, vec![event]);
    Ok(NoContent.into_response())
}
