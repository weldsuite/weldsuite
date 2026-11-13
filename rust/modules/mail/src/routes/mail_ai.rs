//! `/api/mail-ai` (`routes/mail-ai/index.ts`): WeldMail's AI writing and
//! triage surface on `weldsuite-ai` (feature `mail`, ADR AI-012). Every
//! handler answers mail-api's `{ success, data }` shape, plus
//! `meta: { ai: { provider, model, region } }` for the platform's provider
//! badge when a model answered:
//!
//! - `POST /draft` → `{ subject, body }`
//! - `POST /improve-text` → `{ text }`
//! - `POST /auto-draft` → `{ subject, body }` (also as `draft`)
//! - `POST /reply` → `{ body }` (also at the top level)
//! - `POST /smart-replies` → `{ replies }`
//! - `POST /inbox-summary` → `{ summary }`
//! - `POST /label` → the classification, persisted (`email:updated`)
//! - `POST /label/batch` → `{ results }`, persisted
//!
//! The service is [`crate::ai`]; errors map as `handleError` does: 402
//! `insufficient_credits`, the service's own codes lowercased (`forbidden`,
//! `message_not_found`, `account_not_found`, `ai_request_failed`), 503
//! `ai_unavailable` without a model, 500 `internal_error`. A `modelId` the
//! workspace policy refuses is 422 `AI_MODEL_NOT_ALLOWED`, which Global
//! doesn't check.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_ai::AiError;
use weldsuite_catalogs::entity_events::EMAIL_UPDATED;
use weldsuite_catalogs::permission_keys::{MESSAGES_CREATE, MESSAGES_READ, MESSAGES_UPDATE};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::ai::{
    self, AutoDraftInput, Classification, DraftInput, ImproveTextInput, MailAi, MailAiError,
    ReplyInput,
};
use crate::util::validate;
use crate::{Caller, MailState};

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let create = || gate.require([MESSAGES_CREATE]);
    let update = || gate.require([MESSAGES_UPDATE]);
    Router::new()
        .route("/mail-ai/draft", post(draft).route_layer(create()))
        .route(
            "/mail-ai/improve-text",
            post(improve_text).route_layer(update()),
        )
        .route(
            "/mail-ai/auto-draft",
            post(auto_draft).route_layer(create()),
        )
        .route("/mail-ai/reply", post(reply).route_layer(create()))
        .route(
            "/mail-ai/smart-replies",
            post(smart_replies).route_layer(create()),
        )
        .route(
            "/mail-ai/inbox-summary",
            post(inbox_summary).route_layer(gate.require([MESSAGES_READ])),
        )
        .route("/mail-ai/label", post(label).route_layer(update()))
        .route(
            "/mail-ai/label/batch",
            post(label_batch).route_layer(update()),
        )
        .with_state(state)
}

/// The request's service view.
fn context(caller: &Caller, state: &MailState) -> MailAi {
    MailAi {
        db: caller.db.clone(),
        user_id: caller.user_id.clone(),
        workspace_id: caller.workspace_id.clone(),
        master: caller.bindings.master(state),
        ai: caller.bindings.ai(state),
    }
}

/// `{ success: true, ...fields }`, with `meta.ai` when a model answered.
fn success(fields: Value, served: Option<Value>) -> Response {
    let mut body = Map::new();
    body.insert("success".to_owned(), Value::Bool(true));
    if let Value::Object(fields) = fields {
        body.extend(fields);
    }
    if let Some(served) = served {
        body.insert("meta".to_owned(), json!({ "ai": served }));
    }
    Json(Value::Object(body)).into_response()
}

/// `{ success: false, error: { code, message, details? } }`.
fn failure(status: StatusCode, code: &str, message: &str, details: Option<Value>) -> Response {
    let mut error = json!({ "code": code, "message": message });
    if let Some(details) = details {
        error["details"] = details;
    }
    (status, Json(json!({ "success": false, "error": error }))).into_response()
}

/// `handleError(c, err)`.
pub(crate) fn handle_error(error: MailAiError) -> Response {
    match error {
        MailAiError::Forbidden(message) => {
            failure(StatusCode::FORBIDDEN, "forbidden", message, None)
        }
        MailAiError::MessageNotFound(message) => {
            failure(StatusCode::NOT_FOUND, "message_not_found", message, None)
        }
        MailAiError::AccountNotFound => failure(
            StatusCode::NOT_FOUND,
            "account_not_found",
            "Mail account not found",
            None,
        ),
        MailAiError::Ai(error) => ai_error(error),
        MailAiError::Internal(message) => {
            tracing::error!(%message, "[mail-ai] unexpected error");
            internal()
        }
    }
}

fn internal() -> Response {
    failure(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal_error",
        "AI request failed",
        None,
    )
}

/// The AI layer's errors in the route's shape: `InsufficientAiCreditsError`
/// and `MailAiError('AI_NOT_CONFIGURED' | 'AI_REQUEST_FAILED')`.
fn ai_error(error: AiError) -> Response {
    match error {
        AiError::Unavailable => failure(
            StatusCode::SERVICE_UNAVAILABLE,
            "ai_unavailable",
            "AI is currently unavailable",
            None,
        ),
        AiError::ModelNotAllowed { model } => failure(
            StatusCode::UNPROCESSABLE_ENTITY,
            "AI_MODEL_NOT_ALLOWED",
            &format!("The model {model} is not allowed in this workspace"),
            Some(json!({ "model": model })),
        ),
        AiError::InsufficientCredits { balance, required } => failure(
            StatusCode::PAYMENT_REQUIRED,
            "insufficient_credits",
            "Insufficient credits. Top up your workspace balance to continue.",
            Some(json!({
                "currentBalance": balance,
                "required": required,
                "shortfall": (required - balance).max(0),
            })),
        ),
        AiError::Provider { message, .. } | AiError::Invalid(message) => {
            tracing::warn!(%message, "[mail-ai] the model call failed");
            failure(StatusCode::BAD_GATEWAY, "ai_request_failed", &message, None)
        }
        AiError::Database(error) => {
            tracing::error!(%error, "[mail-ai] unexpected error");
            internal()
        }
    }
}

/// A `string().nullish()` field.
fn nullish(
    issues: &mut weldsuite_kit::validation::Issues,
    body: &Map<String, Value>,
    key: &str,
) -> Option<String> {
    issues
        .text(body, key, Presence::Nullish, None, None)
        .into_option()
}

/// `POST /draft` (`draftBody`).
async fn draft(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| DraftInput {
        prompt: issues
            .text(body, "prompt", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        reply_to_message_id: nullish(issues, body, "replyToMessageId"),
        account_id: nullish(issues, body, "accountId"),
        tone: issues
            .choice(
                body,
                "tone",
                Presence::Optional,
                &["professional", "friendly", "casual"],
            )
            .into_option(),
        length: issues
            .choice(
                body,
                "length",
                Presence::Optional,
                &["short", "medium", "long"],
            )
            .into_option(),
        model_id: nullish(issues, body, "modelId"),
    });
    let input = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    match ai::draft_email(&context(&caller, &state), &input).await {
        Ok(answer) => success(json!({ "data": answer.data }), answer.served),
        Err(error) => handle_error(error),
    }
}

/// `POST /improve-text` (`improveBody`).
async fn improve_text(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| ImproveTextInput {
        text: issues
            .text(body, "text", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        action: issues
            .choice(
                body,
                "action",
                Presence::Required,
                &["improve", "shorten", "expand", "formalize", "make_friendly"],
            )
            .into_option()
            .unwrap_or_default(),
        account_id: nullish(issues, body, "accountId"),
        model_id: nullish(issues, body, "modelId"),
    });
    let input = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    match ai::improve_text(&context(&caller, &state), &input).await {
        Ok(answer) => success(json!({ "data": answer.data }), answer.served),
        Err(error) => handle_error(error),
    }
}

/// `POST /auto-draft` (`autoDraftBody`): `{ success, draft, data }`, as the
/// message detail reads `result.draft`.
async fn auto_draft(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| AutoDraftInput {
        account_id: issues
            .text(body, "accountId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default(),
        message_id: nullish(issues, body, "messageId"),
        prompt: issues
            .text(body, "prompt", Presence::Optional, None, None)
            .into_option(),
        recent_message_ids: issues
            .list(
                body,
                "recentMessageIds",
                Presence::Optional,
                None,
                Some(20),
                |issues, item| issues.item_text(item, Text::default()),
            )
            .into_option(),
        model_id: nullish(issues, body, "modelId"),
    });
    let input = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    match ai::auto_draft(&context(&caller, &state), &input).await {
        Ok(answer) => success(
            json!({ "draft": answer.data, "data": answer.data }),
            answer.served,
        ),
        Err(error) => handle_error(error),
    }
}

/// `POST /reply` (`replyBody`): the body at the top level too, as the
/// compose panel reads `result.body`.
async fn reply(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| ReplyInput {
        message_id: nullish(issues, body, "messageId"),
        user_prompt: issues
            .text(body, "userPrompt", Presence::Optional, None, None)
            .into_option(),
        account_id: nullish(issues, body, "accountId"),
        tone: issues
            .choice(
                body,
                "tone",
                Presence::Optional,
                &["professional", "friendly", "brief"],
            )
            .into_option(),
        model_id: nullish(issues, body, "modelId"),
    });
    let input = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    match ai::reply_suggestion(&context(&caller, &state), &input).await {
        Ok(answer) => success(
            json!({ "body": answer.data["body"], "data": answer.data }),
            answer.served,
        ),
        Err(error) => handle_error(error),
    }
}

/// `POST /smart-replies` (`smartRepliesBody`).
async fn smart_replies(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let message = issues
            .text(body, "messageId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default();
        (message, nullish(issues, body, "modelId"))
    });
    let (message_id, model_id) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    match ai::smart_replies(&context(&caller, &state), &message_id, model_id.as_deref()).await {
        Ok(answer) => success(json!({ "data": answer.data }), answer.served),
        Err(error) => handle_error(error),
    }
}

/// `POST /inbox-summary` (`inboxSummaryBody`, other keys passed through).
async fn inbox_summary(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        (
            nullish(issues, body, "accountId"),
            nullish(issues, body, "modelId"),
        )
    });
    let (account_id, model_id) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let cx = context(&caller, &state);
    match ai::inbox_summary(&cx, account_id.as_deref(), model_id.as_deref()).await {
        Ok(answer) => success(json!({ "data": answer.data }), answer.served),
        Err(error) => handle_error(error),
    }
}

/// `publishClassified`: `email:updated` with ids only, as the other label
/// updates (the event is workspace-wide; a private mailbox's subject must
/// not ride on it).
fn publish_classified(caller: &Caller, state: &MailState, result: &Classification) {
    caller.publish(
        state,
        EMAIL_UPDATED,
        &result.message_id,
        &json!({
            "id": result.message_id,
            "accountId": result.account_id,
            "subject": null,
            "from": null,
            "to": null,
        }),
    );
}

/// `POST /label` (`classifyBody`).
async fn label(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let message = issues
            .text(body, "messageId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default();
        (message, nullish(issues, body, "modelId"))
    });
    let (message_id, model_id) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    match ai::classify_message(&context(&caller, &state), &message_id, model_id.as_deref()).await {
        Ok((result, served)) => {
            publish_classified(&caller, &state, &result);
            success(json!({ "data": result.to_json() }), served)
        }
        Err(error) => handle_error(error),
    }
}

/// `POST /label/batch` (`classifyBatchBody`).
async fn label_batch(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let ids = issues
            .list(
                body,
                "messageIds",
                Presence::Required,
                Some(1),
                Some(50),
                |issues, item| issues.item_text(item, Text::default()),
            )
            .into_option()
            .unwrap_or_default();
        (ids, nullish(issues, body, "modelId"))
    });
    let (message_ids, model_id) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    match ai::classify_batch(&context(&caller, &state), &message_ids, model_id.as_deref()).await {
        Ok((results, served)) => {
            for result in &results {
                publish_classified(&caller, &state, result);
            }
            let results: Vec<Value> = results.iter().map(Classification::to_json).collect();
            success(json!({ "data": { "results": results } }), served)
        }
        Err(error) => handle_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn read(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn errors_answer_as_handle_error_does() {
        let cases = [
            (
                MailAiError::Forbidden(ai::NO_ACCESS),
                StatusCode::FORBIDDEN,
                json!({ "code": "forbidden", "message": ai::NO_ACCESS }),
            ),
            (
                MailAiError::MessageNotFound("Message not found"),
                StatusCode::NOT_FOUND,
                json!({ "code": "message_not_found", "message": "Message not found" }),
            ),
            (
                MailAiError::AccountNotFound,
                StatusCode::NOT_FOUND,
                json!({ "code": "account_not_found", "message": "Mail account not found" }),
            ),
            (
                MailAiError::Ai(AiError::Unavailable),
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "code": "ai_unavailable", "message": "AI is currently unavailable" }),
            ),
            (
                MailAiError::Ai(AiError::InsufficientCredits {
                    balance: 0,
                    required: 1,
                }),
                StatusCode::PAYMENT_REQUIRED,
                json!({
                    "code": "insufficient_credits",
                    "message": "Insufficient credits. Top up your workspace balance to continue.",
                    "details": { "currentBalance": 0, "required": 1, "shortfall": 1 },
                }),
            ),
            (
                MailAiError::Ai(AiError::ModelNotAllowed {
                    model: "openai/gpt-5".to_owned(),
                }),
                StatusCode::UNPROCESSABLE_ENTITY,
                json!({
                    "code": "AI_MODEL_NOT_ALLOWED",
                    "message": "The model openai/gpt-5 is not allowed in this workspace",
                    "details": { "model": "openai/gpt-5" },
                }),
            ),
            (
                MailAiError::Ai(AiError::Provider {
                    provider: weldsuite_ai::ProviderId::Mistral,
                    status: Some(500),
                    message: "boom".to_owned(),
                }),
                StatusCode::BAD_GATEWAY,
                json!({ "code": "ai_request_failed", "message": "boom" }),
            ),
            (
                MailAiError::Internal("db".to_owned()),
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "code": "internal_error", "message": "AI request failed" }),
            ),
        ];
        for (error, status, expected) in cases {
            let (got, body) = read(handle_error(error)).await;
            assert_eq!(got, status);
            assert_eq!(body, json!({ "success": false, "error": expected }));
        }
    }

    #[tokio::test]
    async fn answers_carry_the_provider_label() {
        let (status, body) = read(success(
            json!({ "data": { "text": "hi" } }),
            Some(json!({ "provider": "mistral", "model": "mistral/m", "region": "eu" })),
        ))
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "success": true,
                "data": { "text": "hi" },
                "meta": { "ai": { "provider": "mistral", "model": "mistral/m", "region": "eu" } },
            })
        );
        let (_, plain) = read(success(json!({ "data": { "summary": "none" } }), None)).await;
        assert_eq!(
            plain,
            json!({ "success": true, "data": { "summary": "none" } })
        );
    }
}
