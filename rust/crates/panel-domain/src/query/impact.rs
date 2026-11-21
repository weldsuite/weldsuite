//! `impact` (`impact.ts`): did launching a feature move a metric? The people
//! who did the launch event on or after the launch day (adopters) against
//! everyone else active in the same windows, `windowDays` before against
//! `windowDays` after, and the difference in differences. Two statements:
//! per person adopted or not with the metric before and after, and each
//! adopter's first launch day.

use std::collections::HashMap;

use super::context::PanelQueryContext;
use super::result_range::to_resolved_range;
use super::rows::{PanelError, PanelSqlExecutor, PanelSqlQuery, Row, Runner, to_number};
use super::scope::{
    ScopeOptions, ScopeUse, event_match, event_property_number, event_with_filters, events_scope,
    scope_needs, unit_expr,
};
use super::sql::{PanelQueryError, QueryResult, ts};
use super::time::{
    ResolvedRange, TimeBounds, add_days, bucket_label, bucket_labels, bucket_sql, day_start,
    query_now, resolve_range,
};
use crate::js;
use crate::schemas::{
    DateRange, ImpactMath, ImpactSpec, Interval, PanelAdoptionPoint, PanelImpactGroup,
    PanelImpactResult,
};

/// The two windows around the launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImpactWindows {
    pub range: ResolvedRange,
    pub launch: i64,
    pub after: TimeBounds,
}

/// `impactWindows`: the two windows around the launch, clamped to the
/// retention and to now.
pub fn impact_windows(spec: &ImpactSpec, ctx: &PanelQueryContext) -> QueryResult<ImpactWindows> {
    let launch = day_start(&spec.launch_date, &spec.base.timezone)?;
    if launch > query_now(ctx) {
        return Err(PanelQueryError::new("The launch date is in the future"));
    }
    let range = resolve_range(
        &DateRange::Custom {
            from: add_days(&spec.launch_date, -spec.window_days)?,
            to: add_days(&spec.launch_date, spec.window_days - 1)?,
        },
        &spec.base.timezone,
        ctx,
    )?;
    if launch <= range.from {
        return Err(PanelQueryError::new(
            "The launch date is older than the data kept",
        ));
    }
    let after = TimeBounds {
        from: launch,
        to: range.to,
    };
    Ok(ImpactWindows {
        range,
        launch,
        after,
    })
}

/// `impactQueries`.
pub fn impact_queries(
    spec: &ImpactSpec,
    ctx: &PanelQueryContext,
    windows: &ImpactWindows,
) -> QueryResult<Vec<PanelSqlQuery>> {
    let range = &windows.range;
    let needs = scope_needs(
        ctx,
        &ScopeUse {
            filters: &[spec.metric.filters.as_slice()],
            events: &[spec.launch_event.as_str(), spec.metric.event.as_str()],
            ..ScopeUse::default()
        },
    )?;
    let scope = events_scope(
        ctx,
        range,
        range.bounds(),
        ScopeOptions::with_needs(Some(&spec.base.filters), &needs),
    )?;
    let unit = unit_expr(ctx, &scope, None)?;
    // The launch instant is written first (`TIMESTAMP … <= e.ts`): the
    // scope's own bounds stay the only `e.ts >= TIMESTAMP` of the statement.
    let launched = format!(
        "{} AND {} <= e.ts",
        event_match(&spec.launch_event, ctx, range, &scope.person)?,
        ts(windows.launch)
    );
    let metric = event_with_filters(
        &spec.metric.event,
        &spec.metric.filters,
        ctx,
        range,
        &scope.person,
    )?;
    let amount = if matches!(spec.metric.math, ImpactMath::Sum | ImpactMath::Avg) {
        format!(
            "COALESCE({}, 0)",
            event_property_number(spec.metric.property.as_deref().unwrap_or(""), ctx)?
        )
    } else {
        "1".to_owned()
    };
    let before = format!("{} > e.ts", ts(windows.launch));
    let after = format!("{} <= e.ts", ts(windows.launch));

    let per = format!(
        "SELECT {u} AS u, MAX(CASE WHEN {launched} THEN 1 ELSE 0 END) AS adopted, \
         SUM(CASE WHEN {metric} AND {before} THEN {amount} ELSE 0 END) AS mb, SUM(CASE WHEN {metric} AND {after} THEN {amount} ELSE 0 END) AS ma, \
         MAX(CASE WHEN {metric} AND {before} THEN 1 ELSE 0 END) AS ub, MAX(CASE WHEN {metric} AND {after} THEN 1 ELSE 0 END) AS ua, \
         SUM(CASE WHEN {metric} AND {before} THEN 1 ELSE 0 END) AS cb, SUM(CASE WHEN {metric} AND {after} THEN 1 ELSE 0 END) AS ca, \
         MAX(CASE WHEN {after} THEN 1 ELSE 0 END) AS active_after \
         FROM {} {} GROUP BY {u}",
        scope.from,
        scope.where_sql(&unit.conds),
        u = unit.expr
    );
    let groups_sql = format!(
        "SELECT adopted, COUNT(*) AS users, SUM(mb) AS mb, SUM(ma) AS ma, SUM(ub) AS ub, SUM(ua) AS ua, SUM(cb) AS cb, SUM(ca) AS ca, \
         SUM(active_after) AS active_after FROM ({per}) AS per GROUP BY adopted"
    );

    let adoption_needs = scope_needs(
        ctx,
        &ScopeUse {
            events: &[spec.launch_event.as_str()],
            ..ScopeUse::default()
        },
    )?;
    let adoption_scope = events_scope(
        ctx,
        range,
        windows.after,
        ScopeOptions::with_needs(Some(&spec.base.filters), &adoption_needs),
    )?;
    let day = bucket_sql("e.ts", Interval::Day, range.offset_minutes);
    let adoption_sql = format!(
        "SELECT first_day AS bucket, COUNT(*) AS n FROM (SELECT {p} AS u, MIN({day}) AS first_day FROM {} \
         {} GROUP BY {p}) AS firsts GROUP BY first_day",
        adoption_scope.from,
        adoption_scope.where_sql(&[event_match(
            &spec.launch_event,
            ctx,
            range,
            &adoption_scope.person
        )?]),
        p = adoption_scope.person
    );

    Ok(vec![
        PanelSqlQuery::new(
            "impact.groups",
            groups_sql,
            &[
                "adopted",
                "users",
                "mb",
                "ma",
                "ub",
                "ua",
                "cb",
                "ca",
                "active_after",
            ],
        ),
        PanelSqlQuery::new("impact.adoption", adoption_sql, &["bucket", "n"]),
    ])
}

fn round(value: Option<f64>) -> Option<f64> {
    value
        .filter(|v| v.is_finite())
        .map(|v| js::math_round(v * 10000.0) / 10000.0)
}

/// `impactGroup`: one group's metric before and after, per the spec's math.
pub fn impact_group(spec: &ImpactSpec, row: Option<&Row>) -> PanelImpactGroup {
    let get = |key: &str| to_number(row.and_then(|r| r.get(key)));
    let users = get("users");
    let per = |sum: f64, base: f64| (base > 0.0).then(|| sum / base);
    let (before, after) = match spec.metric.math {
        ImpactMath::UniqueUsers => (per(get("ub"), users), per(get("ua"), users)),
        ImpactMath::Avg => (per(get("mb"), get("cb")), per(get("ma"), get("ca"))),
        ImpactMath::Total | ImpactMath::Sum => (per(get("mb"), users), per(get("ma"), users)),
    };
    PanelImpactGroup {
        users,
        before: round(before),
        after: round(after),
        change: match (before, after) {
            (Some(before), Some(after)) => round(Some(after - before)),
            _ => None,
        },
    }
}

/// `runImpact`.
pub async fn run_impact<E: PanelSqlExecutor + ?Sized>(
    spec: &ImpactSpec,
    ctx: &PanelQueryContext,
    runner: &Runner<'_, E>,
) -> Result<PanelImpactResult, PanelError> {
    let windows = impact_windows(spec, ctx)?;
    let mut results = runner
        .run(&impact_queries(spec, ctx, &windows)?)
        .await?
        .into_iter();
    let group_rows = results.next().unwrap_or_default();
    let adoption_rows = results.next().unwrap_or_default();

    let adopters = impact_group(
        spec,
        group_rows
            .iter()
            .find(|r| to_number(r.get("adopted")) == 1.0),
    );
    let non_adopters = impact_group(
        spec,
        group_rows
            .iter()
            .find(|r| to_number(r.get("adopted")) != 1.0),
    );
    let active_after = group_rows
        .iter()
        .fold(0.0, |sum, r| sum + to_number(r.get("active_after")));
    let did = match (adopters.change, non_adopters.change) {
        (Some(a), Some(n)) => round(Some(a - n)),
        _ => None,
    };

    let mut by_day: HashMap<String, f64> = HashMap::new();
    for row in &adoption_rows {
        *by_day
            .entry(bucket_label(row.get("bucket"), Interval::Day))
            .or_insert(0.0) += to_number(row.get("n"));
    }
    let mut so_far = 0.0;
    let adoption = bucket_labels(windows.after, Interval::Day, windows.range.offset_minutes)
        .into_iter()
        .map(|bucket| {
            let new_adopters = by_day.get(&bucket).copied().unwrap_or(0.0);
            so_far += new_adopters;
            PanelAdoptionPoint {
                bucket,
                new_adopters,
                adopters: so_far,
                rate: if active_after > 0.0 {
                    (so_far / active_after).min(1.0)
                } else {
                    0.0
                },
            }
        })
        .collect();

    Ok(PanelImpactResult {
        range: to_resolved_range(&windows.range, None),
        launch_date: spec.launch_date.clone(),
        window_days: spec.window_days,
        adoption,
        relative_impact: match (did, adopters.before) {
            (Some(did), Some(before)) if before != 0.0 => round(Some(did / before)),
            _ => None,
        },
        adopters,
        non_adopters,
        difference_in_differences: did,
    })
}
