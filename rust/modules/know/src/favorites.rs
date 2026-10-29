//! Per-user favorites, pinned at the top of the sidebar. Always the
//! signed-in user's own.

use axum::body::Bytes;
use axum::extract::Path;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};

use crate::pages::load_page;
use crate::{Caller, KnowError, access, all, now, validate};

/// Favorites in spaces the caller can still read: leaving a teamspace hides
/// its pages here too.
pub(crate) async fn list(caller: Caller) -> Response {
    let result = async {
        let space_ids = access::readable_space_ids(&caller.db, &caller.user_id).await?;
        if space_ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object(
                      'id', f.id, 'pageId', f.page_id, 'position', f.position, 'title', p.title,
                      'icon', p.icon, 'spaceId', p.space_id)
             from knowledge_favorites f
             join knowledge_pages p on f.page_id = p.id
             where f.user_id = $1 and p.deleted_at is null and p.space_id = any($2)
             order by f.position asc, f.created_at asc",
        )
        .bind(&caller.user_id)
        .bind(&space_ids)
        .fetch_all(&caller.db)
        .await?;
        Ok::<_, KnowError>(rows)
    }
    .await;
    match result {
        Ok(rows) => all(rows),
        Err(error) => error.respond("Failed to list favorites"),
    }
}

pub(crate) async fn add(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let page_id = match validate(&headers, &body, |issues, fields| {
        issues.text(fields, "pageId", Presence::Required, Some(1), None)
    }) {
        Ok(page_id) => page_id.into_option().unwrap_or_default(),
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let result = async {
        let db = &caller.db;
        load_page(db, &page_id, &caller.user_id).await?;
        let existing: Option<String> = sqlx::query_scalar(
            "select id from knowledge_favorites where page_id = $1 and user_id = $2 limit 1",
        )
        .bind(&page_id)
        .bind(&caller.user_id)
        .fetch_optional(db)
        .await?;
        if let Some(id) = existing {
            return Ok((false, id));
        }
        let max: i64 = sqlx::query_scalar(
            "select coalesce(max(position), -1)::bigint from knowledge_favorites where user_id = $1",
        )
        .bind(&caller.user_id)
        .fetch_one(db)
        .await?;
        let id = generate_id("kfav");
        sqlx::query(
            "insert into knowledge_favorites (id, page_id, user_id, position, created_at)
             values ($1, $2, $3, $4::int, $5::timestamp)",
        )
        .bind(&id)
        .bind(&page_id)
        .bind(&caller.user_id)
        .bind(max + 1)
        .bind(now())
        .execute(db)
        .await?;
        Ok::<_, KnowError>((true, id))
    }
    .await;
    match result {
        Ok((true, id)) => Created(json!({ "id": id, "pageId": page_id })).into_response(),
        Ok((false, id)) => Data(json!({ "id": id, "pageId": page_id })).into_response(),
        Err(error) => error.respond("Failed to add favorite"),
    }
}

pub(crate) async fn remove(caller: Caller, Path(page_id): Path<String>) -> Response {
    let removed =
        sqlx::query("delete from knowledge_favorites where page_id = $1 and user_id = $2")
            .bind(&page_id)
            .bind(&caller.user_id)
            .execute(&caller.db)
            .await;
    match removed {
        Ok(_) => NoContent.into_response(),
        Err(error) => {
            tracing::error!(%error, "[know-api/knowledge] remove favorite failed");
            ApiError::internal()
                .with_message("Failed to remove favorite")
                .into_response()
        }
    }
}
