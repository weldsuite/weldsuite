//! `trends` (`trends.ts`): one or more measures of events over time,
//! filtered, broken down by up to three properties and compared with the
//! previous period, plus formulas over the series (`A / B * 100`).
//!
//! All series share one scan: each is a conditional aggregate over the
//! events that match any series. The breakdown's top values come from a
//! first, cheap statement and are applied as a `CASE` in the second.
//! Formulas are evaluated here, never in SQL. `display: 'cumulative'` turns
//! the points into running totals (distinct-so-far for unique counts, from
//! one more statement per such series).

use std::collections::HashMap;

use super::breakdowns::{
    BreakdownProbe, PreparedBreakdowns, limited_breakdown, ordered_values, parts_for,
    prepare_breakdowns,
};
use super::context::PanelQueryContext;
use super::result_range::to_resolved_range;
use super::rows::{PanelError, PanelSqlExecutor, PanelSqlQuery, Row, Runner, to_number, to_text};
use super::scope::{
    EventsScope, ScopeOptions, ScopeUse, event_property_number, event_with_filters, events_scope,
    group_key_expr, known_group_type, names_condition, scope_needs,
};
use super::sql::{PanelQueryError, QueryResult};
use super::time::{
    ResolvedRange, TimeBounds, bucket_label, bucket_labels, bucket_sql, previous_bounds,
    resolve_range,
};
use crate::expression::{
    ExpressionIdentifierKind, ExpressionNode, ParseExpressionOptions, evaluate, parse_expression,
};
use crate::js;
use crate::schemas::{
    Interval, PanelFormulaLine, PanelFormulaPoint, PanelTrendFormulaResult, PanelTrendLine,
    PanelTrendPoint, PanelTrendSeriesResult, PanelTrendsResult, TrendMath, TrendSeries,
    TrendsDisplay, TrendsSpec, spec_breakdowns,
};

/// `trendsInterval`: the interval asked for, coarsened where it would make
/// thousands of buckets.
pub fn trends_interval(range: &ResolvedRange, requested: Interval) -> Interval {
    let days = (range.to - range.from) as f64 / 86_400_000.0;
    if requested == Interval::Hour && days > 14.0 {
        Interval::Day
    } else {
        requested
    }
}

fn series_group(series: &TrendSeries, ctx: &PanelQueryContext) -> QueryResult<String> {
    group_key_expr(known_group_type(
        ctx,
        series.group_type.as_deref().unwrap_or(""),
    )?)
}

fn series_condition(
    series: &TrendSeries,
    scope: &EventsScope,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
) -> QueryResult<String> {
    let cond = event_with_filters(&series.event, &series.filters, ctx, range, &scope.person)?;
    // A group count leaves out events without that group.
    if series.math == TrendMath::UniqueGroups {
        return Ok(format!(
            "{cond} AND {} IS NOT NULL",
            series_group(series, ctx)?
        ));
    }
    Ok(cond)
}

/// What a distinct measure counts: people, a group key or a session.
fn distinct_unit(
    series: &TrendSeries,
    scope: &EventsScope,
    ctx: &PanelQueryContext,
) -> QueryResult<Option<String>> {
    Ok(match series.math {
        TrendMath::UniqueUsers => Some(scope.person.clone()),
        TrendMath::UniqueGroups => Some(series_group(series, ctx)?),
        TrendMath::Sessions => Some("COALESCE(e.session_id, e.anon_id)".to_owned()),
        _ => None,
    })
}

/// `s<k>_v` (the measure) and `s<k>_u` (users, for per-user averages).
fn series_aggregates(
    series: &TrendSeries,
    index: usize,
    scope: &EventsScope,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
) -> QueryResult<Vec<String>> {
    let cond = series_condition(series, scope, ctx, range)?;
    let v = format!("s{index}_v");
    let u = format!("s{index}_u");
    let property = match series.property.as_deref().filter(|p| !p.is_empty()) {
        Some(property) => event_property_number(property, ctx)?,
        None => String::new(),
    };
    Ok(match series.math {
        TrendMath::Total => vec![format!("COUNT(CASE WHEN {cond} THEN 1 END) AS {v}")],
        TrendMath::UniqueUsers | TrendMath::UniqueGroups | TrendMath::Sessions => {
            let unit = distinct_unit(series, scope, ctx)?.unwrap_or_default();
            vec![format!(
                "COUNT(DISTINCT CASE WHEN {cond} THEN {unit} END) AS {v}"
            )]
        }
        TrendMath::AvgPerUser => vec![
            format!("COUNT(CASE WHEN {cond} THEN 1 END) AS {v}"),
            format!(
                "COUNT(DISTINCT CASE WHEN {cond} THEN {} END) AS {u}",
                scope.person
            ),
        ],
        TrendMath::Sum => vec![format!("SUM(CASE WHEN {cond} THEN {property} END) AS {v}")],
        TrendMath::Avg => vec![format!("AVG(CASE WHEN {cond} THEN {property} END) AS {v}")],
        TrendMath::Min => vec![format!("MIN(CASE WHEN {cond} THEN {property} END) AS {v}")],
        TrendMath::Max => vec![format!("MAX(CASE WHEN {cond} THEN {property} END) AS {v}")],
    })
}

fn aggregate_columns(spec: &TrendsSpec) -> Vec<String> {
    spec.series
        .iter()
        .enumerate()
        .flat_map(|(i, s)| {
            if s.math == TrendMath::AvgPerUser {
                vec![format!("s{i}_v"), format!("s{i}_u")]
            } else {
                vec![format!("s{i}_v")]
            }
        })
        .collect()
}

fn scope_for(
    spec: &TrendsSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    bounds: TimeBounds,
) -> QueryResult<EventsScope> {
    let filters: Vec<&[_]> = spec.series.iter().map(|s| s.filters.as_slice()).collect();
    let events: Vec<&str> = spec.series.iter().map(|s| s.event.as_str()).collect();
    let breakdowns: Vec<_> = spec_breakdowns(spec.breakdown.as_ref(), spec.breakdowns.as_ref())
        .into_iter()
        .map(Some)
        .collect();
    let needs = scope_needs(
        ctx,
        &ScopeUse {
            filters: &filters,
            events: &events,
            breakdowns: &breakdowns,
        },
    )?;
    events_scope(
        ctx,
        range,
        bounds,
        ScopeOptions::with_needs(Some(&spec.base.filters), &needs),
    )
}

fn series_names(spec: &TrendsSpec, ctx: &PanelQueryContext) -> QueryResult<String> {
    let events: Vec<&str> = spec.series.iter().map(|s| s.event.as_str()).collect();
    names_condition(&events, ctx)
}

fn main_queries(
    spec: &TrendsSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    bounds: TimeBounds,
    interval: Interval,
    breakdowns: Option<&PreparedBreakdowns>,
    suffix: &str,
) -> QueryResult<Vec<PanelSqlQuery>> {
    let scope = scope_for(spec, ctx, range, bounds)?;
    let mut aggregates = Vec::new();
    for (i, s) in spec.series.iter().enumerate() {
        aggregates.extend(series_aggregates(s, i, &scope, ctx, range)?);
    }
    let columns = aggregate_columns(spec);
    let bucket = bucket_sql("e.ts", interval, range.offset_minutes);
    let bd = breakdowns.map(limited_breakdown).transpose()?;
    let where_ = scope.where_sql(&[series_names(spec, ctx)?]);

    let bd_select = bd
        .as_ref()
        .map(|bd| format!("{bd} AS bd, "))
        .unwrap_or_default();
    let bd_group = bd.as_ref().map(|bd| format!(", {bd}")).unwrap_or_default();
    let aggregates = aggregates.join(", ");
    let series_sql = format!(
        "SELECT {bucket} AS bucket, {bd_select}{aggregates} FROM {} {where_} GROUP BY {bucket}{bd_group} ORDER BY {bucket} ASC",
        scope.from
    );
    let mut totals_sql = format!(
        "SELECT {bd_select}{aggregates} FROM {} {where_}",
        scope.from
    );
    if let Some(bd) = &bd {
        totals_sql.push_str(" GROUP BY ");
        totals_sql.push_str(bd);
    }
    let bd_column: Vec<String> = bd.iter().map(|_| "bd".to_owned()).collect();
    let mut series_columns = vec!["bucket".to_owned()];
    series_columns.extend(bd_column.iter().cloned());
    series_columns.extend(columns.iter().cloned());
    let mut totals_columns = bd_column;
    totals_columns.extend(columns);
    Ok(vec![
        PanelSqlQuery {
            name: format!("trends.series{suffix}"),
            sql: series_sql,
            columns: series_columns,
        },
        PanelSqlQuery {
            name: format!("trends.totals{suffix}"),
            sql: totals_sql,
            columns: totals_columns,
        },
    ])
}

/// Distinct-so-far for a cumulative line: each person (group, session)
/// counted once, in the bucket of their first matching event.
fn first_seen_query(
    spec: &TrendsSpec,
    index: usize,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    interval: Interval,
    breakdowns: Option<&PreparedBreakdowns>,
) -> QueryResult<PanelSqlQuery> {
    let series = &spec.series[index];
    let scope = scope_for(spec, ctx, range, range.bounds())?;
    let unit = distinct_unit(series, &scope, ctx)?.unwrap_or_default();
    let bucket = bucket_sql("e.ts", interval, range.offset_minutes);
    let bd = breakdowns.map(limited_breakdown).transpose()?;
    let where_ = scope.where_sql(&[series_condition(series, &scope, ctx, range)?]);
    let bd_select = bd
        .as_ref()
        .map(|bd| format!("{bd} AS bd, "))
        .unwrap_or_default();
    let bd_group = bd.as_ref().map(|bd| format!(", {bd}")).unwrap_or_default();
    let inner = format!(
        "SELECT {unit} AS unit, {bd_select}MIN({bucket}) AS first_bucket FROM {} {where_} GROUP BY {unit}{bd_group}",
        scope.from
    );
    let (bd_pick, bd_by) = if bd.is_some() {
        ("bd, ", ", bd")
    } else {
        ("", "")
    };
    let sql = format!(
        "SELECT first_bucket AS bucket, {bd_pick}COUNT(*) AS n FROM ({inner}) AS firsts GROUP BY first_bucket{bd_by}"
    );
    let mut columns = vec!["bucket".to_owned()];
    if bd.is_some() {
        columns.push("bd".to_owned());
    }
    columns.push("n".to_owned());
    Ok(PanelSqlQuery {
        name: format!("trends.firstSeen.s{index}"),
        sql,
        columns,
    })
}

fn measure(series: &TrendSeries, index: usize, row: Option<&Row>) -> f64 {
    let Some(row) = row else {
        return 0.0;
    };
    if series.math == TrendMath::AvgPerUser {
        let users = to_number(row.get(&format!("s{index}_u")));
        return if users > 0.0 {
            to_number(row.get(&format!("s{index}_v"))) / users
        } else {
            0.0
        };
    }
    to_number(row.get(&format!("s{index}_v")))
}

fn round(value: f64) -> f64 {
    js::math_round(value * 100.0) / 100.0
}

fn matches_value(row: &Row, value: Option<&str>) -> bool {
    value.is_none_or(|v| to_text(row.get("bd")) == v)
}

fn line_for(
    series: &TrendSeries,
    index: usize,
    value: Option<&str>,
    series_rows: &[Row],
    total_rows: &[Row],
    labels: &[String],
    interval: Interval,
) -> PanelTrendLine {
    let mut by_bucket: HashMap<String, &Row> = HashMap::new();
    for row in series_rows.iter().filter(|r| matches_value(r, value)) {
        by_bucket.insert(bucket_label(row.get("bucket"), interval), row);
    }
    PanelTrendLine {
        total: round(measure(
            series,
            index,
            total_rows.iter().find(|r| matches_value(r, value)),
        )),
        points: labels
            .iter()
            .map(|bucket| PanelTrendPoint {
                bucket: bucket.clone(),
                value: round(measure(series, index, by_bucket.get(bucket).copied())),
            })
            .collect(),
    }
}

fn running_totals(points: &[PanelTrendPoint]) -> Vec<PanelTrendPoint> {
    let mut running = 0.0;
    points
        .iter()
        .map(|p| {
            running += p.value;
            PanelTrendPoint {
                bucket: p.bucket.clone(),
                value: round(running),
            }
        })
        .collect()
}

/// Running totals. Distinct maths use their first-seen counts; averages and
/// extremes are left per bucket.
fn cumulative_line(
    series: &TrendSeries,
    line: PanelTrendLine,
    first_seen: Option<&[Row]>,
    value: Option<&str>,
    interval: Interval,
) -> PanelTrendLine {
    if let Some(first_seen) = first_seen {
        let mut counts: HashMap<String, f64> = HashMap::new();
        for row in first_seen.iter().filter(|r| matches_value(r, value)) {
            *counts
                .entry(bucket_label(row.get("bucket"), interval))
                .or_insert(0.0) += to_number(row.get("n"));
        }
        let points: Vec<PanelTrendPoint> = line
            .points
            .iter()
            .map(|p| PanelTrendPoint {
                bucket: p.bucket.clone(),
                value: counts.get(&p.bucket).copied().unwrap_or(0.0),
            })
            .collect();
        return PanelTrendLine {
            total: line.total,
            points: running_totals(&points),
        };
    }
    if series.math != TrendMath::Total && series.math != TrendMath::Sum {
        return line;
    }
    PanelTrendLine {
        total: line.total,
        points: running_totals(&line.points),
    }
}

struct Formula {
    expression: String,
    label: String,
    ast: ExpressionNode,
}

/// Each formula parsed once; a formula that does not parse is a 400.
fn parse_formulas(spec: &TrendsSpec) -> QueryResult<Vec<Formula>> {
    spec.formulas
        .iter()
        .flatten()
        .enumerate()
        .map(|(i, formula)| {
            let parsed = parse_expression(
                &formula.expression,
                ParseExpressionOptions {
                    identifiers: ExpressionIdentifierKind::Series,
                    series_count: Some(spec.series.len()),
                },
            )
            .map_err(|err| PanelQueryError::new(format!("Formula {}: {}", i + 1, err.message)))?;
            let label = formula
                .label
                .as_deref()
                .map(js::trim)
                .filter(|l| !l.is_empty())
                .unwrap_or(&formula.expression)
                .to_owned();
            Ok(Formula {
                expression: formula.expression.clone(),
                label,
                ast: parsed.ast,
            })
        })
        .collect()
}

const LETTERS: [&str; 5] = ["A", "B", "C", "D", "E"];

fn round_or_null(value: Option<f64>) -> Option<f64> {
    value.map(|v| js::math_round(v * 10000.0) / 10000.0)
}

/// A formula over lines of the same breakdown value: per bucket and over the totals.
fn formula_line(ast: &ExpressionNode, lines: &[Option<&PanelTrendLine>]) -> PanelFormulaLine {
    let values_at =
        |pick: &dyn Fn(&PanelTrendLine) -> Option<f64>| -> HashMap<String, Option<f64>> {
            lines
                .iter()
                .enumerate()
                .filter_map(|(i, line)| {
                    LETTERS
                        .get(i)
                        .map(|l| ((*l).to_owned(), line.and_then(pick)))
                })
                .collect()
        };
    let labels: Vec<String> = lines
        .iter()
        .flatten()
        .next()
        .map(|l| l.points.iter().map(|p| p.bucket.clone()).collect())
        .unwrap_or_default();
    PanelFormulaLine {
        total: round_or_null(evaluate(ast, &values_at(&|l| Some(l.total)))),
        points: labels
            .into_iter()
            .enumerate()
            .map(|(b, bucket)| PanelFormulaPoint {
                bucket,
                value: round_or_null(evaluate(
                    ast,
                    &values_at(&|l| l.points.get(b).map(|p| p.value)),
                )),
            })
            .collect(),
    }
}

/// `runTrends`.
pub async fn run_trends<E: PanelSqlExecutor + ?Sized>(
    spec: &TrendsSpec,
    ctx: &PanelQueryContext,
    runner: &Runner<'_, E>,
) -> Result<PanelTrendsResult, PanelError> {
    let range = resolve_range(&spec.base.date_range, &spec.base.timezone, ctx)?;
    let interval = trends_interval(&range, spec.interval);
    let previous = spec
        .compare
        .then(|| previous_bounds(range.bounds(), range.floor));
    let formulas = parse_formulas(spec)?;
    let cumulative = spec.display == Some(TrendsDisplay::Cumulative);

    // First pass: the breakdowns' buckets and top values.
    let probe_scope = scope_for(spec, ctx, &range, range.bounds())?;
    let names = series_names(spec, ctx)?;
    let list = spec_breakdowns(spec.breakdown.as_ref(), spec.breakdowns.as_ref());
    let breakdowns = prepare_breakdowns(
        &list,
        &BreakdownProbe {
            ctx,
            scope: &probe_scope,
            where_: vec![names],
            measure: "COUNT(*)".to_owned(),
            name: "trends",
            clean_paths: spec.clean_paths,
        },
        runner,
    )
    .await?;
    let breakdowns = breakdowns.as_ref();

    let mut first_seen_for = Vec::new();
    if cumulative {
        for (i, s) in spec.series.iter().enumerate() {
            if distinct_unit(s, &probe_scope, ctx)?.is_some() {
                first_seen_for.push(i);
            }
        }
    }
    let mut queries = main_queries(spec, ctx, &range, range.bounds(), interval, breakdowns, "")?;
    if let Some(previous) = previous {
        queries.extend(main_queries(
            spec,
            ctx,
            &range,
            previous,
            interval,
            breakdowns,
            ".previous",
        )?);
    }
    for i in &first_seen_for {
        queries.push(first_seen_query(
            spec, *i, ctx, &range, interval, breakdowns,
        )?);
    }
    let results = runner.run(&queries).await?;
    let empty: Vec<Row> = Vec::new();
    let at = |name: &str| -> &[Row] {
        queries
            .iter()
            .position(|q| q.name == name)
            .and_then(|i| results.get(i))
            .map_or(empty.as_slice(), Vec::as_slice)
    };

    let labels = bucket_labels(range.bounds(), interval, range.offset_minutes);
    let previous_labels = previous
        .map(|p| bucket_labels(p, interval, range.offset_minutes))
        .unwrap_or_default();
    let series_rows = at("trends.series");
    let total_rows = at("trends.totals");

    // One line per series, or per breakdown value (top values in rank order,
    // `Other` last, only those with data).
    let seen: Vec<String> = series_rows
        .iter()
        .chain(total_rows)
        .map(|r| to_text(r.get("bd")))
        .collect();
    let breakdown_values: Vec<Option<String>> = match breakdowns {
        Some(prepared) => ordered_values(prepared, &seen)
            .into_iter()
            .map(Some)
            .collect(),
        None => vec![None],
    };

    let mut lines: HashMap<(usize, String), (PanelTrendLine, Option<PanelTrendLine>)> =
        HashMap::new();
    let mut series = Vec::new();
    for (index, s) in spec.series.iter().enumerate() {
        for value in &breakdown_values {
            let value = value.as_deref();
            let mut current = line_for(s, index, value, series_rows, total_rows, &labels, interval);
            let mut before = previous.map(|_| {
                line_for(
                    s,
                    index,
                    value,
                    at("trends.series.previous"),
                    at("trends.totals.previous"),
                    &previous_labels,
                    interval,
                )
            });
            if cumulative {
                let first_seen = first_seen_for
                    .contains(&index)
                    .then(|| at(&format!("trends.firstSeen.s{index}")));
                current = cumulative_line(s, current, first_seen, value, interval);
                // The previous period has no first-seen statement: additive maths only.
                before = before.map(|b| cumulative_line(s, b, None, value, interval));
            }
            lines.insert(
                (index, value.unwrap_or("").to_owned()),
                (current.clone(), before.clone()),
            );
            series.push(PanelTrendSeriesResult {
                series_index: index as i64,
                label: s
                    .label
                    .as_deref()
                    .map(js::trim)
                    .filter(|l| !l.is_empty())
                    .unwrap_or(&s.event)
                    .to_owned(),
                breakdown_value: value.map(str::to_owned),
                breakdown_parts: breakdowns.map(|b| parts_for(Some(b), value)),
                total: current.total,
                points: current.points,
                previous: before,
            });
        }
    }

    let mut result = PanelTrendsResult {
        range: to_resolved_range(&range, previous),
        interval,
        series: if spec.formula_only == Some(true) {
            Vec::new()
        } else {
            series
        },
        cumulative: None,
        formulas: None,
    };
    if cumulative {
        result.cumulative = Some(true);
    }
    if !formulas.is_empty() {
        let mut out = Vec::new();
        for (formula_index, formula) in formulas.iter().enumerate() {
            for value in &breakdown_values {
                let value = value.as_deref();
                let for_value: Vec<Option<&(PanelTrendLine, Option<PanelTrendLine>)>> =
                    (0..spec.series.len())
                        .map(|i| lines.get(&(i, value.unwrap_or("").to_owned())))
                        .collect();
                let currents: Vec<Option<&PanelTrendLine>> =
                    for_value.iter().map(|l| l.map(|(c, _)| c)).collect();
                let current = formula_line(&formula.ast, &currents);
                let previous_line = previous.map(|_| {
                    let befores: Vec<Option<&PanelTrendLine>> = for_value
                        .iter()
                        .map(|l| l.and_then(|(_, p)| p.as_ref()))
                        .collect();
                    formula_line(&formula.ast, &befores)
                });
                out.push(PanelTrendFormulaResult {
                    formula_index: formula_index as i64,
                    label: formula.label.clone(),
                    expression: formula.expression.clone(),
                    breakdown_value: value.map(str::to_owned),
                    breakdown_parts: breakdowns.map(|b| parts_for(Some(b), value)),
                    total: current.total,
                    points: current.points,
                    previous: previous_line,
                });
            }
        }
        result.formulas = Some(out);
    }
    Ok(result)
}
