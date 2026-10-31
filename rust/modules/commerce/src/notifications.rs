//! `/api/parcel-notifications`: the parcel module's email, SMS and WhatsApp
//! notification templates and its outbound webhooks (with a signed test
//! delivery). Every route takes `orders:read`, writes included, as the
//! worker does.

use std::sync::Arc;
use std::time::Instant;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use hmac::{Hmac, KeyInit, Mac};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sha2::Sha256;
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id, random_string};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::HttpRequest;

use crate::js::{js_parse_int, number_value, query_param};
use crate::table::{Table, WriteError};
use crate::tables;
use crate::{Caller, CommerceState, Refusal, now, validate};

/// One template kind's differences.
struct Kind {
    /// `templateType` in the events.
    label: &'static str,
    table: &'static Table,
    prefix: &'static str,
    /// `error.notFound(c, <resource>, id)`.
    resource: &'static str,
    /// The noun of the messages (`email template`, `SMS template`).
    noun: &'static str,
    list_sql: &'static str,
    count_sql: &'static str,
    schema: fn(&mut Issues, &Map<String, Value>, bool) -> Map<String, Value>,
}

macro_rules! template_sql {
    ($table:ident, $search:literal) => {
        (
            concat!(
                "select ", row_of!($table), " from ", stringify!($table), " t where t.deleted_at is null",
                " and ($1::text is null or ", $search, ")",
                " and ($2::boolean is null or t.is_active = $2)",
                " and ($3::text is null or t.trigger_event = $3)",
                " and ($4::text is null or t.approval_status = $4)",
                " order by t.created_at desc limit $5 offset $6"
            ),
            concat!(
                "select count(*)::int from ", stringify!($table), " t where t.deleted_at is null",
                " and ($1::text is null or ", $search, ")",
                " and ($2::boolean is null or t.is_active = $2)",
                " and ($3::text is null or t.trigger_event = $3)",
                " and ($4::text is null or t.approval_status = $4)"
            ),
        )
    };
}

/// `email_templates` and `sms_templates` have no `approval_status`: their
/// statements drop that slot.
macro_rules! template_sql_plain {
    ($table:ident, $search:literal) => {
        (
            concat!(
                "select ", row_of!($table), " from ", stringify!($table), " t where t.deleted_at is null",
                " and ($1::text is null or ", $search, ")",
                " and ($2::boolean is null or t.is_active = $2)",
                " and ($3::text is null or t.trigger_event = $3)",
                " and $4::text is null",
                " order by t.created_at desc limit $5 offset $6"
            ),
            concat!(
                "select count(*)::int from ", stringify!($table), " t where t.deleted_at is null",
                " and ($1::text is null or ", $search, ")",
                " and ($2::boolean is null or t.is_active = $2)",
                " and ($3::text is null or t.trigger_event = $3)",
                " and $4::text is null"
            ),
        )
    };
}

const EMAIL_SQL: (&str, &str) =
    template_sql_plain!(email_templates, "t.name like $1 or t.subject like $1");
const SMS_SQL: (&str, &str) =
    template_sql_plain!(sms_templates, "t.name like $1 or t.message like $1");
const WHATSAPP_SQL: (&str, &str) =
    template_sql!(whatsapp_templates, "t.name like $1 or t.message like $1");

static EMAIL: Kind = Kind {
    label: "email",
    table: &tables::EMAIL_TEMPLATES,
    prefix: "etpl",
    resource: "Email template",
    noun: "email template",
    list_sql: EMAIL_SQL.0,
    count_sql: EMAIL_SQL.1,
    schema: email_schema,
};

static SMS: Kind = Kind {
    label: "sms",
    table: &tables::SMS_TEMPLATES,
    prefix: "stpl",
    resource: "SMS template",
    noun: "SMS template",
    list_sql: SMS_SQL.0,
    count_sql: SMS_SQL.1,
    schema: sms_schema,
};

static WHATSAPP: Kind = Kind {
    label: "whatsapp",
    table: &tables::WHATSAPP_TEMPLATES,
    prefix: "wtpl",
    resource: "WhatsApp template",
    noun: "WhatsApp template",
    list_sql: WHATSAPP_SQL.0,
    count_sql: WHATSAPP_SQL.1,
    schema: whatsapp_schema,
};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::ORDERS_READ]);
    let mut router = Router::new();
    for (path, kind) in [("email", &EMAIL), ("sms", &SMS), ("whatsapp", &WHATSAPP)] {
        router = router
            .route(
                &format!("/{path}"),
                get(move |caller: Caller, query: RawQuery| list(kind, caller, query))
                    .post(move |state: State<CommerceState>, caller: Caller, headers: HeaderMap, body: Bytes| {
                        create(kind, state, caller, headers, body)
                    })
                    .route_layer(read()),
            )
            .route(
                &format!("/{path}/{{id}}"),
                get(move |caller: Caller, id: Path<String>| detail(kind, caller, id))
                    .put(
                        move |state: State<CommerceState>,
                              caller: Caller,
                              id: Path<String>,
                              headers: HeaderMap,
                              body: Bytes| { update(kind, state, caller, id, headers, body) },
                    )
                    .delete(move |state: State<CommerceState>, caller: Caller, id: Path<String>| {
                        remove(kind, state, caller, id)
                    })
                    .route_layer(read()),
            )
            .route(
                &format!("/{path}/{{id}}/toggle"),
                patch(move |state: State<CommerceState>, caller: Caller, id: Path<String>| {
                    toggle(kind, state, caller, id)
                })
                .route_layer(read()),
            );
    }
    router
        .route(
            "/webhooks",
            get(list_webhooks).post(create_webhook).route_layer(read()),
        )
        .route(
            "/webhooks/{id}",
            get(webhook)
                .put(update_webhook)
                .delete(delete_webhook)
                .route_layer(read()),
        )
        .route(
            "/webhooks/{id}/enable",
            patch(|state: State<CommerceState>, caller: Caller, id: Path<String>| {
                set_status(state, caller, id, "active")
            })
            .route_layer(read()),
        )
        .route(
            "/webhooks/{id}/disable",
            patch(|state: State<CommerceState>, caller: Caller, id: Path<String>| {
                set_status(state, caller, id, "paused")
            })
            .route_layer(read()),
        )
        .route("/webhooks/{id}/test", post(test_webhook).route_layer(read()))
        .route("/webhooks/{id}/logs", get(webhook_logs).route_layer(read()))
}

// ── schemas ─────────────────────────────────────────────────────────────────

const OPT: Presence = Presence::Optional;

fn required(partial: bool) -> Presence {
    if partial { OPT } else { Presence::Required }
}

/// Zod's parsed object: the schema's keys that were present, in its order.
struct Parsed<'a> {
    fields: &'a Map<String, Value>,
    out: Map<String, Value>,
}

impl<'a> Parsed<'a> {
    fn new(fields: &'a Map<String, Value>) -> Self {
        Self {
            fields,
            out: Map::new(),
        }
    }

    fn keep(&mut self, key: &str, set: bool) {
        if set && let Some(value) = self.fields.get(key) {
            self.out.insert(key.to_owned(), value.clone());
        }
    }

    fn text(&mut self, issues: &mut Issues, key: &str, presence: Presence, rules: Text) {
        let set = issues.text_with(self.fields, key, presence, rules).as_set().is_some();
        self.keep(key, set);
    }

    fn strings(&mut self, issues: &mut Issues, key: &str) {
        let set = issues
            .list(self.fields, key, OPT, None, None, |issues, item| {
                issues.item_text(item, Text::default())
            })
            .as_set()
            .is_some();
        self.keep(key, set);
    }

    /// `z.boolean().default(value)`; under `.partial()` no default.
    fn flag(&mut self, issues: &mut Issues, key: &str, default: bool, partial: bool) {
        match issues.boolean(self.fields, key, OPT).into_option() {
            Some(flag) => {
                self.out.insert(key.to_owned(), json!(flag));
            }
            None if !partial && !self.fields.contains_key(key) => {
                self.out.insert(key.to_owned(), json!(default));
            }
            None => {}
        }
    }
}

fn email_schema(issues: &mut Issues, fields: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let mut p = Parsed::new(fields);
    p.text(issues, "name", required(partial), Text::length(Some(1), None));
    p.text(issues, "subject", required(partial), Text::length(Some(1), None));
    p.text(issues, "body", OPT, Text::default());
    p.text(issues, "htmlBody", OPT, Text::default());
    p.strings(issues, "variables");
    p.text(issues, "triggerEvent", OPT, Text::default());
    p.flag(issues, "isActive", true, partial);
    p.flag(issues, "isDefault", false, partial);
    p.text(issues, "description", OPT, Text::default());
    p.strings(issues, "tags");
    p.out
}

fn sms_schema(issues: &mut Issues, fields: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let mut p = Parsed::new(fields);
    p.text(issues, "name", required(partial), Text::length(Some(1), None));
    p.text(issues, "message", required(partial), Text::length(Some(1), None));
    match issues.number(fields, "maxLength", OPT, Number::default()).into_option() {
        Some(n) => {
            p.out.insert("maxLength".to_owned(), number_value(n));
        }
        None if !partial && !fields.contains_key("maxLength") => {
            p.out.insert("maxLength".to_owned(), json!(160));
        }
        None => {}
    }
    p.strings(issues, "variables");
    p.text(issues, "triggerEvent", OPT, Text::default());
    p.flag(issues, "isActive", true, partial);
    p.flag(issues, "isDefault", false, partial);
    p.text(issues, "description", OPT, Text::default());
    p.strings(issues, "tags");
    p.out
}

fn whatsapp_schema(issues: &mut Issues, fields: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let mut p = Parsed::new(fields);
    p.text(issues, "name", required(partial), Text::length(Some(1), None));
    p.text(issues, "message", required(partial), Text::length(Some(1), None));
    p.text(issues, "headerText", OPT, Text::default());
    p.text(issues, "footerText", OPT, Text::default());
    p.strings(issues, "variables");
    p.text(issues, "mediaType", OPT, Text::default());
    p.text(issues, "mediaUrl", OPT, Text::default());
    // `z.array(z.object({ type, text, url?, phoneNumber? }))`: items stripped.
    let buttons = issues.list(fields, "buttons", OPT, None, None, |issues, item| {
        let Some(button) = issues.object(item) else {
            return None;
        };
        let before = issues.count();
        let mut out = Map::new();
        if let Some(kind) = issues
            .choice(button, "type", Presence::Required, &["quick_reply", "url", "phone"])
            .into_option()
        {
            out.insert("type".to_owned(), json!(kind));
        }
        for (key, presence) in [("text", Presence::Required), ("url", OPT), ("phoneNumber", OPT)] {
            if let Some(text) = issues.text_with(button, key, presence, Text::default()).into_option() {
                out.insert(key.to_owned(), json!(text));
            }
        }
        (issues.count() == before).then_some(Value::Object(out))
    });
    if let Some(buttons) = buttons.into_option() {
        p.out.insert("buttons".to_owned(), Value::Array(buttons));
    }
    p.text(issues, "triggerEvent", OPT, Text::default());
    p.flag(issues, "isActive", true, partial);
    p.flag(issues, "isDefault", false, partial);
    p.text(issues, "description", OPT, Text::default());
    p.strings(issues, "tags");
    if partial
        && let Some(status) = issues
            .choice(fields, "approvalStatus", OPT, &["pending", "approved", "rejected"])
            .into_option()
    {
        p.out.insert("approvalStatus".to_owned(), json!(status));
    }
    p.out
}

// ── paging ──────────────────────────────────────────────────────────────────

/// `Math.max(1, q.page ? parseInt : 1)` and `Math.min(q.pageSize ? parseInt : 20, 100)`.
fn paging(query: Option<&str>) -> (f64, f64) {
    let page = match query_param(query, "page").filter(|p| !p.is_empty()) {
        None => 1.0,
        Some(raw) => js_parse_int(&raw).map_or(f64::NAN, |n| n.max(1.0)),
    };
    let size = match query_param(query, "pageSize").filter(|p| !p.is_empty()) {
        None => 20.0,
        Some(raw) => js_parse_int(&raw).map_or(f64::NAN, |n| n.min(100.0)),
    };
    (page, size)
}

/// Drizzle's `.limit(size).offset((page - 1) * size)`: a NaN or negative
/// limit is left out, and so is a falsy offset.
#[allow(clippy::cast_possible_truncation)]
fn limit_offset(page: f64, size: f64) -> (Option<i64>, Option<i64>) {
    let limit = (size >= 0.0).then_some(size as i64);
    let offset = (page - 1.0) * size;
    let offset = (!offset.is_nan() && offset != 0.0).then_some(offset as i64);
    (limit, offset)
}

fn pagination(page: f64, size: f64, total: i32) -> Value {
    let total = f64::from(total);
    json!({
        "page": number_value(page),
        "pageSize": number_value(size),
        "totalCount": number_value(total),
        "totalPages": number_value((total / size).ceil()),
        "hasMore": page * size < total,
    })
}

/// A template row as the routes answer it: `toISOString()` dates, a null
/// one left out (`?.toISOString()` is undefined).
fn template_row(kind: &Kind, row: Value) -> Value {
    let mut row = kind.table.js(row);
    if let Value::Object(fields) = &mut row {
        for key in ["createdAt", "updatedAt", "lastUsedAt"] {
            if fields.get(key).is_some_and(Value::is_null) {
                fields.remove(key);
            }
        }
    }
    row
}

// ── templates ───────────────────────────────────────────────────────────────

async fn list(kind: &'static Kind, caller: Caller, RawQuery(query): RawQuery) -> Response {
    let message = format!("Failed to fetch {}s", kind.noun);
    let query = query.as_deref();
    let (page, size) = paging(query);
    let search = query_param(query, "search")
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let active = query_param(query, "isActive").map(|v| v == "true");
    let trigger = query_param(query, "triggerEvent").filter(|t| !t.is_empty());
    let approval = if kind.label == "whatsapp" {
        query_param(query, "approvalStatus").filter(|a| !a.is_empty())
    } else {
        None
    };
    let total: Result<i32, sqlx::Error> = sqlx::query_scalar(kind.count_sql)
        .bind(search.as_deref())
        .bind(active)
        .bind(trigger.as_deref())
        .bind(approval.as_deref())
        .fetch_one(&caller.db)
        .await;
    let total = match total {
        Ok(total) => total,
        Err(error) => return Refusal::Database(error).respond(&message),
    };
    let (limit, offset) = limit_offset(page, size);
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(kind.list_sql)
        .bind(search.as_deref())
        .bind(active)
        .bind(trigger.as_deref())
        .bind(approval.as_deref())
        .bind(limit)
        .bind(offset)
        .fetch_all(&caller.db)
        .await;
    match rows {
        Ok(rows) => {
            let templates: Vec<Value> = rows.into_iter().map(|row| template_row(kind, row)).collect();
            axum::Json(json!({ "data": { "templates": templates, "pagination": pagination(page, size, total) } }))
                .into_response()
        }
        Err(error) => Refusal::Database(error).respond(&message),
    }
}

async fn live(table: &Table, caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(table.select_live)
        .bind(id)
        .fetch_optional(&caller.db)
        .await?;
    Ok(row)
}

async fn detail(kind: &'static Kind, caller: Caller, Path(id): Path<String>) -> Response {
    let message = format!("Failed to fetch {}", kind.noun);
    match live(kind.table, &caller, &id).await {
        Ok(Some(row)) => Data(template_row(kind, row)).into_response(),
        Ok(None) => Refusal::not_found(kind.resource, &id).respond(&message),
        Err(error) => Refusal::Database(error).respond(&message),
    }
}

fn write_failed(error: &WriteError, message: &str) -> Response {
    tracing::error!(%error, "[commerce-api/parcel-notifications] {message}");
    ApiError::internal().with_message(message).into_response()
}

async fn create(
    kind: &'static Kind,
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = format!("Failed to create {}", kind.noun);
    let data = match validate(&headers, &body, |issues, fields| (kind.schema)(issues, fields, false)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(&message),
    };
    let id = generate_id(kind.prefix);
    let now = now();
    let mut values = Map::new();
    kind.table.set(&mut values, "id", json!(id));
    values.extend(kind.table.values(&data));
    if kind.label == "whatsapp" {
        kind.table.set(&mut values, "approvalStatus", json!("pending"));
    }
    kind.table.set(&mut values, "createdAt", json!(now));
    kind.table.set(&mut values, "updatedAt", json!(now));
    if let Err(error) = kind
        .table
        .insert(&caller.db, values, &["createdAt", "updatedAt"])
        .await
    {
        return write_failed(&error, &message);
    }
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    event.insert("templateType".to_owned(), json!(kind.label));
    if let Some(name) = data.get("name") {
        event.insert("name".to_owned(), name.clone());
    }
    caller.publish(&state, ev::NOTIFICATION_TEMPLATE_CREATED, &id, &Value::Object(event));
    Created(json!({ "id": id })).into_response()
}

async fn update(
    kind: &'static Kind,
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = format!("Failed to update {}", kind.noun);
    let data = match validate(&headers, &body, |issues, fields| (kind.schema)(issues, fields, true)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(&message),
    };
    match live(kind.table, &caller, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found(kind.resource, &id).respond(&message),
        Err(error) => return Refusal::Database(error).respond(&message),
    }
    let mut values = kind.table.values(&data);
    kind.table.set(&mut values, "updatedAt", json!(now()));
    if let Err(error) = kind.table.patch(&caller.db, &id, values, true, &["updatedAt"]).await {
        return write_failed(&error, &message);
    }
    caller.publish(
        &state,
        ev::NOTIFICATION_TEMPLATE_UPDATED,
        &id,
        &json!({ "id": id, "templateType": kind.label }),
    );
    Data(json!({ "id": id })).into_response()
}

async fn toggle(
    kind: &'static Kind,
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let message = format!("Failed to toggle {} status", kind.noun);
    let current = match live(kind.table, &caller, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Refusal::not_found(kind.resource, &id).respond(&message),
        Err(error) => return Refusal::Database(error).respond(&message),
    };
    let active = !current.get("is_active").and_then(Value::as_bool).unwrap_or(false);
    let mut values = Map::new();
    kind.table.set(&mut values, "isActive", json!(active));
    kind.table.set(&mut values, "updatedAt", json!(now()));
    if let Err(error) = kind.table.patch(&caller.db, &id, values, true, &["updatedAt"]).await {
        return write_failed(&error, &message);
    }
    caller.publish(
        &state,
        ev::NOTIFICATION_TEMPLATE_UPDATED,
        &id,
        &json!({ "id": id, "templateType": kind.label, "isActive": active }),
    );
    Data(json!({ "id": id, "isActive": active })).into_response()
}

async fn remove(
    kind: &'static Kind,
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let message = format!("Failed to delete {}", kind.noun);
    soft_delete(kind.table, kind.resource, &message, &caller, &id).await.map_or_else(
        |response| response,
        |()| {
            caller.publish(
                &state,
                ev::NOTIFICATION_TEMPLATE_DELETED,
                &id,
                &json!({ "id": id, "templateType": kind.label }),
            );
            NoContent.into_response()
        },
    )
}

/// The live row exists, then `set({ deletedAt, updatedAt })` on it.
async fn soft_delete(
    table: &Table,
    resource: &str,
    message: &str,
    caller: &Caller,
    id: &str,
) -> Result<(), Response> {
    match live(table, caller, id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Err(Refusal::not_found(resource, id).respond(message)),
        Err(error) => return Err(Refusal::Database(error).respond(message)),
    }
    let now = now();
    let mut values = Map::new();
    table.set(&mut values, "deletedAt", json!(now));
    table.set(&mut values, "updatedAt", json!(now));
    table
        .patch(&caller.db, id, values, true, &["deletedAt", "updatedAt"])
        .await
        .map(|_| ())
        .map_err(|error| write_failed(&error, message))
}

// ── webhooks ────────────────────────────────────────────────────────────────

const WEBHOOK_LIST: &str = concat!(
    "select ",
    row_of!(external_webhooks),
    " from external_webhooks t where t.deleted_at is null and ($1::text is null or t.status = $1)",
    " order by t.created_at desc limit $2 offset $3"
);
const WEBHOOK_COUNT: &str = "select count(*)::int from external_webhooks t \
    where t.deleted_at is null and ($1::text is null or t.status = $1)";

fn webhook_fields(w: &Value, full: bool) -> Value {
    let get = |key: &str| w.get(key).cloned().unwrap_or(Value::Null);
    let or_zero = |key: &str| w.get(key).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!(0));
    let mut out = Map::new();
    for key in ["id", "name", "description", "url"] {
        out.insert(key.to_owned(), get(key));
    }
    out.insert(
        "events".to_owned(),
        w.get("events").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!([])),
    );
    out.insert("status".to_owned(), get("status"));
    out.insert("isActive".to_owned(), json!(w.get("status") == Some(&json!("active"))));
    if full {
        out.insert("headers".to_owned(), get("headers"));
    } else {
        out.insert("callCount".to_owned(), or_zero("totalDeliveries"));
    }
    out.insert("totalDeliveries".to_owned(), or_zero("totalDeliveries"));
    out.insert("totalFailures".to_owned(), or_zero("totalFailures"));
    out.insert("consecutiveFailures".to_owned(), or_zero("consecutiveFailures"));
    let date = |key: &str, out: &mut Map<String, Value>| {
        if let Some(value) = w.get(key).filter(|v| !v.is_null()) {
            out.insert(key.to_owned(), value.clone());
        }
    };
    date("lastDeliveredAt", &mut out);
    date("lastFailedAt", &mut out);
    if full {
        out.insert("lastFailureReason".to_owned(), get("lastFailureReason"));
    }
    date("createdAt", &mut out);
    date("updatedAt", &mut out);
    Value::Object(out)
}

async fn list_webhooks(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to fetch webhooks";
    let query = query.as_deref();
    let (page, size) = paging(query);
    let status = query_param(query, "status").filter(|s| !s.is_empty() && s != "all");
    let total: Result<i32, sqlx::Error> = sqlx::query_scalar(WEBHOOK_COUNT)
        .bind(status.as_deref())
        .fetch_one(&caller.db)
        .await;
    let total = match total {
        Ok(total) => total,
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    let (limit, offset) = limit_offset(page, size);
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(WEBHOOK_LIST)
        .bind(status.as_deref())
        .bind(limit)
        .bind(offset)
        .fetch_all(&caller.db)
        .await;
    match rows {
        Ok(rows) => {
            let webhooks: Vec<Value> = rows
                .into_iter()
                .map(|row| webhook_fields(&tables::EXTERNAL_WEBHOOKS.js(row), false))
                .collect();
            axum::Json(json!({ "data": { "webhooks": webhooks, "pagination": pagination(page, size, total) } }))
                .into_response()
        }
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

async fn live_webhook(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    Ok(live(&tables::EXTERNAL_WEBHOOKS, caller, id)
        .await?
        .map(|row| tables::EXTERNAL_WEBHOOKS.js(row)))
}

async fn webhook(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch webhook";
    match live_webhook(&caller, &id).await {
        Ok(Some(w)) => Data(webhook_fields(&w, true)).into_response(),
        Ok(None) => Refusal::not_found("Webhook", &id).respond(FAILED),
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

/// `createWebhookSchema` (`partial` for the PUT).
fn webhook_schema(issues: &mut Issues, fields: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let mut p = Parsed::new(fields);
    p.text(issues, "name", required(partial), Text::length(Some(1), None));
    p.text(
        issues,
        "url",
        required(partial),
        Text {
            format: Some(Format::Url),
            ..Text::default()
        },
    );
    let events = issues
        .list(fields, "events", required(partial), Some(1), None, |issues, item| {
            issues.item_text(item, Text::default())
        })
        .as_set()
        .is_some();
    p.keep("events", events);
    p.text(issues, "secret", OPT, Text::default());
    p.text(issues, "description", OPT, Text::default());
    // `z.record(z.string())`.
    let headers = issues
        .nested(fields, "headers", OPT, |issues, inner| {
            for key in inner.keys() {
                issues.text_with(inner, key, Presence::Required, Text::default());
            }
        })
        .as_set()
        .is_some();
    p.keep("headers", headers);
    p.out
}

async fn create_webhook(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create webhook";
    let data = match validate(&headers, &body, |issues, fields| webhook_schema(issues, fields, false)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let id = generate_id("whk");
    // HMAC signing key: generateId's 8 random characters are an id, not a secret.
    let secret = data
        .get("secret")
        .and_then(Value::as_str)
        .map_or_else(|| format!("whksec_{}", random_string(32, weldsuite_kit::id::ALPHANUMERIC)), str::to_owned);
    let now = now();
    let t = &tables::EXTERNAL_WEBHOOKS;
    let mut values = Map::new();
    t.set(&mut values, "id", json!(id));
    t.set(&mut values, "createdBy", json!(caller.user_id));
    for key in ["name", "url", "events"] {
        if let Some(value) = data.get(key) {
            t.set(&mut values, key, value.clone());
        }
    }
    t.set(&mut values, "secret", json!(secret));
    for key in ["description", "headers"] {
        if let Some(value) = data.get(key) {
            t.set(&mut values, key, value.clone());
        }
    }
    t.set(&mut values, "status", json!("active"));
    t.set(&mut values, "createdAt", json!(now));
    t.set(&mut values, "updatedAt", json!(now));
    if let Err(error) = t.insert(&caller.db, values, &["createdAt", "updatedAt"]).await {
        return write_failed(&error, FAILED);
    }
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    event.insert("templateType".to_owned(), json!("webhook"));
    if let Some(name) = data.get("name") {
        event.insert("name".to_owned(), name.clone());
    }
    caller.publish(&state, ev::NOTIFICATION_TEMPLATE_CREATED, &id, &Value::Object(event));
    Created(json!({ "id": id, "secret": secret })).into_response()
}

async fn update_webhook(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update webhook";
    let data = match validate(&headers, &body, |issues, fields| webhook_schema(issues, fields, true)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match live_webhook(&caller, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found("Webhook", &id).respond(FAILED),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    }
    let t = &tables::EXTERNAL_WEBHOOKS;
    let mut values = t.values(&data);
    t.set(&mut values, "updatedAt", json!(now()));
    if let Err(error) = t.patch(&caller.db, &id, values, true, &["updatedAt"]).await {
        return write_failed(&error, FAILED);
    }
    caller.publish(
        &state,
        ev::NOTIFICATION_TEMPLATE_UPDATED,
        &id,
        &json!({ "id": id, "templateType": "webhook" }),
    );
    Data(json!({ "id": id })).into_response()
}

async fn set_status(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    status: &'static str,
) -> Response {
    let failed = if status == "active" {
        "Failed to enable webhook"
    } else {
        "Failed to disable webhook"
    };
    match live_webhook(&caller, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found("Webhook", &id).respond(failed),
        Err(error) => return Refusal::Database(error).respond(failed),
    }
    let t = &tables::EXTERNAL_WEBHOOKS;
    let mut values = Map::new();
    t.set(&mut values, "status", json!(status));
    t.set(&mut values, "updatedAt", json!(now()));
    if let Err(error) = t.patch(&caller.db, &id, values, true, &["updatedAt"]).await {
        return write_failed(&error, failed);
    }
    caller.publish(
        &state,
        ev::NOTIFICATION_TEMPLATE_UPDATED,
        &id,
        &json!({ "id": id, "templateType": "webhook", "status": status }),
    );
    Data(json!({ "id": id, "status": status })).into_response()
}

async fn delete_webhook(State(state): State<CommerceState>, caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to delete webhook";
    match soft_delete(&tables::EXTERNAL_WEBHOOKS, "Webhook", FAILED, &caller, &id).await {
        Ok(()) => {
            caller.publish(
                &state,
                ev::NOTIFICATION_TEMPLATE_DELETED,
                &id,
                &json!({ "id": id, "templateType": "webhook" }),
            );
            NoContent.into_response()
        }
        Err(response) => response,
    }
}

/// `JSON.stringify(value)` of a string.
fn js_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// What the test delivery ended with.
enum Delivery {
    Answered { status: u16, body: String, ok: bool },
    Failed(String),
}

#[allow(clippy::too_many_lines)]
async fn test_webhook(State(state): State<CommerceState>, caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to test webhook";
    let webhook = match live_webhook(&caller, &id).await {
        Ok(Some(w)) => w,
        Ok(None) => return Refusal::not_found("Webhook", &id).respond(FAILED),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    let timestamp = now();
    // `JSON.stringify({ event, timestamp, data: { message } })`, in that order.
    let payload = format!(
        "{{\"event\":\"test\",\"timestamp\":{},\"data\":{{\"message\":\"This is a test webhook delivery\"}}}}",
        js_string(&timestamp)
    );
    let delivery_id = generate_id("whdel");
    let millis = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    let inserted = sqlx::query(
        "insert into webhook_deliveries (id, webhook_id, event_type, event_id, payload, status, created_at) \
         values ($1, $2, 'test', $3, $4::jsonb, 'pending', $5::timestamptz)",
    )
    .bind(&delivery_id)
    .bind(&id)
    .bind(format!("test_{millis}"))
    .bind(&payload)
    .bind(now())
    .execute(&caller.db)
    .await;
    if let Err(error) = inserted {
        return Refusal::Database(error).respond(FAILED);
    }
    let started = Instant::now();
    let secret = webhook.get("secret").and_then(Value::as_str).unwrap_or_default();
    let delivery = if secret.is_empty() {
        // WebCrypto refuses an empty HMAC key before anything is sent.
        Delivery::Failed("Zero-length key is not supported".to_owned())
    } else {
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes())
            .expect("HMAC takes a key of any length");
        mac.update(payload.as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());
        let url = webhook.get("url").and_then(Value::as_str).unwrap_or_default();
        let mut request = HttpRequest::empty("POST", url)
            .header("Content-Type", "application/json")
            .header("X-Webhook-Event", "test")
            .header("X-Webhook-Signature", signature);
        if let Some(Value::Object(own)) = webhook.get("headers") {
            for (name, value) in own {
                let value = match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                };
                request.headers.retain(|(n, _)| !n.eq_ignore_ascii_case(name));
                request.headers.push((name.clone(), value));
            }
        }
        request.body = Some(payload.clone().into_bytes());
        match caller.overrides.http(&state) {
            Some(http) => match http.send(request).await {
                Ok(response) => Delivery::Answered {
                    status: response.status,
                    ok: response.ok(),
                    body: response.text(),
                },
                Err(_) => Delivery::Failed("fetch failed".to_owned()),
            },
            None => Delivery::Failed("fetch failed".to_owned()),
        }
    };
    #[allow(clippy::cast_possible_truncation)]
    let elapsed = started.elapsed().as_millis() as i64;
    let count = |key: &str| webhook.get(key).and_then(Value::as_i64).unwrap_or(0);
    let now = now();
    let (written, response) = match delivery {
        Delivery::Answered { status, body, ok: true } => {
            let delivery = sqlx::query(
                "update webhook_deliveries set status = 'delivered', response_status = $1, response_body = $2, \
                 response_time_ms = $3, delivered_at = $4::timestamptz where id = $5",
            )
            .bind(i32::from(status))
            .bind(&body)
            .bind(elapsed)
            .bind(&now)
            .bind(&delivery_id)
            .execute(&caller.db)
            .await;
            let hook = sqlx::query(
                "update external_webhooks set last_delivered_at = $1::timestamptz, total_deliveries = $2, \
                 consecutive_failures = 0, updated_at = $1::timestamptz where id = $3",
            )
            .bind(&now)
            .bind(count("totalDeliveries") + 1)
            .bind(&id)
            .execute(&caller.db)
            .await;
            (
                delivery.and(hook),
                json!({ "delivered": true, "status": status, "responseTimeMs": elapsed }),
            )
        }
        Delivery::Answered { status, body, ok: false } => {
            let reason = format!("HTTP {status}");
            let delivery = sqlx::query(
                "update webhook_deliveries set status = 'failed', response_status = $1, response_body = $2, \
                 response_time_ms = $3, error_message = $4 where id = $5",
            )
            .bind(i32::from(status))
            .bind(&body)
            .bind(elapsed)
            .bind(&reason)
            .bind(&delivery_id)
            .execute(&caller.db)
            .await;
            let hook = failed_webhook(&caller, &id, &now, &reason, count("totalFailures"), count("consecutiveFailures")).await;
            (
                delivery.and(hook),
                json!({ "delivered": false, "status": status, "error": body }),
            )
        }
        Delivery::Failed(message) => {
            let delivery = sqlx::query(
                "update webhook_deliveries set status = 'failed', error_message = $1 where id = $2",
            )
            .bind(&message)
            .bind(&delivery_id)
            .execute(&caller.db)
            .await;
            let hook = failed_webhook(&caller, &id, &now, &message, count("totalFailures"), count("consecutiveFailures")).await;
            (delivery.and(hook), json!({ "delivered": false, "error": message }))
        }
    };
    match written {
        Ok(_) => Data(response).into_response(),
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

async fn failed_webhook(
    caller: &Caller,
    id: &str,
    now: &str,
    reason: &str,
    failures: i64,
    consecutive: i64,
) -> Result<sqlx::postgres::PgQueryResult, sqlx::Error> {
    sqlx::query(
        "update external_webhooks set last_failed_at = $1::timestamptz, last_failure_reason = $2, \
         total_failures = $3, consecutive_failures = $4, updated_at = $1::timestamptz where id = $5",
    )
    .bind(now)
    .bind(reason)
    .bind(failures + 1)
    .bind(consecutive + 1)
    .bind(id)
    .execute(&caller.db)
    .await
}

async fn webhook_logs(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to fetch webhook logs";
    let (page, size) = paging(query.as_deref());
    let total: Result<i32, sqlx::Error> =
        sqlx::query_scalar("select count(*)::int from webhook_deliveries where webhook_id = $1")
            .bind(&id)
            .fetch_one(&caller.db)
            .await;
    let total = match total {
        Ok(total) => total,
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    let (limit, offset) = limit_offset(page, size);
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(webhook_deliveries),
        " from webhook_deliveries t where t.webhook_id = $1 order by t.created_at desc limit $2 offset $3"
    ))
    .bind(&id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&caller.db)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    let items: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let d = tables::WEBHOOK_DELIVERIES.js(row);
            let mut out = Map::new();
            for key in [
                "id",
                "eventType",
                "eventId",
                "status",
                "responseStatus",
                "responseTimeMs",
                "errorMessage",
                "attemptNumber",
            ] {
                out.insert(key.to_owned(), d.get(key).cloned().unwrap_or(Value::Null));
            }
            for key in ["createdAt", "deliveredAt"] {
                if let Some(value) = d.get(key).filter(|v| !v.is_null()) {
                    out.insert(key.to_owned(), value.clone());
                }
            }
            Value::Object(out)
        })
        .collect();
    let total = f64::from(total);
    axum::Json(json!({
        "data": {
            "items": items,
            "meta": {
                "page": number_value(page),
                "limit": number_value(size),
                "total": number_value(total),
                "totalPages": number_value((total / size).ceil()),
            },
        },
    }))
    .into_response()
}
