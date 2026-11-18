//! Custom collector domains: `/api/panel/projects/:id/domains`
//! (`routes/domains/index.ts`, `services/domains.ts`, ADR PANEL-012 and
//! PANEL-014). A project's own host name (`stats.example.com`) that serves
//! the SDK and takes its events. Everything here is `panel_projects:manage`.
//!
//!   GET    /                     → the project's domains, with the DNS records to add
//!   POST   /                     → { hostname }: register it
//!   POST   /:domainId/refresh    → its status now (the cron also does)
//!   DELETE /:domainId            → remove it
//!
//! Rows live in the master `panel_custom_domains` (host names are unique
//! across workspaces; the cron polls pending ones without opening tenant
//! databases). Who serves the host name is a port, [`CollectorDomains`]:
//! on Global Cloudflare custom hostnames ([`CloudflareDomains`], the same calls
//! `@weldsuite/cloudflare-zones` makes, through the outbound bridge in
//! conformance); on Kubernetes cert-manager and an `Ingress` per host name
//! (PANEL-014, [`super::cert_manager`]). Without one the routes answer as
//! Global does without its Cloudflare settings: 503 `FEATURE_UNAVAILABLE`.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{
    EventName, PANEL_CUSTOM_DOMAIN_CREATED, PANEL_CUSTOM_DOMAIN_DELETED,
    PANEL_CUSTOM_DOMAIN_UPDATED,
};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_panel_domain::js;
use weldsuite_ports::{BoxFuture, HttpRequest, OutboundHttp};

use super::schemas::CREATE_DOMAIN;
use super::{MonitorState, master_of};
use crate::saved::{field, text};
use crate::{Caller, unexpected};

/// Most custom host names one project may have.
pub(crate) const MAX_DOMAINS_PER_PROJECT: i64 = 5;

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/// A host name as its provider reports it (`CustomHostnameState`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HostnameState {
    /// The provider's id for it.
    pub id: String,
    pub hostname: String,
    /// `pending`, `active`, `moved`, `blocked`, …
    pub status: String,
    /// The certificate's status (`pending_validation`, `active`, …).
    pub ssl_status: Option<String>,
    /// A TXT record (name, value) that activates it before the CNAME moves.
    pub ownership: Option<(String, String)>,
    /// TXT records (name, value) for certificate validation.
    pub certificate_records: Vec<(String, String)>,
    /// Why validation failed, as the provider says it.
    pub errors: Vec<String>,
}

/// A provider refused or could not be reached (`CloudflareHostnameError`):
/// the message, and the status when it answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DomainError {
    pub message: String,
    pub status: Option<u16>,
}

impl std::fmt::Display for DomainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Who serves a customer's collection host name.
pub trait CollectorDomains: Send + Sync {
    /// What the customer points a CNAME at (`PANEL_SAAS_CNAME_TARGET`, or
    /// the install's collector host on Kubernetes).
    fn cname_target(&self) -> &str;
    /// Registers `hostname`; `metadata` says whose it is.
    fn create<'a>(
        &'a self,
        hostname: &'a str,
        metadata: &'a [(&'a str, String)],
    ) -> BoxFuture<'a, Result<HostnameState, DomainError>>;
    /// Its state now (`id` is what [`create`](Self::create) answered,
    /// `hostname` the row's); `None` when the provider no longer has it.
    /// cert-manager's adapter also moves it along here: the status sweep is
    /// what starts its certificate once the CNAME is in place.
    fn get<'a>(
        &'a self,
        id: &'a str,
        hostname: &'a str,
    ) -> BoxFuture<'a, Result<Option<HostnameState>, DomainError>>;
    /// Removes it; one already gone counts as removed.
    fn delete<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), DomainError>>;
}

// ---------------------------------------------------------------------------
// Cloudflare custom hostnames
// ---------------------------------------------------------------------------

const API: &str = "https://api.cloudflare.com/client/v4";

/// Cloudflare custom hostnames custom hostnames on their zone, as the official
/// SDK calls them from `@weldsuite/cloudflare-zones/custom-hostnames`: the
/// same URLs and bodies, two retries for a read or a delete (on 408, 409,
/// 429, 5xx and connection failures), none for a create.
pub struct CloudflareDomains {
    http: OutboundHttp,
    token: String,
    zone_id: String,
    cname_target: String,
}

impl std::fmt::Debug for CloudflareDomains {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudflareDomains")
            .field("zone_id", &self.zone_id)
            .field("cname_target", &self.cname_target)
            .finish_non_exhaustive()
    }
}

impl CloudflareDomains {
    /// `saasConfig(env)`: all three settings, trimmed, or `None`.
    pub fn from_env(http: OutboundHttp, get: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let value = |name: &str| {
            get(name)
                .map(|v| js::trim(&v).to_owned())
                .filter(|v| !v.is_empty())
        };
        Some(Self {
            zone_id: value("PANEL_SAAS_ZONE_ID")?,
            cname_target: value("PANEL_SAAS_CNAME_TARGET")?,
            token: value("CLOUDFLARE_API_TOKEN")?,
            http,
        })
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        max_retries: u32,
    ) -> Result<Value, DomainError> {
        let url = format!("{API}/zones/{}/custom_hostnames{path}", self.zone_id);
        let mut retries = max_retries;
        let mut attempt = 0;
        loop {
            let mut request = HttpRequest::empty(method, url.clone())
                .header("authorization", format!("Bearer {}", self.token))
                .header("accept", "application/json");
            if let Some(body) = body {
                request = request.header("content-type", "application/json");
                request.body = Some(body.to_string().into_bytes());
            }
            let retry = match self.http.send(request).await {
                Err(error) => {
                    if retries == 0 {
                        return Err(DomainError {
                            message: error.to_string(),
                            status: None,
                        });
                    }
                    true
                }
                Ok(response) if response.ok() => {
                    let parsed: Value =
                        serde_json::from_slice(&response.body).unwrap_or(Value::Null);
                    return Ok(parsed.get("result").cloned().unwrap_or(Value::Null));
                }
                Ok(response) => {
                    let retryable =
                        matches!(response.status, 408 | 409 | 429) || response.status >= 500;
                    if !retryable || retries == 0 {
                        return Err(api_error(response.status, &response.body));
                    }
                    true
                }
            };
            if retry {
                retries -= 1;
                let delay = 500_u64.saturating_mul(1 << attempt).min(8000);
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
        }
    }
}

/// `toHostnameError(err)` of an answer the API refused.
fn api_error(status: u16, body: &[u8]) -> DomainError {
    let parsed: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let errors: Vec<(i64, String)> = parsed["errors"]
        .as_array()
        .map(|errors| {
            errors
                .iter()
                .map(|e| {
                    (
                        e["code"].as_i64().unwrap_or(0),
                        e["message"].as_str().unwrap_or_default().to_owned(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let first = errors
        .first()
        .map(|(_, m)| m.clone())
        .filter(|m| !m.is_empty());
    let message = if status == 401 || status == 403 {
        "Cloudflare API token is missing or lacks the SSL and Certificates scope".to_owned()
    } else if errors
        .iter()
        .any(|(code, _)| *code == 1406 || *code == 1414)
        || status == 409
    {
        first.unwrap_or_else(|| "This host name is already in use".to_owned())
    } else if status == 400 || status == 422 {
        first.unwrap_or_else(|| "Cloudflare refused this host name".to_owned())
    } else {
        let text = String::from_utf8_lossy(body);
        let fallback = if text.is_empty() {
            format!("{status} status code (no body)")
        } else {
            format!("{status} {text}")
        };
        format!(
            "Cloudflare API error {status}: {}",
            first.unwrap_or(fallback)
        )
    };
    DomainError {
        message,
        status: Some(status),
    }
}

/// `toCustomHostnameState(raw)`.
fn hostname_state(raw: &Value) -> HostnameState {
    let ownership = &raw["ownership_verification"];
    let pair = |value: &Value, name: &str, val: &str| {
        let (n, v) = (
            value[name].as_str().unwrap_or_default(),
            value[val].as_str().unwrap_or_default(),
        );
        (!n.is_empty() && !v.is_empty()).then(|| (n.to_owned(), v.to_owned()))
    };
    let ssl = &raw["ssl"];
    let mut errors: Vec<String> = raw["verification_errors"]
        .as_array()
        .map(|e| {
            e.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    errors.extend(
        ssl["validation_errors"]
            .as_array()
            .map(|e| {
                e.iter()
                    .filter_map(|e| e["message"].as_str())
                    .filter(|m| !m.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
    );
    HostnameState {
        id: raw["id"].as_str().unwrap_or_default().to_owned(),
        hostname: raw["hostname"].as_str().unwrap_or_default().to_owned(),
        status: raw["status"].as_str().unwrap_or("pending").to_owned(),
        ssl_status: ssl["status"].as_str().map(str::to_owned),
        ownership: pair(ownership, "name", "value"),
        certificate_records: ssl["validation_records"]
            .as_array()
            .map(|records| {
                records
                    .iter()
                    .filter_map(|r| pair(r, "txt_name", "txt_value"))
                    .collect()
            })
            .unwrap_or_default(),
        errors,
    }
}

impl CollectorDomains for CloudflareDomains {
    fn cname_target(&self) -> &str {
        &self.cname_target
    }

    fn create<'a>(
        &'a self,
        hostname: &'a str,
        metadata: &'a [(&'a str, String)],
    ) -> BoxFuture<'a, Result<HostnameState, DomainError>> {
        Box::pin(async move {
            let mut body = json!({
                "hostname": hostname,
                "ssl": { "method": "http", "type": "dv", "settings": { "min_tls_version": "1.2" } },
            });
            if !metadata.is_empty() {
                body["custom_metadata"] = metadata
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), json!(v)))
                    .collect::<serde_json::Map<_, _>>()
                    .into();
            }
            // Not retried: a replay of a create that succeeded would be "already exists".
            let created = self.call("POST", "", Some(&body), 0).await?;
            Ok(hostname_state(&created))
        })
    }

    fn get<'a>(
        &'a self,
        id: &'a str,
        _hostname: &'a str,
    ) -> BoxFuture<'a, Result<Option<HostnameState>, DomainError>> {
        Box::pin(async move {
            match self.call("GET", &format!("/{id}"), None, 2).await {
                Ok(found) => Ok(Some(hostname_state(&found))),
                Err(error) if error.status == Some(404) => Ok(None),
                Err(error) => Err(error),
            }
        })
    }

    fn delete<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), DomainError>> {
        Box::pin(async move {
            match self.call("DELETE", &format!("/{id}"), None, 2).await {
                Ok(_) => Ok(()),
                Err(error) if error.status == Some(404) => Ok(()),
                Err(error) => Err(error),
            }
        })
    }
}

// ---------------------------------------------------------------------------
// Rows and DTOs
// ---------------------------------------------------------------------------

const FAILED_HOSTNAME: [&str; 7] = [
    "moved",
    "blocked",
    "pending_blocked",
    "deleted",
    "pending_deletion",
    "test_blocked",
    "test_failed",
];

/// `domainStatusOf(state)`.
pub(crate) fn domain_status_of(state: &HostnameState) -> &'static str {
    if FAILED_HOSTNAME.contains(&state.status.as_str()) {
        return "failed";
    }
    let ssl = state.ssl_status.as_deref().unwrap_or_default();
    // `failed` is cert-manager's (PANEL-014); Cloudflare never reports it.
    if ssl.ends_with("timed_out")
        || ssl == "expired"
        || ssl == "deleted"
        || ssl == super::cert_manager::SSL_FAILED
    {
        return "failed";
    }
    if state.status == "active" && ssl == "active" {
        return "active";
    }
    "pending"
}

/// `verificationRecords(hostname, cnameTarget, state)`.
pub(crate) fn verification_records(
    hostname: &str,
    cname_target: &str,
    state: Option<&HostnameState>,
) -> Value {
    let mut records = vec![
        json!({ "type": "CNAME", "name": hostname, "value": cname_target, "purpose": "routing" }),
    ];
    if let Some((name, value)) = state.and_then(|s| s.ownership.as_ref()) {
        records
            .push(json!({ "type": "TXT", "name": name, "value": value, "purpose": "ownership" }));
    }
    for (name, value) in state
        .map(|s| s.certificate_records.as_slice())
        .unwrap_or_default()
    {
        records
            .push(json!({ "type": "TXT", "name": name, "value": value, "purpose": "certificate" }));
    }
    Value::Array(records)
}

/// `toDomainDto(d, projectToken)`: the install snippet once it is active.
pub(crate) fn dto(row: &Value, project_token: &str) -> Value {
    let active = text(row, "status") == "active";
    let hostname = text(row, "hostname");
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "hostname": hostname,
        "status": field(row, "status"),
        "sslStatus": field(row, "sslStatus"),
        "records": field(row, "verification"),
        "lastError": field(row, "lastError"),
        "lastCheckedAt": field(row, "lastCheckedAt"),
        "scriptUrl": if active { json!(format!("https://{hostname}/s.js")) } else { Value::Null },
        "snippet": if active && !project_token.is_empty() {
            json!(crate::domain::install_snippet(project_token, &format!("https://{hostname}")))
        } else {
            Value::Null
        },
        "createdAt": field(row, "createdAt"),
    })
}

/// `domainEventData(d)`.
pub(crate) fn event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "hostname": field(row, "hostname"),
        "status": field(row, "status"),
    })
}

fn rows(found: Vec<Value>) -> Vec<Value> {
    found.into_iter().map(weldsuite_db::js_row).collect()
}

async fn list_domains(
    master: &PgPool,
    workspace_id: &str,
    project_id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let found: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from panel_custom_domains d
         where d.workspace_id = $1 and d.project_id = $2 and d.deleted_at is null
         order by d.created_at asc",
    )
    .bind(workspace_id)
    .bind(project_id)
    .fetch_all(master)
    .await?;
    Ok(rows(found))
}

async fn get_domain(
    master: &PgPool,
    workspace_id: &str,
    project_id: &str,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let found: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from panel_custom_domains d
         where d.id = $1 and d.workspace_id = $2 and d.project_id = $3 and d.deleted_at is null limit 1",
    )
    .bind(id)
    .bind(workspace_id)
    .bind(project_id)
    .fetch_optional(master)
    .await?;
    Ok(found.map(weldsuite_db::js_row))
}

fn error_text(error: &DomainError) -> String {
    js::slice_utf16(&error.message, 0, 500)
}

/// `stateFields(cfg, hostname, state, now)` written to the row.
async fn store_state(
    master: &PgPool,
    domains: &dyn CollectorDomains,
    id: &str,
    hostname: &str,
    state: &HostnameState,
    now: i64,
) -> Result<Option<Value>, sqlx::Error> {
    let last_error =
        (!state.errors.is_empty()).then(|| js::slice_utf16(&state.errors.join("; "), 0, 500));
    let row: Option<Value> = sqlx::query_scalar(
        "update panel_custom_domains d set cf_custom_hostname_id = $2, status = $3, ssl_status = $4,
           verification = $5, last_error = $6, last_checked_at = $7::timestamptz, updated_at = $7::timestamptz
         where d.id = $1 returning to_jsonb(d)",
    )
    .bind(id)
    .bind(&state.id)
    .bind(domain_status_of(state))
    .bind(state.ssl_status.as_deref())
    .bind(verification_records(hostname, domains.cname_target(), Some(state)))
    .bind(last_error)
    .bind(js::iso_string(now))
    .fetch_optional(master)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// Why a host name was not registered (`CreateDomainResult`'s refusal).
enum CreateRefusal {
    /// Taken, or the project's limit: 409.
    Conflict(String),
    /// The provider refused: 502.
    Provider(String),
}

/// `createDomain(masterDb, cfg, input)`: claims the host name (the unique
/// index decides a race), then registers it; a refusal releases the claim.
async fn create_domain(
    master: &PgPool,
    domains: &dyn CollectorDomains,
    workspace_id: &str,
    project_id: &str,
    hostname: &str,
    user_id: &str,
    now: i64,
) -> Result<Result<Value, CreateRefusal>, sqlx::Error> {
    if i64::try_from(list_domains(master, workspace_id, project_id).await?.len())
        .unwrap_or(i64::MAX)
        >= MAX_DOMAINS_PER_PROJECT
    {
        return Ok(Err(CreateRefusal::Conflict(format!(
            "A project can have at most {MAX_DOMAINS_PER_PROJECT} custom domains"
        ))));
    }
    let id = weldsuite_kit::generate_id("pncd");
    let claimed: Option<String> = sqlx::query_scalar(
        "insert into panel_custom_domains (id, workspace_id, project_id, hostname, status, verification, created_by_user_id)
         values ($1, $2, $3, $4, 'pending', $5, $6)
         on conflict (hostname) do nothing returning id",
    )
    .bind(&id)
    .bind(workspace_id)
    .bind(project_id)
    .bind(hostname)
    .bind(verification_records(hostname, domains.cname_target(), None))
    .bind(user_id)
    .fetch_optional(master)
    .await?;
    if claimed.is_none() {
        return Ok(Err(CreateRefusal::Conflict(
            "This host name is already in use".to_owned(),
        )));
    }
    let metadata = [
        ("workspace_id", workspace_id.to_owned()),
        ("project_id", project_id.to_owned()),
        ("domain_id", id.clone()),
    ];
    let state = match domains.create(hostname, &metadata).await {
        Ok(state) => state,
        Err(error) => {
            sqlx::query("delete from panel_custom_domains where id = $1")
                .bind(&id)
                .execute(master)
                .await?;
            return Ok(Err(CreateRefusal::Provider(error_text(&error))));
        }
    };
    let row = store_state(master, domains, &id, hostname, &state, now).await?;
    Ok(row.ok_or(CreateRefusal::Conflict(
        "This host name is already in use".to_owned(),
    )))
}

/// `refreshDomain(masterDb, cfg, domain, now)`: the provider's state, stored;
/// a provider error is stored, not returned.
pub(crate) async fn refresh_domain(
    master: &PgPool,
    domains: &dyn CollectorDomains,
    domain: &Value,
    now: i64,
) -> Result<Value, sqlx::Error> {
    let Some(provider_id) = domain
        .get("cfCustomHostnameId")
        .and_then(Value::as_str)
        .filter(|i| !i.is_empty())
    else {
        return Ok(domain.clone());
    };
    let id = text(domain, "id");
    let row = match domains.get(provider_id, text(domain, "hostname")).await {
        Ok(Some(state)) => {
            store_state(master, domains, id, text(domain, "hostname"), &state, now).await?
        }
        Ok(None) => {
            set_error(
                master,
                id,
                Some("failed"),
                "Cloudflare no longer has this host name",
                now,
            )
            .await?
        }
        Err(error) => set_error(master, id, None, &error_text(&error), now).await?,
    };
    Ok(row.unwrap_or_else(|| domain.clone()))
}

async fn set_error(
    master: &PgPool,
    id: &str,
    status: Option<&str>,
    error: &str,
    now: i64,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "update panel_custom_domains d set status = coalesce($2, d.status), last_error = $3,
           last_checked_at = $4::timestamptz, updated_at = $4::timestamptz
         where d.id = $1 returning to_jsonb(d)",
    )
    .bind(id)
    .bind(status)
    .bind(error)
    .bind(js::iso_string(now))
    .fetch_optional(master)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `removeDomain(masterDb, cfg, domain, now)`: removed at the provider, then
/// the row; when the provider fails the row stays `deleting` for the cron.
pub(crate) async fn remove_domain(
    master: &PgPool,
    domains: &dyn CollectorDomains,
    domain: &Value,
    now: i64,
) -> Result<(bool, Value), sqlx::Error> {
    let id = text(domain, "id");
    if let Some(provider_id) = domain
        .get("cfCustomHostnameId")
        .and_then(Value::as_str)
        .filter(|i| !i.is_empty())
        && let Err(error) = domains.delete(provider_id).await
    {
        let row = set_error(master, id, Some("deleting"), &error_text(&error), now).await?;
        return Ok((false, row.unwrap_or_else(|| domain.clone())));
    }
    sqlx::query("delete from panel_custom_domains where id = $1")
        .bind(id)
        .execute(master)
        .await?;
    let mut gone = domain.clone();
    if let Some(obj) = gone.as_object_mut() {
        obj.insert("status".to_owned(), json!("deleting"));
    }
    Ok((true, gone))
}

/// `domainsToPoll(masterDb, now, limit)`: pending ones and removals to
/// retry, least recently checked first.
pub(crate) async fn domains_to_poll(
    master: &PgPool,
    now: i64,
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let found: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from panel_custom_domains d
         where d.status in ('pending', 'deleting') and d.deleted_at is null
           and (d.last_checked_at is null or d.last_checked_at < $1::timestamptz)
         order by d.last_checked_at asc limit $2",
    )
    .bind(js::iso_string(now - 5 * 60_000))
    .bind(limit)
    .fetch_all(master)
    .await?;
    Ok(rows(found))
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/// What every route needs (`setup(c)`).
struct Setup {
    domains: Arc<dyn CollectorDomains>,
    master: PgPool,
    project_id: String,
    token: String,
}

/// The provider for this request: the test's Cloudflare settings and fetch
/// stub (conformance), else the state's.
fn domains_of(caller: &Caller, state: &MonitorState) -> Option<Arc<dyn CollectorDomains>> {
    if caller.conformance() {
        let http = caller.outbound.clone()?;
        return CloudflareDomains::from_env(http, |name| caller.env(name))
            .map(|cf| Arc::new(cf) as Arc<dyn CollectorDomains>);
    }
    state.domains.clone()
}

fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "error": { "code": "FEATURE_UNAVAILABLE", "message": "Custom collector domains are not available here" } })),
    )
        .into_response()
}

async fn setup(caller: &Caller, state: &MonitorState, project_id: &str) -> Result<Setup, Response> {
    let Some(domains) = domains_of(caller, state) else {
        return Err(unavailable());
    };
    if caller.workspace_id.is_empty() {
        return Err(ApiError::org_required().into_response());
    }
    let project = match crate::projects::live_project(caller, project_id).await {
        Ok(Some(project)) => project,
        Ok(None) => return Err(ApiError::not_found("Project", Some(project_id)).into_response()),
        Err(error) => return Err(unexpected(&error, "get project")),
    };
    let Some(master) = master_of(caller, state) else {
        return Err(ApiError::internal().into_response());
    };
    Ok(Setup {
        domains,
        master,
        project_id: project_id.to_owned(),
        token: text(&project, "token").to_owned(),
    })
}

fn publish(caller: &Caller, state: &MonitorState, domain: &Value, event: EventName) {
    caller.publish(&state.panel, event, text(domain, "id"), &event_data(domain));
}

/// `GET /`.
pub(crate) async fn list(
    State(state): State<MonitorState>,
    caller: Caller,
    Path(project_id): Path<String>,
) -> Response {
    let s = match setup(&caller, &state, &project_id).await {
        Ok(s) => s,
        Err(response) => return response,
    };
    match list_domains(&s.master, &caller.workspace_id, &s.project_id).await {
        Ok(found) => {
            let data: Vec<Value> = found.iter().map(|d| dto(d, &s.token)).collect();
            let count = data.len() as u64;
            List::new(data, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => unexpected(&error, "list domains"),
    }
}

/// `POST /`.
pub(crate) async fn create(
    State(state): State<MonitorState>,
    caller: Caller,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match weldsuite_zod::json(&CREATE_DOMAIN, &headers, &body) {
        Ok(parsed) => parsed.body,
        Err(response) => return response,
    };
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    let s = match setup(&caller, &state, &project_id).await {
        Ok(s) => s,
        Err(response) => return response,
    };
    let hostname = input
        .get("hostname")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let created = create_domain(
        &s.master,
        s.domains.as_ref(),
        &caller.workspace_id,
        &s.project_id,
        hostname,
        &caller.user_id,
        js::now_millis(),
    )
    .await;
    match created {
        Ok(Ok(domain)) => {
            publish(&caller, &state, &domain, PANEL_CUSTOM_DOMAIN_CREATED);
            Created(dto(&domain, &s.token)).into_response()
        }
        Ok(Err(CreateRefusal::Provider(message))) => ApiError::bad_gateway()
            .with_message(message)
            .into_response(),
        Ok(Err(CreateRefusal::Conflict(message))) => ApiError::conflict(message).into_response(),
        Err(error) => unexpected(&error, "create domain"),
    }
}

/// `POST /:domainId/refresh`.
pub(crate) async fn refresh(
    State(state): State<MonitorState>,
    caller: Caller,
    Path((project_id, domain_id)): Path<(String, String)>,
) -> Response {
    let s = match setup(&caller, &state, &project_id).await {
        Ok(s) => s,
        Err(response) => return response,
    };
    let domain = match get_domain(&s.master, &caller.workspace_id, &s.project_id, &domain_id).await
    {
        Ok(Some(domain)) => domain,
        Ok(None) => return ApiError::not_found("Domain", Some(&domain_id)).into_response(),
        Err(error) => return unexpected(&error, "refresh domain"),
    };
    let fresh = match refresh_domain(&s.master, s.domains.as_ref(), &domain, js::now_millis()).await
    {
        Ok(fresh) => fresh,
        Err(error) => return unexpected(&error, "refresh domain"),
    };
    if text(&fresh, "status") != text(&domain, "status") {
        publish(&caller, &state, &fresh, PANEL_CUSTOM_DOMAIN_UPDATED);
    }
    Data(dto(&fresh, &s.token)).into_response()
}

/// `DELETE /:domainId`.
pub(crate) async fn remove(
    State(state): State<MonitorState>,
    caller: Caller,
    Path((project_id, domain_id)): Path<(String, String)>,
) -> Response {
    let s = match setup(&caller, &state, &project_id).await {
        Ok(s) => s,
        Err(response) => return response,
    };
    let domain = match get_domain(&s.master, &caller.workspace_id, &s.project_id, &domain_id).await
    {
        Ok(Some(domain)) => domain,
        Ok(None) => return ApiError::not_found("Domain", Some(&domain_id)).into_response(),
        Err(error) => return unexpected(&error, "remove domain"),
    };
    let (removed, after) =
        match remove_domain(&s.master, s.domains.as_ref(), &domain, js::now_millis()).await {
            Ok(result) => result,
            Err(error) => return unexpected(&error, "remove domain"),
        };
    // Removed, or left `deleting` for the cron to finish: either way it is going.
    let event = if removed {
        PANEL_CUSTOM_DOMAIN_DELETED
    } else {
        PANEL_CUSTOM_DOMAIN_UPDATED
    };
    publish(&caller, &state, &after, event);
    if !removed {
        return (
            StatusCode::ACCEPTED,
            Json(json!({ "data": dto(&after, &s.token) })),
        )
            .into_response();
    }
    NoContent.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(status: &str, ssl: Option<&str>) -> HostnameState {
        HostnameState {
            status: status.to_owned(),
            ssl_status: ssl.map(str::to_owned),
            ..HostnameState::default()
        }
    }

    #[test]
    fn statuses_follow_the_host_name_and_its_certificate() {
        assert_eq!(domain_status_of(&state("active", Some("active"))), "active");
        assert_eq!(
            domain_status_of(&state("pending", Some("pending_validation"))),
            "pending"
        );
        assert_eq!(domain_status_of(&state("moved", None)), "failed");
        assert_eq!(
            domain_status_of(&state("pending", Some("validation_timed_out"))),
            "failed"
        );
    }

    #[test]
    fn records_are_the_cname_and_the_txt_records_asked_for() {
        let mut s = state("pending", None);
        s.ownership = Some((
            "_cf-custom-hostname.stats.example.com".to_owned(),
            "abc-123".to_owned(),
        ));
        assert_eq!(
            verification_records("stats.example.com", "collect.weldpanel.net", Some(&s)),
            json!([
                { "type": "CNAME", "name": "stats.example.com", "value": "collect.weldpanel.net", "purpose": "routing" },
                { "type": "TXT", "name": "_cf-custom-hostname.stats.example.com", "value": "abc-123", "purpose": "ownership" }
            ])
        );
    }

    #[test]
    fn cloudflare_errors_read_as_the_sdk_classifies_them() {
        assert_eq!(
            api_error(403, b"{}").message,
            "Cloudflare API token is missing or lacks the SSL and Certificates scope"
        );
        assert_eq!(
            api_error(
                400,
                br#"{"errors":[{"code":1406,"message":"Duplicate custom hostname found."}]}"#
            )
            .message,
            "Duplicate custom hostname found."
        );
        assert_eq!(
            api_error(422, b"{}").message,
            "Cloudflare refused this host name"
        );
        let parsed = hostname_state(&json!({
            "id": "cfh_1", "hostname": "stats.example.com", "status": "pending",
            "ssl": { "status": "pending_validation", "validation_records": [{ "txt_name": "a", "txt_value": "b" }] },
            "ownership_verification": { "type": "txt", "name": "_cf", "value": "v" }
        }));
        assert_eq!(
            parsed.certificate_records,
            vec![("a".to_owned(), "b".to_owned())]
        );
        assert_eq!(parsed.ownership, Some(("_cf".to_owned(), "v".to_owned())));
    }
}
