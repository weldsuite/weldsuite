//! `lifecycle` (`lifecycle.ts`): per bucket, who did the event for the first
//! time (`new`), again after the previous bucket (`returning`), again after
//! a gap (`resurrecting`), and who did it in the previous bucket but not this
//! one (`dormant`). One scan from the retention floor to the end of the range.

use std::collections::HashMap;

use super::context::PanelQueryContext;
use super::result_range::to_resolved_range;
use super::rows::{PanelError, PanelSqlExecutor, PanelSqlQuery, Runner, to_number, to_text};
use super::scope::{ScopeOptions, ScopeUse, event_match, events_scope, scope_needs, unit_expr};
use super::sql::{PanelQueryError, QueryResult, ts};
use super::time::{
    ResolvedRange, TimeBounds, bucket_label, bucket_label_text, bucket_labels, bucket_sql,
    resolve_range,
};
use crate::js;
use crate::schemas::{
    LifecycleSpec, PanelLifecycleBucket, PanelLifecycleResult, PanelLifecycleTotals,
    RetentionInterval,
};

fn step(interval: RetentionInterval) -> &'static str {
    match interval {
        RetentionInterval::Day => "INTERVAL '1 days'",
        RetentionInterval::Week => "INTERVAL '7 days'",
        RetentionInterval::Month => "INTERVAL '1 months'",
    }
}

/// `previousBucketLabel`: the bucket label before `label` (`YYYY-MM-DD`).
pub fn previous_bucket_label(label: &str, interval: RetentionInterval) -> String {
    let mut parts = label.split('-').map(js::string_to_number);
    let mut next = || {
        parts
            .next()
            .filter(|n| n.is_finite())
            .map(|n| n.trunc() as i64)
    };
    let (Some(y), Some(m), Some(d)) = (next(), next(), next()) else {
        // `new Date(NaN)`: an invalid date, which `ts()` refuses.
        return String::new();
    };
    if interval == RetentionInterval::Month {
        return js::iso_day(js::date_utc(y, m - 2, 1));
    }
    let back = if interval == RetentionInterval::Week {
        7
    } else {
        1
    };
    js::iso_day(js::date_utc(y, m - 1, d - back))
}

/// `lifecycleQuery`.
pub fn lifecycle_query(
    spec: &LifecycleSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    first_label: &str,
) -> QueryResult<PanelSqlQuery> {
    let needs = scope_needs(
        ctx,
        &ScopeUse {
            events: &[spec.event.as_str()],
            ..ScopeUse::default()
        },
    )?;
    let scope = events_scope(
        ctx,
        range,
        TimeBounds {
            from: range.floor,
            to: range.to,
        },
        ScopeOptions::with_needs(Some(&spec.base.filters), &needs),
    )?;
    let unit = unit_expr(ctx, &scope, spec.aggregate_by.as_ref())?;
    let bucket = bucket_sql("e.ts", spec.interval.interval(), range.offset_minutes);
    let step = step(spec.interval);
    let since_label = format!(
        "{}T00:00:00Z",
        previous_bucket_label(first_label, spec.interval)
    );
    let since =
        ts(js::parse_iso(&since_label).ok_or_else(|| PanelQueryError::new("Invalid date"))?);
    let mut extra = vec![event_match(&spec.event, ctx, range, &scope.person)?];
    extra.extend(unit.conds.iter().cloned());
    let act = format!(
        "SELECT {u} AS u, {bucket} AS b FROM {} {} GROUP BY {u}, {bucket}",
        scope.from,
        scope.where_sql(&extra),
        u = unit.expr
    );
    let seq = format!(
        "SELECT u, b, LAG(b) OVER (PARTITION BY u ORDER BY b) AS prev_b, LEAD(b) OVER (PARTITION BY u ORDER BY b) AS next_b FROM ({act}) AS act"
    );
    let status = format!(
        "SELECT b, CASE WHEN prev_b IS NULL THEN 'new' WHEN prev_b = b - {step} THEN 'returning' ELSE 'resurrecting' END AS status, \
         CASE WHEN next_b IS NULL OR next_b > b + {step} THEN 1 ELSE 0 END AS dormant_next FROM ({seq}) AS sq"
    );
    let sql = format!(
        "SELECT b AS bucket, status, COUNT(*) AS n, SUM(dormant_next) AS dormant_next FROM ({status}) AS st WHERE b >= {since} GROUP BY b, status"
    );
    Ok(PanelSqlQuery::new(
        "lifecycle.buckets",
        sql,
        &["bucket", "status", "n", "dormant_next"],
    ))
}

/// `runLifecycle`.
pub async fn run_lifecycle<E: PanelSqlExecutor + ?Sized>(
    spec: &LifecycleSpec,
    ctx: &PanelQueryContext,
    runner: &Runner<'_, E>,
) -> Result<PanelLifecycleResult, PanelError> {
    let range = resolve_range(&spec.base.date_range, &spec.base.timezone, ctx)?;
    let interval = spec.interval.interval();
    let labels = bucket_labels(range.bounds(), interval, range.offset_minutes);
    let first = labels
        .first()
        .cloned()
        .unwrap_or_else(|| bucket_label_text(&js::iso_string(range.from), interval));
    let rows = runner
        .run_one(lifecycle_query(spec, ctx, &range, &first)?)
        .await?;

    let mut timeline = vec![previous_bucket_label(&first, spec.interval)];
    timeline.extend(labels.iter().cloned());
    let mut by_label: HashMap<String, PanelLifecycleBucket> = labels
        .iter()
        .map(|bucket| {
            (
                bucket.clone(),
                PanelLifecycleBucket {
                    bucket: bucket.clone(),
                    new: 0.0,
                    returning: 0.0,
                    resurrecting: 0.0,
                    dormant: 0.0,
                },
            )
        })
        .collect();
    for row in &rows {
        let label = bucket_label(row.get("bucket"), interval);
        let status = to_text(row.get("status"));
        if let Some(target) = by_label.get_mut(&label) {
            let n = to_number(row.get("n"));
            match status.as_str() {
                "new" => target.new += n,
                "returning" => target.returning += n,
                "resurrecting" => target.resurrecting += n,
                _ => {}
            }
        }
        // Dormant in the bucket after this one.
        if let Some(position) = timeline.iter().position(|l| *l == label) {
            let next = timeline.get(position + 1).cloned().unwrap_or_default();
            if let Some(later) = by_label.get_mut(&next) {
                later.dormant += to_number(row.get("dormant_next"));
            }
        }
    }
    let buckets: Vec<PanelLifecycleBucket> = labels
        .iter()
        .filter_map(|bucket| by_label.get(bucket).cloned())
        .collect();
    let totals = buckets.iter().fold(
        PanelLifecycleTotals {
            new: 0.0,
            returning: 0.0,
            resurrecting: 0.0,
            dormant: 0.0,
        },
        |sum, b| PanelLifecycleTotals {
            new: sum.new + b.new,
            returning: sum.returning + b.returning,
            resurrecting: sum.resurrecting + b.resurrecting,
            dormant: sum.dormant + b.dormant,
        },
    );
    Ok(PanelLifecycleResult {
        range: to_resolved_range(&range, None),
        interval: spec.interval,
        buckets,
        totals,
    })
}
