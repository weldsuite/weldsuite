//! `funnel_correlation` (`correlation.ts`): what sets the people who
//! converted apart from the people who dropped, built on the funnel's step
//! CTEs. Two statements: the other events people did between entering and
//! converting (or the window's end), and the column values of their first
//! step. Odds ratios are add-one smoothed; values seen by fewer than three
//! people are left out.

use super::context::PanelQueryContext;
use super::funnel::{CORRELATION_COLUMNS, funnel_plan};
use super::result_range::to_resolved_range;
use super::rows::{PanelError, PanelSqlExecutor, PanelSqlQuery, Row, Runner, to_number, to_text};
use super::scope::{NONE_LABEL, ScopeOptions, event_names_of, events_scope, unit_expr};
use super::sql::{QueryResult, in_list, lit};
use super::time::{ResolvedRange, resolve_range};
use crate::js;
use crate::schemas::{
    CorrelationDirection, CorrelationType, FunnelCorrelationSpec, PanelCorrelationRow,
    PanelFunnelCorrelationResult,
};

/// System events that say nothing about intent.
const NOISE_EVENTS: [&str; 4] = ["$pageleave", "$identify", "$webvitals", "$autocapture"];
const TOTAL: &str = "$total";
const MIN_PEOPLE: f64 = 3.0;
const MAX_EVENT_ROWS: i64 = 200;
const MAX_PROPERTY_ROWS: i64 = 600;

fn outcome_cte(
    spec: &FunnelCorrelationSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
) -> QueryResult<String> {
    let plan = funnel_plan(&spec.funnel, ctx, range, None, true)?;
    let first = &plan.reached[0];
    let last = &plan.reached[plan.reached.len() - 1];
    let columns = CORRELATION_COLUMNS
        .iter()
        .map(|c| format!("MIN(a.c_{c}) AS c_{c}"))
        .collect::<Vec<_>>()
        .join(", ");
    let o = format!(
        "o AS (SELECT a.person AS person, MIN(a.t1) AS t1, MAX(CASE WHEN b.person IS NULL THEN 0 ELSE 1 END) AS conv, \
         MAX(COALESCE(b.t, a.t1 + {})) AS t_end, {columns} \
         FROM {first} a LEFT JOIN {last} b ON b.person = a.person AND b.t1 = a.t1 GROUP BY a.person)",
        plan.window
    );
    let mut ctes = plan.ctes.clone();
    ctes.push(o);
    Ok(format!("WITH {}", ctes.join(", ")))
}

/// `correlationQueries`.
pub fn correlation_queries(
    spec: &FunnelCorrelationSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
) -> QueryResult<Vec<PanelSqlQuery>> {
    let with_o = outcome_cte(spec, ctx, range)?;
    let funnel = &spec.funnel;

    let scope = events_scope(
        ctx,
        range,
        range.bounds(),
        ScopeOptions {
            filters: Some(&funnel.base.filters),
            ..ScopeOptions::default()
        },
    )?;
    let unit = unit_expr(ctx, &scope, funnel.aggregate_by.as_ref())?;
    let mut names = Vec::new();
    for step in &funnel.steps {
        names.extend(event_names_of(&step.event, ctx)?);
    }
    let mut skip = js::distinct(names);
    skip.extend(NOISE_EVENTS.iter().map(|n| (*n).to_owned()));
    let mut extra = unit.conds.clone();
    extra.push("e.ts >= o.t1".to_owned());
    extra.push("e.ts <= o.t_end".to_owned());
    extra.push(format!("e.name NOT IN {}", in_list(&skip)?));
    let where_ = scope.where_sql(&extra);
    let events_sql = format!(
        "{with_o} SELECT e.name AS value, COUNT(DISTINCT CASE WHEN o.conv = 1 THEN o.person END) AS success, \
         COUNT(DISTINCT CASE WHEN o.conv = 0 THEN o.person END) AS failure \
         FROM {} JOIN o ON o.person = {} {where_} \
         GROUP BY e.name ORDER BY COUNT(DISTINCT o.person) DESC LIMIT {MAX_EVENT_ROWS}",
        scope.from, unit.expr
    );

    let mut prop_rows = vec![format!("SELECT {} AS prop", lit(TOTAL)?)];
    for c in CORRELATION_COLUMNS {
        prop_rows.push(format!("SELECT {} AS prop", lit(c)?));
    }
    let k = format!("k AS ({})", prop_rows.join(" UNION ALL "));
    let whens = CORRELATION_COLUMNS
        .iter()
        .map(|c| {
            Ok(format!(
                "WHEN {} THEN COALESCE(CAST(o.c_{c} AS VARCHAR), {})",
                lit(c)?,
                lit(NONE_LABEL)?
            ))
        })
        .collect::<QueryResult<Vec<_>>>()?;
    let value = format!("CASE k.prop {} ELSE '' END", whens.join(" "));
    let props_sql = format!(
        "{with_o}, {k} SELECT k.prop AS prop, {value} AS value, SUM(o.conv) AS success, SUM(1 - o.conv) AS failure \
         FROM o CROSS JOIN k GROUP BY k.prop, {value} ORDER BY COUNT(*) DESC LIMIT {MAX_PROPERTY_ROWS}"
    );

    Ok(vec![
        PanelSqlQuery::new(
            "correlation.events",
            events_sql,
            &["value", "success", "failure"],
        ),
        PanelSqlQuery::new(
            "correlation.properties",
            props_sql,
            &["prop", "value", "success", "failure"],
        ),
    ])
}

/// `correlationRow`: one row from the counts with it and the group sizes.
pub fn correlation_row(
    row_type: CorrelationType,
    property: Option<String>,
    value: String,
    success: f64,
    failure: f64,
    converted: f64,
    dropped: f64,
) -> PanelCorrelationRow {
    let success_without = (converted - success).max(0.0);
    let failure_without = (dropped - failure).max(0.0);
    let odds_ratio =
        (success + 1.0) / (failure + 1.0) / ((success_without + 1.0) / (failure_without + 1.0));
    let rate = |s: f64, f: f64| if s + f > 0.0 { s / (s + f) } else { 0.0 };
    PanelCorrelationRow {
        row_type,
        property,
        value,
        success_count: success,
        failure_count: failure,
        success_rate_with: rate(success, failure),
        success_rate_without: rate(success_without, failure_without),
        odds_ratio: js::math_round(odds_ratio * 1000.0) / 1000.0,
        correlation: if odds_ratio >= 1.0 {
            CorrelationDirection::Positive
        } else {
            CorrelationDirection::Negative
        },
    }
}

/// `b - a` as JavaScript's sort reads a comparator's number.
pub(crate) fn by_difference(difference: f64) -> std::cmp::Ordering {
    if difference > 0.0 {
        std::cmp::Ordering::Greater
    } else if difference < 0.0 {
        std::cmp::Ordering::Less
    } else {
        std::cmp::Ordering::Equal
    }
}

/// The strongest `limit` positive and `limit` negative rows, strongest first.
fn strongest(rows: Vec<PanelCorrelationRow>, limit: i64) -> Vec<PanelCorrelationRow> {
    let strength = |r: &PanelCorrelationRow| {
        let ratio = if r.odds_ratio == 0.0 || r.odds_ratio.is_nan() {
            1.0
        } else {
            r.odds_ratio
        };
        ratio.ln().abs()
    };
    let limit = usize::try_from(limit).unwrap_or(0);
    let mut positive: Vec<PanelCorrelationRow> = rows
        .iter()
        .filter(|r| r.correlation == CorrelationDirection::Positive && r.odds_ratio != 1.0)
        .cloned()
        .collect();
    positive.sort_by(|a, b| by_difference(strength(b) - strength(a)));
    positive.truncate(limit);
    let mut negative: Vec<PanelCorrelationRow> = rows
        .into_iter()
        .filter(|r| r.correlation == CorrelationDirection::Negative)
        .collect();
    negative.sort_by(|a, b| by_difference(strength(b) - strength(a)));
    negative.truncate(limit);
    let mut all = positive;
    all.extend(negative);
    all.sort_by(|a, b| by_difference(strength(b) - strength(a)));
    all
}

/// `runFunnelCorrelation`.
pub async fn run_funnel_correlation<E: PanelSqlExecutor + ?Sized>(
    spec: &FunnelCorrelationSpec,
    ctx: &PanelQueryContext,
    runner: &Runner<'_, E>,
) -> Result<PanelFunnelCorrelationResult, PanelError> {
    let base = &spec.funnel.base;
    let range = resolve_range(&base.date_range, &base.timezone, ctx)?;
    let mut results = runner
        .run(&correlation_queries(spec, ctx, &range)?)
        .await?
        .into_iter();
    let event_rows = results.next().unwrap_or_default();
    let property_rows = results.next().unwrap_or_default();

    let total = property_rows
        .iter()
        .find(|r| to_text(r.get("prop")) == TOTAL);
    let converted = to_number(total.and_then(|r| r.get("success")));
    let dropped = to_number(total.and_then(|r| r.get("failure")));
    let enough = |r: &&Row| to_number(r.get("success")) + to_number(r.get("failure")) >= MIN_PEOPLE;

    let events = event_rows
        .iter()
        .filter(enough)
        .map(|r| {
            correlation_row(
                CorrelationType::Event,
                None,
                to_text(r.get("value")),
                to_number(r.get("success")),
                to_number(r.get("failure")),
                converted,
                dropped,
            )
        })
        .collect();
    let properties = property_rows
        .iter()
        .filter(|r| to_text(r.get("prop")) != TOTAL)
        .filter(enough)
        .map(|r| {
            correlation_row(
                CorrelationType::Property,
                Some(to_text(r.get("prop"))),
                to_text(r.get("value")),
                to_number(r.get("success")),
                to_number(r.get("failure")),
                converted,
                dropped,
            )
        })
        .collect();

    Ok(PanelFunnelCorrelationResult {
        range: to_resolved_range(&range, None),
        converted,
        dropped,
        events: strongest(events, spec.limit),
        properties: strongest(properties, spec.limit),
    })
}
