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
use serde_json::{Value, json};
use weldsuite_catalogs::permission_keys::MERGE_ISSUES_DELETE;
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};

use crate::db::{Row, one_by_id, rows_of, text};
use crate::hooks::{CommentChange, after_comment_changed};
use crate::issues::{find_issue, team_key_of};
use crate::mappers::comment_dto;
use crate::{Answer, Caller, MergeState, PendingEvent, Refusal, all, now, publish, validate};

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
) -> Result<(), sqlx::Error> {
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

async fn find_comment(db: &PgPool, id: &str) -> Result<Option<Row>, sqlx::Error> {
    one_by_id(
        db,
        "select to_jsonb(c) from merge_comments c where c.id = $1 and c.deleted_at is null limit 1",
        id,
    )
    .await
}

/// `GET /issues/:id/comments`.
pub(crate) async fn list(caller: Caller, Path(id): Path<String>) -> Answer {
    if find_issue(&caller.db, &id).await?.is_none() {
        return Err(Refusal::not_found("Issue", Some(&id)));
    }
    let rows = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(c) from merge_comments c where c.issue_id = $1 and c.deleted_at is null \
             order by c.created_at asc, c.id asc",
        )
        .bind(&id)
        .fetch_all(&caller.db)
        .await?,
    );
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
    let now = now();
    let row: Value = sqlx::query_scalar(
        "insert into merge_comments (id, issue_id, author_user_id, body, created_at, updated_at) \
         values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz) \
         returning to_jsonb(merge_comments.*)",
    )
    .bind(generate_id("mcm"))
    .bind(&id)
    .bind(&caller.user_id)
    .bind(weldsuite_kit::validation::js_trim(&text_body))
    .bind(&now)
    .fetch_one(&caller.db)
    .await?;
    let row = weldsuite_db::js_row(row);
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
    let row: Value = sqlx::query_scalar(
        "update merge_comments set body = $2, updated_at = $3::timestamptz \
         where id = $1 returning to_jsonb(merge_comments.*)",
    )
    .bind(&id)
    .bind(weldsuite_kit::validation::js_trim(&text_body))
    .bind(now())
    .fetch_one(&caller.db)
    .await?;
    let row = weldsuite_db::js_row(row);
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
    let now = now();
    let row: Value = sqlx::query_scalar(
        "update merge_comments set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where id = $1 returning to_jsonb(merge_comments.*)",
    )
    .bind(&id)
    .bind(&now)
    .fetch_one(&caller.db)
    .await?;
    let row = weldsuite_db::js_row(row);
    publish(&state, &caller.events, vec![comment_event(&row, "deleted")]);
    comment_hooks(&state, &caller, CommentChange::Deleted, &row).await?;
    Ok(NoContent.into_response())
}
