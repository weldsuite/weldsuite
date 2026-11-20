//! The AI routes (`routes/ai/index.ts`): a draft form from a description,
//! more questions for a draft, and the summary of a form's open answers, on
//! `weldsuite_ai` (feature `forms`, [`crate::ai`]). Every route answers 503
//! `ai_unavailable` without an AI provider (the GET too, as the worker's
//! `guarded` checks first), 402 `INSUFFICIENT_CREDITS` when the wallet is
//! empty, and 502 `AI_REQUEST_FAILED` when the model fails. Answers from a
//! model carry `meta.ai`.
//!
//! ```text
//! POST /ai/generate               forms:create
//! POST /ai/suggest-blocks         forms:update
//! GET  /forms/:id/ai/summary      form_responses:read
//! POST /forms/:id/ai/summary      form_responses:read
//! ```

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use weldsuite_catalogs::permission_keys::{FORM_RESPONSES_READ, FORMS_CREATE, FORMS_UPDATE};
use weldsuite_kit::Data;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::{Member, load_form};
use crate::FormsState;
use crate::access::Need;
use crate::ai::{self, AiContext, Ask, GenerateInput};
use crate::common::{FormsResult, answer};
use crate::input;

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<FormsState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/ai/generate",
            post(generate).route_layer(need(FORMS_CREATE)),
        )
        .route(
            "/ai/suggest-blocks",
            post(suggest_blocks).route_layer(need(FORMS_UPDATE)),
        )
        .route(
            "/forms/{id}/ai/summary",
            get(summary)
                .post(create_summary)
                .route_layer(need(FORM_RESPONSES_READ)),
        )
}

impl Member {
    /// Who asks, for the AI calls.
    fn ai_context(&self) -> AiContext {
        AiContext {
            workspace_id: self.ctx.workspace_id.clone(),
            user_id: self.user_id.clone(),
            tenant: Some(self.ctx.db.clone()),
            master: self.ctx.master.clone(),
        }
    }

    /// `guarded`'s `assertAiAvailable`: the AI, or 503 `ai_unavailable`.
    fn ai(&self) -> FormsResult<weldsuite_ai::Ai> {
        self.ctx.svc.ai.clone().ok_or_else(ai::unavailable)
    }
}

async fn generate(member: Member, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let (prompt, layout, language) = input::json(&headers, &body, input::generate_form)?;
            let ai = member.ai()?;
            let ask = Ask::new(Some(ai), member.ai_context()).await?;
            let input = GenerateInput {
                prompt,
                layout,
                language,
            };
            let (result, served) = ai::generate_form(&ask, &input).await?;
            Ok(axum::Json(ai::answered(result, &served)).into_response())
        }
        .await,
    )
}

async fn suggest_blocks(member: Member, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let (prompt, definition) = input::json(&headers, &body, input::suggest_blocks)?;
            let ai = member.ai()?;
            let ask = Ask::new(Some(ai), member.ai_context()).await?;
            let (result, served) = ai::suggest_blocks(&ask, &prompt, &definition).await?;
            Ok(axum::Json(ai::answered(result, &served)).into_response())
        }
        .await,
    )
}

async fn summary(member: Member, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    answer(
        async {
            let block_id = input::query(query.as_deref(), input::ai_summary_query)?;
            member.ai()?;
            let loaded = load_form(&member, &id, Some(Need::ReadResponses)).await?;
            let summary =
                ai::get_summary(&member.ctx, ai::form_id(&loaded.form), block_id.as_deref())
                    .await?;
            Ok(Data(summary).into_response())
        }
        .await,
    )
}

async fn create_summary(
    member: Member,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let block_id = input::json(&headers, &body, input::create_ai_summary)?;
            let ai = member.ai()?;
            let loaded = load_form(&member, &id, Some(Need::ReadResponses)).await?;
            let context = member.ai_context();
            let (summary, served) = ai::create_summary(
                &member.ctx,
                ai::form_id(&loaded.form),
                block_id.as_deref(),
                &member.user_id,
                async move || Ask::new(Some(ai), context).await,
            )
            .await?;
            Ok(axum::Json(ai::answered(summary, &served)).into_response())
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use axum::response::IntoResponse;
    use http::StatusCode;

    #[tokio::test]
    async fn ai_is_unavailable_without_a_provider() {
        let response = crate::ai::unavailable().respond().into_response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("the body reads");
        let json: serde_json::Value = serde_json::from_slice(&body).expect("the body is JSON");
        assert_eq!(json["error"]["code"], "ai_unavailable");
        assert_eq!(json["error"]["message"], "AI is currently unavailable");
    }
}
