//! `middleware/rate-limit.ts`: requests per caller per minute, counted in
//! the workspace cache (`WORKSPACE_CACHE`): 120 reads, 30 writes. Without a
//! cache, or when it fails, nothing is limited.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use time::OffsetDateTime;
use weldsuite_ports::DynCache;

use crate::{Ctx, WidgetState};

/// GET, HEAD and OPTIONS requests per minute.
const READ_LIMIT: i64 = 120;
/// POST, PUT, PATCH and DELETE requests per minute.
const WRITE_LIMIT: i64 = 30;
/// How long a minute's counter is kept.
const COUNTER_TTL: Duration = Duration::from_secs(120);

/// The caller: `cf-connecting-ip`, else `x-forwarded-for` as it came, else
/// `unknown`.
fn caller(headers: &HeaderMap) -> String {
    ["cf-connecting-ip", "x-forwarded-for"]
        .iter()
        .find_map(|name| {
            headers
                .get(*name)
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("unknown")
        .to_owned()
}

/// The counter's key and the limit for a request at `now` (Unix seconds).
fn counter(method: &Method, caller: &str, now: i64) -> (String, i64) {
    let read = matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS);
    let minute = now.div_euclid(60);
    let key = format!("rl:{caller}:{}:{minute}", if read { "r" } else { "w" });
    (key, if read { READ_LIMIT } else { WRITE_LIMIT })
}

/// `rateLimitMiddleware()`.
pub(crate) async fn rate_limit(
    State(state): State<WidgetState>,
    ctx: Ctx,
    request: Request,
    next: Next,
) -> Response {
    let Some(kv) = ctx.kv(&state) else {
        return next.run(request).await;
    };
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let (key, limit) = counter(request.method(), &caller(request.headers()), now);
    if let Some(refusal) = check(&kv, &key, limit, now).await {
        return refusal;
    }
    next.run(request).await
}

/// The 429 when the counter is at the limit; else the count goes up. A
/// cache error lets the request through.
async fn check(kv: &Arc<dyn DynCache>, key: &str, limit: i64, now: i64) -> Option<Response> {
    let current = match kv.get_boxed(key).await {
        Ok(current) => current,
        Err(error) => {
            tracing::warn!(%error, "[widget-api] rate limit read failed");
            return None;
        }
    };
    // `Number.parseInt(current, 10)`: a counter is a number written here.
    let count: i64 = current
        .as_deref()
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0);
    if count >= limit {
        let retry_after = 60 - now.rem_euclid(60);
        let mut response = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": "Too many requests", "retryAfter": retry_after })),
        )
            .into_response();
        if let Ok(value) = HeaderValue::from_str(&retry_after.to_string()) {
            response.headers_mut().insert("retry-after", value);
        }
        return Some(response);
    }
    if let Err(error) = kv
        .put_boxed(key, &(count + 1).to_string(), Some(COUNTER_TTL))
        .await
    {
        tracing::warn!(%error, "[widget-api] rate limit write failed");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_ports::MemoryCache;

    #[test]
    fn reads_and_writes_count_apart_per_minute() {
        let (read, read_limit) = counter(&Method::GET, "1.2.3.4", 120);
        let (write, write_limit) = counter(&Method::POST, "1.2.3.4", 179);
        assert_eq!(read, "rl:1.2.3.4:r:2");
        assert_eq!(read_limit, 120);
        assert_eq!(write, "rl:1.2.3.4:w:2");
        assert_eq!(write_limit, 30);
        assert_eq!(counter(&Method::OPTIONS, "x", 0).1, 120);
    }

    #[test]
    fn the_caller_is_the_first_header_present() {
        let mut headers = HeaderMap::new();
        assert_eq!(caller(&headers), "unknown");
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("5.6.7.8, 10.0.0.1"),
        );
        assert_eq!(caller(&headers), "5.6.7.8, 10.0.0.1");
        headers.insert("cf-connecting-ip", HeaderValue::from_static("1.2.3.4"));
        assert_eq!(caller(&headers), "1.2.3.4");
    }

    #[tokio::test]
    async fn the_limit_answers_429_with_retry_after() {
        let kv: Arc<dyn DynCache> = Arc::new(MemoryCache::default());
        for _ in 0..3 {
            assert!(check(&kv, "rl:k:w:1", 3, 75).await.is_none());
        }
        let refused = check(&kv, "rl:k:w:1", 3, 75).await.expect("refused");
        assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(refused.headers()["retry-after"], "45");
    }
}
