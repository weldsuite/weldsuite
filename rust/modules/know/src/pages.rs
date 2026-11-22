//! Pages: the sidebar tree, trash, detail, create, metadata, content
//! autosave, move, soft-delete and restore.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, EntityTrait, FromQueryResult, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde::Serialize;
use serde_json::{Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    KNOWLEDGE_PAGE_CREATED, KNOWLEDGE_PAGE_DELETED, KNOWLEDGE_PAGE_MOVED, KNOWLEDGE_PAGE_RESTORED,
    KNOWLEDGE_PAGE_UPDATED,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_know_domain::pages::{next_page_position, position as int};
use weldsuite_schema::tenant::{knowledge_pages as pages, knowledge_spaces as spaces};

use crate::access::{self, SpaceAccess, text};
use crate::{Caller, KnowError, KnowState, Refusal, all, now, row, validate, versions};

/// A page as Drizzle returns it.
pub(crate) async fn page_row(db: &PgPool, id: &str) -> Result<Option<Value>, sea_orm::DbErr> {
    let page = pages::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    Ok(page.map(row))
}

/// `id = any(ids)`.
fn among(ids: &[String]) -> sea_orm::sea_query::SimpleExpr {
    pages::Column::Id.is_in(ids.iter().cloned())
}

/// A live page plus the caller's access to its space (`loadPage`). A page in
/// a space the caller cannot read is reported as missing.
pub(crate) async fn load_page(
    db: &PgPool,
    id: &str,
    user_id: &str,
) -> Result<(Value, SpaceAccess), KnowError> {
    let page = pages::Entity::find_by_id(id.to_owned())
        .filter(pages::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    let Some(page) = page.map(row) else {
        return Err(KnowError::not_found("Page", id));
    };
    let access = match access::require_space(db, user_id, text(&page, "spaceId"), false).await {
        Ok(access) => access,
        Err(KnowError::NotFound { .. }) => return Err(KnowError::not_found("Page", id)),
        Err(error) => return Err(error),
    };
    if !access.can_read {
        return Err(KnowError::not_found("Page", id));
    }
    Ok((page, access))
}

/// A page the caller may write: readable, and they have the editor role.
pub(crate) async fn load_writable_page(
    db: &PgPool,
    id: &str,
    user_id: &str,
) -> Result<Value, KnowError> {
    let (page, access) = load_page(db, id, user_id).await?;
    access::assert_can_write(&access)?;
    Ok(page)
}

/// A space the caller may add pages to.
async fn writable_space(db: &PgPool, space_id: &str, user_id: &str) -> Result<(), KnowError> {
    let access = access::require_space(db, user_id, space_id, false).await?;
    access::assert_can_write(&access)
}

/// The next sibling position under a parent (append).
async fn next_position(
    db: &PgPool,
    space_id: &str,
    parent_id: Option<&str>,
) -> Result<i64, sea_orm::DbErr> {
    next_page_position(db, space_id, parent_id).await
}

/// The ids of `root_id` and its descendants (breadth first), live ones or
/// trashed ones.
async fn subtree_ids(
    db: &PgPool,
    root_id: &str,
    trashed: bool,
) -> Result<Vec<String>, sea_orm::DbErr> {
    let db = orm(db);
    let mut all = vec![root_id.to_owned()];
    let mut frontier = all.clone();
    while !frontier.is_empty() {
        let state = if trashed {
            pages::Column::DeletedAt.is_not_null()
        } else {
            pages::Column::DeletedAt.is_null()
        };
        frontier = pages::Entity::find()
            .select_only()
            .column(pages::Column::Id)
            .filter(pages::Column::ParentId.is_in(frontier))
            .filter(state)
            .into_tuple()
            .all(&db)
            .await?;
        all.extend(frontier.iter().cloned());
    }
    Ok(all)
}

/// Whether `new_parent_id` is `page_id` itself or one of its descendants, so
/// moving there would make a cycle.
async fn would_create_cycle(
    db: &PgPool,
    page_id: &str,
    new_parent_id: &str,
) -> Result<bool, sea_orm::DbErr> {
    if page_id == new_parent_id {
        return Ok(true);
    }
    // Walk up from the new parent; reaching the moved page is a cycle.
    let mut current = Some(new_parent_id.to_owned());
    let mut seen = Vec::new();
    while let Some(id) = current.filter(|id| !id.is_empty()) {
        if id == page_id || seen.contains(&id) {
            return Ok(true);
        }
        let parent: Option<Option<String>> = pages::Entity::find()
            .select_only()
            .column(pages::Column::ParentId)
            .filter(pages::Column::Id.eq(&id))
            .into_tuple()
            .one(&orm(db))
            .await?;
        seen.push(id);
        current = parent.flatten();
    }
    Ok(false)
}

/// The JS truthiness of an optional id: set and not empty.
fn truthy(field: &Field<String>) -> Option<&str> {
    field
        .as_set()
        .map(String::as_str)
        .filter(|id| !id.is_empty())
}

// ── GET /pages/tree, GET /trash ─────────────────────────────────────────────

/// A page in the sidebar tree: no content.
#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreePage {
    id: String,
    space_id: String,
    parent_id: Option<String>,
    position: i32,
    title: String,
    icon: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    updated_at: PrimitiveDateTime,
}

/// A page in the trash.
#[derive(FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashedPage {
    id: String,
    space_id: String,
    parent_id: Option<String>,
    title: String,
    icon: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp::option")]
    deleted_at: Option<PrimitiveDateTime>,
}

/// Tree metadata for the sidebar, without content.
pub(crate) async fn tree(caller: Caller, Query(query): Query<HashMap<String, String>>) -> Response {
    let result = async {
        let space_ids = access::readable_space_ids(&caller.db, &caller.user_id).await?;
        let scope: Vec<String> = match query.get("spaceId").filter(|id| !id.is_empty()) {
            Some(filter) => space_ids.into_iter().filter(|id| id == filter).collect(),
            None => space_ids,
        };
        if scope.is_empty() {
            return Ok(Vec::new());
        }
        let rows: Vec<TreePage> = pages::Entity::find()
            .select_only()
            .columns([
                pages::Column::Id,
                pages::Column::SpaceId,
                pages::Column::ParentId,
                pages::Column::Position,
                pages::Column::Title,
                pages::Column::Icon,
                pages::Column::UpdatedAt,
            ])
            .filter(pages::Column::SpaceId.is_in(scope))
            .filter(pages::Column::DeletedAt.is_null())
            .order_by_asc(pages::Column::Position)
            .order_by_asc(pages::Column::CreatedAt)
            .into_model()
            .all(&orm(&caller.db))
            .await?;
        Ok::<_, KnowError>(rows.into_iter().map(row).collect())
    }
    .await;
    match result {
        Ok(rows) => all(rows),
        Err(error) => error.respond("Failed to load page tree"),
    }
}

/// Trashed pages in spaces the caller can write to (and so restore in),
/// newest first.
pub(crate) async fn trash(caller: Caller) -> Response {
    let result = async {
        let space_ids = access::writable_space_ids(&caller.db, &caller.user_id).await?;
        if space_ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows: Vec<TrashedPage> = pages::Entity::find()
            .select_only()
            .columns([
                pages::Column::Id,
                pages::Column::SpaceId,
                pages::Column::ParentId,
                pages::Column::Title,
                pages::Column::Icon,
                pages::Column::DeletedAt,
            ])
            .filter(pages::Column::SpaceId.is_in(space_ids))
            .filter(pages::Column::DeletedAt.is_not_null())
            .order_by_desc(pages::Column::DeletedAt)
            .limit(200)
            .into_model()
            .all(&orm(&caller.db))
            .await?;
        Ok::<_, KnowError>(rows.into_iter().map(row).collect())
    }
    .await;
    match result {
        Ok(rows) => all(rows),
        Err(error) => error.respond("Failed to load trash"),
    }
}

// ── GET /pages/:id ─────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match load_page(&caller.db, &id, &caller.user_id).await {
        Ok((page, _)) => Data(page).into_response(),
        Err(error) => error.respond("Failed to fetch page"),
    }
}

// ── POST /pages ────────────────────────────────────────────────────────────

struct NewPage {
    space_id: String,
    parent_id: Field<String>,
    title: Field<String>,
    icon: Field<String>,
    cover_image: Field<String>,
    content_json: Field<Vec<Value>>,
}

pub(crate) async fn create(
    State(state): State<KnowState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| NewPage {
        space_id: issues
            .text(fields, "spaceId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        parent_id: issues.text(fields, "parentId", Presence::Nullish, None, None),
        title: issues.text(fields, "title", Presence::Optional, None, Some(500)),
        icon: issues.text(fields, "icon", Presence::Nullish, None, Some(100)),
        cover_image: issues.text(fields, "coverImage", Presence::Nullish, None, Some(1000)),
        content_json: issues.records(fields, "contentJson", Presence::Optional),
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    match create_page(&state, &caller, input).await {
        Ok(row) => Created(row).into_response(),
        Err(refusal) => refusal.respond("Failed to create page"),
    }
}

async fn create_page(state: &KnowState, caller: &Caller, input: NewPage) -> Result<Value, Refusal> {
    let db = &caller.db;
    writable_space(db, &input.space_id, &caller.user_id).await?;
    if let Some(parent_id) = truthy(&input.parent_id) {
        let (parent, _) = load_page(db, parent_id, &caller.user_id).await?;
        if text(&parent, "spaceId") != input.space_id {
            return Err(Refusal::bad_request(
                "Parent page belongs to a different space",
            ));
        }
    }

    let id = generate_id("kpag");
    let now = now();
    let parent_id = input.parent_id.as_set().cloned();
    let position = next_position(db, &input.space_id, parent_id.as_deref()).await?;
    let title = input
        .title
        .as_set()
        .filter(|title| !title.is_empty())
        .map_or("Untitled", String::as_str);
    pages::Entity::insert(pages::ActiveModel {
        id: Set(id.clone()),
        space_id: Set(input.space_id.clone()),
        parent_id: Set(parent_id.clone()),
        position: Set(int(position)),
        title: Set(title.to_owned()),
        icon: Set(input.icon.as_set().cloned()),
        cover_image: Set(input.cover_image.as_set().cloned()),
        content_json: Set(Some(Value::Array(
            input.content_json.as_set().cloned().unwrap_or_default(),
        ))),
        content_text: Set(Some(String::new())),
        created_by: Set(Some(caller.user_id.clone())),
        last_edited_by: Set(Some(caller.user_id.clone())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    // The event carries the title as sent (`data.title ?? 'Untitled'`).
    let event_title = input.title.as_set().map_or("Untitled", String::as_str);
    caller.publish(
        state,
        KNOWLEDGE_PAGE_CREATED,
        &id,
        &json!({ "id": id, "spaceId": input.space_id, "parentId": parent_id, "title": event_title }),
    );
    Ok(page_row(db, &id).await?.unwrap_or(Value::Null))
}

// ── PATCH /pages/:id ───────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<KnowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        (
            issues.text(fields, "title", Presence::Optional, None, Some(500)),
            issues.text(fields, "icon", Presence::Nullish, None, Some(100)),
            issues.text(fields, "coverImage", Presence::Nullish, None, Some(1000)),
            issues.boolean(fields, "isLocked", Presence::Optional),
        )
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let (title, icon, cover_image, is_locked) = input;
    let result = async {
        let db = &caller.db;
        let page = load_writable_page(db, &id, &caller.user_id).await?;
        // A field the body sent is set (`null` included); one it left out stays.
        let mut update = pages::Entity::update_many();
        if !title.is_absent() {
            update = update.col_expr(pages::Column::Title, Expr::value(title.as_set().cloned()));
        }
        if !icon.is_absent() {
            update = update.col_expr(pages::Column::Icon, Expr::value(icon.as_set().cloned()));
        }
        if !cover_image.is_absent() {
            update = update.col_expr(
                pages::Column::CoverImage,
                Expr::value(cover_image.as_set().cloned()),
            );
        }
        if !is_locked.is_absent() {
            update = update.col_expr(
                pages::Column::IsLocked,
                Expr::value(is_locked.as_set().copied()),
            );
        }
        update
            .col_expr(pages::Column::LastEditedBy, Expr::value(&caller.user_id))
            .col_expr(pages::Column::UpdatedAt, Expr::value(now()))
            .filter(pages::Column::Id.eq(&id))
            .exec(&orm(db))
            .await?;
        let title = title
            .as_set()
            .map_or_else(|| page["title"].clone(), |title| json!(title));
        caller.publish(
            &state,
            KNOWLEDGE_PAGE_UPDATED,
            &id,
            &json!({ "id": id, "spaceId": page["spaceId"], "title": title }),
        );
        Ok::<_, KnowError>(page_row(db, &id).await?.unwrap_or(Value::Null))
    }
    .await;
    match result {
        Ok(row) => Data(row).into_response(),
        Err(error) => error.respond("Failed to update page"),
    }
}

// ── PUT /pages/:id/content ─────────────────────────────────────────────────

/// Autosave content. Locked pages refuse edits.
pub(crate) async fn save_content(
    State(state): State<KnowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (content, content_text) = match validate(&headers, &body, |issues, fields| {
        (
            issues.records(fields, "contentJson", Presence::Required),
            issues.text(fields, "contentText", Presence::Optional, None, None),
        )
    }) {
        Ok((content, text)) => (
            Value::Array(content.into_option().unwrap_or_default()),
            text,
        ),
        Err(refused) => return refused.respond("Invalid request body"),
    };
    let result = async {
        let db = &caller.db;
        let page = load_writable_page(db, &id, &caller.user_id).await?;
        if page["isLocked"] == true {
            return Err(Refusal::conflict("Page is locked"));
        }
        let content_text = content_text
            .into_option()
            .or_else(|| page["contentText"].as_str().map(str::to_owned));
        pages::Entity::update_many()
            .col_expr(pages::Column::ContentJson, Expr::value(content.clone()))
            .col_expr(pages::Column::ContentText, Expr::value(content_text))
            .col_expr(pages::Column::LastEditedBy, Expr::value(&caller.user_id))
            .col_expr(pages::Column::UpdatedAt, Expr::value(now()))
            .filter(pages::Column::Id.eq(&id))
            .exec(&orm(db))
            .await?;
        versions::maybe_auto_snapshot(db, &id, &content, &caller.user_id).await?;
        caller.publish(
            &state,
            KNOWLEDGE_PAGE_UPDATED,
            &id,
            &json!({ "id": id, "spaceId": page["spaceId"], "title": page["title"] }),
        );
        Ok(())
    }
    .await;
    match result {
        Ok(()) => Data(json!({ "id": id })).into_response(),
        Err(refusal) => refusal.respond("Failed to save page content"),
    }
}

// ── POST /pages/:id/move ───────────────────────────────────────────────────

/// Re-parent, reorder or move to another space. Moving a page moves its
/// whole subtree.
pub(crate) async fn move_page(
    State(state): State<KnowState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        (
            issues.text(fields, "parentId", Presence::Nullable, None, None),
            issues.text(fields, "spaceId", Presence::Optional, None, None),
            issues.integer(fields, "position", Presence::Optional, Some(0)),
        )
    }) {
        Ok(input) => input,
        Err(refused) => return refused.respond("Invalid request body"),
    };
    match move_subtree(&state, &caller, &id, input).await {
        Ok(row) => Data(row).into_response(),
        Err(refusal) => refusal.respond("Failed to move page"),
    }
}

async fn move_subtree(
    state: &KnowState,
    caller: &Caller,
    id: &str,
    (parent_id, space_id, position): (Field<String>, Field<String>, Field<i64>),
) -> Result<Value, Refusal> {
    let db = &caller.db;
    let page = load_writable_page(db, id, &caller.user_id).await?;
    let from_space = text(&page, "spaceId").to_owned();
    let target_space = space_id.into_option().unwrap_or_else(|| from_space.clone());
    if target_space != from_space {
        writable_space(db, &target_space, &caller.user_id).await?;
    }
    if let Some(parent) = truthy(&parent_id) {
        let (parent_page, _) = load_page(db, parent, &caller.user_id).await?;
        if text(&parent_page, "spaceId") != target_space {
            return Err(Refusal::bad_request(
                "Parent page belongs to a different space",
            ));
        }
        if would_create_cycle(db, id, parent).await? {
            return Err(Refusal::bad_request(
                "Cannot move a page under itself or one of its sub-pages",
            ));
        }
    }

    let parent_id = parent_id.into_option();
    let position = match position {
        Field::Set(position) => position,
        _ => next_position(db, &target_space, parent_id.as_deref()).await?,
    };
    let now = now();
    pages::Entity::update_many()
        .col_expr(pages::Column::ParentId, Expr::value(parent_id.clone()))
        .col_expr(pages::Column::SpaceId, Expr::value(&target_space))
        .col_expr(pages::Column::Position, Expr::value(int(position)))
        .col_expr(pages::Column::LastEditedBy, Expr::value(&caller.user_id))
        .col_expr(pages::Column::UpdatedAt, Expr::value(now))
        .filter(pages::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;

    // A move to another space carries the whole subtree along.
    if target_space != from_space {
        let descendants: Vec<String> = subtree_ids(db, id, false)
            .await?
            .into_iter()
            .filter(|page| page != id)
            .collect();
        if !descendants.is_empty() {
            pages::Entity::update_many()
                .col_expr(pages::Column::SpaceId, Expr::value(&target_space))
                .col_expr(pages::Column::UpdatedAt, Expr::value(now))
                .filter(among(&descendants))
                .exec(&orm(db))
                .await?;
        }
    }

    caller.publish(
        state,
        KNOWLEDGE_PAGE_MOVED,
        id,
        &json!({ "id": id, "spaceId": target_space, "parentId": parent_id, "position": position }),
    );
    Ok(page_row(db, id).await?.unwrap_or(Value::Null))
}

// ── DELETE /pages/:id ──────────────────────────────────────────────────────

/// Soft-delete a page and its whole subtree (recoverable from trash).
pub(crate) async fn remove(
    State(state): State<KnowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let db = &caller.db;
        let page = load_writable_page(db, &id, &caller.user_id).await?;
        let subtree = subtree_ids(db, &id, false).await?;
        let now = now();
        pages::Entity::update_many()
            .col_expr(pages::Column::DeletedAt, Expr::value(now))
            .col_expr(pages::Column::UpdatedAt, Expr::value(now))
            .filter(among(&subtree))
            .exec(&orm(db))
            .await?;
        caller.publish(
            &state,
            KNOWLEDGE_PAGE_DELETED,
            &id,
            &json!({ "id": id, "spaceId": page["spaceId"] }),
        );
        Ok::<_, KnowError>(())
    }
    .await;
    match result {
        Ok(()) => NoContent.into_response(),
        Err(error) => error.respond("Failed to delete page"),
    }
}

// ── POST /pages/:id/restore ────────────────────────────────────────────────

/// Restore a trashed page and its trashed descendants. Re-roots it when its
/// old parent is gone.
pub(crate) async fn restore(
    State(state): State<KnowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    match restore_page(&state, &caller, &id).await {
        Ok(row) => Data(row).into_response(),
        Err(refusal) => refusal.respond("Failed to restore page"),
    }
}

async fn restore_page(state: &KnowState, caller: &Caller, id: &str) -> Result<Value, Refusal> {
    let db = &caller.db;
    let page = pages::Entity::find_by_id(id.to_owned())
        .filter(pages::Column::DeletedAt.is_not_null())
        .one(&orm(db))
        .await?;
    let Some(page) = page.map(row) else {
        return Err(Refusal::not_found("Page", id));
    };
    let space_id = text(&page, "spaceId").to_owned();
    let space: Option<String> = spaces::Entity::find()
        .select_only()
        .column(spaces::Column::Id)
        .filter(spaces::Column::Id.eq(&space_id))
        .filter(spaces::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    if space.is_none() {
        return Err(Refusal::conflict(
            "The space this page belonged to no longer exists",
        ));
    }
    match writable_space(db, &space_id, &caller.user_id).await {
        Err(KnowError::NotFound { .. }) => return Err(Refusal::not_found("Page", id)),
        Err(error) => return Err(error.into()),
        Ok(()) => {}
    }

    let to_restore = subtree_ids(db, id, true).await?;
    // The old parent still in the trash: re-root at the top of the space.
    let mut parent_id = page["parentId"].as_str().map(str::to_owned);
    if let Some(parent) = parent_id.as_deref().filter(|parent| !parent.is_empty()) {
        let live: Option<String> = pages::Entity::find()
            .select_only()
            .column(pages::Column::Id)
            .filter(pages::Column::Id.eq(parent))
            .filter(pages::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
            .await?;
        if live.is_none() {
            parent_id = None;
        }
    }

    let now = now();
    pages::Entity::update_many()
        .col_expr(
            pages::Column::DeletedAt,
            Expr::value(None::<PrimitiveDateTime>),
        )
        .col_expr(pages::Column::UpdatedAt, Expr::value(now))
        .filter(among(&to_restore))
        .exec(&orm(db))
        .await?;
    let position = next_position(db, &space_id, parent_id.as_deref()).await?;
    pages::Entity::update_many()
        .col_expr(pages::Column::ParentId, Expr::value(parent_id.clone()))
        .col_expr(pages::Column::Position, Expr::value(int(position)))
        .col_expr(pages::Column::UpdatedAt, Expr::value(now))
        .filter(pages::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;

    caller.publish(
        state,
        KNOWLEDGE_PAGE_RESTORED,
        id,
        &json!({ "id": id, "spaceId": space_id }),
    );
    Ok(page_row(db, id).await?.unwrap_or(Value::Null))
}
