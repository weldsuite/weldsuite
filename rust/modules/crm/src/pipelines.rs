//! `/api/pipelines` (`routes/pipelines/index.ts`): the CRM pipelines in
//! `crm_pipelines`. Stage CRUD lives at `/api/pipeline-stages`.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{PIPELINE_CREATED, PIPELINE_DELETED, PIPELINE_UPDATED};
use weldsuite_crm_domain::tables::CRM_PIPELINES;
use weldsuite_db::record::JsonTable;
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::{crm_pipeline_stages, crm_pipelines};

use crate::orm_rows::{after, cursor_row, insert_values, json, probe_limit, set_values};
use crate::schema::{Kind, NULLISH, OPT, REQ, Spec, extend, partial, s};
use crate::{
    Answer, Caller, CrmState, Refusal, answer, cut, js_limit, now, page, query_map, validate_specs,
};

const LOG: &str = "pipelines";

/// `crm_pipelines`, written from a body as Drizzle wrote it.
const PIPELINES: JsonTable = JsonTable::of::<crm_pipelines::Entity>();

/// `createPipelineSchema`.
const CREATE: [Spec; 7] = [
    Spec::new("name", s(Some(1), Some(255)), REQ),
    Spec::new("description", s(None, Some(1000)), NULLISH),
    Spec::new("icon", s(None, Some(100)), NULLISH),
    Spec::new("color", s(None, Some(50)), NULLISH),
    Spec::new("template", s(None, Some(100)), NULLISH),
    Spec::new("settings", Kind::Unknown, NULLISH),
    Spec::new("isDefault", Kind::Bool, OPT),
];

/// `updatePipelineSchema`: the create schema, partial, plus `isArchived`.
fn update_schema() -> Vec<Spec> {
    extend(
        &partial(&CREATE),
        &[Spec::new("isArchived", Kind::Bool, OPT)],
    )
}

async fn live(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    let row = crm_pipelines::Entity::find_by_id(id.to_owned())
        .filter(crm_pipelines::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?;
    row.map(|row| json(serde_json::to_value(row))).transpose()
}

/// The list's conditions that are `on` (live, active, archived, search),
/// in TypeScript's order.
fn list_filters(on: &[bool], like: Option<&String>) -> Condition {
    use crm_pipelines::Column;
    let mut filters = Condition::all();
    if on[0] {
        filters = filters.add(Column::DeletedAt.is_null());
    }
    if on[1] {
        filters = filters.add(Column::IsArchived.eq(false));
    }
    if on[2] {
        filters = filters.add(Column::IsArchived.eq(true));
    }
    if on[3]
        && let Some(like) = like
    {
        filters = filters.add(Column::Name.like(like.as_str()));
    }
    filters
}

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    answer(
        run_list(&caller, query.as_deref()).await,
        LOG,
        "Failed to list pipelines",
    )
}

async fn run_list(caller: &Caller, query: Option<&str>) -> Answer {
    use crm_pipelines::{Column, Entity};
    let q = query_map(query);
    let limit = js_limit(q.get("limit"), 50, 100);
    let archived = q.get("archived").map_or("active", String::as_str);
    let search = q.get("search").filter(|s| !s.is_empty());
    // The cursor row's position, read before the list (outside its try).
    let mut cursor = None;
    if let Some(id) = q.get("cursor").filter(|c| !c.is_empty()) {
        cursor = cursor_row::<Entity>(&caller.db, Column::CreatedAt, Column::Id, id).await?;
    }
    let limit = limit.ok_or_else(|| Refusal::Failed("limit is NaN".to_owned()))?;
    // The filters in TypeScript's order; a cursor that was given drops the
    // last one from the count (`conditions.slice(0, -1)`), found or not.
    let mut on = vec![
        true,
        archived == "active",
        archived == "archived",
        search.is_some(),
    ];
    let page_on = on.clone();
    if q.get("cursor").is_some_and(|c| !c.is_empty()) && cursor.is_none() {
        // No cursor condition was pushed: the slice drops a real filter.
        if let Some(last) = on.iter().rposition(|f| *f) {
            on[last] = false;
        }
    }
    let like = search.map(|s| format!("%{s}%"));
    let mut rows = Entity::find().filter(list_filters(&page_on, like.as_ref()));
    if let Some(cursor) = &cursor {
        rows = rows.filter(after(Column::CreatedAt, Column::Id, cursor));
    }
    let db = orm(&caller.db);
    let rows = rows
        .order_by_asc(Column::CreatedAt)
        .order_by_asc(Column::Id)
        .limit(probe_limit(limit)?)
        .all(&db)
        .await?;
    let total = Entity::find()
        .filter(list_filters(&on, like.as_ref()))
        .count(&db)
        .await?;
    let rows = rows
        .into_iter()
        .map(|row| json(serde_json::to_value(row)))
        .collect::<Result<Vec<_>, DbErr>>()?;
    let (data, has_more, next) = cut(rows, limit);
    let next = if data.is_empty() { None } else { next };
    Ok(page(
        data,
        i64::try_from(total).unwrap_or(i64::MAX),
        has_more,
        next,
    ))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match live(&caller, &id).await? {
            Some(row) => Ok(Data(row).into_response()),
            None => Ok(ApiError::not_found("Pipeline", Some(&id)).into_response()),
        }
    }
    .await;
    answer(result, LOG, "Failed to fetch pipeline")
}

// ── POST / ──────────────────────────────────────────────────────────────────

pub(crate) async fn create(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate_specs(&headers, &body, &CREATE) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    answer(
        run_create(&state, &caller, &data).await,
        LOG,
        "Failed to create pipeline",
    )
}

async fn run_create(state: &CrmState, caller: &Caller, data: &Map<String, Value>) -> Answer {
    let id = generate_id("pl");
    let now = now();
    let mut values = Map::new();
    values.insert("id".into(), json!(id));
    for key in [
        "name",
        "description",
        "icon",
        "color",
        "template",
        "settings",
    ] {
        if let Some(value) = data.get(key) {
            values.insert(key.into(), value.clone());
        }
    }
    values.insert(
        "isDefault".into(),
        data.get("isDefault").cloned().unwrap_or(json!(false)),
    );
    values.insert("isArchived".into(), json!(false));
    values.insert("createdAt".into(), json!(now));
    values.insert("updatedAt".into(), json!(now));
    let created = PIPELINES
        .insert(&orm(&caller.db), insert_values(&CRM_PIPELINES, &values))
        .await?;
    let mut event = Map::new();
    event.insert("id".into(), json!(id));
    for key in ["name", "icon", "color"] {
        if let Some(value) = values.get(key) {
            event.insert(key.into(), value.clone());
        }
    }
    caller.publish(state, PIPELINE_CREATED, &id, &Value::Object(event));
    Ok(Created(created).into_response())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate_specs(&headers, &body, &update_schema()) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    answer(
        run_update(&state, &caller, &id, &data).await,
        LOG,
        "Failed to update pipeline",
    )
}

async fn run_update(
    state: &CrmState,
    caller: &Caller,
    id: &str,
    data: &Map<String, Value>,
) -> Answer {
    if live(caller, id).await?.is_none() {
        return Ok(ApiError::not_found("Pipeline", Some(id)).into_response());
    }
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    for (key, value) in data {
        update.insert(key.clone(), value.clone());
    }
    let row = PIPELINES
        .update(
            &orm(&caller.db),
            id,
            set_values(&CRM_PIPELINES, &update),
            true,
        )
        .await?;
    let mut event = Map::new();
    event.insert("id".into(), json!(id));
    for (key, value) in &update {
        event.insert(key.clone(), value.clone());
    }
    caller.publish(state, PIPELINE_UPDATED, id, &Value::Object(event));
    Ok(Data(row.unwrap_or(Value::Null)).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = live(&caller, &id).await? else {
            return Ok(ApiError::not_found("Pipeline", Some(&id)).into_response());
        };
        let now = utc_now();
        let db = orm(&caller.db);
        // The stages go with the pipeline.
        crm_pipeline_stages::Entity::update_many()
            .col_expr(crm_pipeline_stages::Column::DeletedAt, Expr::value(now))
            .col_expr(crm_pipeline_stages::Column::UpdatedAt, Expr::value(now))
            .filter(crm_pipeline_stages::Column::Pipeline.eq(id.as_str()))
            .filter(crm_pipeline_stages::Column::DeletedAt.is_null())
            .exec(&db)
            .await?;
        crm_pipelines::Entity::update_many()
            .col_expr(crm_pipelines::Column::DeletedAt, Expr::value(now))
            .col_expr(crm_pipelines::Column::UpdatedAt, Expr::value(now))
            .filter(crm_pipelines::Column::Id.eq(id.as_str()))
            .exec(&db)
            .await?;
        caller.publish(
            &state,
            PIPELINE_DELETED,
            &id,
            &json!({ "id": id, "name": existing.get("name") }),
        );
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, LOG, "Failed to delete pipeline")
}
