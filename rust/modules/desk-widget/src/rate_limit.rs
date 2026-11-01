//! `middleware/rate-limit.ts`: requests per caller per minute, counted in
//! the workspace cache (`WORKSPACE_CACHE`): 120 reads, 30 writes. Without a
//! cache, or when it fails, nothing is limited.
//!
//! The caller is not read as the worker reads it. On Global, Cloudflare
//! overwrites `CF-Connecting-IP`; on Kubernetes nothing in front of the
//! server does, so the client could send a new one with every request and
//! never be counted twice. Here the caller is the `X-Forwarded-For` entry the
//! ingress appended (`TRUSTED_PROXIES` from the right, as the sign portal
//! reads the signer's address), and `CF-Connecting-IP` is ignored.

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

/// The caller (`forwardedClientIp(forwardedFor, trustedProxies)`): the
/// `X-Forwarded-For` entry `trusted_proxies` from the right, when it looks
/// like an address; else `unknown`, one shared counter.
fn caller(headers: &HeaderMap, trusted_proxies: usize) -> String {
    let hops: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|hop| !hop.is_empty())
        .collect();
    hops.len()
        .checked_sub(trusted_proxies.max(1))
        .and_then(|at| hops.get(at))
        .filter(|ip| {
            (2..=45).contains(&ip.len())
                && ip
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() || matches!(b, b'.' | b':'))
        })
        .map_or_else(|| "unknown".to_owned(), |ip| (*ip).to_owned())
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
    let caller = caller(request.headers(), state.settings.trusted_proxies);
    let (key, limit) = counter(request.method(), &caller, now);
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
    fn the_caller_is_the_address_the_ingress_appended() {
        let mut headers = HeaderMap::new();
        assert_eq!(caller(&headers, 1), "unknown");
        // What the client sent sits to the left of the ingress's entry.
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("6.6.6.6, 5.6.7.8"),
        );
        assert_eq!(caller(&headers, 1), "5.6.7.8");
        assert_eq!(caller(&headers, 2), "6.6.6.6");
        assert_eq!(caller(&headers, 3), "unknown");
        // A CF-Connecting-IP the client made up counts for nothing.
        headers.insert("cf-connecting-ip", HeaderValue::from_static("1.2.3.4"));
        assert_eq!(caller(&headers, 1), "5.6.7.8");
        // Neither does an entry that is not an address.
        headers.insert("x-forwarded-for", HeaderValue::from_static("not-an-ip"));
        assert_eq!(caller(&headers, 1), "unknown");
        headers.insert("x-forwarded-for", HeaderValue::from_static("2001:db8::1"));
        assert_eq!(caller(&headers, 1), "2001:db8::1");
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
