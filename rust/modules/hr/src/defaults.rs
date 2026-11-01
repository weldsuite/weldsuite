//! `ensureHrDefaults` (helpers.ts): the first request per workspace seeds
//! the starter checklist templates, leave types, scorecard and KPIs. Each
//! `ensure*` is a `limit 1` probe once seeded, and a memo keeps even that
//! off later requests.
//!
//! The worker's memo lives as long as its isolate. Here it is keyed by the
//! workspace and the database it was seeded in, so a workspace whose
//! database is replaced (a conformance run's next test file, a restore) is
//! seeded again, as a fresh isolate would.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use weldsuite_db::{PgPool, Tenant};

use crate::HrError;

static SEEDED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

/// The memo's key: the workspace and where its database is.
fn key_of(tenant: &Tenant) -> String {
    let options = tenant.db.connect_options();
    format!(
        "{}|{}|{}|{}|{}",
        tenant.workspace_id,
        options.get_host(),
        options.get_port(),
        options.get_database().unwrap_or_default(),
        options.get_application_name().unwrap_or_default(),
    )
}

/// The four probes, as `Promise.all` runs them.
async fn seed(db: &PgPool) -> Result<(), HrError> {
    let (templates, leave_types, form, kpis) = tokio::join!(
        crate::lifecycle::ensure_default_templates(db),
        crate::timekeeping::ensure_default_leave_types(db),
        crate::performance::ensure_default_evaluation_form(db),
        crate::performance::ensure_default_kpis(db),
    );
    templates?;
    leave_types?;
    form?;
    kpis?;
    Ok(())
}

/// The middleware, ahead of every `/api/weldhr` route.
pub(crate) async fn ensure_hr_defaults(request: Request, next: Next) -> Response {
    let Some(tenant) = request.extensions().get::<Tenant>().cloned() else {
        return next.run(request).await;
    };
    if tenant.workspace_id.is_empty() {
        return next.run(request).await;
    }
    let key = key_of(&tenant);
    let known = SEEDED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(&key);
    if !known {
        if let Err(error) = seed(&tenant.db).await {
            return error.into_response();
        }
        SEEDED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key);
    }
    next.run(request).await
}
