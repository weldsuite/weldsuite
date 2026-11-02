//! `/api/pipeline-field-visibility/:id/field-visibility`
//! (`routes/pipeline-field-visibility/index.ts`): the
//! `crm_pipelines.settings.fieldVisibility` sub-object; the other settings
//! keys are kept as they are on write.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::PIPELINE_UPDATED;
use weldsuite_kit::ApiError;
use weldsuite_kit::Data;
use weldsuite_kit::validation::Text;

use crate::schema::{Kind, OPT, Spec};
use crate::{Caller, CrmState, answer, now, validate_specs};

const LOG: &str = "pipeline-field-visibility";

/// `pipelineFieldVisibilitySchema`.
const SCHEMA: [Spec; 2] = [
    Spec::new(
        "grid",
        Kind::StrArray {
            item: Text::length(Some(1), Some(120)),
            min: None,
            max: Some(200),
        },
        OPT,
    ),
    Spec::new(
        "kanban",
        Kind::StrArray {
            item: Text::length(Some(1), Some(120)),
            min: None,
            max: Some(200),
        },
        OPT,
    ),
];

/// The live pipeline's `settings` (`null` when it has none), or `None`.
async fn settings_of(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<(Option<Value>,)> = sqlx::query_as(
        "select settings from crm_pipelines where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(|(settings,)| settings.unwrap_or(Value::Null)))
}

/// `settings.fieldVisibility ?? {}` of `(row.settings ?? {})`.
fn visibility_of(settings: &Value) -> Value {
    match settings.get("fieldVisibility") {
        None | Some(Value::Null) => json!({}),
        Some(value) => value.clone(),
    }
}

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        Ok(match settings_of(&caller, &id).await? {
            Some(settings) => Data(visibility_of(&settings)).into_response(),
            None => ApiError::not_found("Pipeline", Some(&id)).into_response(),
        })
    }
    .await;
    answer(result, LOG, "Failed to read pipeline field visibility")
}

pub(crate) async fn update(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate_specs(&headers, &body, &SCHEMA) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let Some(settings) = settings_of(&caller, &id).await? else {
            return Ok(ApiError::not_found("Pipeline", Some(&id)).into_response());
        };
        // `{ ...existing, fieldVisibility: { ...existing.fieldVisibility, ...input } }`
        let mut next = match settings {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        let mut visibility = match next.get("fieldVisibility") {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        for (key, value) in &input {
            visibility.insert(key.clone(), value.clone());
        }
        next.insert("fieldVisibility".into(), Value::Object(visibility.clone()));
        sqlx::query(
            "update crm_pipelines set settings = $2, updated_at = $3::timestamp
             where id = $1 and deleted_at is null",
        )
        .bind(&id)
        .bind(Value::Object(next))
        .bind(now())
        .execute(&caller.db)
        .await?;
        caller.publish(&state, PIPELINE_UPDATED, &id, &json!({ "id": id }));
        Ok(Data(Value::Object(visibility)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to update pipeline field visibility")
}
