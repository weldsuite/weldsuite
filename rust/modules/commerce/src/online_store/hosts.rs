//! `/api/storefront-hosts`: a shop's addresses. Rows live in the master
//! `storefront_hosts` (host names are unique across workspaces; the edge and
//! the sweep read them without opening tenant databases).
//!
//!   GET    /config        → what this install offers
//!   GET    /?siteId=      → the site's hosts, with the DNS records to add
//!   POST   /              { siteId, subdomain } (a free address, active at once)
//!                         { siteId, hostname }  (a custom domain)
//!   POST   /:id/refresh   → checked now (the sweep also checks)
//!   POST   /:id/primary   → the address the others redirect to
//!   DELETE /:id
//!
//! A custom domain goes live in three steps, each checked on add, on
//! refresh and by [`sweep_hosts`] every few minutes:
//!
//! 1. **Ownership**: a TXT record `_weldcommerce.<host>` with
//!    `weldcommerce-verify=<token>`, so no workspace can take another's
//!    domain (as WeldMail's `_weldmail-verify`, ADR MAIL-012).
//! 2. **Routing**: a CNAME to the install's shop target, or for an apex
//!    domain A records to its ingress addresses.
//! 3. **Certificate**: cert-manager issues one over HTTP-01; the host's
//!    `Ingress` sends everything to the storefront edge.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use http::HeaderMap;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{
    EventName, STOREFRONT_HOST_CREATED, STOREFRONT_HOST_DELETED, STOREFRONT_HOST_FAILED,
    STOREFRONT_HOST_UPDATED, STOREFRONT_HOST_VERIFIED,
};
use weldsuite_catalogs::permission_keys::{WEBSITES_MANAGE, WEBSITES_READ};
use weldsuite_custom_domains::{is_under, normalize_host};
use weldsuite_db::{is_unique_violation, orm, utc_now};
use weldsuite_events::{EntityEventPublisher, EventContext, publish_entity_event};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::master::storefront_hosts;

use super::config::{OnlineStoreConfig, RESERVED_LABELS};
use super::document::is_slug;
use super::registry;
use super::sites::load_site;
use super::{body_object, conflict, failed, invalid_field, iso, not_found, unavailable};
use crate::{Caller, CommerceState};

/// Where the ownership record goes.
const VERIFY_LABEL: &str = "_weldcommerce";
const VERIFY_PREFIX: &str = "weldcommerce-verify=";
/// Hosts one site may have.
const MAX_HOSTS_PER_SITE: usize = 10;
/// Hosts one sweep checks.
const SWEEP_BATCH: u64 = 200;

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([WEBSITES_READ]);
    let manage = || gate.require([WEBSITES_MANAGE]);
    Router::new()
        .route("/config", get(config).route_layer(read()))
        .route("/", get(list).route_layer(read()))
        .route("/", post(create).route_layer(manage()))
        .route("/{id}/refresh", post(refresh).route_layer(manage()))
        .route("/{id}/primary", post(make_primary).route_layer(manage()))
        .route("/{id}", delete(remove).route_layer(manage()))
}

#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
fn master(caller: &Caller) -> Result<&PgPool, Response> {
    caller
        .registry
        .as_ref()
        .ok_or_else(|| unavailable("Shop addresses need the master database"))
}

/// A host name of at most 253 characters in labels of 1–63 letters, digits
/// and inner hyphens, with at least one dot; lower case.
pub(crate) fn is_host_name(host: &str) -> bool {
    host.len() <= 253
        && host.contains('.')
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
        && !host
            .rsplit('.')
            .next()
            .is_some_and(|tld| tld.bytes().all(|b| b.is_ascii_digit()))
}

/// An apex domain, as far as the API can tell without a public suffix list:
/// two labels (`example.com`).
fn looks_like_apex(host: &str) -> bool {
    host.split('.').count() == 2
}

fn dns_records(config: &OnlineStoreConfig, row: &storefront_hosts::Model) -> Vec<Value> {
    if row.kind != "custom" {
        return Vec::new();
    }
    let mut records = vec![json!({
        "type": "TXT",
        "name": format!("{VERIFY_LABEL}.{}", row.hostname),
        "value": format!("{VERIFY_PREFIX}{}", row.verification_token),
        "purpose": "ownership",
        "satisfied": row.verified_at.is_some(),
    })];
    let routed = row.ssl_status.is_some();
    if looks_like_apex(&row.hostname) && !config.apex_addresses.is_empty() {
        for address in &config.apex_addresses {
            let kind = if address.contains(':') { "AAAA" } else { "A" };
            records.push(json!({
                "type": kind, "name": row.hostname, "value": address,
                "purpose": "routing", "satisfied": routed,
            }));
        }
    } else if let Some(target) = config.cname_target() {
        records.push(json!({
            "type": "CNAME", "name": row.hostname, "value": target,
            "purpose": "routing", "satisfied": routed,
        }));
    }
    records
}

fn present(config: &OnlineStoreConfig, row: &storefront_hosts::Model) -> Value {
    json!({
        "id": row.id,
        "siteId": row.site_id,
        "channelId": row.channel_id,
        "hostname": row.hostname,
        "kind": row.kind,
        "isPrimary": row.is_primary,
        "status": row.status,
        "sslStatus": row.ssl_status,
        "lastError": row.last_error,
        "lastCheckedAt": row.last_checked_at.map(iso),
        "verifiedAt": row.verified_at.map(iso),
        "url": config.origin(&row.hostname),
        "dnsRecords": dns_records(config, row),
        "createdAt": iso(row.created_at),
    })
}

/// What the event says of a host: never its verification token or the
/// shop's password hash.
fn event_data(row: &storefront_hosts::Model) -> Value {
    json!({
        "id": row.id,
        "siteId": row.site_id,
        "channelId": row.channel_id,
        "hostname": row.hostname,
        "kind": row.kind,
        "isPrimary": row.is_primary,
        "status": row.status,
        "sslStatus": row.ssl_status,
    })
}

async fn config(State(state): State<CommerceState>) -> Response {
    let config = &state.online_store;
    Data(json!({
        "available": config.base_domain.is_some() || config.domains.is_some(),
        "baseDomain": config.base_domain,
        "cnameTarget": config.cname_target(),
        "apexAddresses": config.apex_addresses,
        "customDomains": config.domains.is_some(),
        "renderer": config.secret.is_some(),
        "staticHosting": config.files.is_some(),
    }))
    .into_response()
}

async fn find(
    master: &PgPool,
    workspace_id: &str,
    id: &str,
) -> Result<Option<storefront_hosts::Model>, DbErr> {
    storefront_hosts::Entity::find_by_id(id.to_owned())
        .filter(storefront_hosts::Column::WorkspaceId.eq(workspace_id))
        .one(&orm(master))
        .await
}

async fn list(
    State(state): State<CommerceState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    const FAILED: &str = "Failed to fetch the shop addresses";
    let master = match master(&caller) {
        Ok(master) => master,
        Err(response) => return response,
    };
    let site_id = query.as_deref().and_then(|q| {
        url::form_urlencoded::parse(q.as_bytes())
            .find(|(key, _)| key == "siteId")
            .map(|(_, value)| value.into_owned())
    });
    let mut select = storefront_hosts::Entity::find()
        .filter(storefront_hosts::Column::WorkspaceId.eq(caller.workspace_id.clone()));
    if let Some(site_id) = site_id {
        select = select.filter(storefront_hosts::Column::SiteId.eq(site_id));
    }
    match select
        .order_by_desc(storefront_hosts::Column::IsPrimary)
        .order_by_asc(storefront_hosts::Column::CreatedAt)
        .all(&orm(master))
        .await
    {
        Ok(rows) => Data(Value::Array(
            rows.iter()
                .map(|row| present(&state.online_store, row))
                .collect(),
        ))
        .into_response(),
        Err(error) => failed(&error, FAILED),
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "free addresses and custom domains, each checked in turn"
)]
async fn create(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to add the address";
    let config = &state.online_store;
    let body = match body_object(&headers, &body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let master = match master(&caller) {
        Ok(master) => master.clone(),
        Err(response) => return response,
    };
    let Some(site_id) = body
        .get("siteId")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return invalid_field("siteId", "Required");
    };
    let subdomain = body
        .get("subdomain")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_ascii_lowercase());
    let hostname = body
        .get("hostname")
        .and_then(Value::as_str)
        .map(normalize_host);
    let (hostname, kind) = match (subdomain, hostname) {
        (Some(label), None) => {
            let Some(base) = &config.base_domain else {
                return unavailable(
                    "This install has no free shop addresses (STOREFRONT_BASE_DOMAIN)",
                );
            };
            if !is_slug(&label, 63) || label.len() < 3 {
                return invalid_field(
                    "subdomain",
                    "3–63 lower-case letters, digits and single hyphens",
                );
            }
            if RESERVED_LABELS.contains(&label.as_str()) {
                return ApiErrorReserved::answer("subdomain");
            }
            (format!("{label}.{base}"), "subdomain")
        }
        (None, Some(host)) => {
            let Some(domains) = &config.domains else {
                return unavailable("Custom domains aren't available on this install");
            };
            if !is_host_name(&host) {
                return invalid_field("hostname", "A domain name such as shop.example.com");
            }
            let ours = domains.is_install_host(&host)
                || config
                    .base_domain
                    .as_deref()
                    .is_some_and(|base| is_under(&host, base));
            if ours {
                return ApiErrorReserved::answer("hostname");
            }
            (host, "custom")
        }
        _ => return invalid_field("subdomain", "Send either subdomain or hostname"),
    };
    let tenant = orm(&caller.db);
    let site = match load_site(&tenant, &site_id).await {
        Ok(Some(site)) => site,
        Ok(None) => return not_found("Online store", &site_id),
        Err(error) => return failed(&error, FAILED),
    };
    let existing = match registry::site_hosts(&master, &caller.workspace_id, &site.id).await {
        Ok(rows) => rows,
        Err(error) => return failed(&error, FAILED),
    };
    if existing.len() >= MAX_HOSTS_PER_SITE {
        return conflict(
            "TOO_MANY_HOSTS",
            &format!("A shop has at most {MAX_HOSTS_PER_SITE} addresses"),
            None,
        );
    }
    if kind == "subdomain" && existing.iter().any(|h| h.kind == "subdomain") {
        return conflict(
            "SUBDOMAIN_EXISTS",
            "The shop has a free address already; remove it to choose another",
            None,
        );
    }
    let now = utc_now();
    let verification_token = hex::encode(weldsuite_kit::portal::tokens::random_token(16));
    let row = storefront_hosts::ActiveModel {
        id: Set(generate_id("sfh")),
        created_at: Set(now),
        updated_at: Set(now),
        hostname: Set(hostname.clone()),
        workspace_id: Set(caller.workspace_id.clone()),
        channel_id: Set(site.channel_id.clone()),
        site_id: Set(site.id.clone()),
        kind: Set(kind.to_owned()),
        is_primary: Set(!existing.iter().any(|h| h.is_primary)),
        status: Set(if kind == "subdomain" {
            "active"
        } else {
            "pending"
        }
        .to_owned()),
        ssl_status: Set((kind == "subdomain").then(|| "active".to_owned())),
        verification_token: Set(verification_token),
        last_error: Set(None),
        last_checked_at: Set(None),
        verified_at: Set((kind == "subdomain").then_some(now)),
        mode: Set(site.mode.clone()),
        published_version_id: Set(site.published_version_id.clone()),
        deployment_id: Set(site.active_deployment_id.clone()),
        visibility: Set(site.visibility.clone()),
        password_hash: Set(site.password_hash.clone()),
        created_by_user_id: Set(Some(caller.user_id.clone())),
    };
    let row = match storefront_hosts::Entity::insert(row)
        .exec_with_returning(&orm(&master))
        .await
    {
        Ok(row) => row,
        Err(error) if is_unique_violation(&error) => {
            return conflict(
                "HOST_TAKEN",
                "This address is in use by another shop",
                Some(json!({ "hostname": hostname })),
            );
        }
        Err(error) => return failed(&error, FAILED),
    };
    let row = if kind == "custom" {
        check(&master, config, row).await.0
    } else {
        row
    };
    registry::forget(config.cache.as_ref(), std::slice::from_ref(&row.hostname)).await;
    caller.publish(&state, STOREFRONT_HOST_CREATED, &row.id, &event_data(&row));
    Created(present(config, &row)).into_response()
}

/// 400 for an address that belongs to the install.
struct ApiErrorReserved;

impl ApiErrorReserved {
    fn answer(field: &str) -> Response {
        weldsuite_kit::ApiError::new(
            http::StatusCode::BAD_REQUEST,
            "HOST_RESERVED",
            "This address is reserved; choose another",
        )
        .with_details(json!({ "field": field }))
        .into_response()
    }
}

/// Moves a custom domain along (ownership, routing, certificate) and saves
/// where it stands; answers the row and the event the change deserves.
pub(crate) async fn check(
    master: &PgPool,
    config: &OnlineStoreConfig,
    row: storefront_hosts::Model,
) -> (storefront_hosts::Model, Option<EventName>) {
    if row.kind != "custom" {
        return (row, None);
    }
    let Some(domains) = &config.domains else {
        return (row, None);
    };
    let now = utc_now();
    let mut change = storefront_hosts::ActiveModel {
        id: Set(row.id.clone()),
        last_checked_at: Set(Some(now)),
        updated_at: Set(now),
        ..Default::default()
    };
    let mut verified = row.verified_at.is_some();
    let mut status = row.status.clone();
    let mut ssl = row.ssl_status.clone();
    let mut error: Option<String> = None;
    if !verified {
        let name = format!("{VERIFY_LABEL}.{}", row.hostname);
        let expected = format!("{VERIFY_PREFIX}{}", row.verification_token);
        match domains.txt_records(&name).await {
            Ok(records) if records.iter().any(|r| r.trim() == expected) => {
                verified = true;
                change.verified_at = Set(Some(now));
            }
            Ok(_) => {
                error = Some(format!(
                    "Add the TXT record {name} with the value {expected}"
                ));
            }
            Err(problem) => error = Some(problem.message),
        }
    }
    if verified {
        match domains.reconcile(&row.hostname).await {
            Ok(state) => {
                status = if state.status == "active" {
                    "active".to_owned()
                } else if state.ssl_status.as_deref() == Some(weldsuite_custom_domains::SSL_FAILED)
                {
                    "failed".to_owned()
                } else {
                    "pending".to_owned()
                };
                ssl = state.ssl_status;
                error = state.errors.into_iter().next();
            }
            Err(problem) => error = Some(problem.message),
        }
    }
    change.status = Set(status.clone());
    change.ssl_status = Set(ssl);
    change.last_error = Set(error);
    let event = match (row.status.as_str(), status.as_str()) {
        (before, "active") if before != "active" => Some(STOREFRONT_HOST_VERIFIED),
        (before, "failed") if before != "failed" => Some(STOREFRONT_HOST_FAILED),
        _ => None,
    };
    match storefront_hosts::Entity::update(change)
        .exec(&orm(master))
        .await
    {
        Ok(saved) => (saved, event),
        Err(problem) => {
            tracing::error!(error = %problem, host = %row.hostname, "[online-store] the host's check was not saved");
            (row, None)
        }
    }
}

async fn refresh(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to check the address";
    let master = match master(&caller) {
        Ok(master) => master.clone(),
        Err(response) => return response,
    };
    let row = match find(&master, &caller.workspace_id, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return not_found("Shop address", &id),
        Err(error) => return failed(&error, FAILED),
    };
    let (row, event) = check(&master, &state.online_store, row).await;
    registry::forget(
        state.online_store.cache.as_ref(),
        std::slice::from_ref(&row.hostname),
    )
    .await;
    if let Some(event) = event {
        caller.publish(&state, event, &row.id, &event_data(&row));
    }
    Data(present(&state.online_store, &row)).into_response()
}

async fn make_primary(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to make the address primary";
    let master = match master(&caller) {
        Ok(master) => master.clone(),
        Err(response) => return response,
    };
    let row = match find(&master, &caller.workspace_id, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return not_found("Shop address", &id),
        Err(error) => return failed(&error, FAILED),
    };
    if row.status != "active" {
        return conflict(
            "HOST_NOT_ACTIVE",
            "Only an active address can be the primary one",
            None,
        );
    }
    let db = orm(&master);
    let result = async {
        storefront_hosts::Entity::update_many()
            .set(storefront_hosts::ActiveModel {
                is_primary: Set(false),
                ..Default::default()
            })
            .filter(storefront_hosts::Column::WorkspaceId.eq(caller.workspace_id.clone()))
            .filter(storefront_hosts::Column::SiteId.eq(row.site_id.clone()))
            .exec(&db)
            .await?;
        storefront_hosts::Entity::update(storefront_hosts::ActiveModel {
            id: Set(row.id.clone()),
            is_primary: Set(true),
            updated_at: Set(utc_now()),
            ..Default::default()
        })
        .exec(&db)
        .await
    }
    .await;
    let row = match result {
        Ok(row) => row,
        Err(error) => return failed(&error, FAILED),
    };
    forget_site(&master, &state, &caller.workspace_id, &row.site_id).await;
    caller.publish(&state, STOREFRONT_HOST_UPDATED, &row.id, &event_data(&row));
    Data(present(&state.online_store, &row)).into_response()
}

async fn forget_site(master: &PgPool, state: &CommerceState, workspace_id: &str, site_id: &str) {
    if let Ok(rows) = registry::site_hosts(master, workspace_id, site_id).await {
        let hosts: Vec<String> = rows.into_iter().map(|h| h.hostname).collect();
        registry::forget(state.online_store.cache.as_ref(), &hosts).await;
    }
}

async fn remove(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to remove the address";
    let master = match master(&caller) {
        Ok(master) => master.clone(),
        Err(response) => return response,
    };
    let row = match find(&master, &caller.workspace_id, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return not_found("Shop address", &id),
        Err(error) => return failed(&error, FAILED),
    };
    // The route first, so the host stops serving before the row goes.
    if row.kind == "custom"
        && let Some(domains) = &state.online_store.domains
        && let Err(error) = domains.remove(&row.hostname).await
    {
        return failed(
            &error,
            "The address's certificate and route could not be removed",
        );
    }
    let db = orm(&master);
    if let Err(error) = storefront_hosts::Entity::delete_by_id(row.id.clone())
        .exec(&db)
        .await
    {
        return failed(&error, FAILED);
    }
    if row.is_primary {
        let next = storefront_hosts::Entity::find()
            .filter(storefront_hosts::Column::WorkspaceId.eq(caller.workspace_id.clone()))
            .filter(storefront_hosts::Column::SiteId.eq(row.site_id.clone()))
            .filter(storefront_hosts::Column::Status.eq("active"))
            .order_by_asc(storefront_hosts::Column::CreatedAt)
            .one(&db)
            .await;
        if let Ok(Some(next)) = next {
            let promoted = storefront_hosts::Entity::update(storefront_hosts::ActiveModel {
                id: Set(next.id),
                is_primary: Set(true),
                ..Default::default()
            })
            .exec(&db)
            .await;
            if let Err(error) = promoted {
                tracing::warn!(%error, "[online-store] no new primary address");
            }
        }
    }
    registry::forget(
        state.online_store.cache.as_ref(),
        std::slice::from_ref(&row.hostname),
    )
    .await;
    forget_site(&master, &state, &caller.workspace_id, &row.site_id).await;
    caller.publish(&state, STOREFRONT_HOST_DELETED, &row.id, &event_data(&row));
    NoContent.into_response()
}

/// `weldsuite cron storefront-hosts`: checks the custom domains that aren't
/// live yet, from the master database alone, and publishes the changes.
/// Answers how many were checked.
pub async fn sweep_hosts(
    master: &PgPool,
    config: &OnlineStoreConfig,
    events: Option<&EntityEventPublisher>,
) -> Result<usize, DbErr> {
    if config.domains.is_none() {
        return Ok(0);
    }
    let rows = storefront_hosts::Entity::find()
        .filter(storefront_hosts::Column::Kind.eq("custom"))
        .filter(storefront_hosts::Column::Status.ne("active"))
        .order_by_asc(storefront_hosts::Column::LastCheckedAt)
        .limit(SWEEP_BATCH)
        .all(&orm(master))
        .await?;
    let checked = rows.len();
    for row in rows {
        let (row, event) = check(master, config, row).await;
        registry::forget(config.cache.as_ref(), std::slice::from_ref(&row.hostname)).await;
        if let (Some(event), Some(events)) = (event, events) {
            let ctx = EventContext::from_ids(&row.workspace_id, None, "system");
            publish_entity_event(events, &ctx, event, &row.id, &event_data(&row));
        }
    }
    Ok(checked)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_names() {
        for good in [
            "shop.example.com",
            "example.nl",
            "a-b.example.co.uk",
            "xn--bcher-kva.example",
        ] {
            assert!(is_host_name(good), "{good}");
        }
        for bad in [
            "localhost",
            "-shop.example.com",
            "shop..example.com",
            "shop.example.com.",
            "Shop.Example.com",
            "1.2.3.4",
            "shop_1.example.com",
        ] {
            assert!(!is_host_name(bad), "{bad}");
        }
    }

    #[test]
    fn apex_heuristic() {
        assert!(looks_like_apex("example.com"));
        assert!(!looks_like_apex("shop.example.com"));
    }
}
