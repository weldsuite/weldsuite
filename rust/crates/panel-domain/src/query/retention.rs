//! `retention` (`retention.ts`): people (or groups) are put in the cohort of
//! the period they first did the first event, then counted in every later
//! period in which they did the return event (any event when none is given).
//! Modes: the first time in the range (default), `first_time` (as far back as
//! the plan keeps data), `recurring` (every period starts a cohort).
//! `unbounded` counts someone in period N when they came back in N or later.
//! Two statements: cohort sizes and returns per cohort and period.

use std::collections::HashMap;

use super::breakdowns::{
    BreakdownProbe, PreparedBreakdowns, limited_breakdown, ordered_values, prepare_breakdowns,
};
use super::context::PanelQueryContext;
use super::result_range::to_resolved_range;
use super::rows::{PanelError, PanelSqlExecutor, PanelSqlQuery, Row, Runner, to_number, to_text};
use super::scope::{
    EventsScope, ScopeOptions, ScopeUse, event_match, events_scope, scope_needs, unit_expr,
};
use super::sql::{QueryResult, ts};
use super::time::{
    ResolvedRange, TimeBounds, bucket_label, bucket_labels, bucket_sql, query_now, resolve_range,
};
use crate::js;
use crate::schemas::{
    Interval, PanelRetentionBreakdown, PanelRetentionCohort, PanelRetentionResult,
    RetentionInterval, RetentionMode, RetentionSpec,
};

fn shifted(column: &str, offset_minutes: i64) -> String {
    if offset_minutes == 0 {
        column.to_owned()
    } else {
        format!("{column} + INTERVAL '{offset_minutes} minutes'")
    }
}

/// Whole `interval`s between the cohort's first event and an event.
fn period_index_sql(spec: &RetentionSpec, offset_minutes: i64) -> String {
    let event = shifted("e.ts", offset_minutes);
    let first = shifted("f.t0", offset_minutes);
    if spec.interval == RetentionInterval::Month {
        return format!(
            "((EXTRACT(YEAR FROM {event}) * 12 + EXTRACT(MONTH FROM {event})) - (EXTRACT(YEAR FROM {first}) * 12 + EXTRACT(MONTH FROM {first})))"
        );
    }
    let unit = spec.interval;
    let seconds = if unit == RetentionInterval::Day {
        86_400
    } else {
        604_800
    };
    format!(
        "FLOOR((to_unixtime(date_trunc('{unit}', {event})) - to_unixtime(date_trunc('{unit}', {first}))) / {seconds})"
    )
}

/// Where first events are read: the range, or (first time ever) back to the retention floor.
fn first_bounds(spec: &RetentionSpec, range: &ResolvedRange) -> TimeBounds {
    if spec.mode == Some(RetentionMode::FirstTime) {
        TimeBounds {
            from: range.floor,
            to: range.to,
        }
    } else {
        range.bounds()
    }
}

fn first_scope(
    spec: &RetentionSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
) -> QueryResult<EventsScope> {
    let needs = scope_needs(
        ctx,
        &ScopeUse {
            events: &[spec.first_event.as_str()],
            breakdowns: &[spec.breakdown.as_ref()],
            ..ScopeUse::default()
        },
    )?;
    events_scope(
        ctx,
        range,
        first_bounds(spec, range),
        ScopeOptions::with_needs(Some(&spec.base.filters), &needs),
    )
}

fn first_event_cte(
    spec: &RetentionSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    breakdowns: Option<&PreparedBreakdowns>,
) -> QueryResult<String> {
    let scope = first_scope(spec, ctx, range)?;
    let unit = unit_expr(ctx, &scope, spec.aggregate_by.as_ref())?;
    let mut extra = vec![event_match(&spec.first_event, ctx, range, &scope.person)?];
    extra.extend(unit.conds.iter().cloned());
    let first_where = scope.where_sql(&extra);
    let bd = match breakdowns {
        Some(prepared) => format!(
            ", FIRST_VALUE({} ORDER BY e.ts ASC, e.event_id ASC) AS bd",
            limited_breakdown(prepared)?
        ),
        None => String::new(),
    };
    if spec.mode == Some(RetentionMode::Recurring) {
        let bucket = bucket_sql("e.ts", spec.interval.interval(), range.offset_minutes);
        return Ok(format!(
            "f AS (SELECT {u} AS person, MIN(e.ts) AS t0{bd} FROM {} {first_where} GROUP BY {u}, {bucket})",
            scope.from,
            u = unit.expr
        ));
    }
    let having = if spec.mode == Some(RetentionMode::FirstTime) {
        format!(" HAVING MIN(e.ts) >= {}", ts(range.from))
    } else {
        String::new()
    };
    Ok(format!(
        "f AS (SELECT {u} AS person, MIN(e.ts) AS t0{bd} FROM {} {first_where} GROUP BY {u}{having})",
        scope.from,
        u = unit.expr
    ))
}

/// `retentionQueries`: cohort sizes and returns.
pub fn retention_queries(
    spec: &RetentionSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    breakdowns: Option<&PreparedBreakdowns>,
) -> QueryResult<Vec<PanelSqlQuery>> {
    let interval = spec.interval.interval();
    let cohort_bucket = |column: &str| bucket_sql(column, interval, range.offset_minutes);
    let f = first_event_cte(spec, ctx, range, breakdowns)?;
    let bd_select = if breakdowns.is_some() { ", bd" } else { "" };
    let f_bd = if breakdowns.is_some() { ", f.bd" } else { "" };

    let sizes = format!(
        "WITH {f} SELECT {c} AS cohort{bd_select}, COUNT(*) AS size FROM f GROUP BY {c}{bd_select} ORDER BY {c} ASC",
        c = cohort_bucket("t0")
    );

    // Returns are read until now, from the first day of the range.
    let return_events: Vec<&str> = spec.return_event.iter().map(String::as_str).collect();
    let needs = scope_needs(
        ctx,
        &ScopeUse {
            events: &return_events,
            ..ScopeUse::default()
        },
    )?;
    let returns = events_scope(
        ctx,
        range,
        TimeBounds {
            from: range.from,
            to: query_now(ctx),
        },
        ScopeOptions::with_needs(Some(&spec.base.filters), &needs),
    )?;
    let unit = unit_expr(ctx, &returns, spec.aggregate_by.as_ref())?;
    let mut extra = Vec::new();
    if let Some(return_event) = &spec.return_event {
        extra.push(event_match(return_event, ctx, range, &returns.person)?);
    }
    extra.extend(unit.conds.iter().cloned());
    extra.push("e.ts >= f.t0".to_owned());
    let period = period_index_sql(spec, range.offset_minutes);
    let from = format!(
        "FROM {} JOIN f ON f.person = {} {}",
        returns.from,
        unit.expr,
        returns.where_sql(&extra)
    );
    let fc = cohort_bucket("f.t0");
    let returns_sql = if spec.unbounded == Some(true) {
        format!(
            "WITH {f} SELECT cohort{bd_select}, maxp AS period, COUNT(*) AS n FROM (\
             SELECT f.person AS person, {fc} AS cohort{f_bd}, MAX({period}) AS maxp {from} \
             GROUP BY f.person, {fc}{f_bd}) AS mp GROUP BY cohort{bd_select}, maxp"
        )
    } else {
        format!(
            "WITH {f} SELECT {fc} AS cohort{f_bd}, {period} AS period, COUNT(DISTINCT f.person) AS n \
             {from} GROUP BY {fc}{f_bd}, {period}"
        )
    };

    let with_bd = |columns: &[&str]| -> Vec<String> {
        let mut out = vec![columns[0].to_owned()];
        if breakdowns.is_some() {
            out.push("bd".to_owned());
        }
        out.extend(columns[1..].iter().map(|c| (*c).to_owned()));
        out
    };
    Ok(vec![
        PanelSqlQuery {
            name: "retention.sizes".to_owned(),
            sql: sizes,
            columns: with_bd(&["cohort", "size"]),
        },
        PanelSqlQuery {
            name: "retention.returns".to_owned(),
            sql: returns_sql,
            columns: with_bd(&["cohort", "period", "n"]),
        },
    ])
}

fn table_from(
    spec: &RetentionSpec,
    range: &ResolvedRange,
    size_rows: &[&Row],
    return_rows: &[&Row],
) -> (Vec<PanelRetentionCohort>, Vec<f64>) {
    let periods = usize::try_from(spec.periods).unwrap_or(0);
    let mut sizes: Vec<(String, f64)> = Vec::new();
    for row in size_rows {
        let key = bucket_label(row.get("cohort"), Interval::Day);
        let size = to_number(row.get("size"));
        match sizes.iter_mut().find(|(k, _)| *k == key) {
            Some((_, total)) => *total += size,
            None => sizes.push((key, size)),
        }
    }
    let mut counts: HashMap<String, Vec<f64>> = HashMap::new();
    for row in return_rows {
        let period = to_number(row.get("period"));
        if period < 0.0 {
            continue;
        }
        let key = bucket_label(row.get("cohort"), Interval::Day);
        let list = counts.entry(key).or_insert_with(|| vec![0.0; periods + 1]);
        let n = to_number(row.get("n"));
        if spec.unbounded == Some(true) {
            // Came back last in `period`: counts for every period up to it.
            let top = period.min(periods as f64);
            let mut p = 0usize;
            while (p as f64) <= top {
                add_at(list, p, n);
                p += 1;
            }
        } else if period <= periods as f64 && period.fract() == 0.0 {
            add_at(list, period as usize, n);
        }
    }

    let mut cohorts: Vec<(String, f64)> =
        sizes.into_iter().filter(|(_, size)| *size > 0.0).collect();
    cohorts.sort_by(|a, b| js::locale_compare(&a.0, &b.0));
    let cohorts: Vec<PanelRetentionCohort> = cohorts
        .into_iter()
        .map(|(cohort, size)| PanelRetentionCohort {
            counts: counts
                .get(&cohort)
                .cloned()
                .unwrap_or_else(|| vec![0.0; periods + 1]),
            cohort,
            size,
        })
        .collect();

    // A cohort can only show a period that has already started.
    let timeline = bucket_labels(
        range.bounds(),
        spec.interval.interval(),
        range.offset_minutes,
    );
    let average_retention = (0..=periods)
        .map(|p| {
            let mut retained = 0.0;
            let mut total = 0.0;
            for cohort in &cohorts {
                let Some(index) = timeline.iter().position(|l| *l == cohort.cohort) else {
                    continue;
                };
                if index + p > timeline.len() - 1 {
                    continue;
                }
                retained += cohort.counts.get(p).copied().unwrap_or(0.0);
                total += cohort.size;
            }
            if total > 0.0 { retained / total } else { 0.0 }
        })
        .collect();
    (cohorts, average_retention)
}

/// `list[index] = (list[index] ?? 0) + n` on a JavaScript array (a
/// fractional period writes a property the result never shows, so it is
/// skipped above).
fn add_at(list: &mut Vec<f64>, index: usize, n: f64) {
    if index >= list.len() {
        list.resize(index + 1, 0.0);
    }
    list[index] += n;
}

/// `runRetention`.
pub async fn run_retention<E: PanelSqlExecutor + ?Sized>(
    spec: &RetentionSpec,
    ctx: &PanelQueryContext,
    runner: &Runner<'_, E>,
) -> Result<PanelRetentionResult, PanelError> {
    let range = resolve_range(&spec.base.date_range, &spec.base.timezone, ctx)?;
    let mut breakdowns = None;
    if let Some(breakdown) = &spec.breakdown {
        let scope = first_scope(spec, ctx, &range)?;
        let unit = unit_expr(ctx, &scope, spec.aggregate_by.as_ref())?;
        let mut where_ = vec![event_match(&spec.first_event, ctx, &range, &scope.person)?];
        where_.extend(unit.conds.iter().cloned());
        breakdowns = prepare_breakdowns(
            &[breakdown],
            &BreakdownProbe {
                ctx,
                scope: &scope,
                where_,
                measure: format!("COUNT(DISTINCT {})", unit.expr),
                name: "retention",
                clean_paths: None,
            },
            runner,
        )
        .await?;
    }
    let breakdowns = breakdowns.as_ref();
    let mut results = runner
        .run(&retention_queries(spec, ctx, &range, breakdowns)?)
        .await?
        .into_iter();
    let size_rows = results.next().unwrap_or_default();
    let return_rows = results.next().unwrap_or_default();

    let all_sizes: Vec<&Row> = size_rows.iter().collect();
    let all_returns: Vec<&Row> = return_rows.iter().collect();
    let (cohorts, average_retention) = table_from(spec, &range, &all_sizes, &all_returns);
    let mut result = PanelRetentionResult {
        range: to_resolved_range(&range, None),
        interval: spec.interval,
        periods: spec.periods,
        cohorts,
        average_retention,
        mode: spec.mode,
        unbounded: (spec.unbounded == Some(true)).then_some(true),
        breakdowns: None,
    };
    if let Some(prepared) = breakdowns {
        let seen: Vec<String> = size_rows.iter().map(|r| to_text(r.get("bd"))).collect();
        result.breakdowns = Some(
            ordered_values(prepared, &seen)
                .into_iter()
                .map(|value| {
                    let sizes: Vec<&Row> = size_rows
                        .iter()
                        .filter(|r| to_text(r.get("bd")) == value)
                        .collect();
                    let returns: Vec<&Row> = return_rows
                        .iter()
                        .filter(|r| to_text(r.get("bd")) == value)
                        .collect();
                    let (cohorts, average_retention) = table_from(spec, &range, &sizes, &returns);
                    PanelRetentionBreakdown {
                        value,
                        cohorts,
                        average_retention,
                    }
                })
                .collect(),
        );
    }
    Ok(result)
}
