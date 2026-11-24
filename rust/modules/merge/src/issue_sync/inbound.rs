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

use sea_orm::ActiveValue::{Set, Unchanged};
use sea_orm::sea_query::Expr;
use sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Issues, js_date_parse};
use weldsuite_schema::tenant::{merge_comments, merge_external_issues};

use super::fields::{checksum_of, provider_fields, provider_state_to_status};
use super::people::{host_of, member_for_login, resolve_assignee, resolve_label_ids};
use super::targets::{SyncTarget, find_link_by_number};
use crate::comments::{comment_row, soft_delete_comment};
use crate::db::{Row, col, instant_opt, int4, now_at, opt_text, required, text};
use crate::hooks::HookContext;
use crate::issues::{
    CreateFailure, ISSUE_CHANGE_FIELDS, RefFailure, UpdateFailure, create_issue, diff_fields,
    find_issue, read_issue_input, update_issue,
};
use crate::mappers::issue_event_data;
use crate::providers::{NormalizedIssue, NormalizedIssueComment};
use crate::{MergeError, PendingEvent, chat};

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
    let (_, at) = now_at();
    merge_external_issues::Entity::insert(merge_external_issues::ActiveModel {
        id: Set(generate_id("mxi")),
        issue_id: Set(text(&created.issue, "id").to_owned()),
        repository_id: Set(text(repository, "id").to_owned()),
        provider: Set(provider.to_owned()),
        external_id: Set(issue.external_id.clone()),
        number: Set(int4(issue.number)?),
        url: Set(issue.url.clone()),
        state: Set(issue.state.to_owned()),
        checksum: Set(checksum.to_owned()),
        last_writer: Set("provider".to_owned()),
        provider_updated_at: Set(instant_opt(issue.updated_at.as_deref())?),
        synced_at: Set(at),
        updated_at: Set(at),
        created_at: Set(at),
    })
    .exec_without_returning(&orm(ctx.db))
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
        // A provider's patch never names an agent: no assigner.
        let updated = match update_issue(ctx.db, &id, &issue_input(&patch, true), None).await? {
            Ok(updated) => updated,
            Err(UpdateFailure::NotFound) => return Ok(ignored("not_found")),
            Err(UpdateFailure::Ref(failure)) => return Ok(ignored(ref_reason(failure))),
            Err(UpdateFailure::Agent) => return Ok(ignored("agent_invalid")),
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
) -> Result<(), DbErr> {
    let (_, at) = now_at();
    merge_external_issues::Entity::update_many()
        .col_expr(
            merge_external_issues::Column::ExternalId,
            Expr::value(issue.external_id.clone()),
        )
        .col_expr(
            merge_external_issues::Column::Number,
            Expr::value(int4(issue.number)?),
        )
        .col_expr(
            merge_external_issues::Column::Url,
            Expr::value(issue.url.clone()),
        )
        .col_expr(
            merge_external_issues::Column::State,
            Expr::value(issue.state),
        )
        .col_expr(
            merge_external_issues::Column::Checksum,
            Expr::value(checksum),
        )
        .col_expr(
            merge_external_issues::Column::LastWriter,
            Expr::value("provider"),
        )
        .col_expr(
            merge_external_issues::Column::ProviderUpdatedAt,
            Expr::value(instant_opt(issue.updated_at.as_deref())?),
        )
        .col_expr(merge_external_issues::Column::SyncedAt, Expr::value(at))
        .col_expr(merge_external_issues::Column::UpdatedAt, Expr::value(at))
        .filter(merge_external_issues::Column::RepositoryId.eq(repository_id))
        .filter(merge_external_issues::Column::Number.eq(issue.number))
        .exec(&orm(db))
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
    merge_external_issues::Entity::delete_by_id(text(&link, "id").to_owned())
        .exec(&orm(ctx.db))
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
    let db = orm(ctx.db);
    let existing = merge_comments::Entity::find()
        .filter(merge_comments::Column::IssueId.eq(&issue_id))
        .filter(merge_comments::Column::ExternalId.eq(&comment.external_id))
        .one(&db)
        .await?
        .map(comment_row)
        .transpose()?;
    let (_, at) = now_at();

    if action == "deleted" {
        let Some(existing) = existing.filter(|c| c["deletedAt"].is_null()) else {
            return Ok(ignored("unknown_comment"));
        };
        let row = soft_delete_comment(ctx.db, text(&existing, "id")).await?;
        return Ok(InboundResult {
            outcome: Outcome::Updated,
            reason: None,
            events: vec![comment_event(&row, "deleted")],
        });
    }

    if let Some(existing) = existing {
        if action == "created" || text(&existing, "body") == comment.body {
            return Ok(ignored("echo"));
        }
        let row = comment_row(
            merge_comments::ActiveModel {
                id: Unchanged(text(&existing, "id").to_owned()),
                body: Set(comment.body.clone()),
                updated_at: Set(at),
                ..Default::default()
            }
            .update(&db)
            .await?,
        )?;
        return Ok(InboundResult {
            outcome: Outcome::Updated,
            reason: None,
            events: vec![comment_event(&row, "updated")],
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
    let row = comment_row(
        merge_comments::Entity::insert(merge_comments::ActiveModel {
            id: Set(generate_id("mcm")),
            issue_id: Set(issue_id),
            author_user_id: Set(author),
            body: Set(comment.body.clone()),
            external_id: Set(Some(comment.external_id.clone())),
            external_author_login: Set(comment.author_login.clone()),
            external_author_avatar_url: Set(comment.author_avatar_url.clone()),
            source: Set("provider".to_owned()),
            // An invalid provider time was a null Postgres refused.
            created_at: Set(required(
                instant_opt(comment.created_at.as_deref())?,
                "created_at",
            )?),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_with_returning(&db)
        .await?,
    )?;
    Ok(InboundResult {
        outcome: Outcome::Created,
        reason: None,
        events: vec![comment_event(&row, "created")],
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
