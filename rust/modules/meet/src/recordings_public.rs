//! `GET /public/meeting-recordings/:token` (`routes/public-meeting-recordings`):
//! one object of the private recordings bucket, streamed with HTTP Range,
//! for the token `POST /api/meeting-sessions/:id/recording/access` minted.
//! Unknown, expired and malformed tokens all answer the same 404.

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::{HeaderMap, HeaderValue, StatusCode, header};
use serde_json::{Value, json};

use crate::js::{query_param, text};
use crate::{MeetState, RequestParts};

pub(crate) fn routes() -> Router<MeetState> {
    Router::new().route("/{token}", get(stream))
}

fn not_found() -> Response {
    let mut response = (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": { "code": "NOT_FOUND", "message": "Recording not found" } })),
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn failed() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(
            json!({ "error": { "code": "INTERNAL_ERROR", "message": "Failed to read recording" } }),
        ),
    )
        .into_response()
}

/// `RECORDING_TOKEN_PATTERN`.
fn valid_token(token: &str) -> bool {
    (32..=64).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `parseByteRange(header, size)`.
#[derive(Debug, PartialEq, Eq)]
enum Range {
    Whole,
    Part { offset: u64, length: u64 },
    Unsatisfiable,
}

fn digits(text: &str) -> Option<Option<u64>> {
    if text.is_empty() {
        return Some(None);
    }
    if !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // `Number(...)` of a long digit run is a huge double; saturate.
    Some(Some(text.parse::<u64>().unwrap_or(u64::MAX)))
}

fn parse_range(header: Option<&str>, size: u64) -> Range {
    let Some(header) = header.filter(|h| !h.is_empty()) else {
        return Range::Whole;
    };
    if size == 0 {
        return Range::Whole;
    }
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return Range::Whole;
    };
    let Some((from, to)) = spec.split_once('-') else {
        return Range::Whole;
    };
    let (Some(from), Some(to)) = (digits(from), digits(to)) else {
        return Range::Whole;
    };
    match (from, to) {
        (None, None) => Range::Whole,
        (None, Some(suffix)) => {
            if suffix == 0 {
                return Range::Unsatisfiable;
            }
            let length = suffix.min(size);
            Range::Part {
                offset: size - length,
                length,
            }
        }
        (Some(start), to) => {
            if start >= size {
                return Range::Unsatisfiable;
            }
            let end = to.map_or(size - 1, |to| to.min(size - 1));
            if end < start {
                return Range::Whole;
            }
            Range::Part {
                offset: start,
                length: end - start + 1,
            }
        }
    }
}

fn set(headers: &mut HeaderMap, name: header::HeaderName, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(name, value);
    }
}

async fn stream(
    State(state): State<MeetState>,
    Path(token): Path<String>,
    RawQuery(query): RawQuery,
    request: axum::extract::Request,
) -> Response {
    let (parts, _) = request.into_parts();
    let request_parts = RequestParts::of(&parts);
    if !valid_token(&token) {
        return not_found();
    }
    let Some(bucket) = request_parts.recordings(&state) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": { "code": "SERVICE_UNAVAILABLE", "message": "Recording storage is not configured" } })),
        )
            .into_response();
    };
    let grant: Option<Value> = match request_parts.cache(&state) {
        Some(cache) => match cache.get_boxed(&format!("rec-token:{token}")).await {
            Ok(Some(raw)) => match serde_json::from_str(&raw) {
                Ok(value) => Some(value),
                Err(error) => {
                    tracing::error!(%error, "[public-meeting-recordings] token lookup failed");
                    return failed();
                }
            },
            Ok(None) => None,
            Err(error) => {
                tracing::error!(%error, "[public-meeting-recordings] token lookup failed");
                return failed();
            }
        },
        None => return failed(),
    };
    let Some(grant) = grant.filter(|g| !g.is_null()) else {
        return not_found();
    };
    let key = text(&grant, "key").unwrap_or_default().to_owned();
    let prefix = format!(
        "{}/{}/",
        crate::js::present(grant.get("orgId")).map_or_else(|| "undefined".to_owned(), js_string),
        crate::js::present(grant.get("sessionId"))
            .map_or_else(|| "undefined".to_owned(), js_string),
    );
    if !key.starts_with(&prefix) {
        return not_found();
    }
    let head = match bucket.head(&key).await {
        Ok(Some(head)) => head,
        Ok(None) => return not_found(),
        Err(error) => {
            tracing::error!(%error, "[public-meeting-recordings] stream failed");
            return failed();
        }
    };
    let range = parse_range(
        parts
            .headers
            .get(header::RANGE)
            .and_then(|v| v.to_str().ok()),
        head.size,
    );
    let download = query_param(query.as_deref(), "download").as_deref() == Some("1");
    let mut headers = HeaderMap::new();
    set(
        &mut headers,
        header::CONTENT_TYPE,
        text(&grant, "contentType").unwrap_or_default(),
    );
    set(&mut headers, header::ACCEPT_RANGES, "bytes");
    set(&mut headers, header::CACHE_CONTROL, "private, no-store");
    set(
        &mut headers,
        header::CONTENT_DISPOSITION,
        &format!(
            "{}; filename=\"{}\"",
            if download { "attachment" } else { "inline" },
            text(&grant, "filename").unwrap_or_default()
        ),
    );
    if let Some(etag) = &head.etag {
        set(&mut headers, header::ETAG, &format!("\"{etag}\""));
    }
    set(
        &mut headers,
        header::HeaderName::from_static("x-content-type-options"),
        "nosniff",
    );
    match range {
        Range::Unsatisfiable => {
            set(
                &mut headers,
                header::CONTENT_RANGE,
                &format!("bytes */{}", head.size),
            );
            (StatusCode::RANGE_NOT_SATISFIABLE, headers).into_response()
        }
        Range::Part { offset, length } => match bucket.get(&key, Some((offset, length))).await {
            Ok(Some(bytes)) => {
                set(
                    &mut headers,
                    header::CONTENT_RANGE,
                    &format!("bytes {offset}-{}/{}", offset + length - 1, head.size),
                );
                set(&mut headers, header::CONTENT_LENGTH, &length.to_string());
                (StatusCode::PARTIAL_CONTENT, headers, Body::from(bytes)).into_response()
            }
            Ok(None) => not_found(),
            Err(error) => {
                tracing::error!(%error, "[public-meeting-recordings] stream failed");
                failed()
            }
        },
        Range::Whole => match bucket.get(&key, None).await {
            Ok(Some(bytes)) => {
                set(&mut headers, header::CONTENT_LENGTH, &head.size.to_string());
                (StatusCode::OK, headers, Body::from(bytes)).into_response()
            }
            Ok(None) => not_found(),
            Err(error) => {
                tracing::error!(%error, "[public-meeting-recordings] stream failed");
                failed()
            }
        },
    }
}

/// `${value}` of a JSON value.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_parse_like_the_worker() {
        assert_eq!(parse_range(None, 10), Range::Whole);
        assert_eq!(
            parse_range(Some("bytes=0-3"), 10),
            Range::Part {
                offset: 0,
                length: 4
            }
        );
        assert_eq!(
            parse_range(Some("bytes=5-"), 10),
            Range::Part {
                offset: 5,
                length: 5
            }
        );
        assert_eq!(
            parse_range(Some("bytes=-3"), 10),
            Range::Part {
                offset: 7,
                length: 3
            }
        );
        assert_eq!(parse_range(Some("bytes=-0"), 10), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=10-"), 10), Range::Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=5-2"), 10), Range::Whole);
        assert_eq!(parse_range(Some("bytes=0-1,4-5"), 10), Range::Whole);
        assert_eq!(
            parse_range(Some("bytes=0-99"), 10),
            Range::Part {
                offset: 0,
                length: 10
            }
        );
        assert!(valid_token(&"a".repeat(32)));
        assert!(!valid_token("short"));
    }
}
