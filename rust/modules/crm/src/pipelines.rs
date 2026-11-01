//! `/api/pipelines` (`routes/pipelines/index.ts`): the CRM pipelines in
//! `crm_pipelines`. Stage CRUD lives at `/api/pipeline-stages`.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{PIPELINE_CREATED, PIPELINE_DELETED, PIPELINE_UPDATED};
use weldsuite_crm_domain::tables::CRM_PIPELINES;
use weldsuite_crm_domain::{drizzle_row, insert_sql, update_sql};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};

use crate::schema::{Kind, NULLISH, OPT, REQ, Spec, extend, partial, s};
use crate::{
    Answer, Caller, CrmState, Refusal, answer, cut, js_limit, now, page, query_map, validate_specs,
};

const LOG: &str = "pipelines";

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

async fn live(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from crm_pipelines t where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(drizzle_row))
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
    let q = query_map(query);
    let limit = js_limit(q.get("limit"), 50, 100);
    let archived = q.get("archived").map_or("active", String::as_str);
    let search = q.get("search").filter(|s| !s.is_empty());
    // The cursor row's position, read before the list (outside its try).
    let mut cursor: Option<(String, String)> = None;
    if let Some(id) = q.get("cursor").filter(|c| !c.is_empty()) {
        cursor = sqlx::query_as(
            "select to_char(date_trunc('milliseconds', created_at), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), id
             from crm_pipelines where id = $1 limit 1",
        )
        .bind(id)
        .fetch_optional(&caller.db)
        .await
        .map_err(|e| Refusal::Failed(e.to_string()))?;
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
    let (cursor_at, cursor_id) = cursor.clone().unzip();
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from crm_pipelines t
         where (not $1 or deleted_at is null)
           and (not $2 or is_archived = false)
           and (not $3 or is_archived = true)
           and (not $4 or name like $5)
           and ($6::timestamp is null
                or created_at > $6::timestamp or (created_at = $6::timestamp and id > $7))
         order by created_at asc, id asc
         limit $8",
    )
    .bind(page_on[0])
    .bind(page_on[1])
    .bind(page_on[2])
    .bind(page_on[3])
    .bind(&like)
    .bind(&cursor_at)
    .bind(&cursor_id)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from crm_pipelines
         where (not $1 or deleted_at is null)
           and (not $2 or is_archived = false)
           and (not $3 or is_archived = true)
           and (not $4 or name like $5)",
    )
    .bind(on[0])
    .bind(on[1])
    .bind(on[2])
    .bind(on[3])
    .bind(&like)
    .fetch_one(&caller.db)
    .await?;
    let (data, has_more, next) = cut(rows.into_iter().map(drizzle_row).collect(), limit);
    let next = if data.is_empty() { None } else { next };
    Ok(page(data, total, has_more, next))
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
    sqlx::query(insert_sql!(crm_pipelines))
        .bind(CRM_PIPELINES.values(&values))
        .execute(&caller.db)
        .await?;
    let created = live_any(caller, &id).await?;
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

async fn live_any(caller: &Caller, id: &str) -> Result<Value, sqlx::Error> {
    let row: Value =
        sqlx::query_scalar("select to_jsonb(t) from crm_pipelines t where id = $1 limit 1")
            .bind(id)
            .fetch_one(&caller.db)
            .await?;
    Ok(drizzle_row(row))
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
    let row: Option<Value> = sqlx::query_scalar(update_sql!(
        crm_pipelines,
        "where t.id = $1 and t.deleted_at is null returning to_jsonb(t)"
    ))
    .bind(id)
    .bind(CRM_PIPELINES.set(&update))
    .fetch_optional(&caller.db)
    .await?;
    let mut event = Map::new();
    event.insert("id".into(), json!(id));
    for (key, value) in &update {
        event.insert(key.clone(), value.clone());
    }
    caller.publish(state, PIPELINE_UPDATED, id, &Value::Object(event));
    Ok(Data(row.map_or(Value::Null, drizzle_row)).into_response())
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
        let now = now();
        // The stages go with the pipeline.
        sqlx::query(
            "update crm_pipeline_stages set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where pipeline = $1 and deleted_at is null",
        )
        .bind(&id)
        .bind(&now)
        .execute(&caller.db)
        .await?;
        sqlx::query(
            "update crm_pipelines set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(&now)
        .execute(&caller.db)
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
