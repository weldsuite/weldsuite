//! WeldCommerce's objects: `/v1/categories` (`routes/v1/categories/index.ts`,
//! the generic `createCrudRoute`), the products' merchandising groups.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{CATEGORY_CREATED, CATEGORY_DELETED, CATEGORY_UPDATED};
use weldsuite_kit::id::generate_id;

use crate::ExternalApiState;
use crate::crud::{
    Answer, Caller, created, dates, get_live, like, live_or_404, no_content, now, ok, page, pick,
    soft_delete, table_list_sql, text, with_updated,
};
use crate::desk::slugify;
use crate::schemas::{CREATE_CATEGORY, LIST_CATEGORIES, UPDATE_CATEGORY};
use crate::session::{internal_with, not_found};
use crate::simple::scoped;
use crate::tables_gen::CATEGORIES;
use crate::zod;

type S = State<ExternalApiState>;

/// Commerce's routes.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    router
        .route(
            "/categories",
            scoped(get(list_categories), "categories:read")
                .merge(scoped(post(create_category), "categories:write")),
        )
        .route(
            "/categories/{id}",
            scoped(get(get_category), "categories:read").merge(scoped(
                patch(update_category).delete(delete_category),
                "categories:write",
            )),
        )
}

const CATEGORIES_LIST: (&str, &str) = table_list_sql!(
    categories,
    "t.deleted_at is null \
     and ($3->>'search' is null or t.name like $3->>'search' or t.slug like $3->>'search') \
     and ($3->>'parentId' is null or t.parent_id = $3->>'parentId') \
     and ($3->>'type' is null or t.type = $3->>'type')"
);

const EVENT_FIELDS: [&str; 4] = ["name", "slug", "parentId", "type"];

async fn list_categories(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_CATEGORIES, raw.as_deref())?;
    let filters = json!({
        "search": like(&q, "search"),
        "parentId": text(&q, "parentId"),
        "type": text(&q, "type"),
    });
    page(&caller.db, CATEGORIES_LIST, &CATEGORIES, &q, filters).await
}

async fn get_category(caller: Caller, Path(id): Path<String>) -> Answer {
    get_live(&caller.db, &CATEGORIES, "Category", &id).await
}

/// `Number(flag)` of a boolean `isActive`.
fn active_number(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::Bool(flag) => Some(json!(i32::from(*flag))),
        other => Some(other.clone()),
    }
}

async fn create_category(
    State(state): S,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_CATEGORY, &headers, &body)?;
    let body = &parsed.body;
    let name = body.get("name").and_then(Value::as_str).unwrap_or_default();
    let slug = body
        .get("slug")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| Some(slugify(name, 255)).filter(|s| !s.is_empty()))
        .unwrap_or_else(|| {
            let millis = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
            format!("cat-{millis}")
        });
    let stamp = now();
    let id = generate_id("cat");
    // `{ id, createdAt, updatedAt, ...prepareCreate(body) }`.
    let mut values = Map::new();
    values.insert("id".into(), json!(id));
    values.insert("createdAt".into(), json!(stamp));
    values.insert("updatedAt".into(), json!(stamp));
    values.extend(body.clone());
    values.insert("slug".into(), json!(slug));
    let kind = match body.get("type") {
        Some(Value::Null) | None => json!("manual"),
        Some(kind) => kind.clone(),
    };
    values.insert("type".into(), kind);
    let active = active_number(body.get("isActive"))
        .filter(|v| !v.is_null())
        .unwrap_or(json!(1));
    values.insert("isActive".into(), active);
    values.insert("depth".into(), json!(0));
    values.insert("path".into(), Value::Null);
    let row = CATEGORIES
        .insert(
            &caller.db,
            &values,
            &dates(&parsed, &["createdAt", "updatedAt"]),
        )
        .await?;
    caller.publish(
        &state.events,
        CATEGORY_CREATED,
        &id,
        pick(&id, &row, &EVENT_FIELDS),
    );
    created(row)
}

async fn update_category(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_CATEGORY, &headers, &body)?;
    live_or_404(&caller.db, &CATEGORIES, "Category", &id).await?;
    let mut body = parsed.body.clone();
    if let Some(Value::Bool(flag)) = body.get("isActive").cloned() {
        body.insert("isActive".into(), json!(i32::from(flag)));
    }
    let update = with_updated(&body, &now());
    let row = CATEGORIES
        .patch(
            &caller.db,
            &id,
            &update,
            true,
            &dates(&parsed, &["updatedAt"]),
        )
        .await?
        .ok_or_else(|| internal_with("Failed to update category"))?;
    caller.publish(
        &state.events,
        CATEGORY_UPDATED,
        &id,
        pick(&id, &row, &EVENT_FIELDS),
    );
    ok(row)
}

async fn delete_category(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    soft_delete(&caller.db, &CATEGORIES, &id)
        .await?
        .ok_or_else(|| not_found("Category", &id))?;
    caller.publish(&state.events, CATEGORY_DELETED, &id, json!({ "id": id }));
    no_content()
}
