//! The provider adapters and the call loop around them: shape the request
//! for the target's API, send it (10 s connect, 120 s overall, 300 s for OCR
//! and transcription; 429 retried with backoff, honouring `Retry-After`),
//! walk the route's fallbacks on a refusal, mark a failing own key, and meter
//! the target that served.
//!
//! - `openai_compat`: chat completions for Mistral, OpenAI, vLLM and Ollama
//!   (tools, `json_schema`, SSE streaming, image and document parts).
//! - `anthropic`: the Messages API (tools, structured output through a forced
//!   tool call, files, streaming). Anthropic's OpenAI-compatible endpoint is
//!   for testing only, so it isn't used.
//! - `mistral_ocr`: `POST /v1/ocr`, with document annotations.
//! - `transcription`: `/audio/transcriptions` (Voxtral).
//!
//! Logs and traces carry the workspace, feature, provider, model, tokens and
//! latency, never prompts or completions.

use crate::error::AiError;
use crate::policy::Route;
use crate::types::{
    Audio, ChatRequest, ChatResponse, ChatStream, Document, EmbedResponse, OcrResponse,
    TranscribeResponse,
};
use crate::{Ai, AiCall};

pub(crate) async fn chat(ai: &Ai, call: &AiCall, route: &Route, request: ChatRequest) -> Result<ChatResponse, AiError> {
    let _ = (ai.http(), ai.fake_provider(), call, route, request);
    todo!("AI-012 phase 1")
}

pub(crate) async fn chat_stream(ai: &Ai, call: &AiCall, route: &Route, request: ChatRequest) -> Result<ChatStream, AiError> {
    let _ = (ai, call, route, request);
    todo!("AI-012 phase 1")
}

pub(crate) async fn ocr(ai: &Ai, call: &AiCall, route: &Route, document: Document) -> Result<OcrResponse, AiError> {
    let _ = (ai, call, route, document);
    todo!("AI-012 phase 1")
}

pub(crate) async fn embed(ai: &Ai, call: &AiCall, route: &Route, inputs: &[String]) -> Result<EmbedResponse, AiError> {
    let _ = (ai, call, route, inputs);
    todo!("AI-012 phase 1")
}

pub(crate) async fn transcribe(ai: &Ai, call: &AiCall, route: &Route, audio: Audio) -> Result<TranscribeResponse, AiError> {
    let _ = (ai, call, route, audio);
    todo!("AI-012 phase 1")
}
