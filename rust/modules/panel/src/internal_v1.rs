//! WeldPanel's read API for other services, `/internal/panel/v1/:workspaceId/*`
//! (`routes/internal-v1`, mounted on panel-api's `PanelApiInternal`
//! entrypoint), for external-api's `/v1/panel` and the MCP server's copy of
//! it.
//!
//! It serves the same handlers the platform uses, read-only: an allow-list
//! of GET routes plus `POST /query` (a query only reads); anything else is a
//! 404 before a handler runs. Every call acts for someone:
//!
//! - `x-weld-user`: a person (a personal API key's owner, an MCP user). Their
//!   own permissions (resolved from the workspace's members) and visibility
//!   apply: their private reports, and people only with `panel_people:read`.
//! - `x-weld-workspace-key`: a workspace API key (its id), its scope checked
//!   by the caller. It reads like a member with `panel_projects:read`,
//!   `panel_reports:read` and `panel_people:read`: shared reports and
//!   dashboards only.
//!
//! On Global the entrypoint is reachable only over a service binding,
//! trusted by topology. The Rust server keeps such routes off its listener
//! (as WeldMerge's `/internal/github-event`): [`internal_v1_router`] is for
//! an in-process caller (the public API's `/v1/panel` when it is ported,
//! which the MCP server runs in process), and conformance builds mount it
//! for panel-api's tests.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use http::{HeaderMap, Method, Uri};
use serde_json::{Map, Value, json};
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_catalogs::permission_keys::{
    PANEL_PEOPLE_READ, PANEL_PROJECTS_READ, PANEL_REPORTS_READ,
};
use weldsuite_db::{MasterDb, Tenant, WorkspaceRestrictions};
use weldsuite_kit::{ApiError, Data, RequestEnv};
use weldsuite_permissions::{
    AppContext, PermissionGate, PermissionQueries, Permissions, PresetPermissions,
    ResolvedPermissions, resolve_effective_permissions,
};
use weldsuite_ports::{OutboundHttp, RequestCache};
use weldsuite_zod::{Keys, Z};

use crate::collector::RequestCollector;
use crate::erasure::RequestErasureQueue;
use crate::project_state::RequestProjectState;

use crate::public_share::{RequestShareRateLimit, RequestWorkspaceTenants, WorkspaceTenants};
use crate::query::{QueryDeps, run_cached_query};
use crate::saved::{Actor, can_see, get_report};
use crate::schemas_gen::PANEL_QUERY_SPEC;
use crate::{
    Caller, PanelState, cohorts_router, dashboards_router, groups_router, lexicon_router,
    people_router, query_router, reports_router, router, unexpected,
};

/// A person's permissions, being resolved on the request's tenant database.
type Resolving =
    std::pin::Pin<Box<dyn Future<Output = Result<ResolvedPermissions, String>> + Send>>;

/// Starts resolving the request's person (`resolveEffectivePermissions`)
/// with the gate's queries; `None` without a tenant database or a person.
type Resolver = Arc<dyn Fn(&http::Extensions) -> Option<Resolving> + Send + Sync>;

/// `PANEL_DATE_PRESETS`.
const DATE_PRESETS: &[&str] = &["today", "7d", "30d", "90d", "12m"];

/// `resultsQuery`.
const RESULTS_QUERY: Z = Z::Obj(
    &[("preset", Z::Opt(&Z::Enum(DATE_PRESETS, None)))],
    Keys::Strip,
);

/// `WORKSPACE_KEY_PERMISSIONS`: what a workspace API key reads with.
fn workspace_key_permissions() -> ResolvedPermissions {
    ResolvedPermissions {
        permissions: [PANEL_PROJECTS_READ, PANEL_REPORTS_READ, PANEL_PEOPLE_READ]
            .map(str::to_owned)
            .to_vec(),
        denies: Vec::new(),
        role: "member".to_owned(),
        role_id: None,
        is_owner: false,
    }
}

/// `isAllowedRead(method, path)`: the only routes served here.
pub(crate) fn is_allowed_read(method: &Method, path: &str) -> bool {
    let Some(rest) = path.strip_prefix('/') else {
        return false;
    };
    let segments: Vec<&str> = rest.split('/').collect();
    if segments.iter().any(|s| s.is_empty()) {
        return false;
    }
    if *method == Method::POST {
        return segments == ["query"];
    }
    if *method != Method::GET {
        return false;
    }
    match segments.as_slice() {
        ["projects" | "reports" | "dashboards" | "cohorts" | "lexicon" | "people" | "groups"]
        | ["reports" | "dashboards", _]
        | ["reports", _, "results"]
        | ["groups", _, _] => true,
        ["people", id] => *id != "by-email",
        _ => false,
    }
}

/// What the read API shares: the platform's routers it hands calls to, and
/// what a workspace is opened with.
#[derive(Clone)]
struct Internal {
    inner: Router,
    state: PanelState,
    resolve: Resolver,
}

/// `/internal/panel/v1`, relative to its prefix.
pub fn internal_v1_router<S, Q>(state: PanelState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let inner: Router = Router::new()
        .route(
            "/reports/{id}/results",
            get(results)
                .with_state(state.clone())
                .route_layer(gate.require([PANEL_REPORTS_READ])),
        )
        .nest("/projects", router(state.clone(), gate))
        .nest("/query", query_router(state.clone(), gate))
        .nest("/reports", reports_router(state.clone(), gate))
        .nest("/dashboards", dashboards_router(state.clone(), gate))
        .nest("/cohorts", cohorts_router(state.clone(), gate))
        .nest("/lexicon", lexicon_router(state.clone(), gate))
        .nest("/people", people_router(state.clone(), gate))
        .nest("/groups", groups_router(state.clone(), gate));
    let resolver_gate = Arc::clone(gate);
    let resolve: Resolver = Arc::new(move |extensions: &http::Extensions| {
        let queries = resolver_gate.queries(extensions).ok()?;
        let user_id = extensions.get::<AuthContext>()?.user_id.clone();
        Some(Box::pin(async move {
            resolve_effective_permissions(&queries, &user_id)
                .await
                .map_err(|error| error.to_string())
        }) as Resolving)
    });
    Router::new()
        .route("/{*path}", any(dispatch))
        .with_state(Internal {
            inner,
            state,
            resolve,
        })
}

/// The workspaces a call opens: the request's (conformance), else the state's.
fn tenants(request: &Request, state: &PanelState) -> Option<Arc<dyn WorkspaceTenants>> {
    match request.extensions().get::<RequestWorkspaceTenants>() {
        Some(tenants) => Some(Arc::clone(&tenants.0)),
        None => state.tenants.clone(),
    }
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
}

/// What the platform's handlers read from a request besides the session:
/// the test's bindings in conformance builds.
fn carry<T: Clone + Send + Sync + 'static>(from: &http::Extensions, to: &mut http::Extensions) {
    if let Some(value) = from.get::<T>() {
        to.insert(value.clone());
    }
}

/// `request` for the platform's router at `uri`, with only what its
/// handlers read carried over (no route parameters of this router's).
fn inner_request(request: Request, uri: Uri) -> Request {
    let (parts, body) = request.into_parts();
    let mut inner = Request::new(body);
    *inner.method_mut() = parts.method;
    *inner.uri_mut() = uri;
    *inner.version_mut() = parts.version;
    *inner.headers_mut() = parts.headers;
    let from = &parts.extensions;
    let extensions = inner.extensions_mut();
    carry::<AppContext>(from, extensions);
    carry::<MasterDb>(from, extensions);
    carry::<OutboundHttp>(from, extensions);
    carry::<RequestCache>(from, extensions);
    carry::<RequestCollector>(from, extensions);
    carry::<RequestEnv>(from, extensions);
    carry::<RequestErasureQueue>(from, extensions);
    carry::<RequestProjectState>(from, extensions);
    carry::<RequestShareRateLimit>(from, extensions);
    carry::<RequestWorkspaceTenants>(from, extensions);
    carry::<weldsuite_ai::Ai>(from, extensions);
    inner
}

/// The middleware of `/:workspaceId/*`: the allow-list, who the call acts
/// for, the workspace; then the platform's handler for the rest of the path,
/// as a request of its own (only what the handlers read carried over).
async fn dispatch(
    State(internal): State<Internal>,
    Path(path): Path<String>,
    request: Request,
) -> Response {
    // `/:workspaceId` alone is the middleware's too: nothing is allowed there.
    let (workspace_ref, rest) = match path.split_once('/') {
        Some((workspace, rest)) => (workspace.to_owned(), format!("/{rest}")),
        None => (path.clone(), String::new()),
    };
    if !is_allowed_read(request.method(), &rest) {
        return ApiError::not_found("Route", Some(&rest)).into_response();
    }
    let person = header(request.headers(), "x-weld-user").map(str::to_owned);
    let key = header(request.headers(), "x-weld-workspace-key").map(str::to_owned);
    let Some(actor) = person.clone().or_else(|| key.clone()) else {
        return ApiError::unauthorized().into_response();
    };

    let Some(tenants) = tenants(&request, &internal.state) else {
        return ApiError::not_found("Workspace", Some(&workspace_ref)).into_response();
    };
    let workspace = match tenants.find(&workspace_ref).await {
        Ok(Some(workspace)) => workspace,
        Ok(None) => return ApiError::not_found("Workspace", Some(&workspace_ref)).into_response(),
        Err(error) => {
            tracing::warn!(%error, "[panel-api] internal: workspace lookup failed");
            return ApiError::not_found("Workspace", Some(&workspace_ref)).into_response();
        }
    };
    if workspace.suspended {
        return ApiError::forbidden()
            .with_message("This workspace is suspended")
            .into_response();
    }

    // The rest of the path, with its query string, for the platform's router.
    let query = request
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let Ok(uri) = format!("{rest}{query}").parse::<Uri>() else {
        return ApiError::not_found("Route", Some(&rest)).into_response();
    };
    let mut inner = inner_request(request, uri);
    let extensions = inner.extensions_mut();
    let clerk_org_id = workspace
        .clerk_org_id
        .clone()
        .unwrap_or_else(|| workspace.id.clone());
    extensions.insert(Tenant {
        workspace_id: workspace.id.clone(),
        clerk_org_id: Some(clerk_org_id.clone()),
        db: workspace.db.clone(),
        suspended: false,
        restrictions: WorkspaceRestrictions::default(),
    });
    extensions.insert(AuthContext {
        user_id: actor.clone(),
        org_id: Some(clerk_org_id),
        session_id: String::new(),
        factor_verification_age: None,
    });
    let resolved = if person.is_some() {
        let Some(resolving) = (internal.resolve)(extensions) else {
            return ApiError::internal().into_response();
        };
        match resolving.await {
            Ok(resolved) => resolved,
            Err(error) => return unexpected(&error, "resolve permissions"),
        }
    } else {
        workspace_key_permissions()
    };
    let extensions = inner.extensions_mut();
    let app = extensions.get::<AppContext>().map(|app| app.0);
    extensions.insert(PresetPermissions(Permissions::new(
        resolved, app, false, actor,
    )));
    match internal.inner.oneshot(inner).await {
        Ok(response) => response,
        Err(never) => match never {},
    }
}

/// `GET /:workspaceId/reports/:id/results`: a saved report run as saved (or
/// over another preset), with its own scope. `panel_reports:read`.
async fn results(
    State(state): State<PanelState>,
    caller: Caller,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::extract::RawQuery(raw): axum::extract::RawQuery,
) -> Response {
    let parsed = match weldsuite_zod::query(&RESULTS_QUERY, raw.as_deref()) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let report = match get_report(&caller.db, &id).await {
        Ok(report) => report,
        Err(error) => return unexpected(&error, "get report"),
    };
    let actor = Actor {
        user_id: caller.user_id.clone(),
        can_manage: false,
    };
    let Some(report) = report.filter(|report| can_see(report, &actor)) else {
        return ApiError::not_found("Report", Some(&id)).into_response();
    };
    let mut spec = report["spec"].clone();
    if let (Some(preset), Some(fields)) = (parsed.text("preset"), spec.as_object_mut()) {
        fields.insert("dateRange".to_owned(), json!({ "preset": preset }));
    }
    let invalid =
        || ApiError::bad_request("The report\u{2019}s query is no longer valid").into_response();
    let Ok(parsed_spec) = weldsuite_zod::parse_issues(&PANEL_QUERY_SPEC, &spec) else {
        return invalid();
    };
    let value = Value::Object(parsed_spec.body);
    if value["projectId"] != report["projectId"] {
        return invalid();
    }
    let typed = match serde_json::from_value(value.clone()) {
        Ok(typed) => typed,
        Err(error) => return unexpected(&error, "a parsed spec the compiler can't read"),
    };
    let deps = QueryDeps::new(&caller, &state);
    match run_cached_query(&deps, &value, &typed).await {
        Ok(run) => {
            let mut body = match run.result {
                Value::Object(result) => result,
                _ => Map::new(),
            };
            body.insert("dataAsOf".to_owned(), run.data_as_of.unwrap_or(Value::Null));
            body.insert("cached".to_owned(), Value::Bool(run.cached));
            Data(Value::Object(body)).into_response()
        }
        Err(failure) => failure.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_listed_reads_are_served() {
        let get = Method::GET;
        for path in [
            "/projects",
            "/reports",
            "/reports/pnr_1",
            "/reports/pnr_1/results",
            "/dashboards",
            "/dashboards/pnd_1",
            "/cohorts",
            "/lexicon",
            "/people",
            "/people/user_1",
            "/groups",
            "/groups/company/acme",
        ] {
            assert!(is_allowed_read(&get, path), "{path}");
        }
        assert!(is_allowed_read(&Method::POST, "/query"));
        for (method, path) in [
            (Method::POST, "/reports"),
            (Method::DELETE, "/reports/pnr_1"),
            (Method::POST, "/projects/pnp_a/rotate-token"),
            (Method::GET, "/people/by-email"),
            (Method::DELETE, "/groups/company/acme"),
            (Method::GET, "/groups/company/acme/extra"),
            (Method::GET, "/query"),
            (Method::GET, "/projects/pnp_a"),
        ] {
            assert!(!is_allowed_read(&method, path), "{method} {path}");
        }
    }
}
