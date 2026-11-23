//! `/api/dns-zones` (`routes/dns-zones`, `services/dns-zones.ts`).
//! Permissions `dns:read|create|update|delete`; events `dns_zone:*`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::{ActiveEnum, ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{DNS_ZONE_CREATED, DNS_ZONE_DELETED, DNS_ZONE_UPDATED};
use weldsuite_db::{orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::dns_zones;
use weldsuite_schema::tenant::enums::{HostDnsProvider, HostDnsZoneStatus};

use crate::listing::list;
use crate::rows::{live_zone, live_zone_of_domain, timestamp_of};
use crate::weldreach::{changes_zone_routing, domain_in_use, is_domain_used};
use crate::{Caller, HostState, internal, validate, validate_query};

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
    let page = async {
        let status = status
            .filter(|v| !v.is_empty())
            .map(|status| HostDnsZoneStatus::try_from_value(&status))
            .transpose()?;
        let conditions = vec![
            Some(Condition::all().add(dns_zones::Column::DeletedAt.is_null())),
            domain_id
                .filter(|v| !v.is_empty())
                .map(|id| Condition::all().add(dns_zones::Column::DomainId.eq(id))),
            status.map(|status| Condition::all().add(dns_zones::Column::Status.eq(status))),
        ];
        list::<dns_zones::Entity>(
            &caller.db,
            (dns_zones::Column::CreatedAt, dns_zones::Column::Id),
            conditions,
            cursor.as_deref().filter(|c| !c.is_empty()),
            limit,
        )
        .await
    }
    .await;
    match page {
        Ok(page) => List::new(
            page.rows,
            Pagination::new(page.total, page.has_more, page.cursor),
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

/// A validated `status` as the column's enum.
fn zone_status(status: &str) -> Result<HostDnsZoneStatus, DbErr> {
    HostDnsZoneStatus::try_from_value(&status.to_owned())
}

/// A validated `provider` as the column's enum.
fn zone_provider(provider: &str) -> Result<HostDnsProvider, DbErr> {
    HostDnsProvider::try_from_value(&provider.to_owned())
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
    let inserted = async {
        let zone = dns_zones::ActiveModel {
            id: Set(id.clone()),
            domain_id: Set(text("domainId").unwrap_or_default()),
            name: Set(text("name").unwrap_or_default()),
            status: Set(zone_status(&text("status").unwrap_or_default())?),
            provider: Set(zone_provider(&text("provider").unwrap_or_default())?),
            external_zone_id: Set(text("externalZoneId")),
            external_nameservers: Set(input.get("externalNameservers").cloned()),
            default_ttl: Set(input
                .get("defaultTtl")
                .and_then(Value::as_i64)
                .and_then(|t| i32::try_from(t).ok())),
            ..Default::default()
        };
        dns_zones::Entity::insert(zone)
            .exec_without_returning(&orm(&caller.db))
            .await
    }
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
    let result: Result<Response, DbErr> = async {
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
        let text = |key: &str| patch.get(key).and_then(Value::as_str).map(str::to_owned);
        let mut zone = dns_zones::ActiveModel::default();
        if patch.contains_key("name") {
            zone.name = Set(text("name").unwrap_or_default());
        }
        if patch.contains_key("status") {
            zone.status = Set(zone_status(&text("status").unwrap_or_default())?);
        }
        if patch.contains_key("provider") {
            zone.provider = Set(zone_provider(&text("provider").unwrap_or_default())?);
        }
        if patch.contains_key("externalZoneId") {
            zone.external_zone_id = Set(text("externalZoneId"));
        }
        if let Some(nameservers) = patch.get("externalNameservers") {
            zone.external_nameservers = Set(Some(nameservers.clone()));
        }
        if patch.contains_key("defaultTtl") {
            zone.default_ttl = Set(patch
                .get("defaultTtl")
                .and_then(Value::as_i64)
                .and_then(|t| i32::try_from(t).ok()));
        }
        if patch.contains_key("syncedAt") {
            zone.synced_at = Set(text("syncedAt")
                .and_then(|s| weldsuite_kit::validation::js_date_iso(&s))
                .map(|iso| timestamp_of(&iso))
                .transpose()?);
        }
        zone.updated_at = Set(utc_now());
        dns_zones::Entity::update_many()
            .set(zone)
            .filter(dns_zones::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
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
    let result: Result<Response, DbErr> = async {
        let zone = live_zone(&caller.db, &id).await?;
        if let Some(zone) = &zone
            && is_domain_used(&caller.db, zone["domainId"].as_str().unwrap_or_default()).await?
        {
            return Ok(domain_in_use());
        }
        let Some(existing) = live_zone(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("DNS zone", Some(&id)).into_response());
        };
        let at = utc_now();
        dns_zones::Entity::update_many()
            .set(dns_zones::ActiveModel {
                deleted_at: Set(Some(at)),
                updated_at: Set(at),
                ..Default::default()
            })
            .filter(dns_zones::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
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
