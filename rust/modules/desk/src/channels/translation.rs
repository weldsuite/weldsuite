//! `routes/desk-conversations/translation.ts`: inbox AI translation at
//! `/api/desk/conversations/:id/translate` and `/translate-reply`. On Global
//! it runs on `@weldsuite/ai`; the Kubernetes editions have no AI provider
//! (ADR AI-011), so both answer 503 `ai_unavailable` behind the same
//! `conversations:update` the worker asks for, and `/config.json` lists
//! `desk-ai` as unavailable so the platform hides the feature. Excluded from
//! the conformance suite for that reason.
//!
//! Sending a translated reply goes through the reply route, which Rust
//! serves in full, `translation` metadata included (`inbox.rs`).

use std::sync::Arc;

use axum::Router;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::StatusCode;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::DeskState;

/// `deskReplyTranslationSchema` (the reply route's optional `translation`),
/// in its key order: the agent's own words and the two languages.
pub(super) fn read(issues: &mut Issues, fields: &Map<String, Value>) -> Map<String, Value> {
    let original = issues.text(
        fields,
        "original",
        Presence::Required,
        Some(1),
        Some(20_000),
    );
    let source = issues.text(
        fields,
        "sourceLocale",
        Presence::Required,
        Some(2),
        Some(10),
    );
    let target = issues.text(
        fields,
        "targetLocale",
        Presence::Required,
        Some(2),
        Some(10),
    );
    let mut out = Map::new();
    out.insert("original".to_owned(), json!(original.into_option()));
    out.insert("sourceLocale".to_owned(), json!(source.into_option()));
    out.insert("targetLocale".to_owned(), json!(target.into_option()));
    out
}

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let update = || gate.require([perm::CONVERSATIONS_UPDATE.to_owned()]);
    Router::new()
        .route("/{id}/translate", post(unavailable).route_layer(update()))
        .route(
            "/{id}/translate-reply",
            post(unavailable).route_layer(update()),
        )
}

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
    async fn translation_is_unavailable() {
        let response = unavailable().await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("the body reads");
        let json: Value = serde_json::from_slice(&body).expect("the body is JSON");
        assert_eq!(json["error"]["code"], "ai_unavailable");
    }
}
