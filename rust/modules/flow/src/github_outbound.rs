//! `dispatchGithubOutboundSync` (flow-api `routes/tasks`): a task created,
//! edited, moved to another status or deleted on a project linked to a
//! GitHub Project (v2) is pushed to its issue by the integration workers'
//! `GITHUB_PROJECT_OUTBOUND` Workflow (`integrations.github-project-outbound`
//! here). Only for an outbound-capable link (`syncIssues`, direction not
//! `inbound`); one run per task, kind and 15-second bucket, created in the
//! background. Without the binding (conformance builds, as flow-api's
//! tests bind none) nothing is dispatched.

use std::sync::Arc;

use serde_json::{Value, json};
use weldsuite_ports::BoxFuture;

use crate::{Caller, FlowState};

/// The `GITHUB_PROJECT_OUTBOUND` binding (`create({ id, params })`); `Err`
/// is what it threw.
pub trait GithubOutboundRuns: Send + Sync {
    fn create<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, Result<(), String>>;
}

/// `githubKindsForUpdate(data, resolvedStatus, existingStatus)`.
pub(crate) fn kinds_for_update(
    edits_issue: bool,
    resolved: Option<&str>,
    existing: Option<&str>,
) -> Vec<&'static str> {
    let mut kinds = Vec::new();
    if edits_issue {
        kinds.push("update");
    }
    if resolved != existing {
        kinds.push("status");
    }
    kinds
}

/// `dispatchGithubOutboundSync(c, { taskId, projectId, kinds })`.
pub(crate) fn dispatch(
    state: &FlowState,
    caller: &Caller,
    task_id: &str,
    project_id: Option<&str>,
    kinds: Vec<&'static str>,
) {
    let Some(runs) = state.github_outbound.clone() else {
        return;
    };
    let Some(project_id) = project_id.filter(|p| !p.is_empty()).map(str::to_owned) else {
        return;
    };
    if kinds.is_empty() {
        return;
    }
    // The outbound Workflow looks the workspace up by org id.
    let Some(org) = caller.clerk_org_id.clone() else {
        return;
    };
    let db = caller.db.clone();
    let task_id = task_id.to_owned();
    state.events.tracker().spawn(async move {
        let link: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
            "select sync_direction from github_project_links
             where project_id = $1 and sync_issues = true and deleted_at is null limit 1",
        )
        .bind(&project_id)
        .fetch_optional(&db)
        .await;
        let direction = match link {
            Ok(Some(direction)) => direction,
            Ok(None) => return,
            Err(error) => {
                tracing::error!(%error, "[app-api/tasks] github outbound dispatch failed");
                return;
            }
        };
        if direction == "inbound" {
            return;
        }
        run(runs.as_ref(), &org, &task_id, &kinds).await;
    });
}

/// One run per kind; a duplicate within the debounce window was already
/// dispatched, so a refusal is ignored.
async fn run(runs: &dyn GithubOutboundRuns, org: &str, task_id: &str, kinds: &[&str]) {
    let bucket = crate::now_ms().div_euclid(15_000);
    for kind in kinds {
        let id = format!("github-outbound-{task_id}-{kind}-{bucket}");
        let params = json!({ "workspaceId": org, "taskId": task_id, "kind": kind });
        if let Err(error) = runs.create(&id, &params).await {
            tracing::debug!(%error, id, "github outbound run not created");
        }
    }
}

/// The binding's handle, cloned into the state.
pub type SharedGithubOutboundRuns = Arc<dyn GithubOutboundRuns>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_update_pushes_the_issue_and_its_status_as_they_changed() {
        assert_eq!(
            kinds_for_update(true, Some("done"), Some("todo")),
            ["update", "status"]
        );
        assert_eq!(kinds_for_update(false, Some("todo"), Some("todo")), [""; 0]);
        assert_eq!(kinds_for_update(false, None, Some("todo")), ["status"]);
    }
}
