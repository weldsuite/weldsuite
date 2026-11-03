//! personal-api on the Kubernetes editions: the person's own surface,
//! outside any workspace (ADR MAIL-008, DATA-011). One master
//! `personal_accounts` row per user (keyed by the session's subject) and the
//! rows of every consumer app in one shared personal database
//! (`DATABASE_URL_PERSONAL`, `packages/core/db/src/schema/personal`), each
//! scoped by `personal_account_id`.
//!
//! The worker's own `/api/...` paths collide with app-api's (`/api/me`) and
//! calendar-api's (`/api/calendars`), and on Kubernetes one host serves every
//! path (ADR OPS-013), so the server mounts this router under
//! `/personal-api`: a client's personal-api base URL is
//! `https://<host>/personal-api` there, as it is `https://personal-api.weldsuite.org`
//! on Global. Inside, the paths are the worker's.
//!
//! | TypeScript (`apps/workers/personal-api/src`) | Here |
//! |---|---|
//! | `index.ts`, `middleware/clerk.ts`, `middleware/personal-account.ts`, `lib/billing.ts` | this file, [`session`] |
//! | `routes/onboard.ts`, `routes/me.ts`, `routes/push-tokens.ts` | [`account`] |
//! | `routes/calendars.ts`, `routes/calendar-events.ts`, `services/calendar-access.ts` | [`calendars`], [`events`] |
//! | `routes/booking-pages.ts`, `routes/bookings.ts`, `services/calendar-slots.ts` | [`booking_pages`], [`bookings`] |
//! | `routes/mail-accounts.ts`, `mail-labels.ts`, `mail-drafts.ts` | [`mail_boxes`] |
//! | `routes/mail-messages.ts`, `services/mail-send.ts`, `lib/send-errors.ts`, the read push | [`mail_messages`], [`mail_send`] |
//! | `routes/mail-subscriptions.ts`, `services/mail-subscriptions.ts` | [`mail_subscriptions`] |
//!
//! Not served: the free `@weldmail.com` addresses (`/api/mail/weldmail`,
//! `mail-free-addresses` in `/config.json`): that domain's MX and reputation
//! belong to Global (ADR MAIL-010), as for mail-api's `/api/mail-weldmail`.
//! Those paths answer the worker's 404.

// The handlers return the response a check ends with; the readers follow
// the Zod schemas field by field.
#![allow(clippy::result_large_err, clippy::too_many_lines)]

mod account;
mod booking_pages;
mod bookings;
mod calendars;
mod caller;
mod events;
mod js;
mod mail_boxes;
mod mail_messages;
mod mail_send;
mod mail_subscriptions;
mod session;

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::{HeaderName, Method, StatusCode};
use serde_json::json;
use tower_http::cors::{AllowOrigin, CorsLayer};
use weldsuite_auth::SessionVerifier;
use weldsuite_db::PgPool;
use weldsuite_events::TaskTracker;
use weldsuite_mail_domain::outbound::OutboundBindings;
use weldsuite_ports::OutboundHttp;

pub use caller::RequestPersonalDb;

/// Where the server mounts personal-api (see the crate docs).
pub const BASE_PATH: &str = "/personal-api";

/// What personal-api reaches: the master and personal databases, the session
/// verifier, the customer-mail bindings (WeldMail's transport and outbound
/// ledgers, the same ones mail-api sends through), third-party HTTP (Expo
/// push, one-click unsubscribes), and the tracker its background work runs
/// on. Conformance builds give each request the test's instead
/// (`MasterDb`, [`RequestPersonalDb`], the request's `SessionVerifier`,
/// `RequestOutbound`, `OutboundHttp`, `RequestEnv`).
#[derive(Clone)]
pub struct PersonalState {
    /// `DATABASE_URL_MASTER`.
    pub master: Option<PgPool>,
    /// `DATABASE_URL_PERSONAL`; unset, every route that reads it answers its
    /// 500, as the worker does without the secret.
    pub personal: Option<PgPool>,
    /// The deployment's session verifier (Clerk or the OIDC provider).
    pub verifier: Option<Arc<SessionVerifier>>,
    /// `SEND_EMAIL`, `OUTBOUND_LEDGER`, `OUTBOUND_PLATFORM`, `OUTBOUND_BACKSTOP`.
    pub outbound: OutboundBindings,
    pub http: Option<OutboundHttp>,
    /// `waitUntil` work (the "email read" push).
    pub tracker: TaskTracker,
    /// `ENVIRONMENT`, reported by `/health`.
    pub environment: String,
    /// Env values the routes read (`CLERK_AUTHORIZED_PARTIES` is the
    /// verifier's).
    pub env: Arc<HashMap<String, String>>,
}

/// personal-api's routes at the worker's own paths, with its CORS (any
/// origin, no credentials) and its 404. The server nests it under
/// [`BASE_PATH`].
pub fn router(state: PersonalState) -> Router {
    let state = Arc::new(state);
    let api = Router::new()
        .merge(account::routes())
        .merge(calendars::routes())
        .merge(events::routes())
        .merge(booking_pages::routes())
        .merge(bookings::routes())
        .merge(mail_boxes::routes())
        .merge(mail_messages::routes())
        .merge(mail_subscriptions::routes());
    Router::new()
        .route("/robots.txt", get(robots))
        .route("/health", get(health))
        .merge(api)
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        // Every `/api/*` request: the session, then the personal account.
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&state),
            session::session,
        ))
        .with_state(state)
        .layer(cors())
}

/// `cors({ origin: '*', allowMethods, allowHeaders, credentials: false })`.
fn cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::any())
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            HeaderName::from_static("content-type"),
            HeaderName::from_static("authorization"),
        ])
}

async fn robots() -> Response {
    (
        [(http::header::CONTENT_TYPE, "text/plain; charset=UTF-8")],
        "User-agent: *\nDisallow: /\n",
    )
        .into_response()
}

async fn health(State(state): State<Arc<PersonalState>>, request: Request) -> Response {
    let environment = request
        .extensions()
        .get::<weldsuite_kit::RequestEnv>()
        .and_then(|env| env.0.get("ENVIRONMENT").cloned())
        .unwrap_or_else(|| state.environment.clone());
    axum::Json(json!({
        "status": "ok",
        "environment": environment,
        "timestamp": js::now_iso(),
    }))
    .into_response()
}

/// `app.notFound`: the path within personal-api.
async fn not_found(request: Request) -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(json!({
            "error": {
                "code": "NOT_FOUND",
                "message": "Not Found",
                "details": { "path": request.uri().path() },
            }
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use http::Request;
    use http_body_util::BodyExt;
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;

    fn app() -> Router {
        router(PersonalState {
            master: None,
            personal: None,
            verifier: None,
            outbound: OutboundBindings::default(),
            http: None,
            tracker: TaskTracker::new(),
            environment: "test".to_owned(),
            env: Arc::default(),
        })
    }

    async fn call(path: &str, authorization: Option<&str>) -> (StatusCode, Value) {
        let mut request = Request::builder().uri(path);
        if let Some(value) = authorization {
            request = request.header(http::header::AUTHORIZATION, value);
        }
        let response = app()
            .oneshot(request.body(Body::empty()).expect("request"))
            .await
            .expect("response");
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn the_worker_s_own_answers() {
        let (status, body) = call("/health", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["environment"], "test");
        let (status, body) = call("/nowhere", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["details"]["path"], "/nowhere");
        let (status, body) = call("/api/me", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            body["error"]["message"],
            "Missing or invalid Authorization header"
        );
        // Without a verifier no token passes.
        let (status, body) = call("/api/nothing", Some("Bearer x")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"]["message"], "Token verification failed");
    }
}
