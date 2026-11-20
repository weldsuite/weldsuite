//! `flows` (`flows.ts`): the most common paths after (or before) an event.
//! One scan: the events of each person in order, with `LEAD` / `LAG` giving
//! the neighbours of every anchor occurrence. Pages are labelled by path,
//! other events by name.

use super::context::PanelQueryContext;
use super::paths::cleaned_path;
use super::result_range::to_resolved_range;
use super::rows::{
    PanelError, PanelSqlExecutor, PanelSqlQuery, Runner, to_nullable_text, to_number,
};
use super::scope::{ScopeOptions, ScopeUse, event_with_filters, events_scope, scope_needs};
use super::sql::{QueryResult, int, lit};
use super::time::{ResolvedRange, resolve_range};
use crate::js;
use crate::schemas::{FlowDirection, FlowScope, FlowsSpec, PanelFlowPath, PanelFlowsResult};

/// Rows read before the spec's `limit` trims them.
const MAX_PATH_ROWS: i64 = 500;

/// `flowsQuery`.
pub fn flows_query(
    spec: &FlowsSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
) -> QueryResult<PanelSqlQuery> {
    let needs = scope_needs(
        ctx,
        &ScopeUse {
            filters: &[spec.anchor.filters.as_slice()],
            events: &[spec.anchor.event.as_str()],
            ..ScopeUse::default()
        },
    )?;
    let scope = events_scope(
        ctx,
        range,
        range.bounds(),
        ScopeOptions::with_needs(Some(&spec.base.filters), &needs),
    )?;
    let anchor = format!(
        "({})",
        event_with_filters(
            &spec.anchor.event,
            &spec.anchor.filters,
            ctx,
            range,
            &scope.person
        )?
    );
    // Pages are labelled by their (cleaned) path, other events by name.
    let label = format!(
        "CASE WHEN e.name = '$pageview' THEN {} ELSE e.name END",
        cleaned_path(ctx, spec.clean_paths)?
    );

    let in_scope = match spec.scope {
        FlowScope::Pageviews => Some(format!("e.name = {}", lit("$pageview")?)),
        FlowScope::Custom => Some("e.name NOT LIKE '$%'".to_owned()),
        FlowScope::All => None,
    };
    let where_ = match &in_scope {
        Some(in_scope) => scope.where_sql(&[format!("({in_scope} OR {anchor})")]),
        None => scope.where_base(),
    };

    let function = if spec.direction == FlowDirection::After {
        "LEAD"
    } else {
        "LAG"
    };
    let depth = usize::try_from(spec.depth).unwrap_or(0);
    let columns: Vec<String> = (1..=depth).map(|i| format!("n{i}")).collect();
    let neighbours: Vec<String> = columns
        .iter()
        .enumerate()
        .map(|(i, name)| {
            format!(
                "{function}({label}, {}) OVER (PARTITION BY {} ORDER BY e.ts, e.event_id) AS {name}",
                i + 1,
                scope.person
            )
        })
        .collect();
    let sql = format!(
        "SELECT {cols}, COUNT(*) AS cnt FROM (\
         SELECT CASE WHEN {anchor} THEN 1 ELSE 0 END AS is_anchor, {} FROM {} {where_}\
         ) AS seq WHERE is_anchor = 1 GROUP BY {cols} ORDER BY COUNT(*) DESC LIMIT {}",
        neighbours.join(", "),
        scope.from,
        int(MAX_PATH_ROWS, MAX_PATH_ROWS)?,
        cols = columns.join(", ")
    );
    let mut all_columns = columns;
    all_columns.push("cnt".to_owned());
    Ok(PanelSqlQuery {
        name: "flows.paths".to_owned(),
        sql,
        columns: all_columns,
    })
}

/// `runFlows`.
pub async fn run_flows<E: PanelSqlExecutor + ?Sized>(
    spec: &FlowsSpec,
    ctx: &PanelQueryContext,
    runner: &Runner<'_, E>,
) -> Result<PanelFlowsResult, PanelError> {
    let range = resolve_range(&spec.base.date_range, &spec.base.timezone, ctx)?;
    let rows = runner.run_one(flows_query(spec, ctx, &range)?).await?;
    let depth = usize::try_from(spec.depth).unwrap_or(0);
    let all: Vec<PanelFlowPath> = rows
        .iter()
        .map(|row| PanelFlowPath {
            steps: (1..=depth)
                .map(|i| to_nullable_text(row.get(&format!("n{i}"))))
                .collect(),
            count: to_number(row.get("cnt")),
        })
        .collect();
    let anchor_count = all.iter().fold(0.0, |sum, p| sum + p.count);
    let limit = usize::try_from(spec.limit).unwrap_or(0);
    Ok(PanelFlowsResult {
        range: to_resolved_range(&range, None),
        anchor: spec
            .anchor
            .label
            .as_deref()
            .map(js::trim)
            .filter(|l| !l.is_empty())
            .unwrap_or(&spec.anchor.event)
            .to_owned(),
        direction: spec.direction,
        depth: spec.depth,
        anchor_count,
        paths: all.into_iter().take(limit).collect(),
    })
}
