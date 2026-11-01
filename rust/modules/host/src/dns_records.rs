//! `/api/dns-records` (`routes/dns-records`, `services/dns-records.ts`):
//! the DNS host is the source of truth, so every mutation calls it and then
//! re-syncs the zone's local records. Permissions `dns:read|create|update|
//! delete`; events `dns_record:*`. Records WeldReach manages are marked
//! `managedBy: 'weldreach'` and refused (409).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{DNS_RECORD_CREATED, DNS_RECORD_DELETED, DNS_RECORD_UPDATED};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_kit::{ApiError, Created, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::dns_host::{Created as Outcome, RecordInput};
use crate::dns_sync::{SyncResult, add_user_lock, record_locks, remove_user_lock, sync_zone};
use crate::doh::scan_domain_records;
use crate::js::{as_text, slice_utf16, text};
use crate::rows::{any_zone, live_domain, live_zone, live_zone_of_domain, one, zone_records};
use crate::weldreach::{domain_name_for_zone, duplicates_record, is_managed_record, mark_records, record_managed};
use crate::{Caller, HostState, internal, json_response, now, validate, validate_query};

const TYPES: [&str; 10] = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA", "PTR", "SOA"];
const IMPORTABLE: [&str; 7] = ["A", "AAAA", "CNAME", "MX", "TXT", "CAA", "SRV"];

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HostState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/by-zone/{zoneId}", get(by_zone).route_layer(need("dns:read")))
        .route(
            "/by-domain/{domainId}",
            get(by_domain).route_layer(need("dns:read")),
        )
        .route(
            "/by-zone/{zoneId}/sync",
            post(sync).route_layer(need("dns:read")),
        )
        .route(
            "/by-domain/{domainId}/scan",
            post(scan).route_layer(need("dns:read")),
        )
        .route(
            "/by-domain/{domainId}/import",
            post(import).route_layer(need("dns:create")),
        )
        .route("/", get(flat_list).route_layer(need("dns:read")))
        .route(
            "/by-domain/{domainId}",
            post(create).route_layer(need("dns:create")),
        )
        .route("/{id}", patch(update).route_layer(need("dns:update")))
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("dns:delete")),
        )
        .route("/{id}/lock", post(lock).route_layer(need("dns:update")))
}

fn unconfigured() -> Response {
    ApiError::internal()
        .with_message("Cloudflare integration is not configured.")
        .into_response()
}

/// A statement outside the route's `try`: the app's 500.
fn app_error(error: &sqlx::Error) -> Response {
    tracing::error!(%error, "[host-api] dns-records");
    ApiError::internal().into_response()
}

// ── Zones and readiness ─────────────────────────────────────────────────────

/// `resolveCloudflareReady*`.
enum Ready {
    NotFound,
    NoCfZone,
    Misconfigured,
    Ok {
        domain: Value,
        zone_id: String,
        external: String,
    },
}

fn readiness(domain: Value, zone: Option<&Value>, token: Option<&str>) -> Ready {
    let external = zone.and_then(|z| text(z, "externalZoneId")).filter(|e| !e.is_empty());
    let cloudflare = zone.and_then(|z| text(z, "provider")) == Some("cloudflare");
    let (Some(zone), Some(external), true) = (zone, external, cloudflare) else {
        return Ready::NoCfZone;
    };
    if token.is_none() {
        return Ready::Misconfigured;
    }
    Ready::Ok {
        domain,
        zone_id: text(zone, "id").unwrap_or_default().to_owned(),
        external: external.to_owned(),
    }
}

/// `resolveCloudflareReady(db, domainId, token)`.
async fn ready_by_domain(db: &PgPool, domain_id: &str, token: Option<&str>) -> Result<Ready, sqlx::Error> {
    let Some(domain) = live_domain(db, domain_id).await? else {
        return Ok(Ready::NotFound);
    };
    let zone = live_zone_of_domain(db, domain_id).await?;
    Ok(readiness(domain, zone.as_ref(), token))
}

/// `resolveCloudflareReadyByZone(db, zoneId, token)`.
async fn ready_by_zone(db: &PgPool, zone_id: &str, token: Option<&str>) -> Result<Ready, sqlx::Error> {
    let Some(zone) = live_zone(db, zone_id).await? else {
        return Ok(Ready::NotFound);
    };
    let Some(domain) = live_domain(db, text(&zone, "domainId").unwrap_or_default()).await? else {
        return Ok(Ready::NotFound);
    };
    Ok(readiness(domain, Some(&zone), token))
}

/// `listDnsRecordsByZone`: the local records, synced first when the zone
/// is on the DNS host and has none or never synced.
async fn list_by_zone(
    caller: &Caller,
    state: &HostState,
    zone_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(zone) = live_zone(&caller.db, zone_id).await? else {
        return Ok(None);
    };
    let mut records = zone_records(&caller.db, zone_id).await?;
    let summary = |zone: &Value| {
        json!({ "id": zone["id"], "syncedAt": zone["syncedAt"], "syncError": zone["syncError"] })
    };
    let mut synced = summary(&zone);
    let providers = caller.providers(state);
    let external = text(&zone, "externalZoneId").filter(|e| !e.is_empty());
    if text(&zone, "provider") == Some("cloudflare")
        && let (Some(external), Some(token)) = (external, providers.cf_token.as_deref())
        && (records.is_empty() || zone["syncedAt"].is_null())
    {
        let dns = providers.dns(token);
        records = sync_zone(&caller.db, &dns, zone_id, Some(external)).await?.records;
        if let Some(refreshed) = any_zone(&caller.db, zone_id).await? {
            synced = summary(&refreshed);
        }
    }
    let records = mark_records(&caller.db, records).await?;
    Ok(Some(json!({ "records": records, "zone": synced })))
}

async fn by_zone(State(state): State<HostState>, caller: Caller, Path(zone_id): Path<String>) -> Response {
    match list_by_zone(&caller, &state, &zone_id).await {
        Ok(Some(body)) => Data(body).into_response(),
        Ok(None) => ApiError::not_found("DNS zone", Some(&zone_id)).into_response(),
        Err(error) => internal(&error, "Failed to list DNS records"),
    }
}

async fn by_domain(
    State(state): State<HostState>,
    caller: Caller,
    Path(domain_id): Path<String>,
) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        if live_domain(&caller.db, &domain_id).await?.is_none() {
            return Ok(ApiError::not_found("Domain", Some(&domain_id)).into_response());
        }
        let Some(zone) = live_zone_of_domain(&caller.db, &domain_id).await? else {
            return Ok(Data(json!({ "records": [], "zone": null })).into_response());
        };
        let zone_id = text(&zone, "id").unwrap_or_default().to_owned();
        Ok(match list_by_zone(&caller, &state, &zone_id).await? {
            Some(body) => Data(body).into_response(),
            None => ApiError::not_found("Domain", Some(&domain_id)).into_response(),
        })
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to list DNS records"))
}

async fn flat_list(State(state): State<HostState>, caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let zone_id = match validate_query(raw.as_deref(), |issues, q| {
        let zone_id = issues.text(q, "zoneId", Presence::Optional, None, None).into_option();
        let _ = issues.choice(q, "type", Presence::Optional, &TYPES);
        let _ = issues.text(q, "cursor", Presence::Optional, None, None);
        let _ = crate::dns_zones::limit_param(issues, q, 200.0);
        zone_id
    }) {
        Ok(zone_id) => zone_id,
        Err(response) => return *response,
    };
    let Some(zone_id) = zone_id.filter(|z| !z.is_empty()) else {
        return ApiError::bad_request("zoneId is required").into_response();
    };
    match list_by_zone(&caller, &state, &zone_id).await {
        Ok(Some(body)) => Data(body).into_response(),
        Ok(None) => ApiError::not_found("DNS zone", Some(&zone_id)).into_response(),
        Err(error) => internal(&error, "Failed to list DNS records"),
    }
}

/// The sync's records with `managedBy`, and its counts.
async fn sync_body(db: &PgPool, sync: SyncResult) -> Result<Value, sqlx::Error> {
    Ok(json!({
        "records": mark_records(db, sync.records).await?,
        "added": sync.added,
        "updated": sync.updated,
        "removed": sync.removed,
    }))
}

async fn sync(State(state): State<HostState>, caller: Caller, Path(zone_id): Path<String>) -> Response {
    let providers = caller.providers(&state);
    let result: Result<Response, sqlx::Error> = async {
        let (zone_id, external) =
            match ready_by_zone(&caller.db, &zone_id, providers.cf_token.as_deref()).await? {
                Ready::NotFound => {
                    return Ok(ApiError::not_found("DNS zone", Some(&zone_id)).into_response());
                }
                Ready::NoCfZone => {
                    return Ok(
                        ApiError::bad_request("This zone is not managed by Cloudflare.").into_response()
                    );
                }
                Ready::Misconfigured => return Ok(unconfigured()),
                Ready::Ok { zone_id, external, .. } => (zone_id, external),
            };
        let dns = providers.dns(providers.cf_token.as_deref().unwrap_or_default());
        let sync = sync_zone(&caller.db, &dns, &zone_id, Some(&external)).await?;
        if !sync.ok {
            let message = sync
                .error
                .clone()
                .unwrap_or_else(|| "Cloudflare sync failed".to_owned());
            let data = sync_body(&caller.db, sync).await?;
            return Ok(json_response(
                StatusCode::BAD_GATEWAY,
                json!({
                    "success": false,
                    "data": data,
                    "error": { "code": "CLOUDFLARE_ERROR", "message": message },
                }),
            ));
        }
        Ok(Data(sync_body(&caller.db, sync).await?).into_response())
    }
    .await;
    result.unwrap_or_else(|error| app_error(&error))
}

/// `isImportable`.
fn importable(domain: &str, record: &Value) -> bool {
    let field = |key: &str| record.get(key).map(as_text).unwrap_or_default();
    let kind = field("type");
    if kind == "NS" {
        return false;
    }
    let verify = format!("_weldhost-verify.{domain}").to_lowercase();
    if kind == "TXT" && field("name").to_lowercase() == verify {
        return false;
    }
    !field("value").to_lowercase().ends_with(".ns.cloudflare.com")
}

async fn scan(State(state): State<HostState>, caller: Caller, Path(domain_id): Path<String>) -> Response {
    let found = async {
        let Some(domain) = live_domain(&caller.db, &domain_id).await? else {
            return Ok::<_, sqlx::Error>(None);
        };
        let zone = live_zone_of_domain(&caller.db, &domain_id).await?;
        Ok(Some((domain, zone)))
    }
    .await;
    let (domain, zone) = match found {
        Ok(Some(found)) => found,
        Ok(None) => return ApiError::not_found("Domain", Some(&domain_id)).into_response(),
        Err(error) => return app_error(&error),
    };
    if zone.as_ref().and_then(|z| text(z, "provider")) != Some("cloudflare") {
        return ApiError::bad_request(
            "This domain does not have a Cloudflare zone yet. Complete verification first.",
        )
        .into_response();
    }
    let full = text(&domain, "fullDomain").unwrap_or_default().to_owned();
    let providers = caller.providers(&state);
    let records: Vec<Value> = scan_domain_records(&providers.http, &full)
        .await
        .into_iter()
        .filter(|r| importable(&full, r))
        .collect();
    Data(json!({ "records": records })).into_response()
}

/// `createDnsRecordSchema` (the update's too).
fn record_fields(issues: &mut Issues, body: &Map<String, Value>) -> RecordInput {
    let kind = issues
        .choice(body, "type", Presence::Required, &TYPES)
        .into_option()
        .unwrap_or_default();
    let name = issues
        .text(body, "name", Presence::Required, Some(1), Some(255))
        .into_option()
        .unwrap_or_default();
    let content = issues
        .text(body, "value", Presence::Required, Some(1), Some(2048))
        .into_option()
        .unwrap_or_default();
    let ttl = issues
        .number(body, "ttl", Presence::Optional, int_rules(1.0, 86_400.0))
        .into_option();
    let priority = issues
        .number(body, "priority", Presence::Optional, int_rules(0.0, 65_535.0))
        .into_option();
    let comment = issues
        .text(body, "comment", Presence::Optional, None, Some(500))
        .into_option();
    RecordInput {
        kind,
        name,
        content,
        ttl,
        priority,
        comment,
    }
}

fn int_rules(min: f64, max: f64) -> Number {
    Number {
        coerce: false,
        int: true,
        min: Some(min),
        max: Some(max),
    }
}

/// `scannedDnsRecordSchema`: the record as Zod outputs it, and the write.
fn scanned_record(issues: &mut Issues, item: &Value) -> Option<(Value, RecordInput)> {
    let fields = issues.object(item)?;
    let name = issues.text(fields, "name", Presence::Required, Some(1), Some(255));
    let kind = issues.choice(fields, "type", Presence::Required, &IMPORTABLE);
    let value = issues.text(fields, "value", Presence::Required, Some(1), Some(2048));
    let ttl = issues.number(fields, "ttl", Presence::Optional, int_rules(1.0, 86_400.0));
    let priority = issues.number(fields, "priority", Presence::Optional, int_rules(0.0, 65_535.0));
    let (Field::Set(name), Field::Set(kind), Field::Set(value)) = (name, kind, value) else {
        return None;
    };
    let mut output = Map::new();
    output.insert("name".to_owned(), json!(name));
    output.insert("type".to_owned(), json!(kind));
    output.insert("value".to_owned(), json!(value));
    if let Field::Set(ttl) = ttl {
        output.insert("ttl".to_owned(), crate::js::number_json(ttl));
    }
    if let Field::Set(priority) = priority {
        output.insert("priority".to_owned(), crate::js::number_json(priority));
    }
    Some((
        Value::Object(output),
        RecordInput {
            kind,
            name,
            content: value,
            ttl: ttl.into_option(),
            priority: priority.into_option(),
            comment: None,
        },
    ))
}

async fn import(
    State(state): State<HostState>,
    caller: Caller,
    Path(domain_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let records = match validate(&headers, &body, |issues, body| {
        issues
            .list(body, "records", Presence::Required, Some(1), Some(100), scanned_record)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(records) => records,
        Err(response) => return *response,
    };
    let providers = caller.providers(&state);
    let Some(token) = providers.cf_token.clone() else {
        return unconfigured();
    };
    let result: Result<Response, sqlx::Error> = async {
        let (domain, zone_id, external) =
            match ready_by_domain(&caller.db, &domain_id, Some(&token)).await? {
                Ready::NotFound => {
                    return Ok(ApiError::not_found("Domain", Some(&domain_id)).into_response());
                }
                Ready::NoCfZone => {
                    return Ok(ApiError::bad_request(
                        "This domain does not have a Cloudflare zone yet.",
                    )
                    .into_response());
                }
                Ready::Misconfigured => return Ok(unconfigured()),
                Ready::Ok {
                    domain,
                    zone_id,
                    external,
                } => (domain, zone_id, external),
            };
        let full = text(&domain, "fullDomain").unwrap_or_default().to_owned();
        let reach = domain_name_for_zone(&caller.db, &zone_id).await?;
        let dns = providers.dns(&token);
        let (mut imported, mut skipped) = (0_u64, 0_u64);
        let mut failed: Vec<Value> = Vec::new();
        for (record, input) in &records {
            if !importable(&full, record) {
                skipped += 1;
                continue;
            }
            if reach
                .as_deref()
                .is_some_and(|domain| duplicates_record(domain, &input.kind, &input.name, &input.content))
            {
                skipped += 1;
                continue;
            }
            match dns.create_record(&external, input).await {
                Ok(Outcome::Created) => imported += 1,
                Ok(Outcome::Duplicate) => skipped += 1,
                Err(error) => failed.push(json!({ "record": record, "error": error.message })),
            }
        }
        sync_zone(&caller.db, &dns, &zone_id, Some(&external)).await?;
        Ok(Data(json!({ "imported": imported, "skipped": skipped, "failed": failed })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| app_error(&error))
}

/// The 422 of a provider refusal, with the re-synced records.
async fn provider_refused(db: &PgPool, sync: SyncResult, message: &str) -> Result<Response, sqlx::Error> {
    let records = mark_records(db, sync.records).await?;
    Ok(json_response(
        StatusCode::UNPROCESSABLE_ENTITY,
        json!({
            "success": false,
            "data": { "records": records },
            "error": { "code": "CLOUDFLARE_ERROR", "message": message },
        }),
    ))
}

async fn create(
    State(state): State<HostState>,
    caller: Caller,
    Path(domain_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, record_fields) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let providers = caller.providers(&state);
    let result: Result<Response, sqlx::Error> = async {
        let (zone_id, external) =
            match ready_by_domain(&caller.db, &domain_id, providers.cf_token.as_deref()).await? {
                Ready::NotFound => {
                    return Ok(ApiError::not_found("Domain", Some(&domain_id)).into_response());
                }
                Ready::NoCfZone => {
                    return Ok(ApiError::bad_request(
                        "This domain does not have a Cloudflare zone yet.",
                    )
                    .into_response());
                }
                Ready::Misconfigured => return Ok(unconfigured()),
                Ready::Ok { zone_id, external, .. } => (zone_id, external),
            };
        if let Some(reach) = domain_name_for_zone(&caller.db, &zone_id).await?
            && duplicates_record(&reach, &input.kind, &input.name, &input.content)
        {
            return Ok(record_managed());
        }
        let dns = providers.dns(providers.cf_token.as_deref().unwrap_or_default());
        let refused = match dns.create_record(&external, &input).await {
            Ok(_) => None,
            Err(error) => {
                tracing::error!(%error, "[dns-records.service] createDnsRecordInZone failed");
                Some(error.message)
            }
        };
        let sync = sync_zone(&caller.db, &dns, &zone_id, Some(&external)).await?;
        if let Some(message) = refused {
            return provider_refused(&caller.db, sync, &message).await;
        }
        caller.publish(
            &state,
            DNS_RECORD_CREATED,
            &zone_id,
            &json!({
                "id": zone_id,
                "zoneId": zone_id,
                "name": input.name,
                "type": input.kind,
                "value": input.content,
            }),
        );
        let records = mark_records(&caller.db, sync.records).await?;
        Ok(Created(json!({ "records": records })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| app_error(&error))
}

/// `loadDnsRecordWithZone`: the record and its zone (deleted or not).
async fn record_with_zone(db: &PgPool, id: &str) -> Result<Option<(Value, Value)>, sqlx::Error> {
    let Some(record) = one(db, "select to_jsonb(t) from dns_records t where t.id = $1 limit 1", id).await? else {
        return Ok(None);
    };
    let zone = any_zone(db, text(&record, "zoneId").unwrap_or_default()).await?;
    Ok(zone.map(|zone| (record, zone)))
}

fn locked_response(record: &Value) -> Response {
    let reasons: Vec<Value> = record_locks(record.get("metadata"))
        .iter()
        .map(|lock| lock["reason"].clone())
        .collect();
    let message = reasons
        .first()
        .map_or_else(|| "This record is locked.".to_owned(), as_text);
    json_response(
        StatusCode::LOCKED,
        json!({
            "success": false,
            "error": { "code": "RECORD_LOCKED", "message": message, "details": { "reasons": reasons } },
        }),
    )
}

/// The checks `updateDnsRecord` and `deleteDnsRecord` share, up to the
/// lock: `Err` with the refusal, or the record, its zone and the zone's
/// external id.
async fn guard(
    db: &PgPool,
    id: &str,
    input: Option<&RecordInput>,
) -> Result<Result<(Value, Value, String), Response>, sqlx::Error> {
    let Some((record, zone)) = record_with_zone(db, id).await? else {
        return Ok(Err(ApiError::not_found("DNS record", Some(id)).into_response()));
    };
    let external = text(&zone, "externalZoneId").filter(|e| !e.is_empty()).map(str::to_owned);
    let (Some(external), true) = (external, text(&zone, "provider") == Some("cloudflare")) else {
        return Ok(Err(
            ApiError::bad_request("This zone is not managed by Cloudflare.").into_response(),
        ));
    };
    let zone_id = text(&zone, "id").unwrap_or_default().to_owned();
    if let Some(reach) = domain_name_for_zone(db, &zone_id).await? {
        let field = |key: &str| record.get(key).map(as_text).unwrap_or_default();
        let managed = is_managed_record(&reach, &field("type"), &field("name"), &field("value"));
        let duplicates = input
            .is_some_and(|input| duplicates_record(&reach, &input.kind, &input.name, &input.content));
        if managed || duplicates {
            return Ok(Err(record_managed()));
        }
    }
    if !record_locks(record.get("metadata")).is_empty() {
        return Ok(Err(locked_response(&record)));
    }
    Ok(Ok((record, zone, external)))
}

async fn update(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, record_fields) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let providers = caller.providers(&state);
    let Some(token) = providers.cf_token.clone() else {
        return unconfigured();
    };
    let result: Result<Response, sqlx::Error> = async {
        let (record, zone, external) = match guard(&caller.db, &id, Some(&input)).await? {
            Ok(found) => found,
            Err(refusal) => return Ok(refusal),
        };
        let Some(record_external) = text(&record, "externalRecordId").filter(|e| !e.is_empty()) else {
            return Ok(ApiError::bad_request("Record has no Cloudflare id — run a sync first.").into_response());
        };
        let dns = providers.dns(&token);
        let refused = match dns.update_record(&external, record_external, &input).await {
            Ok(()) => None,
            Err(error) => {
                tracing::error!(%error, "[dns-records.service] updateDnsRecordInZone failed");
                Some(error.message)
            }
        };
        let zone_id = text(&zone, "id").unwrap_or_default().to_owned();
        let sync = sync_zone(&caller.db, &dns, &zone_id, Some(&external)).await?;
        if let Some(message) = refused {
            return provider_refused(&caller.db, sync, &message).await;
        }
        caller.publish(
            &state,
            DNS_RECORD_UPDATED,
            &id,
            &json!({ "id": id, "zoneId": id, "name": input.name, "type": input.kind, "value": input.content }),
        );
        let records = mark_records(&caller.db, sync.records).await?;
        Ok(Data(json!({ "records": records })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| app_error(&error))
}

async fn remove(State(state): State<HostState>, caller: Caller, Path(id): Path<String>) -> Response {
    let providers = caller.providers(&state);
    let Some(token) = providers.cf_token.clone() else {
        return unconfigured();
    };
    let result: Result<Response, sqlx::Error> = async {
        let (record, zone, external) = match guard(&caller.db, &id, None).await? {
            Ok(found) => found,
            Err(refusal) => return Ok(refusal),
        };
        let dns = providers.dns(&token);
        let mut refused = None;
        if let Some(record_external) = text(&record, "externalRecordId").filter(|e| !e.is_empty())
            && let Err(error) = dns.delete_record(&external, record_external).await
        {
            tracing::error!(%error, "[dns-records.service] deleteDnsRecordInZone failed");
            refused = Some(error.message);
        }
        let zone_id = text(&zone, "id").unwrap_or_default().to_owned();
        let sync = sync_zone(&caller.db, &dns, &zone_id, Some(&external)).await?;
        if let Some(message) = refused {
            return provider_refused(&caller.db, sync, &message).await;
        }
        caller.publish(&state, DNS_RECORD_DELETED, &id, &json!({ "id": id, "zoneId": id }));
        let records = mark_records(&caller.db, sync.records).await?;
        Ok(Data(json!({ "records": records })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| app_error(&error))
}

async fn lock(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (locked, reason) = match validate(&headers, &body, |issues, body| {
        let locked = issues.boolean(body, "locked", Presence::Required).into_option();
        let reason = issues.text(body, "reason", Presence::Optional, None, Some(500)).into_option();
        (locked.unwrap_or_default(), reason)
    }) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let reason = reason
        .filter(|r| !crate::js::js_trim(r).is_empty())
        .map_or_else(|| "Locked by user".to_owned(), |r| slice_utf16(&r, 500));
    let result: Result<Response, sqlx::Error> = async {
        let Some((record, zone)) = record_with_zone(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("DNS record", Some(&id)).into_response());
        };
        let metadata = if locked {
            add_user_lock(record.get("metadata"), &reason)
        } else {
            remove_user_lock(record.get("metadata"))
        };
        sqlx::query("update dns_records set metadata = $2, updated_at = $3::timestamp where id = $1")
            .bind(&id)
            .bind(&metadata)
            .bind(now())
            .execute(&caller.db)
            .await?;
        let zone_id = text(&zone, "id").unwrap_or_default().to_owned();
        let records = zone_records(&caller.db, &zone_id).await?;
        caller.publish(&state, DNS_RECORD_UPDATED, &id, &json!({ "id": id, "zoneId": zone_id }));
        let records = mark_records(&caller.db, records).await?;
        Ok(Data(json!({ "records": records })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| app_error(&error))
}

