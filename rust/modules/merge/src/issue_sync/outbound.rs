//! WeldMerge to provider (`services/issue-sync/outbound.ts`): pushes an
//! issue change or a comment through the repository's issue adapter,
//! creates a provider issue from a WeldMerge one, and unlinks.
//!
//! Every push runs inside the request that caused it (so conformance sees
//! the calls) and stores the new `merge_external_issues.checksum`, taken
//! from the provider's own answer, before the webhook echo can arrive.
//! Failures are errors: the automatic hooks log them, the explicit routes
//! answer 502 `provider_error`.

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::Value;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{merge_comments, merge_external_issues};

use super::fields::{checksum_of, provider_fields, status_to_provider_state};
use super::people::{host_of, label_names, login_for_member};
use super::targets::{SyncTarget, find_link_by_issue, load_target};
use crate::credentials::adapter_context;
use crate::db::{Row, instant_opt, int4, json_row, now_at, opt_text, text};
use crate::providers::{self, IssueWriteInput, NormalizedIssue, RepositoryRef};
use crate::{MergeError, MergeState, Overrides};

/// The synced fields a WeldMerge edit touches.
const SYNCED_ISSUE_FIELDS: [&str; 5] = [
    "title",
    "description",
    "status",
    "labelIds",
    "assigneeUserId",
];

/// `syncedFieldsChanged(before, after)`.
fn synced_fields_changed(before: &Row, after: &Row) -> bool {
    SYNCED_ISSUE_FIELDS.iter().any(|field| {
        let old = before.get(*field).cloned().unwrap_or(Value::Null);
        let new = after.get(*field).cloned().unwrap_or(Value::Null);
        old != new
    })
}

/// `twoWayTarget(db, link)`: the link's repository when it syncs two ways
/// and its connection is live.
async fn two_way_target(
    db: &PgPool,
    link: Option<&Row>,
) -> Result<Option<SyncTarget>, DbErr> {
    let Some(link) = link else {
        return Ok(None);
    };
    Ok(load_target(db, text(link, "repositoryId"))
        .await?
        .filter(|target| text(&target.repository, "issueSync") == "two_way"))
}

async fn store_pushed(db: &PgPool, link: &Row, issue: &NormalizedIssue) -> Result<(), DbErr> {
    let (_, at) = now_at();
    let url = if issue.url.is_empty() {
        text(link, "url").to_owned()
    } else {
        issue.url.clone()
    };
    merge_external_issues::Entity::update_many()
        .col_expr(merge_external_issues::Column::Url, Expr::value(url))
        .col_expr(merge_external_issues::Column::State, Expr::value(issue.state))
        .col_expr(
            merge_external_issues::Column::Checksum,
            Expr::value(checksum_of(&provider_fields(issue))),
        )
        .col_expr(
            merge_external_issues::Column::LastWriter,
            Expr::value("weldmerge"),
        )
        .col_expr(
            merge_external_issues::Column::ProviderUpdatedAt,
            Expr::value(instant_opt(issue.updated_at.as_deref())?),
        )
        .col_expr(merge_external_issues::Column::SyncedAt, Expr::value(at))
        .col_expr(merge_external_issues::Column::UpdatedAt, Expr::value(at))
        .filter(merge_external_issues::Column::Id.eq(text(link, "id")))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// When to send the assignee (`writeInput`'s `assignee`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Assignee {
    Always,
    IfSet,
    Skip,
}

/// `writeInput(db, target, issue, assignee)`: every synced field; the
/// assignee only when it changed (or on create). An assignee without a
/// linked account cannot be named on the provider: the provider's is left
/// alone.
async fn write_input(
    db: &PgPool,
    target: &SyncTarget,
    issue: &Row,
    assignee: Assignee,
) -> Result<IssueWriteInput, DbErr> {
    let label_ids: Vec<String> = issue
        .get("labelIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let (state, state_reason) = status_to_provider_state(text(issue, "status"));
    let mut input = IssueWriteInput {
        title: Some(text(issue, "title").to_owned()),
        body: Some(opt_text(issue, "description").unwrap_or_default()),
        state: Some(state),
        state_reason: Some(state_reason),
        labels: Some(label_names(db, &label_ids).await?),
        assignee_login: None,
    };
    if assignee == Assignee::Skip {
        return Ok(input);
    }
    let assignee_id = opt_text(issue, "assigneeUserId");
    let login = match &assignee_id {
        Some(user_id) => {
            login_for_member(
                db,
                text(&target.repository, "provider"),
                host_of(&target.connection).as_deref(),
                user_id,
            )
            .await?
        }
        None => None,
    };
    if login.is_some() || (assignee == Assignee::Always && assignee_id.is_none()) {
        input.assignee_login = Some(login);
    }
    Ok(input)
}

/// `pushIssueUpdate(db, env, before, after)`: a member's edit of a linked
/// issue, pushed when its repository is `two_way`. Nothing for an unlinked
/// issue, a one-way repository, or an edit of no synced field.
pub(crate) async fn push_issue_update(
    db: &PgPool,
    state: &MergeState,
    overrides: &Overrides,
    before: &Row,
    after: &Row,
) -> Result<bool, MergeError> {
    if !synced_fields_changed(before, after) {
        return Ok(false);
    }
    let link = find_link_by_issue(db, text(after, "id")).await?;
    let target = two_way_target(db, link.as_ref()).await?;
    let (Some(link), Some(target)) = (link, target) else {
        return Ok(false);
    };
    let assignee = if before.get("assigneeUserId") == after.get("assigneeUserId") {
        Assignee::Skip
    } else {
        Assignee::Always
    };
    let input = write_input(db, &target, after, assignee).await?;
    let ctx = adapter_context(db, state, overrides, &target.connection, None).await?;
    let number = link
        .get("number")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let updated =
        providers::update_issue(&ctx, &RepositoryRef::of(&target.repository), number, &input)
            .await?;
    store_pushed(db, &link, &updated).await?;
    Ok(true)
}

/// `pushComment(db, env, comment, issue)`: a comment a member wrote on a
/// linked issue, pushed to the provider (its provider id is stored on the
/// comment, so the webhook echo is recognised).
pub(crate) async fn push_comment(
    db: &PgPool,
    state: &MergeState,
    overrides: &Overrides,
    comment: &Row,
    issue: &Row,
) -> Result<bool, MergeError> {
    if text(comment, "source") == "provider" || opt_text(comment, "externalId").is_some() {
        return Ok(false);
    }
    let link = find_link_by_issue(db, text(issue, "id")).await?;
    let target = two_way_target(db, link.as_ref()).await?;
    let (Some(link), Some(target)) = (link, target) else {
        return Ok(false);
    };
    let ctx = adapter_context(db, state, overrides, &target.connection, None).await?;
    let number = link
        .get("number")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let pushed = providers::create_comment(
        &ctx,
        &RepositoryRef::of(&target.repository),
        number,
        text(comment, "body"),
    )
    .await?;
    merge_comments::Entity::update_many()
        .col_expr(
            merge_comments::Column::ExternalId,
            Expr::value(pushed.external_id.clone()),
        )
        .filter(merge_comments::Column::Id.eq(text(comment, "id")))
        .exec(&orm(db))
        .await?;
    Ok(true)
}

/// Why `createExternalIssue` did not link.
pub(crate) enum CreateExternal {
    Linked {
        link: Row,
        repository_full_name: String,
    },
    AlreadyLinked,
    RepositoryNotFound,
    Unsupported,
}

/// `createExternalIssue(db, env, issue, repositoryId)`: creates the provider
/// issue for a WeldMerge issue (every synced field, closed when the issue is
/// done or canceled) and links it.
pub(crate) async fn create_external_issue(
    db: &PgPool,
    state: &MergeState,
    overrides: &Overrides,
    issue: &Row,
    repository_id: &str,
) -> Result<CreateExternal, MergeError> {
    if find_link_by_issue(db, text(issue, "id")).await?.is_some() {
        return Ok(CreateExternal::AlreadyLinked);
    }
    let Some(target) = load_target(db, repository_id).await? else {
        return Ok(CreateExternal::RepositoryNotFound);
    };
    if !providers::has_issues(text(&target.repository, "provider")) {
        return Ok(CreateExternal::Unsupported);
    }
    let input = write_input(db, &target, issue, Assignee::IfSet).await?;
    let ctx = adapter_context(db, state, overrides, &target.connection, None).await?;
    let created =
        providers::create_issue(&ctx, &RepositoryRef::of(&target.repository), input).await?;
    let (_, at) = now_at();
    let row = merge_external_issues::Entity::insert(merge_external_issues::ActiveModel {
        id: Set(generate_id("mxi")),
        issue_id: Set(text(issue, "id").to_owned()),
        repository_id: Set(text(&target.repository, "id").to_owned()),
        provider: Set(text(&target.repository, "provider").to_owned()),
        external_id: Set(created.external_id.clone()),
        number: Set(int4(created.number)?),
        url: Set(created.url.clone()),
        state: Set(created.state.to_owned()),
        checksum: Set(checksum_of(&provider_fields(&created))),
        last_writer: Set("weldmerge".to_owned()),
        provider_updated_at: Set(instant_opt(created.updated_at.as_deref())?),
        synced_at: Set(at),
        created_at: Set(at),
        updated_at: Set(at),
    })
    .exec_with_returning(&orm(db))
    .await?;
    Ok(CreateExternal::Linked {
        link: json_row(serde_json::to_value(row))?,
        repository_full_name: text(&target.repository, "fullName").to_owned(),
    })
}

/// `removeExternalIssue(db, issueId)`: stops syncing; the provider issue
/// stays. `false` when it was not linked.
pub(crate) async fn remove_external_issue(
    db: &PgPool,
    issue_id: &str,
) -> Result<bool, DbErr> {
    let Some(link) = find_link_by_issue(db, issue_id).await? else {
        return Ok(false);
    };
    merge_external_issues::Entity::delete_by_id(text(&link, "id").to_owned())
        .exec(&orm(db))
        .await?;
    Ok(true)
}
