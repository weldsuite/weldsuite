//! Breakdowns for trends, funnels and retention (`breakdowns.ts`): up to
//! three at once (values joined with ` / `), numeric buckets, and the top N
//! picked in a first, cheap statement.
//!
//! The steps, each a statement only when needed:
//!   1. `auto` buckets: the range of the values (`MIN` / `MAX`).
//!   2. The top combined values by count.
//!   3. The caller's main statement folds everything else into `Other`.

use std::collections::HashMap;

use super::context::PanelQueryContext;
use super::rows::{PanelError, PanelSqlExecutor, PanelSqlQuery, Row, Runner, to_number, to_text};
use super::scope::{
    BreakdownExprOptions, EventsScope, NONE_LABEL, OTHER_LABEL, breakdown_expr,
    breakdown_number_expr, bucket_labels_for, limited_expr,
};
use super::sql::{QueryResult, int, lit};
use crate::js;
use crate::schemas::{BreakdownBucket, PANEL_BREAKDOWN_JOINER, PanelBreakdown};

const DEFAULT_AUTO_BUCKETS: i64 = 5;

/// Round step sizes: 1, 2, 2.5, 5 times a power of ten.
fn nice_step(raw: f64) -> f64 {
    if raw <= 0.0 || !raw.is_finite() {
        return 1.0;
    }
    let power = js::pow10(raw.log10().floor());
    let fraction = raw / power;
    let nice = [1.0, 2.0, 2.5, 5.0, 10.0]
        .into_iter()
        .find(|f| fraction <= *f)
        .unwrap_or(10.0);
    nice * power
}

/// `autoEdges`: `count` equal, round buckets over `[min, max]`: the inner edges.
pub fn auto_edges(min: f64, max: f64, count: i64) -> Vec<f64> {
    if !min.is_finite() || !max.is_finite() {
        return vec![0.0];
    }
    if max <= min {
        return vec![min];
    }
    let step = nice_step((max - min) / count as f64);
    let start = (min / step).floor() * step;
    let mut edges = Vec::new();
    for i in 1..count {
        let edge = js::to_precision(start + step * i as f64, 12);
        if edge > min && edge <= max {
            edges.push(edge);
        }
    }
    if edges.is_empty() {
        vec![js::to_precision(start + step, 12)]
    } else {
        edges
    }
}

/// What steps 1 and 2 found.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedBreakdowns {
    pub list: Vec<PanelBreakdown>,
    /// SQL of each breakdown's (bucketed) value.
    pub parts: Vec<String>,
    /// The value the statements group by: the parts joined with ` / `.
    pub combined: String,
    /// Bucket labels in order for each bucketed part.
    pub bucket_labels: Vec<Option<Vec<String>>>,
    /// Top combined values in rank order (bucket order for one bucketed breakdown).
    pub values: Vec<String>,
    /// Each top value split into its parts.
    pub parts_of: HashMap<String, Vec<String>>,
}

/// What the probe statements read.
pub struct BreakdownProbe<'a> {
    pub ctx: &'a PanelQueryContext,
    pub scope: &'a EventsScope,
    /// Conditions the probe reads (the events of the report).
    pub where_: Vec<String>,
    /// What a row counts: `COUNT(*)` or `COUNT(DISTINCT person)`.
    pub measure: String,
    /// Statement name prefix: `trends`, `funnel`, `retention`.
    pub name: &'a str,
    pub clean_paths: Option<bool>,
}

fn combine(parts: &[String]) -> QueryResult<String> {
    if parts.len() == 1 {
        return Ok(parts[0].clone());
    }
    let joiner = format!(" || {} || ", lit(PANEL_BREAKDOWN_JOINER)?);
    Ok(format!("({})", parts.join(&joiner)))
}

/// `prepareBreakdowns`: steps 1 and 2 for `list`; `None` without breakdowns.
pub async fn prepare_breakdowns<E: PanelSqlExecutor + ?Sized>(
    list: &[&PanelBreakdown],
    probe: &BreakdownProbe<'_>,
    runner: &Runner<'_, E>,
) -> Result<Option<PreparedBreakdowns>, PanelError> {
    if list.is_empty() {
        return Ok(None);
    }
    let ctx = probe.ctx;
    let scope = probe.scope;

    // 1. Auto buckets need the range of the values first.
    let autos: Vec<(usize, i64)> = list
        .iter()
        .enumerate()
        .filter_map(|(i, b)| match b.bucket() {
            Some(BreakdownBucket::Auto { count }) => {
                Some((i, count.unwrap_or(DEFAULT_AUTO_BUCKETS)))
            }
            _ => None,
        })
        .collect();
    let mut edges: Vec<Option<Vec<f64>>> = list
        .iter()
        .map(|b| match b.bucket() {
            Some(BreakdownBucket::Custom { edges }) => Some(edges.clone()),
            _ => None,
        })
        .collect();
    if !autos.is_empty() {
        let mut selects = Vec::new();
        let mut columns = Vec::new();
        for (i, _) in &autos {
            let value = breakdown_number_expr(list[*i], ctx)?;
            selects.push(format!("MIN({value}) AS min{i}"));
            selects.push(format!("MAX({value}) AS max{i}"));
            columns.push(format!("min{i}"));
            columns.push(format!("max{i}"));
        }
        let sql = format!(
            "SELECT {} FROM {} {}",
            selects.join(", "),
            scope.from,
            scope.where_sql(&probe.where_)
        );
        let query = PanelSqlQuery {
            name: format!("{}.breakdownRange", probe.name),
            sql,
            columns,
        };
        let rows = runner.run_one(query).await?;
        let row = rows.into_iter().next().unwrap_or_default();
        for (i, count) in &autos {
            let min = row.get(&format!("min{i}"));
            let max = row.get(&format!("max{i}"));
            edges[*i] = Some(match min {
                None | Some(serde_json::Value::Null) => vec![0.0],
                Some(min) => auto_edges(to_number(Some(min)), to_number(max), *count),
            });
        }
    }

    let parts = list
        .iter()
        .zip(&edges)
        .map(|(b, e)| {
            breakdown_expr(
                b,
                ctx,
                BreakdownExprOptions {
                    clean_paths: probe.clean_paths,
                    edges: e.as_deref(),
                },
            )
        })
        .collect::<QueryResult<Vec<_>>>()?;
    let bucket_labels: Vec<Option<Vec<String>>> = list
        .iter()
        .zip(&edges)
        .map(|(b, e)| match (b.bucket(), e) {
            (Some(_), Some(e)) => {
                let mut labels = bucket_labels_for(e);
                labels.push(NONE_LABEL.to_owned());
                Some(labels)
            }
            _ => None,
        })
        .collect();
    let combined = combine(&parts)?;

    // 2. The top values. A single bucketed breakdown shows every bucket.
    let single = if list.len() == 1 {
        bucket_labels[0].clone()
    } else {
        None
    };
    let limit = match &single {
        Some(labels) => labels.len() as i64,
        None => list.iter().map(|b| b.limit()).max().unwrap_or(0).min(25),
    };
    let part_selects: Vec<String> = parts
        .iter()
        .enumerate()
        .map(|(i, p)| format!("{p} AS v{i}"))
        .collect();
    let sql = format!(
        "SELECT {combined} AS value, {}, {measure} AS n FROM {} {} GROUP BY {} ORDER BY {measure} DESC LIMIT {}",
        part_selects.join(", "),
        scope.from,
        scope.where_sql(&probe.where_),
        parts.join(", "),
        int(limit, 25)?,
        measure = probe.measure,
    );
    let mut columns = vec!["value".to_owned()];
    columns.extend((0..parts.len()).map(|i| format!("v{i}")));
    columns.push("n".to_owned());
    let rows: Vec<Row> = runner
        .run_one(PanelSqlQuery {
            name: format!("{}.breakdownValues", probe.name),
            sql,
            columns,
        })
        .await?;

    let mut parts_of = HashMap::new();
    let mut values: Vec<String> = rows
        .iter()
        .map(|r| {
            let value = to_text(r.get("value"));
            let split = (0..parts.len())
                .map(|i| match r.get(&format!("v{i}")) {
                    None => value.clone(),
                    Some(part) => to_text(Some(part)),
                })
                .collect();
            parts_of.insert(value.clone(), split);
            value
        })
        .collect();
    if let Some(single) = &single {
        let rank = |v: &String| single.iter().position(|l| l == v).map_or(-1, |p| p as i64);
        values.sort_by_key(rank);
    }
    let list = list.iter().map(|b| (*b).clone()).collect();
    Ok(Some(PreparedBreakdowns {
        list,
        parts,
        combined,
        bucket_labels,
        values,
        parts_of,
    }))
}

/// `limitedBreakdown`: the combined value with everything outside the top
/// values folded into `Other`.
pub fn limited_breakdown(prepared: &PreparedBreakdowns) -> QueryResult<String> {
    limited_expr(&prepared.combined, &prepared.values)
}

/// `orderedValues`: the top values that have data, `Other` last.
pub fn ordered_values(prepared: &PreparedBreakdowns, seen: &[String]) -> Vec<String> {
    let mut out: Vec<String> = prepared
        .values
        .iter()
        .filter(|v| seen.contains(v))
        .cloned()
        .collect();
    let other = OTHER_LABEL.to_owned();
    if seen.contains(&other) && !prepared.values.contains(&other) {
        out.push(other);
    }
    out
}

/// `partsFor`: the parts of a line's value; `None` for `Other` or without breakdowns.
pub fn parts_for(
    prepared: Option<&PreparedBreakdowns>,
    value: Option<&str>,
) -> Option<Vec<String>> {
    let (prepared, value) = (prepared?, value?);
    prepared.parts_of.get(value).cloned()
}
