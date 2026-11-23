//! `/api/domain-transfers` (`routes/domain-transfers`,
//! `services/domain-transfers.ts`): incoming transfers go to Realtime
//! Register; outgoing ones are bookkeeping (the auth code comes from
//! `/api/domains/:id/auth-code`). Permissions `transfers:read|create|update`;
//! events `domain_transfer:*`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::{HeaderMap, StatusCode};
use sea_orm::{ActiveEnum, ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{DOMAIN_TRANSFER_CREATED, DOMAIN_TRANSFER_UPDATED};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, List, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::enums::{
    HostDomainRegistrationStatus, HostDomainStatus, HostDomainTransferStatus,
    HostDomainTransferType,
};
use weldsuite_schema::tenant::{domain_transfers, domains};

use crate::dns_zones::limit_param;
use crate::js::{parse_int, text};
use crate::listing::list;
use crate::registrar::{
    Outcome, RealtimeRegistrar, RtrError, platform_contacts, privacy_protect_for_domain,
};
use crate::rows::{js_option, live_domain, timestamp_of};
use crate::weldreach::{domain_in_use, is_domain_name_used, is_domain_used};
use crate::{Caller, HostState, error_response, internal, validate, validate_query};

const TYPES: [&str; 2] = ["incoming", "outgoing"];
const STATUSES: [&str; 8] = [
    "pending",
    "pending_approval",
    "approved",
    "rejected",
    "cancelled",
    "in_progress",
    "completed",
    "failed",
];

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HostState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list_transfers).route_layer(need("transfers:read")))
        .route("/", post(create).route_layer(need("transfers:create")))
        .route("/{id}", get(detail).route_layer(need("transfers:read")))
        .route(
            "/{id}/complete",
            patch(complete).route_layer(need("transfers:update")),
        )
        .route(
            "/{id}/sync",
            patch(sync).route_layer(need("transfers:update")),
        )
        .route(
            "/{id}/fail",
            patch(fail).route_layer(need("transfers:update")),
        )
}

/// How long the webhook's process mapping lives (`expirationTtl`: 14 days).
#[allow(clippy::duration_suboptimal_units)]
const MAPPING_TTL: std::time::Duration = std::time::Duration::from_secs(14 * 86_400);

/// A transfer by id.
async fn by_id(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = domain_transfers::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?;
    js_option(row)
}

/// A validated `status` as the column's enum.
fn transfer_status(status: &str) -> Result<HostDomainTransferStatus, DbErr> {
    HostDomainTransferStatus::try_from_value(&status.to_owned())
}

/// A validated `type` as the column's enum.
fn transfer_type(kind: &str) -> Result<HostDomainTransferType, DbErr> {
    HostDomainTransferType::try_from_value(&kind.to_owned())
}

fn rtr_unconfigured() -> Response {
    error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "SERVICE_UNAVAILABLE",
        "Realtime Register is not configured",
    )
}

fn event_data(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "domainName": row["domainName"],
        "type": row["type"],
        "status": row["status"],
    })
}

async fn list_transfers(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), |issues, q| {
        let domain_id = issues
            .text(q, "domainId", Presence::Optional, None, None)
            .into_option();
        let status = issues
            .choice(q, "status", Presence::Optional, &STATUSES)
            .into_option();
        let kind = issues
            .choice(q, "type", Presence::Optional, &TYPES)
            .into_option();
        let cursor = issues
            .text(q, "cursor", Presence::Optional, None, None)
            .into_option();
        let limit = limit_param(issues, q, 100.0);
        (domain_id, status, kind, cursor, limit)
    }) {
        Ok(query) => query,
        Err(response) => return *response,
    };
    let (domain_id, status, kind, cursor, limit) = query;
    let page = async {
        let status = status
            .filter(|v| !v.is_empty())
            .map(|status| transfer_status(&status))
            .transpose()?;
        let kind = kind
            .filter(|v| !v.is_empty())
            .map(|kind| transfer_type(&kind))
            .transpose()?;
        let conditions = vec![
            domain_id
                .filter(|v| !v.is_empty())
                .map(|id| Condition::all().add(domain_transfers::Column::DomainId.eq(id))),
            status.map(|status| Condition::all().add(domain_transfers::Column::Status.eq(status))),
            kind.map(|kind| Condition::all().add(domain_transfers::Column::Type.eq(kind))),
        ];
        list::<domain_transfers::Entity>(
            &caller.db,
            (
                domain_transfers::Column::CreatedAt,
                domain_transfers::Column::Id,
            ),
            conditions,
            cursor.as_deref().filter(|c| !c.is_empty()),
            limit.unwrap_or(25).min(100),
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
        Err(error) => internal(&error, "Failed to list domain transfers"),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match by_id(&caller.db, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => ApiError::not_found("Domain transfer", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to fetch domain transfer"),
    }
}

/// `createDomainTransferSchema`.
struct NewTransfer {
    domain_id: Option<String>,
    domain_name: String,
    kind: String,
    auth_code: Option<String>,
    from_registrar: Option<String>,
    to_registrar: Option<String>,
}

fn read_new(issues: &mut Issues, body: &Map<String, Value>) -> NewTransfer {
    let domain_id = issues
        .text(body, "domainId", Presence::Nullish, None, None)
        .into_option();
    let domain_name = issues
        .text(body, "domainName", Presence::Required, Some(1), Some(255))
        .into_option()
        .unwrap_or_default();
    let kind = issues
        .choice(body, "type", Presence::Required, &TYPES)
        .into_option()
        .unwrap_or_default();
    let mut optional = |key: &str| {
        issues
            .text(body, key, Presence::Optional, None, Some(255))
            .into_option()
    };
    NewTransfer {
        domain_id,
        domain_name,
        kind,
        auth_code: optional("authCode"),
        from_registrar: optional("fromRegistrar"),
        to_registrar: optional("toRegistrar"),
    }
}

/// Why a create failed after the row went in: Realtime Register refused
/// (400 with its message), or anything else (500).
enum CreateError {
    Registrar(RtrError),
    Other(String),
}

impl From<DbErr> for CreateError {
    fn from(error: DbErr) -> Self {
        Self::Other(error.to_string())
    }
}

/// `mapRtrTransferStatus`.
fn map_status(status: &str) -> &'static str {
    match status.to_lowercase().as_str() {
        "completed" => "completed",
        "failed" | "rejected" | "cancelled" => "failed",
        "approved" => "approved",
        "pendingfoa" | "pendingwhois" | "pendingvalidation" => "pending_approval",
        _ => "in_progress",
    }
}

/// The incoming transfer at Realtime Register, and the rows it updates.
async fn start_incoming(
    caller: &Caller,
    rtr: &RealtimeRegistrar,
    contacts: &crate::registrar::ContactEnv,
    id: &str,
    input: &NewTransfer,
    nameservers: Option<&Value>,
    registrant_contact: Option<&Value>,
) -> Result<(), CreateError> {
    let name = input.domain_name.to_lowercase();
    let Some((registrant, roles)) = platform_contacts(contacts) else {
        return Err(CreateError::Other(
            "REALTIME_REGISTER_CONTACT_ADMIN is not set — WeldHost registers domains on platform contacts so customers are not emailed by the registrar or TLD".to_owned(),
        ));
    };
    let privacy = privacy_protect_for_domain(&input.domain_name);
    let mut request = Map::new();
    request.insert("name".to_owned(), json!(name));
    request.insert("registrant".to_owned(), json!(registrant));
    if let Some(code) = &input.auth_code {
        request.insert("authCode".to_owned(), json!(code));
    }
    request.insert("contacts".to_owned(), roles);
    if let Some(nameservers) = nameservers.filter(|n| !n.is_null()) {
        request.insert("nameservers".to_owned(), nameservers.clone());
    }
    request.insert("privacyProtect".to_owned(), json!(privacy));
    request.insert("designatedAgent".to_owned(), json!("NONE"));
    request.insert("periodMonths".to_owned(), json!(12));
    let result = rtr
        .transfer(&Value::Object(request))
        .await
        .map_err(CreateError::Registrar)?;
    let Some(status) = result.status.as_deref() else {
        return Err(CreateError::Other(
            "Cannot read properties of undefined (reading 'toLowerCase')".to_owned(),
        ));
    };
    let status = map_status(status);
    let external = result.process_id.to_string();
    let effective_privacy = result.privacy_protect;
    let at = utc_now();
    let db = orm(&caller.db);
    let mut domain_id = input.domain_id.clone();
    match domain_id.as_deref().filter(|id| !id.is_empty()) {
        None => {
            let parts: Vec<&str> = name.split('.').collect();
            let new_id = generate_id("dom");
            let domain = domains::ActiveModel {
                id: Set(new_id.clone()),
                name: Set(parts.first().copied().unwrap_or_default().to_owned()),
                tld: Set(parts.get(1..).map(|p| p.join(".")).unwrap_or_default()),
                full_domain: Set(name.clone()),
                registrar: Set(Some("realtimeregister".to_owned())),
                status: Set(HostDomainStatus::Pending),
                registration_status: Set(Some(HostDomainRegistrationStatus::PendingTransfer)),
                privacy_protection: Set(Some(effective_privacy)),
                rtr_registrant_handle: Set(Some(registrant.clone())),
                rtr_process_id: Set(Some(external.clone())),
                auth_code: Set(input.auth_code.clone()),
                registrant_contact: Set(registrant_contact.filter(|c| !c.is_null()).cloned()),
                ..Default::default()
            };
            domains::Entity::insert(domain)
                .exec_without_returning(&db)
                .await?;
            domain_id = Some(new_id);
        }
        Some(existing) => {
            let mut domain = domains::ActiveModel {
                registration_status: Set(Some(HostDomainRegistrationStatus::PendingTransfer)),
                rtr_process_id: Set(Some(external.clone())),
                rtr_registrant_handle: Set(Some(registrant.clone())),
                privacy_protection: Set(Some(effective_privacy)),
                updated_at: Set(at),
                ..Default::default()
            };
            if registrant_contact.is_some_and(|c| crate::js::truthy(Some(c))) {
                domain.registrant_contact = Set(registrant_contact.cloned());
            }
            domains::Entity::update_many()
                .set(domain)
                .filter(domains::Column::Id.eq(existing))
                .exec(&db)
                .await?;
        }
    }
    domain_transfers::Entity::update_many()
        .set(domain_transfers::ActiveModel {
            domain_id: Set(domain_id),
            status: Set(transfer_status(status)?),
            to_registrar: Set(Some("realtimeregister".to_owned())),
            external_transfer_id: Set(Some(external)),
            registrar_response: Set(Some(result.response)),
            updated_at: Set(at),
            ..Default::default()
        })
        .filter(domain_transfers::Column::Id.eq(id))
        .exec(&db)
        .await?;
    Ok(())
}

#[allow(clippy::too_many_lines)] // the guard, the row, the registrar, the mapping
async fn create(
    State(state): State<HostState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_new) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let result: Result<Response, CreateError> = async {
        if input.kind == "outgoing" {
            let by_id = match input.domain_id.as_deref().filter(|id| !id.is_empty()) {
                Some(id) => is_domain_used(&caller.db, id).await?,
                None => false,
            };
            if by_id || is_domain_name_used(&caller.db, &input.domain_name).await? {
                return Ok(domain_in_use());
            }
        }
        let providers = caller.providers(&state);
        let mut registrant_contact: Option<Value> = None;
        let mut nameservers: Option<Value> = None;
        if let Some(domain_id) = input.domain_id.as_deref().filter(|id| !id.is_empty()) {
            let domain = live_domain(&caller.db, domain_id).await?;
            registrant_contact = domain
                .as_ref()
                .and_then(|d| d.get("registrantContact"))
                .filter(|c| !c.is_null())
                .cloned();
            nameservers = domain
                .as_ref()
                .and_then(|d| d.get("nameservers"))
                .filter(|n| !n.is_null())
                .cloned();
        }
        let id = generate_id("txfr");
        let to_registrar = input
            .to_registrar
            .clone()
            .or_else(|| (input.kind == "incoming").then(|| "realtimeregister".to_owned()));
        let transfer = domain_transfers::ActiveModel {
            id: Set(id.clone()),
            domain_id: Set(input.domain_id.clone()),
            domain_name: Set(input.domain_name.to_lowercase()),
            type_: Set(transfer_type(&input.kind)?),
            status: Set(HostDomainTransferStatus::Pending),
            auth_code: Set(input.auth_code.clone()),
            from_registrar: Set(input.from_registrar.clone()),
            to_registrar: Set(to_registrar),
            ..Default::default()
        };
        domain_transfers::Entity::insert(transfer)
            .exec_without_returning(&orm(&caller.db))
            .await?;
        if input.kind == "incoming"
            && let Some(rtr) = &providers.rtr
        {
            let started = start_incoming(
                &caller,
                rtr,
                &providers.contacts,
                &id,
                &input,
                nameservers.as_ref(),
                registrant_contact.as_ref(),
            )
            .await;
            if let Err(error) = started {
                let message = match &error {
                    CreateError::Registrar(e) => e.message.clone(),
                    CreateError::Other(message) => message.clone(),
                };
                set_failed(&caller.db, &id, &message).await?;
                return Err(error);
            }
        }
        let row = by_id(&caller.db, &id).await?.unwrap_or(Value::Null);
        if let (Some(external), Some(cache)) =
            (text(&row, "externalTransferId"), caller.cache(&state))
            && let Some(org) = caller.clerk_org_id.as_deref()
        {
            // The webhook reads the mapping back; keys in the worker's order.
            let mapping = format!(
                "{{\"workspaceId\":{},\"transferId\":{},\"domainId\":{},\"kind\":\"transfer\"}}",
                json!(org),
                row["id"],
                row["domainId"]
            );
            if let Err(error) = cache
                .put_boxed(
                    &format!("rtr:process:{external}"),
                    &mapping,
                    Some(MAPPING_TTL),
                )
                .await
            {
                return Err(CreateError::Other(error.to_string()));
            }
        }
        caller.publish(&state, DOMAIN_TRANSFER_CREATED, &id, &event_data(&row));
        Ok(Created(row).into_response())
    }
    .await;
    match result {
        Ok(response) => response,
        Err(CreateError::Registrar(error)) => {
            tracing::error!(%error, "[app-api/domain-transfers] RTR create failed");
            ApiError::bad_request(error.message).into_response()
        }
        Err(CreateError::Other(error)) => internal(&error, "Failed to create domain transfer"),
    }
}

/// `status = 'failed', failureReason = reason`.
async fn set_failed(db: &PgPool, id: &str, reason: &str) -> Result<(), DbErr> {
    domain_transfers::Entity::update_many()
        .set(domain_transfers::ActiveModel {
            status: Set(HostDomainTransferStatus::Failed),
            failure_reason: Set(Some(reason.to_owned())),
            updated_at: Set(utc_now()),
            ..Default::default()
        })
        .filter(domain_transfers::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// `completeDomainTransfer`.
pub(crate) async fn complete_transfer(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    if by_id(db, id).await?.is_none() {
        return Ok(None);
    }
    let at = utc_now();
    domain_transfers::Entity::update_many()
        .set(domain_transfers::ActiveModel {
            status: Set(HostDomainTransferStatus::Completed),
            completed_at: Set(Some(at)),
            updated_at: Set(at),
            ..Default::default()
        })
        .filter(domain_transfers::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    by_id(db, id).await
}

/// `failDomainTransfer`.
async fn fail_transfer(db: &PgPool, id: &str, reason: &str) -> Result<Option<Value>, DbErr> {
    if by_id(db, id).await?.is_none() {
        return Ok(None);
    }
    set_failed(db, id, reason).await?;
    by_id(db, id).await
}

/// Why a registrar sync failed.
pub(crate) enum SyncError {
    Db(DbErr),
    Registrar(RtrError),
    /// `new Date(text)` was an Invalid Date.
    InvalidDate,
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Db(error) => error.fmt(f),
            Self::Registrar(error) => error.fmt(f),
            Self::InvalidDate => f.write_str("RangeError: Invalid time value"),
        }
    }
}

impl From<DbErr> for SyncError {
    fn from(error: DbErr) -> Self {
        Self::Db(error)
    }
}

/// `syncTransferFromRegistrar`.
pub(crate) async fn sync_from_registrar(
    db: &PgPool,
    rtr: &RealtimeRegistrar,
    id: &str,
) -> Result<Option<Value>, SyncError> {
    let transfer = by_id(db, id).await?;
    let Some(transfer) = transfer else {
        return Ok(None);
    };
    let Some(external) = text(&transfer, "externalTransferId").filter(|e| !e.is_empty()) else {
        return Ok(Some(transfer));
    };
    let Some(process_id) = parse_int(external) else {
        return Ok(Some(transfer));
    };
    match rtr
        .poll_process(process_id)
        .await
        .map_err(SyncError::Registrar)?
    {
        Outcome::Pending => return Ok(Some(transfer)),
        Outcome::Failed => {
            return Ok(fail_transfer(db, id, "Realtime Register process failed").await?);
        }
        Outcome::Completed => {}
    }
    let domain_name = text(&transfer, "domainName").unwrap_or_default();
    let remote = rtr.get_domain(domain_name).await.ok();
    if let Some(domain_id) = text(&transfer, "domainId") {
        let at = utc_now();
        let expires = remote
            .as_ref()
            .and_then(|r| r.expires_at.as_deref())
            .filter(|e| !e.is_empty())
            .map(|e| weldsuite_kit::validation::js_date_iso(e).ok_or(SyncError::InvalidDate))
            .transpose()?
            .map(|iso| timestamp_of(&iso))
            .transpose()?;
        let mut domain = domains::ActiveModel {
            status: Set(HostDomainStatus::Active),
            registration_status: Set(Some(HostDomainRegistrationStatus::Transferred)),
            registrar: Set(Some("realtimeregister".to_owned())),
            external_registrar_id: Set(Some(
                remote
                    .as_ref()
                    .map_or(domain_name, |r| r.id.as_str())
                    .to_owned(),
            )),
            registrar_synced_at: Set(Some(at)),
            updated_at: Set(at),
            ..Default::default()
        };
        if let Some(remote) = &remote {
            domain.registrar_status = Set(Some(remote.status.join(",")));
            domain.locked = Set(Some(remote.locked));
            domain.auto_renew = Set(Some(remote.auto_renew));
        }
        if let Some(expires) = expires {
            domain.expires_at = Set(Some(expires));
        }
        domains::Entity::update_many()
            .set(domain)
            .filter(domains::Column::Id.eq(domain_id))
            .exec(&orm(db))
            .await?;
    }
    Ok(complete_transfer(db, id).await?)
}

async fn complete(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    match complete_transfer(&caller.db, &id).await {
        Ok(Some(row)) => {
            caller.publish(&state, DOMAIN_TRANSFER_UPDATED, &id, &event_data(&row));
            Data(row).into_response()
        }
        Ok(None) => ApiError::not_found("Domain transfer", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to complete domain transfer"),
    }
}

async fn sync(State(state): State<HostState>, caller: Caller, Path(id): Path<String>) -> Response {
    let providers = caller.providers(&state);
    let Some(rtr) = &providers.rtr else {
        return rtr_unconfigured();
    };
    match sync_from_registrar(&caller.db, rtr, &id).await {
        Ok(Some(row)) => {
            let row_id = text(&row, "id").unwrap_or_default().to_owned();
            caller.publish(&state, DOMAIN_TRANSFER_UPDATED, &row_id, &event_data(&row));
            Data(row).into_response()
        }
        Ok(None) => ApiError::not_found("Domain transfer", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to sync domain transfer"),
    }
}

async fn fail(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let reason = match validate(&headers, &body, |issues, body| {
        issues.text(body, "reason", Presence::Optional, None, Some(2000))
    }) {
        Ok(Field::Set(reason)) => reason,
        Ok(_) => "Unknown error".to_owned(),
        Err(response) => return *response,
    };
    match fail_transfer(&caller.db, &id, &reason).await {
        Ok(Some(row)) => {
            caller.publish(&state, DOMAIN_TRANSFER_UPDATED, &id, &event_data(&row));
            Data(row).into_response()
        }
        Ok(None) => ApiError::not_found("Domain transfer", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to mark domain transfer as failed"),
    }
}
