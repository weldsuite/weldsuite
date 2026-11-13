//! The provider adapters and the call loop around them: shape the request
//! for the target's API, send it (10 s connect, 120 s overall, 300 s for OCR
//! and transcription; 429 retried with backoff, honouring `Retry-After`),
//! walk the route's fallbacks on a refusal, mark a failing own key, and meter
//! the target that served.
//!
//! - `openai_compat`: chat completions for Mistral, `OpenAI`, vLLM and Ollama
//!   (tools, `json_schema`, SSE streaming, image and document parts).
//! - `anthropic`: the Messages API (tools, structured output through a forced
//!   tool call, files, streaming). Anthropic's OpenAI-compatible endpoint is
//!   for testing only, so it isn't used.
//! - `mistral_ocr`: `POST /v1/ocr`, with document annotations. On a provider
//!   with native file input (Claude, GPT-5) a document is read by the chat
//!   model instead, falling back to Mistral OCR.
//! - `embeddings`: `POST /v1/embeddings` (`mistral-embed`).
//! - `transcription`: `/audio/transcriptions` (Voxtral).
//!
//! A transport failure (no connection, a timeout) counts as a refusal too,
//! like a 5xx. Logs and traces carry the workspace, feature, provider, model,
//! tokens and latency, never prompts or completions.

mod anthropic;
mod embeddings;
mod mistral_ocr;
mod openai_compat;
mod sse;
mod transcription;

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use futures_util::StreamExt as _;
use serde_json::{Value, json};
use tokio::sync::OwnedSemaphorePermit;
use weldsuite_ports::{
    HttpBodyStream, HttpRequest, HttpResponse, HttpStreamResponse, OutboundHttp,
};

use crate::billing;
use crate::catalog::{self, Api, Capability, KeySource, ProviderId};
use crate::config::AiConfig;
use crate::error::AiError;
use crate::fallback;
use crate::policy::{self, Route, Target};
use crate::settings;
use crate::types::{
    Audio, ChatRequest, ChatResponse, ChatStream, Document, EmbedResponse, FinishReason,
    JsonSchema, Message, OcrPage, OcrResponse, Part, Role, Served, StreamEvent, ToolCall,
    TranscribeResponse, Usage,
};
use crate::{Ai, AiCall};

use self::openai_compat::Dialect;
use self::sse::{SseEvent, SseParser};

/// A chat call's overall limit.
pub const CHAT_TIMEOUT: Duration = Duration::from_secs(120);
/// OCR's and transcription's overall limit.
pub const LONG_TIMEOUT: Duration = Duration::from_secs(300);
/// How often a 429 is retried on the same target before falling back.
const MAX_RETRIES: u32 = 2;
/// The longest a `Retry-After` is honoured.
const MAX_RETRY_DELAY: Duration = Duration::from_secs(20);

/// A completion, provider-neutral, before metering.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ChatAnswer {
    pub(crate) text: String,
    pub(crate) tool_calls: Vec<ToolCall>,
    pub(crate) object: Option<Value>,
    pub(crate) usage: Usage,
    pub(crate) finish_reason: FinishReason,
}

/// `sampling.ts`'s `rejectsSamplingParams`, plus `OpenAI`'s GPT-5 family: the
/// models that refuse a non-default temperature (`top_p`, `top_k`), so the
/// adapters leave it out.
pub fn rejects_sampling_params(model: &str) -> bool {
    if let Some(rest) = model.strip_prefix("anthropic/claude-") {
        let family_5 = ["opus", "sonnet", "haiku"].iter().any(|family| {
            rest.strip_prefix(family)
                .and_then(|r| r.strip_prefix("-5"))
                .is_some_and(|r| r.is_empty() || r.starts_with('-'))
        });
        let opus_4_late = ["opus-4-7", "opus-4-8"]
            .iter()
            .any(|v| rest == *v || rest.starts_with(&format!("{v}-")));
        return rest.starts_with("fable-")
            || rest.starts_with("mythos-")
            || family_5
            || opus_4_late;
    }
    model.strip_prefix("openai/").is_some_and(|rest| {
        rest == "gpt-5"
            || rest.starts_with("gpt-5-")
            || rest.starts_with("o1")
            || rest.starts_with("o3")
            || rest.starts_with("o4")
    })
}

/// `data:<mime>;base64,<data>`.
pub(crate) fn data_url(mime: &str, data: &[u8]) -> String {
    use base64::Engine as _;
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(data)
    )
}

/// A schema or tool name the APIs accept: `[A-Za-z0-9_-]{1,64}`.
pub(crate) fn schema_tool_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "answer".to_owned()
    } else {
        cleaned
    }
}

/// The JSON of a structured answer, without a Markdown fence around it.
pub(crate) fn parse_json_answer(text: &str) -> Result<Value, AiError> {
    let trimmed = text.trim();
    let unfenced = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|rest| rest.trim_end().strip_suffix("```"))
        .map_or(trimmed, str::trim);
    serde_json::from_str(unfenced).map_err(|_| {
        AiError::Invalid("the model's answer isn't the JSON its schema asks for".to_owned())
    })
}

/// A provider's error message: `{ error: { message } }`, `{ message }`,
/// `{ detail }`.
pub(crate) fn error_message_of(value: &Value) -> String {
    let text = value
        .pointer("/error/message")
        .or_else(|| value.get("message"))
        .or_else(|| value.get("detail"))
        .or_else(|| value.get("error"))
        .map_or_else(
            || value.to_string(),
            |v| v.as_str().map_or_else(|| v.to_string(), str::to_owned),
        );
    text.chars().take(300).collect()
}

fn provider_error(provider: ProviderId, status: u16, body: &[u8]) -> AiError {
    let message = match serde_json::from_slice::<Value>(body) {
        Ok(value) => error_message_of(&value),
        Err(_) => String::from_utf8_lossy(body).chars().take(300).collect(),
    };
    AiError::Provider {
        provider,
        status: Some(status),
        message,
    }
}

fn unreachable(provider: ProviderId, message: impl Into<String>) -> AiError {
    AiError::Provider {
        provider,
        status: None,
        message: message.into(),
    }
}

/// The base URL of `provider` on this install (no trailing slash; ending in
/// `/v1` for Anthropic).
fn base_url(config: &AiConfig, provider: ProviderId) -> Result<String, AiError> {
    let configured = policy::endpoint(config, provider)
        .map(|endpoint| endpoint.base_url.trim())
        .filter(|url| !url.is_empty())
        .map(str::to_owned);
    let base = configured
        .or_else(|| catalog::provider(provider).base_url.clone())
        .ok_or_else(|| unreachable(provider, "no base URL configured"))?;
    let base = base.trim_end_matches('/').to_owned();
    Ok(
        if provider == ProviderId::Anthropic && !base.ends_with("/v1") {
            format!("{base}/v1")
        } else {
            base
        },
    )
}

fn url(config: &AiConfig, provider: ProviderId, path: &str) -> Result<String, AiError> {
    Ok(format!("{}{path}", base_url(config, provider)?))
}

/// The key a call to `target` uses: WeldSuite's (optional on an install's
/// own endpoint), or the workspace's own, opened. A missing key is a refusal
/// (the route falls back).
async fn credentials(ai: &Ai, call: &AiCall, target: &Target) -> Result<Option<String>, AiError> {
    let config = ai.config();
    match target.key_source {
        KeySource::Weldsuite => {
            let key = policy::endpoint(config, target.provider)
                .and_then(|e| e.api_key.clone())
                .filter(|k| !k.trim().is_empty());
            if key.is_none() && target.provider != ProviderId::Compat {
                return Err(unreachable(target.provider, "no API key configured"));
            }
            Ok(key)
        }
        KeySource::Own => {
            let (Some(tenant), Some(secret)) = (&call.tenant, &config.keys_encryption_key) else {
                return Err(unreachable(
                    target.provider,
                    "the workspace's own key can't be read",
                ));
            };
            match settings::own_key(tenant, secret, &call.workspace_id, target.provider).await {
                Ok(Some(key)) => Ok(Some(key)),
                Ok(None) => Err(unreachable(target.provider, "the workspace has no own key")),
                Err(error) => {
                    tracing::warn!(%error, provider = target.provider.as_str(), "[weldsuite-ai] the own key can't be opened");
                    Err(unreachable(
                        target.provider,
                        "the workspace's own key can't be opened",
                    ))
                }
            }
        }
    }
}

fn authed(mut request: HttpRequest, provider: ProviderId, key: Option<&str>) -> HttpRequest {
    match provider.api() {
        Api::Anthropic => {
            if let Some(key) = key {
                request = request.header("x-api-key", key);
            }
            request.header("anthropic-version", anthropic::VERSION)
        }
        Api::OpenaiCompatible => match key {
            Some(key) => request.header("authorization", format!("Bearer {key}")),
            None => request,
        },
    }
}

/// How long to wait before retrying a 429: `Retry-After` (seconds), else
/// 1 s, 2 s, …; at most [`MAX_RETRY_DELAY`].
fn retry_delay(retry_after: Option<&str>, attempt: u32) -> Duration {
    let header = retry_after
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|s| s.is_finite() && *s >= 0.0)
        .map(Duration::from_secs_f64);
    header
        .unwrap_or_else(|| Duration::from_secs(1 << attempt.min(4)))
        .min(MAX_RETRY_DELAY)
}

/// Sends `request`, retrying a 429; a non-2xx answer is an error.
async fn send(
    http: &OutboundHttp,
    provider: ProviderId,
    request: HttpRequest,
    timeout: Duration,
) -> Result<HttpResponse, AiError> {
    let mut attempt = 0;
    loop {
        let response = match tokio::time::timeout(timeout, http.send(request.clone())).await {
            Err(_) => {
                return Err(unreachable(
                    provider,
                    format!("timed out after {} s", timeout.as_secs()),
                ));
            }
            Ok(Err(error)) => return Err(unreachable(provider, format!("unreachable: {error}"))),
            Ok(Ok(response)) => response,
        };
        if response.status == 429 && attempt < MAX_RETRIES {
            tokio::time::sleep(retry_delay(response.header("retry-after"), attempt)).await;
            attempt += 1;
            continue;
        }
        if !response.ok() {
            return Err(provider_error(provider, response.status, &response.body));
        }
        return Ok(response);
    }
}

/// [`send`] for a streamed answer: retries a 429, reads a non-2xx answer
/// whole into the error, and hands back the body of a 2xx one unread.
async fn send_streaming(
    http: &OutboundHttp,
    provider: ProviderId,
    request: HttpRequest,
    timeout: Duration,
) -> Result<HttpStreamResponse, AiError> {
    let mut attempt = 0;
    loop {
        let response = match tokio::time::timeout(timeout, http.send_streaming(request.clone()))
            .await
        {
            Err(_) => {
                return Err(unreachable(
                    provider,
                    format!("timed out after {} s", timeout.as_secs()),
                ));
            }
            Ok(Err(error)) => return Err(unreachable(provider, format!("unreachable: {error}"))),
            Ok(Ok(response)) => response,
        };
        if response.ok() {
            return Ok(response);
        }
        let status = response.status;
        let delay = retry_delay(response.header("retry-after"), attempt);
        let body = match tokio::time::timeout(timeout, response.collect()).await {
            Ok(Ok(whole)) => whole.body,
            _ => Vec::new(),
        };
        if status == 429 && attempt < MAX_RETRIES {
            tokio::time::sleep(delay).await;
            attempt += 1;
            continue;
        }
        return Err(provider_error(provider, status, &body));
    }
}

/// Whether a failed attempt on `target` falls back to the next target: a
/// refusal (AI-004's list) or a transport failure. A 401/402/403 on an own
/// key marks it `failing`.
async fn falls_back(ai: &Ai, call: &AiCall, target: &Target, error: &AiError) -> bool {
    let AiError::Provider {
        status, message, ..
    } = error
    else {
        return false;
    };
    if target.key_source == KeySource::Own
        && fallback::is_key_failure(*status)
        && let Some(tenant) = &call.tenant
    {
        if let Err(error) = settings::mark_key(tenant, target.provider, Some(message)).await {
            tracing::warn!(%error, "[weldsuite-ai] could not mark the own key failing");
        }
        ai.invalidate(&call.workspace_id).await;
    }
    let refusal = status.is_none() || fallback::is_provider_refusal(*status, message);
    if refusal {
        tracing::warn!(
            workspace = %call.workspace_id,
            feature = call.feature.as_str(),
            provider = target.provider.as_str(),
            model = %target.model,
            status,
            "[weldsuite-ai] the provider refused the call"
        );
    }
    refusal
}

fn served(route: &Route, index: usize, target: &Target) -> Served {
    Served {
        provider: target.provider,
        model: target.model.clone(),
        region: target.region,
        key_source: target.key_source,
        fallback_from: (index > 0).then(|| route.primary.model.clone()),
    }
}

fn log_call(call: &AiCall, target: &Target, usage: Usage, started: Instant) {
    tracing::info!(
        workspace = %call.workspace_id,
        feature = call.feature.as_str(),
        provider = target.provider.as_str(),
        model = %target.model,
        key_source = target.key_source.as_str(),
        input_tokens = usage.input_tokens,
        output_tokens = usage.output_tokens,
        latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "[weldsuite-ai] call"
    );
}

/// The body and URL of a chat call on `target`.
fn chat_request(
    config: &AiConfig,
    target: &Target,
    request: &ChatRequest,
    stream: bool,
    key: Option<&str>,
) -> Result<HttpRequest, AiError> {
    let (path, body) = match target.provider.api() {
        Api::Anthropic => (
            "/messages",
            anthropic::messages_body(target, request, stream),
        ),
        Api::OpenaiCompatible => (
            "/chat/completions",
            openai_compat::chat_body(Dialect::of(target.provider), target, request, stream),
        ),
    };
    let http = HttpRequest::json("POST", url(config, target.provider, path)?, &body);
    Ok(authed(http, target.provider, key))
}

/// One chat attempt on `target`.
async fn chat_once(
    ai: &Ai,
    call: &AiCall,
    target: &Target,
    request: &ChatRequest,
) -> Result<ChatAnswer, AiError> {
    let key = credentials(ai, call, target).await?;
    let _permit = ai.permit(call, target).await;
    let started = Instant::now();
    let http = chat_request(ai.config(), target, request, false, key.as_deref())?;
    let response = send(ai.http(), target.provider, http, CHAT_TIMEOUT).await?;
    let body = response.json();
    let answer = match target.provider.api() {
        Api::Anthropic => anthropic::parse_message(&body, request)?,
        Api::OpenaiCompatible => openai_compat::parse_chat(target.provider, &body, request)?,
    };
    log_call(call, target, answer.usage, started);
    Ok(answer)
}

async fn respond(
    ai: &Ai,
    call: &AiCall,
    route: &Route,
    index: usize,
    target: &Target,
    answer: ChatAnswer,
) -> ChatResponse {
    let cost = billing::provider_cost_usd(&target.model, answer.usage, 0, 0.0);
    let credits = billing::charge(ai.config(), call, target, cost, answer.usage).await;
    ChatResponse {
        text: answer.text,
        tool_calls: answer.tool_calls,
        object: answer.object,
        usage: answer.usage,
        finish_reason: answer.finish_reason,
        served: served(route, index, target),
        credits,
    }
}

pub(crate) async fn chat(
    ai: &Ai,
    call: &AiCall,
    route: &Route,
    request: ChatRequest,
) -> Result<ChatResponse, AiError> {
    let mut last = None;
    for (index, target) in route.targets().enumerate() {
        match chat_once(ai, call, target, &request).await {
            Ok(answer) => return Ok(respond(ai, call, route, index, target, answer).await),
            Err(error) => {
                if !falls_back(ai, call, target, &error).await {
                    return Err(error);
                }
                last = Some(error);
            }
        }
    }
    Err(last.unwrap_or(AiError::Unavailable))
}

/// A streamed answer being decoded.
enum Decoder {
    OpenAi(openai_compat::StreamDecoder),
    Anthropic(Box<anthropic::StreamDecoder>),
}

impl Decoder {
    fn push(&mut self, event: &SseEvent) -> Result<Vec<StreamEvent>, AiError> {
        match self {
            Self::OpenAi(decoder) => decoder.push(event),
            Self::Anthropic(decoder) => decoder.push(event),
        }
    }
}

struct StreamState {
    ai: Ai,
    call: AiCall,
    route: Route,
    index: usize,
    target: Target,
    body: Box<dyn HttpBodyStream>,
    parser: SseParser,
    decoder: Option<Decoder>,
    pending: VecDeque<Result<StreamEvent, AiError>>,
    done: bool,
    started: Instant,
    _permit: Option<OwnedSemaphorePermit>,
}

impl StreamState {
    fn handle(&mut self, events: Vec<SseEvent>) {
        for event in events {
            let Some(decoder) = self.decoder.as_mut() else {
                return;
            };
            match decoder.push(&event) {
                Ok(events) => self.pending.extend(events.into_iter().map(Ok)),
                Err(error) => {
                    self.fail(error);
                    return;
                }
            }
        }
    }

    fn fail(&mut self, error: AiError) {
        tracing::warn!(
            workspace = %self.call.workspace_id,
            provider = self.target.provider.as_str(),
            model = %self.target.model,
            "[weldsuite-ai] the stream broke off"
        );
        self.pending.push_back(Err(error));
        self.decoder = None;
        self.done = true;
    }

    async fn complete(&mut self) {
        let Some(decoder) = self.decoder.take() else {
            self.done = true;
            return;
        };
        let (answer, emit_calls) = match decoder {
            Decoder::OpenAi(decoder) => (decoder.finish(), true),
            Decoder::Anthropic(decoder) => (decoder.finish(), false),
        };
        match answer {
            Ok(answer) => {
                log_call(&self.call, &self.target, answer.usage, self.started);
                if emit_calls {
                    for call in &answer.tool_calls {
                        self.pending
                            .push_back(Ok(StreamEvent::ToolCall(call.clone())));
                    }
                }
                let response = respond(
                    &self.ai,
                    &self.call,
                    &self.route,
                    self.index,
                    &self.target,
                    answer,
                )
                .await;
                self.pending
                    .push_back(Ok(StreamEvent::Finish(Box::new(response))));
            }
            Err(error) => self.pending.push_back(Err(error)),
        }
        self.done = true;
    }
}

/// Opens a stream on `target`: its key, a concurrency permit, and the answer
/// head.
async fn open_stream(
    ai: &Ai,
    call: &AiCall,
    target: &Target,
    request: &ChatRequest,
) -> Result<(HttpStreamResponse, Option<OwnedSemaphorePermit>), AiError> {
    let key = credentials(ai, call, target).await?;
    let permit = ai.permit(call, target).await;
    let http = chat_request(ai.config(), target, request, true, key.as_deref())?;
    let response = send_streaming(ai.http(), target.provider, http, CHAT_TIMEOUT).await?;
    Ok((response, permit))
}

pub(crate) async fn chat_stream(
    ai: &Ai,
    call: &AiCall,
    route: &Route,
    request: ChatRequest,
) -> Result<ChatStream, AiError> {
    let mut last = None;
    for (index, target) in route.targets().enumerate() {
        match open_stream(ai, call, target, &request).await {
            Ok((response, permit)) => {
                let decoder = match target.provider.api() {
                    Api::Anthropic => {
                        Decoder::Anthropic(Box::new(anthropic::StreamDecoder::new(&request)))
                    }
                    Api::OpenaiCompatible => Decoder::OpenAi(openai_compat::StreamDecoder::new(
                        target.provider,
                        &request,
                    )),
                };
                let state = StreamState {
                    ai: ai.clone(),
                    call: call.clone(),
                    route: route.clone(),
                    index,
                    target: target.clone(),
                    body: response.body,
                    parser: SseParser::default(),
                    decoder: Some(decoder),
                    pending: VecDeque::new(),
                    done: false,
                    started: Instant::now(),
                    _permit: permit,
                };
                let stream = futures_util::stream::unfold(state, |mut state| async move {
                    loop {
                        if let Some(item) = state.pending.pop_front() {
                            return Some((item, state));
                        }
                        if state.done {
                            return None;
                        }
                        match tokio::time::timeout(CHAT_TIMEOUT, state.body.next_chunk()).await {
                            Ok(Ok(Some(chunk))) => {
                                let events = state.parser.push(&chunk);
                                state.handle(events);
                            }
                            Ok(Ok(None)) => {
                                let events = state.parser.finish();
                                state.handle(events);
                                if !state.done {
                                    state.complete().await;
                                }
                            }
                            Ok(Err(error)) => {
                                let provider = state.target.provider;
                                state.fail(unreachable(
                                    provider,
                                    format!("the stream broke off: {error}"),
                                ));
                            }
                            Err(_) => {
                                let provider = state.target.provider;
                                state.fail(unreachable(provider, "the stream stalled"));
                            }
                        }
                    }
                });
                return Ok(stream.boxed());
            }
            Err(error) => {
                if !falls_back(ai, call, target, &error).await {
                    return Err(error);
                }
                last = Some(error);
            }
        }
    }
    Err(last.unwrap_or(AiError::Unavailable))
}

/// Whether `target` is an OCR endpoint model (Mistral OCR), not a chat model
/// reading the file.
fn is_ocr_model(target: &Target) -> bool {
    target.provider == ProviderId::Mistral
        && catalog::model(&target.model).is_some_and(|m| m.has(Capability::Ocr))
}

/// What one OCR attempt read.
struct OcrRead {
    pages: Vec<OcrPage>,
    object: Option<Value>,
    usage: Usage,
    cost: f64,
}

async fn ocr_endpoint(
    ai: &Ai,
    call: &AiCall,
    target: &Target,
    document: &Document,
) -> Result<OcrRead, AiError> {
    let key = credentials(ai, call, target).await?;
    let _permit = ai.permit(call, target).await;
    let started = Instant::now();
    let body = mistral_ocr::ocr_body(target, document);
    let http = authed(
        HttpRequest::json("POST", url(ai.config(), target.provider, "/ocr")?, &body),
        target.provider,
        key.as_deref(),
    );
    let response = send(ai.http(), target.provider, http, LONG_TIMEOUT).await?;
    let answer = mistral_ocr::parse_ocr(&response.json(), document)?;
    log_call(call, target, Usage::default(), started);
    Ok(OcrRead {
        cost: billing::ocr_cost_usd(
            &target.model,
            answer.pages_processed,
            document.extract.is_some(),
        ),
        pages: answer.pages,
        object: answer.object,
        usage: Usage::default(),
    })
}

const READ_DOCUMENT: &str =
    "You read documents. Transcribe the document faithfully as Markdown, keeping its tables.";

/// A chat model with native file input reads the document.
async fn ocr_by_chat(
    ai: &Ai,
    call: &AiCall,
    target: &Target,
    document: &Document,
) -> Result<OcrRead, AiError> {
    let file = if document.mime.starts_with("image/") {
        Part::Image {
            mime: document.mime.clone(),
            data: document.data.clone(),
        }
    } else {
        Part::Document {
            mime: document.mime.clone(),
            name: document.name.clone(),
            data: document.data.clone(),
        }
    };
    let instruction = document
        .prompt
        .clone()
        .unwrap_or_else(|| "Transcribe this document.".to_owned());
    let mut request = ChatRequest {
        system: Some(READ_DOCUMENT.to_owned()),
        messages: vec![Message {
            role: Role::User,
            content: vec![file, Part::Text(instruction)],
        }],
        ..ChatRequest::default()
    };
    if let Some(extract) = &document.extract {
        request.response_schema = Some(JsonSchema {
            name: extract.name.clone(),
            schema: json!({
                "type": "object",
                "properties": {
                    "markdown": { "type": "string", "description": "The whole document as Markdown." },
                    "fields": extract.schema,
                },
                "required": ["markdown", "fields"],
            }),
        });
    }
    let answer = chat_once(ai, call, target, &request).await?;
    let (markdown, object) = match answer.object {
        Some(object) => (
            object
                .get("markdown")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            object.get("fields").cloned(),
        ),
        None => (answer.text, None),
    };
    Ok(OcrRead {
        pages: vec![OcrPage { index: 0, markdown }],
        object,
        usage: answer.usage,
        cost: billing::provider_cost_usd(&target.model, answer.usage, 0, 0.0),
    })
}

pub(crate) async fn ocr(
    ai: &Ai,
    call: &AiCall,
    route: &Route,
    document: Document,
) -> Result<OcrResponse, AiError> {
    let mut last = None;
    for (index, target) in route.targets().enumerate() {
        let attempt = if is_ocr_model(target) {
            ocr_endpoint(ai, call, target, &document).await
        } else {
            ocr_by_chat(ai, call, target, &document).await
        };
        match attempt {
            Ok(read) => {
                let credits =
                    billing::charge(ai.config(), call, target, read.cost, read.usage).await;
                return Ok(OcrResponse {
                    pages: read.pages,
                    object: read.object,
                    usage: read.usage,
                    served: served(route, index, target),
                    credits,
                });
            }
            Err(error) => {
                if !falls_back(ai, call, target, &error).await {
                    return Err(error);
                }
                last = Some(error);
            }
        }
    }
    Err(last.unwrap_or(AiError::Unavailable))
}

pub(crate) async fn embed(
    ai: &Ai,
    call: &AiCall,
    route: &Route,
    inputs: &[String],
) -> Result<EmbedResponse, AiError> {
    if inputs.is_empty() {
        return Ok(EmbedResponse {
            vectors: Vec::new(),
            usage: Usage::default(),
            served: served(route, 0, &route.primary),
            credits: 0,
        });
    }
    let mut last = None;
    for (index, target) in route.targets().enumerate() {
        if target.provider.api() != Api::OpenaiCompatible {
            return Err(AiError::Unavailable);
        }
        let attempt = async {
            let key = credentials(ai, call, target).await?;
            let _permit = ai.permit(call, target).await;
            let started = Instant::now();
            let body = embeddings::embed_body(target, inputs);
            let http = authed(
                HttpRequest::json(
                    "POST",
                    url(ai.config(), target.provider, "/embeddings")?,
                    &body,
                ),
                target.provider,
                key.as_deref(),
            );
            let response = send(ai.http(), target.provider, http, CHAT_TIMEOUT).await?;
            let (vectors, usage) =
                embeddings::parse_embeddings(target.provider, &response.json(), inputs.len())?;
            log_call(call, target, usage, started);
            Ok::<_, AiError>((vectors, usage))
        }
        .await;
        match attempt {
            Ok((vectors, usage)) => {
                let cost = billing::provider_cost_usd(&target.model, usage, 0, 0.0);
                let credits = billing::charge(ai.config(), call, target, cost, usage).await;
                return Ok(EmbedResponse {
                    vectors,
                    usage,
                    served: served(route, index, target),
                    credits,
                });
            }
            Err(error) => {
                if !falls_back(ai, call, target, &error).await {
                    return Err(error);
                }
                last = Some(error);
            }
        }
    }
    Err(last.unwrap_or(AiError::Unavailable))
}

/// A multipart boundary no audio is likely to contain.
fn boundary() -> String {
    use aws_lc_rs::rand::SecureRandom as _;
    let mut bytes = [0_u8; 12];
    if aws_lc_rs::rand::SystemRandom::new()
        .fill(&mut bytes)
        .is_err()
    {
        return "weldsuite-ai-boundary-7f3e9a".to_owned();
    }
    format!("weldsuite-ai-{}", hex::encode(bytes))
}

pub(crate) async fn transcribe(
    ai: &Ai,
    call: &AiCall,
    route: &Route,
    audio: Audio,
) -> Result<TranscribeResponse, AiError> {
    let mut last = None;
    for (index, target) in route.targets().enumerate() {
        if target.provider.api() != Api::OpenaiCompatible {
            return Err(AiError::Unavailable);
        }
        let attempt = async {
            let key = credentials(ai, call, target).await?;
            let _permit = ai.permit(call, target).await;
            let started = Instant::now();
            let (body, content_type) =
                transcription::transcription_body(target, &audio, &boundary());
            let mut http = HttpRequest::empty(
                "POST",
                url(ai.config(), target.provider, "/audio/transcriptions")?,
            )
            .header("content-type", content_type);
            http.body = Some(body);
            let http = authed(http, target.provider, key.as_deref());
            let response = send(ai.http(), target.provider, http, LONG_TIMEOUT).await?;
            let answer = transcription::parse_transcription(&response.json());
            log_call(call, target, Usage::default(), started);
            Ok::<_, AiError>(answer)
        }
        .await;
        match attempt {
            Ok(answer) => {
                let seconds = answer.duration_seconds.unwrap_or(0.0);
                let cost = billing::provider_cost_usd(&target.model, Usage::default(), 0, seconds);
                let credits =
                    billing::charge(ai.config(), call, target, cost, Usage::default()).await;
                return Ok(TranscribeResponse {
                    text: answer.text,
                    segments: answer.segments,
                    duration_seconds: answer.duration_seconds,
                    served: served(route, index, target),
                    credits,
                });
            }
            Err(error) => {
                if !falls_back(ai, call, target, &error).await {
                    return Err(error);
                }
                last = Some(error);
            }
        }
    }
    Err(last.unwrap_or(AiError::Unavailable))
}

/// Checks a key with the provider (a cheap `GET /models`), as `PUT
/// /api/ai-settings/keys/:provider` does before storing it.
pub(crate) async fn check_key(ai: &Ai, provider: ProviderId, key: &str) -> Result<(), AiError> {
    let http = authed(
        HttpRequest::empty("GET", url(ai.config(), provider, "/models")?),
        provider,
        Some(key.trim()),
    );
    send(ai.http(), provider, http, Duration::from_secs(15))
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests;
