//! `BOOKS_INTERNAL`: books-api's `BooksInternal` entrypoint, the service
//! binding hr-api posts an approved pay run's journal over
//! (`POST /internal/payroll/imports`, `createBooksBridge` in
//! `services/weldhr/payroll/deps.ts`).
//!
//! The port is the binding itself: a request (path, the workspace key the
//! binding sends as `X-Workspace-Id`, a JSON body) and books-api's answer
//! (status and body). What the answer means (posted, a duplicate, reversed,
//! failed) is read in [`crate::payroll`], as the TypeScript bridge reads it,
//! so every implementation answers the way books-api's route does:
//!
//! - in conformance builds, the test's own `BOOKS_INTERNAL` stub through the
//!   harness's service-binding bridge (`bins/weldsuite/src/conformance_books.rs`);
//! - once WeldBooks is ported, an in-process adapter in the binary that runs
//!   the payroll import of `weldsuite-books-domain` on the workspace's
//!   database and answers with what the route would (status and JSON);
//! - until then none: the journal is skipped with the worker's own message
//!   for a missing binding, and approving still works (the run shows the
//!   journal as skipped, and `POST /payroll/runs/:id/post-journal` posts it
//!   once WeldBooks is there).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

/// One call over the binding.
#[derive(Debug, Clone, PartialEq)]
pub struct BooksRequest {
    /// `POST`.
    pub method: String,
    /// The path on books-api, `/internal/payroll/imports`.
    pub path: String,
    /// `X-Workspace-Id`: the workspace's R2 key (its Clerk org id), what
    /// books-api resolves the tenant by.
    pub workspace_key: String,
    /// The JSON body.
    pub body: Value,
}

/// books-api's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BooksResponse {
    pub status: u16,
    /// The body as books-api sent it (JSON, normally).
    pub body: String,
}

/// The `BOOKS_INTERNAL` binding. An `Err` is a call that never got an answer
/// (`binding.fetch` threw); its text is what the journal records.
pub trait BooksInternal: Send + Sync {
    fn call(
        &self,
        request: BooksRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BooksResponse, String>> + Send + '_>>;
}

/// A request's own binding (conformance: the test's stub), ahead of the
/// app's.
#[derive(Clone)]
pub struct RequestBooksInternal(pub Arc<dyn BooksInternal>);

impl std::fmt::Debug for RequestBooksInternal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RequestBooksInternal")
    }
}
