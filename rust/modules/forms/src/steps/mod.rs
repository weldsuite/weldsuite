//! The ordered steps of `ProcessResponse` (`workflows/steps/index.ts`): one
//! idempotent step per enabled integration, then the people (followers, the
//! respondent's copy, the quota notices).
//!
//! Adding a step is one file: implement [`ProcessStep`] in its own module
//! here and list it in [`all`]. The job runs each as its own durable step and
//! records integration steps in `form_response_actions`.

use std::sync::Arc;

use crate::process::ProcessStep;

mod crm;
mod desk;
mod flow;
mod notify;
mod quota;
mod receipt;

/// `PROCESS_STEPS`, in order.
pub(crate) fn all() -> Vec<Arc<dyn ProcessStep>> {
    vec![
        // The integrations: one run per enabled integration of the kind, as the member who set it up.
        Arc::new(crm::CrmStep),
        Arc::new(desk::DeskStep),
        Arc::new(flow::FlowStep),
        // Then the people: followers, the respondent's copy, the quota notices.
        Arc::new(notify::NotifyStep),
        Arc::new(receipt::ReceiptStep),
        Arc::new(quota::QuotaStep),
    ]
}
