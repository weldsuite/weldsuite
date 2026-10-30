//! `/api/desk/widget` (`routes/desk-widget/index.ts`): the WeldDesk inbox's
//! web chat widgets (`desk_widget_settings`), each registered in the master
//! `widget_registry` so the public widget API resolves its workspace.
//! Permissions `settings:read|update`, delete `settings:manage`.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Extension, Router};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_db::{PgPool, Tenant};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::{lenient_json, master};
use crate::crud::write_failed;
use crate::tables::DESK_WIDGET_SETTINGS as WIDGETS;
use crate::{Caller, DeskState, Refusal, now, validate};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("settings:read")))
        .route("/", post(create).route_layer(need("settings:update")))
        .route(
            "/{widget_id}",
            get(detail).route_layer(need("settings:read")),
        )
        .route(
            "/{widget_id}",
            patch(update).route_layer(need("settings:update")),
        )
        .route(
            "/{widget_id}",
            delete(remove).route_layer(need("settings:manage")),
        )
}

// ── schemas (`@weldsuite/core-api-client/schemas/desk-widget`) ──────────────

const WEEKDAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const REPLY_TIMES: [&str; 4] = ["few_minutes", "hour", "few_hours", "day"];

/// `/^(?:[01]\d|2[0-3]):[0-5]\d$/`
fn clock_time(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    let digit = |b: u8| b.is_ascii_digit();
    let hour_ok = match bytes[0] {
        b'0' | b'1' => digit(bytes[1]),
        b'2' => (b'0'..=b'3').contains(&bytes[1]),
        _ => false,
    };
    hour_ok && (b'0'..=b'5').contains(&bytes[3]) && digit(bytes[4])
}

/// `deskWidgetBrandingSchema` at `key`.
fn branding(issues: &mut Issues, body: &Map<String, Value>) -> Option<Value> {
    issues
        .nested(body, "branding", Presence::Optional, |issues, fields| {
            let mut out = Map::new();
            for key in ["primaryColor", "backgroundColor"] {
                if let Some(text) = issues
                    .text(fields, key, Presence::Optional, None, Some(30))
                    .into_option()
                {
                    out.insert(key.to_owned(), Value::String(text));
                }
            }
            if let Some(position) = issues
                .choice(fields, "position", Presence::Optional, &["right", "left"])
                .into_option()
            {
                out.insert("position".to_owned(), Value::String(position));
            }
            Value::Object(out)
        })
        .into_option()
}

fn allowed_domains(issues: &mut Issues, body: &Map<String, Value>) -> Option<Value> {
    issues
        .list(
            body,
            "allowedDomains",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, Text::length(None, Some(255))),
        )
        .into_option()
        .map(|domains| json!(domains))
}

/// A refinement Zod settles after the body's synchronous checks.
struct Refinement {
    path: Vec<Value>,
    message: &'static str,
}

/// `end: z.union([clockTime, z.literal('24:00')])`: `Some` when the window
/// can still be refined (valid, or only dirty); `None` when it aborted.
fn window_end(issues: &mut Issues, fields: &Map<String, Value>) -> Option<String> {
    match fields.get("end") {
        Some(Value::String(text)) if clock_time(text) || text == "24:00" => Some(text.clone()),
        Some(Value::String(text)) => {
            // The clock option is only dirty (its regex), so the union
            // answers with its issue.
            issues.push_issue(
                "end",
                json!({ "validation": "regex", "code": "invalid_string", "message": "Use HH:MM" }),
            );
            Some(text.clone())
        }
        value => {
            let received = received(value);
            let message = if received == "undefined" {
                "Required".to_owned()
            } else {
                format!("Expected string, received {received}")
            };
            let path = issues.path_of("end");
            let literal_message = "Invalid literal value, expected \"24:00\"";
            let mut literal = json!({
                "code": "invalid_literal",
                "expected": "24:00",
                "path": path,
                "message": literal_message,
            });
            if let Some(value) = value {
                literal["received"] = value.clone();
            }
            issues.push_issue(
                "end",
                json!({
                    "code": "invalid_union",
                    "unionErrors": [
                        { "issues": [{
                            "code": "invalid_type",
                            "expected": "string",
                            "received": received,
                            "path": path,
                            "message": message,
                        }], "name": "ZodError" },
                        { "issues": [literal], "name": "ZodError" },
                    ],
                    "message": "Invalid input",
                }),
            );
            None
        }
    }
}

/// Zod's `ZodParsedType` of a value.
fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// `deskOfficeHoursSchema.nullish()` at `officeHours`; the windows'
/// refinements go to `refinements`.
fn office_hours(
    issues: &mut Issues,
    body: &Map<String, Value>,
    refinements: &mut Vec<Refinement>,
) -> Field<Value> {
    issues.nested(body, "officeHours", Presence::Nullish, |issues, fields| {
        let enabled = issues.boolean(fields, "enabled", Presence::Required);
        let mut extra: Vec<String> = Vec::new();
        let days = issues.nested(fields, "days", Presence::Required, |issues, days| {
            let mut out = Map::new();
            for day in WEEKDAYS {
                let window = issues.nested(days, day, Presence::Nullish, |issues, window| {
                    issues.pattern(
                        window,
                        "start",
                        Presence::Required,
                        None,
                        None,
                        clock_time,
                        "Use HH:MM",
                    );
                    // A string start failing the regex is only dirty: the
                    // refinement still runs. Anything else aborts the window.
                    let start = window
                        .get("start")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    let end = window_end(issues, window);
                    if let (Some(start), Some(end)) = (&start, &end)
                        && end.encode_utf16().cmp(start.encode_utf16())
                            != std::cmp::Ordering::Greater
                    {
                        refinements.push(Refinement {
                            path: issues_path(issues, "end"),
                            message: "End time must be after start time",
                        });
                    }
                    json!({ "start": start, "end": end })
                });
                match window {
                    Field::Set(value) => {
                        out.insert(day.to_owned(), value);
                    }
                    Field::Null => {
                        out.insert(day.to_owned(), Value::Null);
                    }
                    Field::Absent => {}
                }
            }
            extra = days
                .keys()
                .filter(|key| !WEEKDAYS.contains(&key.as_str()))
                .cloned()
                .collect();
            Value::Object(out)
        });
        // `.strict()`: the keys that are no weekday, after the days' own issues.
        if !extra.is_empty() {
            let quoted: Vec<String> = extra.iter().map(|key| format!("'{key}'")).collect();
            issues.push_issue(
                "days",
                json!({
                    "code": "unrecognized_keys",
                    "keys": extra,
                    "message": format!("Unrecognized key(s) in object: {}", quoted.join(", ")),
                }),
            );
        }
        json!({ "enabled": enabled.into_option(), "days": days.into_option() })
    })
}

/// The path `key` is reported at, as a list.
fn issues_path(issues: &Issues, key: &str) -> Vec<Value> {
    match issues.path_of(key) {
        Value::Array(path) => path,
        _ => Vec::new(),
    }
}

fn read_create(headers: &HeaderMap, body: &Bytes) -> Result<Map<String, Value>, Refusal> {
    validate(headers, body, |issues, fields| {
        let mut data = Map::new();
        if let Some(name) = issues
            .text(fields, "widgetName", Presence::Optional, None, Some(255))
            .into_option()
        {
            data.insert("widgetName".to_owned(), Value::String(name));
        }
        if let Some(greeting) = issues
            .text(fields, "greeting", Presence::Optional, None, Some(500))
            .into_option()
        {
            data.insert("greeting".to_owned(), Value::String(greeting));
        }
        if let Some(branding) = branding(issues, fields) {
            data.insert("branding".to_owned(), branding);
        }
        if let Some(domains) = allowed_domains(issues, fields) {
            data.insert("allowedDomains".to_owned(), domains);
        }
        data
    })
}

/// Insert a field the body set (or nulled) into `data`.
fn keep(data: &mut Map<String, Value>, key: &str, field: Field<Value>) {
    match field {
        Field::Set(value) => {
            data.insert(key.to_owned(), value);
        }
        Field::Null => {
            data.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
}

fn read_update(
    headers: &HeaderMap,
    body: &Bytes,
    known_zone: Option<bool>,
) -> Result<Map<String, Value>, Refusal> {
    validate(headers, body, |issues, fields| {
        let mut refinements = Vec::new();
        let mut data = Map::new();
        let text = |field: Field<String>| match field {
            Field::Set(text) => Field::Set(Value::String(text)),
            Field::Null => Field::Null,
            Field::Absent => Field::Absent,
        };
        let name = issues.text(fields, "widgetName", Presence::Optional, None, Some(255));
        keep(&mut data, "widgetName", text(name));
        let enabled = issues.boolean(fields, "enabled", Presence::Optional);
        if let Field::Set(flag) = enabled {
            data.insert("enabled".to_owned(), Value::Bool(flag));
        }
        let greeting = issues.text(fields, "greeting", Presence::Nullish, None, Some(500));
        keep(&mut data, "greeting", text(greeting));
        if let Some(branding) = branding(issues, fields) {
            data.insert("branding".to_owned(), branding);
        }
        if let Some(domains) = allowed_domains(issues, fields) {
            data.insert("allowedDomains".to_owned(), domains);
        }
        let hours = office_hours(issues, fields, &mut refinements);
        keep(&mut data, "officeHours", hours);
        // `z.string().max(64).refine(isKnownZone)`: a too-long zone is only
        // dirty, so the refinement still runs.
        let zone = issues.text(fields, "timezone", Presence::Nullish, None, Some(64));
        if let Some(Value::String(_)) = fields.get("timezone")
            && known_zone == Some(false)
        {
            refinements.insert(
                0,
                Refinement {
                    path: issues_path(issues, "timezone"),
                    message: "Unknown timezone",
                },
            );
        }
        keep(&mut data, "timezone", text(zone));
        let away = issues.text_with(
            fields,
            "awayMessage",
            Presence::Nullish,
            Text::trimmed(None, Some(1000)),
        );
        keep(&mut data, "awayMessage", text(away));
        let reply = issues.choice(fields, "expectedReplyTime", Presence::Nullish, &REPLY_TIMES);
        keep(&mut data, "expectedReplyTime", text(reply));
        for refinement in refinements {
            issues.custom_at(&refinement.path, refinement.message);
        }
        data
    })
}

// ── routes ──────────────────────────────────────────────────────────────────

async fn list(caller: Caller) -> Response {
    let rows: Result<Vec<Value>, _> =
        sqlx::query_scalar("select to_jsonb(t) from desk_widget_settings t")
            .fetch_all(&caller.db)
            .await;
    match rows {
        Ok(rows) => Data(Value::Array(
            rows.into_iter().map(|row| WIDGETS.js(row)).collect(),
        ))
        .into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to list widgets"),
    }
}

async fn create(
    State(state): State<DeskState>,
    caller: Caller,
    Extension(tenant): Extension<Tenant>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to create widget";
    let data = match read_create(&headers, &body) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let id = generate_id("dwgt");
    let widget_id = generate_id("widget");
    let now = now();
    let name = data
        .get("widgetName")
        .and_then(Value::as_str)
        .unwrap_or("Chat widget")
        .to_owned();
    let mut values = Map::new();
    WIDGETS.set(&mut values, "id", json!(id));
    WIDGETS.set(&mut values, "createdAt", json!(now));
    WIDGETS.set(&mut values, "updatedAt", json!(now));
    WIDGETS.set(&mut values, "widgetId", json!(widget_id));
    WIDGETS.set(&mut values, "widgetName", json!(name));
    WIDGETS.set(&mut values, "enabled", Value::Bool(true));
    WIDGETS.set(
        &mut values,
        "greeting",
        data.get("greeting")
            .cloned()
            .unwrap_or_else(|| json!("Hi — how can we help?")),
    );
    WIDGETS.set(
        &mut values,
        "branding",
        data.get("branding")
            .cloned()
            .unwrap_or_else(|| json!({ "primaryColor": "#2563eb", "position": "right" })),
    );
    WIDGETS.set(
        &mut values,
        "allowedDomains",
        data.get("allowedDomains")
            .cloned()
            .unwrap_or_else(|| json!([])),
    );
    let created = match WIDGETS
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        Ok(row) => row,
        Err(error) => return write_failed(&error, message),
    };
    if let Some(master) = master(&caller, &state) {
        let inserted = sqlx::query(
            "insert into widget_registry (id, widget_id, workspace_id, widget_name, is_active, created_at, updated_at)
             values ($1, $2, $3, $4, true, $5::timestamp, $5::timestamp)",
        )
        .bind(generate_id("wr"))
        .bind(&widget_id)
        .bind(&tenant.workspace_id)
        .bind(&name)
        .bind(&now)
        .execute(&master)
        .await;
        if let Err(error) = inserted {
            tracing::error!(%error, "[app-api/desk-widget] registry insert failed");
        }
    }
    caller.publish(
        &state,
        ev::DESK_WIDGET_CREATED,
        &id,
        &json!({ "id": id, "widgetId": widget_id, "widgetName": name }),
    );
    Created(created).into_response()
}

async fn by_widget_id(db: &PgPool, widget_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_widget_settings t where t.widget_id = $1 limit 1",
    )
    .bind(widget_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| WIDGETS.js(row)))
}

async fn detail(caller: Caller, Path(widget_id): Path<String>) -> Response {
    let message = "Failed to fetch widget";
    match by_widget_id(&caller.db, &widget_id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Widget", &widget_id).respond(message),
        Err(error) => Refusal::Database(error).respond(message),
    }
}

/// Whether the body's `timezone` is a zone the runtime knows
/// (`new Intl.DateTimeFormat('en-US', { timeZone })` doesn't throw): the
/// IANA database Postgres carries, matched without case as ICU does, or a
/// UTC offset. `None` when the body has no string zone.
async fn zone_known(db: &PgPool, body: &Bytes) -> Result<Option<bool>, sqlx::Error> {
    let Some(Value::Object(fields)) = lenient_json(body) else {
        return Ok(None);
    };
    let Some(Value::String(zone)) = fields.get("timezone") else {
        return Ok(None);
    };
    if is_offset(zone) {
        return Ok(Some(true));
    }
    let known: bool = sqlx::query_scalar(
        "select exists(select 1 from pg_timezone_names where lower(name) = lower($1))",
    )
    .bind(zone)
    .fetch_one(db)
    .await?;
    Ok(Some(known))
}

/// `+01:00`, `-0530`, `+01`: offsets `Intl.DateTimeFormat` accepts.
fn is_offset(zone: &str) -> bool {
    let bytes = zone.as_bytes();
    if bytes.len() < 3 || !(bytes[0] == b'+' || bytes[0] == b'-') {
        return false;
    }
    let rest = &zone[1..];
    let digits: String = rest.chars().filter(|c| *c != ':').collect();
    (digits.len() == 2 || digits.len() == 4)
        && digits.chars().all(|c| c.is_ascii_digit())
        && (rest.len() == digits.len() || rest.len() == 5 && rest.as_bytes()[2] == b':')
}

async fn update(
    State(state): State<DeskState>,
    caller: Caller,
    Path(widget_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to update widget";
    let known_zone = match zone_known(&caller.db, &body).await {
        Ok(known) => known,
        Err(error) => return Refusal::Database(error).respond(message),
    };
    let data = match read_update(&headers, &body, known_zone) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(message),
    };
    let existing = match by_widget_id(&caller.db, &widget_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Widget", &widget_id).respond(message),
        Err(error) => return Refusal::Database(error).respond(message),
    };
    let id = existing["id"].as_str().unwrap_or_default().to_owned();
    // `widgetSettingsPatch(data)`: the fields sent; an empty away message
    // clears it (`data.awayMessage || null`).
    let mut values = Map::new();
    WIDGETS.set(&mut values, "updatedAt", json!(now()));
    for (key, value) in &data {
        let value = if key == "awayMessage" && value.as_str() == Some("") {
            Value::Null
        } else {
            value.clone()
        };
        WIDGETS.set(&mut values, key, value);
    }
    let updated = match WIDGETS
        .patch(&caller.db, &id, values, true, &["updatedAt"])
        .await
    {
        Ok(row) => row,
        Err(error) => return write_failed(&error, message),
    };
    let name = data
        .get("widgetName")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty());
    let enabled = data.get("enabled").and_then(Value::as_bool);
    if (name.is_some() || enabled.is_some())
        && let Some(master) = master(&caller, &state)
    {
        let changed = sqlx::query(
            "update widget_registry set
               widget_name = case when $2::boolean then $3::text else widget_name end,
               is_active = case when $4::boolean then $5::boolean else is_active end,
               updated_at = $6::timestamp
             where widget_id = $1",
        )
        .bind(&widget_id)
        .bind(name.is_some())
        .bind(name)
        .bind(enabled.is_some())
        .bind(enabled)
        .bind(now())
        .execute(&master)
        .await;
        if let Err(error) = changed {
            tracing::error!(%error, "[app-api/desk-widget] registry update failed");
        }
    }
    let row = updated.unwrap_or(existing);
    caller.publish(&state, ev::DESK_WIDGET_UPDATED, &id, &row);
    Data(row).into_response()
}

async fn remove(
    State(state): State<DeskState>,
    caller: Caller,
    Path(widget_id): Path<String>,
) -> Response {
    let message = "Failed to delete widget";
    let existing = match by_widget_id(&caller.db, &widget_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found("Widget", &widget_id).respond(message),
        Err(error) => return Refusal::Database(error).respond(message),
    };
    let id = existing["id"].as_str().unwrap_or_default().to_owned();
    let deleted = sqlx::query("delete from desk_widget_settings where id = $1")
        .bind(&id)
        .execute(&caller.db)
        .await;
    if let Err(error) = deleted {
        return Refusal::Database(error).respond(message);
    }
    if let Some(master) = master(&caller, &state) {
        let removed = sqlx::query("delete from widget_registry where widget_id = $1")
            .bind(&widget_id)
            .execute(&master)
            .await;
        if let Err(error) = removed {
            tracing::error!(%error, "[app-api/desk-widget] registry delete failed");
        }
    }
    caller.publish(
        &state,
        ev::DESK_WIDGET_DELETED,
        &id,
        &json!({ "id": id, "widgetId": widget_id }),
    );
    Data(json!({ "id": id, "widgetId": widget_id })).into_response()
}
