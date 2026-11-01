//! WeldHR payroll (`routes/weldhr/payroll`, `services/weldhr/payroll`), behind the
//! `weldhr-payroll` flag, and the payroll routes of My HR (`payroll/self-service.ts`).
//!
//! Permissions: `payroll:read` (overview, runs, payslips, filings, employee
//! payroll data), `payroll:prepare` (employee setup; create, collect,
//! calculate and cancel runs), `payroll:approve` (approve and pay runs, the
//! payment file, the journal), `payroll:manage` (employers, pay schedules,
//! submitting and recording filings). Mutations of runs and filings publish
//! `hr_pay_run`, `hr_payslip` and `hr_payroll_filing` events with ids and
//! status only; sensitive changes go to `hr_audit_events`.

mod annual;
mod approve;
mod calculate;
mod common;
mod corrections;
mod employees;
mod employers;
mod files;
mod filings;
mod journal;
mod notifier;
mod overview;
mod payslips;
mod routes;
mod runs;
mod schema;
mod schemas;
mod self_service;
mod setup;
mod ytd;

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use weldsuite_catalogs::flags::WELDHR_PAYROLL;
use weldsuite_kit::ApiError;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::HrState;

/// `requirePayrollFlag`: without `weldhr-payroll`, every payroll path is a
/// 404, as if the endpoints did not exist.
async fn require_payroll_flag(request: Request, next: Next) -> Response {
    let on = match request.extensions().get::<weldsuite_pipeline::Flags>() {
        Some(flags) => flags.is_on(WELDHR_PAYROLL).await,
        None => false,
    };
    if !on {
        return ApiError::not_found("Payroll", None).into_response();
    }
    next.run(request).await
}

/// `/api/weldhr/payroll`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    setup::routes(gate).merge(routes::routes(gate)).layer(axum::middleware::from_fn(require_payroll_flag))
}

/// The payroll routes of My HR, relative to `/api/weldhr/me`.
pub(crate) fn me_routes<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    self_service::routes().layer(axum::middleware::from_fn(require_payroll_flag))
}

const SECURITY_HEADERS: [(&str, &str); 2] = [("Cache-Control", "private, no-store"), ("X-Content-Type-Options", "nosniff")];

/// `pdfResponse(bytes, fileName)` and `generatedFileResponse(file)`: always
/// an attachment.
pub(crate) fn file_response(bytes: Vec<u8>, file_name: &str, content_type: &str) -> Response {
    let mut builder = Response::builder()
        .status(200)
        .header("Content-Type", content_type)
        .header("Content-Disposition", common::attachment(file_name));
    for (name, value) in SECURITY_HEADERS {
        builder = builder.header(name, value);
    }
    builder.body(Body::from(bytes)).unwrap_or_else(|_| ApiError::internal().into_response())
}

/// What the payroll services depend on besides the database
/// (`PayrollDeps`, built per request as `payrollDeps(c)` does).
pub(crate) struct Deps {
    pub(crate) keyring: weldsuite_db::Keyring,
    /// `STORAGE`: payslip and filing files. `None`: rendered on demand.
    pub(crate) bucket: Option<Arc<dyn weldsuite_ports::DynFileStore>>,
    /// The workspace's R2 prefix (`orgIdOf(c)`, the Clerk org id).
    pub(crate) workspace_key: String,
    /// The billing ledger's workspace id (`workspaces.id`).
    pub(crate) workspace_id: String,
    pub(crate) books: Option<Arc<dyn crate::BooksInternal>>,
    pub(crate) master: Option<weldsuite_db::PgPool>,
    /// `NL_SOFTWARE_RELATION_NUMBER`.
    pub(crate) software_relation_number: Option<String>,
}

impl Deps {
    pub(crate) fn of(state: &HrState, caller: &crate::Caller) -> Self {
        Self {
            keyring: caller.keyring(),
            bucket: caller.storage(state),
            workspace_key: caller.clerk_org_id.clone(),
            workspace_id: caller.workspace_id.clone(),
            books: caller.books(state),
            master: caller.master(state),
            software_relation_number: caller.env("NL_SOFTWARE_RELATION_NUMBER"),
        }
    }
}
