//! `POST /api/panel/query` (`routes/query/index.ts`) and the cached run every
//! report route shares (`services/query-run.ts`'s `runCachedQuery`): a typed
//! spec (ADR PANEL-003), compiled by `weldsuite-panel-domain` and run on the
//! analytics engine ([`crate::engine`]).
//!
//! `panel_reports:read` for every kind; the recordings list (`sessions`)
//! also needs `panel_recordings:read`. The workspace and project come from
//! the request's auth and the tenant database, never from the spec. Results
//! are cached for two minutes per workspace, project and spec hash, in the
//! cache port (Valkey on the Kubernetes editions; the test's KV in
//! conformance, as `WORKSPACE_CACHE` on Global), under panel-api's key
//! (`panel:q:<workspace>:<project>:<sha256 of the spec>`) and in its entry
//! shape (`{ result, dataAsOf }`), so either backend reads the other's.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_kit::{ApiError, Data};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::query::permissions::required_panel_permissions;
use weldsuite_panel_domain::query::{
    PanelError, PanelQueryContext, run_panel_query, spec_cache_key,
};
use weldsuite_panel_domain::schemas::PanelQuerySpec;
use weldsuite_permissions::Permissions;
use weldsuite_ports::{Cache, DynCache};

use crate::engine::{AnalyticsSql, Engine};
use crate::project_state::PanelProjectState;
use crate::projects::live_project;
use crate::query_context::{ContextInput, build_query_context};
use crate::recordings::favorite_session_ids;
use crate::schemas_gen::PANEL_QUERY_SPEC;
use crate::{Caller, PanelState, unexpected};

/// How long a result is cached (`QUERY_CACHE_SECONDS`).
pub(crate) const QUERY_CACHE_TTL: Duration = Duration::from_secs(120);

/// Why a query could not answer (`queryFailure` in `http.ts`).
#[derive(Debug)]
pub(crate) enum QueryFailure {
    /// The compiler refused the spec: 400 with its message.
    Query(String),
    /// The analytics engine or the project state is not configured here: 503.
    Unavailable,
    /// The engine, the project state or a database failed: 502.
    Upstream(String),
}

impl QueryFailure {
    pub(crate) fn upstream(error: impl std::fmt::Display) -> Self {
        Self::Upstream(error.to_string())
    }

    pub(crate) fn into_response(self) -> Response {
        match self {
            Self::Query(message) => ApiError::bad_request(message).into_response(),
            Self::Unavailable => {
                ApiError::unavailable("Analytics queries are not configured here").into_response()
            }
            Self::Upstream(error) => {
                tracing::error!(%error, "[panel-api] query failed");
                ApiError::bad_gateway()
                    .with_message("The analytics store did not answer")
                    .into_response()
            }
        }
    }
}

impl From<PanelError> for QueryFailure {
    fn from(error: PanelError) -> Self {
        match error {
            PanelError::Query(error) => Self::Query(error.message),
            PanelError::Engine(error) => Self::Upstream(error.to_string()),
        }
    }
}

/// What a query run reads from, for one request (`QueryRunDeps`).
pub(crate) struct QueryDeps {
    pub(crate) tenant: weldsuite_db::PgPool,
    pub(crate) master: Option<weldsuite_db::PgPool>,
    pub(crate) cache: Option<Arc<dyn DynCache>>,
    pub(crate) engine: Option<Arc<dyn AnalyticsSql>>,
    pub(crate) state: Option<Arc<dyn PanelProjectState>>,
    /// `workspaces.id`.
    pub(crate) workspace_id: String,
    /// The test's clock (conformance), else the real one.
    pub(crate) now: Option<i64>,
}

impl QueryDeps {
    pub(crate) fn new(caller: &Caller, state: &PanelState) -> Self {
        Self {
            tenant: caller.db.clone(),
            master: caller.master(state),
            cache: caller.cache(state),
            engine: caller.analytics(state),
            state: caller.project_state(state),
            workspace_id: caller.workspace_id.clone(),
            now: caller.now(),
        }
    }

    /// `new Date().toISOString()` on the request's clock.
    pub(crate) fn now_iso(&self) -> String {
        js::iso_string(self.now.unwrap_or_else(js::now_millis))
    }

    /// The engine, or the 503 of panel-api without its Basin settings.
    pub(crate) fn engine(&self) -> Result<Engine, QueryFailure> {
        self.engine
            .clone()
            .map(Engine)
            .ok_or(QueryFailure::Unavailable)
    }

    /// `buildQueryContext` for `spec` in `project_id`.
    pub(crate) async fn context(
        &self,
        project_id: &str,
        spec: &PanelQuerySpec,
    ) -> Result<PanelQueryContext, QueryFailure> {
        build_query_context(ContextInput {
            tenant: &self.tenant,
            master: self.master.as_ref(),
            state: self.state.clone(),
            workspace_id: &self.workspace_id,
            project_id,
            spec,
            now: self.now,
        })
        .await
    }
}

/// A run's answer (`CachedQuery`): the result as `{ kind, result }`.
pub(crate) struct CachedQuery {
    pub(crate) result: Value,
    /// When the engine was read (ISO); older when the answer came from the cache.
    pub(crate) data_as_of: Option<Value>,
    pub(crate) cached: bool,
}

/// `runCachedQuery(deps, spec)`: the cache, else compile and run. `parsed`
/// is the spec as Zod parsed it (what the cache key hashes), `spec` the
/// same in the compiler's types.
pub(crate) async fn run_cached_query(
    deps: &QueryDeps,
    parsed: &Value,
    spec: &PanelQuerySpec,
) -> Result<CachedQuery, QueryFailure> {
    let project_id = spec.project_id();
    let key = spec_cache_key(&deps.workspace_id, project_id, parsed);

    if let Some(cache) = &deps.cache {
        match cache.get(&key).await {
            Ok(Some(text)) => {
                if let Ok(Value::Object(entry)) = serde_json::from_str::<Value>(&text) {
                    return Ok(CachedQuery {
                        result: entry.get("result").cloned().unwrap_or(Value::Null),
                        data_as_of: entry.get("dataAsOf").cloned(),
                        cached: true,
                    });
                }
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "[panel-api] query cache read failed"),
        }
    }

    let engine = deps.engine()?;
    let ctx = deps.context(project_id, spec).await?;
    let output = run_panel_query(spec, &ctx, &engine).await?;
    if let Some(bytes) = output.stats.bytes_scanned {
        tracing::warn!(
            kind = spec.kind().as_str(),
            statements = output.stats.queries,
            bytes_scanned = bytes,
            "[panel-api] basin"
        );
    }
    let result = output.result.to_json();
    let data_as_of = deps.now_iso();
    if let Some(cache) = &deps.cache {
        let entry = json!({ "result": result, "dataAsOf": data_as_of });
        if let Err(error) = cache
            .put(&key, &entry.to_string(), Some(QUERY_CACHE_TTL))
            .await
        {
            tracing::warn!(%error, "[panel-api] query cache write failed");
        }
    }
    Ok(CachedQuery {
        result,
        data_as_of: Some(Value::String(data_as_of)),
        cached: false,
    })
}

/// A body as `panelQuerySpecSchema` parses it, and in the compiler's types.
pub(crate) fn parse_spec(
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<(Value, PanelQuerySpec), Box<Response>> {
    let parsed = weldsuite_zod::json(&PANEL_QUERY_SPEC, headers, body).map_err(Box::new)?;
    let value = Value::Object(parsed.body);
    match serde_json::from_value::<PanelQuerySpec>(value.clone()) {
        Ok(spec) => Ok((value, spec)),
        Err(error) => Err(Box::new(unexpected(
            &error,
            "a parsed spec the compiler can't read",
        ))),
    }
}

/// The session ids of a `sessions` result's rows.
fn session_ids(result: &Value) -> Vec<String> {
    result["result"]["sessions"]
        .as_array()
        .map(|sessions| {
            sessions
                .iter()
                .filter_map(|s| s["sessionId"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// `POST /`: runs a spec.
pub(crate) async fn run(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (parsed, spec) = match parse_spec(&headers, &body) {
        Ok(spec) => spec,
        Err(response) => return *response,
    };
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    for permission in required_panel_permissions(spec.kind()) {
        if !permissions.has_any(&[*permission]) {
            return ApiError::forbidden()
                .with_message(format!("Missing permission: {permission}"))
                .into_response();
        }
    }
    let project_id = spec.project_id().to_owned();
    let project = match live_project(&caller, &project_id).await {
        Ok(Some(project)) => project,
        Ok(None) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "get project"),
    };

    let deps = QueryDeps::new(&caller, &state);
    let mut entry = match run_cached_query(&deps, &parsed, &spec).await {
        Ok(entry) => entry,
        Err(failure) => return failure.into_response(),
    };

    // Favourites are per project, not part of the cached data.
    let ids = session_ids(&entry.result);
    if entry.result["kind"] == "sessions" && !ids.is_empty() {
        let favourites = favorite_session_ids(
            &caller.db,
            project["id"].as_str().unwrap_or(&project_id),
            ids,
        )
        .await;
        let favourites = match favourites {
            Ok(favourites) => favourites,
            Err(error) => return unexpected(&error, "session favourites"),
        };
        if let Some(sessions) = entry.result["result"]["sessions"].as_array_mut() {
            for session in sessions.iter_mut().filter_map(Value::as_object_mut) {
                let favourite = session
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| favourites.iter().any(|f| f == id));
                session.insert("favorite".to_owned(), Value::Bool(favourite));
            }
        }
    }

    // `{ ...entry.result, dataAsOf, cached }`.
    let mut response = match entry.result {
        Value::Object(result) => result,
        _ => Map::new(),
    };
    if let Some(data_as_of) = entry.data_as_of {
        response.insert("dataAsOf".to_owned(), data_as_of);
    }
    response.insert("cached".to_owned(), Value::Bool(entry.cached));
    Data(Value::Object(response)).into_response()
}
