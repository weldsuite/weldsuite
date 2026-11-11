//! `/api/mail-domains` (`routes/mail-domains/index.ts`,
//! `services/mail/domains.ts`) on the Kubernetes editions: a workspace's
//! custom mail domains. Global provisions Cloudflare Email Routing and Email
//! Sending on the zone; here the `MailDomains` port does (ADR MAIL-010,
//! MAIL-011): the EU edition's MTA mints each domain's DKIM key, and the
//! customer publishes the records `dnsRecords` lists (MX to the edition's MX,
//! the SPF include, the DKIM key, a DMARC suggestion). `verify` looks them up.
//!
//! The MTA is shared by every workspace and keeps one DKIM key per domain,
//! so a domain added here also gets an ownership record of its own workspace
//! (`_weldmail-verify.<domain>`, TXT `weldmail-verify=<token>`, the token in
//! `metadata.verificationToken`). It is verified only once that record
//! resolves too, and mailboxes are created only on a verified domain or an
//! active WeldHost domain, whose ownership WeldHost proved
//! ([`ensure_provisioned`]). Removing a domain deregisters it at the MTA only
//! when the workspace proved it and no other workspace has addresses on it.
//!
//! WeldMail's own domains (`weldmail.com`, `weldmail.org` and their
//! subdomains) are Global's: they are refused here, as a custom domain and for
//! a mailbox, so the MTA never registers one ([`weldmail_domain_refused`]).
//!
//! Without an adapter (`MAIL_MX_HOST` unset, so `/config.json` lists
//! `mail-domains` as unavailable) the reads, the catch-all settings and
//! removing a domain still work; adding, verifying and syncing one answer
//! 503 `MAIL_DOMAINS_NOT_CONFIGURED`.
//!
//! Paths, bodies, permissions and entity events are the worker's. What
//! differs is the provisioning: no Cloudflare zone is needed, a new domain
//! starts `pending` until its records resolve, and provider failures answer
//! `DOMAIN_PROVISION_FAILED` / `DOMAIN_VERIFY_FAILED` where the worker answers
//! `CLOUDFLARE_*`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    MAIL_DOMAIN_CREATED, MAIL_DOMAIN_DELETED, MAIL_DOMAIN_UPDATED, MAIL_DOMAIN_VERIFIED,
};
use weldsuite_catalogs::permission_keys::{
    ACCOUNTS_CREATE, ACCOUNTS_DELETE, ACCOUNTS_READ, ACCOUNTS_UPDATE,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_mail_domain::domains::{DnsRecord, DomainError, DomainSetup, MailDomains};
use weldsuite_mail_domain::outbound::limits::is_shared_weldmail_domain;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::util::{MailError, MailResult, answer, now, query_map, validate};
use crate::{Caller, MailState};

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([ACCOUNTS_READ]);
    let update = || gate.require([ACCOUNTS_UPDATE]);
    Router::new()
        .route("/mail-domains", get(list).route_layer(read()))
        .route(
            "/mail-domains",
            post(create).route_layer(gate.require([ACCOUNTS_CREATE])),
        )
        .route(
            "/mail-domains/by-name/{domain_name}",
            get(by_name).route_layer(read()),
        )
        .route("/mail-domains/{id}", get(detail).route_layer(read()))
        .route(
            "/mail-domains/{id}",
            patch(update_domain)
                .put(update_domain)
                .route_layer(update()),
        )
        .route(
            "/mail-domains/{id}",
            axum::routing::delete(remove).route_layer(gate.require([ACCOUNTS_DELETE])),
        )
        .route(
            "/mail-domains/{id}/verify",
            post(verify).route_layer(update()),
        )
        .route("/mail-domains/{id}/sync", post(sync).route_layer(update()))
        .route(
            "/mail-domains/{id}/generate-dkim",
            post(generate_dkim).route_layer(update()),
        )
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/// The ownership record's name prefix (`_weldmail-verify.<domain>`).
const OWNERSHIP_PREFIX: &str = "_weldmail-verify";

/// The workspace's ownership record for `domain`.
fn ownership_record(domain: &str, token: &str) -> DnsRecord {
    DnsRecord {
        kind: "TXT",
        name: format!("{OWNERSHIP_PREFIX}.{domain}"),
        value: format!("weldmail-verify={token}"),
        priority: None,
        purpose: "verification",
        verified: false,
    }
}

/// A domain as the adapter answered for it, with the workspace's ownership
/// record when the domain has one.
struct Provisioned {
    setup: DomainSetup,
    ownership: Option<DnsRecord>,
}

impl Provisioned {
    /// Mail can flow and the workspace proved the domain is its own.
    fn verified(&self) -> bool {
        self.setup.verified && self.ownership.as_ref().is_none_or(|r| r.verified)
    }

    /// `dns_records`: the ownership record first, then the adapter's.
    fn records_json(&self) -> Value {
        let mut records: Vec<Value> = self.ownership.iter().map(DnsRecord::to_json).collect();
        records.extend(self.setup.records.iter().map(DnsRecord::to_json));
        Value::Array(records)
    }

    fn dns_status(&self) -> &'static str {
        if self.verified() {
            "verified"
        } else {
            "pending"
        }
    }
}

/// Look `domain`'s records up, the ownership record included.
async fn check(
    adapter: &dyn MailDomains,
    domain: &str,
    token: Option<&str>,
) -> Result<Provisioned, DomainError> {
    let setup = adapter.verify(domain).await?;
    let ownership = match token {
        Some(token) => {
            let mut record = ownership_record(domain, token);
            record.verified = adapter.check_record(&record).await?;
            Some(record)
        }
        None => None,
    };
    Ok(Provisioned { setup, ownership })
}

/// Register `domain` with the adapter (idempotent), then look its records up:
/// a domain added again may resolve already. A failed lookup keeps the
/// registration's records, none verified.
async fn provision(
    adapter: &dyn MailDomains,
    domain: &str,
    token: Option<&str>,
) -> Result<Provisioned, DomainError> {
    let registered = adapter.register(domain).await?;
    match check(adapter, domain, token).await {
        Ok(checked) => Ok(checked),
        Err(error) => {
            tracing::warn!(%error, "[mail-domains] looking up {domain} after registering it failed");
            Ok(Provisioned {
                setup: registered,
                ownership: token.map(|token| ownership_record(domain, token)),
            })
        }
    }
}

/// Write what the adapter answered to the row; `provider` replaces the
/// row's providers (a re-sync through this edition's adapter).
async fn store(
    db: &PgPool,
    id: &str,
    provider: Option<&str>,
    outcome: &Provisioned,
    at: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update mail_domains set mail_provider = coalesce($2, mail_provider),
           send_provider = coalesce($2, send_provider),
           receive_provider = coalesce($2, receive_provider),
           dns_status = $3::mail_domain_dns_status, dns_records = $4,
           spf_verified = $5, dkim_verified = $6, dmarc_verified = $7,
           dkim_selector = coalesce($8, dkim_selector),
           cloudflare_routing_enabled = false,
           verified_at = case when $9 then $10::timestamp else verified_at end,
           last_verification_attempt = $10::timestamp, updated_at = $10::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(provider)
    .bind(outcome.dns_status())
    .bind(outcome.records_json())
    .bind(outcome.setup.spf_verified())
    .bind(outcome.setup.dkim_verified())
    .bind(outcome.setup.dmarc_verified())
    .bind(outcome.setup.dkim_selector.as_deref())
    .bind(outcome.verified())
    .bind(at)
    .execute(db)
    .await?;
    Ok(())
}

/// The adapter, or 503 when this deployment has none.
fn domains_adapter(state: &MailState) -> MailResult<&Arc<dyn MailDomains>> {
    state.domains.as_ref().ok_or_else(|| {
        MailError::api(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "MAIL_DOMAINS_NOT_CONFIGURED",
            "Custom mail domains are not set up on this server",
        ))
    })
}

/// A provider failure: 503 when the adapter cannot run, 502 when the MTA or
/// the resolver answered with an error.
fn provider_error(code: &'static str, message: String, error: &DomainError) -> MailError {
    let status = match error {
        DomainError::NotConfigured(_) => StatusCode::SERVICE_UNAVAILABLE,
        DomainError::Provider(_) => StatusCode::BAD_GATEWAY,
    };
    tracing::error!(%error, "[mail-domains] {message}");
    MailError::api(ApiError::new(status, code, message).with_details(error.to_string()))
}

/// WeldMail's own domains (`weldmail.com`, `weldmail.org` and their
/// workspace subdomains) belong to Global: their MX, DKIM and reputation are
/// Global's, and free addresses are off on Kubernetes (MAIL-010). Neither a
/// custom domain nor a mailbox goes on one here, and the MTA never registers
/// one.
fn weldmail_domain_refused(domain: &str) -> MailError {
    MailError::bad_request(format!(
        "{domain} is a WeldMail domain. Add a domain you own instead."
    ))
}

/// `ensureManagedDomain` with an adapter: a mailbox goes on a verified mail
/// domain, or on an active WeldHost domain of the workspace (WeldHost proved
/// ownership), which is then registered with the adapter.
pub(crate) async fn ensure_provisioned(
    caller: &Caller,
    adapter: &dyn MailDomains,
    domain: &str,
    at: &str,
) -> MailResult<()> {
    if is_shared_weldmail_domain(domain) {
        return Err(weldmail_domain_refused(domain));
    }
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "select id, dns_status::text from mail_domains
         where domain_name = $1 and deleted_at is null limit 1",
    )
    .bind(domain)
    .fetch_optional(&caller.db)
    .await?;
    if row
        .as_ref()
        .is_some_and(|(_, status)| status.as_deref() == Some("verified"))
    {
        return Ok(());
    }
    let weldhost: bool = sqlx::query_scalar(
        "select exists(select 1 from domains
           where full_domain = $1 and deleted_at is null and status = 'active')",
    )
    .bind(domain)
    .fetch_one(&caller.db)
    .await?;
    if !weldhost {
        return Err(MailError::bad_request(if row.is_some() {
            format!(
                "Verify {domain} under Settings › WeldMail › Domains before creating an email account on it."
            )
        } else {
            format!(
                "Add {domain} under Settings › WeldMail › Domains, or in WeldHost › Domains, before creating an email account on it."
            )
        }));
    }
    let outcome = provision(adapter, domain, None).await.map_err(|error| {
        provider_error(
            "DOMAIN_PROVISION_FAILED",
            format!("Couldn't set up mail for {domain}"),
            &error,
        )
    })?;
    let id = if let Some((id, _)) = row {
        id
    } else {
        let id = generate_id("mdom");
        insert(
            &caller.db,
            &id,
            domain,
            &DomainFields::default(),
            adapter.provider(),
            None,
            at,
        )
        .await?;
        id
    };
    store(&caller.db, &id, Some(adapter.provider()), &outcome, at).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/// `getDomain(db, id)`.
async fn find(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from mail_domains d where d.id = $1 and d.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// The row as it is now, deleted or not.
async fn reread(db: &PgPool, id: &str) -> Result<Value, sqlx::Error> {
    let row: Value = sqlx::query_scalar("select to_jsonb(d) from mail_domains d where d.id = $1")
        .bind(id)
        .fetch_one(db)
        .await?;
    Ok(js_row(row))
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

/// The ownership token of a domain added through these routes.
fn token(row: &Value) -> Option<&str> {
    row["metadata"]["verificationToken"]
        .as_str()
        .filter(|t| !t.is_empty())
}

/// The fields `createBody` and `updateBody` share.
#[derive(Default)]
struct DomainFields {
    is_active: Option<bool>,
    is_primary: Option<bool>,
    mail_provider: Option<String>,
    send_provider: Option<String>,
    receive_provider: Option<String>,
    max_email_accounts: Option<i64>,
}

fn read_fields(issues: &mut Issues, body: &Map<String, Value>) -> DomainFields {
    DomainFields {
        is_active: issues
            .boolean(body, "isActive", Presence::Optional)
            .into_option(),
        is_primary: issues
            .boolean(body, "isPrimary", Presence::Optional)
            .into_option(),
        mail_provider: issues
            .text(body, "mailProvider", Presence::Optional, None, Some(100))
            .into_option(),
        send_provider: issues
            .text(body, "sendProvider", Presence::Optional, None, Some(50))
            .into_option(),
        receive_provider: issues
            .text(body, "receiveProvider", Presence::Optional, None, Some(50))
            .into_option(),
        max_email_accounts: issues
            .whole_number(
                body,
                "maxEmailAccounts",
                Presence::Optional,
                Number {
                    coerce: false,
                    int: true,
                    min: Some(1.0),
                    max: Some(10_000.0),
                },
            )
            .into_option(),
    }
}

/// `/^[a-z0-9.-]+\.[a-z]{2,}$/i`.
fn is_domain_name(text: &str) -> bool {
    let Some((head, tld)) = text.rsplit_once('.') else {
        return false;
    };
    !head.is_empty()
        && head
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        && tld.len() >= 2
        && tld.bytes().all(|b| b.is_ascii_alphabetic())
}

#[allow(clippy::too_many_arguments)]
async fn insert(
    db: &PgPool,
    id: &str,
    domain: &str,
    fields: &DomainFields,
    provider: &str,
    token: Option<&str>,
    at: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into mail_domains (id, domain_name, is_active, is_primary, mail_provider,
           send_provider, receive_provider, dns_status, cloudflare_routing_enabled,
           max_email_accounts, current_email_accounts, catch_all_enabled, metadata,
           created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'pending', false, $8, 0, false, $9,
           $10::timestamp, $10::timestamp)",
    )
    .bind(id)
    .bind(domain)
    .bind(fields.is_active.unwrap_or(true))
    .bind(fields.is_primary.unwrap_or(false))
    .bind(fields.mail_provider.as_deref().unwrap_or(provider))
    .bind(fields.send_provider.as_deref().unwrap_or(provider))
    .bind(fields.receive_provider.as_deref().unwrap_or(provider))
    .bind(fields.max_email_accounts.unwrap_or(100))
    .bind(token.map(|token| json!({ "verificationToken": token })))
    .bind(at)
    .execute(db)
    .await?;
    Ok(())
}

/// `markAsSolePrimary`: every other domain stops being the primary one.
async fn mark_as_sole_primary(db: &PgPool, id: &str, at: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update mail_domains set is_primary = false, updated_at = $2::timestamp
         where deleted_at is null and id <> $1 and is_primary is true",
    )
    .bind(id)
    .bind(at)
    .execute(db)
    .await?;
    Ok(())
}

/// The event payload the worker sends for a domain.
fn event_data(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "domainName": row["domainName"],
        "dnsStatus": row["dnsStatus"],
        "isPrimary": row["isPrimary"],
    })
}

// ---------------------------------------------------------------------------
// Catch-all
// ---------------------------------------------------------------------------

/// `catchAllRegistryEmail(domain)`.
fn catch_all_registry_email(domain: &str) -> String {
    format!("*@{}", domain.to_lowercase())
}

/// `validateCatchAllSettings`.
async fn validate_catch_all(
    caller: &Caller,
    domain: &str,
    enabled: bool,
    account_id: Option<&str>,
) -> MailResult<()> {
    if !enabled {
        return Ok(());
    }
    if is_shared_weldmail_domain(domain) {
        return Err(MailError::bad_request(
            "Catch-all is only available on custom domains, not on *.weldmail.com",
        ));
    }
    let Some(account_id) = account_id.filter(|id| !id.is_empty()) else {
        return Err(MailError::bad_request(
            "Choose a mailbox to receive catch-all mail before enabling",
        ));
    };
    let account: Option<(String, Option<String>)> = sqlx::query_as(
        "select email, status::text from mail_accounts
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(account_id)
    .fetch_optional(&caller.db)
    .await?;
    let Some((email, status)) = account else {
        return Err(MailError::bad_request("Catch-all mailbox was not found"));
    };
    let host = email.split('@').nth(1).map(str::to_lowercase);
    if host.as_deref() != Some(domain.to_lowercase().as_str()) {
        return Err(MailError::bad_request(format!(
            "Catch-all mailbox must be on {domain}"
        )));
    }
    if status.as_deref() != Some("active") {
        return Err(MailError::bad_request(
            "Catch-all mailbox must be an active account",
        ));
    }
    Ok(())
}

/// The master database, or the route's 500.
fn master_db(state: &MailState, caller: &Caller, fallback: &str) -> MailResult<PgPool> {
    caller.bindings.master(state).ok_or_else(|| {
        tracing::error!("[mail-domains] no master database for the catch-all registry");
        MailError::api(ApiError::internal().with_message(fallback))
    })
}

/// `deactivateCatchAllRegistry`.
async fn deactivate_catch_all(master: &PgPool, domain: &str, at: &str) -> MailResult<()> {
    sqlx::query(
        "update mail_account_registry set is_active = false, updated_at = $2::timestamp
         where email = $1",
    )
    .bind(catch_all_registry_email(domain))
    .bind(at)
    .execute(master)
    .await?;
    Ok(())
}

/// `syncCatchAllRegistry`: the master `*@domain` sentinel follows the
/// domain's catch-all setting, so inbound mail finds the mailbox.
async fn sync_catch_all(
    state: &MailState,
    caller: &Caller,
    after: &Value,
    at: &str,
) -> MailResult<()> {
    let master = master_db(state, caller, "Failed to update domain")?;
    let domain = text(after, "domainName");
    let account = after["catchAllAccountId"]
        .as_str()
        .filter(|id| !id.is_empty());
    let (true, Some(account)) = (after["catchAllEnabled"].as_bool() == Some(true), account) else {
        return deactivate_catch_all(&master, domain, at).await;
    };
    sqlx::query(
        "insert into mail_account_registry (id, email, tenant_kind, workspace_id, account_id, is_active)
         values ($1, $2, 'workspace', $3, $4, true)
         on conflict (email) do update set tenant_kind = 'workspace', workspace_id = $3,
           personal_account_id = null, account_id = $4, is_active = true,
           updated_at = $5::timestamp",
    )
    .bind(generate_id("reg"))
    .bind(catch_all_registry_email(domain))
    .bind(&caller.workspace_id)
    .bind(account)
    .bind(at)
    .execute(&master)
    .await?;
    Ok(())
}

/// Whether another workspace (or a personal account) has active addresses
/// on `domain` in the master registry.
async fn used_elsewhere(
    master: &PgPool,
    workspace_id: &str,
    domain: &str,
) -> Result<bool, sqlx::Error> {
    let mut pattern = String::from("%@");
    for c in domain.to_lowercase().chars() {
        if matches!(c, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    sqlx::query_scalar(
        "select exists(select 1 from mail_account_registry
           where is_active = true and email like $1 and workspace_id is distinct from $2)",
    )
    .bind(pattern)
    .bind(workspace_id)
    .fetch_one(master)
    .await
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/// `GET /` (`listDomains`): `isActive` and `isPrimary` are
/// `z.coerce.boolean()`, so any non-empty value reads as true.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = query_map(raw.as_deref());
    let flag = |key: &str| query.get(key).map(|value| !value.is_empty());
    let (is_active, is_primary) = (flag("isActive"), flag("isPrimary"));
    let result = async {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(d) from mail_domains d
             where d.deleted_at is null
               and ($1::boolean is null or d.is_active = $1)
               and ($2::boolean is null or d.is_primary = $2)
             order by d.is_primary desc, d.domain_name asc",
        )
        .bind(is_active)
        .bind(is_primary)
        .fetch_all(&caller.db)
        .await?;
        let rows: Vec<Value> = rows.into_iter().map(js_row).collect();
        Ok(Data(Value::Array(rows)).into_response())
    }
    .await;
    answer(result, "Failed to list domains")
}

/// `GET /by-name/:domainName` (`getDomainByName`).
async fn by_name(caller: Caller, Path(domain_name): Path<String>) -> Response {
    let result = async {
        let row: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(d) from mail_domains d
             where d.domain_name = $1 and d.deleted_at is null limit 1",
        )
        .bind(domain_name.to_lowercase())
        .fetch_optional(&caller.db)
        .await?;
        match row {
            Some(row) => Ok(Data(js_row(row)).into_response()),
            None => Err(MailError::not_found("Domain", Some(&domain_name))),
        }
    }
    .await;
    answer(result, "Failed to look up domain")
}

/// `GET /:id`.
async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match find(&caller.db, &id).await? {
            Some(row) => Ok(Data(row).into_response()),
            None => Err(MailError::not_found("Domain", Some(&id))),
        }
    }
    .await;
    answer(result, "Failed to fetch domain")
}

/// `POST /` (`createDomain`): register the domain with the adapter before the
/// row exists, as the worker provisions Cloudflare before inserting.
async fn create(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let domain = issues
            .pattern(
                body,
                "domainName",
                Presence::Required,
                Some(3),
                Some(255),
                is_domain_name,
                "Invalid domain name",
            )
            .into_option()
            .unwrap_or_default();
        (domain, read_fields(issues, body))
    });
    let (domain, fields) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let domain = domain.trim().to_lowercase();
        if is_shared_weldmail_domain(&domain) {
            return Err(weldmail_domain_refused(&domain));
        }
        let existing: Option<String> = sqlx::query_scalar(
            "select id from mail_domains where domain_name = $1 and deleted_at is null limit 1",
        )
        .bind(&domain)
        .fetch_optional(&caller.db)
        .await?;
        if existing.is_some() {
            return Err(MailError::conflict(format!(
                "Domain {domain} is already registered"
            )));
        }
        let adapter = domains_adapter(&state)?;
        let token = uuid::Uuid::new_v4().simple().to_string();
        let outcome = provision(adapter.as_ref(), &domain, Some(&token))
            .await
            .map_err(|error| {
                provider_error(
                    "DOMAIN_PROVISION_FAILED",
                    format!("Couldn't set up mail for {domain}"),
                    &error,
                )
            })?;
        let id = generate_id("mdom");
        let at = now();
        insert(
            &caller.db,
            &id,
            &domain,
            &fields,
            adapter.provider(),
            Some(&token),
            &at,
        )
        .await?;
        store(&caller.db, &id, None, &outcome, &at).await?;
        if fields.is_primary == Some(true) {
            mark_as_sole_primary(&caller.db, &id, &at).await?;
        }
        let row = reread(&caller.db, &id).await?;
        caller.publish(&state, MAIL_DOMAIN_CREATED, &id, &event_data(&row));
        Ok(Created(row).into_response())
    }
    .await;
    answer(result, "Failed to create domain")
}

/// `PUT|PATCH /:id` (`updateDomain`).
async fn update_domain(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let fields = read_fields(issues, body);
        let enabled = issues
            .boolean(body, "catchAllEnabled", Presence::Optional)
            .into_option();
        let account = issues.text(
            body,
            "catchAllAccountId",
            Presence::Nullish,
            Some(1),
            Some(30),
        );
        (fields, enabled, account)
    });
    let (fields, enabled, account) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    if let Err(error) = caller.org() {
        return error.into_response();
    }
    let result = async {
        let Some(existing) = find(&caller.db, &id).await? else {
            return Err(MailError::not_found("Domain", None));
        };
        let domain = text(&existing, "domainName").to_owned();
        let next_enabled = enabled.unwrap_or(existing["catchAllEnabled"].as_bool() == Some(true));
        let next_account: Option<String> = match &account {
            Field::Set(id) => Some(id.clone()),
            Field::Null => None,
            Field::Absent => existing["catchAllAccountId"].as_str().map(str::to_owned),
        };
        if enabled.is_some() || !account.is_absent() {
            validate_catch_all(&caller, &domain, next_enabled, next_account.as_deref()).await?;
        }
        // What `catch_all_account_id` becomes, if it changes: turning
        // catch-all off clears it unless the patch names one.
        let account_write: Option<Option<String>> =
            if enabled == Some(false) || !account.is_absent() {
                Some(account.as_set().cloned())
            } else if enabled == Some(true) && next_account.is_some() {
                Some(next_account.clone())
            } else {
                None
            };
        let at = now();
        sqlx::query(
            "update mail_domains set updated_at = $2::timestamp,
               is_active = coalesce($3, is_active), is_primary = coalesce($4, is_primary),
               mail_provider = coalesce($5, mail_provider),
               send_provider = coalesce($6, send_provider),
               receive_provider = coalesce($7, receive_provider),
               max_email_accounts = coalesce($8, max_email_accounts),
               catch_all_enabled = coalesce($9, catch_all_enabled),
               catch_all_account_id = case when $10 then $11 else catch_all_account_id end
             where id = $1",
        )
        .bind(&id)
        .bind(&at)
        .bind(fields.is_active)
        .bind(fields.is_primary)
        .bind(fields.mail_provider.as_deref())
        .bind(fields.send_provider.as_deref())
        .bind(fields.receive_provider.as_deref())
        .bind(fields.max_email_accounts)
        .bind(enabled)
        .bind(account_write.is_some())
        .bind(account_write.flatten())
        .execute(&caller.db)
        .await?;
        if fields.is_primary == Some(true) {
            mark_as_sole_primary(&caller.db, &id, &at).await?;
        }
        let after = reread(&caller.db, &id).await?;
        sync_catch_all(&state, &caller, &after, &at).await?;
        let mut data = event_data(&after);
        data["catchAllEnabled"] = after["catchAllEnabled"].clone();
        data["catchAllAccountId"] = after["catchAllAccountId"].clone();
        caller.publish(&state, MAIL_DOMAIN_UPDATED, &id, &data);
        Ok(Data(after).into_response())
    }
    .await;
    answer(result, "Failed to update domain")
}

/// `DELETE /:id` (`softDeleteDomain`): the row goes, its catch-all sentinel
/// is deactivated, and the MTA forgets the domain (best effort) when this
/// workspace proved it and no other workspace sends from it.
async fn remove(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = find(&caller.db, &id).await? else {
            return Err(MailError::not_found("Domain", Some(&id)));
        };
        let domain = text(&existing, "domainName").to_owned();
        let at = now();
        sqlx::query(
            "update mail_domains set deleted_at = $2::timestamp, updated_at = $2::timestamp,
               catch_all_enabled = false, catch_all_account_id = null
             where id = $1",
        )
        .bind(&id)
        .bind(&at)
        .execute(&caller.db)
        .await?;
        let master = master_db(&state, &caller, "Failed to delete domain")?;
        deactivate_catch_all(&master, &domain, &at).await?;
        if let Some(adapter) = &state.domains
            && text(&existing, "dnsStatus") == "verified"
        {
            match used_elsewhere(&master, &caller.workspace_id, &domain).await {
                Ok(false) => {
                    if let Err(error) = adapter.deregister(&domain).await {
                        tracing::error!(%error, "[mail-domains] deregistering {domain} failed");
                    }
                }
                Ok(true) => tracing::info!(
                    "[mail-domains] {domain} has addresses in another workspace; left registered"
                ),
                Err(error) => tracing::error!(
                    %error,
                    "[mail-domains] checking {domain} in the registry failed; left registered"
                ),
            }
        }
        caller.publish(&state, MAIL_DOMAIN_DELETED, &id, &event_data(&existing));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete domain")
}

/// `POST /:id/verify` (`verifyDomain`): look the records up again. Safe to
/// call from a "Check now" button.
async fn verify(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = find(&caller.db, &id).await? else {
            return Err(MailError::not_found("Domain", None));
        };
        let domain = text(&existing, "domainName").to_owned();
        let adapter = domains_adapter(&state)?;
        let outcome = check(adapter.as_ref(), &domain, token(&existing))
            .await
            .map_err(|error| {
                provider_error(
                    "DOMAIN_VERIFY_FAILED",
                    format!("Couldn't verify {domain}"),
                    &error,
                )
            })?;
        store(&caller.db, &id, None, &outcome, &now()).await?;
        let after = reread(&caller.db, &id).await?;
        if outcome.verified() {
            caller.publish(&state, MAIL_DOMAIN_VERIFIED, &id, &event_data(&after));
        }
        Ok(Data(after).into_response())
    }
    .await;
    answer(result, "Failed to verify domain")
}

/// `POST /:id/sync` (`syncDomain`): register the domain with this edition's
/// adapter again (a key the MTA lost, a row from another provider) and look
/// it up.
async fn sync(State(state): State<MailState>, caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(existing) = find(&caller.db, &id).await? else {
            return Err(MailError::not_found("Domain", None));
        };
        let domain = text(&existing, "domainName").to_owned();
        let adapter = domains_adapter(&state)?;
        let outcome = provision(adapter.as_ref(), &domain, token(&existing))
            .await
            .map_err(|error| {
                provider_error(
                    "DOMAIN_PROVISION_FAILED",
                    format!("Couldn't re-sync {domain}"),
                    &error,
                )
            })?;
        store(&caller.db, &id, Some(adapter.provider()), &outcome, &now()).await?;
        let after = reread(&caller.db, &id).await?;
        caller.publish(&state, MAIL_DOMAIN_UPDATED, &id, &event_data(&after));
        Ok(Data(after).into_response())
    }
    .await;
    answer(result, "Failed to sync domain")
}

/// `POST /:id/generate-dkim`: the domain's DKIM record from the adapter (the
/// MTA mints the key on first registration).
async fn generate_dkim(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(existing) = find(&caller.db, &id).await? else {
            return Err(MailError::not_found("Domain", None));
        };
        let domain = text(&existing, "domainName").to_owned();
        let adapter = domains_adapter(&state)?;
        let setup = adapter.register(&domain).await.map_err(|error| {
            provider_error(
                "DOMAIN_PROVISION_FAILED",
                format!("Couldn't get the DKIM record of {domain}"),
                &error,
            )
        })?;
        let dkim = setup.dkim_record();
        let selector = setup
            .dkim_selector
            .clone()
            .or_else(|| dkim.and_then(|r| r.name.split('.').next().map(str::to_owned)))
            .unwrap_or_default();
        sqlx::query(
            "update mail_domains set dkim_selector = $2, updated_at = $3::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&selector)
        .bind(now())
        .execute(&caller.db)
        .await?;
        Ok(Data(json!({
            "selector": selector,
            "dnsRecord": dkim.map(|r| r.value.clone()).unwrap_or_default(),
            "provider": adapter.provider(),
        }))
        .into_response())
    }
    .await;
    answer(result, "Failed to generate DKIM record")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_names_are_the_workers_pattern() {
        for ok in [
            "acme.com",
            "mail.acme.co.uk",
            "ACME.NL",
            "a-b.example.museum",
        ] {
            assert!(is_domain_name(ok), "{ok}");
        }
        for bad in [
            "acme",
            "acme.c",
            "acme.c0m",
            ".com",
            "ac me.com",
            "acme.com.",
            "acme_x.com",
        ] {
            assert!(!is_domain_name(bad), "{bad}");
        }
    }

    fn setup(verified: bool) -> DomainSetup {
        DomainSetup {
            records: vec![DnsRecord {
                kind: "MX",
                name: "acme.test".to_owned(),
                value: "mx.eu.weldsuite.test".to_owned(),
                priority: Some(10),
                purpose: "mx",
                verified,
            }],
            verified,
            dkim_selector: None,
        }
    }

    #[test]
    fn a_domain_with_an_ownership_record_needs_it_resolved() {
        let mut ownership = ownership_record("acme.test", "tok");
        let pending = Provisioned {
            setup: setup(true),
            ownership: Some(ownership.clone()),
        };
        assert!(!pending.verified());
        assert_eq!(pending.dns_status(), "pending");
        ownership.verified = true;
        let done = Provisioned {
            setup: setup(true),
            ownership: Some(ownership),
        };
        assert!(done.verified());
        let records = done.records_json();
        assert_eq!(records[0]["name"], "_weldmail-verify.acme.test");
        assert_eq!(records[0]["value"], "weldmail-verify=tok");
        assert_eq!(records[0]["purpose"], "verification");
        assert_eq!(records[1]["type"], "MX");
    }

    #[test]
    fn a_weldhost_domain_needs_no_ownership_record() {
        let outcome = Provisioned {
            setup: setup(true),
            ownership: None,
        };
        assert!(outcome.verified());
        assert_eq!(outcome.records_json().as_array().map(Vec::len), Some(1));
    }
}

/// The routes on the real schema (databases built from the journaled
/// migrations by `scripts/rust-test-db.ts`, as CI does), with a fake
/// adapter. Runs when `WELDSUITE_TEST_MASTER_URL` and
/// `WELDSUITE_TEST_TENANT_URL` are set; otherwise it returns early.
#[cfg(test)]
mod db_tests {
    #![allow(clippy::too_many_lines)] // one scenario, step by step

    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};

    use http::header::CONTENT_TYPE;
    use weldsuite_events::{EntityEventPublisher, EventContext, TaskTracker};
    use weldsuite_mail_domain::outbound::OutboundBindings;
    use weldsuite_ports::BoxFuture;

    use super::*;
    use crate::caller::Bindings;

    /// Pending until `verified` is set; remembers what it deregistered.
    #[derive(Default)]
    struct FakeDomains {
        verified: AtomicBool,
        removed: Mutex<Vec<String>>,
    }

    fn fake_setup(domain: &str, verified: bool) -> DomainSetup {
        DomainSetup {
            records: vec![DnsRecord {
                kind: "MX",
                name: domain.to_owned(),
                value: "mx.mdt.test".to_owned(),
                priority: Some(10),
                purpose: "mx",
                verified,
            }],
            verified,
            dkim_selector: Some("ws1".to_owned()),
        }
    }

    impl MailDomains for FakeDomains {
        fn provider(&self) -> &'static str {
            "fake"
        }
        fn register<'a>(
            &'a self,
            domain: &'a str,
        ) -> BoxFuture<'a, Result<DomainSetup, DomainError>> {
            Box::pin(async move { Ok(fake_setup(domain, false)) })
        }
        fn verify<'a>(
            &'a self,
            domain: &'a str,
        ) -> BoxFuture<'a, Result<DomainSetup, DomainError>> {
            let verified = self.verified.load(Ordering::SeqCst);
            Box::pin(async move { Ok(fake_setup(domain, verified)) })
        }
        fn deregister<'a>(&'a self, domain: &'a str) -> BoxFuture<'a, Result<(), DomainError>> {
            self.removed.lock().expect("lock").push(domain.to_owned());
            Box::pin(async { Ok(()) })
        }
        fn check_record<'a>(
            &'a self,
            _record: &'a DnsRecord,
        ) -> BoxFuture<'a, Result<bool, DomainError>> {
            let verified = self.verified.load(Ordering::SeqCst);
            Box::pin(async move { Ok(verified) })
        }
    }

    fn databases() -> Option<(PgPool, PgPool)> {
        let master = std::env::var("WELDSUITE_TEST_MASTER_URL").ok()?;
        let tenant = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
        Some((
            weldsuite_db::master_pool(&master, 2).expect("master pool"),
            weldsuite_db::master_pool(&tenant, 2).expect("tenant pool"),
        ))
    }

    fn caller(tenant: &PgPool) -> Caller {
        Caller {
            db: tenant.clone(),
            user_id: "user_mdt".to_owned(),
            org_id: Some("org_mdt".to_owned()),
            workspace_id: "ws_mdt".to_owned(),
            events: EventContext::from_ids("ws_mdt", Some("org_mdt"), "user_mdt"),
            bindings: Bindings::default(),
            permissions: None,
        }
    }

    fn json_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            CONTENT_TYPE,
            http::HeaderValue::from_static("application/json"),
        );
        headers
    }

    async fn read(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// WeldMail's own domains are refused before any query or MTA call, so a
    /// pool that never connects is enough.
    #[tokio::test]
    async fn weldmail_domains_stay_with_global() {
        let offline =
            weldsuite_db::master_pool("postgres://nobody@127.0.0.1:1/none", 1).expect("lazy pool");
        let fake = Arc::new(FakeDomains::default());
        let state = MailState {
            events: EntityEventPublisher::new(None, TaskTracker::new()),
            master: None,
            cache: None,
            outbound: OutboundBindings::default(),
            files: None,
            jobs: None,
            system_mail: None,
            http: None,
            doh: None,
            domains: Some(fake.clone()),
            workspace_tenants: None,
            env: Arc::new(HashMap::new()),
        };
        for name in ["weldmail.com", "acme.weldmail.com", "Acme.WeldMail.org"] {
            let body = Bytes::from(json!({ "domainName": name }).to_string());
            let (status, body) =
                read(create(State(state.clone()), caller(&offline), json_headers(), body).await)
                    .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{name}: {body}");
            assert!(
                body["error"]["message"]
                    .as_str()
                    .is_some_and(|m| m.contains("is a WeldMail domain")),
                "{body}"
            );
            let refused = ensure_provisioned(&caller(&offline), fake.as_ref(), name, &now())
                .await
                .expect_err("a WeldMail domain");
            assert_eq!(refused.respond("").status(), StatusCode::BAD_REQUEST);
        }
        // `weldmail.company` is someone else's domain, not WeldMail's.
        assert!(!is_shared_weldmail_domain("weldmail.company"));
    }

    async fn clean(master: &PgPool, tenant: &PgPool) {
        sqlx::raw_sql(
            "delete from mail_domains where domain_name like '%mdt.test';
             delete from domains where full_domain like '%mdt.test';",
        )
        .execute(tenant)
        .await
        .expect("clean tenant");
        sqlx::raw_sql(
            "delete from mail_account_registry where email like '%mdt.test';
             delete from workspaces where id like 'ws_mdt%';",
        )
        .execute(master)
        .await
        .expect("clean master");
    }

    #[tokio::test]
    async fn a_domain_is_added_verified_used_and_removed() {
        let Some((master, tenant)) = databases() else {
            eprintln!("test databases not set; skipping");
            return;
        };
        clean(&master, &tenant).await;
        sqlx::raw_sql(
            "insert into workspaces (id, name, slug, clerk_org_id) values
               ('ws_mdt', 'Acme', 'acme-mdt', 'org_mdt'),
               ('ws_mdt_other', 'Other', 'other-mdt', 'org_mdt_other');",
        )
        .execute(&master)
        .await
        .expect("seed workspaces");

        let fake = Arc::new(FakeDomains::default());
        let state = MailState {
            events: EntityEventPublisher::new(None, TaskTracker::new()),
            master: Some(master.clone()),
            cache: None,
            outbound: OutboundBindings::default(),
            files: None,
            jobs: None,
            system_mail: None,
            http: None,
            doh: None,
            domains: Some(fake.clone()),
            workspace_tenants: None,
            env: Arc::new(HashMap::new()),
        };
        let add = |name: &str| Bytes::from(json!({ "domainName": name }).to_string());

        // Added: pending, the ownership record first, its token kept.
        let (status, body) = read(
            create(
                State(state.clone()),
                caller(&tenant),
                json_headers(),
                add("Acme.mdt.test"),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let domain = &body["data"];
        let id = domain["id"].as_str().expect("id").to_owned();
        assert_eq!(domain["domainName"], "acme.mdt.test");
        assert_eq!(domain["dnsStatus"], "pending");
        assert_eq!(domain["mailProvider"], "fake");
        assert_eq!(domain["dkimSelector"], "ws1");
        assert_eq!(domain["dnsRecords"][0]["purpose"], "verification");
        let token = domain["metadata"]["verificationToken"]
            .as_str()
            .expect("token");
        assert_eq!(
            domain["dnsRecords"][0]["value"],
            format!("weldmail-verify={token}")
        );
        assert!(domain["verifiedAt"].is_null());

        // Once more, and a name the worker's pattern refuses.
        let (status, _) = read(
            create(
                State(state.clone()),
                caller(&tenant),
                json_headers(),
                add("acme.mdt.test"),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _) = read(
            create(
                State(state.clone()),
                caller(&tenant),
                json_headers(),
                add("not a domain"),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // No mailbox on it until it is verified.
        let refused = ensure_provisioned(&caller(&tenant), fake.as_ref(), "acme.mdt.test", &now())
            .await
            .expect_err("pending domain");
        assert_eq!(refused.respond("").status(), StatusCode::BAD_REQUEST);

        fake.verified.store(true, Ordering::SeqCst);
        let (status, body) =
            read(verify(State(state.clone()), caller(&tenant), Path(id.clone())).await).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["dnsStatus"], "verified");
        assert_eq!(body["data"]["dnsRecords"][0]["verified"], true);
        assert!(body["data"]["verifiedAt"].is_string());
        ensure_provisioned(&caller(&tenant), fake.as_ref(), "acme.mdt.test", &now())
            .await
            .expect("verified domain");

        // Listed, filtered, made primary; catch-all needs a mailbox.
        let (_, body) = read(list(caller(&tenant), RawQuery(None)).await).await;
        assert!(
            body["data"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|r| r["id"] == json!(id)))
        );
        let (_, body) =
            read(list(caller(&tenant), RawQuery(Some("isPrimary=true".to_owned()))).await).await;
        assert!(
            body["data"]
                .as_array()
                .is_some_and(|rows| rows.iter().all(|r| r["id"] != json!(id)))
        );
        let patch = |value: Value| Bytes::from(value.to_string());
        let (status, body) = read(
            update_domain(
                State(state.clone()),
                caller(&tenant),
                Path(id.clone()),
                json_headers(),
                patch(json!({ "isPrimary": true, "maxEmailAccounts": 20 })),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["isPrimary"], true);
        assert_eq!(body["data"]["maxEmailAccounts"], 20);
        let (status, body) = read(
            update_domain(
                State(state.clone()),
                caller(&tenant),
                Path(id.clone()),
                json_headers(),
                patch(json!({ "catchAllEnabled": true })),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let (_, body) =
            read(by_name(caller(&tenant), Path("ACME.mdt.test".to_owned())).await).await;
        assert_eq!(body["data"]["id"], json!(id));

        // An active WeldHost domain takes a mailbox at once: registered, no
        // ownership record.
        sqlx::query(
            "insert into domains (id, name, tld, full_domain, status)
             values ('dom_mdt_host', 'host', 'test', 'host.mdt.test', 'active')",
        )
        .execute(&tenant)
        .await
        .expect("weldhost domain");
        ensure_provisioned(&caller(&tenant), fake.as_ref(), "host.mdt.test", &now())
            .await
            .expect("weldhost domain");
        let (provider, metadata): (Option<String>, Option<Value>) = sqlx::query_as(
            "select mail_provider, metadata from mail_domains
             where domain_name = 'host.mdt.test' and deleted_at is null",
        )
        .fetch_one(&tenant)
        .await
        .expect("provisioned row");
        assert_eq!(provider.as_deref(), Some("fake"));
        assert!(metadata.is_none());

        // Removing a verified domain nobody else sends from deregisters it…
        let (status, _) =
            read(remove(State(state.clone()), caller(&tenant), Path(id.clone())).await).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(
            fake.removed.lock().expect("lock").as_slice(),
            ["acme.mdt.test"]
        );
        let (status, _) = read(detail(caller(&tenant), Path(id)).await).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // …but not one another workspace has addresses on.
        let (_, body) = read(
            create(
                State(state.clone()),
                caller(&tenant),
                json_headers(),
                add("shared.mdt.test"),
            )
            .await,
        )
        .await;
        let shared = body["data"]["id"].as_str().expect("id").to_owned();
        assert_eq!(body["data"]["dnsStatus"], "verified");
        sqlx::query(
            "insert into mail_account_registry (id, email, workspace_id, account_id, is_active)
             values ('reg_mdt_other', 'eve@shared.mdt.test', 'ws_mdt_other', 'mail_other', true)",
        )
        .execute(&master)
        .await
        .expect("other workspace's address");
        let (status, _) =
            read(remove(State(state.clone()), caller(&tenant), Path(shared)).await).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(fake.removed.lock().expect("lock").len(), 1);

        clean(&master, &tenant).await;
    }
}
