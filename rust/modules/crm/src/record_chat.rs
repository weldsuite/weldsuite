//! Company and person chats (`lib/record-chat-forward.ts`): crm-api keeps
//! `/api/companies/:id/chat/*` and `/api/people/:id/chat/*` and forwards
//! them to chat-api's record chats
//! (`/api/chat-entity-channels/<company|person>/:id/<action>`).
//!
//! In the workers that is the `CHAT_API` service binding. In this binary
//! the chat module is served by the same process, so the binding is a
//! [`ServiceBinding`]: the request, at its new path, run through the chat
//! module's record-chat router. It carries the extensions this request came
//! with (session, tenant database, permissions), which is what chat-api's
//! own `apiAuth()` would establish again from the same headers. Where the
//! chat module isn't served (and in conformance builds, whose crm tests run
//! without `CHAT_API`) the binding is unset and the routes answer as crm-api
//! does without it: 503 `SERVICE_UNAVAILABLE`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{MatchedPath, Path, State};
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
        mut extensions,
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
    // Routed once already, to this route: the chat router matches its own.
    extensions.remove::<MatchedPath>();
    if let Some(target) = request.extensions_mut() {
        *target = extensions;
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

    /// Something the session layer put on the request.
    #[derive(Clone)]
    struct Session(&'static str);

    /// What the binding was handed: method, path, the session, `x-forwarded-by`.
    type Seen = (Method, String, Option<&'static str>, Option<HeaderValue>);

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
        extensions.insert(Session("user_1"));
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
                    .get::<Session>()
                    .map(|session| session.0),
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
        let (method, path, session, by) = seen.lock().expect("lock").clone().expect("forwarded");
        assert_eq!(method, Method::POST);
        assert_eq!(path, "/api/chat-entity-channels/company/co%201/messages");
        assert_eq!(session, Some("user_1"));
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
