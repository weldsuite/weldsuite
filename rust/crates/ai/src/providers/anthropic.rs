//! Anthropic's Messages API (`POST /v1/messages`, `anthropic-version:
//! 2023-06-01`): the system prompt, tools, structured output through a
//! forced tool call, image and PDF document blocks, and streaming. Claude 5.x
//! rejects non-default sampling, so the temperature is dropped for it
//! (`sampling.ts`). Anthropic's OpenAI-compatible endpoint is for testing
//! only, so it isn't used.

use serde_json::{Map, Value, json};

use super::sse::SseEvent;
use super::{
    ChatAnswer, error_message_of, parse_json_answer, rejects_sampling_params, schema_tool_name,
};
use crate::catalog::ProviderId;
use crate::error::AiError;
use crate::policy::Target;
use crate::types::{
    ChatRequest, FinishReason, Part, Role, StreamEvent, ToolCall, ToolChoice, Usage,
};

/// The API version every request names.
pub(crate) const VERSION: &str = "2023-06-01";

/// `max_tokens` is required; this when the request sets none.
const DEFAULT_MAX_TOKENS: u32 = 4096;

/// A schema whose root isn't an object is wrapped, since a tool's input must
/// be one.
const WRAPPED: &str = "result";

fn base64(data: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn block(part: &Part) -> Option<Value> {
    match part {
        Part::Text(text) if text.is_empty() => None,
        Part::Text(text) => Some(json!({ "type": "text", "text": text })),
        Part::Image { mime, data } => Some(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": mime, "data": base64(data) },
        })),
        Part::Document { mime, data, .. } => Some(json!({
            "type": "document",
            "source": { "type": "base64", "media_type": mime, "data": base64(data) },
        })),
        Part::ToolCall(call) => Some(json!({
            "type": "tool_use",
            "id": call.id,
            "name": call.name,
            "input": if call.arguments.is_object() { call.arguments.clone() } else { json!({}) },
        })),
        Part::ToolResult {
            call_id,
            content,
            is_error,
        } => Some(json!({
            "type": "tool_result",
            "tool_use_id": call_id,
            "content": content,
            "is_error": is_error,
        })),
    }
}

/// The conversation, consecutive turns of one role merged (tool results are
/// the user's turn).
fn messages(request: &ChatRequest) -> Vec<Value> {
    let mut out: Vec<(&'static str, Vec<Value>)> = Vec::new();
    for message in &request.messages {
        let role = match message.role {
            Role::Assistant => "assistant",
            Role::User | Role::Tool => "user",
        };
        let blocks: Vec<Value> = message.content.iter().filter_map(block).collect();
        if blocks.is_empty() {
            continue;
        }
        match out.last_mut() {
            Some((last, existing)) if *last == role => existing.extend(blocks),
            _ => out.push((role, blocks)),
        }
    }
    out.into_iter()
        .map(|(role, content)| json!({ "role": role, "content": content }))
        .collect()
}

/// Whether `schema` is wrapped in `{ result }` to be a tool's input.
fn needs_wrapping(schema: &Value) -> bool {
    schema.get("type").and_then(Value::as_str) != Some("object")
}

/// The `/v1/messages` body for `target`.
pub(crate) fn messages_body(target: &Target, request: &ChatRequest, stream: bool) -> Value {
    let mut body = Map::new();
    body.insert("model".to_owned(), json!(target.native_model()));
    body.insert(
        "max_tokens".to_owned(),
        json!(request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS)),
    );
    if let Some(system) = request.system.as_deref().filter(|s| !s.is_empty()) {
        body.insert("system".to_owned(), json!(system));
    }
    body.insert("messages".to_owned(), Value::Array(messages(request)));
    let mut tools: Vec<Value> = request
        .tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.parameters,
            })
        })
        .collect();
    let mut choice = (!request.tools.is_empty()).then(|| match &request.tool_choice {
        ToolChoice::Auto => json!({ "type": "auto" }),
        ToolChoice::Required => json!({ "type": "any" }),
        ToolChoice::None => json!({ "type": "none" }),
        ToolChoice::Tool(name) => json!({ "type": "tool", "name": name }),
    });
    if let Some(schema) = &request.response_schema {
        let name = schema_tool_name(&schema.name);
        let input_schema = if needs_wrapping(&schema.schema) {
            json!({ "type": "object", "properties": { WRAPPED: schema.schema }, "required": [WRAPPED] })
        } else {
            schema.schema.clone()
        };
        tools.push(json!({
            "name": name,
            "description": "Answer with the structured result.",
            "input_schema": input_schema,
        }));
        choice = Some(json!({ "type": "tool", "name": name }));
    }
    if !tools.is_empty() {
        body.insert("tools".to_owned(), Value::Array(tools));
    }
    if let Some(choice) = choice {
        body.insert("tool_choice".to_owned(), choice);
    }
    if let Some(temperature) = request.temperature
        && !rejects_sampling_params(&target.model)
    {
        body.insert(
            "temperature".to_owned(),
            json!(f64::from(temperature).clamp(0.0, 1.0)),
        );
    }
    if stream {
        body.insert("stream".to_owned(), json!(true));
    }
    Value::Object(body)
}

fn finish_reason(raw: Option<&str>, schema_only: bool) -> FinishReason {
    match raw {
        Some("end_turn" | "stop_sequence" | "pause_turn") | None => FinishReason::Stop,
        Some("max_tokens" | "model_context_window_exceeded") => FinishReason::Length,
        Some("tool_use") if schema_only => FinishReason::Stop,
        Some("tool_use") => FinishReason::ToolCalls,
        Some("refusal") => FinishReason::ContentFilter,
        Some(_) => FinishReason::Other,
    }
}

fn usage_of(usage: &Value) -> Usage {
    let field = |name: &str| usage.get(name).and_then(Value::as_i64).unwrap_or(0);
    Usage {
        input_tokens: field("input_tokens")
            + field("cache_creation_input_tokens")
            + field("cache_read_input_tokens"),
        output_tokens: field("output_tokens"),
    }
}

/// The structured answer of the forced tool call.
fn schema_object(request: &ChatRequest, input: Value) -> Value {
    match &request.response_schema {
        Some(schema) if needs_wrapping(&schema.schema) => {
            input.get(WRAPPED).cloned().unwrap_or(Value::Null)
        }
        _ => input,
    }
}

fn split_calls(request: &ChatRequest, calls: Vec<ToolCall>) -> (Vec<ToolCall>, Option<Value>) {
    let schema_name = request
        .response_schema
        .as_ref()
        .map(|schema| schema_tool_name(&schema.name));
    let mut object = None;
    let mut rest = Vec::new();
    for call in calls {
        if schema_name.as_deref() == Some(call.name.as_str()) && object.is_none() {
            object = Some(schema_object(request, call.arguments));
        } else {
            rest.push(call);
        }
    }
    (rest, object)
}

fn answer(
    provider: ProviderId,
    request: &ChatRequest,
    text: String,
    calls: Vec<ToolCall>,
    usage: Usage,
    stop: Option<&str>,
) -> Result<ChatAnswer, AiError> {
    let (tool_calls, object) = split_calls(request, calls);
    let object = match (&request.response_schema, object) {
        (Some(_), Some(object)) => Some(object),
        // The model answered in text after all: take its JSON.
        (Some(_), None) => Some(parse_json_answer(&text).map_err(|_| {
            AiError::Invalid(format!(
                "{} didn't answer with the structured result",
                provider.as_str()
            ))
        })?),
        (None, _) => None,
    };
    let schema_only = object.is_some() && tool_calls.is_empty();
    Ok(ChatAnswer {
        text,
        tool_calls,
        object,
        usage,
        finish_reason: finish_reason(stop, schema_only),
    })
}

/// A whole Messages answer.
pub(crate) fn parse_message(body: &Value, request: &ChatRequest) -> Result<ChatAnswer, AiError> {
    let mut text = String::new();
    let mut calls = Vec::new();
    for block in body
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => text.push_str(
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            ),
            Some("tool_use") => calls.push(ToolCall {
                id: block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                name: block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                arguments: block.get("input").cloned().unwrap_or_else(|| json!({})),
            }),
            _ => {}
        }
    }
    answer(
        ProviderId::Anthropic,
        request,
        text,
        calls,
        usage_of(body.get("usage").unwrap_or(&Value::Null)),
        body.get("stop_reason").and_then(Value::as_str),
    )
}

#[derive(Debug)]
enum Block {
    Text,
    Tool {
        id: String,
        name: String,
        input: String,
    },
    Other,
}

/// The block a `content_block_start` opens.
fn start_block(block: &Value) -> Block {
    let field = |name: &str| {
        block
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    match block.get("type").and_then(Value::as_str) {
        Some("text") => Block::Text,
        Some("tool_use") => Block::Tool {
            id: field("id"),
            name: field("name"),
            input: String::new(),
        },
        _ => Block::Other,
    }
}

/// Accumulates a streamed message.
#[derive(Debug)]
pub(crate) struct StreamDecoder {
    request: ChatRequest,
    schema_tool: Option<String>,
    text: String,
    blocks: Vec<(u64, Block)>,
    calls: Vec<ToolCall>,
    usage: Usage,
    stop: Option<String>,
}

impl StreamDecoder {
    pub(crate) fn new(request: &ChatRequest) -> Self {
        Self {
            request: ChatRequest {
                messages: Vec::new(),
                ..request.clone()
            },
            schema_tool: request
                .response_schema
                .as_ref()
                .map(|schema| schema_tool_name(&schema.name)),
            text: String::new(),
            blocks: Vec::new(),
            calls: Vec::new(),
            usage: Usage::default(),
            stop: None,
        }
    }

    fn block_mut(&mut self, index: u64) -> Option<&mut Block> {
        self.blocks
            .iter_mut()
            .find(|(i, _)| *i == index)
            .map(|(_, block)| block)
    }

    /// A finished block: a tool call is complete (the forced schema call is
    /// kept back for the answer's object).
    fn stop_block(&mut self, index: u64) -> Option<StreamEvent> {
        let position = self.blocks.iter().position(|(i, _)| *i == index)?;
        let (_, block) = self.blocks.remove(position);
        let Block::Tool { id, name, input } = block else {
            return None;
        };
        let arguments = if input.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&input).unwrap_or_else(|_| json!({}))
        };
        let call = ToolCall {
            id,
            name,
            arguments,
        };
        self.calls.push(call.clone());
        (self.schema_tool.as_deref() != Some(call.name.as_str()))
            .then_some(StreamEvent::ToolCall(call))
    }

    /// The text deltas one event carries.
    pub(crate) fn push(&mut self, event: &SseEvent) -> Result<Vec<StreamEvent>, AiError> {
        let data: Value = match serde_json::from_str(&event.data) {
            Ok(data) => data,
            Err(_) => return Ok(Vec::new()),
        };
        let kind = data
            .get("type")
            .and_then(Value::as_str)
            .or(event.event.as_deref())
            .unwrap_or_default();
        let index = data.get("index").and_then(Value::as_u64).unwrap_or(0);
        let mut events = Vec::new();
        match kind {
            "message_start" => {
                self.usage = usage_of(data.pointer("/message/usage").unwrap_or(&Value::Null));
            }
            "content_block_start" => {
                let block = data.get("content_block").unwrap_or(&Value::Null);
                self.blocks.push((index, start_block(block)));
            }
            "content_block_delta" => {
                let delta = data.get("delta").cloned().unwrap_or(Value::Null);
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        let text = delta
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        if !text.is_empty() {
                            self.text.push_str(&text);
                            events.push(StreamEvent::TextDelta(text));
                        }
                    }
                    Some("input_json_delta") => {
                        let part = delta
                            .get("partial_json")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        if let Some(Block::Tool { input, .. }) = self.block_mut(index) {
                            input.push_str(&part);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => events.extend(self.stop_block(index)),
            "message_delta" => {
                if let Some(stop) = data.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.stop = Some(stop.to_owned());
                }
                if let Some(output) = data.pointer("/usage/output_tokens").and_then(Value::as_i64) {
                    self.usage.output_tokens = output;
                }
            }
            "error" => {
                return Err(AiError::Provider {
                    provider: ProviderId::Anthropic,
                    status: None,
                    message: error_message_of(data.get("error").unwrap_or(&data)),
                });
            }
            _ => {}
        }
        Ok(events)
    }

    /// The whole answer, once the stream ended.
    pub(crate) fn finish(self) -> Result<ChatAnswer, AiError> {
        answer(
            ProviderId::Anthropic,
            &self.request,
            self.text,
            self.calls,
            self.usage,
            self.stop.as_deref(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{KeySource, Region};
    use crate::types::{Message, ToolDef};

    fn target(model: &str) -> Target {
        Target {
            provider: ProviderId::Anthropic,
            model: model.to_owned(),
            region: Region::OutsideEu,
            key_source: KeySource::Own,
        }
    }

    #[test]
    fn requests_follow_the_messages_api() {
        let mut request = ChatRequest::system_user("Be brief.", "Read this").temperature(0.3);
        request.messages[0].content.push(Part::Document {
            mime: "application/pdf".to_owned(),
            name: None,
            data: b"%PDF".to_vec(),
        });
        request.messages.push(Message {
            role: Role::Assistant,
            content: vec![Part::ToolCall(ToolCall {
                id: "toolu_1".to_owned(),
                name: "lookup".to_owned(),
                arguments: json!({ "q": "x" }),
            })],
        });
        request.messages.push(Message {
            role: Role::Tool,
            content: vec![Part::ToolResult {
                call_id: "toolu_1".to_owned(),
                content: "found".to_owned(),
                is_error: false,
            }],
        });
        request.messages.push(Message::user("Thanks"));
        request.tools.push(ToolDef {
            name: "lookup".to_owned(),
            description: "Look it up".to_owned(),
            parameters: json!({ "type": "object" }),
        });
        let body = messages_body(&target("anthropic/claude-haiku-4-5"), &request, true);
        assert_eq!(body["model"], "claude-haiku-4-5");
        assert_eq!(body["system"], "Be brief.");
        assert_eq!(body["max_tokens"], 4096);
        assert_eq!(body["stream"], true);
        assert!((body["temperature"].as_f64().expect("temperature") - 0.3).abs() < 1e-6);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"][1]["type"], "document");
        assert_eq!(
            body["messages"][0]["content"][1]["source"]["data"],
            "JVBERg=="
        );
        assert_eq!(body["messages"][1]["content"][0]["type"], "tool_use");
        // The tool result and the next user text merge into one user turn.
        assert_eq!(body["messages"][2]["role"], "user");
        assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
        assert_eq!(body["messages"][2]["content"][1]["text"], "Thanks");
        assert_eq!(body["messages"].as_array().expect("messages").len(), 3);
        assert_eq!(
            body["tools"][0]["input_schema"],
            json!({ "type": "object" })
        );
        assert_eq!(body["tool_choice"], json!({ "type": "auto" }));
    }

    #[test]
    fn claude_5_drops_the_temperature() {
        let request = ChatRequest::system_user("s", "u").temperature(0.3);
        let body = messages_body(&target("anthropic/claude-sonnet-5-5"), &request, false);
        assert!(body.get("temperature").is_none());
        assert!(body.get("stream").is_none());
    }

    #[test]
    fn a_schema_is_a_forced_tool_call() {
        let request = ChatRequest::system_user("s", "u").schema(
            "labels",
            json!({ "type": "object", "properties": { "label": { "type": "string" } } }),
        );
        let body = messages_body(&target("anthropic/claude-haiku-5-5"), &request, false);
        assert_eq!(body["tools"][0]["name"], "labels");
        assert_eq!(
            body["tool_choice"],
            json!({ "type": "tool", "name": "labels" })
        );
        let answer = parse_message(
            &json!({
                "content": [{ "type": "tool_use", "id": "toolu_1", "name": "labels", "input": { "label": "spam" } }],
                "stop_reason": "tool_use",
                "usage": { "input_tokens": 30, "output_tokens": 6, "cache_read_input_tokens": 10 },
            }),
            &request,
        )
        .expect("answer");
        assert_eq!(answer.object, Some(json!({ "label": "spam" })));
        assert_eq!(answer.tool_calls.len(), 0);
        assert_eq!(answer.finish_reason, FinishReason::Stop);
        assert_eq!(
            answer.usage,
            Usage {
                input_tokens: 40,
                output_tokens: 6
            }
        );
    }

    #[test]
    fn a_schema_that_isnt_an_object_is_wrapped() {
        let request = ChatRequest::system_user("s", "u").schema(
            "tags",
            json!({ "type": "array", "items": { "type": "string" } }),
        );
        let body = messages_body(&target("anthropic/claude-haiku-5-5"), &request, false);
        assert_eq!(
            body["tools"][0]["input_schema"]["properties"]["result"]["type"],
            "array"
        );
        let answer = parse_message(
            &json!({ "content": [{ "type": "tool_use", "id": "t", "name": "tags", "input": { "result": ["a", "b"] } }] }),
            &request,
        )
        .expect("answer");
        assert_eq!(answer.object, Some(json!(["a", "b"])));
    }

    #[test]
    fn streams_accumulate_text_tools_and_usage() {
        let request = ChatRequest::system_user("s", "u");
        let mut decoder = StreamDecoder::new(&request);
        let mut events = Vec::new();
        for data in [
            r#"{"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}"#,
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}"#,
            r#"{"type":"content_block_stop","index":0}"#,
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"lookup","input":{}}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"q\": "}}"#,
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"x\"}"}}"#,
            r#"{"type":"content_block_stop","index":1}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}"#,
            r#"{"type":"message_stop"}"#,
        ] {
            events.extend(
                decoder
                    .push(&SseEvent {
                        event: None,
                        data: data.to_owned(),
                    })
                    .expect("event"),
            );
        }
        assert_eq!(events.len(), 3);
        assert_eq!(events[0], StreamEvent::TextDelta("Hi ".to_owned()));
        let StreamEvent::ToolCall(call) = &events[2] else {
            panic!("tool call");
        };
        assert_eq!(call.arguments, json!({ "q": "x" }));
        let answer = decoder.finish().expect("answer");
        assert_eq!(answer.text, "Hi there");
        assert_eq!(answer.finish_reason, FinishReason::ToolCalls);
        assert_eq!(
            answer.usage,
            Usage {
                input_tokens: 25,
                output_tokens: 12
            }
        );
    }

    #[test]
    fn a_stream_error_is_a_provider_error() {
        let mut decoder = StreamDecoder::new(&ChatRequest::default());
        let error = decoder
            .push(&SseEvent {
                event: Some("error".to_owned()),
                data:
                    r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#
                        .to_owned(),
            })
            .expect_err("error");
        assert!(matches!(
            error,
            AiError::Provider {
                provider: ProviderId::Anthropic,
                ..
            }
        ));
    }
}
