//! `/api/dns-zones` (`routes/dns-zones`, `services/dns-zones.ts`).
//! Permissions `dns:read|create|update|delete`; events `dns_zone:*`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{DNS_ZONE_CREATED, DNS_ZONE_DELETED, DNS_ZONE_UPDATED};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::listing::{ListSql, keyset, list};
use crate::rows::{live_zone, live_zone_of_domain};
use crate::weldreach::{changes_zone_routing, domain_in_use, is_domain_used};
use crate::{Caller, HostState, internal, now, validate, validate_query};

const STATUSES: [&str; 4] = ["active", "pending", "disabled", "error"];
const PROVIDERS: [&str; 4] = ["hetzner", "cloudflare", "route53", "custom"];

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HostState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list_zones).route_layer(need("dns:read")))
        .route("/", post(create).route_layer(need("dns:create")))
        .route(
            "/by-domain/{domainId}",
            get(by_domain).route_layer(need("dns:read")),
        )
        .route("/{id}", get(detail).route_layer(need("dns:read")))
        .route("/{id}", patch(update).route_layer(need("dns:update")))
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("dns:delete")),
        )
}

const LIST: ListSql = ListSql {
    cursor: "select to_jsonb(t.created_at)#>>'{}', t.id from dns_zones t where t.id = $1 limit 1",
    page: concat!(
        "select to_jsonb(t) from dns_zones t where ($1::boolean or t.deleted_at is null)",
        " and ($2::boolean or t.domain_id = $3)",
        " and ($4::boolean or t.status = $5::host_dns_zone_status)",
        " and ",
        keyset!(6, 7, 8),
        " order by t.created_at desc, t.id desc limit $9"
    ),
    count: concat!(
        "select count(*)::int from dns_zones t where ($1::boolean or t.deleted_at is null)",
        " and ($2::boolean or t.domain_id = $3)",
        " and ($4::boolean or t.status = $5::host_dns_zone_status)",
        " and ",
        keyset!(6, 7, 8)
    ),
    live: true,
};

/// `limit: z.coerce.number().int().min(lo).max(hi).optional()`.
pub(crate) fn limit_param(
    issues: &mut Issues,
    query: &Map<String, Value>,
    max: f64,
) -> Option<i64> {
    issues
        .whole_number(
            query,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                int: true,
                min: Some(1.0),
                max: Some(max),
            },
        )
        .into_option()
}

async fn list_zones(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), |issues, q| {
        let domain_id = issues
            .text(q, "domainId", Presence::Optional, None, None)
            .into_option();
        let status = issues
            .choice(q, "status", Presence::Optional, &STATUSES)
            .into_option();
        let cursor = issues
            .text(q, "cursor", Presence::Optional, None, None)
            .into_option();
        let limit = limit_param(issues, q, 100.0);
        (domain_id, status, cursor, limit)
    }) {
        Ok(query) => query,
        Err(response) => return *response,
    };
    let (domain_id, status, cursor, limit) = query;
    let limit = limit.unwrap_or(25).min(100);
    let filters = [
        domain_id.filter(|v| !v.is_empty()),
        status.filter(|v| !v.is_empty()),
    ];
    match list(
        &caller.db,
        &LIST,
        &filters,
        cursor.as_deref().filter(|c| !c.is_empty()),
        limit,
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
        Err(error) => internal(&error, "Failed to list DNS zones"),
    }
}

async fn by_domain(caller: Caller, Path(domain_id): Path<String>) -> Response {
    match live_zone_of_domain(&caller.db, &domain_id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("DNS zone for domain", Some(&domain_id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch DNS zone"),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match live_zone(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("DNS zone", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch DNS zone"),
    }
}

/// The zone fields of `createDnsZoneSchema` (`partial` for the update's
/// `.partial()`, which also drops the defaults).
fn zone_fields(
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
    if let Field::Set(name) = issues.text(body, "name", required, Some(1), Some(255)) {
        out.insert("name".to_owned(), json!(name));
    }
    match issues.choice(body, "status", Presence::Optional, &STATUSES) {
        Field::Set(status) => {
            out.insert("status".to_owned(), json!(status));
        }
        _ if !partial => {
            out.insert("status".to_owned(), json!("pending"));
        }
        _ => {}
    }
    match issues.choice(body, "provider", Presence::Optional, &PROVIDERS) {
        Field::Set(provider) => {
            out.insert("provider".to_owned(), json!(provider));
        }
        _ if !partial => {
            out.insert("provider".to_owned(), json!("hetzner"));
        }
        _ => {}
    }
    match issues.text(body, "externalZoneId", Presence::Nullish, None, Some(255)) {
        Field::Set(id) => {
            out.insert("externalZoneId".to_owned(), json!(id));
        }
        Field::Null => {
            out.insert("externalZoneId".to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
    if let Field::Set(nameservers) = issues.list(
        body,
        "externalNameservers",
        Presence::Optional,
        None,
        None,
        |issues, item| issues.item_text(item, Text::default()),
    ) {
        out.insert("externalNameservers".to_owned(), json!(nameservers));
    }
    match issues.whole_number(
        body,
        "defaultTtl",
        Presence::Optional,
        Number {
            coerce: false,
            int: true,
            min: Some(60.0),
            max: Some(86_400.0),
        },
    ) {
        Field::Set(ttl) => {
            out.insert("defaultTtl".to_owned(), json!(ttl));
        }
        _ if !partial => {
            out.insert("defaultTtl".to_owned(), json!(3600));
        }
        _ => {}
    }
    if partial {
        let synced = issues.text_with(
            body,
            "syncedAt",
            Presence::Optional,
            Text {
                format: Some(weldsuite_kit::validation::Format::Datetime),
                ..Text::default()
            },
        );
        if let Field::Set(synced) = synced {
            out.insert("syncedAt".to_owned(), json!(synced));
        }
    }
    out
}

fn event_data(row: &Value) -> Value {
    json!({ "id": row["id"], "name": row["name"], "status": row["status"] })
}

async fn create(
    State(state): State<HostState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, body| {
        zone_fields(issues, body, false)
    }) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let id = generate_id("zone");
    let text = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
    let inserted = sqlx::query(
        "insert into dns_zones (id, domain_id, name, status, provider, external_zone_id,
           external_nameservers, default_ttl)
         values ($1, $2, $3, $4::host_dns_zone_status, $5::host_dns_provider, $6, $7, $8)",
    )
    .bind(&id)
    .bind(text("domainId"))
    .bind(text("name"))
    .bind(text("status"))
    .bind(text("provider"))
    .bind(text("externalZoneId"))
    .bind(input.get("externalNameservers").cloned())
    .bind(
        input
            .get("defaultTtl")
            .and_then(Value::as_i64)
            .and_then(|t| i32::try_from(t).ok()),
    )
    .execute(&caller.db)
    .await;
    if let Err(error) = inserted {
        return internal(&error, "Failed to create DNS zone");
    }
    match live_zone(&caller.db, &id).await {
        Ok(Some(row)) => {
            caller.publish(&state, DNS_ZONE_CREATED, &id, &event_data(&row));
            Created(row).into_response()
        }
        Ok(None) => internal(&"the new zone is gone", "Failed to create DNS zone"),
        Err(error) => internal(&error, "Failed to create DNS zone"),
    }
}

async fn update(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let patch = match validate(&headers, &body, |issues, body| {
        zone_fields(issues, body, true)
    }) {
        Ok(patch) => patch,
        Err(response) => return *response,
    };
    let result: Result<Response, sqlx::Error> = async {
        let zone = live_zone(&caller.db, &id).await?;
        if let Some(zone) = &zone {
            let domain_id = zone["domainId"].as_str().unwrap_or_default();
            if changes_zone_routing(zone, &patch) && is_domain_used(&caller.db, domain_id).await? {
                return Ok(domain_in_use());
            }
        }
        if live_zone(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("DNS zone", Some(&id)).into_response());
        }
        let set = |key: &str| patch.contains_key(key);
        let text = |key: &str| patch.get(key).and_then(Value::as_str).map(str::to_owned);
        let synced = text("syncedAt").and_then(|s| weldsuite_kit::validation::js_date_iso(&s));
        sqlx::query(
            "update dns_zones set
               name = case when $2 then $3 else name end,
               status = case when $4 then $5::host_dns_zone_status else status end,
               provider = case when $6 then $7::host_dns_provider else provider end,
               external_zone_id = case when $8 then $9 else external_zone_id end,
               external_nameservers = case when $10 then $11 else external_nameservers end,
               default_ttl = case when $12 then $13 else default_ttl end,
               synced_at = case when $14 then $15::timestamp else synced_at end,
               updated_at = $16::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(set("name"))
        .bind(text("name"))
        .bind(set("status"))
        .bind(text("status"))
        .bind(set("provider"))
        .bind(text("provider"))
        .bind(set("externalZoneId"))
        .bind(text("externalZoneId"))
        .bind(set("externalNameservers"))
        .bind(patch.get("externalNameservers").cloned())
        .bind(set("defaultTtl"))
        .bind(
            patch
                .get("defaultTtl")
                .and_then(Value::as_i64)
                .and_then(|t| i32::try_from(t).ok()),
        )
        .bind(set("syncedAt"))
        .bind(synced)
        .bind(now())
        .execute(&caller.db)
        .await?;
        let row = crate::rows::any_zone(&caller.db, &id)
            .await?
            .unwrap_or(Value::Null);
        caller.publish(&state, DNS_ZONE_UPDATED, &id, &event_data(&row));
        Ok(Data(row).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to update DNS zone"))
}

async fn remove(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        let zone = live_zone(&caller.db, &id).await?;
        if let Some(zone) = &zone
            && is_domain_used(&caller.db, zone["domainId"].as_str().unwrap_or_default()).await?
        {
            return Ok(domain_in_use());
        }
        let Some(existing) = live_zone(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("DNS zone", Some(&id)).into_response());
        };
        let at = now();
        sqlx::query(
            "update dns_zones set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&at)
        .execute(&caller.db)
        .await?;
        caller.publish(
            &state,
            DNS_ZONE_DELETED,
            &id,
            &json!({ "id": id, "name": existing["name"], "status": existing["status"] }),
        );
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete DNS zone"))
}
