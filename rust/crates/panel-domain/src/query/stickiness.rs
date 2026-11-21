//! `stickiness` (`stickiness.ts`, Mixpanel's Frequency): how often the people
//! (or groups) who did an event do it. `intervals`: distinct days (weeks) of
//! the range each was active; `count`: how many times each did it, in buckets.

use super::context::PanelQueryContext;
use super::result_range::to_resolved_range;
use super::rows::{PanelError, PanelSqlExecutor, PanelSqlQuery, Runner, to_number};
use super::scope::{ScopeOptions, ScopeUse, event_match, events_scope, scope_needs, unit_expr};
use super::sql::QueryResult;
use super::time::{ResolvedRange, bucket_labels, bucket_sql, resolve_range};
use crate::schemas::{
    PanelStickinessBucket, PanelStickinessResult, StickinessMeasure, StickinessSpec,
};

/// `count` buckets: inclusive bounds; `None` upper is open.
pub const STICKINESS_COUNT_BUCKETS: [(i64, Option<i64>); 9] = [
    (1, Some(1)),
    (2, Some(2)),
    (3, Some(3)),
    (4, Some(5)),
    (6, Some(10)),
    (11, Some(20)),
    (21, Some(50)),
    (51, Some(100)),
    (101, None),
];

/// `stickinessQuery`.
pub fn stickiness_query(
    spec: &StickinessSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
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
        range.bounds(),
        ScopeOptions::with_needs(Some(&spec.base.filters), &needs),
    )?;
    let unit = unit_expr(ctx, &scope, spec.aggregate_by.as_ref())?;
    let mut extra = vec![event_match(&spec.event, ctx, range, &scope.person)?];
    extra.extend(unit.conds.iter().cloned());
    let where_ = scope.where_sql(&extra);
    if spec.measure == StickinessMeasure::Intervals {
        let bucket = bucket_sql("e.ts", spec.interval.interval(), range.offset_minutes);
        let sql = format!(
            "SELECT n, COUNT(*) AS units FROM (SELECT {u} AS u, COUNT(DISTINCT {bucket}) AS n FROM {} {where_} \
             GROUP BY {u}) AS per GROUP BY n ORDER BY n ASC",
            scope.from,
            u = unit.expr
        );
        return Ok(PanelSqlQuery::new("stickiness.units", sql, &["n", "units"]));
    }
    let cases = STICKINESS_COUNT_BUCKETS
        .iter()
        .enumerate()
        .map(|(i, (_, to))| match to {
            None => format!("ELSE {i}"),
            Some(to) => format!("WHEN n <= {to} THEN {i}"),
        })
        .collect::<Vec<_>>()
        .join(" ");
    let sql = format!(
        "SELECT CASE {cases} END AS n, COUNT(*) AS units FROM (SELECT {u} AS u, COUNT(*) AS n FROM {} {where_} \
         GROUP BY {u}) AS per GROUP BY CASE {cases} END",
        scope.from,
        u = unit.expr
    );
    Ok(PanelSqlQuery::new("stickiness.units", sql, &["n", "units"]))
}

/// `runStickiness`.
pub async fn run_stickiness<E: PanelSqlExecutor + ?Sized>(
    spec: &StickinessSpec,
    ctx: &PanelQueryContext,
    runner: &Runner<'_, E>,
) -> Result<PanelStickinessResult, PanelError> {
    let range = resolve_range(&spec.base.date_range, &spec.base.timezone, ctx)?;
    let rows = runner.run_one(stickiness_query(spec, ctx, &range)?).await?;
    // `Map<number, number>` in insertion order.
    let mut by_n: Vec<(f64, f64)> = Vec::new();
    for row in &rows {
        let n = to_number(row.get("n")) + 0.0;
        let units = to_number(row.get("units"));
        match by_n.iter_mut().find(|(k, _)| *k == n) {
            Some((_, total)) => *total += units,
            None => by_n.push((n, units)),
        }
    }
    let total = by_n.iter().fold(0.0, |sum, (_, n)| sum + n);
    let intervals_in_range = bucket_labels(
        range.bounds(),
        spec.interval.interval(),
        range.offset_minutes,
    )
    .len() as f64;
    let share = |count: f64| if total > 0.0 { count / total } else { 0.0 };
    let count_of = |n: f64| by_n.iter().find(|(k, _)| *k == n).map_or(0.0, |(_, c)| *c);

    let buckets = if spec.measure == StickinessMeasure::Intervals {
        let most = by_n
            .iter()
            .fold(intervals_in_range, |most, (k, _)| most.max(*k));
        let length = if most > 0.0 { most.floor() as usize } else { 0 };
        (0..length)
            .map(|i| {
                let count = count_of((i + 1) as f64);
                PanelStickinessBucket {
                    label: (i + 1).to_string(),
                    from: (i + 1) as f64,
                    to: Some((i + 1) as f64),
                    count,
                    share: share(count),
                }
            })
            .collect()
    } else {
        STICKINESS_COUNT_BUCKETS
            .iter()
            .enumerate()
            .map(|(i, (from, to))| {
                let count = count_of(i as f64);
                let label = match to {
                    None => format!("{from}+"),
                    Some(to) if to == from => from.to_string(),
                    Some(to) => format!("{from}–{to}"),
                };
                PanelStickinessBucket {
                    label,
                    from: *from as f64,
                    to: to.map(|t| t as f64),
                    count,
                    share: share(count),
                }
            })
            .collect()
    };
    Ok(PanelStickinessResult {
        range: to_resolved_range(&range, None),
        interval: spec.interval,
        measure: spec.measure,
        total,
        intervals_in_range: intervals_in_range as i64,
        buckets,
    })
}
