//! `CONNECT_INTERNAL`: the integration workers' calls into connect-api's
//! internal integration routes (`/api/integrations/connections/:id/sync`,
//! `/renew-watch`, …), `fetchConnectInternal(env, path, init)`. On Global
//! that is the `ConnectInternal` entrypoint over a service binding; here the
//! binary answers in process from WeldConnect's internal router, and
//! conformance builds send the call to the test's stub through the
//! service-binding bridge.

use std::sync::Arc;

use weldsuite_ports::BoxFuture;

use crate::binding::BindingResponse;

/// One call (`binding.fetch('https://internal<path>', { method, headers, body })`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectCall {
    pub method: String,
    /// `/api/integrations/connections/<id>/sync`.
    pub path: String,
    /// The headers as the worker sets them (`X-Workspace-Id` or
    /// `X-Internal-Workspace-Id`, `Content-Type`).
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

impl ConnectCall {
    /// A POST with `Content-Type: application/json` and one workspace header.
    pub fn post(
        path: String,
        workspace_header: &str,
        workspace: &str,
        body: Option<String>,
    ) -> Self {
        Self {
            method: "POST".to_owned(),
            path,
            headers: vec![
                ("Content-Type".to_owned(), "application/json".to_owned()),
                (workspace_header.to_owned(), workspace.to_owned()),
            ],
            body,
        }
    }
}

/// connect-api's internal routes. An `Err` is a call that never got an
/// answer (the binding threw); its text is the error's message.
pub trait ConnectInternal: Send + Sync {
    fn fetch(&self, call: ConnectCall) -> BoxFuture<'_, Result<BindingResponse, String>>;
}

/// A request's own `CONNECT_INTERNAL` (conformance: the test's stub, or
/// none), ahead of the app's.
#[derive(Clone)]
pub struct RequestConnectInternal(pub Option<Arc<dyn ConnectInternal>>);

impl std::fmt::Debug for RequestConnectInternal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RequestConnectInternal")
    }
}
