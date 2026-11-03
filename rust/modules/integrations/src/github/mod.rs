//! GitHub: the App's webhook receiver (`POST /webhooks/github`) and the
//! Project (v2) sync Workflows as jobs: `integrations.github-project-sync`
//! (`GithubProjectSyncWorkflow`, the `GITHUB_PROJECT_SYNC` binding WeldConnect's
//! "Sync now" and the webhook start) and `integrations.github-project-outbound`
//! (`GithubProjectOutboundSyncWorkflow`, `GITHUB_PROJECT_OUTBOUND`, one task
//! mutation pushed to its Project item).

pub mod api;
pub mod auth;
pub mod outbound;
pub mod project_sync;
mod queries;
pub mod webhook;

use std::sync::Arc;

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_ports::{BoxFuture, DynJobs, JobRequest, OutboundHttp};

use crate::books::TenantResolver;
pub use auth::AppCredentials;

/// The job `GITHUB_PROJECT_SYNC` starts.
pub const GITHUB_PROJECT_SYNC_JOB: &str = "integrations.github-project-sync";
/// The job `GITHUB_PROJECT_OUTBOUND` starts.
pub const GITHUB_PROJECT_OUTBOUND_JOB: &str = "integrations.github-project-outbound";

/// What the GitHub jobs need: the workspaces' tenant databases (by Clerk
/// org id), GitHub over HTTP and the App's credentials.
#[derive(Clone)]
pub struct GithubDeps {
    pub tenants: TenantResolver,
    pub http: Option<OutboundHttp>,
    /// `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`; none fails the token step.
    pub credentials: Option<AppCredentials>,
}

impl GithubDeps {
    /// `getTenantDbForWorkspace(env, workspaceId)`.
    pub(crate) async fn db(&self, workspace_id: &str) -> Result<PgPool, String> {
        (self.tenants)(workspace_id.to_owned())
            .await
            .map(|tenant| tenant.db)
    }

    /// `getInstallationToken(...)`, or the worker's error without the App.
    pub(crate) async fn token(&self, installation_id: i64) -> Result<String, String> {
        let credentials = self
            .credentials
            .as_ref()
            .ok_or("GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY not configured")?;
        auth::installation_token(self.http.as_ref(), credentials, installation_id).await
    }
}

/// `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` from a settings lookup.
pub fn credentials_from(get: impl Fn(&str) -> Option<String>) -> Option<AppCredentials> {
    let app_id = get("GITHUB_APP_ID").filter(|v| !v.is_empty())?;
    let private_key = get("GITHUB_APP_PRIVATE_KEY").filter(|v| !v.is_empty())?;
    Some(AppCredentials {
        app_id,
        // Secrets often keep the PEM's line breaks escaped.
        private_key: private_key.replace("\\n", "\n"),
    })
}

/// A Workflow binding the integration workers start runs on
/// (`binding.create({ id, params })`). `Err` carries what the binding threw.
pub trait WorkflowRuns: Send + Sync {
    fn create<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, Result<(), String>>;
}

/// A request's own `GITHUB_PROJECT_SYNC` (conformance: the test's, or none).
#[derive(Clone)]
pub struct RequestGithubProjectSync(pub Option<Arc<dyn WorkflowRuns>>);

/// Runs as jobs of this deployment: one run per id, as a Workflow instance
/// id (a second `create` of a running or finished id does nothing).
pub struct JobRuns {
    pub jobs: Arc<dyn DynJobs>,
    pub job: &'static str,
}

impl WorkflowRuns for JobRuns {
    fn create<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let request =
                JobRequest::new(self.job, id, params).map_err(|error| error.to_string())?;
            self.jobs
                .start_boxed(request)
                .await
                .map_err(|error| error.to_string())
        })
    }
}

/// `floor(extract(epoch from <col>) * 1000)`: a timestamp as JavaScript's
/// `Date` holds it (milliseconds, the microseconds dropped).
pub(crate) fn iso_of_millis(millis: i64) -> String {
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    weldsuite_events::iso_timestamp(at)
}

/// `new Date(iso).getTime()`, for the ISO times GitHub sends.
pub(crate) fn millis_of_iso(iso: &str) -> Option<i64> {
    let at =
        time::OffsetDateTime::parse(iso, &time::format_description::well_known::Rfc3339).ok()?;
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok()
}

/// `Date.now()`.
pub(crate) fn now_millis() -> i64 {
    i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .unwrap_or_default()
}

/// The project's pipeline stages as `status → stageId`, the first stage by
/// position for each system status (`loadStatusToStageMap`). Read in the
/// table's order and sorted stably, as `[...rows].sort(...)` does.
pub(crate) async fn status_to_stage_id(
    db: &PgPool,
    project_id: &str,
) -> Result<Vec<(String, String)>, sqlx::Error> {
    let mut stages: Vec<(String, Option<String>, Option<i32>)> = sqlx::query_as(
        "select id, system_status, position from project_pipeline_stages where project_id = $1",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    stages.sort_by_key(|(_, _, position)| position.unwrap_or(0));
    let mut map: Vec<(String, String)> = Vec::new();
    for (id, status, _) in stages {
        if let Some(status) = status.filter(|s| !s.is_empty())
            && !map.iter().any(|(s, _)| *s == status)
        {
            map.push((status, id));
        }
    }
    Ok(map)
}
