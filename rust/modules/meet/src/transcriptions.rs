//! `/api/transcriptions` (`routes/transcriptions/index.ts`): transcripts
//! linked to an activity (a call, a meeting-bot session, a WeldMeet session,
//! a legacy meeting or a CRM activity) and their segments. Scoped to the
//! activity's owner unless the caller holds `activities:scope:all`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    TRANSCRIPTION_CREATED, TRANSCRIPTION_DELETED, TRANSCRIPTION_UPDATED,
};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::text;
use crate::tables::{CRM_TRANSCRIPT_SEGMENTS, CRM_TRANSCRIPTIONS};
use crate::{Caller, MeetState, internal, now, validate};

const ACTIVITY_DENIED: &str = "You do not have access to this transcript";

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<MeetState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/{id}", get(detail).route_layer(need("activities:read")))
        .route(
            "/by-activity/{activity}",
            get(by_activity).route_layer(need("activities:read")),
        )
        .route(
            "/by-activity/{activity}/status",
            get(status_by_activity).route_layer(need("activities:read")),
        )
        .route("/", post(create).route_layer(need("activities:create")))
        .route(
            "/{id}",
            patch(update).route_layer(need("activities:update")),
        )
        .route(
            "/{id}",
            delete(remove).route_layer(need("activities:delete")),
        )
        .route(
            "/{id}/segments",
            get(segments).route_layer(need("activities:read")),
        )
        .route(
            "/{id}/segments",
            post(create_segments).route_layer(need("activities:create")),
        )
        .route(
            "/{id}/segments",
            delete(delete_segments).route_layer(need("activities:delete")),
        )
}

fn denied() -> Response {
    ApiError::forbidden()
        .with_message(ACTIVITY_DENIED)
        .into_response()
}

/// `resolveActivityOwner(c, activityId)`: the owner across every kind of
/// activity a transcript can belong to.
async fn activity_owner(
    db: &PgPool,
    activity: &str,
) -> Result<Option<Option<String>>, sqlx::Error> {
    let lookups = [
        "select user_id from voip_calls where id = $1 limit 1",
        "select user_id from meeting_bot_sessions where id = $1 limit 1",
        "select m.organizer_id from meeting_sessions s inner join meetings m on s.meeting_id = m.id where s.id = $1 limit 1",
        "select organizer_id from meetings where id = $1 limit 1",
        "select assigned_to_id from crm_activities where id = $1 limit 1",
    ];
    for sql in lookups {
        let row: Option<Option<String>> = sqlx::query_scalar(sql)
            .bind(activity)
            .fetch_optional(db)
            .await?;
        if let Some(owner) = row {
            return Ok(Some(owner));
        }
    }
    Ok(None)
}

/// `canAccessActivity(c, activityId)`: always with `activities:scope:all`,
/// else only the activity's owner (an unknown activity denies).
async fn can_access(caller: &Caller, activity: &str) -> Result<bool, sqlx::Error> {
    if caller.can("activities:scope:all") {
        return Ok(true);
    }
    let owner = activity_owner(&caller.db, activity).await?;
    Ok(owner.flatten().as_deref() == Some(caller.user_id.as_str()))
}

async fn transcription(
    db: &PgPool,
    sql: &'static str,
    key: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(sql).bind(key).fetch_optional(db).await?;
    Ok(row.map(|row| CRM_TRANSCRIPTIONS.js(row)))
}

async fn segment_rows(db: &PgPool, transcription_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from crm_transcript_segments s where s.transcription_id = $1
         order by s.sequence_number asc",
    )
    .bind(transcription_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| CRM_TRANSCRIPT_SEGMENTS.js(r))
        .collect())
}

/// `{ ...transcription, segments: [{ ...seg, start, end, speaker }] }`.
async fn with_segments(db: &PgPool, transcription: Value) -> Result<Value, sqlx::Error> {
    let id = text(&transcription, "id").unwrap_or_default().to_owned();
    let segments: Vec<Value> = segment_rows(db, &id)
        .await?
        .into_iter()
        .map(|mut seg| {
            seg["start"] = seg["startTime"].clone();
            seg["end"] = seg["endTime"].clone();
            seg["speaker"] = seg["speakerLabel"].clone();
            seg
        })
        .collect();
    let mut out = transcription;
    out["segments"] = Value::Array(segments);
    Ok(out)
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        let db = &caller.db;
        let Some(found) = transcription(
            db,
            "select to_jsonb(t) from crm_transcriptions t where t.id = $1 limit 1",
            &id,
        )
        .await?
        else {
            return Ok(ApiError::not_found("Transcription", Some(&id)).into_response());
        };
        if !can_access(&caller, text(&found, "activityId").unwrap_or_default()).await? {
            return Ok(denied());
        }
        Ok(Data(with_segments(db, found).await?).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to fetch transcription"))
}

async fn by_activity(caller: Caller, Path(activity): Path<String>) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        let db = &caller.db;
        let Some(found) = transcription(
            db,
            "select to_jsonb(t) from crm_transcriptions t where t.activity_id = $1 limit 1",
            &activity,
        )
        .await?
        else {
            return Ok(ApiError::not_found("Transcription", None).into_response());
        };
        if !can_access(&caller, &activity).await? {
            return Ok(denied());
        }
        Ok(Data(with_segments(db, found).await?).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to fetch transcription"))
}

async fn status_by_activity(caller: Caller, Path(activity): Path<String>) -> Response {
    // The access check runs before the route's `try`.
    match can_access(&caller, &activity).await {
        Ok(true) => {}
        Ok(false) => return denied(),
        Err(error) => {
            tracing::error!(%error, "meet: transcription access check failed");
            return ApiError::internal().into_response();
        }
    }
    let row = transcription(
        &caller.db,
        "select to_jsonb(t) from crm_transcriptions t where t.activity_id = $1 limit 1",
        &activity,
    )
    .await;
    match row {
        Ok(None) => Data(json!({ "exists": false })).into_response(),
        Ok(Some(t)) => Data(json!({
            "exists": true,
            "id": t["id"],
            "status": t["status"],
            "errorMessage": t["errorMessage"],
            "processingStartedAt": t["processingStartedAt"],
            "processingCompletedAt": t["processingCompletedAt"],
            "wordCount": t["wordCount"],
            "speakerCount": t["speakerCount"],
        }))
        .into_response(),
        Err(error) => internal(&error, "Failed to fetch transcription status"),
    }
}

async fn create(
    State(state): State<MeetState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, fields| {
        let activity = issues
            .text_with(
                fields,
                "activityId",
                Presence::Required,
                Text::length(Some(1), None),
            )
            .into_option();
        let language = issues
            .text(fields, "language", Presence::Optional, None, None)
            .into_option();
        (activity.unwrap_or_default(), language)
    }) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let (activity, language) = input;
    let result: Result<Response, sqlx::Error> = async {
        let db = &caller.db;
        let found: Option<String> = sqlx::query_scalar(
            "select id from crm_activities where id = $1 and deleted_at is null limit 1",
        )
        .bind(&activity)
        .fetch_optional(db)
        .await?;
        if found.is_none() {
            return Ok(ApiError::not_found("Activity", Some(&activity)).into_response());
        }
        if !can_access(&caller, &activity).await? {
            return Ok(denied());
        }
        let existing: Option<String> =
            sqlx::query_scalar("select id from crm_transcriptions where activity_id = $1 limit 1")
                .bind(&activity)
                .fetch_optional(db)
                .await?;
        if existing.is_some() {
            return Ok(ApiError::conflict("Transcription already exists for this activity").into_response());
        }
        let id = generate_id("trans");
        let language = language.unwrap_or_else(|| "en".to_owned());
        let now = now();
        sqlx::query(
            "insert into crm_transcriptions (id, activity_id, status, language, created_at, updated_at)
             values ($1, $2, 'pending', $3, $4::timestamp, $4::timestamp)",
        )
        .bind(&id)
        .bind(&activity)
        .bind(&language)
        .bind(&now)
        .execute(db)
        .await?;
        caller.publish(
            &state,
            TRANSCRIPTION_CREATED,
            &id,
            &json!({ "id": id, "activityId": activity, "status": "pending", "language": language }),
        );
        Ok(Created(json!({ "id": id })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to create transcription"))
}

/// `updateTranscriptionSchema`: its keys only, as read.
fn read_update(issues: &mut Issues, fields: &Map<String, Value>) -> Vec<(&'static str, Value)> {
    let mut out = Vec::new();
    let mut keep = |key: &'static str, field: Field<Value>| match field {
        Field::Set(value) => out.push((key, value)),
        Field::Null => out.push((key, Value::Null)),
        Field::Absent => {}
    };
    let string = |field: Field<String>| match field {
        Field::Set(s) => Field::Set(json!(s)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    };
    let number = |field: Field<f64>| match field {
        Field::Set(n) => Field::Set(crate::billing::js_number(n)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    };
    keep(
        "status",
        string(issues.text(fields, "status", Presence::Optional, None, None)),
    );
    keep(
        "fullText",
        string(issues.text(fields, "fullText", Presence::Optional, None, None)),
    );
    keep(
        "model",
        string(issues.text(fields, "model", Presence::Optional, None, None)),
    );
    keep(
        "provider",
        string(issues.text(fields, "provider", Presence::Optional, None, None)),
    );
    keep(
        "language",
        string(issues.text(fields, "language", Presence::Optional, None, None)),
    );
    for key in ["speakerCount", "wordCount", "confidence"] {
        keep(
            key,
            number(issues.number(fields, key, Presence::Optional, Number::default())),
        );
    }
    keep(
        "errorMessage",
        string(issues.text(fields, "errorMessage", Presence::Nullish, None, None)),
    );
    for key in ["processingStartedAt", "processingCompletedAt"] {
        keep(
            key,
            string(issues.text(fields, key, Presence::Nullish, None, None)),
        );
    }
    let metadata = issues.nested(fields, "metadata", Presence::Optional, |_, fields| {
        Value::Object(fields.clone())
    });
    keep("metadata", metadata);
    out
}

async fn update(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_update) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let result: Result<Response, String> = async {
        let db = &caller.db;
        let Some(existing) = transcription(
            db,
            "select to_jsonb(t) from crm_transcriptions t where t.id = $1 limit 1",
            &id,
        )
        .await
        .map_err(|e| e.to_string())?
        else {
            return Ok(ApiError::not_found("Transcription", Some(&id)).into_response());
        };
        if !can_access(&caller, text(&existing, "activityId").unwrap_or_default())
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(denied());
        }
        let table = &CRM_TRANSCRIPTIONS;
        let mut values = Map::new();
        table.set(&mut values, "updatedAt", json!(now()));
        for (key, value) in &data {
            let value = if matches!(*key, "processingStartedAt" | "processingCompletedAt") {
                // `v ? new Date(v) : null`: an unreadable date makes Drizzle throw.
                match value.as_str().filter(|s| !s.is_empty()) {
                    Some(stamp) => json!(
                        weldsuite_kit::validation::js_date_iso(stamp)
                            .ok_or_else(|| "RangeError: Invalid time value".to_owned())?
                    ),
                    None => Value::Null,
                }
            } else {
                value.clone()
            };
            table.set(&mut values, key, value);
        }
        table
            .patch(
                db,
                &id,
                values,
                false,
                &["updatedAt", "processingStartedAt", "processingCompletedAt"],
            )
            .await
            .map_err(|e| e.to_string())?;
        caller.publish(&state, TRANSCRIPTION_UPDATED, &id, &json!({ "id": id }));
        Ok(Data(json!({ "id": id })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to update transcription"))
}

async fn remove(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        let db = &caller.db;
        let Some(existing) = transcription(
            db,
            "select to_jsonb(t) from crm_transcriptions t where t.id = $1 limit 1",
            &id,
        )
        .await?
        else {
            return Ok(ApiError::not_found("Transcription", Some(&id)).into_response());
        };
        if !can_access(&caller, text(&existing, "activityId").unwrap_or_default()).await? {
            return Ok(denied());
        }
        sqlx::query("delete from crm_transcript_segments where transcription_id = $1")
            .bind(&id)
            .execute(db)
            .await?;
        sqlx::query("delete from crm_transcriptions where id = $1")
            .bind(&id)
            .execute(db)
            .await?;
        caller.publish(&state, TRANSCRIPTION_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete transcription"))
}

/// The transcription's activity, or the 404 / 403 to answer.
async fn owned(caller: &Caller, id: &str) -> Result<Result<(), Response>, sqlx::Error> {
    let activity: Option<String> =
        sqlx::query_scalar("select activity_id from crm_transcriptions where id = $1 limit 1")
            .bind(id)
            .fetch_optional(&caller.db)
            .await?;
    let Some(activity) = activity else {
        return Ok(Err(
            ApiError::not_found("Transcription", Some(id)).into_response()
        ));
    };
    if !can_access(caller, &activity).await? {
        return Ok(Err(denied()));
    }
    Ok(Ok(()))
}

async fn segments(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        if let Err(response) = owned(&caller, &id).await? {
            return Ok(response);
        }
        Ok(Data(Value::Array(segment_rows(&caller.db, &id).await?)).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to fetch transcript segments"))
}

/// A number as `${n}` writes it.
fn js_number_text(n: f64) -> String {
    match crate::billing::js_number(n) {
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn read_segment(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let before = issues.count();
    let number = |issues: &mut Issues, key: &str, presence| {
        issues
            .number(fields, key, presence, Number::default())
            .into_option()
    };
    let speaker = number(issues, "speakerId", Presence::Required);
    let label = issues
        .text(fields, "speakerLabel", Presence::Optional, None, None)
        .into_option();
    let name = issues
        .text(fields, "speakerName", Presence::Optional, None, None)
        .into_option();
    let text = issues
        .text(fields, "text", Presence::Required, None, None)
        .into_option();
    let start = number(issues, "startTime", Presence::Required);
    let end = number(issues, "endTime", Presence::Required);
    let timestamp = issues
        .text(fields, "timestamp", Presence::Optional, None, None)
        .into_option();
    let confidence = number(issues, "confidence", Presence::Optional);
    let sequence = number(issues, "sequenceNumber", Presence::Required);
    if issues.count() > before {
        return None;
    }
    let speaker = speaker.unwrap_or_default();
    let label = label.unwrap_or_else(|| format!("Speaker {}", js_number_text(speaker + 1.0)));
    let mut out = Map::new();
    out.insert("speaker_id".into(), crate::billing::js_number(speaker));
    out.insert("speaker_label".into(), json!(label));
    if let Some(name) = name {
        out.insert("speaker_name".into(), json!(name));
    }
    out.insert("text".into(), json!(text));
    out.insert("start_time".into(), json!(start));
    out.insert("end_time".into(), json!(end));
    if let Some(timestamp) = timestamp {
        out.insert("timestamp".into(), json!(timestamp));
    }
    if let Some(confidence) = confidence {
        out.insert("confidence".into(), json!(confidence));
    }
    out.insert(
        "sequence_number".into(),
        crate::billing::js_number(sequence.unwrap_or_default()),
    );
    Some(Value::Object(out))
}

async fn create_segments(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let rows = match validate(&headers, &body, |issues, fields| {
        issues
            .list(
                fields,
                "segments",
                Presence::Required,
                None,
                None,
                read_segment,
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(rows) => rows,
        Err(response) => return *response,
    };
    let result: Result<Response, String> = async {
        if let Err(response) = owned(&caller, &id).await.map_err(|e| e.to_string())? {
            return Ok(response);
        }
        if rows.is_empty() {
            // Drizzle refuses an insert without values.
            return Err("values() must be called with at least one value".to_owned());
        }
        let now = now();
        let rows: Vec<Value> = rows
            .into_iter()
            .map(|mut row| {
                row["id"] = json!(generate_id("seg"));
                row["transcription_id"] = json!(id);
                row["created_at"] = json!(now);
                row
            })
            .collect();
        let count = rows.len();
        sqlx::query(
            "insert into crm_transcript_segments (id, transcription_id, speaker_id, speaker_label,
                 speaker_name, text, start_time, end_time, timestamp, confidence, sequence_number, created_at)
             select r.id, r.transcription_id, r.speaker_id, r.speaker_label, r.speaker_name, r.text,
                 r.start_time, r.end_time, r.timestamp, r.confidence, r.sequence_number, r.created_at
             from jsonb_populate_recordset(null::crm_transcript_segments, $1::jsonb) r",
        )
        .bind(Value::Array(rows))
        .execute(&caller.db)
        .await
        .map_err(|e| e.to_string())?;
        Ok(Created(json!({ "count": count })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to create transcript segments"))
}

async fn delete_segments(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        if let Err(response) = owned(&caller, &id).await? {
            return Ok(response);
        }
        sqlx::query("delete from crm_transcript_segments where transcription_id = $1")
            .bind(&id)
            .execute(&caller.db)
            .await?;
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete transcript segments"))
}
