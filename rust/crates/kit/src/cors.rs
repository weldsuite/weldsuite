//! CORS for the API, and the matching Clerk authorized-party (`azp`) check
//! (`packages/core/worker-kit/src/cors.ts`).
//!
//! One origin list for every API module and every environment. An unlisted
//! origin gets no `Access-Control-Allow-Origin` at all, never a fallback host.
//! The same list is the allow-list for the `azp` claim of session tokens, so
//! the origins a browser may call from and the origins whose tokens we accept
//! cannot drift apart.
//!
//! Only exact, company-controlled origins belong here. Never add a wildcard or
//! a suffix match: hostnames such as `{slug}.welddesk.org` are chosen by
//! tenants.
//!
//! One difference from Hono: a preflight answers 200 instead of 204. Browsers
//! accept both.

use std::time::Duration;

use http::{HeaderName, HeaderValue, Method};
use tower_http::cors::{AllowOrigin, CorsLayer};

/// The first-party origins, from `FIRST_PARTY_ORIGINS` in `cors.ts` through
/// the catalog export.
pub use weldsuite_catalogs::FIRST_PARTY_ORIGINS;

/// Preflight results are cached for a day: with one API host per module a
/// page talks to several origins, and each pays its own preflights.
pub const CORS_MAX_AGE_SECONDS: u64 = 86_400;

const ALLOW_HEADERS: [&str; 9] = [
    "content-type",
    "authorization",
    "x-request-id",
    // Test-only seams, gated by environment and token where they are read.
    // Allowing the names only lets a browser-driven E2E send them.
    "x-test-token",
    "x-test-flags",
    "x-accounting-entity-id",
    "x-weld-app",
    // Partner portal: which partner the caller acts for, and retry-safe
    // credit grants.
    "x-partner-id",
    "idempotency-key",
];

const EXPOSE_HEADERS: [&str; 3] = [
    "x-request-id",
    "x-partner-warnings",
    // A client reads it off a 503 WORKSPACE_MOVING to know how long to wait.
    "retry-after",
];

/// The `Access-Control-Allow-Origin` value for a request `Origin`: the origin
/// itself when it is first-party, else nothing.
pub fn resolve_cors_origin(origin: Option<&str>) -> Option<&str> {
    origin.filter(|origin| FIRST_PARTY_ORIGINS.contains(origin))
}

/// Parse `CLERK_AUTHORIZED_PARTIES`: extra origins, separated by commas or
/// whitespace, whose tokens are accepted on top of the first-party list (the
/// WeldPass extension's `chrome-extension://<id>`). It widens the `azp`
/// allow-list only, never CORS. Anything that isn't one exact origin is
/// dropped, so a wildcard or a URL with a path cannot widen the list.
pub fn parse_extra_authorized_parties(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(|c: char| c == ',' || c.is_whitespace())
        .map(|entry| entry.trim().to_lowercase())
        .filter(|entry| is_exact_origin(entry))
        .collect()
}

/// Whether a verified token may be used here, judged by its `azp` claim.
///
/// - No claim: accepted. Native apps send no Origin when they mint a token,
///   so the claim is left out (and Clerk's own SDK skips the check then).
/// - A claim that is present but empty, or not a string: refused.
/// - Otherwise: accepted only for a first-party or configured extra origin.
pub fn is_authorized_party(azp: Option<&serde_json::Value>, extra_origins: &[String]) -> bool {
    match azp {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::String(azp)) if !azp.is_empty() => {
            FIRST_PARTY_ORIGINS.contains(&azp.as_str()) || extra_origins.iter().any(|o| o == azp)
        }
        Some(_) => false,
    }
}

/// The CORS layer for an API router.
pub fn api_cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            origin
                .to_str()
                .is_ok_and(|origin| FIRST_PARTY_ORIGINS.contains(&origin))
        }))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(ALLOW_HEADERS.map(HeaderName::from_static))
        .expose_headers(EXPOSE_HEADERS.map(HeaderName::from_static))
        .allow_credentials(true)
        .max_age(Duration::from_secs(CORS_MAX_AGE_SECONDS))
}

/// One concrete origin: `http(s)://host[:port]` or
/// `chrome-extension://<32 letters a-p>`. Mirrors the `EXACT_ORIGIN` regex.
fn is_exact_origin(entry: &str) -> bool {
    if let Some(id) = entry.strip_prefix("chrome-extension://") {
        return id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b));
    }
    let Some(rest) = entry
        .strip_prefix("https://")
        .or_else(|| entry.strip_prefix("http://"))
    else {
        return false;
    };
    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (rest, None),
    };
    let host_ok = !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && host
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && host
            .bytes()
            .last()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    let port_ok =
        port.is_none_or(|p| (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
    host_ok && port_ok
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::routing::get;
    use serde_json::json;
    use tower::ServiceExt;

    #[test]
    fn only_first_party_origins_are_echoed() {
        assert_eq!(
            resolve_cors_origin(Some("https://app.weldsuite.org")),
            Some("https://app.weldsuite.org")
        );
        assert_eq!(resolve_cors_origin(Some("https://evil.example")), None);
        assert_eq!(resolve_cors_origin(Some("https://acme.welddesk.org")), None);
        assert_eq!(resolve_cors_origin(None), None);
    }

    #[test]
    fn extra_parties_keep_only_exact_origins() {
        let id = "abcdefghijklmnopabcdefghijklmnop";
        let raw = format!(
            "chrome-extension://{id}, https://new.weldsuite.org:8443\nhttps://*.weldsuite.org https://x.org/path HTTPS://UPPER.ORG"
        );
        assert_eq!(
            parse_extra_authorized_parties(Some(&raw)),
            vec![
                format!("chrome-extension://{id}"),
                "https://new.weldsuite.org:8443".to_owned(),
                "https://upper.org".to_owned(),
            ]
        );
        assert_eq!(parse_extra_authorized_parties(None), Vec::<String>::new());
        assert_eq!(
            parse_extra_authorized_parties(Some("chrome-extension://short")),
            Vec::<String>::new()
        );
    }

    #[test]
    fn azp_rules_match_the_typescript_check() {
        let extra = vec!["chrome-extension://abcdefghijklmnopabcdefghijklmnop".to_owned()];
        assert!(is_authorized_party(None, &extra));
        assert!(is_authorized_party(Some(&json!(null)), &extra));
        assert!(is_authorized_party(
            Some(&json!("https://app.weldsuite.org")),
            &extra
        ));
        assert!(is_authorized_party(Some(&json!(extra[0])), &extra));
        assert!(!is_authorized_party(Some(&json!("")), &extra));
        assert!(!is_authorized_party(Some(&json!(42)), &extra));
        assert!(!is_authorized_party(
            Some(&json!("https://evil.example")),
            &extra
        ));
    }

    async fn preflight(origin: &str) -> http::Response<Body> {
        let app = Router::new()
            .route("/api/x", get(|| async { "ok" }))
            .layer(api_cors());
        let request = http::Request::builder()
            .method(Method::OPTIONS)
            .uri("/api/x")
            .header("Origin", origin)
            .header("Access-Control-Request-Method", "POST")
            .header("Access-Control-Request-Headers", "content-type,x-weld-app")
            .body(Body::empty())
            .expect("request");
        app.oneshot(request).await.expect("response")
    }

    #[tokio::test]
    async fn preflight_from_a_first_party_origin_is_allowed() {
        let response = preflight("https://app-test.weldsuite.org").await;
        let headers = response.headers();
        assert_eq!(
            headers["access-control-allow-origin"],
            "https://app-test.weldsuite.org"
        );
        assert_eq!(headers["access-control-allow-credentials"], "true");
        assert_eq!(headers["access-control-max-age"], "86400");
        let methods = headers["access-control-allow-methods"]
            .to_str()
            .expect("ascii");
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] {
            assert!(methods.contains(method), "{methods}");
        }
        let allowed = headers["access-control-allow-headers"]
            .to_str()
            .expect("ascii");
        assert!(allowed.contains("x-weld-app"), "{allowed}");
    }

    #[tokio::test]
    async fn preflight_from_another_origin_gets_no_allow_origin() {
        let response = preflight("https://acme.welddesk.org").await;
        assert!(
            response
                .headers()
                .get("access-control-allow-origin")
                .is_none()
        );
    }
}
