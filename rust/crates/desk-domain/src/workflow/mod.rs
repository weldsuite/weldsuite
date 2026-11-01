//! The helpdesk workflow engine (`apps/workers/helpdesk-workflow-worker`).
//!
//! On Global the engine is its own worker, reached over the
//! `HELPDESK_WORKFLOW` service binding: the desk API forwards a customer's
//! answer to an interactive step to its `/respond`
//! (`desk-api/src/routes/helpdesk-workflows/index.ts`), and the Discord
//! ingest posts conversation events to its `/event`. Here the routes call
//! the [`WorkflowEngine`] port: [`InProcessEngine`] runs it in this process
//! (runs are `desk.conversation-workflow` jobs, [`ConversationWorkflowJob`]),
//! [`Unavailable`] answers as TypeScript does without the binding.
//!
//! - [`shared`] (`lib/workflow-shared.ts`): templates, conditions,
//!   conversation ids, JavaScript value semantics.
//! - [`handlers`] (`engine/handlers/*`, `workflows/step-executor.ts`): the
//!   registered step handlers and the executor.
//! - [`dispatch`] (`lib/channel-dispatch.ts`): a step's output to Discord or
//!   Slack.
//! - [`job`] (`workflows/conversation-workflow.ts`): the run.
//! - [`engine`] (`index.ts` `/event` and `/respond`).
//!
//! The worker's `AssignmentRouter` Durable Object is
//! [`crate::assignment_router`]. Its SLA breach cron is not ported: the
//! worker schedules none (`crons = []` in every environment).

pub mod dispatch;
pub mod engine;
pub mod handlers;
pub mod job;
pub mod shared;

use std::sync::Arc;

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_ports::BoxFuture;

pub use engine::InProcessEngine;
pub use job::{
    CONVERSATION_WORKFLOW_JOB, ConversationWorkflowJob, ConversationWorkflowParams, EngineDeps,
};

/// Opens a workspace's tenant database by its id or Clerk org id.
pub type TenantDatabases =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<PgPool, String>> + Send + Sync>;

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

    /// `POST /event` with `body` (`{ type, conversationId, workspaceId,
    /// data }`): start a run for a conversation event.
    fn event<'a>(&'a self, body: &'a Value) -> BoxFuture<'a, Result<EngineResponse, EngineError>> {
        let _ = body;
        Box::pin(async { Err(EngineError::Unavailable) })
    }
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
