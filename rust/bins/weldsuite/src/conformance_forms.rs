//! WeldForms' jobs in conformance mode: what the forms-api tests run
//! directly instead of through a request, wrapped in `conformanceSweep`
//! (`packages/core/worker-kit/src/testing/conformance-cron.ts`):
//!
//! - `POST /__conformance/cron/forms-process-response`: one
//!   `runProcessResponse(env, params, inlineSteps, steps)` (`input`: the
//!   params and, optionally, the names of the steps the test runs);
//! - `POST /__conformance/cron/forms-reminders` and `forms-digest`: one tick
//!   of `runRemindersSweep(env, now)` / `runDigestSweep(env, now)`.
//!
//! Every workspace opens the test's tenant database, with the Clerk org id
//! the test maps it to. The job's buckets and outbound ledgers are the
//! test's, served over HTTP; its cache is its KV namespace's seed scope.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::ApiError;
use weldsuite_ports::BoxFuture;

use crate::server::AppState;

/// The body `conformanceSweep` posts.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FormsJobRequest {
    /// The tick's time (ISO).
    now: String,
    database_url: String,
    #[serde(default)]
    master_database_url: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    files: HashMap<String, String>,
    #[serde(default)]
    ledgers: HashMap<String, String>,
    /// `workspaces.id` → Clerk org id.
    #[serde(default)]
    workspaces: HashMap<String, String>,
    #[serde(default)]
    seed_scope: Option<String>,
    #[serde(default)]
    input: Value,
}

/// Every reference (a Clerk org id or a `workspaces.id`) opens the test's
/// tenant database.
struct TestTenants {
    db: PgPool,
    /// Clerk org id → `workspaces.id`.
    ids: HashMap<String, String>,
    /// `workspaces.id` → Clerk org id.
    orgs: HashMap<String, String>,
}

impl weldsuite_forms::TenantResolver for TestTenants {
    fn tenant<'a>(
        &'a self,
        reference: &'a str,
    ) -> BoxFuture<'a, Result<weldsuite_forms::TenantDb, String>> {
        let workspace_id = self
            .ids
            .get(reference)
            .cloned()
            .unwrap_or_else(|| reference.to_owned());
        let tenant = weldsuite_forms::TenantDb {
            db: self.db.clone(),
            clerk_org_id: self.orgs.get(&workspace_id).cloned(),
            workspace_id,
            suspended: false,
        };
        Box::pin(std::future::ready(Ok(tenant)))
    }
}

struct Prepared {
    job: weldsuite_forms::ProcessResponseJob,
    now: time::OffsetDateTime,
}

fn prepare(state: &AppState, request: &FormsJobRequest) -> Result<Prepared, Box<Response>> {
    let pools = &state.conformance_pools;
    let db = pools
        .get(&request.database_url)
        .map_err(|error| Box::new(error.into_response()))?;
    let now =
        time::OffsetDateTime::parse(&request.now, &time::format_description::well_known::Rfc3339)
            .map_err(|_| {
            Box::new(ApiError::bad_request("conformance: now is not an ISO time").into_response())
        })?;
    // The job's clock is the tick's, as the TypeScript functions take `now`.
    let mut env = request.env.clone();
    env.entry("CONFORMANCE_NOW".to_owned())
        .or_insert_with(|| request.now.clone());
    let extensions = pools
        .job_extensions(
            request.master_database_url.as_deref(),
            &env,
            &request.files,
            &request.ledgers,
            request.seed_scope.as_deref(),
        )
        .map_err(|error| Box::new(error.into_response()))?;
    let tenants: Arc<dyn weldsuite_forms::TenantResolver> = Arc::new(TestTenants {
        db,
        ids: request
            .workspaces
            .iter()
            .map(|(id, org)| (org.clone(), id.clone()))
            .collect(),
        orgs: request.workspaces.clone(),
    });
    let mut forms = crate::routes::forms_state(state);
    forms.tenants = Some(Arc::clone(&tenants));
    Ok(Prepared {
        job: weldsuite_forms::ProcessResponseJob {
            tenants,
            state: forms,
            request: extensions,
            steps: weldsuite_forms::process_steps(),
        },
        now,
    })
}

/// `POST /__conformance/cron/forms-process-response`.
pub(crate) async fn process_response(
    State(state): State<AppState>,
    axum::Json(request): axum::Json<FormsJobRequest>,
) -> Response {
    let mut prepared = match prepare(&state, &request) {
        Ok(prepared) => prepared,
        Err(response) => return *response,
    };
    let Ok(params) = serde_json::from_value::<weldsuite_forms::ProcessResponseParams>(
        request.input["params"].clone(),
    ) else {
        return ApiError::bad_request("conformance: input.params is not a ProcessResponse run")
            .into_response();
    };
    if let Some(names) = request.input["steps"].as_array() {
        let names: Vec<&str> = names.iter().filter_map(Value::as_str).collect();
        prepared
            .job
            .steps
            .retain(|step| names.contains(&step.name()));
    }
    if let Err(error) = prepared.job.run_inline(&params).await {
        tracing::error!(%error, "conformance: forms ProcessResponse run failed");
    }
    axum::Json(json!({})).into_response()
}

/// `POST /__conformance/cron/forms-reminders`: one tick of `runRemindersSweep`.
pub(crate) async fn reminders(
    State(state): State<AppState>,
    axum::Json(request): axum::Json<FormsJobRequest>,
) -> Response {
    let prepared = match prepare(&state, &request) {
        Ok(prepared) => prepared,
        Err(response) => return *response,
    };
    let result = weldsuite_forms::run_reminders_sweep(
        &prepared.job.state,
        &prepared.job.request,
        prepared.now,
    )
    .await;
    axum::Json(result).into_response()
}

/// `POST /__conformance/cron/forms-digest`: one tick of `runDigestSweep`.
pub(crate) async fn digest(
    State(state): State<AppState>,
    axum::Json(request): axum::Json<FormsJobRequest>,
) -> Response {
    let prepared = match prepare(&state, &request) {
        Ok(prepared) => prepared,
        Err(response) => return *response,
    };
    let result =
        weldsuite_forms::run_digest_sweep(&prepared.job.state, &prepared.job.request, prepared.now)
            .await;
    axum::Json(result).into_response()
}
