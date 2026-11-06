//! WeldMerge to provider (`services/issue-sync/outbound.ts`): pushes an
//! issue change or a comment through the repository's issue adapter,
//! creates a provider issue from a WeldMerge one, and unlinks.
//!
//! Every push runs inside the request that caused it (so conformance sees
//! the calls) and stores the new `merge_external_issues.checksum`, taken
//! from the provider's own answer, before the webhook echo can arrive.
//! Failures are errors: the automatic hooks log them, the explicit routes
//! answer 502 `provider_error`.

use serde_json::Value;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::generate_id;

use super::fields::{checksum_of, provider_fields, status_to_provider_state};
use super::people::{host_of, label_names, login_for_member};
use super::targets::{SyncTarget, find_link_by_issue, load_target};
use crate::credentials::adapter_context;
use crate::db::{Row, opt_text, text};
use crate::providers::{self, IssueWriteInput, NormalizedIssue, RepositoryRef};
use crate::{MergeError, MergeState, Overrides, now};

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
) -> Result<Option<SyncTarget>, sqlx::Error> {
    let Some(link) = link else {
        return Ok(None);
    };
    Ok(load_target(db, text(link, "repositoryId"))
        .await?
        .filter(|target| text(&target.repository, "issueSync") == "two_way"))
}

async fn store_pushed(db: &PgPool, link: &Row, issue: &NormalizedIssue) -> Result<(), sqlx::Error> {
    let now = now();
    let url = if issue.url.is_empty() {
        text(link, "url").to_owned()
    } else {
        issue.url.clone()
    };
    sqlx::query(
        "update merge_external_issues set url = $2, state = $3, checksum = $4, last_writer = 'weldmerge', \
           provider_updated_at = $5::timestamptz, synced_at = $6::timestamptz, updated_at = $6::timestamptz \
         where id = $1",
    )
    .bind(text(link, "id"))
    .bind(url)
    .bind(issue.state)
    .bind(checksum_of(&provider_fields(issue)))
    .bind(&issue.updated_at)
    .bind(&now)
    .execute(db)
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
) -> Result<IssueWriteInput, sqlx::Error> {
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
    sqlx::query("update merge_comments set external_id = $2 where id = $1")
        .bind(text(comment, "id"))
        .bind(&pushed.external_id)
        .execute(db)
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
    let now = now();
    let row: Value = sqlx::query_scalar(
        "insert into merge_external_issues (id, issue_id, repository_id, provider, external_id, number, url, \
           state, checksum, last_writer, provider_updated_at, synced_at, created_at, updated_at) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'weldmerge', $10::timestamptz, $11::timestamptz, \
           $11::timestamptz, $11::timestamptz) \
         returning to_jsonb(merge_external_issues.*)",
    )
    .bind(generate_id("mxi"))
    .bind(text(issue, "id"))
    .bind(text(&target.repository, "id"))
    .bind(text(&target.repository, "provider"))
    .bind(&created.external_id)
    .bind(created.number)
    .bind(&created.url)
    .bind(created.state)
    .bind(checksum_of(&provider_fields(&created)))
    .bind(&created.updated_at)
    .bind(&now)
    .fetch_one(db)
    .await?;
    Ok(CreateExternal::Linked {
        link: js_row(row),
        repository_full_name: text(&target.repository, "fullName").to_owned(),
    })
}

/// `removeExternalIssue(db, issueId)`: stops syncing; the provider issue
/// stays. `false` when it was not linked.
pub(crate) async fn remove_external_issue(
    db: &PgPool,
    issue_id: &str,
) -> Result<bool, sqlx::Error> {
    let Some(link) = find_link_by_issue(db, issue_id).await? else {
        return Ok(false);
    };
    sqlx::query("delete from merge_external_issues where id = $1")
        .bind(text(&link, "id"))
        .execute(db)
        .await?;
    Ok(true)
}
