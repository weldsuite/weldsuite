//! Metric tree values (`routes/metric-tree-values`,
//! `services/metric-tree-values.ts`); the trees themselves are
//! `/api/panel/metric-trees`.
//!
//!   POST /api/panel/metric-tree-values       { projectId, nodes, dateRange?, timezone? }  (the editor's preview)
//!   POST /api/panel/metric-tree-values/:id   { dateRange?, timezone? }                    (a saved tree)
//!
//! Each node's single trends series over a period and the period before it,
//! the change, and for `influence` nodes how closely its daily values follow
//! the parent's (Pearson). Every node runs through the cached query run, so
//! nodes shared between trees (or with a report on a dashboard) cost one
//! engine read per two minutes. A node that cannot run (its report is gone,
//! hidden, not a trends report, or refused by the compiler) carries an error
//! and the others still answer. `panel_reports:read`; reads only.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_kit::{ApiError, Data};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::schemas::PanelQuerySpec;
use weldsuite_permissions::Permissions;
use weldsuite_zod::{Keys, Z};

use crate::projects::live_project;
use crate::query::{QueryDeps, QueryFailure, run_cached_query};
use crate::saved::{Actor, can_see};
use crate::schemas_gen::{
    PANEL_METRIC_TREE_NODES, PANEL_METRIC_TREE_VALUES, PANEL_SAVED_METRIC_TREE_VALUES, TRENDS_SPEC,
};
use crate::{Caller, PanelState, unexpected};

/// A saved tree's nodes, as `panelMetricTreeNodesSchema.safeParse` reads them.
const NODES: Z = Z::Obj(&[("nodes", PANEL_METRIC_TREE_NODES)], Keys::Strip);

/// Nodes run a few at a time: each is up to four engine statements.
const NODES_AT_ONCE: usize = 4;

/// `pearson(a, b)`: the correlation of two equally long series, rounded to
/// four decimals; `None` when either is flat or shorter than three.
pub(crate) fn pearson(a: &[f64], b: &[f64]) -> Option<f64> {
    let n = a.len().min(b.len());
    if n < 3 {
        return None;
    }
    #[allow(clippy::cast_precision_loss, reason = "a series' length")]
    let count = n as f64;
    let ma = a[..n].iter().sum::<f64>() / count;
    let mb = b[..n].iter().sum::<f64>() / count;
    let (mut cov, mut va, mut vb) = (0.0, 0.0, 0.0);
    for i in 0..n {
        let da = a[i] - ma;
        let db = b[i] - mb;
        cov += da * db;
        va += da * da;
        vb += db * db;
    }
    if va == 0.0 || vb == 0.0 {
        return None;
    }
    Some(js::math_round(cov / (va * vb).sqrt() * 10000.0) / 10000.0)
}

/// A node's spec, or why it can't run.
#[derive(Clone)]
enum Resolved {
    Spec(Value),
    Error(String),
}

/// `reportSpecs`: the specs behind `{ reportId }` nodes, checked: the same
/// project, visible to the caller, a trends report.
async fn report_specs(
    caller: &Caller,
    actor: &Actor,
    project_id: &str,
    nodes: &[Value],
) -> Result<HashMap<String, Resolved>, sqlx::Error> {
    let ids = js::distinct(
        nodes
            .iter()
            .filter_map(|n| n["metric"]["reportId"].as_str().map(str::to_owned)),
    );
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from panel_reports r
         where r.project_id = $1 and r.id = any($2) and r.deleted_at is null",
    )
    .bind(project_id)
    .bind(&ids)
    .fetch_all(&caller.db)
    .await?;
    let rows: Vec<Value> = rows.into_iter().map(weldsuite_db::js_row).collect();
    for id in ids {
        let row = rows.iter().find(|r| r["id"].as_str() == Some(id.as_str()));
        let resolved = match row {
            Some(row) if can_see(row, actor) => {
                let mut raw = row["spec"].as_object().cloned().unwrap_or_default();
                raw.insert("projectId".to_owned(), json!(project_id));
                match weldsuite_zod::parse_issues(&TRENDS_SPEC, &Value::Object(raw)) {
                    Ok(parsed) => Resolved::Spec(Value::Object(parsed.body)),
                    Err(_) => Resolved::Error("not_a_trends_report".to_owned()),
                }
            }
            _ => Resolved::Error("report_not_found".to_owned()),
        };
        out.insert(id, resolved);
    }
    Ok(out)
}

/// The period of the values (`ValuesPeriod`).
struct Period {
    date_range: Option<Value>,
    timezone: Option<Value>,
}

/// `nodeSpec(spec, projectId, period)`: the node's first series, daily, with
/// the previous period, over the tree's period; as `trendsSpecSchema.parse`
/// answers it (a refusal is the node's `query_failed`).
fn node_spec(spec: &Value, project_id: &str, period: &Period) -> Option<(Value, PanelQuerySpec)> {
    let series = spec["series"]
        .as_array()
        .and_then(|s| s.first())
        .map_or_else(Vec::new, |first| vec![first.clone()]);
    let mut raw = Map::new();
    raw.insert("projectId".to_owned(), json!(project_id));
    raw.insert("kind".to_owned(), json!("trends"));
    raw.insert("series".to_owned(), Value::Array(series));
    if let Some(filters) = spec.get("filters") {
        raw.insert("filters".to_owned(), filters.clone());
    }
    raw.insert("interval".to_owned(), json!("day"));
    raw.insert("compare".to_owned(), json!(true));
    raw.insert(
        "dateRange".to_owned(),
        period
            .date_range
            .clone()
            .unwrap_or_else(|| json!({ "preset": "30d" })),
    );
    raw.insert(
        "timezone".to_owned(),
        period.timezone.clone().unwrap_or_else(|| json!("UTC")),
    );
    if let Some(clean) = spec.get("cleanPaths") {
        raw.insert("cleanPaths".to_owned(), clean.clone());
    }
    let parsed = weldsuite_zod::parse_issues(&TRENDS_SPEC, &Value::Object(raw)).ok()?;
    let value = Value::Object(parsed.body);
    let typed = serde_json::from_value::<PanelQuerySpec>(value.clone()).ok()?;
    Some((value, typed))
}

/// One node's run (`NodeRun`).
struct NodeRun {
    value: Option<f64>,
    previous: Option<f64>,
    points: Vec<Value>,
    range: Option<Value>,
    data_as_of: Option<String>,
    error: Option<String>,
}

impl NodeRun {
    fn failed(error: &str) -> Self {
        Self {
            value: None,
            previous: None,
            points: Vec::new(),
            range: None,
            data_as_of: None,
            error: Some(error.to_owned()),
        }
    }
}

/// `runNode`. Only "not configured here" fails the whole request.
async fn run_node(
    deps: &QueryDeps,
    resolved: &Resolved,
    project_id: &str,
    period: &Period,
) -> Result<NodeRun, QueryFailure> {
    let spec = match resolved {
        Resolved::Error(error) => return Ok(NodeRun::failed(error)),
        Resolved::Spec(spec) => spec,
    };
    let Some((value, typed)) = node_spec(spec, project_id, period) else {
        tracing::error!("[panel-api] metric tree node failed: a spec Zod refuses");
        return Ok(NodeRun::failed("query_failed"));
    };
    match run_cached_query(deps, &value, &typed).await {
        Ok(run) => {
            if run.result["kind"] != "trends" {
                return Ok(NodeRun::failed("query_failed"));
            }
            let result = &run.result["result"];
            let line = result["series"].as_array().and_then(|s| s.first());
            Ok(NodeRun {
                value: Some(line.and_then(|l| l["total"].as_f64()).unwrap_or(0.0)),
                previous: line.and_then(|l| l["previous"]["total"].as_f64()),
                points: line
                    .and_then(|l| l["points"].as_array())
                    .cloned()
                    .unwrap_or_default(),
                range: Some(result["range"].clone()),
                data_as_of: run.data_as_of.and_then(|d| d.as_str().map(str::to_owned)),
                error: None,
            })
        }
        Err(QueryFailure::Unavailable) => Err(QueryFailure::Unavailable),
        Err(QueryFailure::Query(message)) => Ok(NodeRun::failed(&message)),
        Err(QueryFailure::Upstream(error)) => {
            tracing::error!(%error, "[panel-api] metric tree node failed");
            Ok(NodeRun::failed("query_failed"))
        }
    }
}

/// `{ bucket, value }` points as pairs.
fn bucket_values(points: &[Value]) -> Vec<(String, f64)> {
    points
        .iter()
        .map(|p| {
            (
                js::value_text(&p["bucket"]),
                p["value"].as_f64().unwrap_or(f64::NAN),
            )
        })
        .collect()
}

/// `metricTreeValues`: every node's value.
async fn metric_tree_values(
    caller: &Caller,
    deps: &QueryDeps,
    actor: &Actor,
    project_id: &str,
    nodes: &[Value],
    period: &Period,
) -> Result<Value, QueryFailure> {
    let reports = report_specs(caller, actor, project_id, nodes)
        .await
        .map_err(QueryFailure::upstream)?;
    let resolved: Vec<Resolved> = nodes
        .iter()
        .map(|node| match node["metric"]["reportId"].as_str() {
            Some(id) => reports
                .get(id)
                .cloned()
                .unwrap_or_else(|| Resolved::Error("report_not_found".to_owned())),
            None => Resolved::Spec(node["metric"]["spec"].clone()),
        })
        .collect();

    let mut runs: Vec<NodeRun> = Vec::with_capacity(nodes.len());
    for batch in resolved.chunks(NODES_AT_ONCE) {
        let outcomes = futures_util::future::join_all(
            batch
                .iter()
                .map(|resolved| run_node(deps, resolved, project_id, period)),
        )
        .await;
        for outcome in outcomes {
            runs.push(outcome?);
        }
    }

    let by_id: HashMap<&str, &NodeRun> = nodes
        .iter()
        .zip(&runs)
        .map(|(node, run)| (node["id"].as_str().unwrap_or_default(), run))
        .collect();
    let values: Vec<Value> = nodes
        .iter()
        .zip(&runs)
        .map(|(node, run)| {
            let parent = node["parentId"].as_str().and_then(|id| by_id.get(id));
            let mut correlation = None;
            if node["relation"] == "influence"
                && let Some(parent) = parent
                && run.error.is_none()
                && parent.error.is_none()
            {
                let parent_by_bucket: HashMap<String, f64> =
                    bucket_values(&parent.points).into_iter().collect();
                let pairs: Vec<(f64, f64)> = bucket_values(&run.points)
                    .into_iter()
                    .filter_map(|(bucket, value)| {
                        parent_by_bucket.get(&bucket).map(|parent| (value, *parent))
                    })
                    .collect();
                let (own, theirs): (Vec<f64>, Vec<f64>) = pairs.into_iter().unzip();
                correlation = pearson(&own, &theirs);
            }
            let change = match (run.value, run.previous) {
                (Some(value), Some(previous)) if previous != 0.0 => {
                    Some(js::math_round((value - previous) / previous * 10000.0) / 10000.0)
                }
                _ => None,
            };
            json!({
                "id": node["id"],
                "label": node["label"],
                "parentId": node["parentId"],
                "relation": node["relation"],
                "value": run.value,
                "previous": run.previous,
                "changePercent": change,
                "correlationWithParent": correlation,
                "points": run.points,
                "error": run.error,
            })
        })
        .collect();

    let range = runs
        .iter()
        .find_map(|r| r.range.clone().filter(|range| !range.is_null()));
    let mut as_of: Vec<(i64, &String)> = runs
        .iter()
        .filter_map(|r| r.data_as_of.as_ref())
        .map(|d| (js::parse_iso(d).unwrap_or(i64::MAX), d))
        .collect();
    as_of.sort_by_key(|(at, _)| *at);
    let data_as_of = as_of
        .first()
        .map_or_else(|| deps.now_iso(), |(_, d)| (*d).clone());
    Ok(js::json_numbers(json!({
        "range": range,
        "nodes": values,
        "dataAsOf": data_as_of,
    })))
}

fn period_of(body: &Map<String, Value>) -> Period {
    Period {
        date_range: body.get("dateRange").cloned(),
        timezone: body.get("timezone").cloned(),
    }
}

/// `POST /`: values for nodes that are not saved.
pub(crate) async fn preview(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let parsed = match weldsuite_zod::json(&PANEL_METRIC_TREE_VALUES, &headers, &body) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    let project_id = parsed.text("projectId").unwrap_or_default().to_owned();
    let project = match live_project(&caller, &project_id).await {
        Ok(Some(project)) => project,
        Ok(None) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "get project"),
    };
    let actor = Actor::of(&caller, &permissions);
    let deps = QueryDeps::new(&caller, &state);
    let nodes = parsed
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    match metric_tree_values(
        &caller,
        &deps,
        &actor,
        project["id"].as_str().unwrap_or(&project_id),
        &nodes,
        &period_of(&parsed.body),
    )
    .await
    {
        Ok(values) => Data(values).into_response(),
        Err(failure) => failure.into_response(),
    }
}

/// `POST /:id`: values for a saved tree the caller may see.
pub(crate) async fn saved(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let parsed = match weldsuite_zod::json(&PANEL_SAVED_METRIC_TREE_VALUES, &headers, &body) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    let actor = Actor::of(&caller, &permissions);
    let tree: Option<Value> = match sqlx::query_scalar(
        "select to_jsonb(t) from panel_metric_trees t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(&id)
    .fetch_optional(&caller.db)
    .await
    {
        Ok(tree) => tree.map(weldsuite_db::js_row),
        Err(error) => return unexpected(&error, "get metric tree"),
    };
    let Some(tree) = tree.filter(|tree| can_see(tree, &actor)) else {
        return ApiError::not_found("Metric tree", Some(&id)).into_response();
    };
    let tree_project = tree["projectId"].as_str().unwrap_or_default().to_owned();
    let project = match live_project(&caller, &tree_project).await {
        Ok(Some(project)) => project,
        Ok(None) => return ApiError::not_found("Project", Some(&tree_project)).into_response(),
        Err(error) => return unexpected(&error, "get project"),
    };
    let Ok(nodes) = weldsuite_zod::parse_issues(&NODES, &json!({ "nodes": tree["nodes"] })) else {
        return ApiError::bad_request(
            "This metric tree is no longer valid; open it and save it again",
        )
        .into_response();
    };
    let nodes = nodes
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let deps = QueryDeps::new(&caller, &state);
    match metric_tree_values(
        &caller,
        &deps,
        &actor,
        project["id"].as_str().unwrap_or(&tree_project),
        &nodes,
        &period_of(&parsed.body),
    )
    .await
    {
        Ok(values) => Data(values).into_response(),
        Err(failure) => failure.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pearson_is_rounded_and_none_for_flat_or_short_series() {
        assert_eq!(pearson(&[1.0, 2.0, 3.0], &[2.0, 4.0, 6.0]), Some(1.0));
        assert_eq!(pearson(&[1.0, 2.0, 3.0], &[3.0, 2.0, 1.0]), Some(-1.0));
        assert_eq!(pearson(&[1.0, 2.0], &[1.0, 2.0]), None);
        assert_eq!(pearson(&[1.0, 1.0, 1.0], &[1.0, 2.0, 3.0]), None);
        assert_eq!(pearson(&[1.0, 2.0, 4.0], &[1.0, 3.0, 2.0]), Some(0.3273));
    }
}
