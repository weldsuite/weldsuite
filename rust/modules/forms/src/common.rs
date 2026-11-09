//! What every route and service shares: the error answer (`FormsError` and
//! `handle()`), the workspace context (`WorkspaceCtx`), the request's view
//! of the worker's `env`, the clock and row helpers.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::Arc;

use axum::response::{IntoResponse, Response};
use http::StatusCode;
use serde_json::{Map, Value};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_events::{EntityEventPublisher, EventContext, publish_entity_event};
use weldsuite_kit::{ApiError, RequestEnv};
use weldsuite_ports::{DynCache, DynSystemMail, FileStores, OutboundHttp};

use crate::process::ProcessRuns;

// ---------------------------------------------------------------------------
// Errors (`lib/errors.ts`)
// ---------------------------------------------------------------------------

/// Why a route refuses or fails.
#[derive(Debug)]
pub(crate) enum Fail {
    /// `FormsError`: `{ error: { code, message, details? } }` with its status.
    Api(ApiError),
    /// A response the route wrote itself (a validation 400).
    Response(Box<Response>),
    /// Anything else (the database, a store): logged, answered with a 500.
    Internal(String),
}

pub(crate) type FormsResult<T> = Result<T, Fail>;

impl From<sqlx::Error> for Fail {
    fn from(error: sqlx::Error) -> Self {
        Self::Internal(format!("database: {error}"))
    }
}

impl From<ApiError> for Fail {
    fn from(error: ApiError) -> Self {
        Self::Api(error)
    }
}

impl From<weldsuite_ports::PortError> for Fail {
    fn from(error: weldsuite_ports::PortError) -> Self {
        Self::Internal(format!("port: {error}"))
    }
}

impl From<serde_json::Error> for Fail {
    fn from(error: serde_json::Error) -> Self {
        Self::Internal(format!("json: {error}"))
    }
}

impl Fail {
    pub(crate) fn respond(self) -> Response {
        match self {
            Self::Api(error) => error.into_response(),
            Self::Response(response) => *response,
            Self::Internal(error) => {
                tracing::error!(error, "forms: request failed");
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_ERROR",
                    "An unexpected error occurred",
                )
                .into_response()
            }
        }
    }
}

/// `new FormsError(status, code, message, details?)`.
pub(crate) fn forms_error(status: u16, code: &'static str, message: impl Into<String>) -> Fail {
    Fail::Api(ApiError::new(
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        code,
        message,
    ))
}

/// `new FormsError(status, code, message, details)`.
pub(crate) fn forms_error_with(
    status: u16,
    code: &'static str,
    message: impl Into<String>,
    details: Value,
) -> Fail {
    Fail::Api(
        ApiError::new(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            code,
            message,
        )
        .with_details(details),
    )
}

/// `notFound(what)`: 404 `NOT_FOUND`, `<what> not found`.
pub(crate) fn not_found(what: &str) -> Fail {
    forms_error(404, "NOT_FOUND", format!("{what} not found"))
}

/// `handle(c, run)`: the route's answer, or its error as the envelope.
pub(crate) fn answer(result: FormsResult<Response>) -> Response {
    result.unwrap_or_else(Fail::respond)
}

// ---------------------------------------------------------------------------
// The worker's env
// ---------------------------------------------------------------------------

/// `c.env`: the request's values (conformance) first, else the process's.
#[derive(Clone, Default)]
pub(crate) struct Env {
    request: Option<RequestEnv>,
    process: Arc<HashMap<String, String>>,
}

impl Env {
    pub(crate) fn new(request: Option<RequestEnv>, process: Arc<HashMap<String, String>>) -> Self {
        Self { request, process }
    }

    /// The value as set (an empty string included); `None` when unset.
    pub(crate) fn get(&self, name: &str) -> Option<String> {
        match &self.request {
            Some(request) => request
                .get(name)
                .map(str::to_owned)
                .or_else(|| self.process.get(name).cloned()),
            None => self.process.get(name).cloned(),
        }
    }

    /// `env.X || null`: unset and empty both read as `None`.
    pub(crate) fn non_empty(&self, name: &str) -> Option<String> {
        self.get(name).filter(|value| !value.is_empty())
    }

    /// `Date.now()`: the test's clock when it fakes one (`CONFORMANCE_NOW`,
    /// which only the conformance harness sets), else now.
    pub(crate) fn now_ms(&self) -> i64 {
        self.get("CONFORMANCE_NOW")
            .and_then(|text| weldsuite_kit::validation::js_date_parse(&text))
            .filter(|ms| ms.is_finite())
            .map_or_else(system_now_ms, |ms| {
                #[allow(clippy::cast_possible_truncation)]
                let ms = ms as i64;
                ms
            })
    }
}

/// The worker env keys forms-api reads, from the process.
pub const ENV_KEYS: &[&str] = &[
    "FORMS_PORTAL_URL",
    "FORMS_PORTAL_SECRET",
    "FORMS_SESSION_SECRET",
    "FORMS_MIN_FILL_MS",
    "PLATFORM_URL",
    "BOT_CHECK_PROVIDER",
    "TURNSTILE_SITE_KEY",
    "TURNSTILE_SECRET_KEY",
    "ALTCHA_HMAC_KEY",
    "R2_PUBLIC_URL",
    "S3_PUBLIC_URL",
    // The integration steps check their creator's permissions as `requirePermission` does.
    "PERMISSIONS_APP_ENFORCE",
];

/// The process environment's values of [`ENV_KEYS`], for [`crate::FormsState`].
pub fn env_from_process() -> HashMap<String, String> {
    ENV_KEYS
        .iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| ((*key).to_owned(), value))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

pub(crate) fn system_now_ms() -> i64 {
    let now = OffsetDateTime::now_utc();
    i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

/// `new Date(ms).toISOString()`.
pub(crate) fn iso(ms: i64) -> String {
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    weldsuite_events::iso_timestamp(at)
}

/// The `YYYY-MM-DD` of a UTC moment.
pub(crate) fn day_of(ms: i64) -> String {
    iso(ms)[..10].to_owned()
}

/// `monthOf(now)`: `YYYY-MM` of a UTC moment.
pub(crate) fn month_of(ms: i64) -> String {
    iso(ms)[..7].to_owned()
}

/// `new Date(text).getTime()`, `None` when it does not parse.
pub(crate) fn parse_ms(text: &str) -> Option<i64> {
    weldsuite_kit::validation::js_date_parse(text)
        .filter(|ms| ms.is_finite())
        .map(|ms| {
            #[allow(clippy::cast_possible_truncation)]
            let ms = ms as i64;
            ms
        })
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/// The first row of `select to_jsonb(x) …`, as Drizzle returns it.
pub(crate) async fn one(
    db: &PgPool,
    query: sqlx::query::QueryScalar<'_, sqlx::Postgres, Value, sqlx::postgres::PgArguments>,
) -> FormsResult<Option<Value>> {
    Ok(query.fetch_optional(db).await?.map(weldsuite_db::js_row))
}

/// Every row of `select to_jsonb(x) …`, as Drizzle returns them.
pub(crate) async fn all(
    db: &PgPool,
    query: sqlx::query::QueryScalar<'_, sqlx::Postgres, Value, sqlx::postgres::PgArguments>,
) -> FormsResult<Vec<Value>> {
    Ok(query
        .fetch_all(db)
        .await?
        .into_iter()
        .map(weldsuite_db::js_row)
        .collect())
}

/// A string field of a row; `""` when null or missing.
pub(crate) fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row[key].as_str().unwrap_or_default()
}

/// A string field of a row, `None` when null.
pub(crate) fn opt_text(row: &Value, key: &str) -> Option<String> {
    row[key].as_str().map(str::to_owned)
}

/// An integer field of a row (0 when null).
pub(crate) fn int(row: &Value, key: &str) -> i64 {
    row[key].as_i64().unwrap_or_default()
}

/// A JSON object from a `jsonb` column (`{}` when it is not one).
pub(crate) fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// `text.slice(0, n)`: the first `n` UTF-16 code units (a surrogate pair cut
/// in half keeps neither half, which JavaScript would keep as a lone one).
pub(crate) fn js_slice(text: &str, n: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= n
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The workspace context
// ---------------------------------------------------------------------------

/// The services a request reaches: the worker's bindings.
#[derive(Clone)]
pub(crate) struct Svc {
    pub(crate) events: EntityEventPublisher,
    pub(crate) env: Env,
    /// `WORKSPACE_CACHE` (Valkey on Kubernetes), and `FORM_COUNTERS` on it.
    pub(crate) cache: Arc<dyn DynCache>,
    /// `PRIVATE_STORAGE` and `STORAGE`.
    pub(crate) files: Option<FileStores>,
    /// `PROCESS_RESPONSE`.
    pub(crate) process: Option<Arc<dyn ProcessRuns>>,
    /// The system mail transport (`workerTransport(env)`).
    pub(crate) mail: Option<Arc<dyn DynSystemMail>>,
    /// In-app notifications (`REALTIME`).
    pub(crate) realtime: Option<Arc<dyn weldsuite_ports::DynRealtimePublisher>>,
    /// The outbound mail guard's bindings.
    pub(crate) outbound: weldsuite_mail_domain::outbound::OutboundBindings,
    /// Third-party HTTP (Turnstile's siteverify).
    pub(crate) http: Option<OutboundHttp>,
}

/// `WorkspaceCtx`: one workspace's tenant and master databases, its two ids
/// and the services.
#[derive(Clone)]
pub(crate) struct Ctx {
    pub(crate) db: PgPool,
    pub(crate) master: Option<PgPool>,
    /// `workspaces.id`.
    pub(crate) workspace_id: String,
    /// The Clerk org id: storage prefixes, entity events, workflow params.
    pub(crate) clerk_org_id: String,
    pub(crate) svc: Svc,
}

impl Ctx {
    /// `ctx.master`: the master database, a 500 without one.
    pub(crate) fn master(&self) -> FormsResult<&PgPool> {
        self.master
            .as_ref()
            .ok_or_else(|| Fail::Internal("forms: no master database".to_owned()))
    }

    pub(crate) fn env(&self) -> &Env {
        &self.svc.env
    }

    pub(crate) fn now_ms(&self) -> i64 {
        self.svc.env.now_ms()
    }

    /// `publishEntityEventRaw({ workspaceId: clerkOrgId, userId: actor, source: 'api' })`.
    pub(crate) fn publish_as(
        &self,
        actor: &str,
        event: weldsuite_catalogs::entity_events::EventName,
        entity_id: &str,
        data: &Value,
    ) {
        let context = EventContext::new(
            self.clerk_org_id.clone(),
            actor,
            weldsuite_events::EventSource::Api,
        );
        publish_entity_event(&self.svc.events, &context, event, entity_id, data);
    }

    /// Work after the response (`waitUntil`): on the events' tracker, so a
    /// shutdown waits for it and conformance reads its side effects after it.
    pub(crate) fn after<F>(&self, work: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            self.svc.events.tracker().spawn_on(work, &runtime);
        }
    }
}

/// `publicFormUrl(env, publicId)`.
pub(crate) fn public_form_url(env: &Env, public_id: Option<&str>) -> Option<String> {
    let public_id = public_id?;
    let base = env
        .non_empty("FORMS_PORTAL_URL")
        .unwrap_or_else(|| "https://forms.weldsuite.org".to_owned());
    let base = base.strip_suffix('/').unwrap_or(&base);
    Some(format!("{base}/f/{public_id}"))
}

/// `workspaceAppUrl(base, clerkOrgId, path)` (`@weldsuite/emails`).
pub(crate) fn workspace_app_url(base: &str, clerk_org_id: &str, path: &str) -> String {
    let mut base = base.trim();
    while let Some(trimmed) = base.strip_suffix('/') {
        base = trimmed;
    }
    let inner = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("/{path}")
    };
    if clerk_org_id.is_empty() {
        format!("{base}{inner}")
    } else {
        let org: String = form_urlencoded_component(clerk_org_id);
        format!("{base}/w/{org}{inner}")
    }
}

/// `encodeURIComponent(text)`.
pub(crate) fn form_urlencoded_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_strings_match_to_iso_string() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
        assert_eq!(day_of(1_700_000_000_123), "2023-11-14");
        assert_eq!(month_of(1_700_000_000_123), "2023-11");
    }

    #[test]
    fn app_urls_match_workspace_app_url() {
        assert_eq!(
            workspace_app_url("https://app.test/", "org_forms", "/weldforms/fill/abc"),
            "https://app.test/w/org_forms/weldforms/fill/abc"
        );
        assert_eq!(js_slice("abc", 2), "ab");
    }
}
