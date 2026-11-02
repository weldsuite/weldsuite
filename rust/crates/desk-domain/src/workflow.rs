//! The helpdesk workflow engine, as the desk API reaches it: the
//! `HELPDESK_WORKFLOW` service binding to `helpdesk-workflow-worker`
//! (`desk-api/src/routes/helpdesk-workflows/index.ts`, the resume route
//! forwards a customer's response to the engine's `/respond`).
//!
//! The engine is not ported yet. When it is, the monolith implements
//! [`WorkflowEngine`] in process; until then [`Unavailable`] stands in, and
//! the routes answer exactly as TypeScript does when the binding is unset.

use std::sync::Arc;

use serde_json::Value;
use weldsuite_ports::BoxFuture;

/// Why the engine could not take a call.
#[derive(Debug)]
pub enum EngineError {
    /// No engine in this deployment (TypeScript: `HELPDESK_WORKFLOW` unset).
    Unavailable,
    /// The engine answered with an error status, and this body.
    Failed { status: u16, body: String },
}

/// The engine's answer to a forwarded call: its status and JSON body.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineResponse {
    pub status: u16,
    pub body: Value,
}

/// `helpdesk-workflow-worker`, as the desk API calls it.
pub trait WorkflowEngine: Send + Sync {
    /// `POST /respond` with `body`: resume a waiting execution with the
    /// customer's response.
    fn respond<'a>(&'a self, body: &'a Value)
    -> BoxFuture<'a, Result<EngineResponse, EngineError>>;
}

/// No engine: every call is [`EngineError::Unavailable`].
#[derive(Debug, Clone, Copy, Default)]
pub struct Unavailable;

impl WorkflowEngine for Unavailable {
    fn respond<'a>(
        &'a self,
        _body: &'a Value,
    ) -> BoxFuture<'a, Result<EngineResponse, EngineError>> {
        Box::pin(async { Err(EngineError::Unavailable) })
    }
}

/// The engine a deployment has, shared by the routes.
pub type DynWorkflowEngine = Arc<dyn WorkflowEngine>;
