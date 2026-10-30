//! What the `/api` route groups share: the route error with its 500
//! fallback, `zValidator` for bodies and query strings, list envelopes,
//! timestamps and the mailbox-directory bump.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use serde_json::{Map, Value};
use time::OffsetDateTime;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::{Issues, json_body, query_values};
use weldsuite_kit::{ApiError, List, Pagination};

use crate::{Caller, MailState};

/// A route's failure: a response it wrote itself, or a database error that
/// its `try/catch` answers with a 500 and the route's own message.
#[derive(Debug)]
pub(crate) enum MailError {
    Response(Box<Response>),
    Database(sqlx::Error),
}

impl MailError {
    pub(crate) fn api(error: ApiError) -> Self {
        Self::Response(Box::new(error.into_response()))
    }

    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self::api(ApiError::bad_request(message))
    }

    /// `error.forbidden(c, message)`.
    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        Self::api(ApiError::forbidden().with_message(message))
    }

    /// `error.notFound(c, resource, id)`.
    pub(crate) fn not_found(resource: &str, id: Option<&str>) -> Self {
        Self::api(ApiError::not_found(resource, id))
    }

    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        Self::api(ApiError::conflict(message))
    }

    /// The answer; a database error is the route's 500 with `fallback`.
    pub(crate) fn respond(self, fallback: &str) -> Response {
        match self {
            Self::Response(response) => *response,
            Self::Database(error) => {
                tracing::error!(%error, "[mail-api] {fallback}");
                ApiError::internal().with_message(fallback).into_response()
            }
        }
    }
}

impl From<sqlx::Error> for MailError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<ApiError> for MailError {
    fn from(error: ApiError) -> Self {
        Self::api(error)
    }
}

pub(crate) type MailResult<T> = Result<T, MailError>;

/// The route's answer, or its failure with `fallback` as the 500's message.
pub(crate) fn answer(result: MailResult<Response>, fallback: &str) -> Response {
    result.unwrap_or_else(|error| error.respond(fallback))
}

/// A database error outside the route's own `try/catch`: Hono's error
/// handler answers 500 with its default message.
pub(crate) fn unhandled(error: MailError) -> Response {
    match error {
        MailError::Response(response) => *response,
        MailError::Database(error) => {
            tracing::error!(%error, "[mail-api] unhandled");
            ApiError::internal().into_response()
        }
    }
}

/// `zValidator('json', schema)`: the body read by `read`, or the 400.
pub(crate) fn validate<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> MailResult<T> {
    let content_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body)
        .map_err(|bad| MailError::Response(Box::new(bad.into_response())))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| MailError::Response(Box::new(invalid.into_response())))?;
    value.ok_or_else(|| MailError::api(ApiError::internal()))
}

/// `zValidator('query', schema)`.
pub(crate) fn validate_query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> MailResult<T> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &values);
    issues
        .finish()
        .map_err(|invalid| MailError::Response(Box::new(invalid.into_response())))?;
    Ok(value)
}

/// `c.req.query()`: the first value of each key.
pub(crate) fn query_map(raw: Option<&str>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (key, value) in form_urlencoded::parse(raw.unwrap_or_default().as_bytes()) {
        out.entry(key.into_owned())
            .or_insert_with(|| value.into_owned());
    }
    out
}

/// `new Date()` as Drizzle writes it (UTC, milliseconds).
pub(crate) fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `list(c, rows, cursorPagination(totalCount, hasMore, cursor))`.
pub(crate) fn list_response(
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

/// The `limit + 1` probe: the page, whether there is more, the last id.
pub(crate) fn page(mut rows: Vec<Value>, limit: i64) -> (Vec<Value>, bool, Option<String>) {
    let limit = usize::try_from(limit.max(0)).unwrap_or(0);
    let has_more = rows.len() > limit;
    if has_more {
        rows.truncate(limit);
    }
    let cursor = if has_more {
        rows.last()
            .and_then(|r| r["id"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    (rows, has_more, cursor)
}

/// `bumpMailboxDirectory(env, workspaceId)`: a fresh random version under
/// `mbxdirv:<workspaceId>`, so the object modes' cached directory is read
/// again. Never fails the request.
pub(crate) async fn bump_mailbox_directory(caller: &Caller, state: &MailState) {
    let Some(cache) = caller.bindings.cache(state) else {
        return;
    };
    let key = format!("mbxdirv:{}", caller.workspace_id);
    let version = uuid::Uuid::new_v4().to_string();
    if let Err(error) = cache.put_boxed(&key, &version, None).await {
        tracing::warn!(%error, "Could not bump a workspace mailbox-directory version");
    }
}

/// A `jsonb` string array as a list (`[]` for anything else).
pub(crate) fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}
