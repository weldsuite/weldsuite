//! `signal` (`signal.ts`): which events go with reaching a goal. For everyone
//! active in the range: did they do the candidate event within `windowDays`
//! of their first event in the range? Per candidate: goal rate with and
//! without, lift and the phi correlation of that 2×2 table. Candidates are
//! the spec's, or the `topN` most common events (a first, cheap statement).

use super::context::PanelQueryContext;
use super::correlation::by_difference;
use super::result_range::to_resolved_range;
use super::rows::{PanelError, PanelSqlExecutor, PanelSqlQuery, Runner, to_number, to_text};
use super::scope::{
    EventsScope, ScopeOptions, ScopeUse, event_match, event_names_of, event_with_filters,
    events_scope, scope_needs,
};
use super::sql::{QueryResult, in_list, int, is_event_name};
use super::time::{ResolvedRange, resolve_range};
use crate::js;
use crate::schemas::{PanelSignalCandidate, PanelSignalResult, SignalSpec};

const NOISE_EVENTS: [&str; 4] = ["$pageleave", "$identify", "$webvitals", "$autocapture"];

fn signal_scope(
    spec: &SignalSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    candidates: &[String],
) -> QueryResult<EventsScope> {
    let mut events = vec![spec.goal.event.as_str()];
    events.extend(candidates.iter().map(String::as_str));
    let needs = scope_needs(
        ctx,
        &ScopeUse {
            filters: &[spec.goal.filters.as_slice()],
            events: &events,
            ..ScopeUse::default()
        },
    )?;
    events_scope(
        ctx,
        range,
        range.bounds(),
        ScopeOptions::with_needs(Some(&spec.base.filters), &needs),
    )
}

/// `signalCandidatesQuery`: the most common events besides the goal (by people).
pub fn signal_candidates_query(
    spec: &SignalSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
) -> QueryResult<PanelSqlQuery> {
    let scope = signal_scope(spec, ctx, range, &[])?;
    let mut skip = event_names_of(&spec.goal.event, ctx)?;
    skip.extend(NOISE_EVENTS.iter().map(|n| (*n).to_owned()));
    let not_skipped = format!("e.name NOT IN {}", in_list(&skip)?);
    let sql = format!(
        "SELECT e.name AS name, COUNT(DISTINCT {p}) AS n FROM {} {} \
         GROUP BY e.name ORDER BY COUNT(DISTINCT {p}) DESC LIMIT {}",
        scope.from,
        scope.where_sql(&[not_skipped]),
        int(spec.top_n, 20)?,
        p = scope.person
    );
    Ok(PanelSqlQuery::new("signal.candidates", sql, &["name", "n"]))
}

/// `signalQuery`.
pub fn signal_query(
    spec: &SignalSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    candidates: &[String],
) -> QueryResult<PanelSqlQuery> {
    let scope = signal_scope(spec, ctx, range, candidates)?;
    let goal = event_with_filters(
        &spec.goal.event,
        &spec.goal.filters,
        ctx,
        range,
        &scope.person,
    )?;
    let flags = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| {
            Ok(format!(
                "CASE WHEN {} THEN 1 ELSE 0 END AS m{i}",
                event_match(c, ctx, range, &scope.person)?
            ))
        })
        .collect::<QueryResult<Vec<_>>>()?;
    let mut inner_columns = vec![
        format!("{} AS u", scope.person),
        "e.ts AS ts".to_owned(),
        format!("MIN(e.ts) OVER (PARTITION BY {}) AS t0", scope.person),
        format!("CASE WHEN {goal} THEN 1 ELSE 0 END AS gm"),
    ];
    inner_columns.extend(flags);
    let inner = format!(
        "SELECT {} FROM {} {}",
        inner_columns.join(", "),
        scope.from,
        scope.where_base()
    );
    let window = format!("INTERVAL '{} days'", int(spec.window_days, 90)?);
    let mut per_person_columns = vec![
        "MAX(gm) AS g".to_owned(),
        "MAX(CASE WHEN gm = 1 THEN ts END) AS lg".to_owned(),
    ];
    per_person_columns
        .extend((0..candidates.len()).map(|i| {
            format!("MIN(CASE WHEN m{i} = 1 AND ts < t0 + {window} THEN ts END) AS f{i}")
        }));
    let per_person = format!(
        "SELECT u, {} FROM ({inner}) AS ev GROUP BY u",
        per_person_columns.join(", ")
    );
    let mut sums = vec![
        "COUNT(*) AS users".to_owned(),
        "SUM(g) AS goal_users".to_owned(),
    ];
    let mut columns = vec!["users".to_owned(), "goal_users".to_owned()];
    for i in 0..candidates.len() {
        sums.push(format!(
            "SUM(CASE WHEN f{i} IS NOT NULL THEN 1 ELSE 0 END) AS c{i}_n"
        ));
        // Did the candidate, then reached the goal after it.
        sums.push(format!(
            "SUM(CASE WHEN f{i} IS NOT NULL AND lg > f{i} THEN 1 ELSE 0 END) AS c{i}_g"
        ));
        // Didn't do the candidate, reached the goal.
        sums.push(format!(
            "SUM(CASE WHEN f{i} IS NULL THEN g ELSE 0 END) AS c{i}_ng"
        ));
        columns.extend([format!("c{i}_n"), format!("c{i}_g"), format!("c{i}_ng")]);
    }
    Ok(PanelSqlQuery {
        name: "signal.main".to_owned(),
        sql: format!("SELECT {} FROM ({per_person}) AS per", sums.join(", ")),
        columns,
    })
}

/// `signalCandidate`: one candidate's numbers from the 2×2 table.
pub fn signal_candidate(
    event: &str,
    users: f64,
    did: f64,
    did_and_goal: f64,
    did_not_and_goal: f64,
) -> PanelSignalCandidate {
    let did_not = (users - did).max(0.0);
    let goal_without = did_not_and_goal.max(0.0).min(did_not);
    let did_goal_rate = if did > 0.0 { did_and_goal / did } else { 0.0 };
    let did_not_goal_rate = if did_not > 0.0 {
        goal_without / did_not
    } else {
        0.0
    };
    let n11 = did_and_goal;
    let n10 = did - did_and_goal;
    let n01 = goal_without;
    let n00 = (did_not - goal_without).max(0.0);
    let reached = n11 + n01;
    let denominator = (did * did_not * reached * (users - reached)).sqrt();
    let phi = (denominator > 0.0).then(|| (n11 * n00 - n10 * n01) / denominator);
    let round = |v: f64| js::math_round(v * 10000.0) / 10000.0;
    PanelSignalCandidate {
        event: event.to_owned(),
        did_users: did,
        did_goal_rate: round(did_goal_rate),
        did_not_users: did_not,
        did_not_goal_rate: round(did_not_goal_rate),
        lift: (did_not_goal_rate > 0.0).then(|| round(did_goal_rate / did_not_goal_rate)),
        correlation: phi.filter(|p| p.is_finite()).map(round),
    }
}

/// `runSignal`.
pub async fn run_signal<E: PanelSqlExecutor + ?Sized>(
    spec: &SignalSpec,
    ctx: &PanelQueryContext,
    runner: &Runner<'_, E>,
) -> Result<PanelSignalResult, PanelError> {
    let range = resolve_range(&spec.base.date_range, &spec.base.timezone, ctx)?;
    let mut candidates: Vec<String> = js::distinct(spec.candidates.iter().flatten().cloned())
        .into_iter()
        .filter(|c| *c != spec.goal.event)
        .collect();
    if spec.candidates.is_none() {
        let rows = runner
            .run_one(signal_candidates_query(spec, ctx, &range)?)
            .await?;
        candidates = rows
            .iter()
            .map(|r| to_text(r.get("name")))
            .filter(|name| is_event_name(name))
            .collect();
    }
    let result = |users: f64, goal_users: f64, goal_rate: f64, candidates| PanelSignalResult {
        range: to_resolved_range(&range, None),
        goal: spec.goal.event.clone(),
        window_days: spec.window_days,
        users,
        goal_users,
        goal_rate,
        candidates,
    };
    if candidates.is_empty() {
        return Ok(result(0.0, 0.0, 0.0, Vec::new()));
    }

    let rows = runner
        .run_one(signal_query(spec, ctx, &range, &candidates)?)
        .await?;
    let row = rows.into_iter().next().unwrap_or_default();
    let users = to_number(row.get("users"));
    let goal_users = to_number(row.get("goal_users"));
    let mut results: Vec<PanelSignalCandidate> = candidates
        .iter()
        .enumerate()
        .map(|(i, event)| {
            signal_candidate(
                event,
                users,
                to_number(row.get(&format!("c{i}_n"))),
                to_number(row.get(&format!("c{i}_g"))),
                to_number(row.get(&format!("c{i}_ng"))),
            )
        })
        .collect();
    let strength = |c: &PanelSignalCandidate| c.correlation.unwrap_or(0.0).abs();
    results.sort_by(|a, b| by_difference(strength(b) - strength(a)));
    let goal_rate = if users > 0.0 { goal_users / users } else { 0.0 };
    Ok(result(users, goal_users, goal_rate, results))
}
