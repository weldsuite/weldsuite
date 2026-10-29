//! Google Calendar outbound sync (`lib/integrations/sync/outbound-calendar-sync.ts`
//! and the push half of `adapters/google-calendar.ts`): after every event
//! change, each active `google_calendar` connection of the workspace gets the
//! create, update or delete, and the event ↔ Google id mapping is kept in
//! `integration_entity_mappings`. Best effort throughout: nothing here fails
//! the request.
//!
//! Google is a third-party API outside the EU: the HTTP goes through the
//! [`GoogleHttp`] port, which conformance mode routes into the test's
//! `fetch` stub.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::generate_id;
use weldsuite_ports::BoxFuture;

use crate::js::{Ordered, OrderedValue, iso, now_ms, parse_date, truthy};
use crate::{CalendarState, Caller, now, text};

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const CALENDAR_API_BASE: &str = "https://www.googleapis.com/calendar/v3";

/// One HTTP request to Google.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

/// Google's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Sends a request; `Err` is a connection-level failure (`fetch` throwing).
pub trait GoogleHttp: Send + Sync {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, String>>;
}

/// The transport a request uses in place of the app's (conformance mode).
#[derive(Clone)]
pub struct CalendarHttp(pub Arc<dyn GoogleHttp>);

impl std::fmt::Debug for CalendarHttp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CalendarHttp")
    }
}

/// [`GoogleHttp`] over reqwest.
#[derive(Debug, Clone, Default)]
pub struct ReqwestGoogle {
    client: reqwest::Client,
}

impl GoogleHttp for ReqwestGoogle {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, String>> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(request.method.as_bytes())
                .map_err(|error| error.to_string())?;
            let mut outgoing = self.client.request(method, &request.url);
            for (name, value) in &request.headers {
                outgoing = outgoing.header(name.as_str(), value.as_str());
            }
            if let Some(body) = request.body {
                outgoing = outgoing.body(body);
            }
            let response = outgoing.send().await.map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let body = response
                .bytes()
                .await
                .map_err(|error| error.to_string())?
                .to_vec();
            Ok(HttpResponse { status, body })
        })
    }
}

/// What happened to the event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PushAction {
    Created,
    Updated,
    Deleted,
}

/// What a push needs outside the request.
#[derive(Clone)]
struct PushContext {
    db: PgPool,
    http: Option<Arc<dyn GoogleHttp>>,
    client_id: Option<String>,
    client_secret: Option<String>,
}

impl PushContext {
    fn of(state: &CalendarState, caller: &Caller) -> Self {
        Self {
            db: caller.db.clone(),
            http: caller.google(state),
            client_id: caller.env(state, "GOOGLE_CALENDAR_CLIENT_ID"),
            client_secret: caller.env(state, "GOOGLE_CALENDAR_CLIENT_SECRET"),
        }
    }
}

/// `c.executionCtx.waitUntil(pushCalendarEventToGoogle(db, id, action, data, env))`.
pub(crate) fn queue_push(
    state: &CalendarState,
    caller: &Caller,
    event_id: &str,
    action: PushAction,
    data: Ordered,
) {
    let context = PushContext::of(state, caller);
    let event_id = event_id.to_owned();
    state.events.tracker().spawn(async move {
        push_event(&context, &event_id, action, &data).await;
    });
}

/// Every deleted event of a calendar, one after the other (`pushDeletesToGoogle`).
pub(crate) fn queue_deletes(state: &CalendarState, caller: &Caller, event_ids: Vec<String>) {
    let context = PushContext::of(state, caller);
    state.events.tracker().spawn(async move {
        for id in event_ids {
            let mut data = Ordered::default();
            data.plain("id", Value::String(id.clone()));
            push_event(&context, &id, PushAction::Deleted, &data).await;
        }
    });
}

/// `pushCalendarEventToGoogle`: every active connection, each on its own.
async fn push_event(context: &PushContext, event_id: &str, action: PushAction, data: &Ordered) {
    let connections: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(c) from integration_connections c
         where provider = 'google_calendar' and status = 'active' and deleted_at is null",
    )
    .fetch_all(&context.db)
    .await;
    let connections = match connections {
        Ok(rows) => rows.into_iter().map(js_row).collect::<Vec<_>>(),
        Err(error) => {
            tracing::error!(%error, "[OutboundCalSync] Failed to push event {event_id}");
            return;
        }
    };
    for connection in connections {
        if let Err(error) = push_to_connection(context, &connection, event_id, action, data).await {
            tracing::error!(
                error,
                "[OutboundCalSync] Error for connection {}",
                text(&connection, "id")
            );
        }
    }
}

async fn send(context: &PushContext, request: HttpRequest) -> Result<HttpResponse, String> {
    let Some(http) = &context.http else {
        return Err("no outbound HTTP transport".to_owned());
    };
    http.send(request).await
}

fn db_error(error: &sqlx::Error) -> String {
    error.to_string()
}

/// A usable access token, refreshed and stored when expired
/// (`resolveAccessToken`); `None` when the connection can't be used.
async fn access_token(context: &PushContext, connection: &Value) -> Result<Option<String>, String> {
    let tokens = &connection["oauthTokens"];
    let Some(access) = tokens["accessToken"].as_str().filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let expired = tokens["expiresAt"]
        .as_str()
        .filter(|e| !e.is_empty())
        .and_then(parse_date)
        .is_some_and(|at| at < now_ms());
    if !expired {
        return Ok(Some(access.to_owned()));
    }
    let refresh = tokens["refreshToken"].as_str().filter(|t| !t.is_empty());
    let (Some(refresh), Some(client_id), Some(secret)) = (
        refresh,
        context.client_id.as_deref().filter(|c| !c.is_empty()),
        context.client_secret.as_deref().filter(|s| !s.is_empty()),
    ) else {
        return Ok(None);
    };
    let body: String = form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", client_id)
        .append_pair("client_secret", secret)
        .append_pair("refresh_token", refresh)
        .append_pair("grant_type", "refresh_token")
        .finish();
    let response = send(
        context,
        HttpRequest {
            method: "POST".to_owned(),
            url: TOKEN_URL.to_owned(),
            headers: vec![(
                "Content-Type".to_owned(),
                "application/x-www-form-urlencoded".to_owned(),
            )],
            body: Some(body.into_bytes()),
        },
    )
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(format!(
            "Google token refresh failed: {} {}",
            response.status,
            String::from_utf8_lossy(&response.body)
        ));
    }
    let data: Value = serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
    let mut tokens = Map::new();
    if !data["access_token"].is_null() {
        tokens.insert("accessToken".to_owned(), data["access_token"].clone());
    }
    tokens.insert("refreshToken".to_owned(), Value::String(refresh.to_owned()));
    if let Some(seconds) = data["expires_in"].as_f64().filter(|s| *s != 0.0) {
        #[allow(clippy::cast_possible_truncation)]
        let at = now_ms() + (seconds * 1000.0) as i64;
        tokens.insert("expiresAt".to_owned(), Value::String(iso(at)));
    }
    let token_type = data["token_type"]
        .as_str()
        .filter(|t| !t.is_empty())
        .unwrap_or("Bearer");
    tokens.insert("tokenType".to_owned(), json!(token_type));
    sqlx::query(
        "update integration_connections set oauth_tokens = $2::jsonb, updated_at = $3::timestamp
         where id = $1",
    )
    .bind(text(connection, "id"))
    .bind(Value::Object(tokens))
    .bind(now())
    .execute(&context.db)
    .await
    .map_err(|e| db_error(&e))?;
    Ok(data["access_token"].as_str().map(str::to_owned))
}

/// `pushToConnection`: `Err` is what TypeScript throws (logged per connection).
async fn push_to_connection(
    context: &PushContext,
    connection: &Value,
    event_id: &str,
    action: PushAction,
    data: &Ordered,
) -> Result<(), String> {
    let Some(token) = access_token(context, connection).await? else {
        return Ok(());
    };
    let connection_id = text(connection, "id");
    let mapping: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from integration_entity_mappings m
         where connection_id = $1 and internal_entity_type = 'calendar_event'
           and internal_entity_id = $2
         limit 1",
    )
    .bind(connection_id)
    .bind(event_id)
    .fetch_optional(&context.db)
    .await
    .map_err(|e| db_error(&e))?;
    let mapping = mapping.map(js_row);
    let authorization = ("Authorization".to_owned(), format!("Bearer {token}"));

    if action == PushAction::Deleted {
        let Some(mapping) = mapping else {
            return Ok(());
        };
        let response = send(
            context,
            HttpRequest {
                method: "DELETE".to_owned(),
                url: format!(
                    "{CALENDAR_API_BASE}/calendars/primary/events/{}",
                    text(&mapping, "externalEntityId")
                ),
                headers: vec![authorization],
                body: None,
            },
        )
        .await?;
        let ok = (200..300).contains(&response.status) || matches!(response.status, 404 | 410);
        if ok {
            sqlx::query(
                "update integration_entity_mappings set updated_at = $2::timestamp where id = $1",
            )
            .bind(text(&mapping, "id"))
            .bind(now())
            .execute(&context.db)
            .await
            .map_err(|e| db_error(&e))?;
        }
        return Ok(());
    }

    let external_id = mapping
        .as_ref()
        .map(|m| text(m, "externalEntityId").to_owned());
    let body = map_to_google(data)?;
    let (method, url) = match &external_id {
        Some(id) if !id.is_empty() => (
            "PATCH",
            format!("{CALENDAR_API_BASE}/calendars/primary/events/{id}"),
        ),
        _ => (
            "POST",
            format!("{CALENDAR_API_BASE}/calendars/primary/events"),
        ),
    };
    let response = send(
        context,
        HttpRequest {
            method: method.to_owned(),
            url,
            headers: vec![
                authorization,
                ("Content-Type".to_owned(), "application/json".to_owned()),
            ],
            body: Some(body.to_string().into_bytes()),
        },
    )
    .await?;
    if !(200..300).contains(&response.status) {
        let error = format!(
            "{}: {}",
            response.status,
            String::from_utf8_lossy(&response.body)
        );
        tracing::error!("[OutboundCalSync] Push failed for event {event_id}: {error}");
        // A read-only token: ask for a reconnect.
        if error.starts_with("403") {
            mark_write_access_denied(context, connection_id).await?;
        }
        return Ok(());
    }
    let result: Value =
        serde_json::from_slice(&response.body).map_err(|error| error.to_string())?;
    let checksum = checksum(&data.stringify());
    upsert_mapping(
        context,
        connection_id,
        event_id,
        mapping.as_ref(),
        &result["id"],
        &checksum,
    )
    .await
}

/// SHA-256 of `JSON.stringify(data)`, in hex (`computeChecksum`).
fn checksum(json: &str) -> String {
    hex::encode(aws_lc_rs::digest::digest(
        &aws_lc_rs::digest::SHA256,
        json.as_bytes(),
    ))
}

async fn mark_write_access_denied(
    context: &PushContext,
    connection_id: &str,
) -> Result<(), String> {
    let now = now();
    sqlx::query(
        "update integration_connections set status = 'error',
             last_error = 'Write access denied. Please reconnect Google Calendar.',
             last_error_at = $2::timestamp, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(connection_id)
    .bind(&now)
    .execute(&context.db)
    .await
    .map_err(|e| db_error(&e))?;
    Ok(())
}

async fn upsert_mapping(
    context: &PushContext,
    connection_id: &str,
    event_id: &str,
    mapping: Option<&Value>,
    external_id: &Value,
    checksum: &str,
) -> Result<(), String> {
    let now = now();
    let external = external_id.as_str();
    if let Some(mapping) = mapping {
        sqlx::query(
            "update integration_entity_mappings set
                 external_entity_id = coalesce($2, external_entity_id),
                 sync_checksum = $3, last_synced_at = $4::timestamp, updated_at = $4::timestamp
             where id = $1",
        )
        .bind(text(mapping, "id"))
        .bind(external)
        .bind(checksum)
        .bind(&now)
        .execute(&context.db)
        .await
        .map_err(|e| db_error(&e))?;
        return Ok(());
    }
    sqlx::query(
        "insert into integration_entity_mappings
             (id, connection_id, external_entity_type, external_entity_id, internal_entity_type,
              internal_entity_id, sync_checksum, last_synced_at)
         values ($1, $2, 'calendar_event', $3, 'calendar_event', $4, $5, $6::timestamp)",
    )
    .bind(generate_id("iem"))
    .bind(connection_id)
    .bind(external)
    .bind(event_id)
    .bind(checksum)
    .bind(&now)
    .execute(&context.db)
    .await
    .map_err(|e| db_error(&e))?;
    Ok(())
}

/// A Google start/end: a bare date for all-day events, else the instant and
/// the zone (`toGoogleTime`). `Err` for an Invalid Date (`toISOString` throws).
fn google_time(value: &str, all_day: bool, zone: Option<&str>) -> Result<Value, String> {
    let at = parse_date(value).ok_or_else(|| "RangeError: Invalid time value".to_owned())?;
    let iso = iso(at);
    if all_day {
        return Ok(json!({ "date": iso.split('T').next().unwrap_or_default() }));
    }
    let mut out = json!({ "dateTime": iso });
    if let Some(zone) = zone.filter(|z| !z.is_empty()) {
        out["timeZone"] = json!(zone);
    }
    Ok(out)
}

fn field(data: &Ordered, key: &str) -> Value {
    data.get(key).map_or(Value::Null, OrderedValue::to_value)
}

/// The event as Google's API wants it (`mapToGoogle`).
fn map_to_google(data: &Ordered) -> Result<Value, String> {
    let mut out = Map::new();
    for (from, to) in [
        ("title", "summary"),
        ("description", "description"),
        ("location", "location"),
        ("status", "status"),
    ] {
        let value = field(data, from);
        if !value.is_null() {
            out.insert(to.to_owned(), value);
        }
    }
    let all_day = field(data, "allDay") == Value::Bool(true);
    let zone = field(data, "timezone");
    let zone = zone.as_str();
    let start = field(data, "startTime");
    if truthy(&start) {
        out.insert(
            "start".to_owned(),
            google_time(start.as_str().unwrap_or_default(), all_day, zone)?,
        );
    }
    let end = field(data, "endTime");
    if truthy(&end) {
        out.insert(
            "end".to_owned(),
            google_time(end.as_str().unwrap_or_default(), all_day, zone)?,
        );
    }
    if let Value::Array(attendees) = field(data, "attendees") {
        let mapped: Vec<Value> = attendees
            .iter()
            .map(|a| {
                let mut item = Map::new();
                item.insert("email".to_owned(), a["email"].clone());
                if let Some(name) = a.get("name").filter(|n| !n.is_null()) {
                    item.insert("displayName".to_owned(), name.clone());
                }
                let status = if truthy(&a["status"]) {
                    a["status"].clone()
                } else {
                    json!("needsAction")
                };
                item.insert("responseStatus".to_owned(), status);
                Value::Object(item)
            })
            .collect();
        out.insert("attendees".to_owned(), Value::Array(mapped));
    }
    let rule = field(data, "recurrenceRule");
    if truthy(&rule) {
        out.insert("recurrence".to_owned(), json!([rule]));
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_map_to_google_like_the_adapter() {
        let mut data = Ordered::default();
        data.plain("id", json!("evt_1"));
        data.plain("title", json!("Planning"));
        data.plain("startTime", json!("2030-03-01T10:00:00.000Z"));
        data.plain("endTime", json!(""));
        data.plain("timezone", json!("Europe/Amsterdam"));
        data.plain("attendees", json!([{ "email": "a@x.test" }]));
        let google = map_to_google(&data).expect("maps");
        assert_eq!(
            google,
            json!({
                "summary": "Planning",
                "start": { "dateTime": "2030-03-01T10:00:00.000Z", "timeZone": "Europe/Amsterdam" },
                "attendees": [{ "email": "a@x.test", "responseStatus": "needsAction" }],
            })
        );
        assert_eq!(checksum("{}").len(), 64);
    }
}
