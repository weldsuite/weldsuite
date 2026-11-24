//! `/api/meeting-waitlist` (`routes/meeting-waitlist/index.ts`): the waiting
//! room's entries, admit and deny (the organizer only) and the CRUD.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::{
    MEETING_WAITLIST_CREATED, MEETING_WAITLIST_DELETED, MEETING_WAITLIST_UPDATED,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::meeting_session_waitlist::{self as waitlist, Column as Entry};
use weldsuite_schema::tenant::meetings;

use crate::js::{js_limit, query_param};
use crate::sessions::{before, limit_of, page_and_count, page_of};
use crate::table::{js_instant, row_json};
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

async fn entry(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    waitlist::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
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
    let result: Result<Response, DbErr> = async {
        let db = &caller.db;
        let tenant = &orm(db);
        let meeting_id: Option<String> = waitlist::Entity::find()
            .select_only()
            .column(Entry::MeetingId)
            .filter(Entry::Id.eq(id))
            .into_tuple()
            .one(tenant)
            .await?;
        let Some(meeting_id) = meeting_id else {
            return Ok(ApiError::not_found("Waitlist entry", Some(id)).into_response());
        };
        let organizer: Option<String> = meetings::Entity::find()
            .select_only()
            .column(meetings::Column::OrganizerId)
            .filter(meetings::Column::Id.eq(&meeting_id))
            .filter(meetings::Column::DeletedAt.is_null())
            .into_tuple()
            .one(tenant)
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
        let now = weldsuite_db::utc_now();
        waitlist::Entity::update_many()
            .col_expr(Entry::Status, Expr::value(status))
            .col_expr(Entry::DecidedBy, Expr::value(caller.user_id.clone()))
            .col_expr(Entry::DecidedAt, Expr::value(now))
            .col_expr(Entry::UpdatedAt, Expr::value(now))
            .filter(Entry::Id.eq(id))
            .exec(tenant)
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

/// `select createdAt, id from meeting_session_waitlist where id = cursor`.
async fn cursor_row(
    db: &PgPool,
    cursor: &str,
) -> Result<Option<(PrimitiveDateTime, String)>, DbErr> {
    let row: Option<(PrimitiveDateTime, String)> = waitlist::Entity::find()
        .select_only()
        .columns([Entry::CreatedAt, Entry::Id])
        .filter(Entry::Id.eq(cursor))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.map(|(at, id)| (js_instant(at), id)))
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let db = &caller.db;
    let limit = js_limit(query_param(query, "limit").as_deref(), 25.0, 100.0);
    let value = |name: &str| query_param(query, name).filter(|v| !v.is_empty());
    let session = value("sessionId");
    let status = value("status");
    let search = value("search").map(|s| format!("%{s}%"));
    let cursor = value("cursor");
    let cursor_row = match &cursor {
        Some(cursor) => match cursor_row(db, cursor).await {
            Ok(row) => row,
            Err(error) => {
                tracing::error!(%error, "meet: cursor lookup failed");
                return ApiError::internal().into_response();
            }
        },
        None => None,
    };
    let (page, count) = page_and_count(
        vec![
            session.map(|session| Condition::all().add(Entry::SessionId.eq(session))),
            status.map(|status| Condition::all().add(Entry::Status.eq(status))),
            search.map(|search| Condition::all().add(Entry::Name.like(search))),
            cursor_row
                .as_ref()
                .map(|row| before(Entry::CreatedAt, Entry::Id, row)),
        ],
        cursor.is_some(),
    );
    let db = &orm(db);
    let rows = waitlist::Entity::find()
        .filter(page)
        .order_by_desc(Entry::CreatedAt)
        .order_by_desc(Entry::Id)
        .limit(limit_of(limit + 1.0))
        .all(db)
        .await
        .and_then(|rows| {
            rows.into_iter()
                .map(row_json)
                .collect::<Result<Vec<_>, _>>()
        });
    let total = waitlist::Entity::find().filter(count).count(db).await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => page_of(rows, limit, i64::try_from(total).unwrap_or(i64::MAX)),
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
    let result: Result<Response, DbErr> = async {
        if entry(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Waitlist entry", Some(&id)).into_response());
        }
        waitlist::Entity::delete_many()
            .filter(Entry::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, MEETING_WAITLIST_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete waitlist entry"))
}
