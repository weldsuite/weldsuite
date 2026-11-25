//! Comments on an issue. Listing and creating live under the issue
//! (`/api/merge/issues/:id/comments`); editing and deleting at
//! `/api/merge/comments/:id`:
//!
//! ```text
//!   PATCH  /:id → edit; the author only                        (merge_issues:update)
//!   DELETE /:id → the author's own with merge_issues:update; anyone's with merge_issues:delete
//! ```

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::IntoResponse;
use http::HeaderMap;
use sea_orm::ActiveValue::{Set, Unchanged};
use sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde_json::json;
use weldsuite_catalogs::permission_keys::MERGE_ISSUES_DELETE;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::merge_comments;

use crate::db::{Row, json_row, json_rows, now_at, text};
use crate::hooks::{CommentChange, after_comment_changed};
use crate::issues::{find_issue, team_key_of};
use crate::mappers::comment_dto;
use crate::{Answer, Caller, MergeState, PendingEvent, Refusal, all, publish, validate};

fn comment_event(row: &Row, action: &'static str) -> PendingEvent {
    PendingEvent::new(
        "merge_comment",
        action,
        text(row, "id"),
        json!({ "id": row["id"], "issueId": row["issueId"], "authorUserId": row["authorUserId"] }),
    )
}

/// `createMergeCommentSchema` (and `updateMergeCommentSchema`, the same).
fn comment_body(headers: &HeaderMap, body: &Bytes) -> Result<String, Refusal> {
    validate(headers, body, |issues, fields| {
        issues
            .text_with(
                fields,
                "body",
                Presence::Required,
                Text::trimmed(Some(1), Some(50_000)),
            )
            .into_option()
            .unwrap_or_default()
    })
}

/// The hooks of a comment edit or delete (`publishCommentEvent`): with its
/// issue and team key, when the issue is still there.
async fn comment_hooks(
    state: &MergeState,
    caller: &Caller,
    change: CommentChange,
    comment: &Row,
) -> Result<(), DbErr> {
    let Some(issue) = find_issue(&caller.db, text(comment, "issueId")).await? else {
        return Ok(());
    };
    let team_key = team_key_of(&caller.db, text(&issue, "teamId")).await?;
    after_comment_changed(
        &caller.hook_context(state),
        change,
        comment,
        &issue,
        &team_key,
    )
    .await;
    Ok(())
}

/// A comment row as the services read it.
pub(crate) fn comment_row(comment: merge_comments::Model) -> Result<Row, DbErr> {
    json_row(serde_json::to_value(comment))
}

async fn find_comment(db: &PgPool, id: &str) -> Result<Option<Row>, DbErr> {
    merge_comments::Entity::find_by_id(id.to_owned())
        .filter(merge_comments::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(comment_row)
        .transpose()
}

/// An issue's live comments, oldest first.
pub(crate) async fn issue_comments(db: &PgPool, issue_id: &str) -> Result<Vec<Row>, DbErr> {
    json_rows(
        merge_comments::Entity::find()
            .filter(merge_comments::Column::IssueId.eq(issue_id))
            .filter(merge_comments::Column::DeletedAt.is_null())
            .order_by_asc(merge_comments::Column::CreatedAt)
            .order_by_asc(merge_comments::Column::Id)
            .all(&orm(db))
            .await?
            .into_iter()
            .map(serde_json::to_value),
    )
}

/// A member's comment on an issue (`body` trimmed), as written.
pub(crate) async fn insert_comment(
    db: &PgPool,
    issue_id: &str,
    author_user_id: &str,
    body: &str,
) -> Result<Row, DbErr> {
    let (_, at) = now_at();
    comment_row(
        merge_comments::Entity::insert(merge_comments::ActiveModel {
            id: Set(generate_id("mcm")),
            issue_id: Set(issue_id.to_owned()),
            author_user_id: Set(Some(author_user_id.to_owned())),
            body: Set(weldsuite_kit::validation::js_trim(body).to_owned()),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_with_returning(&orm(db))
        .await?,
    )
}

/// Soft-deletes a comment; the row as written.
pub(crate) async fn soft_delete_comment(db: &PgPool, id: &str) -> Result<Row, DbErr> {
    let (_, at) = now_at();
    comment_row(
        merge_comments::ActiveModel {
            id: Unchanged(id.to_owned()),
            deleted_at: Set(Some(at)),
            updated_at: Set(at),
            ..Default::default()
        }
        .update(&orm(db))
        .await?,
    )
}

/// `GET /issues/:id/comments`.
pub(crate) async fn list(caller: Caller, Path(id): Path<String>) -> Answer {
    if find_issue(&caller.db, &id).await?.is_none() {
        return Err(Refusal::not_found("Issue", Some(&id)));
    }
    let rows = issue_comments(&caller.db, &id).await?;
    Ok(all(rows.iter().map(comment_dto).collect()))
}

/// `POST /issues/:id/comments`.
pub(crate) async fn create(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let text_body = comment_body(&headers, &body)?;
    if find_issue(&caller.db, &id).await?.is_none() {
        return Err(Refusal::not_found("Issue", Some(&id)));
    }
    let row = insert_comment(&caller.db, &id, &caller.user_id, &text_body).await?;
    publish(&state, &caller.events, vec![comment_event(&row, "created")]);
    if let Some(issue) = find_issue(&caller.db, &id).await? {
        let team_key = team_key_of(&caller.db, text(&issue, "teamId")).await?;
        after_comment_changed(
            &caller.hook_context(&state),
            CommentChange::Created,
            &row,
            &issue,
            &team_key,
        )
        .await;
    }
    Ok(Created(comment_dto(&row)).into_response())
}

/// `PATCH /comments/:id`.
pub(crate) async fn update(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let text_body = comment_body(&headers, &body)?;
    let Some(existing) = find_comment(&caller.db, &id).await? else {
        return Err(Refusal::not_found("Comment", Some(&id)));
    };
    if text(&existing, "authorUserId") != caller.user_id {
        return Err(Refusal::forbidden("Only the author can edit a comment"));
    }
    let (_, at) = now_at();
    let row = comment_row(
        merge_comments::ActiveModel {
            id: Unchanged(id.clone()),
            body: Set(weldsuite_kit::validation::js_trim(&text_body).to_owned()),
            updated_at: Set(at),
            ..Default::default()
        }
        .update(&orm(&caller.db))
        .await?,
    )?;
    publish(&state, &caller.events, vec![comment_event(&row, "updated")]);
    comment_hooks(&state, &caller, CommentChange::Updated, &row).await?;
    Ok(Data(comment_dto(&row)).into_response())
}

/// `DELETE /comments/:id`.
pub(crate) async fn remove(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let Some(existing) = find_comment(&caller.db, &id).await? else {
        return Err(Refusal::not_found("Comment", Some(&id)));
    };
    if text(&existing, "authorUserId") != caller.user_id && !caller.can(MERGE_ISSUES_DELETE) {
        return Err(Refusal::forbidden(
            "Only the author, or someone who can delete issues, can delete a comment",
        ));
    }
    let row = soft_delete_comment(&caller.db, &id).await?;
    publish(&state, &caller.events, vec![comment_event(&row, "deleted")]);
    comment_hooks(&state, &caller, CommentChange::Deleted, &row).await?;
    Ok(NoContent.into_response())
}
