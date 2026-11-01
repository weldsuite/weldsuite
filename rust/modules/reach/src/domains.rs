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
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{REACH_DOMAIN_CONNECTED, REACH_DOMAIN_DISCONNECTED, REACH_DOMAIN_UPDATED};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{Data, List, NoContent, Pagination, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::OutboundHttp;
use weldsuite_reach_domain::schemas::Limits;
use weldsuite_reach_domain::{EventSink, ReachError, ReachEvent, ReachResult, domains, iso, text};

use crate::dnscheck::{DnsLookupError, evaluate, footprint};
use crate::mailpool::{Mailpool, id_text, not_configured, upstream};
use crate::{Caller, ReachState, account_workspace, respond, validate};

pub(crate) fn routes<Q: PermissionQueries + 'static>(gate: &Arc<PermissionGate<Q>>) -> Router<ReachState> {
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
            get(read_one)
                .route_layer(read())
                .merge(axum::routing::delete(disconnect).route_layer(gate.require([perm::REACH_MAILBOXES_DELETE]))),
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
    Mailpool::new(caller.env("MAILPOOL_API_KEY"), caller.env("MAILPOOL_API_URL"), caller.http(state)).ok_or_else(not_configured)
}

async fn list(caller: Caller) -> Response {
    respond(domains::list(&caller.db).await.map(listed))
}

async fn read_one(caller: Caller, Path(id): Path<String>) -> Response {
    respond(domains::get(&caller.db, &id).await.map(|d| Data(d).into_response()))
}

/// The guard inputs (`GuardContext`).
struct Guards {
    connected_host_ids: Vec<String>,
    connected_count: i64,
    cloudflare_host_ids: Vec<String>,
}

async fn guards(db: &PgPool, host_ids: &[String]) -> ReachResult<Guards> {
    let connected: Vec<String> = sqlx::query_scalar("select host_domain_id from reach_domains")
        .fetch_all(db)
        .await?;
    let zones: Vec<String> = if host_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar(
            "select domain_id from dns_zones where domain_id = any($1) and provider::text = 'cloudflare'
                 and external_zone_id is not null and deleted_at is null",
        )
        .bind(host_ids)
        .fetch_all(db)
        .await?
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
        Ok(_) => Ok(None),
        Err(error) if throw_dns => Err(error),
        Err(_) => Ok(None),
    }
}

/// `ineligibleError(reason)`.
fn ineligible_error(reason: &str) -> ReachError {
    let message = match reason {
        "already_connected" => "This domain is already connected.",
        "not_active" => "This domain is not active in WeldHost yet.",
        "not_on_cloudflare" => "This domain is not managed on WeldHost nameservers. Point its nameservers to WeldHost first.",
        "limit_reached" => "The domain limit for this workspace is reached.",
        "has_mx" => {
            "This domain already has email set up (MX records). Connecting it would replace that. Use a separate domain for outreach."
        }
        _ => "This domain already serves a website. Connecting it would break the site. Use a separate domain for outreach.",
    };
    let code = if reason == "already_connected" {
        "DOMAIN_ALREADY_CONNECTED"
    } else {
        "DOMAIN_NOT_ELIGIBLE"
    };
    let status = if reason == "already_connected" { 409 } else { 422 };
    ReachError::new(status, code, message).with_details(json!({ "reason": reason }))
}

async fn candidates(State(state): State<ReachState>, caller: Caller) -> Response {
    respond(
        async {
            let (_, limits) = account_workspace(&caller)?;
            let hosts = weldsuite_reach_domain::js_rows(
                sqlx::query_scalar("select to_jsonb(t) from domains t where t.deleted_at is null order by t.full_domain")
                    .fetch_all(&caller.db)
                    .await?,
            );
            let ids: Vec<String> = hosts.iter().filter_map(|h| text(h, "id").map(str::to_owned)).collect();
            let g = guards(&caller.db, &ids).await?;
            let http = caller.http(&state);
            let mut out = Vec::with_capacity(hosts.len());
            for host in &hosts {
                let reason = ineligible_reason(host, &g, &limits, &http, false).await.unwrap_or(None);
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

async fn connect(State(state): State<ReachState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let host_domain_id = match validate(&headers, &body, |issues, body| {
        issues
            .text_with(body, "hostDomainId", Presence::Required, Text::length(Some(1), Some(30)))
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
            let row = connect_domain(&caller, &state, &master, &mailpool, &workspace_id, &limits, &host_domain_id).await?;
            caller
                .sink(&state)
                .emit(ReachEvent::new(REACH_DOMAIN_CONNECTED, text(&row, "id").unwrap_or_default(), row.clone()));
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
    let host: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from domains t where t.id = $1 and t.deleted_at is null limit 1")
            .bind(host_domain_id)
            .fetch_optional(db)
            .await?;
    let Some(host) = host.map(weldsuite_db::js_row) else {
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
        let reason = skip.and_then(|s| text(s, "reason")).filter(|r| !r.is_empty());
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
    let inserted: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "insert into reach_domains (id, host_domain_id, name, mailpool_domain_id, status, forced_by, connected_at, connected_by)
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8) returning to_jsonb(reach_domains)",
    )
    .bind(&domain_id)
    .bind(&host_id)
    .bind(&name)
    .bind(&mailpool_domain_id)
    .bind(status)
    .bind(forced.then_some("admin_console"))
    .bind(iso(now))
    .bind(&caller.user_id)
    .fetch_one(db)
    .await;
    let row = match inserted {
        Ok(row) => weldsuite_db::js_row(row),
        Err(error) => {
            drop_from_mailpool(mailpool, &mailpool_domain_id).await;
            if weldsuite_db::is_unique_violation(&error) {
                return Err(ineligible_error("already_connected"));
            }
            return Err(error.into());
        }
    };
    let routed: Result<Vec<String>, sqlx::Error> = sqlx::query_scalar(
        "insert into reach_routes (id, kind, external_id, workspace_id, clerk_org_id, tenant_entity_id, status)
         values ($1, 'mailpool_domain', $2, $3, $4, $5, 'active')
         on conflict (kind, external_id) do update set tenant_entity_id = $5, clerk_org_id = $4, status = 'active',
             updated_at = $6::timestamptz
         where reach_routes.workspace_id = $3
         returning id",
    )
    .bind(generate_id("rrt"))
    .bind(&mailpool_domain_id)
    .bind(workspace_id)
    .bind(&caller.clerk_org_id)
    .bind(&domain_id)
    .bind(iso(now))
    .fetch_all(master)
    .await;
    match routed {
        Ok(rows) if rows.is_empty() => {
            sqlx::query("delete from reach_domains where id = $1").bind(&domain_id).execute(db).await?;
            Err(ReachError::new(409, "DOMAIN_IN_USE", "This domain is connected in another workspace."))
        }
        Ok(_) => Ok(row),
        Err(error) => {
            sqlx::query("delete from reach_domains where id = $1").bind(&domain_id).execute(db).await?;
            drop_from_mailpool(mailpool, &mailpool_domain_id).await;
            Err(error.into())
        }
    }
}

async fn drop_from_mailpool(mailpool: &Mailpool, mailpool_domain_id: &str) {
    if let Err(error) = mailpool.delete_domain(mailpool_domain_id).await {
        tracing::error!(?error, mailpool_domain_id, "[reach-domains] rollback: could not delete Mailpool domain");
    }
}

/// `dmarcPolicyOf(records)`.
fn dmarc_policy_of(records: &[Value]) -> Option<String> {
    let key_re = regex::Regex::new(r"(?i)(^|\.)_dmarc(\.|$)").ok()?;
    let policy_re = regex::Regex::new(r"(?i)(?:^|;)\s*p=(none|quarantine|reject)").ok()?;
    records.iter().find_map(|record| {
        if text(record, "type") != Some("TXT") || !key_re.is_match(text(record, "key").unwrap_or_default()) {
            return None;
        }
        policy_re
            .captures(text(record, "value").unwrap_or_default())
            .map(|caps| caps[1].to_lowercase())
    })
}

async fn refresh_dns(State(state): State<ReachState>, caller: Caller, Path(id): Path<String>) -> Response {
    respond(
        async {
            account_workspace(&caller)?;
            crate::require_master(&caller, &state)?;
            let mailpool = mailpool_of(&caller, &state)?;
            let db = &caller.db;
            let row = domains::require(db, &id).await?;
            let Some(mailpool_id) = text(&row, "mailpoolDomainId").map(str::to_owned) else {
                return Err(ReachError::new(409, "DOMAIN_NOT_CONNECTED", "The domain is not connected yet."));
            };
            let remote = mailpool.get_domain(&mailpool_id).await;
            let records = mailpool.get_domain_dns(&mailpool_id).await;
            let (remote, records) = (remote.map_err(|e| upstream(&e))?, records.map_err(|e| upstream(&e))?);
            let now = caller.now();
            let dns_status = evaluate(&caller.http(&state), text(&row, "name").unwrap_or_default(), &records, &iso(now))
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
            let policy = dmarc_policy_of(&records).or_else(|| text(&row, "dmarcPolicy").map(str::to_owned));
            let updated: Option<Value> = sqlx::query_scalar(
                "update reach_domains set status = $2, last_error = $3, dns_status = $4, dmarc_policy = $5,
                     updated_at = $6::timestamptz where id = $1 returning to_jsonb(reach_domains)",
            )
            .bind(&id)
            .bind(&status)
            .bind(&last_error)
            .bind(&dns_status)
            .bind(&policy)
            .bind(iso(caller.now()))
            .fetch_optional(db)
            .await?;
            let updated = updated.map_or(row, weldsuite_db::js_row);
            caller.sink(&state).emit(ReachEvent::new(REACH_DOMAIN_UPDATED, &id, updated.clone()));
            Ok(Data(domains::get(db, text(&updated, "id").unwrap_or(&id)).await?).into_response())
        }
        .await,
    )
}

async fn disconnect(State(state): State<ReachState>, caller: Caller, Path(id): Path<String>) -> Response {
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
            let at = iso(caller.now());
            sqlx::query("update reach_domains set status = 'disconnecting', updated_at = $2::timestamptz where id = $1")
                .bind(&id)
                .bind(&at)
                .execute(db)
                .await?;
            if let Some(mailpool_id) = text(&row, "mailpoolDomainId") {
                if let Err(error) = mailpool.delete_domain(mailpool_id).await
                    && !error.is_not_found()
                {
                    sqlx::query("update reach_domains set status = $2, updated_at = $3::timestamptz where id = $1")
                        .bind(&id)
                        .bind(text(&row, "status"))
                        .bind(&at)
                        .execute(db)
                        .await?;
                    return Err(upstream(&error));
                }
                sqlx::query(
                    "update reach_routes set status = 'deleted', updated_at = $3::timestamptz
                     where kind = 'mailpool_domain' and external_id = $1 and workspace_id = $2",
                )
                .bind(mailpool_id)
                .bind(&workspace_id)
                .bind(&at)
                .execute(&master)
                .await?;
            }
            sqlx::query("delete from reach_domains where id = $1").bind(&id).execute(db).await?;
            caller.sink(&state).emit(ReachEvent::new(REACH_DOMAIN_DISCONNECTED, &id, row));
            Ok(NoContent.into_response())
        }
        .await,
    )
}
