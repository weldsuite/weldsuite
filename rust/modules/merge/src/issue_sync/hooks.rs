//! Issue sync entry points (`services/issue-sync/hooks.ts`): called from
//! [`crate::hooks`] (a WeldMerge change to push) and from the GitHub event
//! intake (a GitHub webhook to apply).
//!
//! Push runs for repositories whose `issue_sync` is `two_way`, inside the
//! request; a failing push is an error that [`crate::hooks`] logs, so the
//! member's own change is never undone by a provider outage. Intake handles
//! `issues`, `issue_comment` and `installation`.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;

use super::inbound::{
    InboundContext, InboundResult, Outcome as InboundOutcome, apply_inbound_comment,
    apply_inbound_issue, unlink_provider_issue,
};
use super::outbound::{push_comment, push_issue_update};
use super::targets::load_target_by_external_id;
use crate::db::{Row, text};
use crate::github_events::{Outcome, applied, id_of, ignored, obj};
use crate::hooks::{CommentChange, HookContext};
use crate::installations::{remove_github_installation_index, set_github_installation_status};
use crate::mappers::connection_event_data;
use crate::providers::github::{is_pull_request, normalize_comment, normalize_issue};
use crate::webhooks::master_of;
use crate::{MergeError, PendingEvent};

/// `afterIssueCreated`: nothing to push (a new issue is linked explicitly).
#[allow(clippy::unused_async)]
pub(crate) async fn after_issue_created(
    _ctx: &HookContext,
    _issue: &Row,
    _team_key: &str,
) -> Result<(), MergeError> {
    Ok(())
}

/// `afterIssueUpdated`: a member's edit (or a pull request moving the
/// issue), pushed when the issue is linked to a `two_way` repository.
pub(crate) async fn after_issue_updated(
    ctx: &HookContext,
    before: &Row,
    after: &Row,
    _team_key: &str,
) -> Result<(), MergeError> {
    push_issue_update(&ctx.db, &ctx.state, &ctx.overrides, before, after).await?;
    Ok(())
}

/// `afterCommentChanged`: a comment a member wrote, pushed to the linked
/// provider issue.
pub(crate) async fn after_comment_changed(
    ctx: &HookContext,
    change: CommentChange,
    comment: &Row,
    issue: &Row,
    _team_key: &str,
) -> Result<(), MergeError> {
    if change != CommentChange::Created {
        return Ok(());
    }
    push_comment(&ctx.db, &ctx.state, &ctx.overrides, comment, issue).await?;
    Ok(())
}

// ── GitHub webhook intake ──────────────────────────────────────────────────

/// `resultOf(result)`.
pub(crate) fn result_of(result: InboundResult) -> Outcome {
    match result.outcome {
        InboundOutcome::Ignored | InboundOutcome::Unchanged => Outcome {
            reason: Some(result.reason.unwrap_or_else(|| {
                if result.outcome == InboundOutcome::Ignored {
                    "ignored"
                } else {
                    "unchanged"
                }
                .to_owned()
            })),
            events: result.events,
        },
        _ => applied(result.events),
    }
}

/// `issues` actions that change an issue we already know.
const UPDATE_ACTIONS: [&str; 6] = [
    "edited",
    "closed",
    "labeled",
    "unlabeled",
    "assigned",
    "unassigned",
];
/// `opened` and `reopened` also bring an unknown one in.
const CREATE_ACTIONS: [&str; 2] = ["opened", "reopened"];
const UNLINK_ACTIONS: [&str; 2] = ["deleted", "transferred"];

/// `String(payload.action)`.
fn action_of(payload: &Map<String, Value>) -> String {
    crate::github::js_string(payload.get("action"))
}

async fn issues_event(
    db: &PgPool,
    payload: &Map<String, Value>,
    hooks: Option<&HookContext>,
) -> Result<Outcome, MergeError> {
    let Some(raw) = obj(payload.get("issue")) else {
        return Ok(ignored("no_payload"));
    };
    if is_pull_request(raw) {
        return Ok(ignored("pull_request"));
    }
    let Some(repo_id) = id_of(obj(payload.get("repository")).and_then(|r| r.get("id"))) else {
        return Ok(ignored("untracked_repository"));
    };
    let Some(target) = load_target_by_external_id(db, "github", &repo_id).await? else {
        return Ok(ignored("untracked_repository"));
    };
    let ctx = InboundContext {
        db,
        target: &target,
        user_id: hooks.map_or("system", |h| h.user_id.as_str()),
        hooks,
    };
    let action = action_of(payload);
    if UNLINK_ACTIONS.contains(&action.as_str()) {
        let number = raw
            .get("number")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        return Ok(result_of(unlink_provider_issue(&ctx, number).await?));
    }
    let create = CREATE_ACTIONS.contains(&action.as_str());
    if !create && !UPDATE_ACTIONS.contains(&action.as_str()) {
        return Ok(ignored("unsupported_action"));
    }
    Ok(result_of(
        apply_inbound_issue(&ctx, &normalize_issue(raw), create).await?,
    ))
}

async fn issue_comment_event(
    db: &PgPool,
    payload: &Map<String, Value>,
    hooks: Option<&HookContext>,
) -> Result<Outcome, MergeError> {
    let (Some(issue), Some(comment)) = (obj(payload.get("issue")), obj(payload.get("comment")))
    else {
        return Ok(ignored("no_payload"));
    };
    if is_pull_request(issue) {
        return Ok(ignored("pull_request"));
    }
    let action = action_of(payload);
    let action = match action.as_str() {
        "created" => "created",
        "edited" => "edited",
        "deleted" => "deleted",
        _ => return Ok(ignored("unsupported_action")),
    };
    let Some(repo_id) = id_of(obj(payload.get("repository")).and_then(|r| r.get("id"))) else {
        return Ok(ignored("untracked_repository"));
    };
    let Some(target) = load_target_by_external_id(db, "github", &repo_id).await? else {
        return Ok(ignored("untracked_repository"));
    };
    let ctx = InboundContext {
        db,
        target: &target,
        user_id: hooks.map_or("system", |h| h.user_id.as_str()),
        hooks,
    };
    let number = issue.get("number").and_then(Value::as_i64);
    Ok(result_of(
        apply_inbound_comment(&ctx, action, &normalize_comment(comment, number)).await?,
    ))
}

/// `installation` deleted / suspend / unsuspend: the connection's status
/// follows; a removed installation also leaves the master index.
async fn installation_event(
    db: &PgPool,
    payload: &Map<String, Value>,
    hooks: Option<&HookContext>,
) -> Result<Outcome, MergeError> {
    let Some(id) = id_of(obj(payload.get("installation")).and_then(|i| i.get("id"))) else {
        return Ok(ignored("no_installation"));
    };
    let status = match action_of(payload).as_str() {
        "deleted" => "revoked",
        "suspend" => "suspended",
        "unsuspend" => "active",
        _ => return Ok(ignored("unsupported_action")),
    };
    let previous: HashMap<String, Value> = crate::installations::find_github_connections(db, &id)
        .await?
        .into_iter()
        .map(|row| (text(&row, "id").to_owned(), row["status"].clone()))
        .collect();
    let rows = set_github_installation_status(db, &id, status).await?;
    if status == "revoked"
        && let Some(hooks) = hooks
    {
        let removed = match master_of(&hooks.state, &hooks.overrides) {
            Ok(master) => remove_github_installation_index(&master, &id)
                .await
                .map_err(MergeError::from),
            Err(error) => Err(error),
        };
        if let Err(error) = removed {
            tracing::error!(
                ?error,
                "merge: could not remove the installation from the master index"
            );
        }
    }
    if rows.is_empty() {
        return Ok(ignored("untracked_installation"));
    }
    let events = rows
        .iter()
        .map(|row| {
            let old = previous
                .get(text(row, "id"))
                .cloned()
                .unwrap_or(Value::Null);
            let changes = (old != row["status"]).then(|| {
                let mut changes = Map::new();
                changes.insert(
                    "status".to_owned(),
                    json!({ "old": old, "new": row["status"] }),
                );
                changes
            });
            PendingEvent::new(
                "merge_connection",
                "updated",
                text(row, "id"),
                connection_event_data(row),
            )
            .with_changes(changes)
        })
        .collect();
    Ok(applied(events))
}

/// `handleGithubIssueSyncEvent(db, envelope, hooks)`: GitHub `issues`,
/// `issue_comment` and `installation` events.
pub(crate) async fn handle_github_event(
    db: &PgPool,
    event: &str,
    payload: &Map<String, Value>,
    hooks: Option<&HookContext>,
) -> Result<Outcome, MergeError> {
    match event {
        "issues" => issues_event(db, payload, hooks).await,
        "issue_comment" => issue_comment_event(db, payload, hooks).await,
        "installation" => installation_event(db, payload, hooks).await,
        _ => Ok(ignored("unsupported_event")),
    }
}
