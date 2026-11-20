//! `vitals` (`vitals.ts`): Core Web Vitals from the SDK's `$webvitals`
//! events. A percentile over the range, over time and per page, element,
//! country and device, the good / needs-improvement / poor shares by
//! Google's thresholds, and Lighthouse's 0-100 score.

use std::collections::HashMap;

use serde_json::Value;

use super::context::PanelQueryContext;
use super::paths::cleaned_path;
use super::result_range::to_resolved_range;
use super::rows::{PanelError, PanelSqlExecutor, PanelSqlQuery, Row, Runner, to_number, to_text};
use super::scope::{EventsScope, ScopeOptions, events_scope};
use super::sql::{QueryResult, int, lit, num, percentile_sql, property_key};
use super::time::{ResolvedRange, bucket_label, bucket_labels, bucket_sql, resolve_range};
use super::trends::trends_interval;
use crate::js;
use crate::schemas::{
    Interval, PanelVitalsPoint, PanelVitalsRating, PanelVitalsResult, PanelVitalsRow,
    PanelVitalsShares, PanelVitalsUnit, VitalsMetric, VitalsPercentile, VitalsSpec,
    vitals_thresholds,
};

fn percentile_value(percentile: VitalsPercentile) -> f64 {
    match percentile {
        VitalsPercentile::P75 => 0.75,
        VitalsPercentile::P90 => 0.9,
        VitalsPercentile::P95 => 0.95,
        VitalsPercentile::P99 => 0.99,
    }
}

/// Metrics that say which element they were measured on.
fn element_key(metric: VitalsMetric) -> Option<&'static str> {
    match metric {
        VitalsMetric::Lcp => Some("$lcp_el"),
        VitalsMetric::Inp => Some("$inp_el"),
        VitalsMetric::Cls => Some("$cls_el"),
        VitalsMetric::Fcp | VitalsMetric::Ttfb => None,
    }
}

/// `vitalsRating`: the rating of a value by Google's thresholds.
pub fn vitals_rating(metric: VitalsMetric, value: Option<f64>) -> Option<PanelVitalsRating> {
    let value = value?;
    let thresholds = vitals_thresholds(metric);
    Some(if value <= thresholds.good {
        PanelVitalsRating::Good
    } else if value > thresholds.poor {
        PanelVitalsRating::Poor
    } else {
        PanelVitalsRating::NeedsImprovement
    })
}

/// Standard normal CDF (Abramowitz and Stegun 7.1.26).
fn normal_cdf(x: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.327_591_1 * (x.abs() / std::f64::consts::SQRT_2));
    let poly = t
        * (0.254_829_592
            + t * (-0.284_496_736
                + t * (1.421_413_741 + t * (-1.453_152_027 + t * 1.061_405_429))));
    let erf = 1.0 - poly * (-(x * x) / 2.0).exp();
    if x >= 0.0 {
        f64::midpoint(1.0, erf)
    } else {
        (1.0 - erf) / 2.0
    }
}

/// `vitalsScore`: Lighthouse's log-normal score (0-100).
pub fn vitals_score(metric: VitalsMetric, value: Option<f64>) -> Option<f64> {
    let value = value.filter(|v| v.is_finite())?;
    if value <= 0.0 {
        return Some(100.0);
    }
    let thresholds = vitals_thresholds(metric);
    let sigma = (thresholds.poor.ln() - thresholds.good.ln()) / 1.281_551_565_544_600_4;
    let score = 1.0 - normal_cdf((value.ln() - thresholds.poor.ln()) / sigma);
    Some(js::math_round(score.clamp(0.0, 1.0) * 100.0))
}

fn value_sql(metric: VitalsMetric) -> QueryResult<String> {
    Ok(format!(
        "json_get_float(e.properties, {})",
        property_key(&format!("${metric}"))?
    ))
}

fn vitals_scope(
    spec: &VitalsSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
) -> QueryResult<(EventsScope, Vec<String>)> {
    let scope = events_scope(
        ctx,
        range,
        range.bounds(),
        ScopeOptions {
            filters: Some(&spec.base.filters),
            ..ScopeOptions::default()
        },
    )?;
    let where_ = vec![
        format!("e.name = {}", lit("$webvitals")?),
        format!("{} IS NOT NULL", value_sql(spec.metric)?),
    ];
    Ok((scope, where_))
}

fn percentile_of(spec: &VitalsSpec) -> QueryResult<String> {
    percentile_sql(&value_sql(spec.metric)?, percentile_value(spec.percentile))
}

fn list_query(
    name: &str,
    expr: &str,
    spec: &VitalsSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    not_null: bool,
) -> QueryResult<PanelSqlQuery> {
    let (scope, mut where_) = vitals_scope(spec, ctx, range)?;
    if not_null {
        where_.push(format!("{expr} IS NOT NULL"));
    }
    let sql = format!(
        "SELECT {expr} AS value, {} AS metric, COUNT(*) AS samples FROM {} {} \
         GROUP BY {expr} ORDER BY COUNT(*) DESC LIMIT {}",
        percentile_of(spec)?,
        scope.from,
        scope.where_sql(&where_),
        int(spec.limit, 50)?
    );
    Ok(PanelSqlQuery::new(
        name,
        sql,
        &["value", "metric", "samples"],
    ))
}

/// `vitalsQueries`.
pub fn vitals_queries(
    spec: &VitalsSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    interval: Interval,
) -> QueryResult<Vec<PanelSqlQuery>> {
    let (scope, where_) = vitals_scope(spec, ctx, range)?;
    let value = value_sql(spec.metric)?;
    let thresholds = vitals_thresholds(spec.metric);
    let bucket = bucket_sql("e.ts", interval, range.offset_minutes);
    let mut queries = vec![
        PanelSqlQuery::new(
            "vitals.summary",
            format!(
                "SELECT {} AS value, COUNT(*) AS samples, SUM(CASE WHEN {value} <= {} THEN 1 ELSE 0 END) AS good, \
                 SUM(CASE WHEN {value} > {} THEN 1 ELSE 0 END) AS poor FROM {} {}",
                percentile_of(spec)?,
                num(thresholds.good)?,
                num(thresholds.poor)?,
                scope.from,
                scope.where_sql(&where_)
            ),
            &["value", "samples", "good", "poor"],
        ),
        PanelSqlQuery::new(
            "vitals.series",
            format!(
                "SELECT {bucket} AS bucket, {} AS value, COUNT(*) AS samples FROM {} {} \
                 GROUP BY {bucket} ORDER BY {bucket} ASC",
                percentile_of(spec)?,
                scope.from,
                scope.where_sql(&where_)
            ),
            &["bucket", "value", "samples"],
        ),
        list_query(
            "vitals.paths",
            &format!(
                "COALESCE({}, '(unknown)')",
                cleaned_path(ctx, spec.clean_paths)?
            ),
            spec,
            ctx,
            range,
            false,
        )?,
        list_query(
            "vitals.countries",
            "COALESCE(e.country, '(unknown)')",
            spec,
            ctx,
            range,
            false,
        )?,
        list_query(
            "vitals.devices",
            "COALESCE(e.device_type, '(unknown)')",
            spec,
            ctx,
            range,
            false,
        )?,
    ];
    if let Some(key) = element_key(spec.metric) {
        queries.push(list_query(
            "vitals.elements",
            &format!("json_get_str(e.properties, {})", property_key(key)?),
            spec,
            ctx,
            range,
            true,
        )?);
    }
    Ok(queries)
}

fn metric_value(value: Option<&Value>) -> Option<f64> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        value => Some(js::math_round(to_number(value) * 1000.0) / 1000.0),
    }
}

fn rows_from(metric: VitalsMetric, rows: &[Row]) -> Vec<PanelVitalsRow> {
    rows.iter()
        .map(|r| {
            let value = metric_value(r.get("metric"));
            PanelVitalsRow {
                value: to_text(r.get("value")),
                metric: value,
                samples: to_number(r.get("samples")),
                rating: vitals_rating(metric, value),
            }
        })
        .collect()
}

/// `runVitals`.
pub async fn run_vitals<E: PanelSqlExecutor + ?Sized>(
    spec: &VitalsSpec,
    ctx: &PanelQueryContext,
    runner: &Runner<'_, E>,
) -> Result<PanelVitalsResult, PanelError> {
    let range = resolve_range(&spec.base.date_range, &spec.base.timezone, ctx)?;
    let interval = trends_interval(&range, spec.interval);
    let queries = vitals_queries(spec, ctx, &range, interval)?;
    let results = runner.run(&queries).await?;
    let empty: Vec<Row> = Vec::new();
    let at = |name: &str| -> &[Row] {
        queries
            .iter()
            .position(|q| q.name == name)
            .and_then(|i| results.get(i))
            .map_or(empty.as_slice(), Vec::as_slice)
    };

    let empty_row = Row::new();
    let summary = at("vitals.summary").first().unwrap_or(&empty_row);
    let samples = to_number(summary.get("samples"));
    let good = to_number(summary.get("good"));
    let poor = to_number(summary.get("poor"));
    let value = if samples > 0.0 {
        metric_value(summary.get("value"))
    } else {
        None
    };
    let mut by_bucket: HashMap<String, &Row> = HashMap::new();
    for row in at("vitals.series") {
        by_bucket.insert(bucket_label(row.get("bucket"), interval), row);
    }

    Ok(PanelVitalsResult {
        range: to_resolved_range(&range, None),
        interval,
        metric: spec.metric,
        percentile: spec.percentile,
        unit: if spec.metric == VitalsMetric::Cls {
            PanelVitalsUnit::Unitless
        } else {
            PanelVitalsUnit::Ms
        },
        thresholds: vitals_thresholds(spec.metric),
        value,
        rating: vitals_rating(spec.metric, value),
        samples,
        shares: PanelVitalsShares {
            good: if samples > 0.0 { good / samples } else { 0.0 },
            needs_improvement: if samples > 0.0 {
                (samples - good - poor).max(0.0) / samples
            } else {
                0.0
            },
            poor: if samples > 0.0 { poor / samples } else { 0.0 },
        },
        score: vitals_score(spec.metric, value),
        series: bucket_labels(range.bounds(), interval, range.offset_minutes)
            .into_iter()
            .map(|bucket| {
                let row = by_bucket.get(&bucket).copied();
                PanelVitalsPoint {
                    value: row.and_then(|r| metric_value(r.get("value"))),
                    samples: to_number(row.and_then(|r| r.get("samples"))),
                    bucket,
                }
            })
            .collect(),
        paths: rows_from(spec.metric, at("vitals.paths")),
        elements: rows_from(spec.metric, at("vitals.elements")),
        countries: rows_from(spec.metric, at("vitals.countries")),
        devices: rows_from(spec.metric, at("vitals.devices")),
    })
}
