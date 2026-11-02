//! `/api/meeting-waitlist` (`routes/meeting-waitlist/index.ts`): the waiting
//! room's entries, admit and deny (the organizer only) and the CRUD.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    MEETING_WAITLIST_CREATED, MEETING_WAITLIST_DELETED, MEETING_WAITLIST_UPDATED,
};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{js_limit, query_param, sql_limit};
use crate::sessions::page_of;
use crate::tables::MEETING_SESSION_WAITLIST;
use crate::{Caller, MeetState, internal, now, validate};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<MeetState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/{id}/admit",
            post(admit).route_layer(need("meetings:read")),
        )
        .route("/{id}/deny", post(deny).route_layer(need("meetings:read")))
        .route("/", get(list).route_layer(need("meetings:read")))
        .route("/{id}", get(detail).route_layer(need("meetings:read")))
        .route("/", post(create).route_layer(need("meetings:create")))
        .route("/{id}", patch(update).route_layer(need("meetings:update")))
        .route("/{id}", delete(remove).route_layer(need("meetings:delete")))
}

async fn entry(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from meeting_session_waitlist t where t.id = $1 limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| MEETING_SESSION_WAITLIST.js(row)))
}

async fn admit(State(state): State<MeetState>, caller: Caller, Path(id): Path<String>) -> Response {
    decide(&state, &caller, &id, true).await
}

async fn deny(State(state): State<MeetState>, caller: Caller, Path(id): Path<String>) -> Response {
    decide(&state, &caller, &id, false).await
}

/// The admit / deny routes (`decideWaitlist`).
async fn decide(state: &MeetState, caller: &Caller, id: &str, admit: bool) -> Response {
    if caller.org_id.is_none() {
        return ApiError::org_required().into_response();
    }
    let result: Result<Response, sqlx::Error> = async {
        let db = &caller.db;
        let meeting_id: Option<String> = sqlx::query_scalar(
            "select meeting_id from meeting_session_waitlist where id = $1 limit 1",
        )
        .bind(id)
        .fetch_optional(db)
        .await?;
        let Some(meeting_id) = meeting_id else {
            return Ok(ApiError::not_found("Waitlist entry", Some(id)).into_response());
        };
        let organizer: Option<String> = sqlx::query_scalar(
            "select organizer_id from meetings where id = $1 and deleted_at is null limit 1",
        )
        .bind(&meeting_id)
        .fetch_optional(db)
        .await?;
        let Some(organizer) = organizer else {
            return Ok(ApiError::not_found("Meeting", Some(&meeting_id)).into_response());
        };
        if organizer != caller.user_id {
            return Ok(ApiError::forbidden()
                .with_message("Only the organizer can manage the waitlist")
                .into_response());
        }
        let Some(existing) = entry(db, id).await? else {
            return Ok(ApiError::not_found("Waitlist entry", Some(id)).into_response());
        };
        if existing.get("status").and_then(Value::as_str) != Some("pending") {
            return Ok(ApiError::bad_request("Waitlist entry is already resolved").into_response());
        }
        let status = if admit { "admitted" } else { "denied" };
        let now = now();
        sqlx::query(
            "update meeting_session_waitlist set status = $2, decided_by = $3,
                 decided_at = $4::timestamp, updated_at = $4::timestamp where id = $1",
        )
        .bind(id)
        .bind(status)
        .bind(&caller.user_id)
        .bind(&now)
        .execute(db)
        .await?;
        let updated = entry(db, id).await?.unwrap_or(Value::Null);
        caller.publish(
            state,
            MEETING_WAITLIST_UPDATED,
            id,
            &json!({ "id": id, "meetingId": meeting_id, "status": status }),
        );
        Ok(Data(updated).into_response())
    }
    .await;
    let message = if admit {
        "Failed to admit waitlist entry"
    } else {
        "Failed to deny waitlist entry"
    };
    result.unwrap_or_else(|error| internal(&error, message))
}

const LIST_SQL: &str = "select to_jsonb(t) from meeting_session_waitlist t
     where ($1::boolean or t.session_id = $2) and ($3::boolean or t.status = $4)
       and ($5::boolean or t.name like $6)
       and ($7::boolean or t.created_at < $8::timestamp or (t.created_at = $8::timestamp and t.id < $9))
     order by t.created_at desc, t.id desc limit $10";
const COUNT_SQL: &str = "select to_jsonb(count(*)) from meeting_session_waitlist t
     where ($1::boolean or t.session_id = $2) and ($3::boolean or t.status = $4)
       and ($5::boolean or t.name like $6)
       and ($7::boolean or t.created_at < $8::timestamp or (t.created_at = $8::timestamp and t.id < $9))";

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let db = &caller.db;
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let value = |name: &str| query_param(query, name).filter(|v| !v.is_empty());
    let session = value("sessionId");
    let status = value("status");
    let search = value("search").map(|s| format!("%{s}%"));
    let cursor = value("cursor");
    let cursor_row: Option<(String, String)> = match &cursor {
        Some(cursor) => {
            let row: Result<Option<(Option<String>, String)>, sqlx::Error> = sqlx::query_as(
                "select to_jsonb(t.created_at)#>>'{}', t.id from meeting_session_waitlist t where t.id = $1 limit 1",
            )
            .bind(cursor)
            .fetch_optional(db)
            .await;
            match row {
                Ok(row) => row.and_then(|(at, id)| {
                    at.and_then(|s| weldsuite_db::js_timestamp(&s))
                        .map(|at| (at, id))
                }),
                Err(error) => {
                    tracing::error!(%error, "meet: cursor lookup failed");
                    return ApiError::internal().into_response();
                }
            }
        }
        None => None,
    };
    let active = [
        session.is_some(),
        status.is_some(),
        search.is_some(),
        cursor_row.is_some(),
    ];
    let page = active.map(|a| !a);
    let mut count = page;
    if cursor.is_some()
        && let Some(last) = count.iter().rposition(|skip| !skip)
    {
        count[last] = true;
    }
    let bind = |sql: &'static str, skip: [bool; 4]| {
        sqlx::query_scalar::<_, Value>(sql)
            .bind(skip[0])
            .bind(session.clone())
            .bind(skip[1])
            .bind(status.clone())
            .bind(skip[2])
            .bind(search.clone())
            .bind(skip[3])
            .bind(cursor_row.as_ref().map(|(at, _)| at.clone()))
            .bind(cursor_row.as_ref().map(|(_, id)| id.clone()))
    };
    let rows = bind(LIST_SQL, page)
        .bind(sql_limit(limit + 1.0))
        .fetch_all(db)
        .await;
    let total = bind(COUNT_SQL, count).fetch_one(db).await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => page_of(
            rows.into_iter()
                .map(|r| MEETING_SESSION_WAITLIST.js(r))
                .collect(),
            limit,
            total.as_i64().unwrap_or(0),
        ),
        (Err(error), _) | (_, Err(error)) => internal(&error, "Failed to list waitlist entrys"),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match entry(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Waitlist entry", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch waitlist entry"),
    }
}

/// `createMeetingWaitlistEntrySchema` (passthrough), or its `.partial()`.
fn read_entry(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let _ = issues.text(fields, "sessionId", required, None, None);
    let _ = issues.text(fields, "name", required, Some(1), Some(255));
    let email = Text {
        format: Some(Format::Email),
        max: Some(255),
        ..Text::default()
    };
    let _ = issues.text_with(fields, "email", Presence::Optional, email);
    let _ = issues.text(fields, "status", Presence::Optional, None, Some(30));
    fields.clone()
}

async fn create(
    State(state): State<MeetState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        read_entry(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let id = generate_id("wl");
    let now = now();
    let table = &MEETING_SESSION_WAITLIST;
    let mut values = Map::new();
    table.set(&mut values, "id", json!(id));
    values.extend(table.values(&data));
    table.set(&mut values, "createdAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));
    let trusted: Vec<&str> = if data.contains_key("id") {
        vec!["createdAt", "updatedAt"]
    } else {
        vec!["id", "createdAt", "updatedAt"]
    };
    if let Err(error) = table.insert(&caller.db, values, &trusted).await {
        return internal(&error, "Failed to create waitlist entry");
    }
    let mut event = Map::new();
    event.insert("id".into(), json!(id));
    for key in ["meetingId", "name", "email"] {
        if let Some(value) = data.get(key) {
            event.insert(key.into(), value.clone());
        }
    }
    event.insert(
        "status".into(),
        data.get("status")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| json!("pending")),
    );
    caller.publish(&state, MEETING_WAITLIST_CREATED, &id, &Value::Object(event));
    Created(json!({ "id": id })).into_response()
}

async fn update(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, fields| {
        read_entry(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let existing = match entry(&caller.db, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return ApiError::not_found("Waitlist entry", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Failed to update waitlist entry"),
    };
    let table = &MEETING_SESSION_WAITLIST;
    let mut values = Map::new();
    table.set(&mut values, "updatedAt", json!(now()));
    values.extend(table.values(&data));
    let trusted: &[&str] = if data.contains_key("updatedAt") {
        &[]
    } else {
        &["updatedAt"]
    };
    if let Err(error) = table.patch(&caller.db, &id, values, false, trusted).await {
        return internal(&error, "Failed to update waitlist entry");
    }
    let pick = |key: &str| {
        data.get(key)
            .filter(|v| !v.is_null())
            .cloned()
            .or_else(|| existing.get(key).cloned())
            .unwrap_or(Value::Null)
    };
    caller.publish(
        &state,
        MEETING_WAITLIST_UPDATED,
        &id,
        &json!({
            "id": id,
            "meetingId": pick("meetingId"),
            "name": pick("name"),
            "email": pick("email"),
            "status": pick("status"),
        }),
    );
    Data(json!({ "id": id })).into_response()
}

async fn remove(
    State(state): State<MeetState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        if entry(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Waitlist entry", Some(&id)).into_response());
        }
        sqlx::query("delete from meeting_session_waitlist where id = $1")
            .bind(&id)
            .execute(&caller.db)
            .await?;
        caller.publish(&state, MEETING_WAITLIST_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete waitlist entry"))
}
