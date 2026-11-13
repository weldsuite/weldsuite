//! Requests and answers, provider-neutral. Each provider adapter shapes them
//! into its own API (`providers`).

use futures_util::stream::BoxStream;
use serde::Serialize;
use serde_json::{Value, json};

use crate::catalog::{KeySource, ProviderId, Region};
use crate::error::AiError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    /// A tool's result, answering an assistant's [`Part::ToolCall`].
    Tool,
}

/// One piece of a message.
#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Text(String),
    /// An image (`image/png`, `image/jpeg`, …), for vision models.
    Image { mime: String, data: Vec<u8> },
    /// A file (PDF), for models with native file input.
    Document {
        mime: String,
        name: Option<String>,
        data: Vec<u8>,
    },
    /// The assistant asked for a tool.
    ToolCall(ToolCall),
    /// A tool's answer.
    ToolResult {
        call_id: String,
        content: String,
        is_error: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub role: Role,
    pub content: Vec<Part>,
}

impl Message {
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: vec![Part::Text(text.into())],
        }
    }

    pub fn assistant(text: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            content: vec![Part::Text(text.into())],
        }
    }
}

/// A tool the model may call.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    /// JSON Schema of the arguments.
    pub parameters: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ToolChoice {
    #[default]
    Auto,
    Required,
    None,
    Tool(String),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// A structured answer: the model must return JSON matching `schema`
/// (`response_format: json_schema` on OpenAI-compatible APIs, a forced tool
/// call on Anthropic's). [`ChatResponse::object`] holds the parsed JSON.
#[derive(Debug, Clone, PartialEq)]
pub struct JsonSchema {
    pub name: String,
    pub schema: Value,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ChatRequest {
    pub system: Option<String>,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDef>,
    pub tool_choice: ToolChoice,
    pub response_schema: Option<JsonSchema>,
    pub max_tokens: Option<u32>,
    /// Dropped for models that reject non-default sampling (Claude 5.x,
    /// `sampling.ts`).
    pub temperature: Option<f32>,
}

impl ChatRequest {
    /// A system prompt and one user message.
    pub fn system_user(system: impl Into<String>, user: impl Into<String>) -> Self {
        Self {
            system: Some(system.into()),
            messages: vec![Message::user(user)],
            ..Self::default()
        }
    }

    #[must_use]
    pub fn schema(mut self, name: impl Into<String>, schema: Value) -> Self {
        self.response_schema = Some(JsonSchema {
            name: name.into(),
            schema,
        });
        self
    }

    #[must_use]
    pub fn max_tokens(mut self, max: u32) -> Self {
        self.max_tokens = Some(max);
        self
    }

    #[must_use]
    pub fn temperature(mut self, temperature: f32) -> Self {
        self.temperature = Some(temperature);
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Usage {
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FinishReason {
    #[default]
    Stop,
    Length,
    ToolCalls,
    ContentFilter,
    Other,
}

/// Who answered: the label every AI surface shows, and what was charged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Served {
    pub provider: ProviderId,
    /// The canonical model id (`mistral/mistral-medium-…`,
    /// `anthropic/claude-sonnet-5-5`): what the ledger and prices key on.
    pub model: String,
    pub region: Region,
    pub key_source: KeySource,
    /// The model the call was meant for, when it fell back.
    pub fallback_from: Option<String>,
}

impl Served {
    /// `meta.ai` on an AI response: `{ provider, model, region }`.
    pub fn meta(&self) -> Value {
        json!({
            "provider": self.provider.as_str(),
            "model": self.model,
            "region": self.region.as_str(),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChatResponse {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    /// The parsed JSON of a [`ChatRequest::response_schema`] call.
    pub object: Option<Value>,
    pub usage: Usage,
    pub finish_reason: FinishReason,
    pub served: Served,
    /// Credits charged (0 for own keys, display-only installs and unmetered
    /// calls).
    pub credits: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    TextDelta(String),
    ToolCall(ToolCall),
    /// The end: the whole answer (text included), after metering.
    Finish(Box<ChatResponse>),
}

pub type ChatStream = BoxStream<'static, Result<StreamEvent, AiError>>;

/// A document to read: a PDF or an image.
#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    pub mime: String,
    pub name: Option<String>,
    pub data: Vec<u8>,
    /// Fields to extract in the same call, as a JSON schema (Mistral OCR's
    /// document annotations, or a structured answer from a file-input model).
    pub extract: Option<crate::types::JsonSchema>,
    /// Instructions for the extraction.
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OcrPage {
    pub index: u32,
    pub markdown: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OcrResponse {
    pub pages: Vec<OcrPage>,
    /// The extracted fields, when [`Document::extract`] was set.
    pub object: Option<Value>,
    pub usage: Usage,
    pub served: Served,
    pub credits: i64,
}

impl OcrResponse {
    /// Every page's markdown, joined.
    pub fn text(&self) -> String {
        self.pages
            .iter()
            .map(|p| p.markdown.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EmbedResponse {
    pub vectors: Vec<Vec<f32>>,
    pub usage: Usage,
    pub served: Served,
    pub credits: i64,
}

/// Audio to transcribe.
#[derive(Debug, Clone, PartialEq)]
pub struct Audio {
    pub mime: String,
    pub name: String,
    pub data: Vec<u8>,
    /// ISO 639-1, when known.
    pub language: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TranscribeResponse {
    pub text: String,
    /// Segments with start and end in seconds, when the provider gives them.
    pub segments: Vec<(f64, f64, String)>,
    pub duration_seconds: Option<f64>,
    pub served: Served,
    pub credits: i64,
}
