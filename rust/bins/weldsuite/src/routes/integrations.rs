//! The integration workers (`weldsuite-integrations`): the public webhook
//! receivers at the workers' own paths (`/webhooks/...`), their jobs (the
//! Workflows `GITHUB_PROJECT_SYNC` and `GITHUB_PROJECT_OUTBOUND`), and the
//! service bindings they call, answered in this process. They have no API
//! module id, so they are always served; what they hand to another module
//! goes nowhere while that module is not (WeldBooks' bank feeds until
//! `books` is marked ported), as the worker without the binding.
//!
//! WeldConnect's routes start the same Workflows (`GITHUB_PROJECT_SYNC` on
//! "Sync now"): [`connect_bindings`] gives them this deployment's jobs.

use std::sync::{Arc, Once};

use axum::Router;
use axum::extract::Request;
use axum::middleware::Next;
use serde_json::Value;
use weldsuite_db::{Keyring, PgPool, Workspaces};
use weldsuite_events::EntityEventPublisher;
use weldsuite_integrations::crm::{CRM_SYNC_JOB, CrmDeps};
use weldsuite_integrations::github::{GITHUB_PROJECT_SYNC_JOB, GithubDeps, JobRuns};
use weldsuite_integrations::{
    BindingResponse, ConnectCall, ConnectInternal, IntegrationsState, ServiceBinding,
    TenantResolver, WorkflowRuns,
};
use weldsuite_ports::BoxFuture;

use crate::server::AppState;

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn keyring() -> Keyring {
    Keyring {
        v1: env_value("DATABASE_ENCRYPTION_KEY"),
        v2: env_value("DATABASE_ENCRYPTION_KEY_V2"),
    }
}

fn tenants(workspaces: &Arc<Workspaces>) -> TenantResolver {
    let workspaces = Arc::clone(workspaces);
    Arc::new(move |reference: String| {
        let workspaces = Arc::clone(&workspaces);
        Box::pin(async move {
            workspaces
                .tenant(&reference)
                .await
                .map_err(|error| error.to_string())
        })
    })
}

/// The receivers, before any authentication. Registers the jobs once.
pub(crate) fn public(state: &AppState) -> Router<AppState> {
    register_jobs(state);
    let router = weldsuite_integrations::public_router(integrations_state(state));
    // Conformance builds open the test's tenant database for every workspace.
    #[cfg(feature = "conformance")]
    let router = router.route_layer(axum::middleware::from_fn_with_state(
        Arc::clone(&state.conformance_pools),
        crate::conformance::public_tenant,
    ));
    router
}

/// `integrations.github-project-sync` and `integrations.github-project-outbound`,
/// on this process's jobs.
fn register_jobs(state: &AppState) {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let deps = GithubDeps {
            tenants: tenants(&state.workspaces),
            http: super::books::books_http(),
            credentials: weldsuite_integrations::github::credentials_from(env_value),
        };
        let registry = &state.infra.job_registry;
        registry.register(
            weldsuite_integrations::github::project_sync::GithubProjectSyncJob {
                deps: deps.clone(),
            },
        );
        registry
            .register(weldsuite_integrations::github::outbound::GithubProjectOutboundJob { deps });
        registry.register(weldsuite_integrations::crm::job::CrmSyncJob {
            deps: crm_deps(state),
        });
    });
}

/// `GITHUB_PROJECT_SYNC` / `GITHUB_PROJECT_OUTBOUND` as this deployment's jobs.
fn job_runs(state: &AppState, job: &'static str) -> Arc<JobRuns> {
    Arc::new(JobRuns {
        jobs: Arc::clone(&state.infra.jobs),
        job,
    })
}

/// The integration workers' handle on the app. Conformance builds take the
/// test's env, master database, KV, HTTP client and bindings per request.
pub(crate) fn integrations_state(state: &AppState) -> IntegrationsState {
    let conformance = cfg!(feature = "conformance");
    let master = state.workspaces.master().clone();
    IntegrationsState {
        events: state.infra.events.clone(),
        master: (!conformance).then(|| master.clone()),
        cache: (!conformance).then(|| state.infra.cache.clone()).flatten(),
        http: (!conformance).then(super::books::books_http).flatten(),
        env: Arc::new(weldsuite_integrations::env_from_process()),
        books: (!conformance)
            .then(|| {
                in_process_books(
                    &master,
                    &keyring(),
                    &state.workspaces,
                    state.infra.events.clone(),
                )
            })
            .flatten(),
        tenants: (!conformance).then(|| tenants(&state.workspaces)),
        github_sync: (!conformance)
            .then(|| job_runs(state, GITHUB_PROJECT_SYNC_JOB) as Arc<dyn WorkflowRuns>),
        connect_internal: (!conformance)
            .then(|| server_connect_internal(state))
            .flatten(),
        execute_workflow: (!conformance && super::mounts("connect"))
            .then(|| execute_workflow(Arc::clone(&state.infra.jobs))),
    }
}

/// `BOOKS_INTERNAL`: WeldBooks' internal bank-feed routes in this process,
/// once books is served; none before.
pub(crate) fn in_process_books(
    master: &PgPool,
    keyring: &Keyring,
    workspaces: &Arc<Workspaces>,
    events: EntityEventPublisher,
) -> Option<Arc<dyn ServiceBinding>> {
    if !super::mounts("books") {
        return None;
    }
    Some(Arc::new(weldsuite_integrations::books::InProcessBooks {
        tenants: tenants(workspaces),
        keyring: keyring.clone(),
        master: Some(master.clone()),
        env: super::books::books_env(),
        http: super::books::books_http(),
        ponto_http: super::books::ponto_http(),
        events,
    }))
}

/// connect's `ProjectSyncRuns` over this deployment's jobs.
struct ConnectRuns(Arc<JobRuns>);

impl weldsuite_connect::ProjectSyncRuns for ConnectRuns {
    fn create<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, Result<(), String>> {
        WorkflowRuns::create(self.0.as_ref(), id, params)
    }
}

/// WeldConnect's Workflow bindings that the integration workers host, on
/// this deployment's jobs: `GITHUB_PROJECT_SYNC` ("Sync now" on a project
/// link). Conformance builds take the test's binding per request instead.
/// `CRM_SYNC`: the `integrations.crm-sync` job (Connect's CRM sync routes).
pub(crate) fn connect_bindings(router: Router<AppState>, state: &AppState) -> Router<AppState> {
    if cfg!(feature = "conformance") {
        return router;
    }
    let runs: Arc<dyn weldsuite_connect::ProjectSyncRuns> =
        Arc::new(ConnectRuns(job_runs(state, GITHUB_PROJECT_SYNC_JOB)));
    let crm: Arc<dyn weldsuite_connect::ProjectSyncRuns> =
        Arc::new(ConnectRuns(job_runs(state, CRM_SYNC_JOB)));
    with_crm_runs(
        router.layer(axum::middleware::from_fn(
            move |mut request: Request, next: Next| {
                let runs = Arc::clone(&runs);
                async move {
                    request
                        .extensions_mut()
                        .insert(weldsuite_connect::RequestProjectSyncRuns(Some(runs)));
                    next.run(request).await
                }
            },
        )),
        crm,
    )
}

// ── CRM sync ────────────────────────────────────────────────────────────────

/// What `integrations.crm-sync` needs: the tenants, third-party HTTP, the
/// OAuth clients and realtime.
fn crm_deps(state: &AppState) -> CrmDeps {
    CrmDeps {
        tenants: tenants(&state.workspaces),
        http: super::books::books_http(),
        env: Arc::new(weldsuite_integrations::env_from_process()),
        realtime: state.infra.realtime.clone(),
    }
}

/// `CRM_SYNC` on a request (`RequestCrmSyncRuns`), for WeldConnect's
/// CRM routes and its internal sync route.
fn with_crm_runs<S>(
    router: Router<S>,
    runs: Arc<dyn weldsuite_connect::ProjectSyncRuns>,
) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router.layer(axum::middleware::from_fn(
        move |mut request: Request, next: Next| {
            let runs = Arc::clone(&runs);
            async move {
                request
                    .extensions_mut()
                    .insert(weldsuite_connect::RequestCrmSyncRuns(Some(runs)));
                next.run(request).await
            }
        },
    ))
}

/// `CONNECT_INTERNAL` in this process: WeldConnect's internal integration
/// router, called with the internal secret (`INTERNAL_API_SECRET`) as the
/// app-api fallback path does on Global.
pub(crate) struct InProcessConnectInternal {
    router: Router,
    secret: Option<String>,
}

impl ConnectInternal for InProcessConnectInternal {
    fn fetch(&self, call: ConnectCall) -> BoxFuture<'_, Result<BindingResponse, String>> {
        Box::pin(async move {
            use tower::ServiceExt;
            let mut builder = http::Request::builder()
                .method(call.method.as_str())
                .uri(call.path.as_str());
            for (name, value) in &call.headers {
                builder = builder.header(name.as_str(), value.as_str());
            }
            builder = builder.header("x-internal-secret", self.secret.clone().unwrap_or_default());
            let request = builder
                .body(axum::body::Body::from(call.body.unwrap_or_default()))
                .map_err(|error| error.to_string())?;
            let response = match self.router.clone().oneshot(request).await {
                Ok(response) => response,
                Err(never) => match never {},
            };
            let status = response.status().as_u16();
            let body = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
                .await
                .map_err(|error| error.to_string())?;
            Ok(BindingResponse {
                status,
                body: String::from_utf8_lossy(&body).into_owned(),
            })
        })
    }
}

/// The server's `CONNECT_INTERNAL`: WeldConnect's internal routes with
/// this deployment's `CRM_SYNC`; none while connect is not served.
fn server_connect_internal(state: &AppState) -> Option<Arc<dyn ConnectInternal>> {
    let router = super::connect_internal(state)?;
    let crm: Arc<dyn weldsuite_connect::ProjectSyncRuns> =
        Arc::new(ConnectRuns(job_runs(state, CRM_SYNC_JOB)));
    Some(Arc::new(InProcessConnectInternal {
        router: with_crm_runs(router, crm).with_state(state.clone()),
        secret: env_value("INTERNAL_API_SECRET"),
    }))
}

/// `CONNECT_INTERNAL` for a cron run: WeldConnect's internal routes over
/// `connect`, starting `CRM_SYNC` on `jobs`; none while connect is not served.
pub(crate) fn cron_connect_internal(
    connect: weldsuite_connect::ConnectState,
    jobs: Arc<dyn weldsuite_ports::DynJobs>,
) -> Option<Arc<dyn ConnectInternal>> {
    if !super::mounts("connect") {
        return None;
    }
    let crm: Arc<dyn weldsuite_connect::ProjectSyncRuns> =
        Arc::new(ConnectRuns(Arc::new(JobRuns {
            jobs,
            job: CRM_SYNC_JOB,
        })));
    let router: Router = weldsuite_connect::internal_integrations_router(connect);
    Some(Arc::new(InProcessConnectInternal {
        router: with_crm_runs(router, crm),
        secret: env_value("INTERNAL_API_SECRET"),
    }))
}

// ── WeldFlow ────────────────────────────────────────────────────────────────

/// WeldFlow's `GITHUB_PROJECT_OUTBOUND` over this deployment's jobs.
struct FlowOutboundRuns(Arc<JobRuns>);

impl weldsuite_flow::github_outbound::GithubOutboundRuns for FlowOutboundRuns {
    fn create<'a>(&'a self, id: &'a str, params: &'a Value) -> BoxFuture<'a, Result<(), String>> {
        WorkflowRuns::create(self.0.as_ref(), id, params)
    }
}

/// `GITHUB_PROJECT_OUTBOUND` for WeldFlow's task routes: the
/// `integrations.github-project-outbound` job.
pub(crate) fn flow_github_outbound(
    state: &AppState,
) -> weldsuite_flow::github_outbound::SharedGithubOutboundRuns {
    Arc::new(FlowOutboundRuns(job_runs(
        state,
        weldsuite_integrations::github::GITHUB_PROJECT_OUTBOUND_JOB,
    )))
}

// ── WeldConnect's integration triggers ──────────────────────────────────────

/// `EXECUTE_WORKFLOW` as WeldConnect starts its runs (`connect.execute-workflow`).
pub(crate) struct ConnectExecute(pub(crate) Arc<dyn weldsuite_connect::WorkflowRuns>);

impl weldsuite_integrations::workflow_events::ExecuteWorkflowRuns for ConnectExecute {
    fn create<'a>(&'a self, params: &'a Value) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move { self.0.create(params).await.map(|_| ()) })
    }
}

/// `EXECUTE_WORKFLOW` over `jobs`.
pub(crate) fn execute_workflow(
    jobs: Arc<dyn weldsuite_ports::DynJobs>,
) -> Arc<dyn weldsuite_integrations::workflow_events::ExecuteWorkflowRuns> {
    Arc::new(ConnectExecute(Arc::new(
        weldsuite_connect::JobsWorkflowRuns { jobs },
    )))
}
