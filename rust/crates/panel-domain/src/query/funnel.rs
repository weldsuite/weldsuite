//! `funnel` (`funnel.ts`): ordered steps with a conversion window.
//!
//! One scan reads the events of all steps into `seq` with a 0/1 flag per step
//! (`m1`..`mN`) and per exclusion (`x1`..). Each step is then a CTE that
//! joins the previous step's person-and-timestamp set to `seq`. `loose`:
//! other events may happen between steps; `strict`: a step must be the very
//! next event; `any`: any order within the window. Optional steps never gate
//! later ones; exclusions remove a person who did the excluded event between
//! two steps; `holdConstant` keeps a property at its step-1 value;
//! `aggregateBy` counts groups.

use std::collections::HashMap;

use super::breakdowns::{
    BreakdownProbe, PreparedBreakdowns, limited_breakdown, ordered_values, parts_for,
    prepare_breakdowns,
};
use super::context::PanelQueryContext;
use super::result_range::to_resolved_range;
use super::rows::{PanelError, PanelSqlExecutor, PanelSqlQuery, Row, Runner, to_number, to_text};
use super::scope::{
    BreakdownExprOptions, EventsScope, ScopeOptions, ScopeUse, breakdown_expr, event_with_filters,
    events_scope, scope_needs, unit_expr,
};
use super::sql::{QueryResult, int, percentile_sql};
use super::time::{ResolvedRange, bucket_label, bucket_labels, bucket_sql, resolve_range};
use crate::js;
use crate::schemas::{
    FunnelDisplay, FunnelOrder, FunnelSpec, FunnelStep, Interval, PanelFunnelBreakdown,
    PanelFunnelResult, PanelFunnelStepResult, PanelFunnelTimeToConvert, PanelFunnelTrendPoint,
    PanelStepTimeToConvert, PanelTimeHistogramBucket, PanelTimeToConvertStats, spec_breakdowns,
};

fn window_interval(spec: &FunnelSpec) -> QueryResult<String> {
    Ok(format!(
        "INTERVAL '{} {}s'",
        int(spec.window.value, 366)?,
        spec.window.unit
    ))
}

/// `funnelScope`: the scope every funnel statement reads.
pub fn funnel_scope(
    spec: &FunnelSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
) -> QueryResult<EventsScope> {
    let exclusions = spec.exclusions.as_deref().unwrap_or_default();
    let mut filters: Vec<&[_]> = spec.steps.iter().map(|s| s.filters.as_slice()).collect();
    filters.extend(exclusions.iter().map(|x| x.filters.as_slice()));
    let mut events: Vec<&str> = spec.steps.iter().map(|s| s.event.as_str()).collect();
    events.extend(exclusions.iter().map(|x| x.event.as_str()));
    let mut breakdowns: Vec<_> = spec_breakdowns(spec.breakdown.as_ref(), spec.breakdowns.as_ref())
        .into_iter()
        .map(Some)
        .collect();
    breakdowns.push(spec.hold_constant.as_ref());
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
        range.bounds(),
        ScopeOptions::with_needs(Some(&spec.base.filters), &needs),
    )
}

fn step_condition(
    step: &FunnelStep,
    scope: &EventsScope,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
) -> QueryResult<String> {
    Ok(format!(
        "({})",
        event_with_filters(&step.event, &step.filters, ctx, range, &scope.person)?
    ))
}

/// `prepareFunnelBreakdowns`: the breakdowns' buckets and top values, counted on step 1.
pub async fn prepare_funnel_breakdowns<E: PanelSqlExecutor + ?Sized>(
    spec: &FunnelSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    runner: &Runner<'_, E>,
) -> Result<Option<PreparedBreakdowns>, PanelError> {
    let scope = funnel_scope(spec, ctx, range)?;
    let unit = unit_expr(ctx, &scope, spec.aggregate_by.as_ref())?;
    let first = step_condition(&spec.steps[0], &scope, ctx, range)?;
    let mut where_ = vec![first];
    where_.extend(unit.conds.iter().cloned());
    let list = spec_breakdowns(spec.breakdown.as_ref(), spec.breakdowns.as_ref());
    prepare_breakdowns(
        &list,
        &BreakdownProbe {
            ctx,
            scope: &scope,
            where_,
            measure: format!("COUNT(DISTINCT {})", unit.expr),
            name: "funnel",
            clean_paths: spec.clean_paths,
        },
        runner,
    )
    .await
}

/// Columns of the first step that correlation reads.
pub const CORRELATION_COLUMNS: [&str; 6] = [
    "country",
    "device_type",
    "browser",
    "os",
    "utm_source",
    "referrer_host",
];

/// The step CTEs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunnelPlan {
    /// The `WITH` parts.
    pub ctes: Vec<String>,
    /// Per step (0-based), the CTE of who reached it (after exclusions).
    pub reached: Vec<String>,
    pub window: String,
}

/// What every CTE builder of a plan shares.
struct PlanParts<'a> {
    spec: &'a FunnelSpec,
    ctes: Vec<String>,
    bd: Option<String>,
    hc: Option<String>,
    /// `c_<column>` names carried for correlation.
    cols: Vec<String>,
    window: String,
}

const EMPTY_BD: &str = "'' AS bd";
const FIRST: &str = "ORDER BY ts ASC, event_id ASC";

/// `seq`: one scan of the step (and exclusion) events with their flags.
fn seq_cte(
    spec: &FunnelSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    bd: Option<&str>,
    hc: Option<&str>,
    with_columns: bool,
) -> QueryResult<String> {
    let strict = spec.order == FunnelOrder::Strict;
    let scope = funnel_scope(spec, ctx, range)?;
    let unit = unit_expr(ctx, &scope, spec.aggregate_by.as_ref())?;
    let conds = spec
        .steps
        .iter()
        .map(|step| step_condition(step, &scope, ctx, range))
        .collect::<QueryResult<Vec<_>>>()?;
    let exclusions = if spec.order == FunnelOrder::Any {
        &[][..]
    } else {
        spec.exclusions.as_deref().unwrap_or_default()
    };
    let excl_conds = exclusions
        .iter()
        .map(|x| {
            Ok(format!(
                "({})",
                event_with_filters(&x.event, &x.filters, ctx, range, &scope.person)?
            ))
        })
        .collect::<QueryResult<Vec<_>>>()?;
    let mut select = vec![
        format!("{} AS person", unit.expr),
        "e.ts AS ts".to_owned(),
        "e.event_id AS event_id".to_owned(),
    ];
    if let Some(bd) = bd {
        select.push(format!("{bd} AS bd"));
    }
    if let Some(hc) = hc {
        select.push(format!("{hc} AS hc"));
    }
    if with_columns {
        select.extend(
            CORRELATION_COLUMNS
                .iter()
                .map(|c| format!("e.{c} AS c_{c}")),
        );
    }
    select.extend(
        conds
            .iter()
            .enumerate()
            .map(|(i, cond)| format!("CASE WHEN {cond} THEN 1 ELSE 0 END AS m{}", i + 1)),
    );
    select.extend(
        excl_conds
            .iter()
            .enumerate()
            .map(|(i, cond)| format!("CASE WHEN {cond} THEN 1 ELSE 0 END AS x{}", i + 1)),
    );
    if strict {
        select.push(format!(
            "LEAD(e.event_id) OVER (PARTITION BY {} ORDER BY e.ts, e.event_id) AS next_id",
            unit.expr
        ));
    }
    // Loose and any order only need the step (and exclusion) events; strict
    // needs every event to know what came next.
    let mut all = conds.clone();
    all.extend(excl_conds);
    let any_step = format!("({})", all.join(" OR "));
    let mut extra = unit.conds.clone();
    if !strict {
        extra.push(any_step);
    }
    let where_ = scope.where_sql(&extra);
    Ok(format!(
        "seq AS (SELECT {} FROM {} {where_})",
        select.join(", "),
        scope.from
    ))
}

/// `any` order: the anchor, what each person did in the window, one CTE per step.
fn any_order_steps(parts: &mut PlanParts<'_>) -> Vec<String> {
    let spec = parts.spec;
    let mut firsts = vec![match &parts.bd {
        Some(_) => format!("FIRST_VALUE(bd {FIRST}) AS bd"),
        None => EMPTY_BD.to_owned(),
    }];
    if parts.hc.is_some() {
        firsts.push(format!("FIRST_VALUE(hc {FIRST}) AS hc"));
    }
    firsts.extend(
        parts
            .cols
            .iter()
            .map(|c| format!("FIRST_VALUE({c} {FIRST}) AS {c}")),
    );
    parts.ctes.push(format!(
        "a AS (SELECT person, MIN(ts) AS t0, {} FROM seq GROUP BY person)",
        firsts.join(", ")
    ));
    let done = (0..spec.steps.len()).map(|i| {
        format!(
            "MAX(q.m{n}) AS d{n}, MIN(CASE WHEN q.m{n} = 1 THEN q.ts END) AS f{n}",
            n = i + 1
        )
    });
    let carried: Vec<String> = parts
        .cols
        .iter()
        .map(|c| format!("MIN(a.{c}) AS {c}"))
        .chain(done)
        .collect();
    let same_value = if parts.hc.is_some() {
        " AND q.hc = a.hc"
    } else {
        ""
    };
    parts.ctes.push(format!(
        "p AS (SELECT q.person AS person, MIN(a.t0) AS t0, MIN(a.bd) AS bd, {} \
         FROM seq q JOIN a ON a.person = q.person WHERE q.ts <= a.t0 + {}{same_value} GROUP BY q.person)",
        carried.join(", "),
        parts.window
    ));
    (0..spec.steps.len())
        .map(|i| {
            let all = (0..=i).map(|j| format!("d{} = 1", j + 1)).collect::<Vec<_>>().join(" AND ");
            let extra = if i == 0 {
                parts.cols.iter().map(|c| format!(", {c}")).collect::<Vec<_>>().concat()
            } else {
                String::new()
            };
            parts.ctes.push(format!(
                "r{n} AS (SELECT person, t0 AS t1, f{n} AS t, t0 AS tp, bd{extra} FROM p WHERE {all})",
                n = i + 1
            ));
            format!("r{}", i + 1)
        })
        .collect()
}

/// `s1`: one row per person (loose) or per step-1 event (strict).
fn first_step_cte(parts: &PlanParts<'_>, strict: bool) -> String {
    if strict {
        let first_bd = match &parts.bd {
            Some(_) => format!("FIRST_VALUE(bd) OVER (PARTITION BY person {FIRST}) AS bd"),
            None => EMPTY_BD.to_owned(),
        };
        let tail: String = parts
            .hc
            .iter()
            .map(|_| "hc".to_owned())
            .chain(parts.cols.iter().cloned())
            .map(|x| format!(", {x}"))
            .collect::<Vec<_>>()
            .concat();
        return format!(
            "s1 AS (SELECT person, ts AS t1, ts AS t, ts AS tp, next_id, {first_bd}{tail} FROM seq WHERE m1 = 1)"
        );
    }
    let first_bd = match &parts.bd {
        Some(_) => format!("FIRST_VALUE(bd {FIRST}) AS bd"),
        None => EMPTY_BD.to_owned(),
    };
    let mut extras = Vec::new();
    if parts.hc.is_some() {
        extras.push(format!("FIRST_VALUE(hc {FIRST}) AS hc"));
    }
    extras.extend(
        parts
            .cols
            .iter()
            .map(|c| format!("FIRST_VALUE({c} {FIRST}) AS {c}")),
    );
    let tail: String = extras
        .iter()
        .map(|x| format!(", {x}"))
        .collect::<Vec<_>>()
        .concat();
    format!(
        "s1 AS (SELECT person, MIN(ts) AS t1, MIN(ts) AS t, MIN(ts) AS tp, {first_bd}{tail} FROM seq WHERE m1 = 1 GROUP BY person)"
    )
}

fn is_optional(spec: &FunnelSpec, step_1_based: usize) -> bool {
    spec.steps[step_1_based - 1].optional == Some(true)
}

/// Strict: the CTEs step k may follow.
fn strict_sources(spec: &FunnelSpec, k: usize) -> Vec<String> {
    let mut own = vec![format!("s{}", k - 1)];
    if k > 2 && is_optional(spec, k - 1) {
        own.extend(strict_sources(spec, k - 1));
    }
    own
}

/// Loose: the last required step before step k (1-based).
fn last_required(spec: &FunnelSpec, k: usize) -> usize {
    let mut j = k - 1;
    while j > 1 {
        if !is_optional(spec, j) {
            return j;
        }
        j -= 1;
    }
    1
}

fn strict_step_cte(parts: &mut PlanParts<'_>, k: usize) {
    let sources = strict_sources(parts.spec, k);
    let mut prev = sources[0].clone();
    if sources.len() > 1 {
        prev = format!("u{k}");
        let columns = if parts.hc.is_some() {
            "person, t1, t, next_id, bd, hc"
        } else {
            "person, t1, t, next_id, bd"
        };
        let selects: Vec<String> = sources
            .iter()
            .map(|s| format!("SELECT {columns} FROM {s}"))
            .collect();
        parts
            .ctes
            .push(format!("u{k} AS ({})", selects.join(" UNION ALL ")));
    }
    let carry = if parts.hc.is_some() {
        ", p.hc AS hc"
    } else {
        ""
    };
    let same_value = if parts.hc.is_some() {
        " AND q.hc = p.hc"
    } else {
        ""
    };
    parts.ctes.push(format!(
        "s{k} AS (SELECT p.person AS person, p.t1 AS t1, p.t AS tp, q.ts AS t, q.next_id AS next_id, p.bd AS bd{carry} FROM {prev} p \
         JOIN seq q ON q.event_id = p.next_id AND q.person = p.person WHERE q.m{k} = 1 AND q.ts <= p.t1 + {}{same_value})",
        parts.window
    ));
}

fn loose_step_cte(parts: &mut PlanParts<'_>, k: usize) {
    let j = last_required(parts.spec, k);
    let same_event = parts.spec.steps[k - 1].event == parts.spec.steps[j - 1].event;
    let carry = if parts.hc.is_some() {
        ", MIN(p.hc) AS hc"
    } else {
        ""
    };
    let same_value = if parts.hc.is_some() {
        " AND q.hc = p.hc"
    } else {
        ""
    };
    let after = if same_event { ">" } else { ">=" };
    parts.ctes.push(format!(
        "s{k} AS (SELECT p.person AS person, p.t1 AS t1, p.t AS tp, MIN(q.ts) AS t, MIN(p.bd) AS bd{carry} FROM s{j} p \
         JOIN seq q ON q.person = p.person WHERE q.m{k} = 1 AND q.ts {after} p.t AND q.ts <= p.t1 + {}\
         {same_value} GROUP BY p.person, p.t1, p.t)",
        parts.window
    ));
}

/// Exclusions: people who did the excluded event after `fromStep` and
/// before `toStep` (or the window's end) leave every step.
fn excluded_steps(parts: &mut PlanParts<'_>, steps: Vec<String>) -> Vec<String> {
    let exclusions = parts.spec.exclusions.as_deref().unwrap_or_default();
    if exclusions.is_empty() {
        return steps;
    }
    for (i, x) in exclusions.iter().enumerate() {
        parts.ctes.push(format!(
            "x{n} AS (SELECT DISTINCT f.person AS person FROM s{from} f \
             LEFT JOIN s{to} g ON g.person = f.person AND g.t1 = f.t1 JOIN seq q ON q.person = f.person \
             WHERE q.x{n} = 1 AND q.ts > f.t AND q.ts < COALESCE(g.t, f.t1 + {window}))",
            n = i + 1,
            from = x.from_step + 1,
            to = x.to_step + 1,
            window = parts.window
        ));
    }
    let excluded: Vec<String> = (0..exclusions.len())
        .map(|i| format!("SELECT person FROM x{}", i + 1))
        .collect();
    parts
        .ctes
        .push(format!("xall AS ({})", excluded.join(" UNION ")));
    steps
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let extra: String = if i == 0 {
                parts.cols.iter().map(|c| format!(", s.{c} AS {c}")).collect::<Vec<_>>().concat()
            } else {
                String::new()
            };
            parts.ctes.push(format!(
                "r{n} AS (SELECT s.person AS person, s.t1 AS t1, s.t AS t, s.tp AS tp, s.bd AS bd{extra} FROM {s} s \
                 LEFT JOIN xall xa ON xa.person = s.person WHERE xa.person IS NULL)",
                n = i + 1
            ));
            format!("r{}", i + 1)
        })
        .collect()
}

/// `funnelPlan`: the step CTEs (also for the correlation statements).
pub fn funnel_plan(
    spec: &FunnelSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    breakdowns: Option<&PreparedBreakdowns>,
    with_columns: bool,
) -> QueryResult<FunnelPlan> {
    let bd = breakdowns.map(limited_breakdown).transpose()?;
    let hc = spec
        .hold_constant
        .as_ref()
        .map(|b| {
            breakdown_expr(
                b,
                ctx,
                BreakdownExprOptions {
                    clean_paths: spec.clean_paths,
                    edges: None,
                },
            )
        })
        .transpose()?;
    let cols: Vec<String> = if with_columns {
        CORRELATION_COLUMNS
            .iter()
            .map(|c| format!("c_{c}"))
            .collect()
    } else {
        Vec::new()
    };
    let window = window_interval(spec)?;
    let seq = seq_cte(spec, ctx, range, bd.as_deref(), hc.as_deref(), with_columns)?;
    let mut parts = PlanParts {
        spec,
        ctes: vec![seq],
        bd,
        hc,
        cols,
        window: window.clone(),
    };

    if spec.order == FunnelOrder::Any {
        let reached = any_order_steps(&mut parts);
        return Ok(FunnelPlan {
            ctes: parts.ctes,
            reached,
            window,
        });
    }

    let strict = spec.order == FunnelOrder::Strict;
    let first = first_step_cte(&parts, strict);
    parts.ctes.push(first);
    for k in 2..=spec.steps.len() {
        if strict {
            strict_step_cte(&mut parts, k);
        } else {
            loose_step_cte(&mut parts, k);
        }
    }
    let steps: Vec<String> = (1..=spec.steps.len()).map(|i| format!("s{i}")).collect();
    let reached = excluded_steps(&mut parts, steps);
    Ok(FunnelPlan {
        ctes: parts.ctes,
        reached,
        window,
    })
}

/// `funnelQuery`: the funnel statement.
pub fn funnel_query(
    spec: &FunnelSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    breakdowns: Option<&PreparedBreakdowns>,
) -> QueryResult<PanelSqlQuery> {
    let plan = funnel_plan(spec, ctx, range, breakdowns, false)?;
    let finals: Vec<String> = plan
        .reached
        .iter()
        .enumerate()
        .map(|(i, source)| {
            format!(
                "SELECT {} AS step, bd AS bd, COUNT(DISTINCT person) AS persons, AVG(to_unixtime(t) - to_unixtime(tp)) AS avg_secs \
                 FROM {source} GROUP BY bd",
                i + 1
            )
        })
        .collect();
    Ok(PanelSqlQuery::new(
        "funnel.steps",
        format!(
            "WITH {} {}",
            plan.ctes.join(", "),
            finals.join(" UNION ALL ")
        ),
        &["step", "bd", "persons", "avg_secs"],
    ))
}

/// Edges (seconds) of the time-to-convert histogram.
pub const TIME_TO_CONVERT_EDGES: [i64; 10] = [
    10, 30, 60, 300, 1800, 3600, 21_600, 86_400, 259_200, 604_800,
];

/// `timeToConvertQuery`: per step (2..N) and overall (step 0): count,
/// median, p90, average and histogram.
pub fn time_to_convert_query(
    spec: &FunnelSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    breakdowns: Option<&PreparedBreakdowns>,
) -> QueryResult<PanelSqlQuery> {
    let plan = funnel_plan(spec, ctx, range, breakdowns, false)?;
    let last = plan.reached[plan.reached.len() - 1].clone();
    let mut parts: Vec<String> = plan
        .reached
        .iter()
        .skip(1)
        .enumerate()
        .map(|(i, source)| {
            format!(
                "SELECT {} AS step, to_unixtime(t) - to_unixtime(tp) AS secs FROM {source}",
                i + 2
            )
        })
        .collect();
    parts.push(format!(
        "SELECT 0 AS step, to_unixtime(t) - to_unixtime(t1) AS secs FROM {last}"
    ));
    let edges = TIME_TO_CONVERT_EDGES;
    let histogram: Vec<String> = (0..=edges.len())
        .map(|i| {
            let mut conds = Vec::new();
            if i > 0 {
                conds.push(format!("secs >= {}", edges[i - 1]));
            }
            if let Some(edge) = edges.get(i) {
                conds.push(format!("secs < {edge}"));
            }
            let cond = if conds.is_empty() {
                "secs IS NOT NULL".to_owned()
            } else {
                conds.join(" AND ")
            };
            format!("SUM(CASE WHEN {cond} THEN 1 ELSE 0 END) AS h{i}")
        })
        .collect();
    let sql = format!(
        "WITH {}, d AS ({}) SELECT step, COUNT(*) AS n, {} AS p50, {} AS p90, AVG(secs) AS avg_secs, {} FROM d GROUP BY step",
        plan.ctes.join(", "),
        parts.join(" UNION ALL "),
        percentile_sql("secs", 0.5)?,
        percentile_sql("secs", 0.9)?,
        histogram.join(", ")
    );
    let mut columns: Vec<String> = ["step", "n", "p50", "p90", "avg_secs"]
        .iter()
        .map(|c| (*c).to_owned())
        .collect();
    columns.extend((0..histogram.len()).map(|i| format!("h{i}")));
    Ok(PanelSqlQuery {
        name: "funnel.timeToConvert".to_owned(),
        sql,
        columns,
    })
}

/// `funnelTrendQuery`: entered and converted per bucket of the time people entered.
pub fn funnel_trend_query(
    spec: &FunnelSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    breakdowns: Option<&PreparedBreakdowns>,
    interval: Interval,
) -> QueryResult<PanelSqlQuery> {
    let plan = funnel_plan(spec, ctx, range, breakdowns, false)?;
    let first = &plan.reached[0];
    let last = &plan.reached[plan.reached.len() - 1];
    let bucket = bucket_sql("t1", interval, range.offset_minutes);
    let sql = format!(
        "WITH {} SELECT bucket, COUNT(DISTINCT CASE WHEN k = 1 THEN person END) AS entered, \
         COUNT(DISTINCT CASE WHEN k = 2 THEN person END) AS converted FROM (\
         SELECT 1 AS k, person, {bucket} AS bucket FROM {first} UNION ALL SELECT 2 AS k, person, {bucket} AS bucket FROM {last}\
         ) AS z GROUP BY bucket ORDER BY bucket ASC",
        plan.ctes.join(", ")
    );
    Ok(PanelSqlQuery::new(
        "funnel.trend",
        sql,
        &["bucket", "entered", "converted"],
    ))
}

fn steps_from(spec: &FunnelSpec, rows: &[&Row]) -> (Vec<PanelFunnelStepResult>, f64) {
    let counts: Vec<Vec<&Row>> = (0..spec.steps.len())
        .map(|i| {
            rows.iter()
                .filter(|r| to_number(r.get("step")) == (i + 1) as f64)
                .copied()
                .collect()
        })
        .collect();
    let sum_persons = |rows: &[&Row]| {
        rows.iter()
            .fold(0.0, |sum, r| sum + to_number(r.get("persons")))
    };
    let first = counts.first().map_or(0.0, |c| sum_persons(c));
    let mut previous_count = first;
    let last_index = spec.steps.len() - 1;
    let steps: Vec<PanelFunnelStepResult> = spec
        .steps
        .iter()
        .enumerate()
        .map(|(i, step)| {
            let step_rows = &counts[i];
            let count = sum_persons(step_rows);
            // Weighted by people: the average over the breakdown groups.
            let secs = (count > 0.0).then(|| {
                step_rows.iter().fold(0.0, |sum, r| {
                    sum + to_number(r.get("avg_secs")) * to_number(r.get("persons"))
                }) / count
            });
            let from_previous = if i == 0 {
                1.0
            } else if previous_count > 0.0 {
                count / previous_count
            } else {
                0.0
            };
            let mut result = PanelFunnelStepResult {
                index: i as i64,
                event: step.event.clone(),
                label: step
                    .label
                    .as_deref()
                    .map(js::trim)
                    .filter(|l| !l.is_empty())
                    .unwrap_or(&step.event)
                    .to_owned(),
                count,
                conversion_from_previous: from_previous,
                conversion_from_first: if first > 0.0 { count / first } else { 0.0 },
                dropped_off: if i == 0 {
                    0.0
                } else {
                    (previous_count - count).max(0.0)
                },
                avg_seconds_from_previous: if i == 0 || count == 0.0 {
                    None
                } else {
                    secs.map(js::math_round)
                },
                optional: None,
            };
            let optional = step.optional == Some(true)
                && spec.order != FunnelOrder::Any
                && i > 0
                && i < last_index;
            if optional {
                result.optional = Some(true);
            } else {
                // An optional step does not become the "previous" of the next one.
                previous_count = count;
            }
            result
        })
        .collect();
    let overall = match steps.last() {
        Some(last) if first > 0.0 => last.count / first,
        _ => 0.0,
    };
    (steps, overall)
}

fn stats_from(row: Option<&Row>) -> PanelTimeToConvertStats {
    let edges = TIME_TO_CONVERT_EDGES;
    let get = |key: &str| row.and_then(|r| r.get(key));
    let nullable = |key: &str| match get(key) {
        None | Some(serde_json::Value::Null) => None,
        value => Some(js::math_round(to_number(value))),
    };
    PanelTimeToConvertStats {
        count: to_number(get("n")),
        median_seconds: nullable("p50"),
        p90_seconds: nullable("p90"),
        avg_seconds: nullable("avg_secs"),
        histogram: (0..=edges.len())
            .map(|i| PanelTimeHistogramBucket {
                from_seconds: if i == 0 { 0.0 } else { edges[i - 1] as f64 },
                to_seconds: edges.get(i).map(|e| *e as f64),
                count: to_number(get(&format!("h{i}"))),
            })
            .collect(),
    }
}

/// `timeToConvertFrom`: time-to-convert rows (step 0 = overall) as the result shape.
pub fn time_to_convert_from(spec: &FunnelSpec, rows: &[Row]) -> PanelFunnelTimeToConvert {
    let mut by_step: HashMap<u64, &Row> = HashMap::new();
    for row in rows {
        let step = to_number(row.get("step"));
        by_step.insert((step + 0.0).to_bits(), row);
    }
    let lookup = |step: f64| by_step.get(&(step + 0.0).to_bits()).copied();
    PanelFunnelTimeToConvert {
        overall: stats_from(lookup(0.0)),
        steps: (1..spec.steps.len())
            .map(|i| PanelStepTimeToConvert {
                index: i as i64,
                stats: stats_from(lookup((i + 1) as f64)),
            })
            .collect(),
    }
}

fn trend_from(
    rows: &[Row],
    range: &ResolvedRange,
    interval: Interval,
) -> Vec<PanelFunnelTrendPoint> {
    let mut by_bucket: HashMap<String, &Row> = HashMap::new();
    for row in rows {
        by_bucket.insert(bucket_label(row.get("bucket"), interval), row);
    }
    bucket_labels(range.bounds(), interval, range.offset_minutes)
        .into_iter()
        .map(|bucket| {
            let row = by_bucket.get(&bucket).copied();
            let entered = to_number(row.and_then(|r| r.get("entered")));
            let converted = to_number(row.and_then(|r| r.get("converted")));
            PanelFunnelTrendPoint {
                bucket,
                entered,
                converted,
                conversion: if entered > 0.0 {
                    converted / entered
                } else {
                    0.0
                },
            }
        })
        .collect()
}

/// Hours make sense for short ranges only.
fn funnel_trend_interval(range: &ResolvedRange, requested: Option<Interval>) -> Interval {
    let days = (range.to - range.from) as f64 / 86_400_000.0;
    let interval = requested.unwrap_or(Interval::Day);
    if interval == Interval::Hour && days > 14.0 {
        Interval::Day
    } else {
        interval
    }
}

/// `runFunnel`.
pub async fn run_funnel<E: PanelSqlExecutor + ?Sized>(
    spec: &FunnelSpec,
    ctx: &PanelQueryContext,
    runner: &Runner<'_, E>,
) -> Result<PanelFunnelResult, PanelError> {
    let range = resolve_range(&spec.base.date_range, &spec.base.timezone, ctx)?;
    let breakdowns = prepare_funnel_breakdowns(spec, ctx, &range, runner).await?;
    let breakdowns = breakdowns.as_ref();

    let mut queries = vec![funnel_query(spec, ctx, &range, breakdowns)?];
    let interval = funnel_trend_interval(&range, spec.interval);
    if spec.display == Some(FunnelDisplay::TimeToConvert) {
        queries.push(time_to_convert_query(spec, ctx, &range, breakdowns)?);
    }
    if spec.display == Some(FunnelDisplay::Trends) {
        queries.push(funnel_trend_query(spec, ctx, &range, breakdowns, interval)?);
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
    let rows: Vec<&Row> = at("funnel.steps").iter().collect();

    let (steps, overall) = steps_from(spec, &rows);
    let mut breakdown_results = None;
    if let Some(prepared) = breakdowns {
        let seen: Vec<String> = rows.iter().map(|r| to_text(r.get("bd"))).collect();
        breakdown_results = Some(
            ordered_values(prepared, &seen)
                .into_iter()
                .map(|value| {
                    let part_rows: Vec<&Row> = rows
                        .iter()
                        .filter(|r| to_text(r.get("bd")) == value)
                        .copied()
                        .collect();
                    let (part_steps, part_overall) = steps_from(spec, &part_rows);
                    PanelFunnelBreakdown {
                        parts: parts_for(Some(prepared), Some(&value)),
                        value,
                        steps: part_steps,
                        overall_conversion: part_overall,
                    }
                })
                .collect(),
        );
    }
    let mut result = PanelFunnelResult {
        range: to_resolved_range(&range, None),
        steps,
        overall_conversion: overall,
        breakdowns: breakdown_results,
        time_to_convert: None,
        trend: None,
        interval: None,
    };
    if spec.display == Some(FunnelDisplay::TimeToConvert) {
        result.time_to_convert = Some(time_to_convert_from(spec, at("funnel.timeToConvert")));
    }
    if spec.display == Some(FunnelDisplay::Trends) {
        result.trend = Some(trend_from(at("funnel.trend"), &range, interval));
        result.interval = Some(interval);
    }
    Ok(result)
}
