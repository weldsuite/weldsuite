//! `/api/pipeline-stages` (`routes/pipeline-stages/index.ts`): the stages of
//! the CRM pipelines in `crm_pipeline_stages`, with `POST /reorder` to
//! renumber `position` for a pipeline.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::{Expr, Func, Order};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PIPELINE_STAGE_CREATED, PIPELINE_STAGE_DELETED, PIPELINE_STAGE_UPDATED,
};
use weldsuite_crm_domain::tables::CRM_PIPELINE_STAGES;
use weldsuite_db::record::JsonTable;
use weldsuite_db::{OrmConn, orm, orm_error, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::crm_opportunities;
use weldsuite_schema::tenant::crm_pipeline_stages::{self as stages, Column};

use crate::orm_rows::{insert_values, json, probe_limit, set_values};
use crate::schema::{Kind, NULLISH, OPT, REQ, Spec, int, partial, s};
use crate::{
    Answer, Caller, CrmState, answer, cut, js_limit, now, page, query_map, validate, validate_specs,
};

const LOG: &str = "pipeline-stages";

/// `crm_pipeline_stages`, written from a body as Drizzle wrote it.
const STAGES: JsonTable = JsonTable::of::<stages::Entity>();

/// `createPipelineStageSchema`.
const CREATE: [Spec; 9] = [
    Spec::new("name", s(Some(1), Some(255)), REQ),
    Spec::new("description", s(None, Some(1000)), NULLISH),
    Spec::new("position", int(Some(0.0), None), OPT),
    Spec::new("probability", int(Some(0.0), Some(100.0)), NULLISH),
    Spec::new("color", s(None, Some(50)), NULLISH),
    Spec::new("pipeline", s(None, Some(100)), OPT).with_default("\"default\""),
    Spec::new("isDefault", Kind::Bool, OPT),
    Spec::new("isWon", Kind::Bool, OPT),
    Spec::new("isLost", Kind::Bool, OPT),
];

async fn live(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    let row = stages::Entity::find_by_id(id.to_owned())
        .filter(Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?;
    row.map(|row| json(serde_json::to_value(row))).transpose()
}

/// `coalesce(is_won, false) or coalesce(is_lost, false)`: a won or lost
/// stage.
fn closed() -> Expr {
    use sea_orm::ExprTrait as _;
    let flag = |column: Column| {
        Expr::from(Func::coalesce([
            Expr::col((stages::Entity, column)),
            Expr::val(false),
        ]))
    };
    flag(Column::IsWon).or(flag(Column::IsLost))
}

/// The live stages of `pipeline` (every pipeline's without one).
fn live_in(pipeline: Option<&String>) -> Condition {
    let mut filters = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(pipeline) = pipeline {
        filters = filters.add(Column::Pipeline.eq(pipeline.as_str()));
    }
    filters
}

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let result = async {
        let q = query_map(query.as_deref());
        let limit = js_limit(q.get("limit"), 100, 200)
            .ok_or_else(|| crate::Refusal::Failed("limit is NaN".to_owned()))?;
        let pipeline = q.get("pipeline").filter(|p| !p.is_empty());
        let db = orm(&caller.db);
        // Ties on `position` list open stages before won/lost ones, then by
        // creation order.
        let rows = stages::Entity::find()
            .filter(live_in(pipeline))
            .order_by_asc(Column::Position)
            .order_by(
                Into::<Expr>::into(Expr::case(closed(), 1).finally(0)),
                Order::Asc,
            )
            .order_by_asc(Column::CreatedAt)
            .order_by_asc(Column::Id)
            .limit(probe_limit(limit)?)
            .all(&db)
            .await?;
        let total = stages::Entity::find()
            .filter(live_in(pipeline))
            .count(&db)
            .await?;
        let rows = rows
            .into_iter()
            .map(|row| json(serde_json::to_value(row)))
            .collect::<Result<Vec<_>, DbErr>>()?;
        let (data, has_more, next) = cut(rows, limit);
        Ok(page(
            data,
            i64::try_from(total).unwrap_or(i64::MAX),
            has_more,
            next,
        ))
    }
    .await;
    answer(result, LOG, "Failed to list pipeline stages")
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        Ok(match live(&caller, &id).await? {
            Some(row) => Data(row).into_response(),
            None => ApiError::not_found("Pipeline stage", Some(&id)).into_response(),
        })
    }
    .await;
    answer(result, LOG, "Failed to fetch pipeline stage")
}

// ── POST / ──────────────────────────────────────────────────────────────────

/// `nextStagePosition`: where a stage without a `position` goes, and how far
/// the won/lost stages move right to make room.
async fn next_stage_position(
    caller: &Caller,
    pipeline: &str,
    closed: bool,
) -> Result<(i64, i64), DbErr> {
    let existing: Vec<(i32, Option<bool>, Option<bool>)> = stages::Entity::find()
        .select_only()
        .columns([Column::Position, Column::IsWon, Column::IsLost])
        .filter(Column::Pipeline.eq(pipeline))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(&caller.db))
        .await?;
    if closed {
        let max = existing.iter().map(|(p, _, _)| i64::from(*p)).max();
        return Ok((max.map_or(0, |max| max + 1), 0));
    }
    let is_closed = |won: Option<bool>, lost: Option<bool>| won == Some(true) || lost == Some(true);
    let open: Vec<i64> = existing
        .iter()
        .filter(|(_, won, lost)| !is_closed(*won, *lost))
        .map(|(p, _, _)| i64::from(*p))
        .collect();
    let closed_positions: Vec<i64> = existing
        .iter()
        .filter(|(_, won, lost)| is_closed(*won, *lost))
        .map(|(p, _, _)| i64::from(*p))
        .collect();
    let min_closed = closed_positions.iter().copied().min();
    let position = match (open.iter().copied().max(), min_closed) {
        (Some(max), _) => max + 1,
        (None, Some(min)) => min,
        (None, None) => 0,
    };
    let shift = min_closed.map_or(0, |min| (position + 1 - min).max(0));
    Ok((position, shift))
}

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
        "Failed to create pipeline stage",
    )
}

async fn run_create(state: &CrmState, caller: &Caller, data: &Map<String, Value>) -> Answer {
    let id = generate_id("pls");
    // One instant: the row's text and the shift's `timestamp`.
    let at = time::OffsetDateTime::now_utc();
    let now = weldsuite_events::iso_timestamp(at);
    let pipeline = data
        .get("pipeline")
        .and_then(Value::as_str)
        .unwrap_or("default")
        .to_owned();
    let truthy = |key: &str| data.get(key).and_then(Value::as_bool).unwrap_or(false);
    let (position, shift) = match data.get("position").and_then(Value::as_i64) {
        Some(position) => (position, 0),
        None => next_stage_position(caller, &pipeline, truthy("isWon") || truthy("isLost")).await?,
    };
    let mut values = Map::new();
    values.insert("id".into(), json!(id));
    values.insert(
        "name".into(),
        data.get("name").cloned().unwrap_or(Value::Null),
    );
    if let Some(description) = data.get("description") {
        values.insert("description".into(), description.clone());
    }
    values.insert("position".into(), json!(position));
    values.insert(
        "probability".into(),
        data.get("probability")
            .filter(|p| !p.is_null())
            .cloned()
            .unwrap_or(json!(0)),
    );
    if let Some(color) = data.get("color") {
        values.insert("color".into(), color.clone());
    }
    values.insert("pipeline".into(), json!(pipeline));
    for key in ["isDefault", "isWon", "isLost"] {
        values.insert(key.into(), data.get(key).cloned().unwrap_or(json!(false)));
    }
    values.insert("createdAt".into(), json!(now));
    values.insert("updatedAt".into(), json!(now));
    // Inserting before the closed stages pushes them right in the same
    // transaction.
    let mut tx = caller.db.begin().await.map_err(orm_error)?;
    {
        let db = OrmConn::new(&mut tx);
        if shift != 0 {
            use sea_orm::ExprTrait as _;
            stages::Entity::update_many()
                .col_expr(
                    Column::Position,
                    Expr::col(Column::Position).add(i32::try_from(shift).unwrap_or(i32::MAX)),
                )
                .col_expr(Column::UpdatedAt, Expr::value(utc_timestamp(at)))
                .filter(Column::Pipeline.eq(pipeline.as_str()))
                .filter(Column::DeletedAt.is_null())
                .filter(closed())
                .exec(&db)
                .await?;
        }
        STAGES
            .insert(&db, insert_values(&CRM_PIPELINE_STAGES, &values))
            .await?;
    }
    tx.commit().await.map_err(orm_error)?;
    caller.publish(
        state,
        PIPELINE_STAGE_CREATED,
        &id,
        &json!({ "id": id, "name": values["name"], "pipeline": pipeline, "position": position }),
    );
    Ok(Created(json!({ "id": id })).into_response())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate_specs(&headers, &body, &partial(&CREATE)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let Some(existing) = live(&caller, &id).await? else {
            return Ok(ApiError::not_found("Pipeline stage", Some(&id)).into_response());
        };
        let mut update = Map::new();
        update.insert("updatedAt".into(), json!(now()));
        for (key, value) in &data {
            update.insert(key.clone(), value.clone());
        }
        STAGES
            .update(
                &orm(&caller.db),
                &id,
                set_values(&CRM_PIPELINE_STAGES, &update),
                true,
            )
            .await?;
        let mut event = Map::new();
        event.insert("id".into(), json!(id));
        event.insert(
            "pipeline".into(),
            existing.get("pipeline").cloned().unwrap_or(Value::Null),
        );
        for (key, value) in &update {
            event.insert(key.clone(), value.clone());
        }
        caller.publish(&state, PIPELINE_STAGE_UPDATED, &id, &Value::Object(event));
        Ok(Data(json!({ "id": id })).into_response())
    }
    .await;
    answer(result, LOG, "Failed to update pipeline stage")
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = live(&caller, &id).await? else {
            return Ok(ApiError::not_found("Pipeline stage", Some(&id)).into_response());
        };
        // Deleting a stage that still holds deals would orphan them.
        let deals = crm_opportunities::Entity::find()
            .filter(
                Condition::any()
                    .add(crm_opportunities::Column::StageId.eq(id.as_str()))
                    .add(crm_opportunities::Column::Stage.eq(id.as_str())),
            )
            .filter(crm_opportunities::Column::DeletedAt.is_null())
            .count(&orm(&caller.db))
            .await?;
        let name = existing.get("name").and_then(Value::as_str).unwrap_or_default();
        if deals > 0 {
            return Ok(ApiError::bad_request(format!(
                "Cannot delete stage \"{name}\": it still has {deals} deal(s). Move them to another stage first."
            ))
            .into_response());
        }
        let now = utc_now();
        stages::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(now))
            .col_expr(Column::UpdatedAt, Expr::value(now))
            .filter(Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(
            &state,
            PIPELINE_STAGE_DELETED,
            &id,
            &json!({ "id": id, "pipeline": existing.get("pipeline"), "name": existing.get("name") }),
        );
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, LOG, "Failed to delete pipeline stage")
}

// ── POST /reorder ───────────────────────────────────────────────────────────

/// `reorderPipelineStagesSchema`.
fn reorder_input(
    issues: &mut weldsuite_kit::validation::Issues,
    body: &Map<String, Value>,
) -> (String, Vec<String>) {
    let pipeline = issues
        .text_with(body, "pipeline", Presence::Optional, Text::default())
        .into_option()
        .unwrap_or_else(|| "default".to_owned());
    let ids = issues
        .list(
            body,
            "ids",
            Presence::Required,
            Some(1),
            None,
            |issues, item| issues.item_text(item, Text::default()),
        )
        .into_option()
        .unwrap_or_default();
    (pipeline, ids)
}

pub(crate) async fn reorder(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (pipeline, ids) = match validate(&headers, &body, reorder_input) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let now = utc_now();
        if !ids.is_empty() {
            let mut tx = caller.db.begin().await.map_err(orm_error)?;
            {
                let db = OrmConn::new(&mut tx);
                for (position, id) in ids.iter().enumerate() {
                    stages::Entity::update_many()
                        .col_expr(
                            Column::Position,
                            Expr::value(i32::try_from(position).unwrap_or(i32::MAX)),
                        )
                        .col_expr(Column::UpdatedAt, Expr::value(now))
                        .filter(Column::Id.eq(id.as_str()))
                        .filter(Column::Pipeline.eq(pipeline.as_str()))
                        .filter(Column::DeletedAt.is_null())
                        .exec(&db)
                        .await?;
                }
            }
            tx.commit().await.map_err(orm_error)?;
        }
        for (position, id) in ids.iter().enumerate() {
            caller.publish(
                &state,
                PIPELINE_STAGE_UPDATED,
                id,
                &json!({ "id": id, "pipeline": pipeline, "position": position }),
            );
        }
        Ok(Data(json!({ "pipeline": pipeline, "ids": ids })).into_response())
    }
    .await;
    answer(result, LOG, "Failed to reorder pipeline stages")
}
