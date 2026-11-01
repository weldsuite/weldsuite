//! `lib/domain-renew-due.ts`: a successful write to `/api/domains*` or
//! `/api/domain-transfers*` marks the workspace due for the auto-renew sweep
//! (the master `workspace_due_index`, kind `domain_renew`, keyed by
//! `workspaces.id`; Global's is the schedule-index D1).

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use http::Method;
use time::OffsetDateTime;
use weldsuite_db::{MasterDb, Tenant};
use weldsuite_kit::RequestEnv;

use crate::HostState;

pub(crate) const KIND: &str = "domain_renew";

pub(crate) async fn mark(State(state): State<HostState>, request: Request, next: Next) -> Response {
    let read = matches!(*request.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    let workspace = request
        .extensions()
        .get::<Tenant>()
        .map(|tenant| tenant.workspace_id.clone());
    // Conformance requests use the test's master database, if it has one.
    let master = if request.extensions().get::<RequestEnv>().is_some() {
        request.extensions().get::<MasterDb>().map(|m| m.0.clone())
    } else {
        state.master.clone()
    };
    let response = next.run(request).await;
    if read || !response.status().is_success() {
        return response;
    }
    if let (Some(master), Some(workspace)) = (master, workspace) {
        weldsuite_db::due_index::mark_due(&master, KIND, &workspace, OffsetDateTime::now_utc()).await;
    }
    response
}
