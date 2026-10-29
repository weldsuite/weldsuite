//! `/api/sso` (`app-api/src/routes/sso`, `services/sso.ts`,
//! `@weldsuite/core-domain/sso`): a workspace's enterprise single sign-on.
//!
//! - `GET /`: the configuration (entitlement, domain, connection), `sso:read`.
//! - `PUT|DELETE /domain`, `POST /domain/verify`: claim a domain and prove it
//!   with a TXT record, `sso:manage`.
//! - `PUT|DELETE /connection`, `POST /connection/activate|deactivate`: the
//!   SAML connection, `sso:manage`.
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

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Extension, Router};
use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::WORKSPACE_SETTINGS_UPDATED;
use weldsuite_db::{PgPool, is_unique_violation, js_row};
use weldsuite_kit::validation::{Format, Issues, Presence, Text, js_trim};
use weldsuite_kit::{ApiError, Data, generate_id, random_string};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::BoxFuture;

use crate::{Caller, CorePlatformState, PlatformError, PlatformResult, answer, now, validate};

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

/// `loadSsoContext(db, { clerkOrgId })`: `None` without a workspace.
async fn load_context(master: &PgPool, clerk_org_id: &str) -> Result<Option<Context>, sqlx::Error> {
    let workspace: Option<WorkspaceRow> = sqlx::query_as(
        "select id, clerk_org_id, plan_id, is_active, deleted_at is not null
         from workspaces where clerk_org_id = $1 limit 1",
    )
    .bind(clerk_org_id)
    .fetch_optional(master)
    .await?;
    let Some((id, clerk_org_id, plan_id, is_active, deleted)) = workspace else {
        return Ok(None);
    };
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from workspace_sso s where workspace_id = $1 limit 1",
    )
    .bind(&id)
    .fetch_optional(master)
    .await?;
    let mut plan_includes_sso = false;
    if let Some(plan_id) = plan_id.filter(|plan| !plan.is_empty()) {
        let features: Option<Option<Value>> =
            sqlx::query_scalar("select features from plans where id = $1 limit 1")
                .bind(plan_id)
                .fetch_optional(master)
                .await?;
        plan_includes_sso = features
            .flatten()
            .is_some_and(|features| features.get("sso") == Some(&Value::Bool(true)));
    }
    Ok(Some(Context {
        workspace: Workspace {
            id,
            clerk_org_id,
            is_active,
            deleted,
        },
        row: row.map(|row| SsoRow::from_row(&js_row(row))),
        plan_includes_sso,
    }))
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
    let taken: Option<String> = sqlx::query_scalar(
        "select id from workspace_sso
         where domain = $1 and domain_verified_at is not null and workspace_id <> $2
         limit 1",
    )
    .bind(domain)
    .bind(workspace_id)
    .fetch_optional(master)
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
    sqlx::query(
        "insert into workspace_sso (id, workspace_id, clerk_org_id) values ($1, $2, $3)
         on conflict (workspace_id) do nothing",
    )
    .bind(generate_id("wsso"))
    .bind(&workspace.id)
    .bind(clerk_org_id)
    .execute(master)
    .await?;
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from workspace_sso s where workspace_id = $1 limit 1",
    )
    .bind(&workspace.id)
    .fetch_optional(master)
    .await?;
    row.map(|row| SsoRow::from_row(&js_row(row)))
        .ok_or_else(|| {
            PlatformError::internal(
                "Internal server error",
                format!("Could not create the SSO row of workspace {}", workspace.id),
            )
        })
}

/// `setSsoDomain`: the same domain again keeps its token; another starts over.
async fn set_domain(master: &PgPool, ctx: Context, input: &str, actor: &str) -> PlatformResult<()> {
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

    let at = now();
    let saved: Option<String> = sqlx::query_scalar(
        "update workspace_sso
         set domain = $2, domain_verification_token = $3, domain_verified_at = null,
             connection_updated_by = $4, connection_updated_at = $5::timestamptz,
             updated_at = $5::timestamptz
         where id = $1 and clerk_connection_id is null
         returning id",
    )
    .bind(&row.id)
    .bind(&domain)
    .bind(random_string(32, "0123456789abcdef"))
    .bind(actor)
    .bind(&at)
    .fetch_optional(master)
    .await?;
    saved.map(|_| ()).ok_or_else(changed_meanwhile)
}

/// `DELETE /domain`.
async fn remove_domain(State(state): State<CorePlatformState>, caller: Caller) -> Response {
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
                let at = now();
                let saved: Option<String> = sqlx::query_scalar(
                    "update workspace_sso
                     set domain = null, domain_verification_token = null, domain_verified_at = null,
                         connection_updated_by = $2, connection_updated_at = $3::timestamptz,
                         updated_at = $3::timestamptz
                     where id = $1 and clerk_connection_id is null
                     returning id",
                )
                .bind(&row.id)
                .bind(&caller.user_id)
                .bind(&at)
                .fetch_optional(&master)
                .await?;
                if saved.is_none() {
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
    let at = now();
    let verified: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
        "update workspace_sso
         set domain_verified_at = $4::timestamptz, connection_updated_by = $5,
             connection_updated_at = $4::timestamptz, updated_at = $4::timestamptz
         where id = $1 and domain = $2 and domain_verification_token = $3
         returning id",
    )
    .bind(&row.id)
    .bind(domain)
    .bind(token)
    .bind(&at)
    .bind(actor)
    .fetch_optional(master)
    .await;
    match verified {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(changed_meanwhile()),
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
    answer(set_enabled(&state, &caller, true).await)
}

/// `POST /connection/deactivate`.
async fn deactivate(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    answer(set_enabled(&state, &caller, false).await)
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

    let at = now();
    let saved: Option<bool> = sqlx::query_scalar(
        "update workspace_sso
         set enabled = false, connection_updated_by = $3,
             connection_updated_at = $4::timestamptz, updated_at = $4::timestamptz
         where id = $1 and clerk_connection_id = $2
         returning clerk_active",
    )
    .bind(&row.id)
    .bind(connection_id)
    .bind(&caller.user_id)
    .bind(&at)
    .fetch_optional(&master)
    .await?;
    let Some(clerk_active) = saved else {
        return Err(changed_meanwhile());
    };
    // Switched off, Clerk should not be active: nothing to do unless it is.
    if clerk_active {
        // `updateSamlConnection(id, { active: false })` fails: put the switch
        // back so the page does not claim a state Clerk is not in.
        sqlx::query(
            "update workspace_sso set enabled = $2, updated_at = $3::timestamptz where id = $1",
        )
        .bind(&row.id)
        .bind(row.enabled)
        .bind(now())
        .execute(&master)
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
