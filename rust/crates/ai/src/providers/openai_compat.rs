//! Chat completions on OpenAI-compatible APIs: Mistral, `OpenAI` and an
//! install's own endpoint (vLLM, Ollama, Azure). Tools, `response_format:
//! json_schema`, image and document parts, SSE streaming, and each dialect's
//! differences: Mistral's `tool_choice: "any"`, string `image_url` and
//! `document_url` parts; `OpenAI`'s `max_completion_tokens`, `file` parts and
//! `stream_options`; GPT-5's fixed sampling.

use serde_json::{Map, Value, json};

use super::sse::SseEvent;
use super::{ChatAnswer, data_url, parse_json_answer, rejects_sampling_params, schema_tool_name};
use crate::catalog::ProviderId;
use crate::error::AiError;
use crate::policy::Target;
use crate::types::{
    ChatRequest, FinishReason, Part, Role, StreamEvent, ToolCall, ToolChoice, Usage,
};

/// Which OpenAI-compatible API a request goes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Dialect {
    Mistral,
    OpenAi,
    Compat,
}

impl Dialect {
    pub(crate) fn of(provider: ProviderId) -> Self {
        match provider {
            ProviderId::Mistral => Self::Mistral,
            ProviderId::OpenAi => Self::OpenAi,
            ProviderId::Anthropic | ProviderId::Compat => Self::Compat,
        }
    }
}

fn content_part(dialect: Dialect, part: &Part) -> Option<Value> {
    match part {
        Part::Text(text) => Some(json!({ "type": "text", "text": text })),
        Part::Image { mime, data } => {
            let url = data_url(mime, data);
            Some(match dialect {
                Dialect::Mistral => json!({ "type": "image_url", "image_url": url }),
                Dialect::OpenAi | Dialect::Compat => {
                    json!({ "type": "image_url", "image_url": { "url": url } })
                }
            })
        }
        Part::Document { mime, name, data } => {
            let url = data_url(mime, data);
            Some(match dialect {
                Dialect::Mistral => json!({ "type": "document_url", "document_url": url }),
                Dialect::OpenAi | Dialect::Compat => json!({
                    "type": "file",
                    "file": {
                        "filename": name.clone().unwrap_or_else(|| "document.pdf".to_owned()),
                        "file_data": url,
                    },
                }),
            })
        }
        Part::ToolCall(_) | Part::ToolResult { .. } => None,
    }
}

/// A message's content: a plain string when it is one text part.
fn content(dialect: Dialect, parts: &[&Part]) -> Value {
    if let [Part::Text(text)] = parts {
        return Value::String(text.clone());
    }
    Value::Array(
        parts
            .iter()
            .filter_map(|p| content_part(dialect, p))
            .collect(),
    )
}

fn messages(dialect: Dialect, request: &ChatRequest) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(system) = request.system.as_deref().filter(|s| !s.is_empty()) {
        out.push(json!({ "role": "system", "content": system }));
    }
    for message in &request.messages {
        let results: Vec<&Part> = message
            .content
            .iter()
            .filter(|p| matches!(p, Part::ToolResult { .. }))
            .collect();
        for result in &results {
            if let Part::ToolResult {
                call_id, content, ..
            } = result
            {
                out.push(json!({ "role": "tool", "tool_call_id": call_id, "content": content }));
            }
        }
        if message.role == Role::Tool {
            continue;
        }
        let parts: Vec<&Part> = message
            .content
            .iter()
            .filter(|p| !matches!(p, Part::ToolCall(_) | Part::ToolResult { .. }))
            .collect();
        let calls: Vec<Value> = message
            .content
            .iter()
            .filter_map(|p| match p {
                Part::ToolCall(call) => Some(json!({
                    "id": call.id,
                    "type": "function",
                    "function": { "name": call.name, "arguments": call.arguments.to_string() },
                })),
                _ => None,
            })
            .collect();
        match message.role {
            Role::Assistant => {
                let text: String = parts
                    .iter()
                    .filter_map(|p| match p {
                        Part::Text(text) => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("");
                let mut entry = Map::new();
                entry.insert("role".to_owned(), json!("assistant"));
                entry.insert("content".to_owned(), json!(text));
                if !calls.is_empty() {
                    entry.insert("tool_calls".to_owned(), Value::Array(calls));
                }
                out.push(Value::Object(entry));
            }
            Role::User | Role::Tool => {
                if !parts.is_empty() {
                    out.push(json!({ "role": "user", "content": content(dialect, &parts) }));
                }
            }
        }
    }
    out
}

fn tool_choice(dialect: Dialect, choice: &ToolChoice) -> Value {
    match choice {
        ToolChoice::Auto => json!("auto"),
        ToolChoice::Required => match dialect {
            Dialect::Mistral => json!("any"),
            Dialect::OpenAi | Dialect::Compat => json!("required"),
        },
        ToolChoice::None => json!("none"),
        ToolChoice::Tool(name) => json!({ "type": "function", "function": { "name": name } }),
    }
}

fn temperature(dialect: Dialect, model: &str, temperature: Option<f32>) -> Option<f64> {
    let temperature = f64::from(temperature?);
    if rejects_sampling_params(model) {
        return None;
    }
    Some(match dialect {
        Dialect::Mistral => temperature.clamp(0.0, 1.0),
        Dialect::OpenAi => temperature.clamp(0.0, 2.0),
        Dialect::Compat => temperature,
    })
}

/// The `/chat/completions` body for `target`.
pub(crate) fn chat_body(
    dialect: Dialect,
    target: &Target,
    request: &ChatRequest,
    stream: bool,
) -> Value {
    let mut body = Map::new();
    body.insert("model".to_owned(), json!(target.native_model()));
    body.insert(
        "messages".to_owned(),
        Value::Array(messages(dialect, request)),
    );
    if !request.tools.is_empty() {
        let tools: Vec<Value> = request
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                })
            })
            .collect();
        body.insert("tools".to_owned(), Value::Array(tools));
        body.insert(
            "tool_choice".to_owned(),
            tool_choice(dialect, &request.tool_choice),
        );
    }
    if let Some(schema) = &request.response_schema {
        let strict = schema.schema.get("additionalProperties") == Some(&Value::Bool(false));
        body.insert(
            "response_format".to_owned(),
            json!({
                "type": "json_schema",
                "json_schema": {
                    "name": schema_tool_name(&schema.name),
                    "schema": schema.schema,
                    "strict": strict,
                },
            }),
        );
    }
    if let Some(max) = request.max_tokens {
        let field = if dialect == Dialect::OpenAi {
            "max_completion_tokens"
        } else {
            "max_tokens"
        };
        body.insert(field.to_owned(), json!(max));
    }
    if let Some(temperature) = temperature(dialect, &target.model, request.temperature) {
        body.insert("temperature".to_owned(), json!(temperature));
    }
    if stream {
        body.insert("stream".to_owned(), json!(true));
        if dialect != Dialect::Mistral {
            body.insert(
                "stream_options".to_owned(),
                json!({ "include_usage": true }),
            );
        }
    }
    Value::Object(body)
}

fn finish_reason(raw: Option<&str>) -> FinishReason {
    match raw {
        Some("stop") | None => FinishReason::Stop,
        Some("length" | "model_length") => FinishReason::Length,
        Some("tool_calls") => FinishReason::ToolCalls,
        Some("content_filter") => FinishReason::ContentFilter,
        Some(_) => FinishReason::Other,
    }
}

/// A message's content as text: a string, or Mistral's chunk array.
fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(chunks) => chunks
            .iter()
            .filter(|c| {
                c.get("type")
                    .and_then(Value::as_str)
                    .is_none_or(|t| t == "text")
            })
            .filter_map(|c| c.get("text").and_then(Value::as_str))
            .collect(),
        _ => String::new(),
    }
}

/// Arguments arrive as a JSON string (`OpenAI`) or an object (some servers).
fn arguments(raw: &Value) -> Value {
    match raw {
        Value::String(text) if text.trim().is_empty() => json!({}),
        Value::String(text) => {
            serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.clone()))
        }
        Value::Null => json!({}),
        other => other.clone(),
    }
}

fn usage_of(body: &Value) -> Option<Usage> {
    let usage = body.get("usage").filter(|u| u.is_object())?;
    Some(Usage {
        input_tokens: usage
            .get("prompt_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        output_tokens: usage
            .get("completion_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
    })
}

/// A whole `/chat/completions` answer.
pub(crate) fn parse_chat(
    provider: ProviderId,
    body: &Value,
    request: &ChatRequest,
) -> Result<ChatAnswer, AiError> {
    let choice = body
        .get("choices")
        .and_then(|c| c.get(0))
        .ok_or_else(|| AiError::Provider {
            provider,
            status: None,
            message: "the answer has no choices".to_owned(),
        })?;
    let message = choice.get("message").cloned().unwrap_or(Value::Null);
    let text = text_of(message.get("content").unwrap_or(&Value::Null));
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, call)| ToolCall {
            id: call
                .get("id")
                .and_then(Value::as_str)
                .map_or_else(|| format!("call_{index}"), str::to_owned),
            name: call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            arguments: arguments(call.pointer("/function/arguments").unwrap_or(&Value::Null)),
        })
        .collect();
    let object = match &request.response_schema {
        Some(_) => Some(parse_json_answer(&text)?),
        None => None,
    };
    Ok(ChatAnswer {
        text,
        tool_calls,
        object,
        usage: usage_of(body).unwrap_or_default(),
        finish_reason: finish_reason(choice.get("finish_reason").and_then(Value::as_str)),
    })
}

#[derive(Debug, Default)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
}

/// Accumulates a streamed completion.
#[derive(Debug)]
pub(crate) struct StreamDecoder {
    provider: ProviderId,
    schema: bool,
    text: String,
    calls: Vec<PartialCall>,
    usage: Usage,
    finish: Option<String>,
}

impl StreamDecoder {
    pub(crate) fn new(provider: ProviderId, request: &ChatRequest) -> Self {
        Self {
            provider,
            schema: request.response_schema.is_some(),
            text: String::new(),
            calls: Vec::new(),
            usage: Usage::default(),
            finish: None,
        }
    }

    /// The text deltas one event carries.
    pub(crate) fn push(&mut self, event: &SseEvent) -> Result<Vec<StreamEvent>, AiError> {
        let data = event.data.trim();
        if data.is_empty() || data == "[DONE]" {
            return Ok(Vec::new());
        }
        let chunk: Value = serde_json::from_str(data).map_err(|_| AiError::Provider {
            provider: self.provider,
            status: None,
            message: "the stream sent a chunk that isn't JSON".to_owned(),
        })?;
        if let Some(error) = chunk.get("error") {
            return Err(AiError::Provider {
                provider: self.provider,
                status: None,
                message: super::error_message_of(error),
            });
        }
        if let Some(usage) = usage_of(&chunk) {
            self.usage = usage;
        }
        let mut events = Vec::new();
        let Some(choice) = chunk.get("choices").and_then(|c| c.get(0)) else {
            return Ok(events);
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish = Some(reason.to_owned());
        }
        let delta = choice.get("delta").cloned().unwrap_or(Value::Null);
        let text = text_of(delta.get("content").unwrap_or(&Value::Null));
        if !text.is_empty() {
            self.text.push_str(&text);
            if !self.schema {
                events.push(StreamEvent::TextDelta(text));
            }
        }
        for call in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            // Without an index (servers that send each call whole), a call
            // with an id starts a new entry; anything else continues the last.
            let index = call
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|i| usize::try_from(i).ok())
                .unwrap_or_else(|| {
                    if call.get("id").is_some() {
                        self.calls.len()
                    } else {
                        self.calls.len().saturating_sub(1)
                    }
                });
            while self.calls.len() <= index {
                self.calls.push(PartialCall::default());
            }
            let entry = &mut self.calls[index];
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                id.clone_into(&mut entry.id);
            }
            if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                entry.name.push_str(name);
            }
            match call.pointer("/function/arguments") {
                Some(Value::String(part)) => entry.arguments.push_str(part),
                Some(Value::Null) | None => {}
                Some(other) => entry.arguments.push_str(&other.to_string()),
            }
        }
        Ok(events)
    }

    /// The whole answer, once the stream ended.
    pub(crate) fn finish(self) -> Result<ChatAnswer, AiError> {
        let tool_calls = self
            .calls
            .into_iter()
            .enumerate()
            .filter(|(_, c)| !c.name.is_empty())
            .map(|(index, call)| ToolCall {
                id: if call.id.is_empty() {
                    format!("call_{index}")
                } else {
                    call.id
                },
                name: call.name,
                arguments: arguments(&Value::String(call.arguments)),
            })
            .collect();
        let object = if self.schema {
            Some(parse_json_answer(&self.text)?)
        } else {
            None
        };
        Ok(ChatAnswer {
            text: self.text,
            tool_calls,
            object,
            usage: self.usage,
            finish_reason: finish_reason(self.finish.as_deref()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{KeySource, Region};
    use crate::types::{Message, ToolDef};

    fn target(provider: ProviderId, model: &str) -> Target {
        Target {
            provider,
            model: model.to_owned(),
            region: Region::Eu,
            key_source: KeySource::Weldsuite,
        }
    }

    fn request() -> ChatRequest {
        let mut request = ChatRequest::system_user("Be brief.", "Hello")
            .max_tokens(300)
            .temperature(0.4);
        request.messages.push(Message {
            role: Role::Assistant,
            content: vec![
                Part::Text("Looking it up.".to_owned()),
                Part::ToolCall(ToolCall {
                    id: "call_1".to_owned(),
                    name: "lookup".to_owned(),
                    arguments: json!({ "q": "x" }),
                }),
            ],
        });
        request.messages.push(Message {
            role: Role::Tool,
            content: vec![Part::ToolResult {
                call_id: "call_1".to_owned(),
                content: "found".to_owned(),
                is_error: false,
            }],
        });
        request.messages.push(Message {
            role: Role::User,
            content: vec![
                Part::Text("And this?".to_owned()),
                Part::Image {
                    mime: "image/png".to_owned(),
                    data: vec![1, 2, 3],
                },
                Part::Document {
                    mime: "application/pdf".to_owned(),
                    name: Some("invoice.pdf".to_owned()),
                    data: b"%PDF".to_vec(),
                },
            ],
        });
        request.tools.push(ToolDef {
            name: "lookup".to_owned(),
            description: "Look it up".to_owned(),
            parameters: json!({ "type": "object", "properties": { "q": { "type": "string" } } }),
        });
        request.tool_choice = ToolChoice::Required;
        request
    }

    #[test]
    fn mistral_requests_use_its_dialect() {
        let body = chat_body(
            Dialect::Mistral,
            &target(ProviderId::Mistral, "mistral/mistral-large-4-0"),
            &request(),
            false,
        );
        assert_eq!(body["model"], "mistral-large-4-0");
        assert_eq!(
            body["messages"][0],
            json!({ "role": "system", "content": "Be brief." })
        );
        assert_eq!(
            body["messages"][1],
            json!({ "role": "user", "content": "Hello" })
        );
        assert_eq!(body["messages"][2]["role"], "assistant");
        assert_eq!(body["messages"][2]["content"], "Looking it up.");
        assert_eq!(
            body["messages"][2]["tool_calls"][0]["function"]["arguments"],
            "{\"q\":\"x\"}"
        );
        assert_eq!(
            body["messages"][3],
            json!({ "role": "tool", "tool_call_id": "call_1", "content": "found" })
        );
        let parts = &body["messages"][4]["content"];
        assert_eq!(parts[0], json!({ "type": "text", "text": "And this?" }));
        assert_eq!(
            parts[1],
            json!({ "type": "image_url", "image_url": "data:image/png;base64,AQID" })
        );
        assert_eq!(
            parts[2],
            json!({ "type": "document_url", "document_url": "data:application/pdf;base64,JVBERg==" })
        );
        assert_eq!(body["tool_choice"], "any");
        assert_eq!(body["tools"][0]["function"]["name"], "lookup");
        assert_eq!(body["max_tokens"], 300);
        assert!((body["temperature"].as_f64().expect("temperature") - 0.4).abs() < 1e-6);
        assert!(body.get("stream").is_none());
    }

    #[test]
    fn openai_requests_use_its_dialect() {
        let body = chat_body(
            Dialect::OpenAi,
            &target(ProviderId::OpenAi, "openai/gpt-5"),
            &request(),
            true,
        );
        assert_eq!(body["model"], "gpt-5");
        assert_eq!(body["tool_choice"], "required");
        assert_eq!(body["max_completion_tokens"], 300);
        assert!(body.get("max_tokens").is_none());
        // GPT-5 only takes the default temperature.
        assert!(body.get("temperature").is_none());
        let parts = &body["messages"][4]["content"];
        assert_eq!(parts[1]["image_url"]["url"], "data:image/png;base64,AQID");
        assert_eq!(parts[2]["type"], "file");
        assert_eq!(parts[2]["file"]["filename"], "invoice.pdf");
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
    }

    #[test]
    fn a_schema_asks_for_json_and_parses_it() {
        let request = ChatRequest::system_user("s", "u").schema(
            "reply labels!",
            json!({ "type": "object", "properties": { "label": { "type": "string" } }, "additionalProperties": false }),
        );
        let body = chat_body(
            Dialect::Mistral,
            &target(ProviderId::Mistral, "mistral/mistral-small-2603"),
            &request,
            false,
        );
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(
            body["response_format"]["json_schema"]["name"],
            "reply_labels_"
        );
        assert_eq!(body["response_format"]["json_schema"]["strict"], true);
        assert!(body.get("tools").is_none());

        let answer = parse_chat(
            ProviderId::Mistral,
            &json!({
                "choices": [{ "message": { "content": "```json\n{\"label\":\"interested\"}\n```" }, "finish_reason": "stop" }],
                "usage": { "prompt_tokens": 20, "completion_tokens": 4 },
            }),
            &request,
        )
        .expect("answer");
        assert_eq!(answer.object, Some(json!({ "label": "interested" })));
        assert_eq!(
            answer.usage,
            Usage {
                input_tokens: 20,
                output_tokens: 4
            }
        );
        // Not JSON: an invalid answer, not a refusal.
        let bad = parse_chat(
            ProviderId::Mistral,
            &json!({ "choices": [{ "message": { "content": "sure!" } }] }),
            &request,
        );
        assert!(matches!(bad, Err(AiError::Invalid(_))));
    }

    #[test]
    fn tool_calls_and_chunked_content_parse() {
        let answer = parse_chat(
            ProviderId::Mistral,
            &json!({
                "choices": [{
                    "message": {
                        "content": [{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }],
                        "tool_calls": [{ "id": "t1", "function": { "name": "lookup", "arguments": "{\"q\":1}" } },
                                       { "function": { "name": "other", "arguments": { "z": 2 } } }],
                    },
                    "finish_reason": "tool_calls",
                }],
            }),
            &ChatRequest::default(),
        )
        .expect("answer");
        assert_eq!(answer.text, "ab");
        assert_eq!(answer.finish_reason, FinishReason::ToolCalls);
        assert_eq!(answer.tool_calls[0].arguments, json!({ "q": 1 }));
        assert_eq!(answer.tool_calls[1].id, "call_1");
        assert_eq!(answer.tool_calls[1].arguments, json!({ "z": 2 }));
    }

    #[test]
    fn streams_accumulate_text_tool_calls_and_usage() {
        let mut decoder = StreamDecoder::new(ProviderId::OpenAi, &ChatRequest::default());
        let mut deltas = Vec::new();
        for data in [
            r#"{"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}"#,
            r#"{"choices":[{"delta":{"content":"lo"}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"look","arguments":"{\"q\":"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"up","arguments":"\"x\"}"}}]}}]}"#,
            r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
            r#"{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}"#,
            "[DONE]",
        ] {
            deltas.extend(
                decoder
                    .push(&SseEvent {
                        event: None,
                        data: data.to_owned(),
                    })
                    .expect("chunk"),
            );
        }
        assert_eq!(
            deltas,
            vec![
                StreamEvent::TextDelta("Hel".to_owned()),
                StreamEvent::TextDelta("lo".to_owned())
            ]
        );
        let answer = decoder.finish().expect("answer");
        assert_eq!(answer.text, "Hello");
        assert_eq!(answer.tool_calls[0].name, "lookup");
        assert_eq!(answer.tool_calls[0].arguments, json!({ "q": "x" }));
        assert_eq!(answer.finish_reason, FinishReason::ToolCalls);
        assert_eq!(
            answer.usage,
            Usage {
                input_tokens: 7,
                output_tokens: 3
            }
        );
    }
}
