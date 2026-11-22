//! Per-user favorites, pinned at the top of the sidebar. Always the
//! signed-in user's own.

use axum::body::Bytes;
use axum::extract::Path;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, EntityTrait, FromQueryResult, JoinType, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde::Serialize;
use serde_json::json;
use weldsuite_db::orm;
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::{knowledge_favorites as favorites, knowledge_pages as pages};

use crate::pages::load_page;
use crate::{Caller, KnowError, access, all, now, row, validate};

/// A favorite with its page's title, icon and space.
#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct Favorite {
    id: String,
    page_id: String,
    position: i32,
    title: String,
    icon: Option<String>,
    space_id: String,
}

/// Favorites in spaces the caller can still read: leaving a teamspace hides
/// its pages here too.
pub(crate) async fn list(caller: Caller) -> Response {
    let result = async {
        let space_ids = access::readable_space_ids(&caller.db, &caller.user_id).await?;
        if space_ids.is_empty() {
            return Ok(Vec::new());
        }
        let page = favorites::Entity::belongs_to(pages::Entity)
            .from(favorites::Column::PageId)
            .to(pages::Column::Id)
            .into();
        let rows: Vec<Favorite> = favorites::Entity::find()
            .select_only()
            .column(favorites::Column::Id)
            .column(favorites::Column::PageId)
            .column(favorites::Column::Position)
            .column_as(pages::Column::Title, "title")
            .column_as(pages::Column::Icon, "icon")
            .column_as(pages::Column::SpaceId, "space_id")
            .join(JoinType::InnerJoin, page)
            .filter(favorites::Column::UserId.eq(&caller.user_id))
            .filter(pages::Column::DeletedAt.is_null())
            .filter(pages::Column::SpaceId.is_in(space_ids))
            .order_by_asc(favorites::Column::Position)
            .order_by_asc(favorites::Column::CreatedAt)
            .into_model()
            .all(&orm(&caller.db))
            .await?;
        Ok::<_, KnowError>(rows.into_iter().map(row).collect())
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
        let orm_db = orm(db);
        let existing: Option<String> = favorites::Entity::find()
            .select_only()
            .column(favorites::Column::Id)
            .filter(favorites::Column::PageId.eq(&page_id))
            .filter(favorites::Column::UserId.eq(&caller.user_id))
            .into_tuple()
            .one(&orm_db)
            .await?;
        if let Some(id) = existing {
            return Ok((false, id));
        }
        let max: Option<Option<i32>> = favorites::Entity::find()
            .select_only()
            .column_as(favorites::Column::Position.max(), "max")
            .filter(favorites::Column::UserId.eq(&caller.user_id))
            .into_tuple()
            .one(&orm_db)
            .await?;
        let id = generate_id("kfav");
        favorites::Entity::insert(favorites::ActiveModel {
            id: Set(id.clone()),
            page_id: Set(page_id.clone()),
            user_id: Set(caller.user_id.clone()),
            position: Set(max.flatten().unwrap_or(-1).saturating_add(1)),
            created_at: Set(now()),
        })
        .exec_without_returning(&orm_db)
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
    let removed = favorites::Entity::delete_many()
        .filter(favorites::Column::PageId.eq(&page_id))
        .filter(favorites::Column::UserId.eq(&caller.user_id))
        .exec(&orm(&caller.db))
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
