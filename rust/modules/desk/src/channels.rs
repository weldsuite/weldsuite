//! WeldDesk channels: the webchat inbox (`/desk/conversations`), the
//! Discord and Slack channel integrations (`/helpdesk-integrations`), and
//! the two public surfaces the worker mounts ahead of the Clerk guard: the
//! OAuth callbacks (`/api/integrations/helpdesk/*`) and the help center feed
//! (`/public/helpcenter/*`).
//!
//! One submodule per TypeScript route file, named in each module's docs.

#[path = "channels/attributes.rs"]
mod attributes;
#[path = "channels/helpcenter.rs"]
mod helpcenter;
#[path = "channels/inbox.rs"]
mod inbox;
#[path = "channels/integrations.rs"]
mod integrations;
#[path = "channels/oauth.rs"]
mod oauth;
#[path = "channels/providers.rs"]
mod providers;
#[path = "channels/webchat.rs"]
mod webchat;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use http::request::Parts;
use serde_json::{Map, Value, json};
use weldsuite_auth::AuthContext;
use weldsuite_db::{MasterDb, PgPool, Tenant, Workspaces};
use weldsuite_desk_domain::http::{DynDeskHttp, RequestHttp};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynCache, DynFileStore, OutboundHttp, RequestCache, StorageBuckets};

use crate::{Caller, DeskState};

/// The routes, relative to `/api`, each with its `requirePermission`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .nest("/desk/conversations", inbox::routes(gate))
        .nest("/helpdesk-integrations", integrations::routes(gate))
}

/// What the public routes share: the desk's state and, outside conformance,
/// the workspace resolver that opens a tenant database by Clerk org id.
#[derive(Clone)]
pub(crate) struct PublicState {
    pub(crate) desk: DeskState,
    pub(crate) workspaces: Option<Arc<Workspaces>>,
}

/// The public routes at their full paths, outside the session and tenant
/// layers.
pub(crate) fn public_router<S>(desk: DeskState, workspaces: Option<Arc<Workspaces>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .nest("/api/integrations/helpdesk", oauth::routes())
        .nest("/public/helpcenter", helpcenter::routes())
        .with_state(PublicState { desk, workspaces })
}

// ── the authenticated routes' caller ─────────────────────────────────────────

/// [`Caller`] and what these routes read beyond it: the session's org id
/// (`c.get('orgId')`), and the test's own buckets, KV namespace and HTTP
/// client in conformance builds.
pub(crate) struct Ctx {
    pub(crate) caller: Caller,
    /// `c.get('orgId')`.
    pub(crate) org_id: Option<String>,
    /// A conformance request: the test's bindings stand in for the state's,
    /// and a binding the test left out is missing.
    conformance: bool,
    buckets: Option<StorageBuckets>,
    cache: Option<Arc<dyn DynCache>>,
    outbound_http: Option<OutboundHttp>,
}

impl<S: Send + Sync> FromRequestParts<S> for Ctx {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let caller = Caller::from_request_parts(parts, state).await?;
        let extensions = &parts.extensions;
        Ok(Self {
            caller,
            org_id: extensions
                .get::<AuthContext>()
                .and_then(|auth| auth.org_id.clone()),
            conformance: extensions.get::<RequestEnv>().is_some(),
            buckets: extensions.get::<StorageBuckets>().cloned(),
            cache: extensions
                .get::<RequestCache>()
                .map(|cache| Arc::clone(&cache.0)),
            outbound_http: extensions.get::<OutboundHttp>().cloned(),
        })
    }
}

impl Ctx {
    /// `c.env.STORAGE`: the public bucket.
    pub(crate) fn public_bucket(&self, state: &DeskState) -> Option<Arc<dyn DynFileStore>> {
        if self.conformance {
            return self.buckets.as_ref().and_then(|b| b.public.clone());
        }
        state.files.as_ref().and_then(|files| files.public.clone())
    }

    /// `c.env.WORKSPACE_CACHE`.
    pub(crate) fn kv(&self, state: &DeskState) -> Option<Arc<dyn DynCache>> {
        if self.conformance {
            return self.cache.clone();
        }
        state.cache.clone()
    }

    /// The Discord and Slack client.
    pub(crate) fn http(&self, state: &DeskState) -> Option<DynDeskHttp> {
        self.caller.http(state)
    }

    /// The client that hands back bytes (an avatar image), when there is one.
    pub(crate) fn bytes_http(&self) -> Option<OutboundHttp> {
        self.outbound_http.clone()
    }
}

// ── the public routes' context ───────────────────────────────────────────────

/// What a public route reads off its request: the test's env, master and
/// tenant databases, KV namespace and HTTP client in conformance builds.
pub(crate) struct PublicCtx {
    env: Option<RequestEnv>,
    master: Option<PgPool>,
    tenant: Option<PgPool>,
    cache: Option<Arc<dyn DynCache>>,
    http: Option<DynDeskHttp>,
}

impl<S: Send + Sync> FromRequestParts<S> for PublicCtx {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let extensions = &parts.extensions;
        std::future::ready(Ok(Self {
            env: extensions.get::<RequestEnv>().cloned(),
            master: extensions.get::<MasterDb>().map(|master| master.0.clone()),
            tenant: extensions.get::<Tenant>().map(|tenant| tenant.db.clone()),
            cache: extensions
                .get::<RequestCache>()
                .map(|cache| Arc::clone(&cache.0)),
            http: extensions
                .get::<RequestHttp>()
                .map(|http| Arc::clone(&http.0)),
        }))
    }
}

impl PublicCtx {
    fn conformance(&self) -> bool {
        self.env.is_some()
    }

    /// `env.<name>`: the test's (conformance), else the process's.
    pub(crate) fn env(&self, name: &str) -> Option<String> {
        if let Some(env) = &self.env {
            return env.get(name).map(str::to_owned);
        }
        std::env::var(name).ok()
    }

    pub(crate) fn master(&self, state: &PublicState) -> Option<PgPool> {
        self.master.clone().or_else(|| state.desk.master.clone())
    }

    pub(crate) fn kv(&self, state: &PublicState) -> Option<Arc<dyn DynCache>> {
        if self.conformance() {
            return self.cache.clone();
        }
        state.desk.cache.clone()
    }

    pub(crate) fn http(&self, state: &PublicState) -> Option<DynDeskHttp> {
        self.http.clone().or_else(|| state.desk.http.clone())
    }

    /// `getTenantDbForWorkspace(env, ref)`: the test's tenant database in
    /// conformance builds (every workspace opens it), else the workspace's.
    pub(crate) async fn tenant_db(
        &self,
        state: &PublicState,
        reference: &str,
    ) -> Result<PgPool, String> {
        if let Some(db) = &self.tenant {
            return Ok(db.clone());
        }
        let Some(workspaces) = &state.workspaces else {
            return Err("no workspace resolver".to_owned());
        };
        workspaces
            .tenant(reference)
            .await
            .map(|tenant| tenant.db)
            .map_err(|error| error.to_string())
    }
}

// ── shared helpers ───────────────────────────────────────────────────────────

/// `c.json({ error: { code, message } }, status)`.
pub(crate) fn error_body(status: StatusCode, code: &'static str, message: &str) -> Response {
    ApiError::new(status, code, message).into_response()
}

/// `error.orgRequired(c)`.
pub(crate) fn org_required() -> Response {
    error_body(
        StatusCode::BAD_REQUEST,
        "ORG_REQUIRED",
        "Organization context required",
    )
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `a || b` on JSON values.
pub(crate) fn or_value(a: &Value, b: Value) -> Value {
    if truthy(a) { a.clone() } else { b }
}

/// A string as `JSON.stringify` writes it.
pub(crate) fn js_string(text: &str) -> String {
    Value::String(text.to_owned()).to_string()
}

/// `JSON.stringify` of an object whose fields are in `fields`' order
/// (`serde_json` would sort them); `None` values are left out, as
/// `undefined` is.
pub(crate) fn json_object(fields: &[(&str, Option<&Value>)]) -> String {
    let parts: Vec<String> = fields
        .iter()
        .filter_map(|(key, value)| value.map(|value| format!("{}:{}", js_string(key), value)))
        .collect();
    format!("{{{}}}", parts.join(","))
}

/// `kv.put(key, value, ttl)`.
pub(crate) async fn kv_put(
    kv: Option<&Arc<dyn DynCache>>,
    key: &str,
    value: &str,
    ttl: Option<u64>,
) -> Result<(), String> {
    let kv = kv.ok_or("WORKSPACE_CACHE is not bound")?;
    kv.put_boxed(key, value, ttl.map(Duration::from_secs))
        .await
        .map_err(|error| error.to_string())
}

/// `kv.get(key, 'json')`.
pub(crate) async fn kv_get_json(
    kv: Option<&Arc<dyn DynCache>>,
    key: &str,
) -> Result<Option<Value>, String> {
    let kv = kv.ok_or("WORKSPACE_CACHE is not bound")?;
    let Some(text) = kv.get_boxed(key).await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| error.to_string())
}

/// `kv.delete(key)`.
pub(crate) async fn kv_delete(kv: Option<&Arc<dyn DynCache>>, key: &str) -> Result<(), String> {
    let kv = kv.ok_or("WORKSPACE_CACHE is not bound")?;
    kv.delete_boxed(key)
        .await
        .map_err(|error| error.to_string())
}

/// `new URLSearchParams(pairs).toString()`.
pub(crate) fn form_encode(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", form_component(key), form_component(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// The `application/x-www-form-urlencoded` serializer of one name or value.
fn form_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(byte));
            }
            b' ' => out.push('+'),
            _ => {
                let _ = std::fmt::Write::write_fmt(&mut out, format_args!("%{byte:02X}"));
            }
        }
    }
    out
}

/// `{ ...row }` without the OAuth tokens (`sanitizeIntegration`).
pub(crate) fn sanitized(row: &Value) -> Map<String, Value> {
    let mut safe = row.as_object().cloned().unwrap_or_default();
    safe.remove("accessToken");
    safe.remove("refreshToken");
    safe
}

/// `discordGuildId(row)`: the guild recorded on a Discord integration.
pub(crate) fn discord_guild_id(row: &Value) -> Option<String> {
    let info = &row["accountInfo"];
    if let Some(guild) = info["metadata"]["guildId"]
        .as_str()
        .filter(|g| !g.is_empty())
    {
        return Some(guild.to_owned());
    }
    info["id"]
        .as_str()
        .filter(|id| !id.is_empty() && *id != "unknown")
        .map(str::to_owned)
}

/// The URL builders both halves of the OAuth dance share
/// (`getHelpdeskWorkerUrl`, `getHelpdeskAppUrl`, `helpdeskOAuthRedirectUri`).
pub(crate) struct Urls {
    pub(crate) environment: Option<String>,
    pub(crate) worker_override: Option<String>,
    pub(crate) app_override: Option<String>,
}

/// `str.replace(/\/$/, '')`.
fn without_one_slash(text: &str) -> String {
    text.strip_suffix('/').unwrap_or(text).to_owned()
}

impl Urls {
    pub(crate) fn worker(&self) -> String {
        if let Some(url) = self.worker_override.as_deref().filter(|u| !u.is_empty()) {
            return without_one_slash(url);
        }
        match self.environment.as_deref() {
            Some("test" | "preview") => "https://app-api-test.weldsuite.org",
            Some("production") => "https://app-api.weldsuite.org",
            _ => "http://localhost:8789",
        }
        .to_owned()
    }

    pub(crate) fn app(&self) -> String {
        if let Some(url) = self.app_override.as_deref().filter(|u| !u.is_empty()) {
            return without_one_slash(url);
        }
        match self.environment.as_deref() {
            Some("test") => "https://app-test.weldsuite.org",
            Some("preview") => "https://app-preview.weldsuite.org",
            Some("production") => "https://app.weldsuite.org",
            _ => "http://localhost:3000",
        }
        .to_owned()
    }

    pub(crate) fn redirect_uri(&self, provider: &str) -> String {
        format!(
            "{}/api/integrations/helpdesk/{provider}/callback",
            self.worker()
        )
    }
}

/// `json!` of an `f64` the way JavaScript prints it (`3`, not `3.0`).
pub(crate) fn js_number(number: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if number.fract() == 0.0 && number.abs() < 9.007_199_254_740_992e15 {
        return json!(number as i64);
    }
    json!(number)
}
