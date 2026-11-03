//! The request's caller and databases, and the routes' error handling
//! (`lib/response.ts`, each route's try/catch).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::FromRequestParts;
use axum::response::{IntoResponse, Response};
use http::request::Parts;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Issues, json_body, query_values};
use weldsuite_kit::{ApiError, List, Pagination};
use weldsuite_mail_domain::outbound::{OutboundBindings, RequestOutbound};
use weldsuite_ports::OutboundHttp;

use crate::PersonalState;
use crate::session::{Account, Entitlements, Session};

/// The test's personal database, which conformance builds put on each
/// request (the context's database: personal-api has no tenant).
#[derive(Clone)]
pub struct RequestPersonalDb(pub PgPool);

/// An `/api/*` request after the session and the account lookup.
pub(crate) struct Caller {
    pub(crate) user_id: String,
    pub(crate) entitlements: Entitlements,
    pub(crate) account: Option<Account>,
    personal: Option<PgPool>,
    pub(crate) master: Option<PgPool>,
    pub(crate) outbound: OutboundBindings,
    pub(crate) http: Option<OutboundHttp>,
    pub(crate) state: Arc<PersonalState>,
}

impl FromRequestParts<Arc<PersonalState>> for Caller {
    type Rejection = Response;

    fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<PersonalState>,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let extensions = &parts.extensions;
        let caller = extensions
            .get::<Session>()
            .cloned()
            .map(|session| Self {
                user_id: session.user_id,
                entitlements: session.entitlements,
                account: session.account,
                personal: extensions
                    .get::<RequestPersonalDb>()
                    .map(|db| db.0.clone())
                    .or_else(|| state.personal.clone()),
                master: extensions
                    .get::<weldsuite_db::MasterDb>()
                    .map(|db| db.0.clone())
                    .or_else(|| state.master.clone()),
                outbound: extensions
                    .get::<RequestOutbound>()
                    .map_or_else(|| state.outbound.clone(), |request| request.0.clone()),
                http: extensions
                    .get::<OutboundHttp>()
                    .cloned()
                    .or_else(|| state.http.clone()),
                state: Arc::clone(state),
            })
            .ok_or_else(|| ApiError::unauthorized().into_response());
        std::future::ready(caller)
    }
}

impl Caller {
    /// `personalAccountId`, or the refusal the routes answer without one.
    pub(crate) fn account_id(&self) -> Result<&str, Response> {
        self.account
            .as_ref()
            .map(|account| account.id.as_str())
            .ok_or_else(personal_account_required)
    }

    /// `getPersonalDb(c.env)`: throws without `DATABASE_URL_PERSONAL`.
    pub(crate) fn personal(&self) -> Result<&PgPool, Failure> {
        self.personal
            .as_ref()
            .ok_or_else(|| Failure::Internal("DATABASE_URL_PERSONAL secret is not set".to_owned()))
    }

    /// `getMasterDb(c.env)`: throws without `DATABASE_URL_MASTER`.
    pub(crate) fn master(&self) -> Result<&PgPool, Failure> {
        self.master
            .as_ref()
            .ok_or_else(|| Failure::Internal("DATABASE_URL_MASTER secret is not set".to_owned()))
    }
}

/// `error.personalAccountRequired(c)`.
pub(crate) fn personal_account_required() -> Response {
    error_response(
        StatusCode::NOT_FOUND,
        "PERSONAL_ACCOUNT_REQUIRED",
        "Personal account required. Call POST /api/onboard first.",
        None,
    )
}

/// `{ error: { code, message, details? } }` with any status.
pub(crate) fn error_response(
    status: StatusCode,
    code: &str,
    message: &str,
    details: Option<Value>,
) -> Response {
    let mut error = json!({ "code": code, "message": message });
    if let Some(details) = details {
        error["details"] = details;
    }
    (status, axum::Json(json!({ "error": error }))).into_response()
}

/// `error.planLimit(c, message, details)`.
pub(crate) fn plan_limit(message: &str, details: Value) -> Response {
    error_response(
        StatusCode::FORBIDDEN,
        "PLAN_LIMIT_REACHED",
        message,
        Some(details),
    )
}

/// Why a route's work stopped.
#[derive(Debug)]
pub(crate) enum Failure {
    /// An answer the route gives on purpose.
    Answer(Response),
    /// A statement failed (the route's catch).
    Db(sqlx::Error),
    /// Anything else the route's catch takes (an Invalid Date bound to a query).
    Internal(String),
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self::Db(error)
    }
}

impl From<ApiError> for Failure {
    fn from(error: ApiError) -> Self {
        Self::Answer(error.into_response())
    }
}

impl From<Response> for Failure {
    fn from(response: Response) -> Self {
        Self::Answer(response)
    }
}

impl Failure {
    /// The unique-constraint violation a route turns into a conflict.
    pub(crate) fn is_unique_violation(&self) -> bool {
        matches!(self, Self::Db(sqlx::Error::Database(error)) if error.code().as_deref() == Some("23505"))
    }
}

/// The route's try/catch: its answer, or `error.internal(c, message)`.
pub(crate) fn answer(result: Result<Response, Failure>, message: &str) -> Response {
    match result {
        Ok(response) | Err(Failure::Answer(response)) => response,
        Err(Failure::Db(error)) => {
            tracing::error!(%error, "[personal-api] {message}");
            ApiError::internal().with_message(message).into_response()
        }
        Err(Failure::Internal(error)) => {
            tracing::error!(%error, "[personal-api] {message}");
            ApiError::internal().with_message(message).into_response()
        }
    }
}

/// Work outside a route's try/catch: `app.onError`'s 500.
pub(crate) fn unhandled(result: Result<Response, Failure>) -> Response {
    answer(result, "Internal server error")
}

/// `{ data }`.
pub(crate) fn data(value: Value) -> Response {
    axum::Json(json!({ "data": value })).into_response()
}

/// `{ data }` with 201.
pub(crate) fn created(value: Value) -> Response {
    (StatusCode::CREATED, axum::Json(json!({ "data": value }))).into_response()
}

/// `list(c, rows, cursorPagination(totalCount, hasMore, cursor))`.
pub(crate) fn list(
    rows: Vec<Value>,
    total: i64,
    has_more: bool,
    cursor: Option<String>,
) -> Response {
    List::new(
        rows,
        Pagination::new(u64::try_from(total).unwrap_or(0), has_more, cursor),
    )
    .into_response()
}

/// `noContent(c)`.
pub(crate) fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

/// `zValidator('json', schema)`: the body read field by field, or the 400.
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Response> {
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body).map_err(IntoResponse::into_response)?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues.finish().map_err(IntoResponse::into_response)?;
    value.ok_or_else(|| ApiError::internal().into_response())
}

/// `zValidator('query', schema)`.
pub(crate) fn validate_query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Response> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &values);
    issues.finish().map_err(IntoResponse::into_response)?;
    Ok(value)
}

/// `c.req.query()`: the first value of each key.
pub(crate) fn query_map(raw: Option<&str>) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for (key, value) in form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
        out.entry(key.into_owned())
            .or_insert_with(|| value.into_owned());
    }
    out
}

/// `to_jsonb` rows as Drizzle hands them out.
pub(crate) fn rows(values: Vec<Value>) -> Vec<Value> {
    values.into_iter().map(weldsuite_db::js_row).collect()
}

/// Some fields of a row, in that order.
pub(crate) fn pick(row: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        out.insert(
            (*key).to_owned(),
            row.get(*key).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(out)
}
