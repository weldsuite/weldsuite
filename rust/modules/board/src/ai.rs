//! The model call of WeldBoard's AI actions (`services/ai.ts`'s
//! `runBoardAi`), on `weldsuite_ai` (feature `board`). What each action asks
//! (the task, the JSON schema, the prompts) and how its answer becomes ops
//! come from the board engine (`aiPrepare` and `aiPlan`,
//! `services/ai-plan.ts`), so Rust never parses a board; this asks the model
//! in between: `recommended.<task>.quality` for the task the engine names,
//! charged as `board_<action>`.

use axum::response::{IntoResponse, Response};
use http::StatusCode;
use serde_json::{Value, json};
use weldsuite_ai::{Ai, AiCall, AiError, ChatRequest, Feature, Served, Task, Tier};
use weldsuite_db::PgPool;

/// The task the engine named (`draft`, `classify`, `summarize`).
pub(crate) fn task_of(name: &str) -> Task {
    match name {
        "classify" => Task::Classify,
        "summarize" => Task::Summarize,
        _ => Task::Draft,
    }
}

/// The call of one action.
pub(crate) fn call_for(
    workspace_id: &str,
    user_id: &str,
    tenant: PgPool,
    master: Option<PgPool>,
    action: &str,
    task: Task,
) -> AiCall {
    AiCall::new(workspace_id, Feature::Board, task, Tier::Quality)
        .user(user_id)
        .tenant(tenant)
        .master(master)
        .op(format!("board_{action}"))
}

/// One structured answer for the engine's `ask` (`{ schemaName, schema,
/// system, user }`): the parsed object and who answered.
pub(crate) async fn ask_model(
    ai: &Ai,
    call: &AiCall,
    ask: &Value,
) -> Result<(Value, Served), AiError> {
    let text = |key: &str| ask[key].as_str().unwrap_or_default().to_owned();
    let request = ChatRequest::system_user(text("system"), text("user"))
        .schema(text("schemaName"), ask["schema"].clone());
    let response = ai.chat(call, request).await?;
    Ok((response.object.unwrap_or(Value::Null), response.served))
}

/// `c.json({ error: { code, message } }, status)` (`BoardAiError`).
pub(crate) fn ai_error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        axum::Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// An engine refusal (`{ code, message, status }`) as the route answers it.
pub(crate) fn refusal(refused: &Value) -> Response {
    let status = refused["status"]
        .as_u64()
        .and_then(|status| u16::try_from(status).ok())
        .and_then(|status| StatusCode::from_u16(status).ok())
        .unwrap_or(StatusCode::BAD_REQUEST);
    ai_error(
        status,
        refused["code"].as_str().unwrap_or_default(),
        refused["message"].as_str().unwrap_or_default(),
    )
}

/// The model failed (`AI_REQUEST_FAILED`, 502).
pub(crate) fn request_failed(error: &AiError) -> Response {
    tracing::error!(%error, "[board-api/ai] the model call failed");
    ai_error(
        StatusCode::BAD_GATEWAY,
        "AI_REQUEST_FAILED",
        "The AI request failed",
    )
}

/// Without AI: as the worker answers without its gateway.
pub(crate) fn not_configured() -> Response {
    ai_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "AI_NOT_CONFIGURED",
        "AI is not available in this edition of WeldSuite.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_ai::{AiConfig, FakeProvider};

    fn ai(fake: FakeProvider) -> Ai {
        let mut problems = Vec::new();
        let config = AiConfig::from_lookup(
            &|name| match name {
                "AI_DEFAULT_PROVIDER" => Some("mistral".to_owned()),
                "MISTRAL_API_KEY" => Some("mistral-key".to_owned()),
                _ => None,
            },
            &mut problems,
        );
        Ai::fake(config, fake)
    }

    #[tokio::test]
    async fn the_engines_ask_goes_to_the_model_as_given() {
        let fake = FakeProvider::new().reply_json(&json!({ "ideas": ["Loyalty points"] }));
        let ai = ai(fake.clone());
        let call =
            AiCall::new("ws_1", Feature::Board, task_of("draft"), Tier::Quality).op("board_ideas");
        let ask = json!({
            "task": "draft",
            "schemaName": "ideas",
            "schema": { "type": "object", "properties": { "ideas": { "type": "array" } }, "required": ["ideas"] },
            "system": "You suggest more ideas for a whiteboard.",
            "user": "<notes>\n- Lower prices\n</notes>",
        });
        let (answer, served) = ask_model(&ai, &call, &ask)
            .await
            .expect("the model answers");
        assert_eq!(answer, json!({ "ideas": ["Loyalty points"] }));
        assert_eq!(served.meta()["provider"], "mistral");
        let body = &fake.calls()[0].body;
        assert_eq!(
            body["messages"][0]["content"],
            "You suggest more ideas for a whiteboard."
        );
        assert_eq!(
            body["messages"][1]["content"],
            "<notes>\n- Lower prices\n</notes>"
        );
        assert_eq!(body["response_format"]["json_schema"]["name"], "ideas");
    }

    #[test]
    fn tasks_and_refusals_read_as_the_engine_gives_them() {
        assert_eq!(task_of("classify"), Task::Classify);
        assert_eq!(task_of("summarize"), Task::Summarize);
        assert_eq!(task_of("draft"), Task::Draft);
        let response = refusal(&json!({
            "code": "NOTHING_TO_DO",
            "message": "Select at least two notes to group",
            "status": 400,
        }));
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(not_configured().status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
