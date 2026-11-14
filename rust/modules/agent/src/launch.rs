//! How an agent run that nobody is waiting for starts: inline in this
//! process, or as a durable `weldagent.job` that `serve` runs.
//!
//! The spreadsheet, board and WeldMerge tools reach their modules through
//! [`crate::tools::ModuleTools`], which only `serve` installs. The routine
//! cron (`weldsuite cron weldagent-routines`) and the `weldagent` hub
//! subscriber (`weldsuite consume`) run in other processes, where those tools
//! answer "not available to agents here". On Global the same two live in
//! agent-api, which reaches the modules over service bindings, so their runs
//! have every tool.
//!
//! [`RunLauncher::Jobs`] closes that gap: the cron and the subscriber decide
//! what is due or matched (claim the routine, write the queued run row, check
//! for a duplicate event) and enqueue the run on the jobs backend. The job
//! (`WeldAgentJob`, kind `agent-run`, registered by `serve`) runs it where
//! the module tools are. The job key is the run row's id, so a retried
//! enqueue starts nothing twice.
//!
//! [`RunLauncher::Inline`] is the fallback for installs whose jobs backend
//! does not reach `serve` (no `RESTATE_INGRESS_URL`: the in-process adapter
//! would run the job in the cron or consume process anyway). The run works
//! as before, with every tool except the spreadsheet, board and WeldMerge
//! ones.

use std::sync::Arc;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_ai::Ai;
use weldsuite_ports::{DynJobs, JobRequest};

use crate::routines::{complete_routine_run, release_routine_claim};
use crate::run::{RunEnv, RunParams, TriggerType, run_agent};

/// The job's name (`weldagent.job`, the same job rooms use).
pub const JOB_NAME: &str = "weldagent.job";

/// What a failed start gives back: the routine occurrence that was claimed,
/// so the next sweep retries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Release<'a> {
    pub routine_id: &'a str,
    pub due_at_ms: i64,
}

/// Where a run starts.
#[derive(Clone)]
pub enum RunLauncher {
    /// Run in this process with `ai` and `env`.
    Inline { ai: Option<Ai>, env: RunEnv },
    /// Enqueue on the jobs backend; `serve` runs it with the module tools.
    Jobs(Arc<dyn DynJobs>),
}

impl std::fmt::Debug for RunLauncher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Inline { ai, .. } => f
                .debug_struct("RunLauncher::Inline")
                .field("ai", &ai.is_some())
                .finish_non_exhaustive(),
            Self::Jobs(_) => f.write_str("RunLauncher::Jobs"),
        }
    }
}

impl RunLauncher {
    /// Run in this process.
    pub fn inline(ai: Option<Ai>, env: RunEnv) -> Self {
        Self::Inline { ai, env }
    }

    /// Hand runs to the jobs backend.
    pub fn jobs(jobs: Arc<dyn DynJobs>) -> Self {
        Self::Jobs(jobs)
    }

    /// Whether a run starts on the jobs backend (and so in `serve`).
    pub fn is_durable(&self) -> bool {
        matches!(self, Self::Jobs(_))
    }

    /// Start one run. Inline, this returns when the run is over; on the jobs
    /// backend, when the job is accepted. `params.env` is replaced by the
    /// launcher's (inline) or by `serve`'s (job).
    ///
    /// # Errors
    ///
    /// The run could not start (inline: the loop refused it; jobs: the backend
    /// did not accept it). The caller fails its row and releases a claim.
    pub async fn start(
        &self,
        mut params: RunParams,
        release: Option<Release<'_>>,
    ) -> Result<(), String> {
        match self {
            Self::Inline { ai, env } => {
                params.env = env.clone();
                run_agent(ai.as_ref(), params)
                    .await
                    .map(|_| ())
                    .map_err(|error| format!("{error:?}"))
            }
            Self::Jobs(jobs) => {
                let key = params
                    .run_id
                    .clone()
                    .or_else(|| params.routine_run_id.clone())
                    .map(|id| format!("agent-run-{id}"))
                    .ok_or("a durable run needs a run id")?;
                let request = JobRequest {
                    name: JOB_NAME.to_owned(),
                    key,
                    payload: payload_of(&params, release),
                    delay: None,
                };
                jobs.start_boxed(request)
                    .await
                    .map_err(|error| error.to_string())
            }
        }
    }
}

/// The `agent-run` job payload of a run.
pub fn payload_of(params: &RunParams, release: Option<Release<'_>>) -> Value {
    let mut payload = json!({
        "kind": "agent-run",
        "workspaceId": params.workspace_id,
        "actorUserId": params.actor_user_id,
        "agentId": params.agent_id,
        "triggerData": params.trigger_data,
        "userMessage": params.user_message,
        "extraSystem": params.extra_system,
        "runId": params.run_id,
        "routineRunId": params.routine_run_id,
        "skipApprovals": params.skip_approvals,
        "notify": params.notify,
    });
    if let (Some(release), Some(map)) = (release, payload.as_object_mut()) {
        map.insert(
            "release".into(),
            json!({ "routineId": release.routine_id, "dueAtMs": release.due_at_ms }),
        );
    }
    payload
}

/// The run an `agent-run` payload describes, on the tenant database `db`.
pub fn params_of(payload: &Value, db: PgPool, env: RunEnv) -> RunParams {
    let text = |key: &str| payload[key].as_str().map(str::to_owned);
    RunParams {
        db,
        workspace_id: text("workspaceId").unwrap_or_default(),
        actor_user_id: text("actorUserId").unwrap_or_else(|| "system".to_owned()),
        agent_id: text("agentId").unwrap_or_default(),
        trigger_type: TriggerType::Event,
        trigger_data: payload.get("triggerData").filter(|v| !v.is_null()).cloned(),
        user_message: text("userMessage").unwrap_or_default(),
        extra_system: text("extraSystem"),
        run_id: text("runId"),
        routine_run_id: text("routineRunId"),
        skip_approvals: payload["skipApprovals"] == json!(true),
        // Jobs from before `notify` existed notified.
        notify: payload["notify"] != json!(false),
        actor_permissions: None,
        events: None,
        env,
    }
}

/// Run an `agent-run` payload (the job body). A run that could not start
/// fails its routine run row and gives back the claimed occurrence, as the
/// inline sweep does, and does not fail the job: the next sweep retries.
pub async fn run_payload(ai: Option<&Ai>, db: PgPool, env: RunEnv, payload: &Value) {
    let params = params_of(payload, db.clone(), env);
    let routine_run_id = params.routine_run_id.clone();
    let Err(error) = run_agent(ai, params).await else {
        return;
    };
    let message = format!("{error:?}");
    tracing::warn!(%message, "[weldagent/job] run could not start");
    if let Some(run_id) = routine_run_id {
        if let Err(error) =
            complete_routine_run(&db, &run_id, "failed", None, Some(&message), None).await
        {
            tracing::error!(%error, "[weldagent/job] could not fail the routine run");
        }
    }
    if let Some(release) = payload.get("release").filter(|v| v.is_object()) {
        let id = release["routineId"].as_str().unwrap_or_default();
        let due = release["dueAtMs"].as_i64().unwrap_or_default();
        if let Err(error) = release_routine_claim(&db, id, due).await {
            tracing::error!(%error, "[weldagent/job] could not release the routine claim");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use weldsuite_ports::{BoxFuture, PortError};

    #[derive(Default)]
    struct Recorder(Mutex<Vec<JobRequest>>);

    impl DynJobs for Recorder {
        fn start_boxed(&self, request: JobRequest) -> BoxFuture<'_, Result<(), PortError>> {
            self.0.lock().unwrap().push(request);
            Box::pin(std::future::ready(Ok(())))
        }
        fn signal_boxed<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
            _: &'a str,
        ) -> BoxFuture<'a, Result<bool, PortError>> {
            Box::pin(std::future::ready(Ok(false)))
        }
    }

    fn params() -> RunParams {
        RunParams {
            db: PgPool::connect_lazy("postgres://localhost/none").unwrap(),
            workspace_id: "ws_1".into(),
            actor_user_id: "u1".into(),
            agent_id: "agt_1".into(),
            trigger_type: TriggerType::Event,
            trigger_data: Some(json!({ "routineId": "rtn_1" })),
            user_message: "go".into(),
            extra_system: Some("sys".into()),
            run_id: None,
            routine_run_id: Some("rr_1".into()),
            skip_approvals: true,
            notify: false,
            actor_permissions: None,
            events: None,
            env: RunEnv::default(),
        }
    }

    #[tokio::test]
    async fn a_durable_run_is_one_weldagent_job_keyed_on_its_row() {
        let recorder = Arc::new(Recorder::default());
        let launcher = RunLauncher::jobs(recorder.clone());
        assert!(launcher.is_durable());
        let release = Release {
            routine_id: "rtn_1",
            due_at_ms: 42,
        };
        launcher.start(params(), Some(release)).await.unwrap();
        let jobs = recorder.0.lock().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].name, "weldagent.job");
        assert_eq!(jobs[0].key, "agent-run-rr_1");
        let p = &jobs[0].payload;
        assert_eq!(p["kind"], "agent-run");
        assert_eq!(p["notify"], false);
        assert_eq!(p["release"]["dueAtMs"], 42);
    }

    #[tokio::test]
    async fn a_durable_run_without_a_row_is_refused() {
        let launcher = RunLauncher::jobs(Arc::new(Recorder::default()));
        let mut p = params();
        p.routine_run_id = None;
        assert!(launcher.start(p, None).await.is_err());
    }

    #[tokio::test]
    async fn the_payload_round_trips_into_the_same_run() {
        let p = params();
        let payload = payload_of(&p, None);
        let back = params_of(&payload, p.db.clone(), RunEnv::default());
        assert_eq!(back.workspace_id, p.workspace_id);
        assert_eq!(back.routine_run_id, p.routine_run_id);
        assert_eq!(back.trigger_data, p.trigger_data);
        assert_eq!(back.extra_system, p.extra_system);
        assert!(back.skip_approvals);
        assert!(!back.notify);
        assert!(payload.get("release").is_none());
    }
}
