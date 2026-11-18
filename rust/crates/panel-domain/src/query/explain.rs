//! Root cause (`explain.ts`, "why did this move?"): one trends series, a
//! current window and the window before it, split by the usual dimensions
//! and up to three asked properties. Each dimension is one statement over
//! both windows; a totals statement gives the whole change. Window bounds are
//! written `TIMESTAMP … <= e.ts`, so the scope's own bounds stay the only
//! `e.ts >= TIMESTAMP` in a statement.

use super::context::PanelQueryContext;
use super::correlation::by_difference;
use super::paths::cleaned_path;
use super::rows::{PanelSqlQuery, Row, to_number, to_text};
use super::scope::{
    BreakdownExprOptions, EventsScope, ScopeOptions, ScopeUse, breakdown_expr,
    event_property_number, event_with_filters, events_scope, group_key_expr, known_group_type,
    names_condition, scope_needs,
};
use super::sql::{PanelQueryError, QueryResult, ts};
use super::time::{
    ResolvedRange, TimeBounds, add_days, add_months, day_start, previous_bounds, query_now,
    resolve_range,
};
use super::trends::trends_interval;
use crate::js;
use crate::schemas::{
    ExplainPanelChange, Interval, PanelBreakdown, TrendMath, TrendSeries, TrendsSpec,
};

/// The start of a bucket label and of the bucket after it, in the timezone.
fn bucket_bounds(label: &str, interval: Interval, timezone: &str) -> QueryResult<TimeBounds> {
    let day = js::slice_utf16(label, 0, 10);
    match interval {
        Interval::Hour => {
            let hour_text = js::slice_utf16(label, 11, 13);
            let hour = js::string_to_number(if hour_text.is_empty() {
                "0"
            } else {
                &hour_text
            });
            if !hour.is_finite() {
                return Err(PanelQueryError::new("Invalid date"));
            }
            let from = day_start(&day, timezone)? + (hour as i64) * 3_600_000;
            Ok(TimeBounds {
                from,
                to: from + 3_600_000,
            })
        }
        Interval::Month => Ok(TimeBounds {
            from: day_start(&day, timezone)?,
            to: day_start(&add_months(&day, 1)?, timezone)?,
        }),
        Interval::Day | Interval::Week => Ok(TimeBounds {
            from: day_start(&day, timezone)?,
            to: day_start(
                &add_days(&day, if interval == Interval::Week { 7 } else { 1 })?,
                timezone,
            )?,
        }),
    }
}

/// The label of the bucket before `label`.
fn previous_label(label: &str, interval: Interval) -> QueryResult<String> {
    let day = js::slice_utf16(label, 0, 10);
    match interval {
        Interval::Month => add_months(&day, -1),
        Interval::Week => add_days(&day, -7),
        Interval::Day | Interval::Hour => add_days(&day, -1),
    }
}

/// The window to explain and the one it is compared with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExplainWindows {
    pub current: TimeBounds,
    pub baseline: TimeBounds,
}

/// A bucket and the one before it.
fn bucket_windows(label: &str, interval: Interval, timezone: &str) -> QueryResult<ExplainWindows> {
    let current = bucket_bounds(label, interval, timezone)?;
    if interval == Interval::Hour {
        return Ok(ExplainWindows {
            current,
            baseline: TimeBounds {
                from: current.from - 3_600_000,
                to: current.from,
            },
        });
    }
    Ok(ExplainWindows {
        current,
        baseline: TimeBounds {
            from: bucket_bounds(&previous_label(label, interval)?, interval, timezone)?.from,
            to: current.from,
        },
    })
}

/// A bucket or a period of days to explain.
#[derive(Debug, Clone, Copy, Default)]
pub struct ExplainInput<'a> {
    pub bucket: Option<&'a str>,
    /// `(from, to)` days.
    pub period: Option<(&'a str, &'a str)>,
}

/// `explainWindows`: a bucket and the one before it, a period of days and as
/// many days before, or the spec's range and the period before it. Clamped
/// to the retention floor and to now.
pub fn explain_windows(
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    interval: Interval,
    input: ExplainInput<'_>,
) -> QueryResult<ExplainWindows> {
    let now = query_now(ctx);
    let ExplainWindows { current, baseline } =
        if let Some(bucket) = input.bucket.filter(|b| !b.is_empty()) {
            bucket_windows(bucket, interval, &range.timezone)?
        } else if let Some((from, to)) = input.period {
            let current = TimeBounds {
                from: day_start(from, &range.timezone)?,
                to: day_start(&add_days(to, 1)?, &range.timezone)?,
            };
            ExplainWindows {
                current,
                baseline: previous_bounds(current, range.floor),
            }
        } else {
            let current = range.bounds();
            ExplainWindows {
                current,
                baseline: previous_bounds(current, range.floor),
            }
        };
    let clamp = |d: i64| d.max(range.floor).min(now);
    let current = TimeBounds {
        from: clamp(current.from),
        to: clamp(current.to),
    };
    let baseline = TimeBounds {
        from: clamp(baseline.from),
        to: clamp(baseline.to),
    };
    if current.to <= current.from {
        return Err(PanelQueryError::new("That period has not started yet"));
    }
    Ok(ExplainWindows { current, baseline })
}

/// `EXPLAIN_DIMENSIONS`.
pub const EXPLAIN_DIMENSIONS: [&str; 7] = crate::schemas::PANEL_EXPLAIN_DIMENSIONS;

const MAX_VALUES_READ: i64 = 50;

/// A dimension to split by: `country`, …, `event:<key>`, `person:<key>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplainDimension {
    pub name: String,
    pub expr: String,
}

/// The measure of the series inside a window, as one aggregate.
fn window_aggregate(
    series: &TrendSeries,
    scope: &EventsScope,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    window: TimeBounds,
) -> QueryResult<String> {
    let mut cond = format!(
        "{} AND {} <= e.ts AND {} > e.ts",
        event_with_filters(&series.event, &series.filters, ctx, range, &scope.person)?,
        ts(window.from),
        ts(window.to)
    );
    Ok(match series.math {
        TrendMath::Total => format!("COUNT(CASE WHEN {cond} THEN 1 END)"),
        TrendMath::UniqueUsers => {
            format!("COUNT(DISTINCT CASE WHEN {cond} THEN {} END)", scope.person)
        }
        TrendMath::UniqueGroups => {
            let key = group_key_expr(known_group_type(
                ctx,
                series.group_type.as_deref().unwrap_or(""),
            )?)?;
            cond = format!("{cond} AND {key} IS NOT NULL");
            format!("COUNT(DISTINCT CASE WHEN {cond} THEN {key} END)")
        }
        TrendMath::Sessions => {
            format!("COUNT(DISTINCT CASE WHEN {cond} THEN COALESCE(e.session_id, e.anon_id) END)")
        }
        TrendMath::Sum => format!(
            "SUM(CASE WHEN {cond} THEN {} END)",
            event_property_number(series.property.as_deref().unwrap_or(""), ctx)?
        ),
        _ => return Err(PanelQueryError::new("Root cause works on counts and sums")),
    })
}

/// `explainDimensions`: the standard dimensions and the asked properties.
pub fn explain_dimensions(
    ctx: &PanelQueryContext,
    properties: &[PanelBreakdown],
    clean_paths: Option<bool>,
) -> QueryResult<Vec<ExplainDimension>> {
    let dimension = |name: &str, expr: String| ExplainDimension {
        name: name.to_owned(),
        expr,
    };
    let mut out = vec![
        dimension("country", "COALESCE(e.country, '(unknown)')".to_owned()),
        dimension(
            "device_type",
            "COALESCE(e.device_type, '(unknown)')".to_owned(),
        ),
        dimension("browser", "COALESCE(e.browser, '(unknown)')".to_owned()),
        dimension("os", "COALESCE(e.os, '(unknown)')".to_owned()),
        dimension(
            "referrer_host",
            "COALESCE(e.referrer_host, '(direct)')".to_owned(),
        ),
        dimension("utm_source", "COALESCE(e.utm_source, '(none)')".to_owned()),
        dimension(
            "path",
            format!("COALESCE({}, '(none)')", cleaned_path(ctx, clean_paths)?),
        ),
    ];
    for b in properties.iter().take(3) {
        let (PanelBreakdown::Event { key, .. } | PanelBreakdown::Person { key, .. }) = b else {
            return Err(PanelQueryError::new("Use event or person properties"));
        };
        out.push(ExplainDimension {
            name: format!("{}:{key}", b.source()),
            expr: breakdown_expr(&b.without_bucket(), ctx, BreakdownExprOptions::default())?,
        });
    }
    Ok(out)
}

/// `explainQueries`: totals and one statement per dimension, over both windows.
pub fn explain_queries(
    spec: &TrendsSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    windows: &ExplainWindows,
    dimensions: &[ExplainDimension],
    properties: &[PanelBreakdown],
) -> QueryResult<Vec<PanelSqlQuery>> {
    let [series] = spec.series.as_slice() else {
        return Err(PanelQueryError::new("Explain one series at a time"));
    };
    let bounds = TimeBounds {
        from: windows.baseline.from,
        to: windows.current.to,
    };
    let breakdowns: Vec<Option<&PanelBreakdown>> = properties.iter().map(Some).collect();
    let needs = scope_needs(
        ctx,
        &ScopeUse {
            filters: &[series.filters.as_slice()],
            events: &[series.event.as_str()],
            breakdowns: &breakdowns,
        },
    )?;
    let scope = events_scope(
        ctx,
        range,
        bounds,
        ScopeOptions::with_needs(Some(&spec.base.filters), &needs),
    )?;
    let cur = window_aggregate(series, &scope, ctx, range, windows.current)?;
    let base = window_aggregate(series, &scope, ctx, range, windows.baseline)?;
    let where_ = scope.where_sql(&[names_condition(&[series.event.as_str()], ctx)?]);

    let mut queries = vec![PanelSqlQuery::new(
        "explain.totals",
        format!(
            "SELECT {cur} AS cur, {base} AS base FROM {} {where_}",
            scope.from
        ),
        &["cur", "base"],
    )];
    for (i, dim) in dimensions.iter().enumerate() {
        queries.push(PanelSqlQuery::new(
            format!("explain.d{i}"),
            format!(
                "SELECT {expr} AS value, {cur} AS cur, {base} AS base FROM {} {where_} \
                 GROUP BY {expr} ORDER BY ABS(COALESCE({cur}, 0) - COALESCE({base}, 0)) DESC LIMIT {MAX_VALUES_READ}",
                scope.from,
                expr = dim.expr
            ),
            &["value", "cur", "base"],
        ));
    }
    Ok(queries)
}

/// panel-api's root cause (`explainNumbers`) up to the statements: the
/// request's spec without breakdowns and formulas, its range, the windows
/// (at the trends interval), the dimensions and the statements.
pub fn explain_statements(
    request: &ExplainPanelChange,
    ctx: &PanelQueryContext,
) -> QueryResult<Vec<PanelSqlQuery>> {
    let spec = TrendsSpec {
        breakdown: None,
        breakdowns: None,
        formulas: None,
        formula_only: None,
        ..request.spec.clone()
    };
    let range = resolve_range(&spec.base.date_range, &spec.base.timezone, ctx)?;
    let windows = explain_windows(
        ctx,
        &range,
        trends_interval(&range, spec.interval),
        ExplainInput {
            bucket: request.bucket.as_deref(),
            period: request
                .period
                .as_ref()
                .map(|p| (p.from.as_str(), p.to.as_str())),
        },
    )?;
    let dimensions = explain_dimensions(ctx, &request.properties, spec.clean_paths)?;
    explain_queries(
        &spec,
        ctx,
        &range,
        &windows,
        &dimensions,
        &request.properties,
    )
}

/// One value of a dimension.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainValue {
    pub value: String,
    pub current: f64,
    pub baseline: f64,
    pub change: f64,
    pub change_percent: Option<f64>,
    pub contribution_share: f64,
}

/// A dimension's values that explain the move best.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ExplainDimensionResult {
    pub dimension: String,
    pub values: Vec<ExplainValue>,
    pub explained: f64,
}

/// The whole move.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainMetric {
    pub current: f64,
    pub baseline: f64,
    pub change: f64,
    pub change_percent: Option<f64>,
}

/// What [`explain_from`] answers.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ExplainOutcome {
    pub metric: ExplainMetric,
    pub dimensions: Vec<ExplainDimensionResult>,
}

fn percent(change: f64, baseline: f64) -> Option<f64> {
    (baseline != 0.0).then(|| js::math_round(change / baseline * 10000.0) / 10000.0)
}

fn round(value: f64) -> f64 {
    js::math_round(value * 10000.0) / 10000.0
}

/// `explainFrom`: rows in, ranked dimensions out.
pub fn explain_from(
    dimensions: &[ExplainDimension],
    totals: Option<&Row>,
    rows_per_dimension: &[Vec<Row>],
    limit: i64,
) -> ExplainOutcome {
    let current = to_number(totals.and_then(|r| r.get("cur")));
    let baseline = to_number(totals.and_then(|r| r.get("base")));
    let change = current - baseline;
    let direction = if change >= 0.0 { 1.0 } else { -1.0 };
    let limit = usize::try_from(limit).unwrap_or(0);

    let mut results: Vec<ExplainDimensionResult> = dimensions
        .iter()
        .enumerate()
        .map(|(i, dim)| {
            let rows = rows_per_dimension.get(i).map_or(&[][..], Vec::as_slice);
            let mut values: Vec<ExplainValue> = rows
                .iter()
                .map(|r| {
                    let cur = to_number(r.get("cur"));
                    let base = to_number(r.get("base"));
                    let delta = cur - base;
                    ExplainValue {
                        value: to_text(r.get("value")),
                        current: cur,
                        baseline: base,
                        change: delta,
                        change_percent: percent(delta, base),
                        contribution_share: if change == 0.0 {
                            0.0
                        } else {
                            round(delta / change)
                        },
                    }
                })
                .collect();
            values.sort_by(|a, b| by_difference(direction * (b.change - a.change)));
            values.truncate(limit);
            // How much more of the change the best value carries than its share of the traffic.
            let share = |v: &ExplainValue| {
                if baseline > 0.0 {
                    v.baseline / baseline
                } else if current > 0.0 {
                    v.current / current
                } else {
                    0.0
                }
            };
            let explained = values
                .iter()
                .fold(0.0_f64, |best, v| best.max(v.contribution_share - share(v)));
            ExplainDimensionResult {
                dimension: dim.name.clone(),
                values,
                explained: round(explained.clamp(0.0, 1.0)),
            }
        })
        .collect();
    results.sort_by(|a, b| by_difference(b.explained - a.explained));
    ExplainOutcome {
        metric: ExplainMetric {
            current,
            baseline,
            change,
            change_percent: percent(change, baseline),
        },
        dimensions: results,
    }
}
