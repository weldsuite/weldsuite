//! `/api/external-webhooks` (`routes/external-webhooks/index.ts`,
//! `services/external-webhooks.ts`): the workspace's outbound webhook
//! subscriptions (`external_webhooks`) and their deliveries
//! (`webhook_deliveries`). The secret leaves the server only on create and
//! rotate. The test delivery goes out through the hub subscriber's delivery
//! path (`weldsuite_subscribers::deliver_webhook_event_with`); a failure puts
//! the workspace in the due index for the retry sweep (`webhook_retry`, where
//! Global uses D1).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};
use weldsuite_kit::{
    ApiError, Created, Data, List, NoContent, Pagination, generate_id, random_string,
};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{custom_objects, external_webhooks, webhook_deliveries};
use weldsuite_subscribers::{DeliverInput, WEBHOOK_RETRY_KIND, WebhookRow};

use crate::js::{next_cursor, page};
use crate::{Caller, ConnectState, Refusal, internal, validate, validate_query};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ConnectState> {
    let read = || gate.require([perm::WEBHOOKS_READ]);
    let update = || gate.require([perm::WEBHOOKS_UPDATE]);
    Router::new()
        .route("/events", get(events).route_layer(read()))
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create).route_layer(gate.require([perm::WEBHOOKS_CREATE])),
        )
        .route("/{id}", get(get_one).route_layer(read()))
        .route("/{id}", patch(update_one).route_layer(update()))
        .route(
            "/{id}",
            delete(delete_one).route_layer(gate.require([perm::WEBHOOKS_DELETE])),
        )
        .route("/{id}/deliveries", get(deliveries).route_layer(read()))
        .route(
            "/{id}/rotate-secret",
            post(rotate_secret).route_layer(update()),
        )
        .route("/{id}/test", post(send_test).route_layer(update()))
}

const STATUSES: &[&str] = &["active", "paused", "disabled"];
const CUSTOM_OBJECT_ACTIONS: [&str; 3] = ["created", "updated", "deleted"];
const UNKNOWN_EVENTS: &str = "One or more events are not in the entity-events catalog";
const HTTPS_ONLY: &str = "Webhook URL must use https://";
const TOO_MANY_HEADERS: &str = "A webhook may define at most 20 custom headers";

/// `/^co_[a-z][a-z0-9_]{0,23}\.(created|updated|deleted)$/`.
fn is_custom_object_event(event: &str) -> bool {
    let Some((key, action)) = event.split_once('.') else {
        return false;
    };
    let Some(slug) = key.strip_prefix("co_") else {
        return false;
    };
    let mut chars = slug.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && slug.len() <= 24
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && CUSTOM_OBJECT_ACTIONS.contains(&action)
}

/// `isKnownEvent`: in the static catalog (`listAllEvents()`), or shaped like a
/// WeldObjects event.
fn is_known_event(event: &str) -> bool {
    let known = event
        .split_once('.')
        .is_some_and(|(entity, action)| entity_events::is_known_action(entity, action));
    known || is_custom_object_event(event)
}

/// A custom object, as the event checks read it.
struct CustomObject {
    slug: String,
    entity_key: String,
    label_plural: String,
    enable_events: bool,
}

/// `listCustomObjects(db)`.
async fn custom_objects(db: &PgPool) -> Result<Vec<CustomObject>, DbErr> {
    let rows: Vec<(String, String, String, bool)> = custom_objects::Entity::find()
        .select_only()
        .columns([
            custom_objects::Column::Slug,
            custom_objects::Column::EntityKey,
            custom_objects::Column::LabelPlural,
            custom_objects::Column::EnableEvents,
        ])
        .filter(custom_objects::Column::DeletedAt.is_null())
        .order_by_asc(custom_objects::Column::SortOrder)
        .order_by_asc(custom_objects::Column::LabelPlural)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(slug, entity_key, label_plural, enable_events)| CustomObject {
                slug,
                entity_key,
                label_plural,
                enable_events,
            },
        )
        .collect())
}

/// `unknownCustomObjectEvents`: the WeldObjects events whose object is
/// missing or has events switched off.
async fn unknown_custom_object_events(
    db: &PgPool,
    events: &[String],
) -> Result<Vec<String>, DbErr> {
    let custom: Vec<&String> = events
        .iter()
        .filter(|e| is_custom_object_event(e))
        .collect();
    if custom.is_empty() {
        return Ok(Vec::new());
    }
    let objects = custom_objects(db).await?;
    Ok(custom
        .into_iter()
        .filter(|event| {
            let key = event.split_once('.').map_or(event.as_str(), |(key, _)| key);
            !objects
                .iter()
                .any(|o| o.enable_events && o.entity_key == key)
        })
        .cloned()
        .collect())
}

fn unknown_events_refusal(unknown: &[String]) -> Refusal {
    Refusal::bad_request(format!(
        "Unknown custom object event(s): {}. The object may not exist, or may have workflow events switched off.",
        unknown.join(", ")
    ))
}

/// `toPublic(row)`: the row without its secret.
fn public(row: external_webhooks::Model) -> Result<Value, DbErr> {
    let mut row = serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string()))?;
    if let Value::Object(map) = &mut row {
        map.remove("secret");
    }
    Ok(row)
}

/// `new Date()` as the `timestamptz` columns store it (milliseconds).
fn stamp() -> OffsetDateTime {
    utc_now().assume_utc()
}

/// `generateWebhookSecret()`: `whsec_` and 32 random bytes in hex.
fn webhook_secret() -> String {
    format!("whsec_{}", random_string(64, "0123456789abcdef"))
}

/// The row with its secret (`getExternalWebhookRow`).
async fn webhook_row(db: &PgPool, id: &str) -> Result<Option<external_webhooks::Model>, DbErr> {
    external_webhooks::Entity::find_by_id(id)
        .filter(external_webhooks::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await
}

/// The webhook as the delivery reads it (`WebhookRow::from_json`).
fn delivery_row(row: external_webhooks::Model) -> WebhookRow {
    WebhookRow {
        id: row.id,
        url: row.url,
        secret: row.secret,
        headers: row.headers.filter(|h| !h.is_null()),
        status: row.status,
        consecutive_failures: row.consecutive_failures,
        events: row
            .events
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

// ── GET /events ─────────────────────────────────────────────────────────────

fn event_entry(event: &str, label: Option<&str>) -> Value {
    let (entity, action) = event.split_once('.').unwrap_or((event, ""));
    let mut entry = json!({ "event": event, "entity": entity, "action": action });
    if let Some(label) = label.filter(|l| !l.is_empty()) {
        entry["label"] = json!(label);
    }
    entry
}

async fn events(caller: Caller) -> Response {
    let mut events: Vec<Value> = crate::catalog::webhook_events()
        .iter()
        .filter_map(Value::as_str)
        .map(|event| event_entry(event, None))
        .collect();
    match custom_objects(&caller.db).await {
        Ok(objects) => {
            for object in objects.iter().filter(|o| o.enable_events) {
                for action in CUSTOM_OBJECT_ACTIONS {
                    let event = format!("co_{}.{action}", object.slug);
                    events.push(event_entry(&event, Some(&object.label_plural)));
                }
            }
        }
        Err(error) => {
            tracing::error!(%error, "[app-api/external-webhooks] custom object event merge failed");
        }
    }
    Data(events).into_response()
}

// ── Lists ───────────────────────────────────────────────────────────────────

struct PageQuery {
    cursor: Option<String>,
    limit: Option<f64>,
    status: Option<String>,
}

fn page_query(issues: &mut Issues, fields: &Map<String, Value>, with_status: bool) -> PageQuery {
    let cursor = issues
        .text(fields, "cursor", Presence::Optional, None, None)
        .into_option();
    let limit = issues
        .number(
            fields,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                int: false,
                min: Some(1.0),
                max: Some(100.0),
            },
        )
        .into_option();
    let status = if with_status {
        issues
            .choice(fields, "status", Presence::Optional, STATUSES)
            .into_option()
    } else {
        None
    };
    PageQuery {
        cursor,
        limit,
        status,
    }
}

/// `Math.min(params.limit ?? 25, 100)`.
#[allow(clippy::cast_possible_truncation)]
fn limit_of(limit: Option<f64>) -> i64 {
    limit.unwrap_or(25.0).min(100.0) as i64
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list webhooks";
    let q = match validate_query(query.as_deref(), |issues, fields| {
        page_query(issues, fields, true)
    }) {
        Ok(q) => q,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let limit = limit_of(q.limit);
    let db = orm(&caller.db);
    let mut live =
        external_webhooks::Entity::find().filter(external_webhooks::Column::DeletedAt.is_null());
    if let Some(status) = &q.status {
        live = live.filter(external_webhooks::Column::Status.eq(status));
    }
    let mut rows = live.clone();
    if let Some(cursor) = &q.cursor {
        rows = rows.filter(external_webhooks::Column::Id.lt(cursor));
    }
    let rows = rows
        .order_by_desc(external_webhooks::Column::CreatedAt)
        .order_by_desc(external_webhooks::Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(&db)
        .await
        .and_then(|rows| rows.into_iter().map(public).collect::<Result<Vec<_>, _>>());
    let count = live.count(&db).await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(rows, limit);
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(count, has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, FAILED),
    }
}

async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    match webhook_row(&caller.db, &id).await {
        Ok(Some(row)) => match public(row) {
            Ok(row) => Data(row).into_response(),
            Err(error) => internal(&error, "Failed to fetch webhook"),
        },
        Ok(None) => ApiError::not_found("Webhook", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch webhook"),
    }
}

async fn deliveries(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to fetch webhook deliveries";
    let q = match validate_query(query.as_deref(), |issues, fields| {
        page_query(issues, fields, false)
    }) {
        Ok(q) => q,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result: Result<Response, DbErr> = async {
        if webhook_row(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Webhook", Some(&id)).into_response());
        }
        let limit = limit_of(q.limit);
        let db = orm(&caller.db);
        let of_webhook = webhook_deliveries::Entity::find()
            .filter(webhook_deliveries::Column::WebhookId.eq(&id));
        let mut rows = of_webhook.clone();
        if let Some(cursor) = &q.cursor {
            rows = rows.filter(webhook_deliveries::Column::Id.lt(cursor));
        }
        let rows = rows
            .order_by_desc(webhook_deliveries::Column::CreatedAt)
            .order_by_desc(webhook_deliveries::Column::Id)
            .limit(u64::try_from(limit + 1).unwrap_or(0))
            .all(&db)
            .await?
            .into_iter()
            .map(|row| serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string())))
            .collect::<Result<Vec<_>, _>>()?;
        let count = of_webhook.count(&db).await?;
        let (data, has_more) = page(rows, limit);
        let cursor = next_cursor(&data, has_more, "id");
        Ok(List::new(data, Pagination::new(count, has_more, cursor)).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, FAILED))
}

// ── Create and update ───────────────────────────────────────────────────────

/// The fields `createWebhookSchema` / `updateWebhookSchema` read.
#[derive(Default)]
struct WebhookBody {
    name: Option<String>,
    description: Option<String>,
    url: Option<String>,
    events: Option<Vec<String>>,
    headers: Option<Value>,
    status: Option<String>,
}

/// `createWebhookSchema` (every field but `description` and `headers`
/// required) or `updateWebhookSchema` (all optional, plus `status`).
fn webhook_body(issues: &mut Issues, fields: &Map<String, Value>, create: bool) -> WebhookBody {
    let required = if create {
        Presence::Required
    } else {
        Presence::Optional
    };
    let name = issues
        .text(fields, "name", required, Some(1), Some(255))
        .into_option();
    let description = issues
        .text(fields, "description", Presence::Optional, None, Some(2000))
        .into_option();
    // `.url().refine(startsWith https)`: the refinement runs whenever the
    // value is a string, even an invalid URL.
    let url_value = fields.get("url").and_then(Value::as_str).map(str::to_owned);
    let url = issues
        .text_with(
            fields,
            "url",
            required,
            Text {
                format: Some(Format::Url),
                ..Text::default()
            },
        )
        .into_option();
    // `z.array(z.string()).min(1, …).refine(every isKnownEvent)`: the
    // refinement runs when every item is a string (a short list only marks
    // the array dirty).
    let events = match issues.list_with(
        fields,
        "events",
        required,
        (Some(1), Some("Select at least one event")),
        None,
        |issues, item| issues.item_text(item, Text::default()),
    ) {
        Field::Set(events) => Some(events),
        _ => None,
    };
    let raw_events: Option<Vec<String>> = match fields.get("events") {
        Some(Value::Array(items)) if items.iter().all(Value::is_string) => Some(
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
        ),
        _ => None,
    };
    // `z.record(z.string().max(500)).refine(at most 20 keys)`.
    let headers_object = matches!(fields.get("headers"), Some(Value::Object(_)));
    let headers = issues
        .nested(fields, "headers", Presence::Optional, |issues, inner| {
            let mut out = Map::new();
            for key in inner.keys() {
                if let Some(value) = issues
                    .text(inner, key, Presence::Required, None, Some(500))
                    .into_option()
                {
                    out.insert(key.clone(), Value::String(value));
                }
            }
            Value::Object(out)
        })
        .into_option();
    let status = if create {
        None
    } else {
        issues
            .choice(fields, "status", Presence::Optional, STATUSES)
            .into_option()
    };
    // Refinements, after every synchronous check.
    if let Some(url) = &url_value
        && !url.starts_with("https://")
    {
        issues.custom("url", HTTPS_ONLY);
    }
    if let Some(events) = &raw_events
        && !events.iter().all(|e| is_known_event(e))
    {
        issues.custom("events", UNKNOWN_EVENTS);
    }
    if headers_object
        && let Some(Value::Object(map)) = fields.get("headers")
        && map.len() > 20
    {
        issues.custom("headers", TOO_MANY_HEADERS);
    }
    WebhookBody {
        name,
        description,
        url,
        events,
        headers,
        status,
    }
}

async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to create webhook";
    let input = match validate(&headers, &body, |issues, fields| {
        webhook_body(issues, fields, true)
    }) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result: Result<Response, Refusal> = async {
        let events = input.events.clone().unwrap_or_default();
        let unknown = unknown_custom_object_events(&caller.db, &events).await?;
        if !unknown.is_empty() {
            return Err(unknown_events_refusal(&unknown));
        }
        let id = generate_id("ewh");
        let secret = webhook_secret();
        let stamp = stamp();
        let row = external_webhooks::Entity::insert(external_webhooks::ActiveModel {
            id: Set(id),
            name: Set(input.name.clone().unwrap_or_default()),
            description: Set(input.description.clone()),
            url: Set(input.url.clone().unwrap_or_default()),
            events: Set(json!(events)),
            secret: Set(secret.clone()),
            headers: Set(input.headers.clone()),
            status: Set("active".to_owned()),
            created_by: Set(caller.user_id.clone()),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        })
        .exec_with_returning(&orm(&caller.db))
        .await?;
        let mut webhook = public(row)?;
        webhook["secret"] = json!(secret);
        Ok(Created(webhook).into_response())
    }
    .await;
    result.unwrap_or_else(|refusal| refusal.respond(FAILED))
}

async fn update_one(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update webhook";
    let input = match validate(&headers, &body, |issues, fields| {
        webhook_body(issues, fields, false)
    }) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result: Result<Response, Refusal> = async {
        if let Some(events) = &input.events {
            let unknown = unknown_custom_object_events(&caller.db, events).await?;
            if !unknown.is_empty() {
                return Err(unknown_events_refusal(&unknown));
            }
        }
        if webhook_row(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found("Webhook", &id));
        }
        let mut update = external_webhooks::Entity::update_many()
            .col_expr(external_webhooks::Column::UpdatedAt, Expr::value(stamp()));
        if let Some(name) = &input.name {
            update = update.col_expr(external_webhooks::Column::Name, Expr::value(name));
        }
        if let Some(description) = &input.description {
            update = update.col_expr(
                external_webhooks::Column::Description,
                Expr::value(description),
            );
        }
        if let Some(url) = &input.url {
            update = update.col_expr(external_webhooks::Column::Url, Expr::value(url));
        }
        if let Some(events) = &input.events {
            update = update.col_expr(
                external_webhooks::Column::Events,
                Expr::value(json!(events)),
            );
        }
        if let Some(headers) = &input.headers {
            update = update.col_expr(
                external_webhooks::Column::Headers,
                Expr::value(headers.clone()),
            );
        }
        if let Some(status) = &input.status {
            update = update.col_expr(external_webhooks::Column::Status, Expr::value(status));
        }
        let row = update
            .filter(external_webhooks::Column::Id.eq(&id))
            .exec_with_returning(&orm(&caller.db))
            .await?
            .into_iter()
            .next();
        Ok(match row {
            Some(row) => Data(public(row)?).into_response(),
            None => Data(Value::Null).into_response(),
        })
    }
    .await;
    result.unwrap_or_else(|refusal| refusal.respond(FAILED))
}

async fn rotate_secret(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to rotate webhook secret";
    let result: Result<Response, DbErr> = async {
        if webhook_row(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Webhook", Some(&id)).into_response());
        }
        let secret = webhook_secret();
        let row = external_webhooks::Entity::update_many()
            .col_expr(external_webhooks::Column::Secret, Expr::value(&secret))
            .col_expr(external_webhooks::Column::UpdatedAt, Expr::value(stamp()))
            .filter(external_webhooks::Column::Id.eq(&id))
            .exec_with_returning(&orm(&caller.db))
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| DbErr::RecordNotFound("no rows returned by a query".to_owned()))?;
        let mut webhook = public(row)?;
        webhook["secret"] = json!(secret);
        Ok(Data(webhook).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, FAILED))
}

async fn delete_one(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Result<Response, DbErr> = async {
        if webhook_row(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Webhook", Some(&id)).into_response());
        }
        let stamp = stamp();
        external_webhooks::Entity::update_many()
            .col_expr(external_webhooks::Column::DeletedAt, Expr::value(stamp))
            .col_expr(external_webhooks::Column::UpdatedAt, Expr::value(stamp))
            .filter(external_webhooks::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete webhook"))
}

// ── POST /:id/test ──────────────────────────────────────────────────────────

async fn send_test(
    State(state): State<ConnectState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to send test webhook";
    // The Clerk org id: stamped into the payload like every entity event's
    // `workspaceId`.
    let clerk_org_id = caller.clerk_org_id.clone();
    let result: Result<Response, DbErr> = async {
        let Some(row) = webhook_row(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Webhook", Some(&id)).into_response());
        };
        let webhook = delivery_row(row);
        let event_id = generate_id("evt");
        let data_json = format!(
            "{{\"message\":\"This is a test event from WeldSuite.\",\"webhookId\":{}}}",
            Value::String(webhook.id.clone())
        );
        let attempts = caller.overrides.webhook_attempts(&state);
        let outcome = weldsuite_subscribers::deliver_webhook_event_with(
            &caller.db,
            attempts.as_ref(),
            DeliverInput {
                webhook: &webhook,
                event_id: &event_id,
                event_type: "webhook.test",
                workspace_id: &clerk_org_id,
                data_json: &data_json,
            },
        )
        .await?;
        if !outcome.delivered
            && !clerk_org_id.is_empty()
            && let Some(master) = caller.overrides.master(&state)
        {
            // `scheduleWebhookRetryIndex`: the retry sweep looks at this
            // workspace now (Global: the D1 tenant work index).
            weldsuite_db::due_index::mark_due(
                &master,
                WEBHOOK_RETRY_KIND,
                &caller.workspace_id,
                time::OffsetDateTime::now_utc(),
            )
            .await;
        }
        Ok(Data(json!({
            "delivered": outcome.delivered,
            "responseStatus": outcome.response_status,
            "responseBody": outcome.response_body,
            "errorMessage": outcome.error_message,
        }))
        .into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, FAILED))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_object_event_shape() {
        assert!(is_custom_object_event("co_machine.created"));
        assert!(is_custom_object_event("co_m2_x.deleted"));
        assert!(!is_custom_object_event("co_2m.created"));
        assert!(!is_custom_object_event("co_machine.archived"));
        assert!(!is_custom_object_event("machine.created"));
        assert!(!is_custom_object_event(&format!(
            "co_{}.created",
            "a".repeat(25)
        )));
    }

    #[test]
    fn known_events() {
        assert!(is_known_event("company.created"));
        assert!(is_known_event("customer.created"));
        assert!(is_known_event("co_machine.updated"));
        assert!(!is_known_event("nope.created"));
    }

    #[test]
    fn secrets_are_hex() {
        let secret = webhook_secret();
        assert_eq!(secret.len(), 6 + 64);
        assert!(secret[6..].chars().all(|c| c.is_ascii_hexdigit()));
    }
}
