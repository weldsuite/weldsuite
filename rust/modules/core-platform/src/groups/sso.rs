//! `/api/sso` (`app-api/src/routes/sso`, `services/sso.ts`,
//! `@weldsuite/core-domain/sso`): a workspace's enterprise single sign-on.
//!
//! - `GET /`: the configuration (entitlement, domain, connection), `sso:read`.
//! - `PUT|DELETE /domain`, `POST /domain/verify`: claim a domain and prove it
//!   with a TXT record, `sso:manage`.
//! - `PUT|DELETE /connection`, `POST /connection/activate|deactivate`: the
//!   SAML connection, `sso:manage`.
//! - `POST /domains`, `DELETE /domains/{domain}`, `POST /domains/{domain}/verify`:
//!   a WeldID connection's domains, `sso:manage` (404 without WeldID).
//! - `GET /billing` (`sso:read`), `POST /billing/subscribe|cancel|resume`
//!   (`billing:manage`): the paid add-on.
//!
//! The state is the master database's `workspace_sso` row. Every
//! configuration write answers with the configuration after it and publishes
//! `workspace_settings.updated` (`field: 'sso'`, what changed, the domain,
//! the provider, whether SSO is on), never the identity provider's details.
//!
//! What stays Global-only:
//!
//! - The SAML connection lives at Clerk (ADR SEC-010); on Kubernetes the
//!   identity provider's own federation applies and the
//!   [`Identity`](weldsuite_ports::Identity) port has no SAML connections.
//!   Every step that asks Clerk answers as the workers do when Clerk cannot
//!   be reached: the view shows no live identity provider details and no user count, and a
//!   change that needs Clerk is a 502 `SSO_PROVIDER_UNAVAILABLE`.
//! - The add-on's billing is billing-worker's (Stripe): `/billing` answers
//!   as when billing-worker cannot be reached, 502 `BILLING_UNAVAILABLE`.
//!
//! The domain's TXT record is looked up over DNS-over-HTTPS
//! (`@weldsuite/worker-kit/dns-lookup`), through [`DnsGateway`] when the
//! request carries one (conformance builds: the test's fetch stub), else
//! Cloudflare's resolver as the workers use it.
//!
//! With WeldID as the identity provider ([`CorePlatformState::sso`] set),
//! the connection is an `OpenID` Connect connection at WeldID instead, with
//! its own domains, and every route but `/billing` is served by [`weldid`]
//! (ADR SEC-019, phase 5a). Conformance builds never set it, so what
//! Global's tests see is unchanged.

mod weldid;

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Extension, Router};
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, QueryFilter,
    QuerySelect,
};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::WORKSPACE_SETTINGS_UPDATED;
use weldsuite_db::{PgPool, is_unique_violation, orm, utc_now};
use weldsuite_kit::validation::{Format, Issues, Presence, Text, js_trim};
use weldsuite_kit::{ApiError, Data, generate_id, random_string};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::BoxFuture;
use weldsuite_schema::master::{plans, workspace_sso, workspaces};

use crate::{Caller, CorePlatformState, PlatformError, PlatformResult, answer, validate};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["sso:read"]);
    let manage = || gate.require(["sso:manage"]);
    // Starting or ending the paid add-on spends money: the billing write grant.
    let billing = || gate.require(["billing:manage"]);
    Router::new()
        .route("/", get(show).route_layer(read()))
        .route(
            "/domain",
            put(claim_domain)
                .delete(remove_domain)
                .route_layer(manage()),
        )
        .route("/domain/verify", post(verify_domain).route_layer(manage()))
        .route(
            "/connection",
            put(save_connection)
                .delete(remove_connection)
                .route_layer(manage()),
        )
        .route("/connection/activate", post(activate).route_layer(manage()))
        .route(
            "/connection/deactivate",
            post(deactivate).route_layer(manage()),
        )
        // A WeldID connection's domains (WeldID mode only; Global has one).
        .route("/domains", post(add_domain).route_layer(manage()))
        .route(
            "/domains/{domain}",
            delete(remove_named_domain).route_layer(manage()),
        )
        .route(
            "/domains/{domain}/verify",
            post(verify_named_domain).route_layer(manage()),
        )
        .route("/billing", get(billing_unavailable).route_layer(read()))
        .route(
            "/billing/subscribe",
            post(billing_unavailable).route_layer(billing()),
        )
        .route(
            "/billing/cancel",
            post(billing_unavailable).route_layer(billing()),
        )
        .route(
            "/billing/resume",
            post(billing_unavailable).route_layer(billing()),
        )
}

// ── DNS ─────────────────────────────────────────────────────────────────────

const DOH_ENDPOINT: &str = "https://cloudflare-dns.com/dns-query";
/// DNS's type code for TXT records.
const TXT: f64 = 16.0;

/// One GET to a DNS-over-HTTPS resolver: the status and body, or why it
/// could not be sent (the workers' `fetch` throwing).
pub trait DnsTransport: Send + Sync {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<(u16, String), String>>;
}

/// The DNS-over-HTTPS transport a request uses, as a request extension.
/// Without one, Cloudflare's resolver is asked directly.
#[derive(Clone)]
pub struct DnsGateway(pub Arc<dyn DnsTransport>);

impl std::fmt::Debug for DnsGateway {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DnsGateway")
    }
}

/// Cloudflare's resolver over HTTPS, as `lookupRecord` asks it.
struct HttpsDns(reqwest::Client);

impl DnsTransport for HttpsDns {
    fn get<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<(u16, String), String>> {
        Box::pin(async move {
            let response = self
                .0
                .get(url)
                .header("accept", "application/dns-json")
                .send()
                .await
                .map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let body = response.text().await.map_err(|error| error.to_string())?;
            Ok((status, body))
        })
    }
}

static HTTPS_DNS: LazyLock<Arc<dyn DnsTransport>> = LazyLock::new(|| {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default();
    Arc::new(HttpsDns(client))
});

/// JavaScript's `encodeURIComponent`.
fn encode_uri_component(value: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let unreserved = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `lookupTxt(name)`: the TXT values found, or why the lookup failed.
async fn lookup_txt(dns: &dyn DnsTransport, name: &str) -> Result<Vec<String>, String> {
    let url = format!(
        "{DOH_ENDPOINT}?name={}&type=TXT",
        encode_uri_component(name)
    );
    let (status, body) = dns.get(&url).await?;
    if !(200..300).contains(&status) {
        return Err(format!("DNS lookup failed with status {status}"));
    }
    let body: Value = serde_json::from_str(&body).map_err(|error| error.to_string())?;
    if body.is_null() {
        return Err("the resolver answered null".to_owned());
    }
    let answers = match body.get("Answer") {
        Some(Value::Array(answers)) => answers,
        // `if (!body.Answer) return []`; a string iterates to nothing usable.
        None | Some(Value::Null | Value::Bool(false) | Value::String(_)) => return Ok(Vec::new()),
        Some(Value::Number(n)) if n.as_f64().is_some_and(|n| n.abs() < f64::EPSILON) => {
            return Ok(Vec::new());
        }
        Some(_) => return Err("the resolver's Answer is not a list".to_owned()),
    };
    let mut values = Vec::new();
    for answer in answers {
        if answer.is_null() {
            return Err("a null answer".to_owned());
        }
        let is_txt = answer
            .get("type")
            .and_then(Value::as_f64)
            .is_some_and(|code| (code - TXT).abs() < f64::EPSILON);
        if !is_txt {
            continue;
        }
        if !answer.get("name").is_some_and(Value::is_string) {
            return Err("an answer without a name".to_owned());
        }
        let Some(data) = answer.get("data").and_then(Value::as_str) else {
            return Err("an answer without data".to_owned());
        };
        values.push(parse_txt_data(data));
    }
    Ok(values)
}

/// JavaScript's line terminators, which a regex `.` does not match.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `parseTxtData`: the quoted chunks (`/"((?:[^"\\]|\\.)*)"/g`) joined, or
/// the data as it is when it has none.
fn parse_txt_data(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut chunks: Vec<String> = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        if chars[start] != '"' {
            start += 1;
            continue;
        }
        // Scan to the closing quote; an escape takes the next character
        // unless it ends a line.
        let mut i = start + 1;
        let mut closed = None;
        while i < chars.len() {
            match chars[i] {
                '"' => {
                    closed = Some(i);
                    break;
                }
                '\\' => match chars.get(i + 1) {
                    Some(&next) if !is_line_terminator(next) => i += 2,
                    _ => break,
                },
                _ => i += 1,
            }
        }
        if let Some(end) = closed {
            chunks.push(chars[start + 1..end].iter().collect());
            start = end + 1;
        } else {
            start += 1;
        }
    }
    if chunks.is_empty() {
        raw.to_owned()
    } else {
        chunks.concat()
    }
}

// ── Domains ─────────────────────────────────────────────────────────────────

const DNS_RECORD_PREFIX: &str = "_weldsuite-sso";
const DNS_VALUE_PREFIX: &str = "weldsuite-sso-verification=";

/// `ssoDnsRecordName`.
fn dns_record_name(domain: &str) -> String {
    format!("{DNS_RECORD_PREFIX}.{domain}")
}

/// `ssoDnsRecordValue`.
fn dns_record_value(token: &str) -> String {
    format!("{DNS_VALUE_PREFIX}{token}")
}

/// `ssoDnsRecordMatches`: any value is the expected one, quotes and
/// whitespace aside (`value.replace(/^"|"$/g, '').trim()`).
fn dns_record_matches(values: &[String], token: &str) -> bool {
    let expected = dns_record_value(token);
    values.iter().any(|value| {
        let unquoted = value.strip_prefix('"').unwrap_or(value);
        let unquoted = unquoted.strip_suffix('"').unwrap_or(unquoted);
        js_trim(unquoted) == expected
    })
}

/// `/^(?!-)[a-z0-9-]{1,63}(?<!-)$/`.
fn hostname_label(label: &str) -> bool {
    (1..=63).contains(&label.len())
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The length of `^[a-z][a-z0-9+.-]*:\/\/` at the start of `value`, if it
/// has one.
fn scheme_length(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    if !bytes.first().is_some_and(u8::is_ascii_lowercase) {
        return None;
    }
    let end = bytes
        .iter()
        .skip(1)
        .position(|&b| {
            !(b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'+' | b'.' | b'-'))
        })
        .map_or(bytes.len(), |i| i + 1);
    value[end..].starts_with("://").then_some(end + 3)
}

/// `normalizeSsoDomain`: what a person typed (`https://www.Acme.com/`,
/// "jane@acme.com") to the bare lowercase domain, or `None` when it isn't a
/// registrable-looking hostname.
fn normalize_sso_domain(input: &str) -> Option<String> {
    let mut value = js_trim(input).to_lowercase();
    if let Some(length) = scheme_length(&value) {
        value.replace_range(..length, "");
    }
    if let Some(at) = value.rfind('@') {
        value.replace_range(..=at, "");
    }
    if let Some(end) = value.find(['/', '?', '#', ':']) {
        value.truncate(end);
    }
    if value.ends_with('.') {
        value.pop();
    }
    if value.starts_with("www.") {
        value.replace_range(..4, "");
    }

    let length = value.encode_utf16().count();
    if !(3..=253).contains(&length) {
        return None;
    }
    let labels: Vec<&str> = value.split('.').collect();
    if labels.len() < 2 || !labels.iter().all(|label| hostname_label(label)) {
        return None;
    }
    // The top-level label is never all digits (rules out IPv4 addresses).
    if labels
        .last()
        .is_some_and(|tld| tld.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some(value)
}

/// `PUBLIC_EMAIL_DOMAINS`.
const PUBLIC_EMAIL_DOMAINS: &[&str] = &[
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "yahoo.com",
    "ymail.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
    "pm.me",
    "gmx.com",
    "gmx.net",
    "gmx.de",
    "web.de",
    "mail.com",
    "zoho.com",
    "yandex.com",
    "yandex.ru",
    "hey.com",
    "fastmail.com",
    "tutanota.com",
    "tuta.io",
    "qq.com",
    "163.com",
    "126.com",
    "naver.com",
    "hotmail.nl",
    "live.nl",
    "outlook.nl",
    "hotmail.be",
    "live.be",
    "outlook.be",
    "hotmail.fr",
    "live.fr",
    "outlook.fr",
    "hotmail.de",
    "outlook.de",
    "hotmail.co.uk",
    "live.co.uk",
    "yahoo.co.uk",
    "yahoo.fr",
    "yahoo.de",
    "ziggo.nl",
    "kpnmail.nl",
    "planet.nl",
    "home.nl",
    "hetnet.nl",
    "telenet.be",
    "skynet.be",
    "orange.fr",
    "free.fr",
    "wanadoo.fr",
    "laposte.net",
    "t-online.de",
    "btinternet.com",
];

// ── State ───────────────────────────────────────────────────────────────────

/// `SsoWorkspace`.
struct Workspace {
    id: String,
    clerk_org_id: Option<String>,
    is_active: bool,
    deleted: bool,
}

/// The `workspace_sso` row (`WorkspaceSso`), the columns the routes read.
struct SsoRow {
    id: String,
    domain: Option<String>,
    token: Option<String>,
    verified_at: Option<String>,
    connection_id: Option<String>,
    provider: Option<String>,
    enabled: bool,
    clerk_active: bool,
    acs_url: Option<String>,
    sp_entity_id: Option<String>,
    sp_metadata_url: Option<String>,
    connection_updated_at: Option<String>,
    price_override_cents: Option<i64>,
    subscription_status: Option<String>,
}

impl SsoRow {
    fn from_row(row: &Value) -> Self {
        let text = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
        Self {
            id: text("id").unwrap_or_default(),
            domain: text("domain"),
            token: text("domainVerificationToken"),
            verified_at: text("domainVerifiedAt"),
            connection_id: text("clerkConnectionId"),
            provider: text("provider"),
            enabled: row["enabled"].as_bool().unwrap_or(false),
            clerk_active: row["clerkActive"].as_bool().unwrap_or(false),
            acs_url: text("acsUrl"),
            sp_entity_id: text("spEntityId"),
            sp_metadata_url: text("spMetadataUrl"),
            connection_updated_at: text("connectionUpdatedAt"),
            price_override_cents: row["priceOverrideCents"].as_i64(),
            subscription_status: text("subscriptionStatus"),
        }
    }
}

/// JavaScript truthiness of an optional string.
fn truthy(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|text| !text.is_empty())
}

/// `SsoContext`.
struct Context {
    workspace: Workspace,
    row: Option<SsoRow>,
    plan_includes_sso: bool,
}

impl Context {
    fn domain(&self) -> Option<&str> {
        self.row
            .as_ref()
            .and_then(|row| truthy(row.domain.as_ref()))
    }

    fn connection_id(&self) -> Option<&str> {
        self.row
            .as_ref()
            .and_then(|row| truthy(row.connection_id.as_ref()))
    }

    fn verified(&self) -> bool {
        self.row
            .as_ref()
            .is_some_and(|row| row.verified_at.is_some())
    }

    /// `ssoEntitlement` (`resolveSsoEntitlement`): the plan, a free staff
    /// grant (price 0), or a live add-on (past-due still counts).
    fn entitlement(&self) -> (bool, Option<&'static str>) {
        if !self.workspace.is_active || self.workspace.deleted {
            return (false, None);
        }
        if self.plan_includes_sso {
            return (true, Some("plan"));
        }
        let row = self.row.as_ref();
        if row.and_then(|row| row.price_override_cents) == Some(0) {
            return (true, Some("free"));
        }
        match row.and_then(|row| row.subscription_status.as_deref()) {
            Some("active" | "past_due") => (true, Some("subscription")),
            _ => (false, None),
        }
    }
}

type WorkspaceRow = (String, Option<String>, Option<String>, bool, bool);

/// `planIncludesSso`: `plans.features.sso` of the workspace's plan.
async fn plan_includes_sso(master: &PgPool, plan_id: Option<&str>) -> Result<bool, DbErr> {
    let Some(plan_id) = plan_id.filter(|plan| !plan.is_empty()) else {
        return Ok(false);
    };
    let features: Option<Option<Value>> = plans::Entity::find()
        .select_only()
        .column(plans::Column::Features)
        .filter(plans::Column::Id.eq(plan_id))
        .into_tuple()
        .one(&orm(master))
        .await?;
    Ok(features
        .flatten()
        .is_some_and(|features| features.get("sso") == Some(&Value::Bool(true))))
}

/// `select id, clerk_org_id, plan_id, is_active, deleted_at is not null from
/// workspaces where …`: the workspace `loadSsoContext` reads.
async fn workspace_row(
    master: &DatabaseConnection,
    filter: Condition,
) -> Result<Option<WorkspaceRow>, DbErr> {
    use workspaces::Column as W;
    workspaces::Entity::find()
        .select_only()
        .columns([W::Id, W::ClerkOrgId, W::PlanId, W::IsActive])
        .expr(sea_orm::ExprTrait::is_not_null(Expr::col(W::DeletedAt)))
        .filter(filter)
        .into_tuple()
        .one(master)
        .await
}

/// The workspace's `workspace_sso` row, as the routes read it.
async fn sso_row(master: &DatabaseConnection, workspace_id: &str) -> Result<Option<SsoRow>, DbErr> {
    let row = workspace_sso::Entity::find()
        .filter(workspace_sso::Column::WorkspaceId.eq(workspace_id))
        .one(master)
        .await?;
    row.map(|row| {
        serde_json::to_value(row)
            .map(|row| SsoRow::from_row(&row))
            .map_err(|error| DbErr::Json(error.to_string()))
    })
    .transpose()
}

/// `loadSsoContext` for the workspace `filter` finds: `None` without one.
async fn context_where(master: &PgPool, filter: Condition) -> Result<Option<Context>, DbErr> {
    let db = orm(master);
    let Some((id, clerk_org_id, plan_id, is_active, deleted)) = workspace_row(&db, filter).await?
    else {
        return Ok(None);
    };
    let row = sso_row(&db, &id).await?;
    let plan_includes_sso = plan_includes_sso(master, plan_id.as_deref()).await?;
    Ok(Some(Context {
        workspace: Workspace {
            id,
            clerk_org_id,
            is_active,
            deleted,
        },
        row,
        plan_includes_sso,
    }))
}

/// `loadSsoContext(db, { clerkOrgId })`: `None` without a workspace.
async fn load_context(master: &PgPool, clerk_org_id: &str) -> Result<Option<Context>, DbErr> {
    context_where(
        master,
        Condition::all().add(workspaces::Column::ClerkOrgId.eq(clerk_org_id)),
    )
    .await
}

/// `update workspace_sso set …, connection_updated_by, connection_updated_at
/// = updated_at = now where id = … and <condition>`: whether a row matched
/// (the old `returning id`).
async fn update_row(
    master: &PgPool,
    id: &str,
    condition: Condition,
    actor: &str,
    values: Vec<(workspace_sso::Column, Expr)>,
) -> Result<bool, DbErr> {
    use workspace_sso::Column as S;
    let at = utc_now().assume_utc();
    let mut update = workspace_sso::Entity::update_many();
    for (column, value) in values {
        update = update.col_expr(column, value);
    }
    let done = update
        .col_expr(S::ConnectionUpdatedBy, Expr::value(actor.to_owned()))
        .col_expr(S::ConnectionUpdatedAt, Expr::value(at))
        .col_expr(S::UpdatedAt, Expr::value(at))
        .filter(S::Id.eq(id))
        .filter(condition)
        .exec(&orm(master))
        .await?;
    Ok(done.rows_affected > 0)
}

// ── Refusals ────────────────────────────────────────────────────────────────

/// `SsoError`: `{ error: { code, message } }` with `status`.
fn refusal(status: StatusCode, code: &'static str, message: &'static str) -> PlatformError {
    PlatformError::api(ApiError::new(status, code, message))
}

fn changed_meanwhile() -> PlatformError {
    refusal(
        StatusCode::CONFLICT,
        "SSO_CHANGED_MEANWHILE",
        "Single sign-on was changed by another request. Reload and try again.",
    )
}

fn domain_in_use() -> PlatformError {
    refusal(
        StatusCode::CONFLICT,
        "SSO_DOMAIN_IN_USE",
        "Another workspace already uses this domain for single sign-on.",
    )
}

fn domain_not_verified() -> PlatformError {
    refusal(
        StatusCode::CONFLICT,
        "SSO_DOMAIN_NOT_VERIFIED",
        "Verify your domain first.",
    )
}

/// `clerkFailure` of a call that could not reach the provider (no status):
/// a 502. Every call to Clerk's SAML connections ends here on Kubernetes.
fn provider_unreachable(call: &str) -> PlatformError {
    tracing::error!(
        call,
        "sso: the identity provider's SAML connections are not reachable here"
    );
    refusal(
        StatusCode::BAD_GATEWAY,
        "SSO_PROVIDER_UNAVAILABLE",
        "Single sign-on could not be updated right now. Try again later.",
    )
}

/// `requireEntitled`.
fn require_entitled(ctx: &Context) -> PlatformResult<()> {
    if ctx.entitlement().0 {
        Ok(())
    } else {
        Err(refusal(
            StatusCode::PAYMENT_REQUIRED,
            "SSO_NOT_ENTITLED",
            "Add single sign-on to your workspace first.",
        ))
    }
}

// ── View ────────────────────────────────────────────────────────────────────

/// `buildSsoView`. The live connection (Clerk's) can't be read here, so its
/// identity provider details are empty and its user count unknown, as when Clerk fails.
fn view(ctx: &Context, can_manage: bool) -> Value {
    let (entitled, source) = ctx.entitlement();
    let row = ctx.row.as_ref();
    let domain = row.and_then(|row| {
        let name = truthy(row.domain.as_ref())?;
        let token = truthy(row.token.as_ref())?;
        Some(json!({
            "name": name,
            "verified": row.verified_at.is_some(),
            "verifiedAt": row.verified_at,
            "dnsRecord": {
                "type": "TXT",
                "name": dns_record_name(name),
                "value": dns_record_value(token),
            },
        }))
    });
    let connection = row.and_then(|row| {
        truthy(row.connection_id.as_ref())?;
        let provider = truthy(row.provider.as_ref())?;
        Some(json!({
            "provider": provider,
            "enabled": row.enabled,
            "active": row.clerk_active,
            "idp": {
                "metadataUrl": null,
                "hasMetadata": false,
                "entityId": null,
                "ssoUrl": null,
                "hasCertificate": false,
            },
            "idpConfigured": false,
            "sp": {
                "acsUrl": row.acs_url,
                "entityId": row.sp_entity_id,
                "metadataUrl": row.sp_metadata_url,
            },
            "userCount": null,
            "updatedAt": row.connection_updated_at,
        }))
    });
    json!({
        "entitlement": { "entitled": entitled, "source": source },
        "domain": domain,
        "connection": connection,
        "canManage": can_manage,
    })
}

/// `loadContext`: the caller's workspace, or the 404.
async fn context_of(caller: &Caller, master: &PgPool) -> PlatformResult<Context> {
    let found = match caller.clerk_org_id.as_deref() {
        Some(org) => load_context(master, org).await?,
        None => None,
    };
    found.ok_or_else(|| {
        refusal(
            StatusCode::NOT_FOUND,
            "WORKSPACE_NOT_FOUND",
            "Workspace not found.",
        )
    })
}

/// `GET /`.
async fn show(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    if let Some(directory) = state.sso.clone() {
        return answer(weldid::show(&state, &caller, &*directory).await);
    }
    answer(
        async {
            let master = caller.master(&state);
            let ctx = context_of(&caller, &master).await?;
            Ok(Data(view(&ctx, caller.can("sso:manage"))).into_response())
        }
        .await,
    )
}

/// `change(c, kind, run)` after `run`: the configuration now, recorded as
/// `workspace_settings.updated`.
async fn changed(
    state: &CorePlatformState,
    caller: &Caller,
    master: &PgPool,
    kind: &str,
) -> PlatformResult<Response> {
    let ctx = context_of(caller, master).await?;
    let view = view(&ctx, caller.can("sso:manage"));
    let data = json!({
        "id": ctx.workspace.id,
        "field": "sso",
        "change": kind,
        "domain": view["domain"]["name"].as_str(),
        "domainVerified": view["domain"]["verified"].as_bool().unwrap_or(false),
        "provider": view["connection"]["provider"].as_str(),
        "enabled": view["connection"]["enabled"].as_bool().unwrap_or(false),
    });
    caller.publish(state, WORKSPACE_SETTINGS_UPDATED, &ctx.workspace.id, &data);
    Ok(Data(view).into_response())
}

// ── Domain ──────────────────────────────────────────────────────────────────

/// `PUT /domain`.
async fn claim_domain(
    State(state): State<CorePlatformState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(directory) = state.sso.clone() {
        return answer(
            async {
                let domain = weldid::read_domain(&headers, &body)?;
                weldid::add_domain(&state, &caller, &*directory, &domain).await
            }
            .await,
        );
    }
    answer(
        async {
            let domain = validate(&headers, &body, |issues, fields| {
                issues
                    .text_with(
                        fields,
                        "domain",
                        Presence::Required,
                        Text::trimmed(Some(1), Some(300)),
                    )
                    .into_option()
                    .unwrap_or_default()
            })?;
            let master = caller.master(&state);
            let before = context_of(&caller, &master).await?;
            set_domain(&master, before, &domain, &caller.user_id).await?;
            changed(&state, &caller, &master, "domain_claimed").await
        }
        .await,
    )
}

/// `assertDomainFree`: no other workspace verified `domain`.
async fn assert_domain_free(
    master: &PgPool,
    domain: &str,
    workspace_id: &str,
) -> PlatformResult<()> {
    use workspace_sso::Column as S;
    let taken: Option<String> = workspace_sso::Entity::find()
        .select_only()
        .column(S::Id)
        .filter(S::Domain.eq(domain))
        .filter(S::DomainVerifiedAt.is_not_null())
        .filter(S::WorkspaceId.ne(workspace_id))
        .into_tuple()
        .one(&orm(master))
        .await?;
    if taken.is_some() {
        return Err(domain_in_use());
    }
    Ok(())
}

/// `ensureSsoRow`: the workspace's row, created when it has none.
async fn ensure_row(master: &PgPool, workspace: &Workspace) -> PlatformResult<SsoRow> {
    let Some(clerk_org_id) = workspace.clerk_org_id.as_deref() else {
        return Err(PlatformError::internal(
            "Internal server error",
            format!("Workspace {} has no Clerk organization", workspace.id),
        ));
    };
    let db = orm(master);
    let row = workspace_sso::ActiveModel {
        id: Set(generate_id("wsso")),
        workspace_id: Set(workspace.id.clone()),
        clerk_org_id: Set(clerk_org_id.to_owned()),
        ..Default::default()
    };
    workspace_sso::Entity::insert(row)
        .on_conflict(
            OnConflict::column(workspace_sso::Column::WorkspaceId)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(&db)
        .await?;
    sso_row(&db, &workspace.id).await?.ok_or_else(|| {
        PlatformError::internal(
            "Internal server error",
            format!("Could not create the SSO row of workspace {}", workspace.id),
        )
    })
}

/// `setSsoDomain`: the same domain again keeps its token; another starts over.
async fn set_domain(master: &PgPool, ctx: Context, input: &str, actor: &str) -> PlatformResult<()> {
    use workspace_sso::Column as S;
    let Some(domain) = normalize_sso_domain(input) else {
        return Err(refusal(
            StatusCode::BAD_REQUEST,
            "SSO_DOMAIN_INVALID",
            "Enter a domain like acme.com.",
        ));
    };
    if PUBLIC_EMAIL_DOMAINS.contains(&domain.as_str()) {
        return Err(refusal(
            StatusCode::BAD_REQUEST,
            "SSO_DOMAIN_PUBLIC",
            "Use your company domain, not a public email provider.",
        ));
    }

    let row = match ctx.row {
        Some(row) => row,
        None => ensure_row(master, &ctx.workspace).await?,
    };
    if row.domain.as_deref() == Some(domain.as_str()) {
        return Ok(());
    }
    if truthy(row.connection_id.as_ref()).is_some() {
        return Err(refusal(
            StatusCode::CONFLICT,
            "SSO_DOMAIN_LOCKED",
            "Remove the identity provider connection before changing the domain.",
        ));
    }
    assert_domain_free(master, &domain, &ctx.workspace.id).await?;

    let saved = update_row(
        master,
        &row.id,
        Condition::all().add(S::ClerkConnectionId.is_null()),
        actor,
        vec![
            (S::Domain, Expr::value(domain)),
            (
                S::DomainVerificationToken,
                Expr::value(random_string(32, "0123456789abcdef")),
            ),
            (S::DomainVerifiedAt, Expr::null()),
        ],
    )
    .await?;
    saved.then_some(()).ok_or_else(changed_meanwhile)
}

/// `DELETE /domain`.
async fn remove_domain(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    use workspace_sso::Column as S;
    if let Some(directory) = state.sso.clone() {
        return answer(weldid::remove_domain(&state, &caller, &*directory, None).await);
    }
    answer(
        async {
            let master = caller.master(&state);
            let before = context_of(&caller, &master).await?;
            if let Some(row) = before.row.as_ref().filter(|_| before.domain().is_some()) {
                if before.connection_id().is_some() {
                    return Err(refusal(
                        StatusCode::CONFLICT,
                        "SSO_DOMAIN_LOCKED",
                        "Remove the identity provider connection before removing the domain.",
                    ));
                }
                let saved = update_row(
                    &master,
                    &row.id,
                    Condition::all().add(S::ClerkConnectionId.is_null()),
                    &caller.user_id,
                    vec![
                        (S::Domain, Expr::null()),
                        (S::DomainVerificationToken, Expr::null()),
                        (S::DomainVerifiedAt, Expr::null()),
                    ],
                )
                .await?;
                if !saved {
                    return Err(changed_meanwhile());
                }
            }
            changed(&state, &caller, &master, "domain_removed").await
        }
        .await,
    )
}

/// `POST /domain/verify`: look for the TXT record; on a match the domain is
/// the workspace's.
async fn verify_domain(
    State(state): State<CorePlatformState>,
    caller: Caller,
    dns: Option<Extension<DnsGateway>>,
) -> Response {
    if let Some(directory) = state.sso.clone() {
        // WeldID runs the DNS check itself: it acts on the result.
        return answer(weldid::verify_domain(&state, &caller, &*directory, None).await);
    }
    answer(
        async {
            let master = caller.master(&state);
            let before = context_of(&caller, &master).await?;
            let transport = dns.map_or_else(|| Arc::clone(&HTTPS_DNS), |Extension(dns)| dns.0);
            verify(&master, &before, &*transport, &caller.user_id).await?;
            changed(&state, &caller, &master, "domain_verified").await
        }
        .await,
    )
}

/// `verifySsoDomain`.
async fn verify(
    master: &PgPool,
    ctx: &Context,
    dns: &dyn DnsTransport,
    actor: &str,
) -> PlatformResult<()> {
    use workspace_sso::Column as S;
    let claim = ctx.row.as_ref().and_then(|row| {
        let domain = truthy(row.domain.as_ref())?;
        let token = truthy(row.token.as_ref())?;
        Some((row, domain, token))
    });
    let Some((row, domain, token)) = claim else {
        return Err(refusal(
            StatusCode::CONFLICT,
            "SSO_DOMAIN_MISSING",
            "Add your domain first.",
        ));
    };
    if row.verified_at.is_some() {
        return Ok(());
    }

    let values = match lookup_txt(dns, &dns_record_name(domain)).await {
        Ok(values) => values,
        Err(error) => {
            tracing::warn!(error, "sso: the TXT lookup failed");
            return Err(refusal(
                StatusCode::BAD_GATEWAY,
                "SSO_DNS_LOOKUP_FAILED",
                "The DNS lookup failed. Try again in a minute.",
            ));
        }
    };
    if !dns_record_matches(&values, token) {
        return Err(refusal(
            StatusCode::UNPROCESSABLE_ENTITY,
            "SSO_DOMAIN_NOT_VERIFIED",
            "The TXT record was not found yet. DNS changes can take a while to show up; try again later.",
        ));
    }

    assert_domain_free(master, domain, &ctx.workspace.id).await?;
    // Only the claim whose record was looked up: the token is new on every
    // claim, so a domain changed during the lookup no longer matches.
    let at = utc_now().assume_utc();
    let verified = workspace_sso::Entity::update_many()
        .col_expr(S::DomainVerifiedAt, Expr::value(at))
        .col_expr(S::ConnectionUpdatedBy, Expr::value(actor.to_owned()))
        .col_expr(S::ConnectionUpdatedAt, Expr::value(at))
        .col_expr(S::UpdatedAt, Expr::value(at))
        .filter(S::Id.eq(&row.id))
        .filter(S::Domain.eq(domain))
        .filter(S::DomainVerificationToken.eq(token))
        .exec(&orm(master))
        .await;
    match verified {
        Ok(done) if done.rows_affected > 0 => Ok(()),
        Ok(_) => Err(changed_meanwhile()),
        // Another workspace verified the same domain a moment earlier.
        Err(error) if is_unique_violation(&error) => Err(domain_in_use()),
        Err(error) => Err(error.into()),
    }
}

// ── Connection ──────────────────────────────────────────────────────────────

const SSO_PROVIDERS: [&str; 4] = ["saml_okta", "saml_microsoft", "saml_google", "saml_custom"];

/// `httpsUrl.nullable().optional()`: `z.string().trim().url().max(2000)`
/// with a refinement that runs after the body's other checks.
const HTTPS_URL: Text = Text {
    trim: true,
    lowercase: false,
    format: Some(Format::Url),
    min: None,
    max: Some(2000),
};

/// `ssoConnectionInputSchema`. The input itself never reaches a provider
/// here (saving needs Clerk), so only its validation matters.
fn read_connection_input(issues: &mut Issues, fields: &serde_json::Map<String, Value>) {
    let _ = issues.choice(fields, "provider", Presence::Required, &SSO_PROVIDERS);
    let _ = issues.text_with(fields, "idpMetadataUrl", Presence::Nullish, HTTPS_URL);
    let _ = issues.text_with(
        fields,
        "idpMetadata",
        Presence::Nullish,
        Text::trimmed(None, Some(200_000)),
    );
    let _ = issues.text_with(
        fields,
        "idpEntityId",
        Presence::Nullish,
        Text::trimmed(None, Some(2000)),
    );
    let _ = issues.text_with(fields, "idpSsoUrl", Presence::Nullish, HTTPS_URL);
    let _ = issues.text_with(
        fields,
        "idpCertificate",
        Presence::Nullish,
        Text::trimmed(None, Some(20_000)),
    );
    // `.refine((value) => value.startsWith('https://'), 'Use an https:// URL')`
    // on the trimmed string, settled after every synchronous check.
    for key in ["idpMetadataUrl", "idpSsoUrl"] {
        if let Some(Value::String(text)) = fields.get(key)
            && !js_trim(text).starts_with("https://")
        {
            issues.custom(key, "Use an https:// URL");
        }
    }
}

/// `PUT /connection` (`saveSsoConnection`): create the connection or update
/// it, both at Clerk.
async fn save_connection(
    State(state): State<CorePlatformState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(directory) = state.sso.clone() {
        return answer(
            weldid::save_connection(&state, &caller, &*directory, &headers, &body).await,
        );
    }
    answer(
        async {
            validate(&headers, &body, read_connection_input)?;
            let master = caller.master(&state);
            let ctx = context_of(&caller, &master).await?;
            require_entitled(&ctx)?;
            if ctx.domain().is_none() || !ctx.verified() {
                return Err(domain_not_verified());
            }
            // `updateSamlConnection` (a connection on file) or
            // `createSamlConnection`: Clerk.
            let call = if ctx.connection_id().is_some() {
                "updateSamlConnection"
            } else {
                "createSamlConnection"
            };
            Err(provider_unreachable(call))
        }
        .await,
    )
}

/// `DELETE /connection` (`removeSsoConnection`): deleting it is Clerk's.
async fn remove_connection(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    if let Some(directory) = state.sso.clone() {
        return answer(weldid::remove_connection(&state, &caller, &*directory).await);
    }
    answer(
        async {
            let master = caller.master(&state);
            let ctx = context_of(&caller, &master).await?;
            if ctx.connection_id().is_some() {
                return Err(provider_unreachable("deleteSamlConnection"));
            }
            changed(&state, &caller, &master, "connection_removed").await
        }
        .await,
    )
}

/// `POST /connection/activate`.
async fn activate(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    if let Some(directory) = state.sso.clone() {
        return answer(weldid::set_enabled(&state, &caller, &*directory, true).await);
    }
    answer(set_enabled(&state, &caller, true).await)
}

/// `POST /connection/deactivate`.
async fn deactivate(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    if let Some(directory) = state.sso.clone() {
        return answer(weldid::set_enabled(&state, &caller, &*directory, false).await);
    }
    answer(set_enabled(&state, &caller, false).await)
}

// ── A WeldID connection's domains ───────────────────────────────────────────

/// `POST /domains`.
async fn add_domain(
    State(state): State<CorePlatformState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(directory) = state.sso.clone() else {
        return weldid::not_offered();
    };
    answer(
        async {
            let domain = weldid::read_domain(&headers, &body)?;
            weldid::add_domain(&state, &caller, &*directory, &domain).await
        }
        .await,
    )
}

/// `DELETE /domains/{domain}`.
async fn remove_named_domain(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(domain): Path<String>,
) -> Response {
    let Some(directory) = state.sso.clone() else {
        return weldid::not_offered();
    };
    answer(weldid::remove_domain(&state, &caller, &*directory, Some(&domain)).await)
}

/// `POST /domains/{domain}/verify`.
async fn verify_named_domain(
    State(state): State<CorePlatformState>,
    caller: Caller,
    Path(domain): Path<String>,
) -> Response {
    let Some(directory) = state.sso.clone() else {
        return weldid::not_offered();
    };
    answer(weldid::verify_domain(&state, &caller, &*directory, Some(&domain)).await)
}

/// `setSsoEnabled`: on needs entitlement, a verified domain and a complete
/// identity provider (read from Clerk); then Clerk's `active` follows (`reconcileSsoConnection`).
async fn set_enabled(
    state: &CorePlatformState,
    caller: &Caller,
    enabled: bool,
) -> PlatformResult<Response> {
    let master = caller.master(state);
    let ctx = context_of(caller, &master).await?;
    let (Some(row), Some(connection_id)) = (ctx.row.as_ref(), ctx.connection_id()) else {
        return Err(refusal(
            StatusCode::CONFLICT,
            "SSO_CONNECTION_MISSING",
            "Connect your identity provider first.",
        ));
    };
    if enabled {
        require_entitled(&ctx)?;
        if ctx.domain().is_none() || !ctx.verified() {
            return Err(domain_not_verified());
        }
        // Whether the IdP is complete is the live connection's
        // (`getSamlConnection`).
        return Err(provider_unreachable("getSamlConnection"));
    }

    let at = utc_now().assume_utc();
    let db = orm(&master);
    let saved = workspace_sso::Entity::update_many()
        .col_expr(workspace_sso::Column::Enabled, Expr::value(false))
        .col_expr(
            workspace_sso::Column::ConnectionUpdatedBy,
            Expr::value(caller.user_id.clone()),
        )
        .col_expr(workspace_sso::Column::ConnectionUpdatedAt, Expr::value(at))
        .col_expr(workspace_sso::Column::UpdatedAt, Expr::value(at))
        .filter(workspace_sso::Column::Id.eq(&row.id))
        .filter(workspace_sso::Column::ClerkConnectionId.eq(connection_id))
        .exec_with_returning(&db)
        .await?;
    let Some(clerk_active) = saved.into_iter().next().map(|row| row.clerk_active) else {
        return Err(changed_meanwhile());
    };
    // Switched off, Clerk should not be active: nothing to do unless it is.
    if clerk_active {
        // `updateSamlConnection(id, { active: false })` fails: put the switch
        // back so the page does not claim a state Clerk is not in.
        workspace_sso::Entity::update_many()
            .col_expr(workspace_sso::Column::Enabled, Expr::value(row.enabled))
            .col_expr(
                workspace_sso::Column::UpdatedAt,
                Expr::value(utc_now().assume_utc()),
            )
            .filter(workspace_sso::Column::Id.eq(&row.id))
            .exec(&db)
            .await?;
        return Err(provider_unreachable("updateSamlConnection"));
    }
    changed(state, caller, &master, "disabled").await
}

// ── Add-on billing ──────────────────────────────────────────────────────────

/// The `/billing` paths: billing-worker (Stripe) is Global-only, so they
/// answer as when it cannot be reached.
async fn billing_unavailable() -> Response {
    tracing::error!("sso: billing-worker is not reachable from this edition");
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "BILLING_UNAVAILABLE",
        "Billing is unavailable right now. Try again later.",
    )
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_domains_like_the_workers() {
        let cases = [
            (" https://www.Acme-Corp.com/login ", Some("acme-corp.com")),
            ("jane@Acme.com", Some("acme.com")),
            ("@acme.com", Some("acme.com")),
            ("acme.com.", Some("acme.com")),
            ("acme.com:8443", Some("acme.com")),
            ("sub.acme.co.uk?x=1", Some("sub.acme.co.uk")),
            ("localhost", None),
            ("10.0.0.1", None),
            ("-acme.com", None),
            ("acme-.com", None),
            ("ac", None),
            ("exämple.com", None),
            ("www.", None),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_sso_domain(input).as_deref(), expected, "{input}");
        }
    }

    #[test]
    fn parses_txt_data_like_the_workers() {
        assert_eq!(parse_txt_data("\"v=spf1 -all\""), "v=spf1 -all");
        assert_eq!(
            parse_txt_data("\"part one\" \"part two\""),
            "part onepart two"
        );
        assert_eq!(parse_txt_data("no quotes"), "no quotes");
        assert_eq!(parse_txt_data("\"a\\\"b\""), "a\\\"b");
        assert_eq!(parse_txt_data("\"unclosed"), "\"unclosed");
    }

    #[test]
    fn matches_the_record_with_quotes_and_spaces() {
        let token = "0123456789abcdef0123456789abcdef";
        let value = dns_record_value(token);
        assert!(dns_record_matches(&[format!("\"{value}\"")], token));
        assert!(dns_record_matches(&[format!(" {value} ")], token));
        assert!(!dns_record_matches(
            &["weldsuite-sso-verification=other".to_owned()],
            token
        ));
    }

    #[test]
    fn encodes_names_like_encode_uri_component() {
        assert_eq!(
            encode_uri_component("_weldsuite-sso.acme.com"),
            "_weldsuite-sso.acme.com"
        );
        assert_eq!(encode_uri_component("a b"), "a%20b");
    }
}
