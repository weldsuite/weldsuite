//! WeldPass: `/api/weldpass` as pass-api serves it
//! (`apps/workers/pass-api/src/routes/weldpass/`): encrypted secret vaults
//! with push sync to Cloudflare Workers, Cloudflare Pages and Vercel, and the
//! team password manager (personal and shared vaults, logins, notes, cards,
//! 2FA codes, CSV import, password health).
//!
//! Access, as in TypeScript:
//!
//! - the secret vaults ("projects") open by workspace permission:
//!   `secrets:read` lists, `secrets:reveal` decrypts, `secrets:create |
//!   update | delete | sync | manage` write. A project of another workspace
//!   is a 404.
//! - the password vaults open by membership ([`password_vaults`]):
//!   `passwords:use` opens the door, the role on the vault decides the rest;
//!   a vault the caller cannot see is a 404, one they can see but not touch
//!   a 403.
//!
//! Every value is encrypted under the envelope of [`envelope`], bit for bit
//! the worker's, so the two backends read each other's rows. No entity
//! events: WeldPass writes its own trail (`weldpass_audit_events`,
//! `weldpass_vault_events`), reveals and 2FA codes included.

mod audit;
#[cfg(test)]
mod cases;
mod credentials;
mod dotenv;
pub mod envelope;
mod health;
mod transport;
mod import;
mod js;
mod jsjson;
mod password_items;
mod password_vaults;
mod projects;
mod providers;
mod routes_passwords;
mod routes_projects;
mod schemas;
mod secrets;
mod sync;
pub mod totp;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::request::Parts;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::permission_keys::{
    PASSWORDS_CREATE, PASSWORDS_MANAGE, PASSWORDS_USE, SECRETS_CREATE, SECRETS_DELETE,
    SECRETS_MANAGE, SECRETS_READ, SECRETS_REVEAL, SECRETS_SYNC, SECRETS_UPDATE,
};
use weldsuite_db::{PgPool, Tenant};
use weldsuite_kit::validation::{Issues, json_body};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_permissions::{PermissionGate, PermissionQueries, Permissions};

pub use envelope::{EnvelopeError, RootKeyring, rewrap_vault_key};
pub use transport::{
    HttpTransport, OutboundRequest, OutboundResponse, PassHttp, ReqwestTransport, TransportError,
};

/// What the WeldPass handlers share.
#[derive(Clone)]
pub struct PassState {
    /// `WELDPASS_ROOT_KEY` / `WELDPASS_ROOT_KEY_V2`, read at start.
    pub root_keys: RootKeyring,
    /// Outbound calls to the deploy targets.
    pub http: Arc<dyn HttpTransport>,
}

impl std::fmt::Debug for PassState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PassState")
            .field("root_keys", &self.root_keys)
            .finish_non_exhaustive()
    }
}

impl PassState {
    /// The root keys from the process environment, and reqwest for the
    /// providers.
    pub fn from_env() -> Self {
        let read = |name: &str| std::env::var(name).ok();
        Self {
            root_keys: RootKeyring {
                v1: read("WELDPASS_ROOT_KEY"),
                v2: read("WELDPASS_ROOT_KEY_V2"),
            },
            http: Arc::new(ReqwestTransport::new()),
        }
    }
}

/// `/api/weldpass`, to nest under `/api` behind the session, tenant
/// database, licence and flag layers. Each route carries its
/// `requirePermission` from `gate`.
#[allow(clippy::too_many_lines)] // one line per route, as the worker lists them
pub fn router<S, Q>(state: PassState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    use routes_passwords as pw;
    use routes_projects as rp;

    let need = |keys: &[&'static str]| gate.require(keys.iter().copied());
    const SECRETS: &str = "/projects/{projectId}/environments/{environmentId}/secrets";
    const VAULT: &str = "/vaults/{vaultId}";
    const ITEM: &str = "/vaults/{vaultId}/items/{itemId}";

    Router::new()
        .route("/providers", get(rp::providers).route_layer(need(&[SECRETS_READ])))
        // Projects
        .route("/projects", get(rp::list_projects).route_layer(need(&[SECRETS_READ])))
        .route(
            "/projects",
            post(rp::create_project).route_layer(need(&[SECRETS_CREATE, SECRETS_MANAGE])),
        )
        .route(
            "/projects/{projectId}",
            get(rp::get_project).route_layer(need(&[SECRETS_READ])),
        )
        .route(
            "/projects/{projectId}",
            patch(rp::update_project).route_layer(need(&[SECRETS_UPDATE, SECRETS_MANAGE])),
        )
        .route(
            "/projects/{projectId}",
            delete(rp::delete_project).route_layer(need(&[SECRETS_DELETE, SECRETS_MANAGE])),
        )
        // Environments
        .route(
            "/projects/{projectId}/environments",
            get(rp::list_environments).route_layer(need(&[SECRETS_READ])),
        )
        .route(
            "/projects/{projectId}/environments",
            post(rp::create_environment).route_layer(need(&[SECRETS_MANAGE])),
        )
        .route(
            "/projects/{projectId}/environments/{environmentId}",
            patch(rp::update_environment)
                .delete(rp::delete_environment)
                .route_layer(need(&[SECRETS_MANAGE])),
        )
        // Secrets
        .route(SECRETS, get(rp::list_secrets).route_layer(need(&[SECRETS_READ])))
        .route(
            SECRETS,
            post(rp::upsert_secret).route_layer(need(&[SECRETS_CREATE, SECRETS_MANAGE])),
        )
        .route(
            const_format(SECRETS, "/{secretId}"),
            patch(rp::patch_secret).route_layer(need(&[SECRETS_UPDATE, SECRETS_MANAGE])),
        )
        .route(
            const_format(SECRETS, "/{secretId}"),
            delete(rp::delete_secret).route_layer(need(&[SECRETS_DELETE, SECRETS_MANAGE])),
        )
        .route(
            const_format(SECRETS, "/{secretId}/reveal"),
            get(rp::reveal_secret).route_layer(need(&[SECRETS_REVEAL])),
        )
        .route(
            const_format(SECRETS, "/{secretId}/versions"),
            get(rp::list_versions).route_layer(need(&[SECRETS_READ])),
        )
        .route(
            const_format(SECRETS, "/{secretId}/restore"),
            post(rp::restore_secret).route_layer(need(&[SECRETS_UPDATE, SECRETS_MANAGE])),
        )
        .route(
            const_format(SECRETS, "/import"),
            post(rp::import_secrets).route_layer(need(&[SECRETS_CREATE, SECRETS_MANAGE])),
        )
        .route(
            const_format(SECRETS, "/export"),
            get(rp::export_secrets).route_layer(need(&[SECRETS_REVEAL])),
        )
        // Provider credentials
        .route(
            "/projects/{projectId}/credentials",
            get(rp::list_credentials)
                .post(rp::create_credential)
                .route_layer(need(&[SECRETS_MANAGE])),
        )
        .route(
            "/projects/{projectId}/credentials/{credentialId}",
            patch(rp::update_credential)
                .delete(rp::delete_credential)
                .route_layer(need(&[SECRETS_MANAGE])),
        )
        .route(
            "/projects/{projectId}/credentials/{credentialId}/verify",
            post(rp::verify_credential).route_layer(need(&[SECRETS_MANAGE])),
        )
        // Sync targets
        .route(
            "/projects/{projectId}/sync-targets",
            get(rp::list_targets).route_layer(need(&[SECRETS_READ])),
        )
        .route(
            "/projects/{projectId}/sync-targets",
            post(rp::create_target).route_layer(need(&[SECRETS_MANAGE])),
        )
        .route(
            "/projects/{projectId}/sync-targets/{targetId}",
            patch(rp::update_target)
                .delete(rp::delete_target)
                .route_layer(need(&[SECRETS_MANAGE])),
        )
        .route(
            "/projects/{projectId}/sync-targets/{targetId}/preview",
            get(rp::preview_target).route_layer(need(&[SECRETS_READ])),
        )
        .route(
            "/projects/{projectId}/sync-targets/{targetId}/push",
            post(rp::push_target).route_layer(need(&[SECRETS_SYNC, SECRETS_MANAGE])),
        )
        .route(
            "/projects/{projectId}/sync-runs",
            get(rp::list_runs).route_layer(need(&[SECRETS_READ])),
        )
        .route(
            "/projects/{projectId}/audit",
            get(rp::list_audit).route_layer(need(&[SECRETS_MANAGE])),
        )
        // Password manager: vaults
        .route("/vaults", get(pw::list_vaults).route_layer(need(&[PASSWORDS_USE])))
        .route(
            "/vaults",
            post(pw::create_vault).route_layer(need(&[PASSWORDS_CREATE, PASSWORDS_MANAGE])),
        )
        .route(
            VAULT,
            get(pw::get_vault)
                .patch(pw::update_vault)
                .delete(pw::delete_vault)
                .route_layer(need(&[PASSWORDS_USE])),
        )
        .route("/teammates", get(pw::teammates).route_layer(need(&[PASSWORDS_USE])))
        .route(
            const_format(VAULT, "/members"),
            get(pw::list_members)
                .post(pw::add_member)
                .route_layer(need(&[PASSWORDS_USE])),
        )
        .route(
            const_format(VAULT, "/members/{userId}"),
            patch(pw::set_member_role)
                .delete(pw::remove_member)
                .route_layer(need(&[PASSWORDS_USE])),
        )
        .route(
            const_format(VAULT, "/activity"),
            get(pw::activity).route_layer(need(&[PASSWORDS_USE])),
        )
        // Password manager: items
        .route("/items", get(pw::list_items).route_layer(need(&[PASSWORDS_USE])))
        .route(
            "/items/match",
            get(pw::match_items).route_layer(need(&[PASSWORDS_USE])),
        )
        .route(
            "/password-health",
            get(pw::password_health).route_layer(need(&[PASSWORDS_USE])),
        )
        .route(
            const_format(VAULT, "/items"),
            post(pw::create_item).route_layer(need(&[PASSWORDS_USE])),
        )
        .route(
            const_format(VAULT, "/items/import"),
            post(pw::import_items).route_layer(need(&[PASSWORDS_USE])),
        )
        .route(
            const_format(ITEM, "/reveal"),
            get(pw::reveal_item).route_layer(need(&[PASSWORDS_USE])),
        )
        .route(
            const_format(ITEM, "/totp"),
            post(pw::item_totp).route_layer(need(&[PASSWORDS_USE])),
        )
        .route(
            ITEM,
            put(pw::update_item)
                .delete(pw::delete_item)
                .route_layer(need(&[PASSWORDS_USE])),
        )
        .route(
            const_format(ITEM, "/versions"),
            get(pw::item_versions).route_layer(need(&[PASSWORDS_USE])),
        )
        .route(
            const_format(ITEM, "/restore"),
            post(pw::restore_item).route_layer(need(&[PASSWORDS_USE])),
        )
        .route(
            const_format(ITEM, "/move"),
            post(pw::move_item).route_layer(need(&[PASSWORDS_USE])),
        )
        .with_state(state)
}

/// A route path: a prefix and its tail (axum takes `&str`, built once at
/// start).
fn const_format(prefix: &str, tail: &str) -> &'static str {
    Box::leak(format!("{prefix}{tail}").into_boxed_str())
}

// ── The caller ─────────────────────────────────────────────────────────────

/// Who is asking, in which workspace, with what permissions.
pub(crate) struct Caller {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    /// `c.get('clerkOrgId')`: `weldpass_*.workspace_id` holds the Clerk org id.
    pub(crate) clerk_org_id: Option<String>,
    pub(crate) permissions: Option<Permissions>,
    pub(crate) audit: audit::AuditContext,
    /// `X-WeldPass-Client`, recorded on an item reveal.
    pub(crate) client: Option<String>,
    env: Option<RequestEnv>,
    http: Option<PassHttp>,
}

impl Caller {
    /// `hasContextPermission(c, key)`.
    pub(crate) fn can(&self, key: &str) -> bool {
        self.permissions
            .as_ref()
            .is_some_and(|permissions| permissions.has_any(&[key]))
    }

    /// `rootKeyringFromEnv(c.env)`: the request's env in conformance mode,
    /// else the process's.
    pub(crate) fn keyring(&self, state: &PassState) -> RootKeyring {
        match &self.env {
            Some(env) => RootKeyring::from_values(
                env.get("WELDPASS_ROOT_KEY"),
                env.get("WELDPASS_ROOT_KEY_V2"),
            ),
            None => state.root_keys.clone(),
        }
    }

    /// The provider transport: the request's (conformance), else the app's.
    pub(crate) fn http(&self, state: &PassState) -> Arc<dyn HttpTransport> {
        self.http
            .as_ref()
            .map_or_else(|| Arc::clone(&state.http), |http| Arc::clone(&http.0))
    }

    pub(crate) fn org(&self) -> Option<&str> {
        self.clerk_org_id.as_deref()
    }
}

/// Behind the session and tenant database layers; without them it is a
/// routing mistake (500).
impl<S: Send + Sync> FromRequestParts<S> for Caller {
    type Rejection = ApiError;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let auth = parts.extensions.get::<AuthContext>();
        let tenant = parts.extensions.get::<Tenant>();
        let caller = if let (Some(auth), Some(tenant)) = (auth, tenant) {
            Ok(Self {
                db: tenant.db.clone(),
                user_id: auth.user_id.clone(),
                clerk_org_id: tenant.clerk_org_id.clone(),
                permissions: parts.extensions.get::<Permissions>().cloned(),
                audit: audit::AuditContext::from_headers(&parts.headers),
                client: parts
                    .headers
                    .get("x-weldpass-client")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned),
                env: parts.extensions.get::<RequestEnv>().cloned(),
                http: parts.extensions.get::<PassHttp>().cloned(),
            })
        } else {
            tracing::error!("pass: a route without the session or tenant layer");
            Err(ApiError::internal())
        };
        std::future::ready(caller)
    }
}

// ── Errors ─────────────────────────────────────────────────────────────────

/// What the WeldPass services throw, answered by the router's `onError`
/// (`toWeldPassErrorResponse`), or a response a route writes itself.
#[derive(Debug)]
pub(crate) enum PassError {
    /// `VaultNotFoundError`: 404 `<resource> with ID '<id>' not found`.
    NotFound { resource: &'static str, id: String },
    /// `SecretKeyError`, `ItemFieldError`, `ImportError`: 400.
    BadRequest(String),
    /// `VaultAccessError`: 403 with the message.
    Forbidden(String),
    /// `VaultConflictError`: 409.
    Conflict(String),
    /// `ProviderError`: 502 `SYNC_FAILED`.
    Provider(String),
    /// `EnvelopeError`: 500 `CRYPTO_ERROR`, logged, never shown.
    Envelope(EnvelopeError),
    /// Anything else: 500 `INTERNAL_ERROR`, "An unexpected error occurred".
    Internal(String),
    /// A response the route wrote (validation, a refusal of its own).
    Response(Box<Response>),
}

impl PassError {
    pub(crate) fn not_found(resource: &'static str, id: &str) -> Self {
        Self::NotFound {
            resource,
            id: id.to_owned(),
        }
    }

    pub(crate) fn respond(self) -> Response {
        match self {
            Self::NotFound { resource, id } => {
                ApiError::not_found(resource, Some(&id)).into_response()
            }
            Self::BadRequest(message) => ApiError::bad_request(message).into_response(),
            Self::Forbidden(message) => ApiError::forbidden().with_message(message).into_response(),
            Self::Conflict(message) => ApiError::conflict(message).into_response(),
            Self::Provider(message) => {
                ApiError::new(StatusCode::BAD_GATEWAY, "SYNC_FAILED", message).into_response()
            }
            Self::Envelope(error) => {
                // An operational incident (a missing or rotated root key),
                // not something the caller can fix. The message names no key.
                tracing::error!(error = %error, "[weldpass] envelope failure");
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "CRYPTO_ERROR",
                    "This vault could not be opened. Its encryption key is unavailable — contact an administrator.",
                )
                .into_response()
            }
            Self::Internal(error) => {
                tracing::error!(%error, "[weldpass] unhandled error");
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "An unexpected error occurred",
                )
                .into_response()
            }
            Self::Response(response) => *response,
        }
    }
}

impl From<sqlx::Error> for PassError {
    /// The database's own message when it has one, as Drizzle's error
    /// carries it (a push records it as the failed run's error).
    fn from(error: sqlx::Error) -> Self {
        Self::Internal(
            error
                .as_database_error()
                .map_or_else(|| error.to_string(), |database| database.message().to_owned()),
        )
    }
}

impl From<EnvelopeError> for PassError {
    fn from(error: EnvelopeError) -> Self {
        Self::Envelope(error)
    }
}

impl From<ApiError> for PassError {
    fn from(error: ApiError) -> Self {
        Self::Response(Box::new(error.into_response()))
    }
}

pub(crate) type PassResult<T> = Result<T, PassError>;

/// A handler's outcome as a response.
pub(crate) fn answer(result: PassResult<Response>) -> Response {
    result.unwrap_or_else(PassError::respond)
}

// ── Helpers ────────────────────────────────────────────────────────────────

/// `zValidator('json', schema)`: the body read by `read`, or the 400 (bad
/// JSON, or the schema's issues).
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> PassResult<T> {
    let value = json_value(headers, body)?;
    let mut issues = Issues::default();
    let read = issues.object(&value).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| PassError::Response(Box::new(invalid.into_response())))?;
    read.ok_or_else(|| PassError::Internal("validated body without a value".to_owned()))
}

/// The JSON body as `zValidator('json')` reads it (`{}` without a JSON
/// content type).
pub(crate) fn json_value(headers: &HeaderMap, body: &Bytes) -> PassResult<Value> {
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    json_body(content_type, body).map_err(|bad| PassError::Response(Box::new(bad.into_response())))
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds, bound as text.
pub(crate) fn now() -> String {
    weldsuite_events::iso_timestamp(OffsetDateTime::now_utc())
}

/// A row built with `jsonb_build_object`, with its timestamp keys as
/// `toISOString()` prints them.
pub(crate) fn dated(mut row: Value, keys: &[&str]) -> Value {
    if let Value::Object(fields) = &mut row {
        for key in keys {
            if let Some(Value::String(text)) = fields.get(*key)
                && let Some(stamp) = weldsuite_db::js_timestamp(text)
            {
                fields.insert((*key).to_owned(), Value::String(stamp));
            }
        }
    }
    row
}

/// `{ data }` with status 200.
pub(crate) fn ok(data: Value) -> Response {
    weldsuite_kit::Data(data).into_response()
}

/// `{ data }` with status 201.
pub(crate) fn created(data: Value) -> Response {
    weldsuite_kit::Created(data).into_response()
}

/// `{ data }` with 201 when `was_created`, else 200.
pub(crate) fn ok_or_created(data: Value, was_created: bool) -> Response {
    if was_created { created(data) } else { ok(data) }
}

/// `{ ...a, ...b }`.
pub(crate) fn merge(mut base: Value, extra: Value) -> Value {
    if let (Value::Object(base), Value::Object(extra)) = (&mut base, extra) {
        for (key, value) in extra {
            base.insert(key, value);
        }
    }
    base
}

/// A path parameter the route declares, `''` when missing.
pub(crate) fn param<'a>(params: &'a std::collections::HashMap<String, String>, name: &str) -> &'a str {
    params.get(name).map_or("", String::as_str)
}

