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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};
use weldsuite_kit::{
    ApiError, Created, Data, List, NoContent, Pagination, generate_id, random_string,
};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_subscribers::{DeliverInput, WEBHOOK_RETRY_KIND, WebhookRow};

use crate::js::{next_cursor, page, total};
use crate::{Caller, ConnectState, Refusal, internal, now, validate, validate_query};

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
async fn custom_objects(db: &PgPool) -> Result<Vec<CustomObject>, sqlx::Error> {
    let rows: Vec<(String, String, String, bool)> = sqlx::query_as(
        "select slug, entity_key, label_plural, enable_events from custom_objects
         where deleted_at is null order by sort_order asc, label_plural asc",
    )
    .fetch_all(db)
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
) -> Result<Vec<String>, sqlx::Error> {
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
fn public(row: Value) -> Value {
    let mut row = js_row(row);
    if let Value::Object(map) = &mut row {
        map.remove("secret");
    }
    row
}

/// `generateWebhookSecret()`: `whsec_` and 32 random bytes in hex.
fn webhook_secret() -> String {
    format!("whsec_{}", random_string(64, "0123456789abcdef"))
}

/// The row with its secret (`getExternalWebhookRow`), as `to_jsonb` reads it.
async fn webhook_row(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "select to_jsonb(t) from external_webhooks t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await
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
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) from external_webhooks t
         where t.deleted_at is null and ($1::text is null or t.status = $1)
           and ($2::text is null or t.id < $2)
         order by t.created_at desc, t.id desc limit $3",
    )
    .bind(&q.status)
    .bind(&q.cursor)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await;
    let count: Result<i64, sqlx::Error> = sqlx::query_scalar(
        "select count(*)::int8 from external_webhooks t
         where t.deleted_at is null and ($1::text is null or t.status = $1)",
    )
    .bind(&q.status)
    .fetch_one(&caller.db)
    .await;
    match (rows, count) {
        (Ok(rows), Ok(count)) => {
            let (data, has_more) = page(rows.into_iter().map(public).collect(), limit);
            let cursor = next_cursor(&data, has_more, "id");
            List::new(data, Pagination::new(total(count), has_more, cursor)).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, FAILED),
    }
}

async fn get_one(caller: Caller, Path(id): Path<String>) -> Response {
    match webhook_row(&caller.db, &id).await {
        Ok(Some(row)) => Data(public(row)).into_response(),
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
    let result: Result<Response, sqlx::Error> = async {
        if webhook_row(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Webhook", Some(&id)).into_response());
        }
        let limit = limit_of(q.limit);
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(d) from webhook_deliveries d
             where d.webhook_id = $1 and ($2::text is null or d.id < $2)
             order by d.created_at desc, d.id desc limit $3",
        )
        .bind(&id)
        .bind(&q.cursor)
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await?;
        let count: i64 = sqlx::query_scalar(
            "select count(*)::int8 from webhook_deliveries d where d.webhook_id = $1",
        )
        .bind(&id)
        .fetch_one(&caller.db)
        .await?;
        let (data, has_more) = page(rows.into_iter().map(js_row).collect(), limit);
        let cursor = next_cursor(&data, has_more, "id");
        Ok(List::new(data, Pagination::new(total(count), has_more, cursor)).into_response())
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
        let stamp = now();
        let row: Value = sqlx::query_scalar(
            "insert into external_webhooks as t
                (id, name, description, url, events, secret, headers, status, created_by,
                 created_at, updated_at)
             values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, 'active', $8,
                     $9::timestamptz, $9::timestamptz)
             returning to_jsonb(t)",
        )
        .bind(&id)
        .bind(input.name.as_deref().unwrap_or_default())
        .bind(&input.description)
        .bind(input.url.as_deref().unwrap_or_default())
        .bind(json!(events))
        .bind(&secret)
        .bind(&input.headers)
        .bind(&caller.user_id)
        .bind(&stamp)
        .fetch_one(&caller.db)
        .await?;
        let mut webhook = public(row);
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
        let row: Option<Value> = sqlx::query_scalar(
            "update external_webhooks as t set
                 updated_at = $2::timestamptz,
                 name = case when $3::text is null then t.name else $3 end,
                 description = case when $4::text is null then t.description else $4 end,
                 url = case when $5::text is null then t.url else $5 end,
                 events = case when $6::jsonb is null then t.events else $6 end,
                 headers = case when $7::jsonb is null then t.headers else $7 end,
                 status = case when $8::text is null then t.status else $8 end
             where t.id = $1 returning to_jsonb(t)",
        )
        .bind(&id)
        .bind(now())
        .bind(&input.name)
        .bind(&input.description)
        .bind(&input.url)
        .bind(input.events.as_ref().map(|events| json!(events)))
        .bind(&input.headers)
        .bind(&input.status)
        .fetch_optional(&caller.db)
        .await?;
        Ok(match row {
            Some(row) => Data(public(row)).into_response(),
            None => Data(Value::Null).into_response(),
        })
    }
    .await;
    result.unwrap_or_else(|refusal| refusal.respond(FAILED))
}

async fn rotate_secret(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to rotate webhook secret";
    let result: Result<Response, sqlx::Error> = async {
        if webhook_row(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Webhook", Some(&id)).into_response());
        }
        let secret = webhook_secret();
        let row: Value = sqlx::query_scalar(
            "update external_webhooks as t set secret = $2, updated_at = $3::timestamptz
             where t.id = $1 returning to_jsonb(t)",
        )
        .bind(&id)
        .bind(&secret)
        .bind(now())
        .fetch_one(&caller.db)
        .await?;
        let mut webhook = public(row);
        webhook["secret"] = json!(secret);
        Ok(Data(webhook).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, FAILED))
}

async fn delete_one(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        if webhook_row(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Webhook", Some(&id)).into_response());
        }
        let stamp = now();
        sqlx::query(
            "update external_webhooks set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
             where id = $1",
        )
        .bind(&id)
        .bind(&stamp)
        .execute(&caller.db)
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
    let result: Result<Response, sqlx::Error> = async {
        let Some(row) = webhook_row(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Webhook", Some(&id)).into_response());
        };
        let webhook = WebhookRow::from_json(&row);
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
