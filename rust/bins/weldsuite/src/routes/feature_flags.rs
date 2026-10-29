//! `GET /api/feature-flags` (`app-api/src/routes/feature-flags/index.ts`): the
//! client-visible flags for the caller. Reading your own flag set needs no
//! permission. Keep the keys in sync with `featureFlagsResponseSchema` in
//! `@weldsuite/app-api-client`.

use axum::response::{IntoResponse, Response};
use http::header::CACHE_CONTROL;
use serde_json::json;
use weldsuite_catalogs::flags::{
    UPGRADE_BUTTON, WELDFLOW_MOVE_TASK, WELDHR_PAYROLL, WELDHR_PAYROLL_DIGIPOORT,
};
use weldsuite_kit::Data;
use weldsuite_pipeline::Flags;

pub(crate) async fn list(flags: Flags) -> Response {
    let body = json!({
        "upgrade-button": flags.is_on(UPGRADE_BUTTON).await,
        "weldflow-move-task": flags.is_on(WELDFLOW_MOVE_TASK).await,
        "weldhr-payroll": flags.is_on(WELDHR_PAYROLL).await,
        "weldhr-payroll-digipoort": flags.is_on(WELDHR_PAYROLL_DIGIPOORT).await,
    });
    // Never cached: a flag flip must take effect at once.
    ([(CACHE_CONTROL, "no-store")], Data(body)).into_response()
}
