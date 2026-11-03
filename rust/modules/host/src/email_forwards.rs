//! `/api/email-forwards` (`routes/email-forwards`,
//! `services/email-forwards.ts`): stored forwarding rules. Permissions
//! `email:read|create|update|delete`; events `email_forward:*`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EMAIL_FORWARD_CREATED, EMAIL_FORWARD_DELETED, EMAIL_FORWARD_UPDATED,
};
use weldsuite_kit::validation::{Field, Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::dns_zones::limit_param;
use crate::listing::{ListSql, keyset, list};
use crate::rows::one;
use crate::{Caller, HostState, internal, now, validate, validate_query};

const STATUSES: [&str; 4] = ["active", "pending", "disabled", "error"];

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HostState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list_forwards).route_layer(need("email:read")))
        .route("/", post(create).route_layer(need("email:create")))
        .route("/{id}", get(detail).route_layer(need("email:read")))
        .route("/{id}", patch(update).route_layer(need("email:update")))
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("email:delete")),
        )
}

const LIST: ListSql = ListSql {
    cursor: "select to_jsonb(t.created_at)#>>'{}', t.id from email_forwards t where t.id = $1 limit 1",
    page: concat!(
        "select to_jsonb(t) from email_forwards t where ($1::boolean or t.deleted_at is null)",
        " and ($2::boolean or t.domain_id = $3)",
        " and ($4::boolean or t.enabled = $5::boolean)",
        " and ($6::boolean or t.status = $7::host_email_forward_status)",
        " and ",
        keyset!(8, 9, 10),
        " order by t.created_at desc, t.id desc limit $11"
    ),
    count: concat!(
        "select count(*)::int from email_forwards t where ($1::boolean or t.deleted_at is null)",
        " and ($2::boolean or t.domain_id = $3)",
        " and ($4::boolean or t.enabled = $5::boolean)",
        " and ($6::boolean or t.status = $7::host_email_forward_status)",
        " and ",
        keyset!(8, 9, 10)
    ),
    live: true,
};

const LIVE: &str =
    "select to_jsonb(t) from email_forwards t where t.id = $1 and t.deleted_at is null limit 1";

async fn list_forwards(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), |issues, q| {
        let domain_id = issues
            .text(q, "domainId", Presence::Optional, None, None)
            .into_option();
        // `z.coerce.boolean()`: `Boolean(value)`.
        let enabled = q.get("enabled").map(|value| match value {
            Value::String(text) => !text.is_empty(),
            _ => true,
        });
        let status = issues
            .choice(q, "status", Presence::Optional, &STATUSES)
            .into_option();
        let cursor = issues
            .text(q, "cursor", Presence::Optional, None, None)
            .into_option();
        let limit = limit_param(issues, q, 100.0);
        (domain_id, enabled, status, cursor, limit)
    }) {
        Ok(query) => query,
        Err(response) => return *response,
    };
    let (domain_id, enabled, status, cursor, limit) = query;
    let filters = [
        domain_id.filter(|v| !v.is_empty()),
        enabled.map(|flag| flag.to_string()),
        status.filter(|v| !v.is_empty()),
    ];
    match list(
        &caller.db,
        &LIST,
        &filters,
        cursor.as_deref().filter(|c| !c.is_empty()),
        limit.unwrap_or(25).min(100),
    )
    .await
    {
        Ok(page) => List::new(
            page.rows,
            Pagination::new(
                u64::try_from(page.total).unwrap_or(0),
                page.has_more,
                page.cursor,
            ),
        )
        .into_response(),
        Err(error) => internal(&error, "Failed to list email forwards"),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match one(&caller.db, LIVE, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Email forward", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch email forward"),
    }
}

/// `createEmailForwardSchema` (`partial`: its `.omit({ domainId }).partial()`).
fn forward_fields(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let mut out = Map::new();
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    if !partial
        && let Field::Set(domain_id) =
            issues.text(body, "domainId", Presence::Required, Some(1), None)
    {
        out.insert("domainId".to_owned(), json!(domain_id));
    }
    if let Field::Set(source) = issues.text(body, "source", required, Some(1), Some(255)) {
        out.insert("source".to_owned(), json!(source));
    }
    let email = Text {
        format: Some(Format::Email),
        ..Text::default()
    };
    if let Field::Set(destination) = issues.text_with(
        body,
        "destination",
        required,
        Text {
            max: Some(500),
            ..email
        },
    ) {
        out.insert("destination".to_owned(), json!(destination));
    }
    if let Field::Set(extra) = issues.list(
        body,
        "additionalDestinations",
        Presence::Optional,
        None,
        None,
        |issues, item| issues.item_text(item, email),
    ) {
        out.insert("additionalDestinations".to_owned(), json!(extra));
    }
    for (key, default) in [("enabled", true), ("catchAll", false), ("wildcard", false)] {
        match issues.boolean(body, key, Presence::Optional) {
            Field::Set(flag) => {
                out.insert(key.to_owned(), json!(flag));
            }
            _ if !partial => {
                out.insert(key.to_owned(), json!(default));
            }
            _ => {}
        }
    }
    match issues.choice(body, "status", Presence::Optional, &STATUSES) {
        Field::Set(status) => {
            out.insert("status".to_owned(), json!(status));
        }
        _ if !partial => {
            out.insert("status".to_owned(), json!("active"));
        }
        _ => {}
    }
    out
}

fn event_data(id: &str, row: &Value) -> Value {
    json!({
        "id": id,
        "domainId": row["domainId"],
        "source": row["source"],
        "destination": row["destination"],
        "enabled": row["enabled"],
        "status": row["status"],
    })
}

async fn create(
    State(state): State<HostState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, body| {
        forward_fields(issues, body, false)
    }) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let id = generate_id("efwd");
    let text = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
    let flag = |key: &str| input.get(key).and_then(Value::as_bool);
    let result: Result<Response, sqlx::Error> = async {
        sqlx::query(
            "insert into email_forwards (id, domain_id, source, destination, additional_destinations,
               enabled, catch_all, wildcard, status)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9::host_email_forward_status)",
        )
        .bind(&id)
        .bind(text("domainId"))
        .bind(text("source"))
        .bind(text("destination"))
        .bind(input.get("additionalDestinations").cloned())
        .bind(flag("enabled"))
        .bind(flag("catchAll"))
        .bind(flag("wildcard"))
        .bind(text("status"))
        .execute(&caller.db)
        .await?;
        let row = one(&caller.db, "select to_jsonb(t) from email_forwards t where t.id = $1 limit 1", &id)
            .await?
            .unwrap_or(Value::Null);
        caller.publish(&state, EMAIL_FORWARD_CREATED, &id, &event_data(&id, &row));
        Ok(Created(row).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to create email forward"))
}

async fn update(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let patch = match validate(&headers, &body, |issues, body| {
        forward_fields(issues, body, true)
    }) {
        Ok(patch) => patch,
        Err(response) => return *response,
    };
    let result: Result<Response, sqlx::Error> = async {
        if one(&caller.db, LIVE, &id).await?.is_none() {
            return Ok(ApiError::not_found("Email forward", Some(&id)).into_response());
        }
        let set = |key: &str| patch.contains_key(key);
        let text = |key: &str| patch.get(key).and_then(Value::as_str).map(str::to_owned);
        let flag = |key: &str| patch.get(key).and_then(Value::as_bool);
        sqlx::query(
            "update email_forwards set
               source = case when $2 then $3 else source end,
               destination = case when $4 then $5 else destination end,
               additional_destinations = case when $6 then $7 else additional_destinations end,
               enabled = case when $8 then $9 else enabled end,
               catch_all = case when $10 then $11 else catch_all end,
               wildcard = case when $12 then $13 else wildcard end,
               status = case when $14 then $15::host_email_forward_status else status end,
               updated_at = $16::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(set("source"))
        .bind(text("source"))
        .bind(set("destination"))
        .bind(text("destination"))
        .bind(set("additionalDestinations"))
        .bind(patch.get("additionalDestinations").cloned())
        .bind(set("enabled"))
        .bind(flag("enabled"))
        .bind(set("catchAll"))
        .bind(flag("catchAll"))
        .bind(set("wildcard"))
        .bind(flag("wildcard"))
        .bind(set("status"))
        .bind(text("status"))
        .bind(now())
        .execute(&caller.db)
        .await?;
        let row = one(
            &caller.db,
            "select to_jsonb(t) from email_forwards t where t.id = $1 limit 1",
            &id,
        )
        .await?
        .unwrap_or(Value::Null);
        caller.publish(&state, EMAIL_FORWARD_UPDATED, &id, &event_data(&id, &row));
        Ok(Data(row).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to update email forward"))
}

async fn remove(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        let Some(existing) = one(&caller.db, LIVE, &id).await? else {
            return Ok(ApiError::not_found("Email forward", Some(&id)).into_response());
        };
        sqlx::query(
            "update email_forwards set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
        caller.publish(&state, EMAIL_FORWARD_DELETED, &id, &event_data(&id, &existing));
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete email forward"))
}
