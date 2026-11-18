//! What the result tests share: a fake engine that answers canned rows by
//! statement name and records what it was sent.

#![allow(dead_code)]

use std::sync::Mutex;

use serde_json::{Map, Value, json};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::query::{
    EngineError, PanelError, PanelQueryContext, PanelSqlQuery, PanelSqlResult, RunStats,
    run_panel_query,
};
use weldsuite_panel_domain::schemas::PanelQuerySpec;

/// The tests' clock: 2026-11-14T12:00:00Z.
pub(crate) fn now() -> i64 {
    js::parse_iso("2026-11-14T12:00:00Z").expect("an instant")
}

/// `ws_1` / `pnp_1`, a year of retention, anonymous only.
pub(crate) fn ctx() -> PanelQueryContext {
    PanelQueryContext {
        workspace_id: "ws_1".to_owned(),
        project_id: "pnp_1".to_owned(),
        retention_days: 365.0,
        has_identified_users: false,
        erased_ids: Vec::new(),
        now: Some(now()),
        ..PanelQueryContext::default()
    }
}

/// A spec as a client writes it, parsed (defaults filled in).
pub(crate) fn spec(value: Value) -> PanelQuerySpec {
    serde_json::from_value(value).expect("a valid spec")
}

/// What a run gave.
pub(crate) struct Ran {
    /// `{ kind, result }` as JSON.
    pub(crate) result: Value,
    pub(crate) stats: RunStats,
    pub(crate) sent: Vec<PanelSqlQuery>,
}

impl Ran {
    /// The SQL of the statement named `name` ('' when none was sent).
    pub(crate) fn sql(&self, name: &str) -> String {
        self.sent
            .iter()
            .find(|q| q.name == name)
            .map(|q| q.sql.clone())
            .unwrap_or_default()
    }

    /// The names of the statements sent, in order.
    pub(crate) fn names(&self) -> Vec<String> {
        self.sent.iter().map(|q| q.name.clone()).collect()
    }

    /// `result.result`.
    pub(crate) fn out(&self) -> &Value {
        &self.result["result"]
    }
}

/// Runs `spec` against canned rows (by statement name), each statement
/// reporting `bytes` scanned.
pub(crate) async fn try_run_with(
    spec_json: Value,
    canned: Value,
    context: &PanelQueryContext,
    bytes: Option<f64>,
) -> Result<Ran, PanelError> {
    let parsed = spec(spec_json);
    let canned: Map<String, Value> = match canned {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let sent = Mutex::new(Vec::new());
    let executor = |query: PanelSqlQuery| {
        let rows = canned
            .get(&query.name)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        sent.lock().expect("not poisoned").push(query);
        async move {
            Ok::<_, EngineError>(PanelSqlResult {
                rows,
                bytes_scanned: bytes,
            })
        }
    };
    let out = run_panel_query(&parsed, context, &executor).await?;
    Ok(Ran {
        result: out.result.to_json(),
        stats: out.stats,
        sent: sent.into_inner().expect("not poisoned"),
    })
}

/// [`try_run_with`] that expects success.
pub(crate) async fn run_with(spec_json: Value, canned: Value, context: &PanelQueryContext) -> Ran {
    try_run_with(spec_json, canned, context, Some(5.0))
        .await
        .expect("the spec runs")
}

/// [`run_with`] in [`ctx`].
pub(crate) async fn run(spec_json: Value, canned: Value) -> Ran {
    run_with(spec_json, canned, &ctx()).await
}

/// The refusal a spec gets.
pub(crate) async fn refusal(spec_json: Value, context: &PanelQueryContext) -> String {
    match try_run_with(spec_json, json!({}), context, None).await {
        Ok(_) => panic!("expected a refusal"),
        Err(PanelError::Query(err)) => err.message,
        Err(err) => panic!("expected a refusal, got {err}"),
    }
}

/// Numbers compared as JavaScript compares them.
pub(crate) fn num(value: &Value) -> f64 {
    value.as_f64().unwrap_or(f64::NAN)
}
