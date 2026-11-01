//! Starting, cancelling and resuming workflow runs: the `EXECUTE_WORKFLOW`
//! Workflow binding (`ExecuteWorkflowWorkflow` in workflow-worker) on
//! Global, the [`EXECUTE_WORKFLOW_JOB`] job on the Kubernetes editions.
//!
//! - `binding.create({ params })` → [`WorkflowRuns::create`]: a new run
//!   under a fresh instance id (Cloudflare picks one; here a UUID-shaped key).
//! - `(await binding.get(id)).terminate()` → [`WorkflowRuns::terminate`]:
//!   jobs cannot be killed from outside, so the run is woken with
//!   [`CANCEL_SIGNAL`]; it reads its row (already `cancelled`) and stops
//!   before its next step.
//! - `(await binding.get(id)).sendEvent({ type, payload })` →
//!   [`WorkflowRuns::send_event`]: a signal. A signal carries no payload, so
//!   the run reads the decision the route wrote on the step row.

use std::sync::Arc;

use serde_json::Value;
use weldsuite_ports::{BoxFuture, DynJobs, JobRequest};

/// The job a run is (`ExecuteWorkflowWorkflow`).
pub const EXECUTE_WORKFLOW_JOB: &str = "connect.execute-workflow";

/// The event an approval resumes a waiting run with (`resume-step`).
pub const RESUME_SIGNAL: &str = "resume-step";

/// What a cancelled run is woken with, so a parked wait sees its row.
pub const CANCEL_SIGNAL: &str = "cancel";

/// The `EXECUTE_WORKFLOW` binding as the routes use it. `Err` carries the
/// message of what the binding threw.
pub trait WorkflowRuns: Send + Sync {
    /// `binding.create({ params })`: the new instance's id.
    fn create<'a>(&'a self, params: &'a Value) -> BoxFuture<'a, Result<String, String>>;

    /// `(await binding.get(id)).terminate()`.
    fn terminate<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), String>>;

    /// `(await binding.get(id)).sendEvent({ type, payload })`.
    fn send_event<'a>(
        &'a self,
        id: &'a str,
        event_type: &'a str,
        payload: &'a Value,
    ) -> BoxFuture<'a, Result<(), String>>;
}

/// A request's own `EXECUTE_WORKFLOW` (conformance): the test's binding, or
/// none when the test has none.
#[derive(Clone)]
pub struct RequestWorkflowRuns(pub Option<Arc<dyn WorkflowRuns>>);

/// Runs as jobs of this deployment.
pub struct JobsWorkflowRuns {
    pub jobs: Arc<dyn DynJobs>,
}

/// A Cloudflare-style instance id: 32 lowercase hex characters.
fn instance_id() -> String {
    weldsuite_kit::random_string(32, "0123456789abcdef")
}

impl WorkflowRuns for JobsWorkflowRuns {
    fn create<'a>(&'a self, params: &'a Value) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let id = instance_id();
            let request = JobRequest::new(EXECUTE_WORKFLOW_JOB, id.clone(), params)
                .map_err(|error| error.to_string())?;
            self.jobs
                .start_boxed(request)
                .await
                .map_err(|error| error.to_string())?;
            Ok(id)
        })
    }

    fn terminate<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.jobs
                .signal_boxed(EXECUTE_WORKFLOW_JOB, id, CANCEL_SIGNAL)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
    }

    fn send_event<'a>(
        &'a self,
        id: &'a str,
        event_type: &'a str,
        _payload: &'a Value,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.jobs
                .signal_boxed(EXECUTE_WORKFLOW_JOB, id, event_type)
                .await
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
    }
}
