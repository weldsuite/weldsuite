//! `/api/pipeline-stages` (`routes/pipeline-stages/index.ts`): the stages of
//! the CRM pipelines in `crm_pipeline_stages`, with `POST /reorder` to
//! renumber `position` for a pipeline.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    PIPELINE_STAGE_CREATED, PIPELINE_STAGE_DELETED, PIPELINE_STAGE_UPDATED,
};
use weldsuite_crm_domain::tables::CRM_PIPELINE_STAGES;
use weldsuite_crm_domain::{drizzle_row, insert_sql, update_sql};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};

use crate::schema::{Kind, NULLISH, OPT, REQ, Spec, int, partial, s};
use crate::{
    Answer, Caller, CrmState, answer, cut, js_limit, now, page, query_map, validate, validate_specs,
};

const LOG: &str = "pipeline-stages";

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

async fn live(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from crm_pipeline_stages t
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(drizzle_row))
}

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let result = async {
        let q = query_map(query.as_deref());
        let limit = js_limit(q.get("limit"), 100, 200)
            .ok_or_else(|| crate::Refusal::Failed("limit is NaN".to_owned()))?;
        let pipeline = q.get("pipeline").filter(|p| !p.is_empty());
        // Ties on `position` list open stages before won/lost ones, then by
        // creation order.
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from crm_pipeline_stages t
             where deleted_at is null and ($1::text is null or pipeline = $1)
             order by position asc,
                      case when (coalesce(is_won, false) or coalesce(is_lost, false)) then 1 else 0 end asc,
                      created_at asc, id asc
             limit $2",
        )
        .bind(pipeline)
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "select count(*) from crm_pipeline_stages
             where deleted_at is null and ($1::text is null or pipeline = $1)",
        )
        .bind(pipeline)
        .fetch_one(&caller.db)
        .await?;
        let (data, has_more, next) = cut(rows.into_iter().map(drizzle_row).collect(), limit);
        Ok(page(data, total, has_more, next))
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
) -> Result<(i64, i64), sqlx::Error> {
    let existing: Vec<(i32, Option<bool>, Option<bool>)> = sqlx::query_as(
        "select position, is_won, is_lost from crm_pipeline_stages
         where pipeline = $1 and deleted_at is null",
    )
    .bind(pipeline)
    .fetch_all(&caller.db)
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
    let now = now();
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
    let mut tx = caller.db.begin().await?;
    if shift != 0 {
        sqlx::query(
            "update crm_pipeline_stages set position = position + $2, updated_at = $3::timestamp
             where pipeline = $1 and deleted_at is null
               and (coalesce(is_won, false) or coalesce(is_lost, false))",
        )
        .bind(&pipeline)
        .bind(i32::try_from(shift).unwrap_or(i32::MAX))
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(insert_sql!(crm_pipeline_stages))
        .bind(CRM_PIPELINE_STAGES.values(&values))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
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
        sqlx::query(update_sql!(
            crm_pipeline_stages,
            "where t.id = $1 and t.deleted_at is null"
        ))
        .bind(&id)
        .bind(CRM_PIPELINE_STAGES.set(&update))
        .execute(&caller.db)
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
        let deals: i64 = sqlx::query_scalar(
            "select count(*) from crm_opportunities
             where (stage_id = $1 or stage = $1) and deleted_at is null",
        )
        .bind(&id)
        .fetch_one(&caller.db)
        .await?;
        let name = existing.get("name").and_then(Value::as_str).unwrap_or_default();
        if deals > 0 {
            return Ok(ApiError::bad_request(format!(
                "Cannot delete stage \"{name}\": it still has {deals} deal(s). Move them to another stage first."
            ))
            .into_response());
        }
        let now = now();
        sqlx::query(
            "update crm_pipeline_stages set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(&now)
        .execute(&caller.db)
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
        let now = now();
        if !ids.is_empty() {
            let mut tx = caller.db.begin().await?;
            for (position, id) in ids.iter().enumerate() {
                sqlx::query(
                    "update crm_pipeline_stages set position = $3, updated_at = $4::timestamp
                     where id = $1 and pipeline = $2 and deleted_at is null",
                )
                .bind(id)
                .bind(&pipeline)
                .bind(i32::try_from(position).unwrap_or(i32::MAX))
                .bind(&now)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
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
