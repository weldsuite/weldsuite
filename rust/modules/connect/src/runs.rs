//! Starting, cancelling and resuming workflow runs: the `EXECUTE_WORKFLOW`
//! Workflow binding (`ExecuteWorkflowWorkflow` in workflow-worker) on
//! Global, the [`EXECUTE_WORKFLOW_JOB`] job on the Kubernetes editions.
//!
//! - `binding.create({ params })` → [`WorkflowRuns::create`]: a new run
//!   under a fresh instance id (Cloudflare picks one; here a UUID-shaped key).
//! - `(await binding.get(id)).terminate()` → [`WorkflowRuns::terminate`]:
//!   jobs cannot be killed from outside, so the run is woken with
//!   [`RESUME_SIGNAL`] (a parked wait is the one place a run idles); it
//!   reads its row (already `cancelled`) and stops. A run between steps
//!   checks its row before the next one.
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

/// The `EXECUTE_WORKFLOW` binding as the routes use it. `Err` carries the
/// message of what the binding threw.
pub trait WorkflowRuns: Send + Sync {
    /// `binding.create({ params })`: the new instance's id.
    fn create<'a>(&'a self, params: &'a Value) -> BoxFuture<'a, Result<String, String>>;

    /// `binding.create({ id, params })`: a run under `id` when given (one
    /// run per id), else a fresh one; the instance's id.
    fn start<'a>(
        &'a self,
        id: Option<&'a str>,
        params: &'a Value,
    ) -> BoxFuture<'a, Result<String, String>> {
        match id {
            None => self.create(params),
            Some(_) => Box::pin(std::future::ready(Err(
                "this binding starts runs under fresh ids only".to_owned(),
            ))),
        }
    }

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
        self.start(None, params)
    }

    fn start<'a>(
        &'a self,
        id: Option<&'a str>,
        params: &'a Value,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let id = id.map_or_else(instance_id, str::to_owned);
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
                .signal_boxed(EXECUTE_WORKFLOW_JOB, id, RESUME_SIGNAL)
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

/// The `GITHUB_PROJECT_SYNC` binding (`GithubProjectSyncWorkflow`, hosted by
/// integration-webhook-worker on Global). The Kubernetes editions do not run
/// that worker yet, so they have none and the sync route answers as Global
/// does without the binding. `Err` carries what the binding threw.
pub trait ProjectSyncRuns: Send + Sync {
    /// `binding.create({ id, params })`.
    fn create<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, Result<(), String>>;
}

/// A request's own `GITHUB_PROJECT_SYNC` (conformance): the test's binding,
/// or none.
#[derive(Clone)]
pub struct RequestProjectSyncRuns(pub Option<Arc<dyn ProjectSyncRuns>>);
