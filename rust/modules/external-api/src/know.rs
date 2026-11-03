//! WeldKnow's objects: `/v1/knowledge-spaces` and `/v1/knowledge-pages`
//! (`routes/v1/knowledge-*/index.ts`), on the teamspace rules know-api
//! shares (`weldsuite_know_domain::access`). A workspace key (no user)
//! reaches open teamspaces only; a user token follows that person's
//! memberships. A space or page the caller cannot see is a 404.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, Query, RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::{get, patch, post};
use http::HeaderMap;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::LazyLock;
use weldsuite_catalogs::entity_events::{
    KNOWLEDGE_PAGE_CREATED, KNOWLEDGE_PAGE_DELETED, KNOWLEDGE_PAGE_MOVED, KNOWLEDGE_PAGE_UPDATED,
    KNOWLEDGE_SPACE_CREATED, KNOWLEDGE_SPACE_DELETED, KNOWLEDGE_SPACE_UPDATED,
};
use weldsuite_db::PgPool;
use weldsuite_kit::id::generate_id;
use weldsuite_know_domain::KnowError;
use weldsuite_know_domain::access::{self, SpaceAccess};

use crate::ExternalApiState;
use crate::crud::{Answer, Caller, Fail, created, field, list_query, no_content, now, ok};
use crate::list::list_page_mapped;
use crate::schemas::{
    CREATE_KNOWLEDGE_PAGE, LIST_KNOWLEDGE_PAGES, MOVE_KNOWLEDGE_PAGE, UPDATE_KNOWLEDGE_PAGE,
};
use crate::schemas_gen::{CREATE_KNOWLEDGE_SPACE, UPDATE_KNOWLEDGE_SPACE};
use crate::session::{bad_request, conflict, forbidden, internal, not_found};
use crate::simple::scoped;
use crate::tables_gen::{KNOWLEDGE_PAGES, KNOWLEDGE_SPACES, row};
use crate::zod;

type S = State<ExternalApiState>;

/// Know's routes.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    router
        .route(
            "/knowledge-spaces",
            scoped(get(list_spaces), "knowledge:read")
                .merge(scoped(post(create_space), "knowledge:write")),
        )
        .route(
            "/knowledge-spaces/{id}",
            scoped(get(get_space), "knowledge:read").merge(scoped(
                patch(update_space).delete(delete_space),
                "knowledge:write",
            )),
        )
        .route(
            "/knowledge-pages",
            scoped(get(list_pages), "knowledge:read")
                .merge(scoped(post(create_page), "knowledge:write")),
        )
        .route(
            "/knowledge-pages/tree",
            scoped(get(page_tree), "knowledge:read"),
        )
        .route(
            "/knowledge-pages/{id}",
            scoped(get(get_page), "knowledge:read").merge(scoped(
                patch(update_page).delete(delete_page),
                "knowledge:write",
            )),
        )
        .route(
            "/knowledge-pages/{id}/move",
            scoped(post(move_page), "knowledge:write"),
        )
}

const DEFAULT_ONLY_IN_APP: &str = "Default teamspaces are set in WeldKnow by a workspace admin.";
const NOT_OWNER: &str = "This needs the owner role in the teamspace.";
const NOT_EDITOR: &str = "This needs the editor role in the teamspace.";

/// A rule's failure the route does not catch: the worker's 500.
fn thrown(error: KnowError) -> Fail {
    if let KnowError::Database(error) = error {
        tracing::error!(%error, "external-api: a knowledge query failed");
    }
    internal().into()
}

fn user(caller: &Caller) -> Option<&str> {
    caller.session.user_id.as_deref()
}

/// `spaceAccess(db, spaceId, userId)`: the caller's access, or `None` when
/// the space is invisible to them.
async fn space_access(
    db: &PgPool,
    space_id: &str,
    user_id: Option<&str>,
) -> Result<Option<SpaceAccess>, Fail> {
    match access::require_space(db, user_id, space_id, false).await {
        Ok(access) => Ok(Some(access)),
        Err(KnowError::NotFound { .. }) => Ok(None),
        Err(error) => Err(thrown(error)),
    }
}

/// `list(c, rows, cursorPagination(rows.length, false, null))`.
#[allow(clippy::unnecessary_wraps, clippy::needless_pass_by_value)] // a handler's answer
fn whole(rows: Vec<Value>) -> Answer {
    let total = rows.len();
    Ok(axum::Json(json!({
        "data": rows,
        "pagination": { "totalCount": total, "hasMore": false, "cursor": null },
    }))
    .into_response())
}

// ── spaces ───────────────────────────────────────────────────────────────────

async fn list_spaces(caller: Caller) -> Answer {
    let visible = access::list_spaces(&caller.db, user(&caller), false)
        .await
        .map_err(thrown)?;
    whole(visible)
}

async fn get_space(caller: Caller, Path(id): Path<String>) -> Answer {
    match space_access(&caller.db, &id, user(&caller)).await? {
        Some(access) => ok(access.space),
        None => Err(not_found("Knowledge space", &id).into()),
    }
}

/// `!userId && body.visibility && body.visibility !== 'open'`.
fn key_closes_off(caller: &Caller, body: &Map<String, Value>) -> bool {
    user(caller).is_none()
        && body
            .get("visibility")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty() && v != "open")
}

async fn create_space(State(state): S, caller: Caller, headers: HeaderMap, body: Bytes) -> Answer {
    let parsed = zod::json(&CREATE_KNOWLEDGE_SPACE, &headers, &body)?;
    let body = &parsed.body;
    if body.get("isDefault") == Some(&Value::Bool(true)) {
        return Err(forbidden(DEFAULT_ONLY_IN_APP).into());
    }
    if key_closes_off(&caller, body) {
        return Err(bad_request("An API key can only create open teamspaces.").into());
    }
    let id = generate_id("kspc");
    let stamp = now();
    let sort_order = if let Some(order) = body.get("sortOrder") {
        order.clone()
    } else {
        let max: i64 = sqlx::query_scalar(
            "select coalesce(max(sort_order), -1)::bigint from knowledge_spaces where deleted_at is null",
        )
        .fetch_one(&caller.db)
        .await?;
        json!(max + 1)
    };
    let opt = |key: &str| body.get(key).cloned().unwrap_or(Value::Null);
    let mut values = Map::new();
    values.insert("id".into(), json!(id));
    values.insert("name".into(), opt("name"));
    values.insert("description".into(), opt("description"));
    values.insert("icon".into(), opt("icon"));
    values.insert("color".into(), opt("color"));
    values.insert("kind".into(), json!("team"));
    values.insert(
        "visibility".into(),
        body.get("visibility").cloned().unwrap_or(json!("open")),
    );
    values.insert("sortOrder".into(), sort_order);
    values.insert("createdBy".into(), json!(user(&caller)));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    let row = KNOWLEDGE_SPACES
        .insert(&caller.db, &values, &["createdAt", "updatedAt"])
        .await?;
    // The creator is the teamspace's first owner.
    if let Some(user_id) = user(&caller) {
        access::add_space_member(&caller.db, &id, user_id, "owner", user_id, &stamp)
            .await
            .map_err(thrown)?;
    }
    caller.publish(
        &state.events,
        KNOWLEDGE_SPACE_CREATED,
        &id,
        json!({ "id": id, "name": field(&row, "name") }),
    );
    created(row)
}

async fn update_space(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_KNOWLEDGE_SPACE, &headers, &body)?;
    let body = &parsed.body;
    let Some(access) = space_access(&caller.db, &id, user(&caller)).await? else {
        return Err(not_found("Knowledge space", &id).into());
    };
    if !access.can_manage {
        return Err(forbidden(NOT_OWNER).into());
    }
    if let Some(is_default) = body.get("isDefault")
        && Some(is_default) != access.space.get("isDefault")
    {
        return Err(forbidden(DEFAULT_ONLY_IN_APP).into());
    }
    if key_closes_off(&caller, body) {
        return Err(bad_request(
            "An API key cannot close a teamspace off; an owner does that in WeldKnow.",
        )
        .into());
    }
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    for key in [
        "name",
        "description",
        "icon",
        "color",
        "visibility",
        "sortOrder",
    ] {
        if let Some(value) = body.get(key) {
            update.insert(key.into(), value.clone());
        }
    }
    let row = KNOWLEDGE_SPACES
        .patch(&caller.db, &id, &update, false, &["updatedAt"])
        .await?
        .ok_or_else(|| not_found("Knowledge space", &id))?;
    caller.publish(
        &state.events,
        KNOWLEDGE_SPACE_UPDATED,
        &id,
        json!({ "id": id, "name": field(&row, "name") }),
    );
    ok(row)
}

async fn delete_space(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    let Some(access) = space_access(&caller.db, &id, user(&caller)).await? else {
        return Err(not_found("Knowledge space", &id).into());
    };
    if !access.can_manage {
        return Err(forbidden(NOT_OWNER).into());
    }
    let stamp = now();
    sqlx::query(
        "update knowledge_spaces set deleted_at = $2::timestamptz, updated_at = $2::timestamptz where id = $1",
    )
    .bind(&id)
    .bind(&stamp)
    .execute(&caller.db)
    .await?;
    // Every live page in the space goes to the platform trash.
    sqlx::query(
        "update knowledge_pages set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
         where space_id = $1 and deleted_at is null",
    )
    .bind(&id)
    .bind(&stamp)
    .execute(&caller.db)
    .await?;
    caller.publish(
        &state.events,
        KNOWLEDGE_SPACE_DELETED,
        &id,
        json!({ "id": id }),
    );
    no_content()
}

// ── content ──────────────────────────────────────────────────────────────────

fn inline(text: &str) -> Value {
    json!([{ "type": "text", "text": text, "styles": {} }])
}

static HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(#{1,3})\s+(\S.*)$").expect("heading pattern"));
static BULLET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*[-*]\s+(\S.*)$").expect("bullet pattern"));
static NUMBERED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*\d+[.)]\s+(\S.*)$").expect("numbered pattern"));

/// JavaScript's whitespace (`trim`, `\s`).
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `textToBlocks(text)`: plain text / light markdown as `BlockNote` blocks.
fn text_to_blocks(text: &str) -> Vec<Value> {
    let mut blocks = Vec::new();
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let line = raw.trim_end_matches(js_space);
        if line.trim_matches(js_space).is_empty() {
            continue;
        }
        if let Some(heading) = HEADING.captures(line) {
            blocks.push(json!({
                "type": "heading",
                "props": { "level": heading[1].len() },
                "content": inline(&heading[2]),
                "children": [],
            }));
            continue;
        }
        if let Some(bullet) = BULLET.captures(line) {
            blocks.push(
                json!({ "type": "bulletListItem", "content": inline(&bullet[1]), "children": [] }),
            );
            continue;
        }
        if let Some(numbered) = NUMBERED.captures(line) {
            blocks.push(json!({ "type": "numberedListItem", "content": inline(&numbered[1]), "children": [] }));
            continue;
        }
        blocks.push(json!({
            "type": "paragraph",
            "content": inline(line.trim_matches(js_space)),
            "children": [],
        }));
    }
    blocks
}

/// `blocksToText(blocks)`: every `text`, in order, whitespace collapsed.
fn blocks_to_text(blocks: &Value) -> String {
    fn walk(node: &Value, parts: &mut Vec<String>) {
        match node {
            Value::Array(items) => items.iter().for_each(|item| walk(item, parts)),
            Value::Object(object) => {
                if let Some(Value::String(text)) = object.get("text") {
                    parts.push(text.clone());
                }
                if let Some(content) = object.get("content") {
                    walk(content, parts);
                }
                if let Some(children) = object.get("children") {
                    walk(children, parts);
                }
            }
            _ => {}
        }
    }
    let mut parts = Vec::new();
    walk(blocks, &mut parts);
    parts
        .join(" ")
        .split(js_space)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// `resolveContent(body)`: `{ contentJson, contentText }` when given.
fn resolve_content(body: &Map<String, Value>) -> Option<(Value, String)> {
    if let Some(blocks) = body.get("contentJson") {
        return Some((blocks.clone(), blocks_to_text(blocks)));
    }
    if let Some(Value::String(text)) = body.get("content") {
        let blocks = Value::Array(text_to_blocks(text));
        let text = blocks_to_text(&blocks);
        return Some((blocks, text));
    }
    None
}

// ── pages ────────────────────────────────────────────────────────────────────

/// `loadAccessiblePage(db, id, userId)`: a live page in a space the caller
/// can read, with their access to it.
async fn load_page(
    db: &PgPool,
    id: &str,
    user_id: Option<&str>,
) -> Result<Option<(Value, SpaceAccess)>, Fail> {
    let Some(page) = KNOWLEDGE_PAGES.find_live(db, id).await? else {
        return Ok(None);
    };
    let space_id = page["spaceId"].as_str().unwrap_or_default().to_owned();
    match space_access(db, &space_id, user_id).await? {
        Some(access) if access.can_read => Ok(Some((page, access))),
        _ => Ok(None),
    }
}

/// `nextPosition(db, spaceId, parentId)`.
async fn next_position(db: &PgPool, space_id: &str, parent_id: Option<&str>) -> Result<i64, Fail> {
    let max: Option<i64> = sqlx::query_scalar(
        "select max(position)::bigint from knowledge_pages
         where space_id = $1 and parent_id is not distinct from $2 and deleted_at is null",
    )
    .bind(space_id)
    .bind(parent_id)
    .fetch_one(db)
    .await?;
    Ok(max.unwrap_or(-1).max(-1) + 1)
}

/// `collectSubtreeIds(db, rootId)`: the page and its live descendants.
async fn subtree(db: &PgPool, root: &str) -> Result<Vec<String>, Fail> {
    let mut all = vec![root.to_owned()];
    let mut frontier = vec![root.to_owned()];
    while !frontier.is_empty() {
        frontier = sqlx::query_scalar(
            "select id from knowledge_pages where parent_id = any($1) and deleted_at is null",
        )
        .bind(&frontier)
        .fetch_all(db)
        .await?;
        all.extend(frontier.iter().cloned());
    }
    Ok(all)
}

/// `wouldCreateCycle(db, pageId, newParentId)`.
async fn would_create_cycle(db: &PgPool, page_id: &str, parent_id: &str) -> Result<bool, Fail> {
    let mut current = Some(parent_id.to_owned());
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = current {
        if id == page_id || !seen.insert(id.clone()) {
            return Ok(true);
        }
        current = sqlx::query_scalar::<_, Option<String>>(
            "select parent_id from knowledge_pages where id = $1 limit 1",
        )
        .bind(&id)
        .fetch_optional(db)
        .await?
        .flatten();
    }
    Ok(false)
}

const PAGES_LIST: (&str, &str) = crate::crud::table_list_sql!(
    knowledge_pages,
    "t.deleted_at is null \
     and t.space_id in (select jsonb_array_elements_text($3->'spaceIds')) \
     and ($3->>'parentId' is null or t.parent_id = $3->>'parentId') \
     and ($3->>'search' is null or (t.title like $3->>'search' or t.content_text like $3->>'search'))"
);

/// The caller's readable spaces, narrowed to `spaceId` when given.
async fn readable_scope(caller: &Caller, space_id: Option<&str>) -> Result<Vec<String>, Fail> {
    let ids = access::readable_space_ids(&caller.db, user(caller))
        .await
        .map_err(thrown)?;
    Ok(match space_id {
        Some(space) => ids.into_iter().filter(|id| id == space).collect(),
        None => ids,
    })
}

async fn list_pages(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_KNOWLEDGE_PAGES, raw.as_deref())?;
    let scope = readable_scope(&caller, q.text("spaceId")).await?;
    if scope.is_empty() {
        return whole(Vec::new());
    }
    let filters = json!({
        "spaceIds": scope,
        "parentId": crate::crud::text(&q, "parentId"),
        "search": crate::crud::like(&q, "search"),
    });
    Ok(
        list_page_mapped(&caller.db, PAGES_LIST, &list_query(&q), &filters, |row| {
            KNOWLEDGE_PAGES.js(row)
        })
        .await?,
    )
}

const TREE_SQL: &str = concat!(
    "select ",
    row!(knowledge_pages),
    " from knowledge_pages t where t.space_id = any($1) and t.deleted_at is null \
     order by t.position asc, t.created_at asc"
);

async fn page_tree(caller: Caller, Query(query): Query<HashMap<String, String>>) -> Answer {
    let space_id = query.get("spaceId").filter(|s| !s.is_empty());
    let scope = readable_scope(&caller, space_id.map(String::as_str)).await?;
    if scope.is_empty() {
        return whole(Vec::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(TREE_SQL)
        .bind(&scope)
        .fetch_all(&caller.db)
        .await?;
    let rows = rows
        .into_iter()
        .map(|row| {
            let page = KNOWLEDGE_PAGES.js(row);
            json!({
                "id": field(&page, "id"),
                "spaceId": field(&page, "spaceId"),
                "parentId": field(&page, "parentId"),
                "position": field(&page, "position"),
                "title": field(&page, "title"),
                "icon": field(&page, "icon"),
                "updatedAt": field(&page, "updatedAt"),
            })
        })
        .collect();
    whole(rows)
}

async fn get_page(caller: Caller, Path(id): Path<String>) -> Answer {
    match load_page(&caller.db, &id, user(&caller)).await? {
        Some((page, _)) => ok(page),
        None => Err(not_found("Knowledge page", &id).into()),
    }
}

async fn create_page(State(state): S, caller: Caller, headers: HeaderMap, body: Bytes) -> Answer {
    let parsed = zod::json(&CREATE_KNOWLEDGE_PAGE, &headers, &body)?;
    let body = &parsed.body;
    let user_id = user(&caller);
    let space_id = body["spaceId"].as_str().unwrap_or_default().to_owned();
    let id = generate_id("kpag");
    let stamp = now();

    let space = space_access(&caller.db, &space_id, user_id).await?;
    let Some(space) = space.filter(|s| s.can_read) else {
        return Err(not_found("Knowledge space", &space_id).into());
    };
    if !space.can_write {
        return Err(forbidden(NOT_EDITOR).into());
    }
    let parent_id = body
        .get("parentId")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty());
    if let Some(parent_id) = parent_id {
        let Some((parent, _)) = load_page(&caller.db, parent_id, user_id).await? else {
            return Err(not_found("Parent page", parent_id).into());
        };
        if parent["spaceId"].as_str() != Some(space_id.as_str()) {
            return Err(bad_request("Parent page belongs to a different space").into());
        }
    }
    let (content_json, content_text) =
        resolve_content(body).unwrap_or_else(|| (json!([]), String::new()));
    // `body.parentId ?? null`: an empty string is kept.
    let parent_value = body.get("parentId").cloned().unwrap_or(Value::Null);
    let position = next_position(&caller.db, &space_id, parent_value.as_str()).await?;
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .unwrap_or("Untitled");
    let opt = |key: &str| body.get(key).cloned().unwrap_or(Value::Null);
    let mut values = Map::new();
    values.insert("id".into(), json!(id));
    values.insert("spaceId".into(), json!(space_id));
    values.insert("parentId".into(), parent_value.clone());
    values.insert("position".into(), json!(position));
    values.insert("title".into(), json!(title));
    values.insert("icon".into(), opt("icon"));
    values.insert("coverImage".into(), opt("coverImage"));
    values.insert("contentJson".into(), content_json);
    values.insert("contentText".into(), json!(content_text));
    values.insert("createdBy".into(), json!(user_id));
    values.insert("lastEditedBy".into(), json!(user_id));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    let row = KNOWLEDGE_PAGES
        .insert(&caller.db, &values, &["createdAt", "updatedAt"])
        .await?;
    caller.publish(
        &state.events,
        KNOWLEDGE_PAGE_CREATED,
        &id,
        json!({
            "id": id,
            "spaceId": space_id,
            "parentId": parent_value,
            "title": field(&row, "title"),
        }),
    );
    created(row)
}

async fn update_page(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_KNOWLEDGE_PAGE, &headers, &body)?;
    let body = &parsed.body;
    let user_id = user(&caller);
    let Some((page, access)) = load_page(&caller.db, &id, user_id).await? else {
        return Err(not_found("Knowledge page", &id).into());
    };
    if !access.can_write {
        return Err(forbidden(NOT_EDITOR).into());
    }
    let content = resolve_content(body);
    if content.is_some()
        && page["isLocked"] == Value::Bool(true)
        && body.get("isLocked") != Some(&Value::Bool(false))
    {
        return Err(conflict("Page is locked").into());
    }
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    update.insert("lastEditedBy".into(), json!(user_id));
    for key in ["title", "icon", "coverImage", "isLocked"] {
        if let Some(value) = body.get(key) {
            update.insert(key.into(), value.clone());
        }
    }
    if let Some((blocks, text)) = content {
        update.insert("contentJson".into(), blocks);
        update.insert("contentText".into(), json!(text));
    }
    let row = KNOWLEDGE_PAGES
        .patch(&caller.db, &id, &update, false, &["updatedAt"])
        .await?
        .ok_or_else(|| not_found("Knowledge page", &id))?;
    caller.publish(
        &state.events,
        KNOWLEDGE_PAGE_UPDATED,
        &id,
        json!({ "id": id, "spaceId": field(&row, "spaceId"), "title": field(&row, "title") }),
    );
    ok(row)
}

async fn move_page(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&MOVE_KNOWLEDGE_PAGE, &headers, &body)?;
    let body = &parsed.body;
    let user_id = user(&caller);
    let Some((page, access)) = load_page(&caller.db, &id, user_id).await? else {
        return Err(not_found("Knowledge page", &id).into());
    };
    if !access.can_write {
        return Err(forbidden(NOT_EDITOR).into());
    }
    let current_space = page["spaceId"].as_str().unwrap_or_default().to_owned();
    let target = body
        .get("spaceId")
        .and_then(Value::as_str)
        .map_or_else(|| current_space.clone(), str::to_owned);
    if target != current_space {
        let space = space_access(&caller.db, &target, user_id).await?;
        let Some(space) = space.filter(|s| s.can_read) else {
            return Err(not_found("Knowledge space", &target).into());
        };
        if !space.can_write {
            return Err(forbidden(NOT_EDITOR).into());
        }
    }
    let parent_value = body.get("parentId").cloned().unwrap_or(Value::Null);
    if let Some(parent_id) = parent_value.as_str().filter(|p| !p.is_empty()) {
        let Some((parent, _)) = load_page(&caller.db, parent_id, user_id).await? else {
            return Err(not_found("Parent page", parent_id).into());
        };
        if parent["spaceId"].as_str() != Some(target.as_str()) {
            return Err(bad_request("Parent page belongs to a different space").into());
        }
        if would_create_cycle(&caller.db, &id, parent_id).await? {
            return Err(
                bad_request("Cannot move a page under itself or one of its sub-pages").into(),
            );
        }
    }
    let position = match body.get("position") {
        Some(position) => position.clone(),
        None => json!(next_position(&caller.db, &target, parent_value.as_str()).await?),
    };
    let stamp = now();
    let mut update = Map::new();
    update.insert("parentId".into(), parent_value.clone());
    update.insert("spaceId".into(), json!(target));
    update.insert("position".into(), position.clone());
    update.insert("lastEditedBy".into(), json!(user_id));
    update.insert("updatedAt".into(), json!(stamp));
    let row = KNOWLEDGE_PAGES
        .patch(&caller.db, &id, &update, false, &["updatedAt"])
        .await?
        .ok_or_else(|| not_found("Knowledge page", &id))?;
    // A cross-space move carries the whole subtree along.
    if target != current_space {
        let descendants: Vec<String> = subtree(&caller.db, &id)
            .await?
            .into_iter()
            .filter(|page| *page != id)
            .collect();
        if !descendants.is_empty() {
            sqlx::query(
                "update knowledge_pages set space_id = $2, updated_at = $3::timestamptz where id = any($1)",
            )
            .bind(&descendants)
            .bind(&target)
            .bind(&stamp)
            .execute(&caller.db)
            .await?;
        }
    }
    caller.publish(
        &state.events,
        KNOWLEDGE_PAGE_MOVED,
        &id,
        json!({ "id": id, "spaceId": target, "parentId": parent_value, "position": position }),
    );
    ok(row)
}

async fn delete_page(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    let Some((page, access)) = load_page(&caller.db, &id, user(&caller)).await? else {
        return Err(not_found("Knowledge page", &id).into());
    };
    if !access.can_write {
        return Err(forbidden(NOT_EDITOR).into());
    }
    let ids = subtree(&caller.db, &id).await?;
    sqlx::query(
        "update knowledge_pages set deleted_at = $2::timestamptz, updated_at = $2::timestamptz where id = any($1)",
    )
    .bind(&ids)
    .bind(now())
    .execute(&caller.db)
    .await?;
    caller.publish(
        &state.events,
        KNOWLEDGE_PAGE_DELETED,
        &id,
        json!({ "id": id, "spaceId": field(&page, "spaceId") }),
    );
    no_content()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_reads_as_blocks() {
        let blocks = text_to_blocks("# Title\r\n\n- one\n* two\n1. first\n2) second\n  plain  \n");
        let kinds: Vec<&str> = blocks
            .iter()
            .map(|b| b["type"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(
            kinds,
            [
                "heading",
                "bulletListItem",
                "bulletListItem",
                "numberedListItem",
                "numberedListItem",
                "paragraph"
            ]
        );
        assert_eq!(blocks[0]["props"]["level"], 1);
        assert_eq!(blocks[5]["content"][0]["text"], "plain");
        assert_eq!(
            blocks_to_text(&Value::Array(blocks)),
            "Title one two first second plain"
        );
    }
}
