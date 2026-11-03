//! The layers after authentication: the licence and read-only gate
//! (`middleware/licence.ts`) and the per-workspace rate limit
//! (`middleware/rate-limit.ts`).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::{OriginalUri, Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use http::{HeaderValue, Method, StatusCode};
use weldsuite_catalogs::{ApiModule, api_module, find_module_for_path};
use weldsuite_db::ReadOnlyReason;
use weldsuite_kit::ApiError;
use weldsuite_pipeline::{app_not_licensed, workspace_read_only};

use crate::ExternalApiState;
use crate::session::{ApiSession, unauthorized};

/// `/v1` objects whose first-party name differs (`EXTERNAL_OBJECT_MODULES`).
fn aliased_module(object: &str) -> Option<&'static str> {
    match object {
        "knowledge-pages" | "knowledge-spaces" => Some("know"),
        "quotes" => Some("crm"),
        _ => None,
    }
}

/// `findModuleForExternalPath`: the module that owns `/v1/<object>…`, found
/// through the first-party path for the same object.
pub fn module_for_external_path(path: &str) -> &'static ApiModule {
    let core = || find_module_for_path("/api");
    let Some(rest) = path.strip_prefix("/v1/") else {
        return core();
    };
    let object = rest.split(['/', '?']).next().unwrap_or_default();
    if object.is_empty() {
        return core();
    }
    if let Some(module) = aliased_module(object).and_then(api_module) {
        return module;
    }
    find_module_for_path(&format!("/api/{rest}"))
}

/// `missingLicensedApp`: the module's own app when none of its apps is
/// licensed; `None` when the module is never gated or one is.
pub(crate) fn missing_licensed_app<'a>(
    module: &'a ApiModule,
    licensed: &[String],
) -> Option<&'a str> {
    let apps = module.apps.as_ref()?;
    if apps.iter().any(|app| licensed.contains(app)) {
        return None;
    }
    apps.first().map(String::as_str)
}

/// `isReadOnlyRequestAllowed` of external-api: reads always, a write only on
/// `/v1/search`.
pub(crate) fn is_read_only_request_allowed(method: &Method, path: &str) -> bool {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return true;
    }
    path == "/v1/search" || path.starts_with("/v1/search/")
}

/// `licenceMiddleware`: a partner-managed workspace's licence, and a
/// read-only workspace's refusal of writes (a moving database answers a
/// retryable 503).
pub async fn licence_gate(request: Request, next: Next) -> Response {
    let path = full_path(&request);
    if is_before_authentication(&path) {
        return next.run(request).await;
    }
    if let Some(session) = request.extensions().get::<ApiSession>() {
        let path = path.as_str();
        if let Some(licensed) = &session.licensed_apps
            && let Some(missing) = missing_licensed_app(module_for_external_path(path), licensed)
        {
            return app_not_licensed(missing).into_response();
        }
        if session.read_only && !is_read_only_request_allowed(request.method(), path) {
            return match session.read_only_reason.as_deref() {
                Some("database_move") => ApiError::workspace_moving().into_response(),
                Some("partner_suspended") => {
                    workspace_read_only(Some(ReadOnlyReason::PartnerSuspended)).into_response()
                }
                _ => workspace_read_only(Some(ReadOnlyReason::LicenceInactive)).into_response(),
            };
        }
    }
    next.run(request).await
}

/// The request's full path (`/v1/...`), also inside the nested `/v1` router.
pub(crate) fn full_path(request: &Request) -> String {
    request.extensions().get::<OriginalUri>().map_or_else(
        || request.uri().path().to_owned(),
        |uri| uri.path().to_owned(),
    )
}

/// `/v1/oauth` is mounted before authentication: the client credentials in
/// the body are its authentication.
pub(crate) fn is_before_authentication(path: &str) -> bool {
    path.starts_with("/v1/oauth/")
}

/// Requests per minute by tier (`RATE_LIMITS`, the `[[ratelimits]]` of
/// `wrangler.toml`); an unknown tier is `free`'s.
pub(crate) fn tier_limit(tier: &str) -> i64 {
    match tier {
        "business" => 300,
        "scale" => 1_000,
        "enterprise" => 5_000,
        _ => 60,
    }
}

const RATE_WINDOW_SECONDS: u64 = 60;

/// `rateLimitMiddleware`: a fixed one-minute window per workspace on the
/// cache's atomic counters (Cloudflare's native rate limit binding on
/// Global, per location and eventually consistent; Valkey here, exact across
/// pods). `X-RateLimit-Limit` on every answer, 429 with `Retry-After` past
/// the limit. Without a cache the limit is not enforced (one process could
/// only count its own share).
pub async fn rate_limit(
    State(state): State<ExternalApiState>,
    request: Request,
    next: Next,
) -> Response {
    if is_before_authentication(&full_path(&request)) {
        return next.run(request).await;
    }
    let Some(session) = request.extensions().get::<ApiSession>() else {
        return unauthorized("Unauthorized").into_response();
    };
    let limit = tier_limit(&session.tier);
    let mut allowed = true;
    if let Some(cache) = &state.cache {
        let window = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs() / RATE_WINDOW_SECONDS);
        let key = format!("extapi:rl:{}:{window}", session.workspace_id);
        match cache
            .increment_boxed(&key, 1, Some(Duration::from_secs(RATE_WINDOW_SECONDS * 2)))
            .await
        {
            Ok(count) => allowed = count <= limit,
            // A cache outage lets requests through, as the binding does.
            Err(error) => tracing::warn!(%error, "external-api: rate limit counter unavailable"),
        }
    }
    let mut response = if allowed {
        next.run(request).await
    } else {
        ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Too many requests. Please try again later.",
        )
        .with_retry_after(u32::try_from(RATE_WINDOW_SECONDS).unwrap_or(60))
        .into_response()
    };
    response
        .headers_mut()
        .insert("x-ratelimit-limit", HeaderValue::from(limit));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_paths_map_onto_their_module() {
        assert_eq!(module_for_external_path("/v1/knowledge-pages/x").id, "know");
        assert_eq!(module_for_external_path("/v1/quotes").id, "crm");
        assert_eq!(module_for_external_path("/v1/tickets/t_1").id, "desk");
        assert_eq!(module_for_external_path("/v1/people?limit=5").id, "crm");
        assert_eq!(module_for_external_path("/v1").id, "core");
        assert_eq!(module_for_external_path("/v1/app-storage/x").id, "core");
    }

    #[test]
    fn licences_and_read_only() {
        let crm = module_for_external_path("/v1/people");
        let own = crm.apps.as_ref().expect("gated")[0].clone();
        assert_eq!(missing_licensed_app(crm, std::slice::from_ref(&own)), None);
        assert_eq!(missing_licensed_app(crm, &[]), Some(own.as_str()));
        assert!(is_read_only_request_allowed(&Method::GET, "/v1/people"));
        assert!(!is_read_only_request_allowed(&Method::POST, "/v1/people"));
        assert!(is_read_only_request_allowed(&Method::POST, "/v1/search/x"));
        assert!(!is_read_only_request_allowed(&Method::POST, "/v1/searches"));
    }

    #[test]
    fn tiers_have_their_limits() {
        assert_eq!(tier_limit("enterprise"), 5_000);
        assert_eq!(tier_limit("unknown"), 60);
    }
}
