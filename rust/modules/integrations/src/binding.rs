//! Service bindings: the integration workers' calls into another worker
//! (`BOOKS_INTERNAL`, books-api's `BooksInternal` entrypoint; later
//! `CONNECT_INTERNAL`). The port is the binding itself, a request on a path
//! and the worker's answer, so every implementation answers as that worker's
//! internal route does:
//!
//! - in the binary, the other module runs in the same process
//!   ([`crate::books::InProcessBooks`] for WeldBooks' bank-feed routes);
//! - in conformance builds, the test's own stub through the harness's
//!   service-binding bridge (`bins/weldsuite/src/conformance_books.rs`), or
//!   none when the test binds none, as the worker then runs without it.

use std::sync::Arc;

use weldsuite_ports::BoxFuture;

/// One call over a binding (`binding.fetch('https://internal<path>', init)`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindingRequest {
    pub method: String,
    /// The path on the other worker, `/internal/bank-connections/events`.
    pub path: String,
    /// `X-Workspace-Id`: the workspace's Clerk org id, which the other worker
    /// resolves the tenant by.
    pub workspace_key: String,
    /// The body as sent (JSON), none for a bodyless call.
    pub body: Option<String>,
}

/// The other worker's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindingResponse {
    pub status: u16,
    pub body: String,
}

impl BindingResponse {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The body as JSON, `Null` when it isn't.
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

/// A service binding. An `Err` is a call that never got an answer
/// (`binding.fetch` threw); its text is the error's message.
pub trait ServiceBinding: Send + Sync {
    fn fetch(&self, request: BindingRequest) -> BoxFuture<'_, Result<BindingResponse, String>>;
}

/// A request's own `BOOKS_INTERNAL` (conformance: the test's stub, or none),
/// ahead of the app's.
#[derive(Clone)]
pub struct RequestBooksBinding(pub Option<Arc<dyn ServiceBinding>>);

impl std::fmt::Debug for RequestBooksBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RequestBooksBinding")
    }
}
