//! `/api/reach/domains` (`routes/domains`, `services/domains.ts`): WeldHost
//! domains connected to Mailpool through its Cloudflare integration. The
//! name is never taken from the client: a connect resolves the WeldHost
//! domain in this workspace's tenant database and re-runs every guard.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{
    REACH_DOMAIN_CONNECTED, REACH_DOMAIN_DISCONNECTED, REACH_DOMAIN_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::orm;
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::OutboundHttp;
use weldsuite_reach_domain::schemas::Limits;
use weldsuite_reach_domain::{EventSink, ReachError, ReachEvent, ReachResult, domains, iso, text};
use weldsuite_schema::master::reach_routes;
use weldsuite_schema::tenant::enums::HostDnsProvider;
use weldsuite_schema::tenant::{dns_zones, domains as host_domains, reach_domains};

use crate::dnscheck::{DnsLookupError, evaluate, footprint};
use crate::mailpool::{Mailpool, id_text, not_configured, upstream};
use crate::{Caller, ReachState, account_workspace, db_error, respond, row_json, validate};

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ReachState> {
    let read = || gate.require([perm::REACH_MAILBOXES_READ]);
    Router::new()
        .route(
            "/",
            get(list)
                .route_layer(read())
                .merge(post(connect).route_layer(gate.require([perm::REACH_MAILBOXES_CREATE]))),
        )
        .route("/candidates", get(candidates).route_layer(read()))
        .route(
            "/{id}",
            get(read_one).route_layer(read()).merge(
                axum::routing::delete(disconnect)
                    .route_layer(gate.require([perm::REACH_MAILBOXES_DELETE])),
            ),
        )
        .route(
            "/{id}/refresh-dns",
            post(refresh_dns).route_layer(gate.require([perm::REACH_MAILBOXES_UPDATE])),
        )
}

fn listed(items: Vec<Value>) -> Response {
    let n = items.len() as u64;
    List::new(items, Pagination::new(n, false, None)).into_response()
}

/// `createMailpoolClient(c.env)`, or 503 without the key.
pub(crate) fn mailpool_of(caller: &Caller, state: &ReachState) -> ReachResult<Mailpool> {
    Mailpool::new(
        caller.env("MAILPOOL_API_KEY"),
        caller.env("MAILPOOL_API_URL"),
        caller.http(state),
    )
    .ok_or_else(not_configured)
}

async fn list(caller: Caller) -> Response {
    respond(domains::list(&caller.db).await.map(listed))
}

async fn read_one(caller: Caller, Path(id): Path<String>) -> Response {
    respond(
        domains::get(&caller.db, &id)
            .await
            .map(|d| Data(d).into_response()),
    )
}

/// The guard inputs (`GuardContext`).
struct Guards {
    connected_host_ids: Vec<String>,
    connected_count: i64,
    cloudflare_host_ids: Vec<String>,
}

async fn guards(db: &PgPool, host_ids: &[String]) -> ReachResult<Guards> {
    let connected: Vec<String> = reach_domains::Entity::find()
        .select_only()
        .column(reach_domains::Column::HostDomainId)
        .into_tuple()
        .all(&orm(db))
        .await
        .map_err(db_error)?;
    let zones: Vec<String> = if host_ids.is_empty() {
        Vec::new()
    } else {
        dns_zones::Entity::find()
            .select_only()
            .column(dns_zones::Column::DomainId)
            .filter(dns_zones::Column::DomainId.is_in(host_ids))
            .filter(dns_zones::Column::Provider.eq(HostDnsProvider::Cloudflare))
            .filter(dns_zones::Column::ExternalZoneId.is_not_null())
            .filter(dns_zones::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(db))
            .await
            .map_err(db_error)?
    };
    Ok(Guards {
        connected_count: connected.len() as i64,
        connected_host_ids: connected,
        cloudflare_host_ids: zones,
    })
}

fn is_force_allowed(host: &Value, limits: &Limits) -> bool {
    limits
        .force_allow_domains
        .contains(&text(host, "fullDomain").unwrap_or_default().to_lowercase())
}

/// `ineligibleReason(host, g, onDnsFailure)`.
async fn ineligible_reason(
    host: &Value,
    g: &Guards,
    limits: &Limits,
    http: &OutboundHttp,
    throw_dns: bool,
) -> Result<Option<&'static str>, DnsLookupError> {
    let id = text(host, "id").unwrap_or_default();
    if g.connected_host_ids.iter().any(|h| h == id) {
        return Ok(Some("already_connected"));
    }
    if text(host, "status") != Some("active") {
        return Ok(Some("not_active"));
    }
    let on_cloudflare = g.cloudflare_host_ids.iter().any(|h| h == id)
        || text(host, "registrar").is_some_and(|r| r.to_lowercase() == "cloudflare")
        || host.get("nameserverVerified").and_then(Value::as_bool) == Some(true);
    if !on_cloudflare {
        return Ok(Some("not_on_cloudflare"));
    }
    if g.connected_count >= limits.max_domains {
        return Ok(Some("limit_reached"));
    }
    if is_force_allowed(host, limits) {
        return Ok(None);
    }
    match footprint(http, text(host, "fullDomain").unwrap_or_default()).await {
        Ok((true, _)) => Ok(Some("has_mx")),
        Ok((_, true)) => Ok(Some("has_website")),
        Err(error) if throw_dns => Err(error),
        Ok(_) | Err(_) => Ok(None),
    }
}

/// `ineligibleError(reason)`.
fn ineligible_error(reason: &str) -> ReachError {
    let message = match reason {
        "already_connected" => "This domain is already connected.",
        "not_active" => "This domain is not active in WeldHost yet.",
        "not_on_cloudflare" => {
            "This domain is not managed on WeldHost nameservers. Point its nameservers to WeldHost first."
        }
        "limit_reached" => "The domain limit for this workspace is reached.",
        "has_mx" => {
            "This domain already has email set up (MX records). Connecting it would replace that. Use a separate domain for outreach."
        }
        _ => {
            "This domain already serves a website. Connecting it would break the site. Use a separate domain for outreach."
        }
    };
    let code = if reason == "already_connected" {
        "DOMAIN_ALREADY_CONNECTED"
    } else {
        "DOMAIN_NOT_ELIGIBLE"
    };
    let status = if reason == "already_connected" {
        409
    } else {
        422
    };
    ReachError::new(status, code, message).with_details(json!({ "reason": reason }))
}

async fn candidates(State(state): State<ReachState>, caller: Caller) -> Response {
    respond(
        async {
            let (_, limits) = account_workspace(&caller)?;
            let hosts = host_domains::Entity::find()
                .filter(host_domains::Column::DeletedAt.is_null())
                .order_by_asc(host_domains::Column::FullDomain)
                .all(&orm(&caller.db))
                .await
                .map_err(db_error)?
                .into_iter()
                .map(row_json)
                .collect::<ReachResult<Vec<Value>>>()?;
            let ids: Vec<String> = hosts
                .iter()
                .filter_map(|h| text(h, "id").map(str::to_owned))
                .collect();
            let g = guards(&caller.db, &ids).await?;
            let http = caller.http(&state);
            let mut out = Vec::with_capacity(hosts.len());
            for host in &hosts {
                let reason = ineligible_reason(host, &g, &limits, &http, false)
                    .await
                    .unwrap_or(None);
                out.push(json!({
                    "hostDomainId": text(host, "id"),
                    "name": text(host, "fullDomain"),
                    "hostStatus": text(host, "status"),
                    "eligible": reason.is_none(),
                    "reason": reason,
                }));
            }
            Ok(listed(out))
        }
        .await,
    )
}

async fn connect(
    State(state): State<ReachState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let host_domain_id = match validate(&headers, &body, |issues, body| {
        issues
            .text_with(
                body,
                "hostDomainId",
                Presence::Required,
                Text::length(Some(1), Some(30)),
            )
            .into_option()
    }) {
        Ok(Some(id)) => id,
        Ok(None) => return weldsuite_kit::ApiError::internal().into_response(),
        Err(response) => return response,
    };
    respond(
        async {
            let (workspace_id, limits) = account_workspace(&caller)?;
            let master = crate::require_master(&caller, &state)?;
            let mailpool = mailpool_of(&caller, &state)?;
            let row = connect_domain(
                &caller,
                &state,
                &master,
                &mailpool,
                &workspace_id,
                &limits,
                &host_domain_id,
            )
            .await?;
            caller.sink(&state).emit(ReachEvent::new(
                REACH_DOMAIN_CONNECTED,
                text(&row, "id").unwrap_or_default(),
                row.clone(),
            ));
            Ok((StatusCode::CREATED, Data(domains::to_dto(&row, 0))).into_response())
        }
        .await,
    )
}

/// `connectDomain(deps, hostDomainId)`.
async fn connect_domain(
    caller: &Caller,
    state: &ReachState,
    master: &PgPool,
    mailpool: &Mailpool,
    workspace_id: &str,
    limits: &Limits,
    host_domain_id: &str,
) -> ReachResult<Value> {
    let db = &caller.db;
    let now = caller.now();
    let host = host_domains::Entity::find_by_id(host_domain_id.to_owned())
        .filter(host_domains::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await
        .map_err(db_error)?
        .map(row_json)
        .transpose()?;
    let Some(host) = host else {
        return Err(ReachError::new(
            404,
            "DOMAIN_NOT_FOUND",
            format!("Domain with ID '{host_domain_id}' not found"),
        ));
    };
    let host_id = text(&host, "id").unwrap_or_default().to_owned();
    let g = guards(db, std::slice::from_ref(&host_id)).await?;
    let http = caller.http(state);
    if let Some(reason) = ineligible_reason(&host, &g, limits, &http, true)
        .await
        .map_err(DnsLookupError::into_reach)?
    {
        return Err(ineligible_error(reason));
    }
    let name = text(&host, "fullDomain").unwrap_or_default().to_lowercase();
    let forced = is_force_allowed(&host, limits);
    let (connected, skipped) = mailpool
        .connect_cloudflare_domains(std::slice::from_ref(&name))
        .await
        .map_err(|e| upstream(&e))?;
    let Some(connected) = connected
        .iter()
        .find(|c| text(c, "domain").is_some_and(|d| d.to_lowercase() == name))
    else {
        let skip = skipped.iter().find(|s| {
            text(s, "domain")
                .or_else(|| text(s, "name"))
                .unwrap_or_default()
                .to_lowercase()
                == name
        });
        let reason = skip
            .and_then(|s| text(s, "reason"))
            .filter(|r| !r.is_empty());
        let detail = reason.map_or_else(|| ".".to_owned(), |r| format!(": {r}"));
        return Err(ReachError::new(
            422,
            "DOMAIN_CONNECT_FAILED",
            format!("The mailbox provider could not connect {name}{detail}"),
        )
        .with_details(json!({ "reason": skip.and_then(|s| text(s, "reason")) })));
    };
    let mailpool_domain_id = id_text(connected);
    let status = if text(connected, "status").is_some_and(|s| s.to_lowercase() == "active") {
        "active"
    } else {
        "connecting"
    };
    let domain_id = generate_id("rdom");
    let inserted = reach_domains::Entity::insert(reach_domains::ActiveModel {
        id: Set(domain_id.clone()),
        host_domain_id: Set(host_id.clone()),
        name: Set(name.clone()),
        mailpool_domain_id: Set(Some(mailpool_domain_id.clone())),
        status: Set(status.to_owned()),
        forced_by: Set(forced.then(|| "admin_console".to_owned())),
        connected_at: Set(Some(now)),
        connected_by: Set(Some(caller.user_id.clone())),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await;
    let row = match inserted {
        Ok(row) => row_json(row)?,
        Err(error) => {
            drop_from_mailpool(mailpool, &mailpool_domain_id).await;
            if weldsuite_db::is_unique_violation(&error) {
                return Err(ineligible_error("already_connected"));
            }
            return Err(db_error(error));
        }
    };
    let routed = reach_routes::Entity::insert(reach_routes::ActiveModel {
        id: Set(generate_id("rrt")),
        kind: Set("mailpool_domain".to_owned()),
        external_id: Set(mailpool_domain_id.clone()),
        workspace_id: Set(workspace_id.to_owned()),
        clerk_org_id: Set(caller.clerk_org_id.clone()),
        tenant_entity_id: Set(domain_id.clone()),
        status: Set("active".to_owned()),
        ..Default::default()
    })
    .on_conflict(
        OnConflict::columns([reach_routes::Column::Kind, reach_routes::Column::ExternalId])
            .value(
                reach_routes::Column::TenantEntityId,
                Expr::value(&domain_id),
            )
            .value(
                reach_routes::Column::ClerkOrgId,
                Expr::value(&caller.clerk_org_id),
            )
            .value(reach_routes::Column::Status, Expr::value("active"))
            .value(reach_routes::Column::UpdatedAt, Expr::value(now))
            .action_and_where(reach_routes::Column::WorkspaceId.eq(workspace_id))
            .to_owned(),
    )
    .exec_with_returning_many(&orm(master))
    .await;
    match routed {
        Ok(rows) if rows.is_empty() => {
            delete_domain_row(db, &domain_id).await?;
            Err(ReachError::new(
                409,
                "DOMAIN_IN_USE",
                "This domain is connected in another workspace.",
            ))
        }
        Ok(_) => Ok(row),
        Err(error) => {
            delete_domain_row(db, &domain_id).await?;
            drop_from_mailpool(mailpool, &mailpool_domain_id).await;
            Err(db_error(error))
        }
    }
}

/// `delete from reach_domains where id = …`.
async fn delete_domain_row(db: &PgPool, id: &str) -> ReachResult<()> {
    reach_domains::Entity::delete_by_id(id.to_owned())
        .exec(&orm(db))
        .await
        .map_err(db_error)?;
    Ok(())
}

async fn drop_from_mailpool(mailpool: &Mailpool, mailpool_domain_id: &str) {
    if let Err(error) = mailpool.delete_domain(mailpool_domain_id).await {
        tracing::error!(
            ?error,
            mailpool_domain_id,
            "[reach-domains] rollback: could not delete Mailpool domain"
        );
    }
}

/// `dmarcPolicyOf(records)`.
fn dmarc_policy_of(records: &[Value]) -> Option<String> {
    let key_re = regex::Regex::new(r"(?i)(^|\.)_dmarc(\.|$)").ok()?;
    let policy_re = regex::Regex::new(r"(?i)(?:^|;)\s*p=(none|quarantine|reject)").ok()?;
    records.iter().find_map(|record| {
        if text(record, "type") != Some("TXT")
            || !key_re.is_match(text(record, "key").unwrap_or_default())
        {
            return None;
        }
        policy_re
            .captures(text(record, "value").unwrap_or_default())
            .map(|caps| caps[1].to_lowercase())
    })
}

async fn refresh_dns(
    State(state): State<ReachState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    respond(
        async {
            account_workspace(&caller)?;
            crate::require_master(&caller, &state)?;
            let mailpool = mailpool_of(&caller, &state)?;
            let db = &caller.db;
            let row = domains::require(db, &id).await?;
            let Some(mailpool_id) = text(&row, "mailpoolDomainId").map(str::to_owned) else {
                return Err(ReachError::new(
                    409,
                    "DOMAIN_NOT_CONNECTED",
                    "The domain is not connected yet.",
                ));
            };
            let remote = mailpool.get_domain(&mailpool_id).await;
            let records = mailpool.get_domain_dns(&mailpool_id).await;
            let (remote, records) = (
                remote.map_err(|e| upstream(&e))?,
                records.map_err(|e| upstream(&e))?,
            );
            let now = caller.now();
            let dns_status = evaluate(
                &caller.http(&state),
                text(&row, "name").unwrap_or_default(),
                &records,
                &iso(now),
            )
            .await
            .map_err(DnsLookupError::into_reach)?;
            let current = text(&row, "status").unwrap_or_default();
            let (status, last_error) = if current == "disconnecting" {
                (current.to_owned(), None)
            } else {
                match text(&remote, "status") {
                    Some("inactive") => (
                        "error".to_owned(),
                        Some(
                            remote
                                .pointer("/error/message")
                                .and_then(Value::as_str)
                                .unwrap_or("The mailbox provider disabled this domain.")
                                .to_owned(),
                        ),
                    ),
                    Some("active") => ("active".to_owned(), None),
                    _ => ("connecting".to_owned(), None),
                }
            };
            let policy =
                dmarc_policy_of(&records).or_else(|| text(&row, "dmarcPolicy").map(str::to_owned));
            let updated = reach_domains::Entity::update_many()
                .col_expr(reach_domains::Column::Status, Expr::value(&status))
                .col_expr(reach_domains::Column::LastError, Expr::value(last_error))
                .col_expr(reach_domains::Column::DnsStatus, Expr::value(dns_status))
                .col_expr(reach_domains::Column::DmarcPolicy, Expr::value(policy))
                .col_expr(reach_domains::Column::UpdatedAt, Expr::value(caller.now()))
                .filter(reach_domains::Column::Id.eq(&id))
                .exec_with_returning(&orm(db))
                .await
                .map_err(db_error)?
                .into_iter()
                .next()
                .map(row_json)
                .transpose()?;
            let updated = updated.unwrap_or(row);
            caller
                .sink(&state)
                .emit(ReachEvent::new(REACH_DOMAIN_UPDATED, &id, updated.clone()));
            Ok(Data(domains::get(db, text(&updated, "id").unwrap_or(&id)).await?).into_response())
        }
        .await,
    )
}

async fn disconnect(
    State(state): State<ReachState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    respond(
        async {
            let (workspace_id, _) = account_workspace(&caller)?;
            let master = crate::require_master(&caller, &state)?;
            let mailpool = mailpool_of(&caller, &state)?;
            let db = &caller.db;
            let row = domains::require(db, &id).await?;
            let count = domains::mailbox_counts(db, std::slice::from_ref(&id))
                .await?
                .first()
                .map_or(0, |(_, n)| *n);
            if count > 0 {
                return Err(ReachError::new(
                    409,
                    "DOMAIN_HAS_MAILBOXES",
                    "Delete the mailboxes on this domain before disconnecting it.",
                )
                .with_details(json!({ "mailboxCount": count })));
            }
            let at = caller.now();
            set_domain_status(db, &id, Some("disconnecting"), at).await?;
            if let Some(mailpool_id) = text(&row, "mailpoolDomainId") {
                if let Err(error) = mailpool.delete_domain(mailpool_id).await
                    && !error.is_not_found()
                {
                    set_domain_status(db, &id, text(&row, "status"), at).await?;
                    return Err(upstream(&error));
                }
                reach_routes::Entity::update_many()
                    .col_expr(reach_routes::Column::Status, Expr::value("deleted"))
                    .col_expr(reach_routes::Column::UpdatedAt, Expr::value(at))
                    .filter(reach_routes::Column::Kind.eq("mailpool_domain"))
                    .filter(reach_routes::Column::ExternalId.eq(mailpool_id))
                    .filter(reach_routes::Column::WorkspaceId.eq(&workspace_id))
                    .exec(&orm(&master))
                    .await
                    .map_err(db_error)?;
            }
            delete_domain_row(db, &id).await?;
            caller
                .sink(&state)
                .emit(ReachEvent::new(REACH_DOMAIN_DISCONNECTED, &id, row));
            Ok(NoContent.into_response())
        }
        .await,
    )
}

/// `update reach_domains set status = …, updated_at = … where id = …`.
async fn set_domain_status(
    db: &PgPool,
    id: &str,
    status: Option<&str>,
    at: time::OffsetDateTime,
) -> ReachResult<()> {
    reach_domains::Entity::update_many()
        .col_expr(
            reach_domains::Column::Status,
            Expr::value(status.map(str::to_owned)),
        )
        .col_expr(reach_domains::Column::UpdatedAt, Expr::value(at))
        .filter(reach_domains::Column::Id.eq(id))
        .exec(&orm(db))
        .await
        .map_err(db_error)?;
    Ok(())
}
