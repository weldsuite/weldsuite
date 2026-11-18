//! Company and person chats (`lib/record-chat-forward.ts`): crm-api keeps
//! `/api/companies/:id/chat/*` and `/api/people/:id/chat/*` and forwards
//! them to chat-api's record chats
//! (`/api/chat-entity-channels/<company|person>/:id/<action>`).
//!
//! In the workers that is the `CHAT_API` service binding. In this binary
//! the chat module is served by the same process, so the binding is a
//! [`ServiceBinding`]: the request, at its new path, run through the chat
//! module's record-chat router. It carries what this request's session and
//! tenant layers established ([`forwarded_extensions`]), which is what
//! chat-api's own `apiAuth()` would establish again from the same headers,
//! and nothing of this route's own routing. Where the chat module isn't
//! served (and in conformance builds, whose crm tests run without
//! `CHAT_API`) the binding is unset and the routes answer as crm-api does
//! without it: 503 `SERVICE_UNAVAILABLE`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::{Extensions, HeaderMap, HeaderValue, Method, Request, StatusCode};
use weldsuite_kit::ApiError;

use crate::CrmState;

/// A worker's service binding served in this process: takes the forwarded
/// request and answers it.
pub type ServiceBinding =
    Arc<dyn Fn(Request<Body>) -> Pin<Box<dyn Future<Output = Response> + Send>> + Send + Sync>;

/// `FORWARDED_BY_HEADER` of `@weldsuite/worker-kit`.
const FORWARDED_BY: &str = "x-forwarded-by";

fn unavailable() -> Response {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "SERVICE_UNAVAILABLE",
        "chat-api is unavailable",
    )
    .into_response()
}

/// What the forwarded request takes from the incoming one.
struct Incoming {
    headers: HeaderMap,
    extensions: Extensions,
    body: Bytes,
}

/// The extensions the chat routes read: the session, the tenant database,
/// the caller's permissions and app context, the request id, and the
/// per-request overrides a test harness brings (`access.rs` in the chat
/// module, and its permission gate). Only these go along, never the whole
/// set: the rest belongs to this route's own routing, and axum adds a
/// route's path params to any already on the request, so this route's
/// `{id}` would reach the chat route's `Path<(entity_type, entity_id)>` as a
/// third param and fail it.
fn forwarded_extensions(incoming: &Extensions) -> Extensions {
    let mut forwarded = Extensions::new();
    macro_rules! carry {
        ($($kind:ty),* $(,)?) => {
            $(
                if let Some(value) = incoming.get::<$kind>() {
                    forwarded.insert(value.clone());
                }
            )*
        };
    }
    carry!(
        weldsuite_auth::AuthContext,
        weldsuite_db::Tenant,
        weldsuite_permissions::Permissions,
        weldsuite_permissions::PresetPermissions,
        weldsuite_permissions::AppContext,
        weldsuite_kit::RequestEnv,
        weldsuite_kit::RequestId,
        weldsuite_ports::RequestCache,
        weldsuite_ports::FileStores,
        weldsuite_ports::StorageBuckets,
        weldsuite_ports::OutboundHttp,
        weldsuite_ports::PresenceReader,
    );
    forwarded
}

/// `forwardToChatApi(c, entityType, action)`.
async fn forward(
    state: &CrmState,
    entity: &str,
    id: &str,
    action: &str,
    method: Method,
    incoming: Incoming,
) -> Response {
    let Incoming {
        headers,
        extensions,
        body,
    } = incoming;
    if id.is_empty() {
        return ApiError::bad_request("Record id is required").into_response();
    }
    let Some(binding) = state.chat_api.clone() else {
        tracing::error!("[crm-api/record-chat] CHAT_API binding is missing");
        return unavailable();
    };
    let path = format!(
        "/api/chat-entity-channels/{entity}/{}/{action}",
        weldsuite_kit::cursor::encode_uri_component(id)
    );
    let mut request = Request::builder().method(method.clone()).uri(path);
    // Routed afresh: the chat router matches its own path and params.
    if let Some(target) = request.extensions_mut() {
        *target = forwarded_extensions(&extensions);
    }
    if let Some(target) = request.headers_mut() {
        *target = headers;
        if !target.contains_key("x-request-id") {
            let id = weldsuite_kit::generate_id("req");
            if let Ok(value) = HeaderValue::from_str(&id) {
                target.insert("x-request-id", value);
            }
        }
        target.insert(FORWARDED_BY, HeaderValue::from_static("crm-api"));
    }
    let body = if method == Method::GET || method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(body)
    };
    match request.body(body) {
        Ok(request) => binding(request).await,
        Err(error) => {
            tracing::error!(%error, "[crm-api/record-chat] chat-api unreachable");
            unavailable()
        }
    }
}

macro_rules! chat_handlers {
    ($entity:literal, $channel:ident, $messages:ident, $follow:ident, $unfollow:ident) => {
        pub(crate) async fn $channel(
            State(state): State<CrmState>,
            Path(id): Path<String>,
            headers: HeaderMap,
            extensions: Extensions,
        ) -> Response {
            let incoming = Incoming {
                headers,
                extensions,
                body: Bytes::new(),
            };
            forward(&state, $entity, &id, "channel", Method::GET, incoming).await
        }
        pub(crate) async fn $messages(
            State(state): State<CrmState>,
            Path(id): Path<String>,
            headers: HeaderMap,
            extensions: Extensions,
            body: Bytes,
        ) -> Response {
            let incoming = Incoming {
                headers,
                extensions,
                body,
            };
            forward(&state, $entity, &id, "messages", Method::POST, incoming).await
        }
        pub(crate) async fn $follow(
            State(state): State<CrmState>,
            Path(id): Path<String>,
            headers: HeaderMap,
            extensions: Extensions,
            body: Bytes,
        ) -> Response {
            let incoming = Incoming {
                headers,
                extensions,
                body,
            };
            forward(&state, $entity, &id, "follow", Method::POST, incoming).await
        }
        pub(crate) async fn $unfollow(
            State(state): State<CrmState>,
            Path(id): Path<String>,
            headers: HeaderMap,
            extensions: Extensions,
            body: Bytes,
        ) -> Response {
            let incoming = Incoming {
                headers,
                extensions,
                body,
            };
            forward(&state, $entity, &id, "follow", Method::DELETE, incoming).await
        }
    };
}

chat_handlers!(
    "company",
    company_channel,
    company_messages,
    company_follow,
    company_unfollow
);
chat_handlers!(
    "person",
    person_channel,
    person_messages,
    person_follow,
    person_unfollow
);

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::task::{Context, Poll, Waker};

    use super::*;

    /// Runs a forward whose binding answers at once (nothing in it waits).
    fn ready<F: Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        match future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(output) => output,
            Poll::Pending => panic!("the forward waited"),
        }
    }

    /// Something of the CRM route's own routing (as axum's path params are).
    #[derive(Clone)]
    struct Routing;

    /// What the binding was handed: method, path, the session's user, whether
    /// the CRM route's routing came along, `x-forwarded-by`.
    type Seen = (Method, String, Option<String>, bool, Option<HeaderValue>);

    fn state(chat_api: Option<ServiceBinding>) -> CrmState {
        CrmState {
            services: crate::CrmServices {
                events: weldsuite_events::EntityEventPublisher::new(
                    None,
                    weldsuite_events::TaskTracker::new(),
                ),
                realtime: None,
                files: None,
                cache: None,
                jobs: None,
                env: Arc::default(),
            },
            chat_api,
        }
    }

    fn incoming() -> Incoming {
        let mut extensions = Extensions::new();
        extensions.insert(weldsuite_auth::AuthContext {
            user_id: "user_1".to_owned(),
            org_id: Some("org_1".to_owned()),
            session_id: String::new(),
            factor_verification_age: None,
        });
        extensions.insert(Routing);
        Incoming {
            headers: HeaderMap::new(),
            extensions,
            body: Bytes::from_static(b"{\"content\":\"hi\"}"),
        }
    }

    #[test]
    fn forwards_to_the_record_chat_with_the_requests_session() {
        let seen: Arc<Mutex<Option<Seen>>> = Arc::default();
        let record = Arc::clone(&seen);
        let binding: ServiceBinding = Arc::new(move |request: Request<Body>| {
            *record.lock().expect("lock") = Some((
                request.method().clone(),
                request.uri().to_string(),
                request
                    .extensions()
                    .get::<weldsuite_auth::AuthContext>()
                    .map(|auth| auth.user_id.clone()),
                request.extensions().get::<Routing>().is_some(),
                request.headers().get(FORWARDED_BY).cloned(),
            ));
            Box::pin(std::future::ready(StatusCode::CREATED.into_response()))
        });
        let response = ready(forward(
            &state(Some(binding)),
            "company",
            "co 1",
            "messages",
            Method::POST,
            incoming(),
        ));
        assert_eq!(response.status(), StatusCode::CREATED);
        let (method, path, user, routing, by) =
            seen.lock().expect("lock").clone().expect("forwarded");
        assert_eq!(method, Method::POST);
        assert_eq!(path, "/api/chat-entity-channels/company/co%201/messages");
        assert_eq!(user.as_deref(), Some("user_1"));
        assert!(!routing, "the CRM route's own routing stays behind");
        assert_eq!(by, Some(HeaderValue::from_static("crm-api")));
    }

    #[test]
    fn answers_503_without_chat() {
        let response = ready(forward(
            &state(None),
            "person",
            "per_1",
            "channel",
            Method::GET,
            incoming(),
        ));
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
