//! Company and person chats (`lib/record-chat-forward.ts`): crm-api keeps
//! `/api/companies/:id/chat/*` and `/api/people/:id/chat/*` and forwards
//! them to chat-api's record chats
//! (`/api/chat-entity-channels/<company|person>/:id/<action>`).
//!
//! In the workers that is the `CHAT_API` service binding. In this binary
//! the chat module is served by the same process, so the binding is a
//! [`ServiceBinding`]: the request, at its new path, run through the
//! server's own router (session and tenant layers included, as chat-api
//! runs its own auth on the forwarded request). Until the chat module is
//! mounted the binding is unset and the routes answer as crm-api does
//! without `CHAT_API`: 503 `SERVICE_UNAVAILABLE`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, HeaderValue, Method, Request, StatusCode};
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

/// `forwardToChatApi(c, entityType, action)`.
async fn forward(
    state: &CrmState,
    entity: &str,
    id: &str,
    action: &str,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
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
        ) -> Response {
            forward(
                &state,
                $entity,
                &id,
                "channel",
                Method::GET,
                headers,
                Bytes::new(),
            )
            .await
        }
        pub(crate) async fn $messages(
            State(state): State<CrmState>,
            Path(id): Path<String>,
            headers: HeaderMap,
            body: Bytes,
        ) -> Response {
            forward(
                &state,
                $entity,
                &id,
                "messages",
                Method::POST,
                headers,
                body,
            )
            .await
        }
        pub(crate) async fn $follow(
            State(state): State<CrmState>,
            Path(id): Path<String>,
            headers: HeaderMap,
            body: Bytes,
        ) -> Response {
            forward(&state, $entity, &id, "follow", Method::POST, headers, body).await
        }
        pub(crate) async fn $unfollow(
            State(state): State<CrmState>,
            Path(id): Path<String>,
            headers: HeaderMap,
            body: Bytes,
        ) -> Response {
            forward(
                &state,
                $entity,
                &id,
                "follow",
                Method::DELETE,
                headers,
                body,
            )
            .await
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
