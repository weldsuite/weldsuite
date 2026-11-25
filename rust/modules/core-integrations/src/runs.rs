//! The `CRM_SYNC` Workflow binding (`CrmSyncWorkflow`, hosted by
//! integration-webhook-worker on Global; the `integrations.crm-sync` job
//! here): what the CRM sync routes (`/api/integrations/connections/:id/sync`,
//! the internal sync route) start a sync on.

use std::sync::Arc;

use serde_json::Value;
use weldsuite_ports::BoxFuture;

/// `CRM_SYNC` as the routes use it: `create({ id, params })`, the same shape
/// as `GITHUB_PROJECT_SYNC`. `Err` carries what the binding threw.
pub trait CrmSyncRuns: Send + Sync {
    /// `binding.create({ id, params })`.
    fn create<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, Result<(), String>>;
}

/// A request's own `CRM_SYNC`: the deployment's jobs, or the test's binding
/// (conformance), or none when the test has none.
#[derive(Clone)]
pub struct RequestCrmSyncRuns(pub Option<Arc<dyn CrmSyncRuns>>);
