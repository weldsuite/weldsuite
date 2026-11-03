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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{DOMAIN_TRANSFER_CREATED, DOMAIN_TRANSFER_UPDATED};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, List, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::dns_zones::limit_param;
use crate::js::{parse_int, text};
use crate::listing::{ListSql, keyset, list};
use crate::registrar::{
    Outcome, RealtimeRegistrar, RtrError, platform_contacts, privacy_protect_for_domain,
};
use crate::rows::{live_domain, one};
use crate::weldreach::{domain_in_use, is_domain_name_used, is_domain_used};
use crate::{Caller, HostState, error_response, internal, now, validate, validate_query};

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

const LIST: ListSql = ListSql {
    cursor: "select to_jsonb(t.created_at)#>>'{}', t.id from domain_transfers t where t.id = $1 limit 1",
    page: concat!(
        "select to_jsonb(t) from domain_transfers t where ($1::boolean or true)",
        " and ($2::boolean or t.domain_id = $3)",
        " and ($4::boolean or t.status = $5::host_domain_transfer_status)",
        " and ($6::boolean or t.type = $7::host_domain_transfer_type)",
        " and ",
        keyset!(8, 9, 10),
        " order by t.created_at desc, t.id desc limit $11"
    ),
    count: concat!(
        "select count(*)::int from domain_transfers t where ($1::boolean or true)",
        " and ($2::boolean or t.domain_id = $3)",
        " and ($4::boolean or t.status = $5::host_domain_transfer_status)",
        " and ($6::boolean or t.type = $7::host_domain_transfer_type)",
        " and ",
        keyset!(8, 9, 10)
    ),
    live: false,
};

/// How long the webhook's process mapping lives (`expirationTtl`: 14 days).
#[allow(clippy::duration_suboptimal_units)]
const MAPPING_TTL: std::time::Duration = std::time::Duration::from_secs(14 * 86_400);

const BY_ID: &str = "select to_jsonb(t) from domain_transfers t where t.id = $1 limit 1";

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
    let filters = [
        domain_id.filter(|v| !v.is_empty()),
        status.filter(|v| !v.is_empty()),
        kind.filter(|v| !v.is_empty()),
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
        Err(error) => internal(&error, "Failed to list domain transfers"),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match one(&caller.db, BY_ID, &id).await {
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

impl From<sqlx::Error> for CreateError {
    fn from(error: sqlx::Error) -> Self {
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
    let at = now();
    let mut domain_id = input.domain_id.clone();
    match domain_id.as_deref().filter(|id| !id.is_empty()) {
        None => {
            let parts: Vec<&str> = name.split('.').collect();
            let new_id = generate_id("dom");
            sqlx::query(
                "insert into domains (id, name, tld, full_domain, registrar, status,
                   registration_status, privacy_protection, rtr_registrant_handle, rtr_process_id,
                   auth_code, registrant_contact)
                 values ($1, $2, $3, $4, 'realtimeregister', 'pending', 'pending_transfer', $5, $6,
                   $7, $8, $9)",
            )
            .bind(&new_id)
            .bind(parts.first().copied().unwrap_or_default())
            .bind(parts.get(1..).map(|p| p.join(".")).unwrap_or_default())
            .bind(&name)
            .bind(effective_privacy)
            .bind(&registrant)
            .bind(&external)
            .bind(input.auth_code.as_deref())
            .bind(registrant_contact.filter(|c| !c.is_null()).cloned())
            .execute(&caller.db)
            .await?;
            domain_id = Some(new_id);
        }
        Some(existing) => {
            let existing = existing.to_owned();
            sqlx::query(
                "update domains set registration_status = 'pending_transfer', rtr_process_id = $2,
                   rtr_registrant_handle = $3, privacy_protection = $4,
                   registrant_contact = case when $5 then $6 else registrant_contact end,
                   updated_at = $7::timestamp
                 where id = $1",
            )
            .bind(&existing)
            .bind(&external)
            .bind(&registrant)
            .bind(effective_privacy)
            .bind(registrant_contact.is_some_and(|c| crate::js::truthy(Some(c))))
            .bind(registrant_contact.cloned())
            .bind(&at)
            .execute(&caller.db)
            .await?;
        }
    }
    sqlx::query(
        "update domain_transfers set domain_id = $2, status = $3::host_domain_transfer_status,
           to_registrar = 'realtimeregister', external_transfer_id = $4, registrar_response = $5,
           updated_at = $6::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(domain_id)
    .bind(status)
    .bind(&external)
    .bind(&result.response)
    .bind(&at)
    .execute(&caller.db)
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
        sqlx::query(
            "insert into domain_transfers (id, domain_id, domain_name, type, status, auth_code,
               from_registrar, to_registrar)
             values ($1, $2, $3, $4::host_domain_transfer_type, 'pending', $5, $6, $7)",
        )
        .bind(&id)
        .bind(input.domain_id.as_deref())
        .bind(input.domain_name.to_lowercase())
        .bind(&input.kind)
        .bind(input.auth_code.as_deref())
        .bind(input.from_registrar.as_deref())
        .bind(to_registrar)
        .execute(&caller.db)
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
                sqlx::query(
                    "update domain_transfers set status = 'failed', failure_reason = $2,
                       updated_at = $3::timestamp where id = $1",
                )
                .bind(&id)
                .bind(message)
                .bind(now())
                .execute(&caller.db)
                .await?;
                return Err(error);
            }
        }
        let row = one(&caller.db, BY_ID, &id).await?.unwrap_or(Value::Null);
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

/// `completeDomainTransfer`.
pub(crate) async fn complete_transfer(
    db: &weldsuite_db::PgPool,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    if one(db, BY_ID, id).await?.is_none() {
        return Ok(None);
    }
    let at = now();
    sqlx::query(
        "update domain_transfers set status = 'completed', completed_at = $2::timestamp,
           updated_at = $2::timestamp where id = $1",
    )
    .bind(id)
    .bind(&at)
    .execute(db)
    .await?;
    one(db, BY_ID, id).await
}

/// `failDomainTransfer`.
async fn fail_transfer(
    db: &weldsuite_db::PgPool,
    id: &str,
    reason: &str,
) -> Result<Option<Value>, sqlx::Error> {
    if one(db, BY_ID, id).await?.is_none() {
        return Ok(None);
    }
    sqlx::query(
        "update domain_transfers set status = 'failed', failure_reason = $2,
           updated_at = $3::timestamp where id = $1",
    )
    .bind(id)
    .bind(reason)
    .bind(now())
    .execute(db)
    .await?;
    one(db, BY_ID, id).await
}

/// Why a registrar sync failed.
pub(crate) enum SyncError {
    Db(sqlx::Error),
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

impl From<sqlx::Error> for SyncError {
    fn from(error: sqlx::Error) -> Self {
        Self::Db(error)
    }
}

/// `syncTransferFromRegistrar`.
pub(crate) async fn sync_from_registrar(
    db: &weldsuite_db::PgPool,
    rtr: &RealtimeRegistrar,
    id: &str,
) -> Result<Option<Value>, SyncError> {
    let transfer = one(db, BY_ID, id).await?;
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
        let at = now();
        let expires = remote
            .as_ref()
            .and_then(|r| r.expires_at.as_deref())
            .filter(|e| !e.is_empty())
            .map(|e| weldsuite_kit::validation::js_date_iso(e).ok_or(SyncError::InvalidDate))
            .transpose()?;
        sqlx::query(
            "update domains set status = 'active', registration_status = 'transferred',
               registrar = 'realtimeregister', external_registrar_id = $2,
               registrar_synced_at = $3::timestamp, updated_at = $3::timestamp,
               registrar_status = case when $4 then $5 else registrar_status end,
               expires_at = case when $6 then $7::timestamp else expires_at end,
               locked = case when $4 then $8 else locked end,
               auto_renew = case when $4 then $9 else auto_renew end
             where id = $1",
        )
        .bind(domain_id)
        .bind(remote.as_ref().map_or(domain_name, |r| r.id.as_str()))
        .bind(&at)
        .bind(remote.is_some())
        .bind(remote.as_ref().map(|r| r.status.join(",")))
        .bind(expires.is_some())
        .bind(expires)
        .bind(remote.as_ref().map(|r| r.locked))
        .bind(remote.as_ref().map(|r| r.auto_renew))
        .execute(db)
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
