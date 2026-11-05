//! Provider to WeldMerge (`services/issue-sync/inbound.ts`): a provider
//! issue or comment (from a webhook, or read by an import) applied to
//! WeldMerge's own records. Provider-agnostic: GitHub's and GitLab's events
//! go through the same functions.
//!
//! - an inbound issue whose checksum equals the stored one is an echo of our
//!   own push and is ignored; one older than the stored
//!   `provider_updated_at` is stale;
//! - closed maps to `done` (`canceled` for `not_planned`), a reopen to `todo`;
//! - labels by name (missing ones become team labels), assignee by linked
//!   account;
//! - provider comments are stored with `source = provider`.
//!
//! Nothing here publishes: every function answers the entity events it
//! caused and the caller publishes them (`system` source for webhooks).

use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Issues, js_date_parse};

use super::fields::{checksum_of, provider_fields, provider_state_to_status};
use super::people::{host_of, member_for_login, resolve_assignee, resolve_label_ids};
use super::targets::{SyncTarget, find_link_by_number};
use crate::db::{Row, col, opt_text, text};
use crate::hooks::HookContext;
use crate::issues::{
    CreateFailure, ISSUE_CHANGE_FIELDS, RefFailure, UpdateFailure, create_issue, diff_fields,
    find_issue, read_issue_input, update_issue,
};
use crate::mappers::issue_event_data;
use crate::providers::{NormalizedIssue, NormalizedIssueComment};
use crate::{MergeError, PendingEvent, chat, now};

/// What the inbound functions act on (`InboundContext`). `hooks` runs the
/// chat hooks after a write (left out for bulk imports).
pub(crate) struct InboundContext<'a> {
    pub(crate) db: &'a PgPool,
    pub(crate) target: &'a SyncTarget,
    /// Who new issues are created by: `system` for webhooks, the member for an import.
    pub(crate) user_id: &'a str,
    pub(crate) hooks: Option<&'a HookContext>,
}

/// `InboundOutcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    Created,
    Updated,
    Unchanged,
    Ignored,
}

/// `InboundResult`.
pub(crate) struct InboundResult {
    pub(crate) outcome: Outcome,
    pub(crate) reason: Option<String>,
    pub(crate) events: Vec<PendingEvent>,
}

const MAX_TITLE: usize = 500;
const MAX_DESCRIPTION: usize = 100_000;
const MAX_LABELS: usize = 20;

fn ignored(reason: &str) -> InboundResult {
    InboundResult {
        outcome: Outcome::Ignored,
        reason: Some(reason.to_owned()),
        events: Vec::new(),
    }
}

/// `syncsInbound(repository)`: `import` and `two_way` take provider changes in.
pub(crate) fn syncs_inbound(repository: &Row) -> bool {
    matches!(text(repository, "issueSync"), "import" | "two_way")
}

/// `str.slice(0, n)` by characters.
fn truncate(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// An issue's input as `read_issue_input` reads a body.
fn issue_input(fields: &Map<String, Value>, partial: bool) -> crate::issues::IssueInput {
    let mut issues = Issues::default();
    read_issue_input(&mut issues, fields, partial)
}

fn ref_reason(failure: RefFailure) -> &'static str {
    match failure {
        RefFailure::Cycle => "cycle_invalid",
        RefFailure::Parent => "parent_invalid",
        RefFailure::Labels => "labels_invalid",
    }
}

/// `new Date(x).getTime()` of a stored or provider time.
fn millis(value: Option<&str>) -> Option<f64> {
    value.and_then(js_date_parse)
}

async fn chat_after_created(ctx: &InboundContext<'_>, issue: &Row, team_key: &str) {
    if let Some(hooks) = ctx.hooks
        && let Err(error) = chat::hooks::after_issue_created(hooks, issue, team_key).await
    {
        tracing::error!(?error, "merge: hook chat.afterIssueCreated failed");
    }
}

async fn chat_after_updated(ctx: &InboundContext<'_>, before: &Row, after: &Row, team_key: &str) {
    if let Some(hooks) = ctx.hooks
        && let Err(error) = chat::hooks::after_issue_updated(hooks, before, after, team_key).await
    {
        tracing::error!(?error, "merge: hook chat.afterIssueUpdated failed");
    }
}

async fn create_from_provider(
    ctx: &InboundContext<'_>,
    issue: &NormalizedIssue,
    checksum: &str,
) -> Result<InboundResult, MergeError> {
    let repository = &ctx.target.repository;
    let Some(team_id) = opt_text(repository, "teamId") else {
        return Ok(ignored("no_team"));
    };
    let provider = text(repository, "provider");
    let host = host_of(&ctx.target.connection);
    let (label_ids, label_events) = resolve_label_ids(ctx.db, &team_id, &issue.labels).await?;
    let assignee = match &issue.assignee_login {
        Some(login) => member_for_login(ctx.db, provider, host.as_deref(), login).await?,
        None => None,
    };
    let title = truncate(weldsuite_kit::validation::js_trim(&issue.title), MAX_TITLE);
    let mut fields = Map::new();
    fields.insert("teamId".into(), json!(team_id));
    fields.insert(
        "title".into(),
        json!(if title.is_empty() {
            "Untitled".to_owned()
        } else {
            title
        }),
    );
    fields.insert(
        "description".into(),
        json!(truncate(&issue.body, MAX_DESCRIPTION)),
    );
    fields.insert(
        "status".into(),
        json!(provider_state_to_status(
            issue.state,
            issue.state_reason,
            None
        )),
    );
    fields.insert(
        "labelIds".into(),
        json!(label_ids.iter().take(MAX_LABELS).collect::<Vec<_>>()),
    );
    fields.insert("assigneeUserId".into(), json!(assignee));
    let created = match create_issue(ctx.db, issue_input(&fields, false), ctx.user_id).await? {
        Ok(created) => created,
        Err(CreateFailure::TeamNotFound) => return Ok(ignored("team_not_found")),
        Err(CreateFailure::Ref(failure)) => return Ok(ignored(ref_reason(failure))),
    };
    let now = now();
    sqlx::query(
        "insert into merge_external_issues (id, issue_id, repository_id, provider, external_id, number, url, \
           state, checksum, last_writer, provider_updated_at, synced_at, updated_at, created_at) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'provider', $10::timestamptz, $11::timestamptz, \
           $11::timestamptz, $11::timestamptz)",
    )
    .bind(generate_id("mxi"))
    .bind(text(&created.issue, "id"))
    .bind(text(repository, "id"))
    .bind(provider)
    .bind(&issue.external_id)
    .bind(issue.number)
    .bind(&issue.url)
    .bind(issue.state)
    .bind(checksum)
    .bind(&issue.updated_at)
    .bind(&now)
    .execute(ctx.db)
    .await?;
    let team_key = text(&created.team, "key").to_owned();
    chat_after_created(ctx, &created.issue, &team_key).await;
    let mut events = label_events;
    events.push(PendingEvent::new(
        "merge_issue",
        "created",
        text(&created.issue, "id"),
        issue_event_data(&created.issue, &team_key, None),
    ));
    Ok(InboundResult {
        outcome: Outcome::Created,
        reason: None,
        events,
    })
}

async fn update_from_provider(
    ctx: &InboundContext<'_>,
    issue: &NormalizedIssue,
    checksum: &str,
    before: &Row,
) -> Result<InboundResult, MergeError> {
    let repository = &ctx.target.repository;
    let provider = text(repository, "provider");
    let host = host_of(&ctx.target.connection);
    let (label_ids, label_events) =
        resolve_label_ids(ctx.db, text(before, "teamId"), &issue.labels).await?;
    let current_assignee = opt_text(before, "assigneeUserId");
    let assignee = resolve_assignee(
        ctx.db,
        provider,
        host.as_deref(),
        issue.assignee_login.as_deref(),
        current_assignee.as_deref(),
    )
    .await?;
    let trimmed = truncate(weldsuite_kit::validation::js_trim(&issue.title), MAX_TITLE);
    let title = if trimmed.is_empty() {
        text(before, "title").to_owned()
    } else {
        trimmed
    };
    let description = truncate(&issue.body, MAX_DESCRIPTION);
    let status = provider_state_to_status(
        issue.state,
        issue.state_reason,
        Some(text(before, "status")),
    );
    let label_ids: Vec<String> = label_ids.into_iter().take(MAX_LABELS).collect();
    let mut sorted_new = label_ids.clone();
    sorted_new.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let mut sorted_old: Vec<String> = before
        .get("labelIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    sorted_old.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));

    let mut patch = Map::new();
    if title != text(before, "title") {
        patch.insert("title".into(), json!(title));
    }
    if description != opt_text(before, "description").unwrap_or_default() {
        patch.insert("description".into(), json!(description));
    }
    if status != text(before, "status") {
        patch.insert("status".into(), json!(status));
    }
    if sorted_new != sorted_old {
        patch.insert("labelIds".into(), json!(label_ids));
    }
    if assignee != current_assignee {
        patch.insert("assigneeUserId".into(), json!(assignee));
    }

    let mut events = label_events;
    let mut outcome = Outcome::Unchanged;
    if !patch.is_empty() {
        let id = text(before, "id").to_owned();
        let updated = match update_issue(ctx.db, &id, &issue_input(&patch, true)).await? {
            Ok(updated) => updated,
            Err(UpdateFailure::NotFound) => return Ok(ignored("not_found")),
            Err(UpdateFailure::Ref(failure)) => return Ok(ignored(ref_reason(failure))),
        };
        let changes = diff_fields(before, &updated.issue, &ISSUE_CHANGE_FIELDS);
        events.push(
            PendingEvent::new(
                "merge_issue",
                "updated",
                text(&updated.issue, "id"),
                issue_event_data(&updated.issue, &updated.team_key, None),
            )
            .with_changes(changes),
        );
        chat_after_updated(ctx, before, &updated.issue, &updated.team_key).await;
        outcome = Outcome::Updated;
    }
    write_link(ctx.db, text(repository, "id"), issue, checksum).await?;
    Ok(InboundResult {
        outcome,
        reason: None,
        events,
    })
}

/// `linkValues(issue, checksum, now)` onto the link of the issue's number.
async fn write_link(
    db: &PgPool,
    repository_id: &str,
    issue: &NormalizedIssue,
    checksum: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update merge_external_issues set external_id = $3, number = $4, url = $5, state = $6, checksum = $7, \
           last_writer = 'provider', provider_updated_at = $8::timestamptz, synced_at = $9::timestamptz, \
           updated_at = $9::timestamptz \
         where repository_id = $1 and number = $2",
    )
    .bind(repository_id)
    .bind(issue.number)
    .bind(&issue.external_id)
    .bind(issue.number)
    .bind(&issue.url)
    .bind(issue.state)
    .bind(checksum)
    .bind(&issue.updated_at)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

/// `applyInboundIssue(ctx, issue, { create })`: one provider issue. With
/// `create`, an issue WeldMerge does not know becomes a new issue in the
/// repository's team; otherwise it is ignored (`unlinked_issue`).
pub(crate) async fn apply_inbound_issue(
    ctx: &InboundContext<'_>,
    issue: &NormalizedIssue,
    create: bool,
) -> Result<InboundResult, MergeError> {
    if !syncs_inbound(&ctx.target.repository) {
        return Ok(ignored("issue_sync_off"));
    }
    let checksum = checksum_of(&provider_fields(issue));
    let link =
        find_link_by_number(ctx.db, text(&ctx.target.repository, "id"), issue.number).await?;
    let Some(link) = link else {
        return if create {
            create_from_provider(ctx, issue, &checksum).await
        } else {
            Ok(ignored("unlinked_issue"))
        };
    };
    if text(&link, "checksum") == checksum {
        return Ok(ignored("echo"));
    }
    if let (Some(stored), Some(incoming)) = (
        millis(link.get("providerUpdatedAt").and_then(Value::as_str)),
        millis(issue.updated_at.as_deref()),
    ) && incoming < stored
    {
        return Ok(ignored("stale"));
    }
    let Some(before) = find_issue(ctx.db, text(&link, "issueId")).await? else {
        return Ok(ignored("issue_deleted"));
    };
    update_from_provider(ctx, issue, &checksum, &before).await
}

/// `unlinkProviderIssue(ctx, number)`: the provider issue was deleted or
/// moved away; WeldMerge keeps its issue and drops the link.
pub(crate) async fn unlink_provider_issue(
    ctx: &InboundContext<'_>,
    number: i64,
) -> Result<InboundResult, MergeError> {
    let Some(link) =
        find_link_by_number(ctx.db, text(&ctx.target.repository, "id"), number).await?
    else {
        return Ok(ignored("unlinked_issue"));
    };
    sqlx::query("delete from merge_external_issues where id = $1")
        .bind(text(&link, "id"))
        .execute(ctx.db)
        .await?;
    Ok(InboundResult {
        outcome: Outcome::Updated,
        reason: None,
        events: Vec::new(),
    })
}

fn comment_event(row: &Row, action: &'static str) -> PendingEvent {
    PendingEvent::new(
        "merge_comment",
        action,
        text(row, "id"),
        json!({ "id": row["id"], "issueId": row["issueId"], "authorUserId": col(row, "authorUserId") }),
    )
}

/// `applyInboundComment(ctx, action, comment)`: created (stored with
/// `source = provider`; one already stored, such as one we pushed, is
/// ignored), edited (body updated, stored if unknown) or deleted (soft
/// delete).
pub(crate) async fn apply_inbound_comment(
    ctx: &InboundContext<'_>,
    action: &str,
    comment: &NormalizedIssueComment,
) -> Result<InboundResult, MergeError> {
    let repository = &ctx.target.repository;
    if !syncs_inbound(repository) {
        return Ok(ignored("issue_sync_off"));
    }
    let Some(link) =
        find_link_by_number(ctx.db, text(repository, "id"), comment.issue_number).await?
    else {
        return Ok(ignored("unlinked_issue"));
    };
    let issue_id = text(&link, "issueId").to_owned();
    if find_issue(ctx.db, &issue_id).await?.is_none() {
        return Ok(ignored("issue_deleted"));
    }
    let existing: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(c) from merge_comments c where c.issue_id = $1 and c.external_id = $2 limit 1",
    )
    .bind(&issue_id)
    .bind(&comment.external_id)
    .fetch_optional(ctx.db)
    .await?;
    let existing = existing.map(js_row);
    let now = now();

    if action == "deleted" {
        let Some(existing) = existing.filter(|c| c["deletedAt"].is_null()) else {
            return Ok(ignored("unknown_comment"));
        };
        let row: Value = sqlx::query_scalar(
            "update merge_comments set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
             where id = $1 returning to_jsonb(merge_comments.*)",
        )
        .bind(text(&existing, "id"))
        .bind(&now)
        .fetch_one(ctx.db)
        .await?;
        return Ok(InboundResult {
            outcome: Outcome::Updated,
            reason: None,
            events: vec![comment_event(&js_row(row), "deleted")],
        });
    }

    if let Some(existing) = existing {
        if action == "created" || text(&existing, "body") == comment.body {
            return Ok(ignored("echo"));
        }
        let row: Value = sqlx::query_scalar(
            "update merge_comments set body = $2, updated_at = $3::timestamptz \
             where id = $1 returning to_jsonb(merge_comments.*)",
        )
        .bind(text(&existing, "id"))
        .bind(&comment.body)
        .bind(&now)
        .fetch_one(ctx.db)
        .await?;
        return Ok(InboundResult {
            outcome: Outcome::Updated,
            reason: None,
            events: vec![comment_event(&js_row(row), "updated")],
        });
    }

    let author = match &comment.author_login {
        Some(login) => {
            member_for_login(
                ctx.db,
                text(repository, "provider"),
                host_of(&ctx.target.connection).as_deref(),
                login,
            )
            .await?
        }
        None => None,
    };
    let row: Value = sqlx::query_scalar(
        "insert into merge_comments (id, issue_id, author_user_id, body, external_id, external_author_login, \
           external_author_avatar_url, source, created_at, updated_at) \
         values ($1, $2, $3, $4, $5, $6, $7, 'provider', $8::timestamptz, $9::timestamptz) \
         returning to_jsonb(merge_comments.*)",
    )
    .bind(generate_id("mcm"))
    .bind(&issue_id)
    .bind(author)
    .bind(&comment.body)
    .bind(&comment.external_id)
    .bind(&comment.author_login)
    .bind(&comment.author_avatar_url)
    .bind(&comment.created_at)
    .bind(&now)
    .fetch_one(ctx.db)
    .await?;
    Ok(InboundResult {
        outcome: Outcome::Created,
        reason: None,
        events: vec![comment_event(&js_row(row), "created")],
    })
}

/// `ImportCounts`.
#[derive(Debug, Default)]
pub(crate) struct ImportCounts {
    pub(crate) imported: usize,
    pub(crate) updated: usize,
    pub(crate) skipped: usize,
}

/// `importProviderIssues(ctx, issues)`: new ones created, known ones
/// refreshed, echoes and unchanged ones skipped. No chat hooks.
pub(crate) async fn import_provider_issues(
    ctx: &InboundContext<'_>,
    issues: &[NormalizedIssue],
) -> Result<(ImportCounts, Vec<PendingEvent>), MergeError> {
    let mut counts = ImportCounts::default();
    let mut events = Vec::new();
    for issue in issues {
        let result = apply_inbound_issue(ctx, issue, true).await?;
        events.extend(result.events);
        match result.outcome {
            Outcome::Created => counts.imported += 1,
            Outcome::Updated => counts.updated += 1,
            Outcome::Unchanged | Outcome::Ignored => counts.skipped += 1,
        }
    }
    Ok((counts, events))
}
