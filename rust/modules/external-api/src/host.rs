//! WeldHost's objects: `/v1/domains` with its DNS zones and records
//! (`routes/v1/domains/index.ts`). The public API keeps zones and records
//! local: it writes the rows and never calls a DNS host (app-api does).

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    DNS_RECORD_CREATED, DNS_RECORD_DELETED, DNS_RECORD_UPDATED, DNS_ZONE_CREATED, DNS_ZONE_DELETED,
    DNS_ZONE_UPDATED, DOMAIN_CREATED, DOMAIN_DELETED, DOMAIN_UPDATED,
};
use weldsuite_kit::id::generate_id;

use crate::ExternalApiState;
use crate::crud::{
    Answer, Caller, created, dates, field, like, list_query, no_content, now, ok, soft_delete,
    table_list_sql, with_id, with_updated,
};
use crate::list::{ListQuery, clamp_limit, list_page_mapped};
use crate::schemas_gen::{
    CREATE_DNS_RECORD, CREATE_DNS_ZONE, CREATE_DOMAIN, LIST_DOMAINS, UPDATE_DNS_RECORD,
    UPDATE_DNS_ZONE, UPDATE_DOMAIN,
};
use crate::session::not_found;
use crate::simple::{coerce_dates, scoped};
use crate::tables_gen::{DNS_RECORDS, DNS_ZONES, DOMAINS};
use crate::zod;

type S = State<ExternalApiState>;

/// Host's routes.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    router
        .route(
            "/domains",
            scoped(get(list_domains), "domains:read")
                .merge(scoped(post(create_domain), "domains:write")),
        )
        .route(
            "/domains/{id}",
            scoped(get(get_domain), "domains:read").merge(scoped(
                patch(update_domain).delete(delete_domain),
                "domains:write",
            )),
        )
        .route(
            "/domains/{domain_id}/zones",
            scoped(get(list_zones), "domains:read")
                .merge(scoped(post(create_zone), "domains:write")),
        )
        .route(
            "/domains/{domain_id}/zones/{id}",
            scoped(get(get_zone), "domains:read").merge(scoped(
                patch(update_zone).delete(delete_zone),
                "domains:write",
            )),
        )
        .route(
            "/domains/{domain_id}/zones/{zone_id}/records",
            scoped(get(list_records), "domains:read")
                .merge(scoped(post(create_record), "domains:write")),
        )
        .route(
            "/domains/{domain_id}/zones/{zone_id}/records/{id}",
            scoped(get(get_record), "domains:read").merge(scoped(
                patch(update_record).delete(delete_record),
                "domains:write",
            )),
        )
}

/// `DOMAIN_DATE_FIELDS`.
const DOMAIN_DATES: &[&str] = &[
    "registrarSyncedAt",
    "registeredAt",
    "expiresAt",
    "renewedAt",
    "authCodeExpiresAt",
];

/// `MANAGED_DOMAIN_REGISTRARS`: never shown; customers see `WeldSuite`.
const MANAGED_REGISTRARS: &[&str] = &["realtimeregister", "cloudflare", "WeldHost", "WeldSuite"];

/// `toPublicDomain(row)`: a managed (or missing) registrar reads `WeldSuite`.
fn public_domain(mut row: Value) -> Value {
    let registrar = row.get("registrar").and_then(Value::as_str).unwrap_or("");
    let managed = registrar.is_empty() || MANAGED_REGISTRARS.contains(&registrar);
    if managed && let Some(object) = row.as_object_mut() {
        object.insert("registrar".into(), json!("WeldSuite"));
    }
    row
}

/// `isHiddenUnpaidDomain(row)`: an unpaid checkout row.
fn hidden_unpaid(row: &Value) -> bool {
    let registration = row.get("registrationStatus").and_then(Value::as_str);
    if registration == Some("pending_payment") {
        return true;
    }
    row.get("status").and_then(Value::as_str) == Some("cancelled") && registration == Some("failed")
}

/// The domain event's data: `{ id, name: row.fullDomain, status }`.
fn domain_data(id: &str, row: &Value) -> Value {
    json!({ "id": id, "name": field(row, "fullDomain"), "status": field(row, "status") })
}

fn zone_data(id: &str, row: &Value) -> Value {
    json!({ "id": id, "name": field(row, "name"), "status": field(row, "status") })
}

/// `isUsedByWeldReach(db, domainId)`: a domain connected to WeldReach
/// carries Mailpool's mail records; a tenant without the WeldReach tables
/// has none.
async fn used_by_weldreach(caller: &Caller, domain_id: &str) -> bool {
    sqlx::query_scalar::<_, String>(
        "select id from reach_domains where host_domain_id = $1 and status <> 'disconnecting' limit 1",
    )
    .bind(domain_id)
    .fetch_optional(&caller.db)
    .await
    .ok()
    .flatten()
    .is_some()
}

/// `DOMAIN_IN_USE_BY_WELDREACH` with 409.
#[allow(clippy::unnecessary_wraps)] // a handler's answer
fn in_use_by_weldreach() -> Answer {
    Ok((
        StatusCode::CONFLICT,
        axum::Json(json!({
            "error": {
                "code": "DOMAIN_IN_USE_BY_WELDREACH",
                "message": "Disconnect this domain in WeldReach first.",
            }
        })),
    )
        .into_response())
}

// ── domains ──────────────────────────────────────────────────────────────────

const DOMAINS_LIST: (&str, &str) = table_list_sql!(
    domains,
    "t.deleted_at is null \
     and ($3->>'search' is null or (t.full_domain like $3->>'search' or t.name like $3->>'search')) \
     and ($3->>'status' is null or t.status::text = $3->>'status') \
     and t.registration_status is distinct from 'pending_payment' \
     and not (t.status = 'cancelled' and t.registration_status is not distinct from 'failed')"
);

async fn list_domains(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_DOMAINS, raw.as_deref())?;
    let status = match q.text("status") {
        Some("all") | None => Value::Null,
        Some(status) => json!(status),
    };
    let filters = json!({ "search": like(&q, "search"), "status": status });
    Ok(
        list_page_mapped(&caller.db, DOMAINS_LIST, &list_query(&q), &filters, |row| {
            public_domain(DOMAINS.js(row))
        })
        .await?,
    )
}

async fn get_domain(caller: Caller, Path(id): Path<String>) -> Answer {
    match DOMAINS.find_live(&caller.db, &id).await? {
        Some(row) if !hidden_unpaid(&row) => ok(public_domain(row)),
        _ => Err(not_found("Domain", &id).into()),
    }
}

async fn create_domain(State(state): S, caller: Caller, headers: HeaderMap, body: Bytes) -> Answer {
    let parsed = zod::json(&CREATE_DOMAIN, &headers, &body)?;
    let mut body = parsed.body.clone();
    let mut own = coerce_dates(&mut body, DOMAIN_DATES)?;
    own.extend(["createdAt", "updatedAt"]);
    let id = generate_id("dom");
    let values = with_id(&body, &id, &now());
    let row = DOMAINS
        .insert(&caller.db, &values, &dates(&parsed, &own))
        .await?;
    caller.publish(&state.events, DOMAIN_CREATED, &id, domain_data(&id, &row));
    created(public_domain(row))
}

async fn update_domain(
    State(state): S,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_DOMAIN, &headers, &body)?;
    let touches_dns =
        parsed.body.contains_key("nameservers") || parsed.body.contains_key("customNameservers");
    if touches_dns && used_by_weldreach(&caller, &id).await {
        return in_use_by_weldreach();
    }
    let mut body = parsed.body.clone();
    let mut own = coerce_dates(&mut body, DOMAIN_DATES)?;
    own.push("updatedAt");
    let row = DOMAINS
        .patch(
            &caller.db,
            &id,
            &with_updated(&body, &now()),
            true,
            &dates(&parsed, &own),
        )
        .await?
        .ok_or_else(|| not_found("Domain", &id))?;
    caller.publish(&state.events, DOMAIN_UPDATED, &id, domain_data(&id, &row));
    ok(public_domain(row))
}

async fn delete_domain(State(state): S, caller: Caller, Path(id): Path<String>) -> Answer {
    if used_by_weldreach(&caller, &id).await {
        return in_use_by_weldreach();
    }
    let row = soft_delete(&caller.db, &DOMAINS, &id)
        .await?
        .ok_or_else(|| not_found("Domain", &id))?;
    caller.publish(&state.events, DOMAIN_DELETED, &id, domain_data(&id, &row));
    no_content()
}

// ── zones ────────────────────────────────────────────────────────────────────

const ZONES_LIST: (&str, &str) = table_list_sql!(
    dns_zones,
    "t.deleted_at is null and t.domain_id = $3->>'domainId'"
);

/// `listWithCursor` without a query: the first page of the default size.
fn first_page() -> ListQuery {
    ListQuery {
        cursor: None,
        limit: clamp_limit(None),
    }
}

async fn list_zones(caller: Caller, Path(domain_id): Path<String>) -> Answer {
    Ok(list_page_mapped(
        &caller.db,
        ZONES_LIST,
        &first_page(),
        &json!({ "domainId": domain_id }),
        |row| DNS_ZONES.js(row),
    )
    .await?)
}

async fn get_zone(caller: Caller, Path((_domain, id)): Path<(String, String)>) -> Answer {
    crate::crud::get_live(&caller.db, &DNS_ZONES, "DnsZone", &id).await
}

async fn create_zone(
    State(state): S,
    caller: Caller,
    Path(domain_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_DNS_ZONE, &headers, &body)?;
    let id = generate_id("zone");
    // `{ id, createdAt, updatedAt, domainId, ...body }`: the body's
    // `domainId` (required) wins over the path's.
    let mut values = Map::new();
    values.insert("domainId".into(), json!(domain_id));
    values.extend(parsed.body.clone());
    let values = with_id(&values, &id, &now());
    let row = DNS_ZONES
        .insert(
            &caller.db,
            &values,
            &dates(&parsed, &["createdAt", "updatedAt"]),
        )
        .await?;
    caller.publish(&state.events, DNS_ZONE_CREATED, &id, zone_data(&id, &row));
    created(row)
}

async fn update_zone(
    State(state): S,
    caller: Caller,
    Path((domain_id, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    if used_by_weldreach(&caller, &domain_id).await {
        return in_use_by_weldreach();
    }
    let parsed = zod::json(&UPDATE_DNS_ZONE, &headers, &body)?;
    let mut body = parsed.body.clone();
    let mut own = coerce_dates(&mut body, &["syncedAt"])?;
    own.push("updatedAt");
    let row = DNS_ZONES
        .patch(
            &caller.db,
            &id,
            &with_updated(&body, &now()),
            true,
            &dates(&parsed, &own),
        )
        .await?
        .ok_or_else(|| not_found("DnsZone", &id))?;
    caller.publish(&state.events, DNS_ZONE_UPDATED, &id, zone_data(&id, &row));
    ok(row)
}

async fn delete_zone(
    State(state): S,
    caller: Caller,
    Path((domain_id, id)): Path<(String, String)>,
) -> Answer {
    if used_by_weldreach(&caller, &domain_id).await {
        return in_use_by_weldreach();
    }
    let row = soft_delete(&caller.db, &DNS_ZONES, &id)
        .await?
        .ok_or_else(|| not_found("DnsZone", &id))?;
    caller.publish(&state.events, DNS_ZONE_DELETED, &id, zone_data(&id, &row));
    no_content()
}

// ── records ──────────────────────────────────────────────────────────────────

const RECORDS_LIST: (&str, &str) = table_list_sql!(dns_records, "t.zone_id = $3->>'zoneId'");

async fn list_records(caller: Caller, Path((_domain, zone_id)): Path<(String, String)>) -> Answer {
    Ok(list_page_mapped(
        &caller.db,
        RECORDS_LIST,
        &first_page(),
        &json!({ "zoneId": zone_id }),
        |row| DNS_RECORDS.js(row),
    )
    .await?)
}

async fn get_record(
    caller: Caller,
    Path((_domain, _zone, id)): Path<(String, String, String)>,
) -> Answer {
    match DNS_RECORDS.find_any(&caller.db, &id).await? {
        Some(row) => ok(row),
        None => Err(not_found("DnsRecord", &id).into()),
    }
}

fn record_data(id: &str, zone_id: &Value, row: &Value) -> Value {
    json!({
        "id": id,
        "zoneId": zone_id,
        "name": field(row, "name"),
        "type": field(row, "type"),
        "value": field(row, "value"),
    })
}

async fn create_record(
    State(state): S,
    caller: Caller,
    Path((_domain, zone_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_DNS_RECORD, &headers, &body)?;
    let id = generate_id("rec");
    let mut values = Map::new();
    values.insert("zoneId".into(), json!(zone_id));
    values.extend(parsed.body.clone());
    let values = with_id(&values, &id, &now());
    let row = DNS_RECORDS
        .insert(
            &caller.db,
            &values,
            &dates(&parsed, &["createdAt", "updatedAt"]),
        )
        .await?;
    caller.publish(
        &state.events,
        DNS_RECORD_CREATED,
        &id,
        record_data(&id, &json!(zone_id), &row),
    );
    created(row)
}

async fn update_record(
    State(state): S,
    caller: Caller,
    Path((_domain, _zone, id)): Path<(String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_DNS_RECORD, &headers, &body)?;
    let row = DNS_RECORDS
        .patch(
            &caller.db,
            &id,
            &with_updated(&parsed.body, &now()),
            false,
            &dates(&parsed, &["updatedAt"]),
        )
        .await?
        .ok_or_else(|| not_found("DnsRecord", &id))?;
    caller.publish(
        &state.events,
        DNS_RECORD_UPDATED,
        &id,
        record_data(&id, &field(&row, "zoneId"), &row),
    );
    ok(row)
}

async fn delete_record(
    State(state): S,
    caller: Caller,
    Path((_domain, _zone, id)): Path<(String, String, String)>,
) -> Answer {
    let row = DNS_RECORDS
        .delete(&caller.db, &id)
        .await?
        .ok_or_else(|| not_found("DnsRecord", &id))?;
    caller.publish(
        &state.events,
        DNS_RECORD_DELETED,
        &id,
        json!({ "id": id, "zoneId": field(&row, "zoneId") }),
    );
    no_content()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_registrars_read_weldsuite() {
        assert_eq!(
            public_domain(json!({ "registrar": "cloudflare" }))["registrar"],
            "WeldSuite"
        );
        assert_eq!(
            public_domain(json!({ "registrar": null }))["registrar"],
            "WeldSuite"
        );
        assert_eq!(
            public_domain(json!({ "registrar": "GoDaddy" }))["registrar"],
            "GoDaddy"
        );
    }

    #[test]
    fn unpaid_checkouts_are_hidden() {
        assert!(hidden_unpaid(
            &json!({ "registrationStatus": "pending_payment" })
        ));
        assert!(hidden_unpaid(
            &json!({ "status": "cancelled", "registrationStatus": "failed" })
        ));
        assert!(!hidden_unpaid(
            &json!({ "status": "active", "registrationStatus": "failed" })
        ));
    }
}
