//! A scripted model server for unit tests: every provider's HTTP calls are
//! answered by the queued replies, and every request is recorded so a test
//! can assert which provider and model was called (and that a disabled one
//! never was).

use std::sync::{Arc, Mutex};

use weldsuite_ports::{HttpRequest, HttpResponse, OutboundHttp};

/// One recorded request.
#[derive(Debug, Clone)]
pub struct FakeCall {
    pub url: String,
    pub body: serde_json::Value,
    pub headers: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default)]
pub struct FakeProvider {
    replies: Arc<Mutex<Vec<HttpResponse>>>,
    calls: Arc<Mutex<Vec<FakeCall>>>,
}

impl FakeProvider {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue an OpenAI-compatible chat completion answering `text`.
    #[must_use]
    pub fn reply_text(self, text: &str) -> Self {
        let _ = text;
        todo!("AI-012 phase 1")
    }

    /// Queue an OpenAI-compatible chat completion answering `object` as JSON.
    #[must_use]
    pub fn reply_json(self, object: &serde_json::Value) -> Self {
        let _ = object;
        todo!("AI-012 phase 1")
    }

    /// Queue an error status (a refusal, for fallback tests).
    #[must_use]
    pub fn reply_status(self, status: u16, body: &str) -> Self {
        let _ = (status, body);
        todo!("AI-012 phase 1")
    }

    /// Queue a raw answer.
    #[must_use]
    pub fn reply(self, response: HttpResponse) -> Self {
        self.replies
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(response);
        self
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
        let _ = HttpRequest::empty("GET", "");
        todo!("AI-012 phase 1")
    }
}
