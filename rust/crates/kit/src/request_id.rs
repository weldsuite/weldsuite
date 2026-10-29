//! `X-Request-Id` (`middleware/request-id.ts`): reuse the caller's id or mint a
//! UUID, make it available to handlers, and echo it on the response.

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use http::HeaderValue;
use http::header::HeaderName;

pub const X_REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

/// The request's id, in the request extensions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestId(pub String);

/// Middleware: `axum::middleware::from_fn(request_id)`.
///
/// An empty or non-ASCII incoming header counts as missing, as `||` treats an
/// empty string in TypeScript.
pub async fn request_id(mut request: Request, next: Next) -> Response {
    let incoming = request
        .headers()
        .get(&X_REQUEST_ID)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let id = incoming.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    request.extensions_mut().insert(RequestId(id.clone()));

    let mut response = next.run(request).await;
    if let Ok(value) = HeaderValue::from_str(&id) {
        response.headers_mut().insert(X_REQUEST_ID, value);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::routing::get;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn app() -> Router {
        Router::new()
            .route(
                "/",
                get(|axum::Extension(id): axum::Extension<RequestId>| async move { id.0 }),
            )
            .layer(axum::middleware::from_fn(request_id))
    }

    async fn call(header: Option<&str>) -> (Option<String>, String) {
        let mut builder = http::Request::builder().uri("/");
        if let Some(value) = header {
            builder = builder.header("X-Request-Id", value);
        }
        let response = app()
            .oneshot(builder.body(Body::empty()).expect("request"))
            .await
            .expect("response");
        let echoed = response
            .headers()
            .get(&X_REQUEST_ID)
            .map(|v| v.to_str().unwrap_or_default().to_owned());
        let body = response
            .into_body()
            .collect()
            .await
            .map(http_body_util::Collected::to_bytes)
            .unwrap_or_default();
        (echoed, String::from_utf8(body.to_vec()).unwrap_or_default())
    }

    #[tokio::test]
    async fn reuses_the_callers_id() {
        let (echoed, seen) = call(Some("req-123")).await;
        assert_eq!(echoed.as_deref(), Some("req-123"));
        assert_eq!(seen, "req-123");
    }

    #[tokio::test]
    async fn mints_a_uuid_when_missing_or_empty() {
        for header in [None, Some("")] {
            let (echoed, seen) = call(header).await;
            let echoed = echoed.expect("header set");
            assert_eq!(echoed, seen);
            assert!(uuid::Uuid::parse_str(&echoed).is_ok(), "{echoed}");
        }
    }
}
