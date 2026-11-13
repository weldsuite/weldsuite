//! The assistant chat on the Kubernetes editions (ADR AI-012, phase 3e):
//! agent-api's `/api/ai/generate`, `/api/ai/chat` and `/api/ai/chat/stream`
//! (`apps/workers/agent-api/src/routes/ai/index.ts`).
//!
//! Without an `agentId` the chat is the default WeldAgent ([`persona`]): the
//! person's own permissions decide which read tools it gets, and the model is
//! `weldsuite-ai` with [`Feature::Assistant`] and [`Task::Copilot`]. A `model`
//! in the body is the caller's choice (422 `AI_MODEL_NOT_ALLOWED` when the
//! workspace policy refuses it). With an `agentId` the turn is a workspace
//! agent's, handed to the loop through [`agent`].
//!
//! Request and answer shapes are the worker's. `/chat/stream` is not SSE: it
//! is the plain text stream (`text/plain`) the worker answers with, the text
//! of each lookup step set apart by a blank line. A `meta.ai` object (the
//! provider that answered) is added to the JSON answers.

mod agent;
mod persona;
mod tags;

use std::convert::Infallible;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{FromRequestParts, State};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::post;
use http::StatusCode;
use http::header::CONTENT_TYPE;
use http::request::Parts;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use weldsuite_ai::{Ai, AiCall, ChatRequest, Feature, Message, Task, Tier};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Field, Number, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::access::{AgentAccess, can_access_agent};
use crate::agents::get_agent;
use crate::run::unavailable;
use crate::tools::EventSink;
use crate::{AgentState, Caller, failed, validate};

pub use agent::{AgentChat, chat_once, chat_stream};

const CONTEXT: &str = "ai";

/// The `/api/ai` routes, to merge under `/api` (see [`crate::router`]).
pub(crate) fn router<S, Q>(state: AgentState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    use weldsuite_catalogs::permission_keys::{AGENTS_CREATE, AGENTS_READ, WELDAGENT_USE};
    Router::new()
        .route(
            "/ai/generate",
            post(generate).route_layer(gate.require([AGENTS_CREATE])),
        )
        .route(
            "/ai/chat",
            post(chat).route_layer(gate.require([AGENTS_READ, WELDAGENT_USE])),
        )
        .route(
            "/ai/chat/stream",
            post(chat_stream_route).route_layer(gate.require([AGENTS_READ, WELDAGENT_USE])),
        )
        .with_state(state)
}

/// The request's own `Ai` (conformance builds carry the test's model), else
/// the install's.
struct RequestAi(Option<Ai>);

impl<S: Send + Sync> FromRequestParts<S> for RequestAi {
    type Rejection = Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(Ok(Self(parts.extensions.get::<Ai>().cloned())))
    }
}

impl RequestAi {
    /// The AI to call; `None` when it is off.
    fn resolve(self, state: &AgentState) -> Option<Ai> {
        self.0
            .or_else(|| state.ai.clone())
            .filter(weldsuite_ai::Ai::enabled)
    }
}

// ── bodies ──────────────────────────────────────────────────────────────────

const TEMPERATURE: Number = Number {
    coerce: false,
    int: false,
    min: Some(0.0),
    max: Some(2.0),
};

struct GenerateInput {
    prompt: String,
    model: Option<String>,
    system: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<i64>,
}

fn max_tokens_of(
    issues: &mut weldsuite_kit::validation::Issues,
    fields: &serde_json::Map<String, Value>,
) -> Option<i64> {
    issues
        .whole_number(
            fields,
            "maxTokens",
            Presence::Optional,
            Number {
                min: Some(1.0),
                max: Some(8192.0),
                ..Number::default()
            },
        )
        .into_option()
}

/// `generateSchema`.
fn read_generate(
    issues: &mut weldsuite_kit::validation::Issues,
    fields: &serde_json::Map<String, Value>,
) -> GenerateInput {
    GenerateInput {
        prompt: issues
            .text(fields, "prompt", Presence::Required, Some(1), Some(20000))
            .into_option()
            .unwrap_or_default(),
        model: issues
            .text(fields, "model", Presence::Optional, Some(1), Some(200))
            .into_option(),
        system: issues
            .text(fields, "system", Presence::Optional, None, Some(8000))
            .into_option(),
        temperature: issues
            .number(fields, "temperature", Presence::Optional, TEMPERATURE)
            .into_option(),
        max_tokens: max_tokens_of(issues, fields),
    }
}

struct ChatInput {
    /// `(role, content)`; the role is `user`, `assistant` or `system`.
    messages: Vec<(String, String)>,
    model: Option<String>,
    system: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<i64>,
    agent_id: Option<String>,
}

/// `chatSchema`. `context` (the open sheet) is validated and left unused:
/// the spreadsheet tools are not in the EU tool registry.
fn read_chat(
    issues: &mut weldsuite_kit::validation::Issues,
    fields: &serde_json::Map<String, Value>,
) -> ChatInput {
    let messages = issues
        .list(
            fields,
            "messages",
            Presence::Required,
            Some(1),
            Some(50),
            |issues, item| {
                let message = issues.object(item)?;
                let role = issues
                    .choice(
                        message,
                        "role",
                        Presence::Required,
                        &["user", "assistant", "system"],
                    )
                    .into_option();
                let content = issues
                    .text(message, "content", Presence::Required, Some(1), Some(20000))
                    .into_option();
                Some((role?, content?))
            },
        )
        .into_option()
        .unwrap_or_default();
    let input = ChatInput {
        messages,
        model: issues
            .text(fields, "model", Presence::Optional, Some(1), Some(200))
            .into_option(),
        system: issues
            .text(fields, "system", Presence::Optional, None, Some(8000))
            .into_option(),
        temperature: issues
            .number(fields, "temperature", Presence::Optional, TEMPERATURE)
            .into_option(),
        max_tokens: max_tokens_of(issues, fields),
        agent_id: issues
            .text(fields, "agentId", Presence::Optional, Some(1), Some(30))
            .into_option(),
    };
    let _: Field<()> = issues.nested(fields, "context", Presence::Optional, |issues, context| {
        let _: Field<()> = issues.nested(context, "sheet", Presence::Optional, |issues, sheet| {
            let _ = issues.text(sheet, "id", Presence::Required, Some(1), Some(64));
            for (key, max) in [("name", 255), ("tab", 200), ("selection", 200)] {
                let _ = issues.text(sheet, key, Presence::Optional, None, Some(max));
            }
        });
    });
    input
}

/// `splitChatMessages`: the `system` turns (plus the `system` field) become
/// one system string; the user and assistant turns stay, the user's record
/// tags spelled out.
fn split_messages(input: &ChatInput) -> (Option<String>, Vec<(String, String)>) {
    let extra = input
        .messages
        .iter()
        .filter(|(role, _)| role == "system")
        .map(|(_, content)| content.as_str())
        .chain(input.system.as_deref())
        .collect::<Vec<_>>()
        .join("\n\n");
    let turns = input
        .messages
        .iter()
        .filter(|(role, _)| role != "system")
        .map(|(role, content)| {
            let content = if role == "user" {
                tags::describe_record_tokens(content)
            } else {
                content.clone()
            };
            (role.clone(), content)
        })
        .collect();
    ((!extra.is_empty()).then_some(extra), turns)
}

fn chat_messages(turns: &[(String, String)]) -> Vec<Message> {
    turns
        .iter()
        .map(|(role, content)| {
            if role == "assistant" {
                Message::assistant(content.clone())
            } else {
                Message::user(content.clone())
            }
        })
        .collect()
}

// ── shared steps ────────────────────────────────────────────────────────────

/// The AI call of one request: who asks, the caller's `model`, and the
/// ledger's `op`.
fn call_for(caller: &Caller, state: &AgentState, op: &str, model: Option<&str>) -> AiCall {
    AiCall::new(
        caller.workspace_id.clone(),
        Feature::Assistant,
        Task::Copilot,
        Tier::Free,
    )
    .user(caller.user_id.clone())
    .tenant(caller.db.clone())
    .master(state.master.clone())
    .requested_model(model)
    .op(op)
}

/// The hard credit gate, and with it the policy's refusals (422, 503).
async fn gate(ai: &Ai, call: &AiCall) -> Result<(), Response> {
    ai.assert_credits(call)
        .await
        .map_err(|error| error.into_api_error().into_response())
}

fn answer(data: &Value, meta: Option<Value>) -> Response {
    let mut body = json!({ "data": data });
    if let (Some(meta), Some(map)) = (meta, body.as_object_mut()) {
        map.insert("meta".into(), json!({ "ai": meta }));
    }
    Json(body).into_response()
}

fn usage_json(usage: weldsuite_ai::Usage) -> Value {
    json!({
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "totalTokens": usage.input_tokens + usage.output_tokens,
    })
}

#[allow(clippy::cast_possible_truncation)] // 0..=2, the schema's range
fn temperature_of(value: Option<f64>) -> Option<f32> {
    value.map(|value| value as f32)
}

fn max_tokens_u32(value: Option<i64>) -> Option<u32> {
    value.and_then(|value| u32::try_from(value).ok())
}

// ── POST /generate ──────────────────────────────────────────────────────────

/// `POST /generate`: one-shot text generation, metered against the wallet.
async fn generate(
    State(state): State<AgentState>,
    caller: Caller,
    ai: RequestAi,
    headers: http::HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_generate) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let Some(ai) = ai.resolve(&state) else {
        return unavailable();
    };
    let call = call_for(&caller, &state, "generate", input.model.as_deref());
    if let Err(response) = gate(&ai, &call).await {
        return response;
    }
    let request = ChatRequest {
        system: input.system,
        messages: vec![Message::user(input.prompt)],
        max_tokens: max_tokens_u32(input.max_tokens),
        temperature: temperature_of(input.temperature),
        ..ChatRequest::default()
    };
    match ai.chat(&call, request).await {
        Ok(reply) => answer(
            &json!({
                "text": reply.text,
                "model": reply.served.model,
                "finishReason": reply.finish_reason,
                "usage": usage_json(reply.usage),
                "creditsUsed": reply.credits,
            }),
            Some(reply.served.meta()),
        ),
        Err(error) => error.into_api_error().into_response(),
    }
}

// ── workspace agents ────────────────────────────────────────────────────────

/// `loadWorkspaceAgent`: `weldagent:use`, and an agent the caller may see.
async fn load_agent(caller: &Caller, agent_id: &str) -> Result<Value, Response> {
    if !caller
        .permissions
        .has_any(&[weldsuite_catalogs::permission_keys::WELDAGENT_USE])
    {
        return Err(ApiError::forbidden()
            .with_message("Missing permission: weldagent:use")
            .into_response());
    }
    let not_found = || ApiError::not_found("Agent not found", None).into_response();
    let agent = get_agent(&caller.db, agent_id)
        .await
        .map_err(|e| failed(&e, CONTEXT, "Failed to load the agent"))?
        .ok_or_else(not_found)?;
    let allowed = can_access_agent(
        &caller.db,
        &AgentAccess {
            id: agent["id"].as_str().unwrap_or_default(),
            owner_id: agent["ownerId"].as_str(),
            visibility: agent["visibility"].as_str().unwrap_or("workspace"),
        },
        &caller.viewer(),
    )
    .await
    .map_err(|e| failed(&e, CONTEXT, "Failed to load the agent"))?;
    if allowed { Ok(agent) } else { Err(not_found()) }
}

/// A workspace agent's turn (`chatWithWorkspaceAgent`,
/// `streamWithWorkspaceAgent`), through the loop's seam.
#[allow(clippy::too_many_arguments)] // what the two routes hand over
async fn with_agent(
    state: &AgentState,
    caller: &Caller,
    ai: Option<&Ai>,
    input: &ChatInput,
    agent_id: &str,
    extra_system: Option<String>,
    turns: Vec<(String, String)>,
    streaming: bool,
) -> Response {
    let agent = match load_agent(caller, agent_id).await {
        Ok(agent) => agent,
        Err(response) => return response,
    };
    if streaming {
        // The gate before the stream opens (a refusal is a 402, not a stream).
        let Some(ai) = ai else { return unavailable() };
        let call = AiCall::new(
            caller.workspace_id.clone(),
            Feature::Agents,
            Task::Copilot,
            Tier::Free,
        )
        .user(caller.user_id.clone())
        .tenant(caller.db.clone())
        .master(state.master.clone())
        .op("chat");
        if let Err(response) = gate(ai, &call).await {
            return response;
        }
    }
    let chat = AgentChat {
        db: caller.db.clone(),
        workspace_id: caller.workspace_id.clone(),
        actor_user_id: caller.user_id.clone(),
        agent,
        messages: turns,
        model: input.model.clone(),
        temperature: input.temperature,
        max_tokens: input.max_tokens,
        extra_system,
        actor_permissions: caller.permissions.resolved().permissions.clone(),
        env: state.run_env(),
        events: Some(EventSink {
            publisher: state.events.clone(),
            context: caller.events.clone(),
        }),
    };
    if streaming {
        return match chat_stream(ai, chat).await {
            Ok(stream) => text_stream(Body::from_stream(stream)),
            Err(error) => error.into_response_for("AI request failed"),
        };
    }
    match chat_once(ai, chat).await {
        Ok(data) => answer(&data, None),
        Err(error) => error.into_response_for("AI request failed"),
    }
}

fn text_stream(body: Body) -> Response {
    (
        StatusCode::OK,
        [(CONTENT_TYPE, "text/plain; charset=utf-8")],
        body,
    )
        .into_response()
}

// ── POST /chat ──────────────────────────────────────────────────────────────

fn no_user_message() -> Response {
    ApiError::bad_request("At least one user message is required").into_response()
}

/// `POST /chat`: a multi-turn chat. Stateless on the server: the client sends
/// the full running conversation each turn.
async fn chat(
    State(state): State<AgentState>,
    caller: Caller,
    ai: RequestAi,
    headers: http::HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_chat) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let (extra_system, turns) = split_messages(&input);
    if turns.is_empty() {
        return no_user_message();
    }
    let ai = ai.resolve(&state);
    if let Some(agent_id) = input.agent_id.as_deref() {
        return with_agent(
            &state,
            &caller,
            ai.as_ref(),
            &input,
            agent_id,
            extra_system,
            turns,
            false,
        )
        .await;
    }
    let Some(ai) = ai else { return unavailable() };
    let call = call_for(&caller, &state, "chat", input.model.as_deref());
    if let Err(response) = gate(&ai, &call).await {
        return response;
    }
    let persona = persona::build(&caller, None, extra_system.as_deref()).await;
    match persona::run(
        &ai,
        &call,
        &persona,
        chat_messages(&turns),
        temperature_of(input.temperature),
        max_tokens_u32(input.max_tokens),
    )
    .await
    {
        Ok(reply) => answer(
            &json!({
                "text": persona::reply_text(reply.text),
                "model": reply.served.model,
                "finishReason": reply.finish_reason,
                "usage": usage_json(reply.usage),
                "creditsUsed": reply.credits,
            }),
            Some(reply.served.meta()),
        ),
        Err(error) => error.into_api_error().into_response(),
    }
}

// ── POST /chat/stream ───────────────────────────────────────────────────────

/// `POST /chat/stream`: the streaming twin of `/chat`. Credits are gated
/// before the stream opens; each model request is metered when it finishes,
/// including the ones of a reply the client walked away from.
async fn chat_stream_route(
    State(state): State<AgentState>,
    caller: Caller,
    ai: RequestAi,
    headers: http::HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_chat) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let ai = ai.resolve(&state);
    let (extra_system, turns) = split_messages(&input);
    if turns.is_empty() {
        return no_user_message();
    }
    if let Some(agent_id) = input.agent_id.as_deref() {
        return with_agent(
            &state,
            &caller,
            ai.as_ref(),
            &input,
            agent_id,
            extra_system,
            turns,
            true,
        )
        .await;
    }
    let Some(ai) = ai else { return unavailable() };
    let call = call_for(&caller, &state, "chat", input.model.as_deref());
    if let Err(response) = gate(&ai, &call).await {
        return response;
    }
    let persona = persona::build(&caller, None, extra_system.as_deref()).await;
    let (out, chunks) = mpsc::channel::<String>(32);
    tokio::spawn(persona::stream(
        ai,
        call,
        persona,
        chat_messages(&turns),
        temperature_of(input.temperature),
        max_tokens_u32(input.max_tokens),
        out,
    ));
    let body = futures_util::stream::unfold(chunks, |mut chunks| async move {
        chunks
            .recv()
            .await
            .map(|text| (Ok::<_, Infallible>(Bytes::from(text)), chunks))
    });
    text_stream(Body::from_stream(body))
}

#[cfg(test)]
mod tests;
