//! A scripted model server for unit tests: every provider's HTTP calls are
//! answered by the queued replies, and every request is recorded so a test
//! can assert which provider and model was called (and that a disabled one
//! never was).
//!
//! A queued reply is shaped for the endpoint that receives it: an
//! OpenAI-compatible chat completion (`/chat/completions`), an Anthropic
//! message (`/messages`), either as server-sent events when the request
//! streams, a Mistral OCR answer (`/ocr`), embeddings (`/embeddings`), a
//! transcription (`/audio/transcriptions`) or a model list (`/models`). With
//! nothing queued it answers the text `ok`.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, OutboundHttp, PortError,
};

/// One recorded request.
#[derive(Debug, Clone)]
pub struct FakeCall {
    pub url: String,
    /// The JSON body; a multipart or other body as a string.
    pub body: serde_json::Value,
    pub headers: Vec<(String, String)>,
}

impl FakeCall {
    /// The `model` the request named (in a JSON body, or a multipart field).
    pub fn model(&self) -> Option<String> {
        if let Some(model) = self.body.get("model").and_then(Value::as_str) {
            return Some(model.to_owned());
        }
        let text = self.body.as_str()?;
        let start = text.find("name=\"model\"\r\n\r\n")? + "name=\"model\"\r\n\r\n".len();
        text[start..].split("\r\n").next().map(str::to_owned)
    }

    /// A request header, by case-insensitive name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// A queued answer, shaped when it is sent.
#[derive(Debug, Clone)]
enum Reply {
    Text(String),
    Json(Value),
    ToolCall { name: String, arguments: Value },
    Embeddings(Vec<Vec<f32>>),
    Status(u16, String),
    Raw(HttpResponse),
}

#[derive(Debug, Clone, Default)]
pub struct FakeProvider {
    replies: Arc<Mutex<Vec<Reply>>>,
    calls: Arc<Mutex<Vec<FakeCall>>>,
}

/// The token counts every fake answer reports.
pub const FAKE_INPUT_TOKENS: i64 = 12;
pub const FAKE_OUTPUT_TOKENS: i64 = 8;

impl FakeProvider {
    pub fn new() -> Self {
        Self::default()
    }

    fn push(self, reply: Reply) -> Self {
        self.replies
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(reply);
        self
    }

    /// Queue an answer of `text` (a chat completion, a message, OCR markdown
    /// or a transcription, depending on the endpoint called).
    #[must_use]
    pub fn reply_text(self, text: &str) -> Self {
        self.push(Reply::Text(text.to_owned()))
    }

    /// Queue an answer of `object` as JSON: the content of a chat completion,
    /// Anthropic's forced tool call, or OCR's document annotation.
    #[must_use]
    pub fn reply_json(self, object: &serde_json::Value) -> Self {
        self.push(Reply::Json(object.clone()))
    }

    /// Queue a call of the tool `name`.
    #[must_use]
    pub fn reply_tool_call(self, name: &str, arguments: &serde_json::Value) -> Self {
        self.push(Reply::ToolCall {
            name: name.to_owned(),
            arguments: arguments.clone(),
        })
    }

    /// Queue embeddings.
    #[must_use]
    pub fn reply_embeddings(self, vectors: Vec<Vec<f32>>) -> Self {
        self.push(Reply::Embeddings(vectors))
    }

    /// Queue an error status (a refusal, for fallback tests).
    #[must_use]
    pub fn reply_status(self, status: u16, body: &str) -> Self {
        self.push(Reply::Status(status, body.to_owned()))
    }

    /// Queue a raw answer.
    #[must_use]
    pub fn reply(self, response: HttpResponse) -> Self {
        self.push(Reply::Raw(response))
    }

    /// The requests made so far.
    pub fn calls(&self) -> Vec<FakeCall> {
        self.calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// An HTTP client answered by this fake.
    pub fn outbound(&self) -> OutboundHttp {
        OutboundHttp(Arc::new(FakeOutbound(self.clone())))
    }

    fn next(&self) -> Reply {
        let mut replies = self
            .replies
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if replies.is_empty() {
            Reply::Text("ok".to_owned())
        } else {
            replies.remove(0)
        }
    }
}

struct FakeOutbound(FakeProvider);

impl DynOutboundHttp for FakeOutbound {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        let body = request.body.as_deref().map_or(Value::Null, |raw| {
            serde_json::from_slice(raw)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(raw).into_owned()))
        });
        self.0
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(FakeCall {
                url: request.url.clone(),
                body: body.clone(),
                headers: request.headers.clone(),
            });
        let reply = self.0.next();
        Box::pin(std::future::ready(Ok(answer(&request.url, &body, reply))))
    }
}

fn json_response(value: &Value) -> HttpResponse {
    let mut response = HttpResponse::new(200, value.to_string().into_bytes());
    response
        .headers
        .push(("content-type".to_owned(), "application/json".to_owned()));
    response
}

fn sse_response(events: &[Value], done: bool, named: bool) -> HttpResponse {
    let mut body = String::new();
    for event in events {
        if named && let Some(kind) = event.get("type").and_then(Value::as_str) {
            body.push_str("event: ");
            body.push_str(kind);
            body.push('\n');
        }
        body.push_str("data: ");
        body.push_str(&event.to_string());
        body.push_str("\n\n");
    }
    if done {
        body.push_str("data: [DONE]\n\n");
    }
    let mut response = HttpResponse::new(200, body.into_bytes());
    response
        .headers
        .push(("content-type".to_owned(), "text/event-stream".to_owned()));
    response
}

fn usage_openai() -> Value {
    json!({ "prompt_tokens": FAKE_INPUT_TOKENS, "completion_tokens": FAKE_OUTPUT_TOKENS })
}

fn answer(url: &str, request: &Value, reply: Reply) -> HttpResponse {
    match reply {
        Reply::Status(status, body) => return HttpResponse::new(status, body.into_bytes()),
        Reply::Raw(response) => return response,
        _ => {}
    }
    let stream = request.get("stream").and_then(Value::as_bool) == Some(true);
    let path = url.split('?').next().unwrap_or(url);
    if path.ends_with("/chat/completions") {
        openai_chat(request, reply, stream)
    } else if path.ends_with("/messages") {
        anthropic_message(request, reply, stream)
    } else if path.ends_with("/ocr") {
        let (markdown, annotation) = match reply {
            Reply::Json(object) => ("# Document".to_owned(), Some(object.to_string())),
            Reply::Text(text) => (text, None),
            _ => (String::new(), None),
        };
        json_response(&json!({
            "pages": [{ "index": 0, "markdown": markdown }],
            "model": request.get("model"),
            "document_annotation": annotation,
            "usage_info": { "pages_processed": 1, "doc_size_bytes": 0 },
        }))
    } else if path.ends_with("/embeddings") {
        let count = request
            .get("input")
            .and_then(Value::as_array)
            .map_or(1, Vec::len);
        let vectors = match reply {
            Reply::Embeddings(vectors) => vectors,
            _ => vec![vec![0.0; 4]; count],
        };
        let data: Vec<Value> = vectors
            .iter()
            .enumerate()
            .map(|(index, vector)| json!({ "index": index, "embedding": vector }))
            .collect();
        json_response(&json!({ "data": data, "usage": { "prompt_tokens": FAKE_INPUT_TOKENS } }))
    } else if path.ends_with("/audio/transcriptions") {
        let text = match reply {
            Reply::Text(text) => text,
            _ => String::new(),
        };
        json_response(&json!({
            "text": text,
            "segments": [{ "start": 0.0, "end": 60.0, "text": text }],
            "usage": { "prompt_audio_seconds": 60 },
        }))
    } else if path.ends_with("/models") {
        json_response(&json!({ "data": [] }))
    } else {
        HttpResponse::new(404, b"not found".to_vec())
    }
}

fn openai_chat(request: &Value, reply: Reply, stream: bool) -> HttpResponse {
    let (content, tool_calls) = match reply {
        Reply::Text(text) => (text, None),
        Reply::Json(object) => (object.to_string(), None),
        Reply::ToolCall { name, arguments } => (
            String::new(),
            Some(json!([{
                "id": "call_fake_1",
                "type": "function",
                "function": { "name": name, "arguments": arguments.to_string() },
            }])),
        ),
        _ => (String::new(), None),
    };
    let finish = if tool_calls.is_some() {
        "tool_calls"
    } else {
        "stop"
    };
    if stream {
        let mut events = Vec::new();
        if !content.is_empty() {
            let middle = content
                .char_indices()
                .nth(content.chars().count() / 2)
                .map_or(0, |(i, _)| i);
            let (first, second) = content.split_at(middle);
            for part in [first, second].iter().filter(|p| !p.is_empty()) {
                events.push(json!({ "choices": [{ "index": 0, "delta": { "content": part } }] }));
            }
        }
        if let Some(Value::Array(calls)) = &tool_calls {
            let calls: Vec<Value> = calls
                .iter()
                .enumerate()
                .map(|(index, call)| {
                    let mut call = call.clone();
                    call["index"] = json!(index);
                    call
                })
                .collect();
            events.push(json!({ "choices": [{ "index": 0, "delta": { "tool_calls": calls } }] }));
        }
        events.push(json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": finish }] }));
        events.push(json!({ "choices": [], "usage": usage_openai() }));
        return sse_response(&events, true, false);
    }
    let mut message = json!({ "role": "assistant", "content": content });
    if let Some(calls) = tool_calls {
        message["tool_calls"] = calls;
    }
    json_response(&json!({
        "id": "fake",
        "object": "chat.completion",
        "model": request.get("model"),
        "choices": [{ "index": 0, "message": message, "finish_reason": finish }],
        "usage": usage_openai(),
    }))
}

fn anthropic_message(request: &Value, reply: Reply, stream: bool) -> HttpResponse {
    let forced = request
        .pointer("/tool_choice/name")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let blocks: Vec<Value> = match reply {
        Reply::Text(text) => vec![json!({ "type": "text", "text": text })],
        Reply::Json(object) => match forced {
            Some(name) => {
                let wrapped = request
                    .get("tools")
                    .and_then(Value::as_array)
                    .and_then(|tools| tools.iter().find(|t| t["name"] == name.as_str()))
                    .and_then(|tool| tool.pointer("/input_schema/required"))
                    == Some(&json!(["result"]));
                let input = if wrapped && !object.is_object() {
                    json!({ "result": object })
                } else {
                    object
                };
                vec![
                    json!({ "type": "tool_use", "id": "toolu_fake_1", "name": name, "input": input }),
                ]
            }
            None => vec![json!({ "type": "text", "text": object.to_string() })],
        },
        Reply::ToolCall { name, arguments } => {
            vec![
                json!({ "type": "tool_use", "id": "toolu_fake_1", "name": name, "input": arguments }),
            ]
        }
        _ => Vec::new(),
    };
    let stop = if blocks.iter().any(|b| b["type"] == "tool_use") {
        "tool_use"
    } else {
        "end_turn"
    };
    if stream {
        let mut events = vec![json!({
            "type": "message_start",
            "message": { "id": "msg_fake", "role": "assistant", "content": [], "usage": { "input_tokens": FAKE_INPUT_TOKENS, "output_tokens": 1 } },
        })];
        for (index, block) in blocks.iter().enumerate() {
            if block["type"] == "text" {
                events.push(json!({ "type": "content_block_start", "index": index, "content_block": { "type": "text", "text": "" } }));
                events.push(json!({ "type": "content_block_delta", "index": index, "delta": { "type": "text_delta", "text": block["text"] } }));
            } else {
                events.push(json!({ "type": "content_block_start", "index": index, "content_block": { "type": "tool_use", "id": block["id"], "name": block["name"], "input": {} } }));
                events.push(json!({ "type": "content_block_delta", "index": index, "delta": { "type": "input_json_delta", "partial_json": block["input"].to_string() } }));
            }
            events.push(json!({ "type": "content_block_stop", "index": index }));
        }
        events.push(json!({ "type": "message_delta", "delta": { "stop_reason": stop }, "usage": { "output_tokens": FAKE_OUTPUT_TOKENS } }));
        events.push(json!({ "type": "message_stop" }));
        return sse_response(&events, false, true);
    }
    json_response(&json!({
        "id": "msg_fake",
        "type": "message",
        "role": "assistant",
        "model": request.get("model"),
        "content": blocks,
        "stop_reason": stop,
        "usage": { "input_tokens": FAKE_INPUT_TOKENS, "output_tokens": FAKE_OUTPUT_TOKENS },
    }))
}
