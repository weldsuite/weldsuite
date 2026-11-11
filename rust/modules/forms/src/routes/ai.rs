//! The AI routes (`routes/ai/index.ts`): a draft form from a description,
//! more questions for a draft, and the summary of a form's open answers. On
//! Global they run on `@weldsuite/ai`; the Kubernetes editions have no AI
//! provider (ADR AI-011), so every one answers 503 `ai_unavailable` behind the
//! permission the worker asks for, as the worker does without a gateway.
//! Excluded from the conformance suite for that reason (`ai.test.ts` runs on
//! TypeScript).
//!
//! ```text
//! POST /ai/generate               forms:create
//! POST /ai/suggest-blocks         forms:update
//! GET  /forms/:id/ai/summary      form_responses:read
//! POST /forms/:id/ai/summary      form_responses:read
//! ```

use std::sync::Arc;

use axum::Router;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::StatusCode;
use weldsuite_catalogs::permission_keys::{FORM_RESPONSES_READ, FORMS_CREATE, FORMS_UPDATE};
use weldsuite_kit::ApiError;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::FormsState;

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<FormsState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/ai/generate",
            post(unavailable).route_layer(need(FORMS_CREATE)),
        )
        .route(
            "/ai/suggest-blocks",
            post(unavailable).route_layer(need(FORMS_UPDATE)),
        )
        .route(
            "/forms/{id}/ai/summary",
            get(unavailable)
                .post(unavailable)
                .route_layer(need(FORM_RESPONSES_READ)),
        )
}

/// `aiUnavailable()`: `FormsError(503, 'ai_unavailable', 'AI is currently unavailable')`.
async fn unavailable() -> Response {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "ai_unavailable",
        "AI is currently unavailable",
    )
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ai_is_unavailable() {
        let response = unavailable().await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("the body reads");
        let json: serde_json::Value = serde_json::from_slice(&body).expect("the body is JSON");
        assert_eq!(json["error"]["code"], "ai_unavailable");
        assert_eq!(json["error"]["message"], "AI is currently unavailable");
    }
}
