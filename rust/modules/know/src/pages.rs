//! Pages: the sidebar tree, trash, detail, create, metadata, content
//! autosave, move, soft-delete and restore.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    KNOWLEDGE_PAGE_CREATED, KNOWLEDGE_PAGE_DELETED, KNOWLEDGE_PAGE_MOVED, KNOWLEDGE_PAGE_RESTORED,
    KNOWLEDGE_PAGE_UPDATED,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};

use crate::access::{self, SpaceAccess, text};
use crate::{Caller, KnowError, KnowState, Refusal, all, now, validate, versions};

/// A live page as Drizzle returns it.
pub(crate) async fn page_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(p) from knowledge_pages p where id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(js_row))
}

/// A live page plus the caller's access to its space (`loadPage`). A page in
/// a space the caller cannot read is reported as missing.
pub(crate) async fn load_page(
    db: &PgPool,
    id: &str,
    user_id: &str,
) -> Result<(Value, SpaceAccess), KnowError> {
    let page: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(p) from knowledge_pages p where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(page) = page.map(js_row) else {
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
) -> Result<i64, sqlx::Error> {
    let max: i64 = sqlx::query_scalar(
        "select coalesce(max(position), -1)::bigint from knowledge_pages
         where space_id = $1 and parent_id is not distinct from $2 and deleted_at is null",
    )
    .bind(space_id)
    .bind(parent_id)
    .fetch_one(db)
    .await?;
    Ok(max + 1)
}

/// The ids of `root_id` and its descendants (breadth first), live ones or
/// trashed ones.
async fn subtree_ids(
    db: &PgPool,
    root_id: &str,
    trashed: bool,
) -> Result<Vec<String>, sqlx::Error> {
    let mut all = vec![root_id.to_owned()];
    let mut frontier = all.clone();
    while !frontier.is_empty() {
        frontier = sqlx::query_scalar(
            "select id from knowledge_pages
             where parent_id = any($1) and (deleted_at is not null) = $2",
        )
        .bind(&frontier)
        .bind(trashed)
        .fetch_all(db)
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
) -> Result<bool, sqlx::Error> {
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
        let parent: Option<Option<String>> =
            sqlx::query_scalar("select parent_id from knowledge_pages where id = $1 limit 1")
                .bind(&id)
                .fetch_optional(db)
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
        let rows: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object(
                      'id', id, 'spaceId', space_id, 'parentId', parent_id, 'position', position,
                      'title', title, 'icon', icon, 'updatedAt', updated_at)
             from knowledge_pages
             where space_id = any($1) and deleted_at is null
             order by position asc, created_at asc",
        )
        .bind(&scope)
        .fetch_all(&caller.db)
        .await?;
        Ok::<_, KnowError>(rows.into_iter().map(js_row).collect())
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
        let rows: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object(
                      'id', id, 'spaceId', space_id, 'parentId', parent_id, 'title', title,
                      'icon', icon, 'deletedAt', deleted_at)
             from knowledge_pages
             where space_id = any($1) and deleted_at is not null
             order by deleted_at desc
             limit 200",
        )
        .bind(&space_ids)
        .fetch_all(&caller.db)
        .await?;
        Ok::<_, KnowError>(rows.into_iter().map(js_row).collect())
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
    sqlx::query(
        "insert into knowledge_pages
             (id, space_id, parent_id, position, title, icon, cover_image, content_json,
              content_text, created_by, last_edited_by, created_at, updated_at)
         values ($1, $2, $3, $4::int, $5, $6, $7, $8, '', $9, $9, $10::timestamp, $10::timestamp)",
    )
    .bind(&id)
    .bind(&input.space_id)
    .bind(&parent_id)
    .bind(position)
    .bind(title)
    .bind(input.icon.as_set())
    .bind(input.cover_image.as_set())
    .bind(Value::Array(
        input.content_json.as_set().cloned().unwrap_or_default(),
    ))
    .bind(&caller.user_id)
    .bind(&now)
    .execute(db)
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
        sqlx::query(
            "update knowledge_pages set
                 title = case when $2 then $3 else title end,
                 icon = case when $4 then $5 else icon end,
                 cover_image = case when $6 then $7 else cover_image end,
                 is_locked = case when $8 then $9 else is_locked end,
                 last_edited_by = $10,
                 updated_at = $11::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(!title.is_absent())
        .bind(title.as_set())
        .bind(!icon.is_absent())
        .bind(icon.as_set())
        .bind(!cover_image.is_absent())
        .bind(cover_image.as_set())
        .bind(!is_locked.is_absent())
        .bind(is_locked.as_set())
        .bind(&caller.user_id)
        .bind(now())
        .execute(db)
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
        sqlx::query(
            "update knowledge_pages
             set content_json = $2, content_text = $3, last_edited_by = $4, updated_at = $5::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(&content)
        .bind(content_text)
        .bind(&caller.user_id)
        .bind(now())
        .execute(db)
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
    sqlx::query(
        "update knowledge_pages
         set parent_id = $2, space_id = $3, position = $4::int, last_edited_by = $5,
             updated_at = $6::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(&parent_id)
    .bind(&target_space)
    .bind(position)
    .bind(&caller.user_id)
    .bind(&now)
    .execute(db)
    .await?;

    // A move to another space carries the whole subtree along.
    if target_space != from_space {
        let descendants: Vec<String> = subtree_ids(db, id, false)
            .await?
            .into_iter()
            .filter(|page| page != id)
            .collect();
        if !descendants.is_empty() {
            sqlx::query(
                "update knowledge_pages set space_id = $2, updated_at = $3::timestamp
                 where id = any($1)",
            )
            .bind(&descendants)
            .bind(&target_space)
            .bind(&now)
            .execute(db)
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
        sqlx::query(
            "update knowledge_pages set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = any($1)",
        )
        .bind(&subtree)
        .bind(now())
        .execute(db)
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
    let page: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(p) from knowledge_pages p where id = $1 and deleted_at is not null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(page) = page.map(js_row) else {
        return Err(Refusal::not_found("Page", id));
    };
    let space_id = text(&page, "spaceId").to_owned();
    let space: Option<String> = sqlx::query_scalar(
        "select id from knowledge_spaces where id = $1 and deleted_at is null limit 1",
    )
    .bind(&space_id)
    .fetch_optional(db)
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
        let live: Option<String> = sqlx::query_scalar(
            "select id from knowledge_pages where id = $1 and deleted_at is null limit 1",
        )
        .bind(parent)
        .fetch_optional(db)
        .await?;
        if live.is_none() {
            parent_id = None;
        }
    }

    let now = now();
    sqlx::query(
        "update knowledge_pages set deleted_at = null, updated_at = $2::timestamp
         where id = any($1)",
    )
    .bind(&to_restore)
    .bind(&now)
    .execute(db)
    .await?;
    let position = next_position(db, &space_id, parent_id.as_deref()).await?;
    sqlx::query(
        "update knowledge_pages set parent_id = $2, position = $3::int, updated_at = $4::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(&parent_id)
    .bind(position)
    .bind(&now)
    .execute(db)
    .await?;

    caller.publish(
        state,
        KNOWLEDGE_PAGE_RESTORED,
        id,
        &json!({ "id": id, "spaceId": space_id }),
    );
    Ok(page_row(db, id).await?.unwrap_or(Value::Null))
}
