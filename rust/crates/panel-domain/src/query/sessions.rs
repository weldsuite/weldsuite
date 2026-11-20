//! `sessions` (`sessions.ts`): the recordings list. A session is an
//! aggregate of `events_v1` by `session_id`, and the sessions that have
//! recording chunks are marked from `replay_chunks_v1` in a second statement
//! for the ids on the page. The cursor is an offset: the statement asks for
//! `offset + limit + 1` rows, capped at [`MAX_SESSIONS_REACH`].

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

use super::context::PanelQueryContext;
use super::result_range::to_resolved_range;
use super::rows::{
    PanelError, PanelSqlExecutor, PanelSqlQuery, Row, Runner, to_iso, to_nullable_text, to_number,
    to_text,
};
use super::scope::{
    ScopeOptions, ScopeUse, cohort_membership, event_match, events_scope, history_bounds,
    replay_chunks_table, scope_conds, scope_needs,
};
use super::sql::{
    LIKE_ESCAPE, PanelQueryError, QueryResult, event_name, in_list, int, like_contains, lit, num,
    ts,
};
use super::time::{ResolvedRange, resolve_range};
use crate::js;
use crate::schemas::{
    DeviceClass, FrustrationType, PanelSessionRow, PanelSessionsResult, SessionSort, SessionsSpec,
};
use crate::wire::is_custom_event_ref;

/// The furthest a page may reach.
pub const MAX_SESSIONS_REACH: i64 = 500;

const COLUMNS: [&str; 20] = [
    "session_id",
    "started",
    "ended",
    "duration_seconds",
    "pageviews",
    "clicks",
    "events",
    "rage",
    "dead",
    "quickback",
    "excessive",
    "errors",
    "entry_page",
    "exit_page",
    "device",
    "browser",
    "os",
    "country",
    "person",
    "user_id",
];

fn frustration_name(kind: FrustrationType) -> &'static str {
    match kind {
        FrustrationType::Rage => "$rageclick",
        FrustrationType::Dead => "$deadclick",
        FrustrationType::Quickback => "$quickback",
        FrustrationType::ExcessiveScroll => "$excessivescroll",
    }
}

/// `SUM(CASE WHEN <cond> THEN 1 ELSE 0 END)` over the session's events.
fn count(cond: &str) -> String {
    format!("SUM(CASE WHEN {cond} THEN 1 ELSE 0 END)")
}

fn named(name: &str) -> QueryResult<String> {
    Ok(format!("name = {}", event_name(name)?))
}

/// The custom events among the did / did-not events.
fn custom_refs(spec: &SessionsSpec) -> Vec<String> {
    js::distinct(
        spec.did_events
            .iter()
            .flatten()
            .chain(spec.not_did_events.iter().flatten())
            .filter(|e| is_custom_event_ref(e))
            .cloned(),
    )
}

/// How often the session did an event.
fn did_count(event: &str, refs: &[String]) -> QueryResult<String> {
    match refs.iter().position(|r| r == event) {
        Some(index) => Ok(format!("SUM(ce{index})")),
        None => Ok(count(&named(event)?)),
    }
}

const DURATION: &str = "to_unixtime(MAX(ts)) - to_unixtime(MIN(ts))";

fn having_conditions(spec: &SessionsSpec, refs: &[String]) -> QueryResult<Vec<String>> {
    let mut having = Vec::new();
    if let Some(min) = spec.min_duration_seconds {
        having.push(format!("{DURATION} >= {}", num(min as f64)?));
    }
    if let Some(max) = spec.max_duration_seconds {
        having.push(format!("{DURATION} <= {}", num(max as f64)?));
    }
    for page in spec.pages_visited.iter().flatten() {
        let visited = format!(
            "name = {} AND LOWER(path) LIKE {}{LIKE_ESCAPE}",
            lit("$pageview")?,
            like_contains(page)?
        );
        having.push(format!("{} > 0", count(&visited)));
    }
    if let Some(entry) = spec.entry_page.as_deref().filter(|p| !p.is_empty()) {
        having.push(format!(
            "MAX(CASE WHEN rn_first = 1 THEN LOWER(path) END) LIKE {}{LIKE_ESCAPE}",
            like_contains(entry)?
        ));
    }
    if let Some(exit) = spec.exit_page.as_deref().filter(|p| !p.is_empty()) {
        having.push(format!(
            "MAX(CASE WHEN rn_last = 1 THEN LOWER(path) END) LIKE {}{LIKE_ESCAPE}",
            like_contains(exit)?
        ));
    }
    if let Some(countries) = spec.countries.as_ref().filter(|c| !c.is_empty()) {
        having.push(format!("MAX(country) IN {}", in_list(countries)?));
    }
    if let Some(devices) = spec.devices.as_ref().filter(|d| !d.is_empty()) {
        let names: Vec<&str> = devices.iter().map(|d| d.as_str()).collect();
        having.push(format!("MAX(device_type) IN {}", in_list(&names)?));
    }
    if let Some(browsers) = spec.browsers.as_ref().filter(|b| !b.is_empty()) {
        having.push(format!("MAX(browser) IN {}", in_list(browsers)?));
    }
    for event in spec.did_events.iter().flatten() {
        having.push(format!("{} > 0", did_count(event, refs)?));
    }
    for event in spec.not_did_events.iter().flatten() {
        having.push(format!("{} = 0", did_count(event, refs)?));
    }
    for kind in spec.frustration.iter().flatten() {
        having.push(format!("{} > 0", count(&named(frustration_name(*kind))?)));
    }
    if spec.has_errors == Some(true) {
        having.push(format!("{} > 0", count(&named("$exception")?)));
    }
    Ok(having)
}

fn order_by(spec: &SessionsSpec) -> QueryResult<String> {
    Ok(match spec.sort {
        SessionSort::DurationDesc => format!("{DURATION} DESC"),
        SessionSort::PagesDesc => format!("{} DESC", count(&named("$pageview")?)),
        SessionSort::FrustrationDesc => {
            let names = [
                FrustrationType::Rage,
                FrustrationType::Dead,
                FrustrationType::Quickback,
                FrustrationType::ExcessiveScroll,
            ]
            .map(frustration_name);
            format!(
                "{} DESC, MIN(ts) DESC",
                count(&format!("name IN {}", in_list(&names)?))
            )
        }
        SessionSort::ErrorsDesc => format!("{} DESC, MIN(ts) DESC", count(&named("$exception")?)),
        SessionSort::StartedDesc => "MIN(ts) DESC".to_owned(),
    })
}

static CURSOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^o([0-9]{1,4})$").expect("a valid pattern"));

/// `parseSessionsCursor`: the offset a cursor stands for.
pub fn parse_sessions_cursor(cursor: Option<&str>) -> QueryResult<i64> {
    let Some(cursor) = cursor.filter(|c| !c.is_empty()) else {
        return Ok(0);
    };
    CURSOR
        .captures(cursor)
        .and_then(|caps| caps.get(1))
        .and_then(|m| m.as_str().parse().ok())
        .ok_or_else(|| PanelQueryError::new("Invalid cursor"))
}

fn cursor_of(spec: &SessionsSpec) -> Option<&str> {
    spec.cursor.as_ref().and_then(|c| c.as_deref())
}

/// `sessionsQuery`.
pub fn sessions_query(
    spec: &SessionsSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
) -> QueryResult<PanelSqlQuery> {
    let offset = parse_sessions_cursor(cursor_of(spec))?;
    if offset + spec.limit + 1 > MAX_SESSIONS_REACH + 1 {
        return Err(PanelQueryError::new(
            "Narrow the filters to see further back",
        ));
    }

    let refs = custom_refs(spec);
    let ref_slices: Vec<&str> = refs.iter().map(String::as_str).collect();
    let needs = scope_needs(
        ctx,
        &ScopeUse {
            events: &ref_slices,
            ..ScopeUse::default()
        },
    )?;
    let scope = events_scope(
        ctx,
        range,
        range.bounds(),
        ScopeOptions::with_needs(None, &needs),
    )?;
    let mut extra = vec!["e.session_id IS NOT NULL".to_owned()];

    if spec.favorites_only == Some(true) {
        let favourites = js::distinct(ctx.favorite_session_ids.iter().flatten().cloned());
        // No favourites: the list is empty, but still a scoped, bounded statement.
        extra.push(if favourites.is_empty() {
            "1 = 0".to_owned()
        } else {
            format!(
                "e.session_id IN {}",
                in_list(&favourites[..favourites.len().min(1000)])?
            )
        });
    }
    if let Some(ids) = spec.session_ids.as_ref().filter(|ids| !ids.is_empty()) {
        extra.push(format!("e.session_id IN {}", in_list(ids)?));
    }
    if let Some(distinct_id) = spec.distinct_id.as_deref().filter(|d| !d.is_empty()) {
        extra.push(format!("{} = {}", scope.person, lit(distinct_id)?));
    }
    if let Some(cohort_id) = spec.cohort_id.as_deref().filter(|c| !c.is_empty()) {
        let cohort = ctx
            .cohorts
            .as_ref()
            .and_then(|cohorts| cohorts.get(cohort_id))
            .ok_or_else(|| PanelQueryError::new("That cohort does not exist"))?;
        extra.push(format!(
            "({})",
            cohort_membership(cohort, ctx, range, &scope.person)?
        ));
    }
    if let Some(has_recording) = spec.has_recording {
        let mut conds = scope_conds(ctx, "")?;
        conds.extend(history_bounds(ctx, range, "ts_start"));
        let chunks = format!(
            "SELECT session_id FROM {} WHERE {}",
            replay_chunks_table(),
            conds.join(" AND ")
        );
        extra.push(format!(
            "e.session_id {} ({chunks})",
            if has_recording { "IN" } else { "NOT IN" }
        ));
    }

    let flags = refs
        .iter()
        .enumerate()
        .map(|(i, r)| {
            Ok(format!(
                "CASE WHEN {} THEN 1 ELSE 0 END AS ce{i}, ",
                event_match(r, ctx, range, &scope.person)?
            ))
        })
        .collect::<QueryResult<Vec<_>>>()?
        .concat();
    let inner = format!(
        "SELECT e.session_id AS session_id, e.ts AS ts, e.name AS name, e.path AS path, e.device_type AS device_type, e.browser AS browser, \
         e.os AS os, e.country AS country, e.user_id AS user_id, {} AS person, \
         json_get_str(e.properties, '$action') AS act, \
         {flags}\
         ROW_NUMBER() OVER (PARTITION BY e.session_id ORDER BY e.ts ASC, e.event_id ASC) AS rn_first, \
         ROW_NUMBER() OVER (PARTITION BY e.session_id ORDER BY e.ts DESC, e.event_id DESC) AS rn_last \
         FROM {} {}",
        scope.person,
        scope.from,
        scope.where_sql(&extra)
    );

    let having = having_conditions(spec, &refs)?;
    let having_sql = if having.is_empty() {
        String::new()
    } else {
        format!(" HAVING {}", having.join(" AND "))
    };
    let clicks = count(&format!("{} AND act = 'click'", named("$autocapture")?));
    let sql = format!(
        "SELECT session_id, MIN(ts) AS started, MAX(ts) AS ended, {DURATION} AS duration_seconds, \
         {} AS pageviews, \
         {clicks} AS clicks, COUNT(*) AS events, \
         {} AS rage, {} AS dead, {} AS quickback, \
         {} AS excessive, {} AS errors, \
         MAX(CASE WHEN rn_first = 1 THEN path END) AS entry_page, MAX(CASE WHEN rn_last = 1 THEN path END) AS exit_page, \
         MAX(device_type) AS device, MAX(browser) AS browser, MAX(os) AS os, MAX(country) AS country, MAX(person) AS person, MAX(user_id) AS user_id \
         FROM ({inner}) AS ev GROUP BY session_id\
         {having_sql} \
         ORDER BY {} LIMIT {}",
        count(&named("$pageview")?),
        count(&named("$rageclick")?),
        count(&named("$deadclick")?),
        count(&named("$quickback")?),
        count(&named("$excessivescroll")?),
        count(&named("$exception")?),
        order_by(spec)?,
        int(offset + spec.limit + 1, MAX_SESSIONS_REACH + 1)?
    );
    Ok(PanelSqlQuery::new("sessions.list", sql, &COLUMNS))
}

/// `chunkCountsQuery`: which of `session_ids` have recording chunks, and how many.
pub fn chunk_counts_query(
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    session_ids: &[String],
) -> QueryResult<PanelSqlQuery> {
    let mut conds = scope_conds(ctx, "")?;
    conds.push(format!("ts_start >= {}", ts(range.floor)));
    conds.push(format!("ts_start <= {}", ts(range.now)));
    conds.push(format!("session_id IN {}", in_list(session_ids)?));
    Ok(PanelSqlQuery::new(
        "sessions.chunks",
        format!(
            "SELECT session_id, COUNT(*) AS chunks FROM {} WHERE {} GROUP BY session_id",
            replay_chunks_table(),
            conds.join(" AND ")
        ),
        &["session_id", "chunks"],
    ))
}

fn device_of(value: Option<&serde_json::Value>) -> Option<DeviceClass> {
    match value.and_then(serde_json::Value::as_str) {
        Some("desktop") => Some(DeviceClass::Desktop),
        Some("mobile") => Some(DeviceClass::Mobile),
        Some("tablet") => Some(DeviceClass::Tablet),
        _ => None,
    }
}

/// `sessionRowFrom`. `None` where JavaScript throws (a timestamp that is no date).
pub fn session_row_from(row: &Row, chunks: f64) -> Option<PanelSessionRow> {
    Some(PanelSessionRow {
        session_id: to_text(row.get("session_id")),
        started_at: to_iso(row.get("started"))?,
        ended_at: to_iso(row.get("ended"))?,
        duration_seconds: js::math_round(to_number(row.get("duration_seconds"))).max(0.0),
        pageviews: to_number(row.get("pageviews")),
        clicks: to_number(row.get("clicks")),
        events: to_number(row.get("events")),
        rage_clicks: to_number(row.get("rage")),
        dead_clicks: to_number(row.get("dead")),
        quick_backs: to_number(row.get("quickback")),
        excessive_scrolls: to_number(row.get("excessive")),
        errors: to_number(row.get("errors")),
        entry_page: to_nullable_text(row.get("entry_page")),
        exit_page: to_nullable_text(row.get("exit_page")),
        device_type: device_of(row.get("device")),
        browser: to_nullable_text(row.get("browser")),
        os: to_nullable_text(row.get("os")),
        country: to_nullable_text(row.get("country")),
        distinct_id: to_text(row.get("person")),
        user_id: to_nullable_text(row.get("user_id")),
        has_recording: chunks > 0.0,
        chunk_count: chunks,
        favorite: false,
    })
}

/// `runSessions`.
pub async fn run_sessions<E: PanelSqlExecutor + ?Sized>(
    spec: &SessionsSpec,
    ctx: &PanelQueryContext,
    runner: &Runner<'_, E>,
) -> Result<PanelSessionsResult, PanelError> {
    let range = resolve_range(&spec.date_range, &spec.timezone, ctx)?;
    let offset = parse_sessions_cursor(cursor_of(spec))?;
    let rows = runner.run_one(sessions_query(spec, ctx, &range)?).await?;
    let start = usize::try_from(offset).unwrap_or(0).min(rows.len());
    let end = usize::try_from(offset + spec.limit)
        .unwrap_or(0)
        .clamp(start, rows.len());
    let page = &rows[start..end];
    let has_more = rows.len() as i64 > offset + spec.limit;

    let ids: Vec<String> = page
        .iter()
        .map(|r| to_text(r.get("session_id")))
        .filter(|id| !id.is_empty())
        .collect();
    let chunk_rows = if ids.is_empty() {
        Vec::new()
    } else {
        runner
            .run_one(chunk_counts_query(ctx, &range, &ids)?)
            .await?
    };
    let mut chunks: HashMap<String, f64> = HashMap::new();
    for row in &chunk_rows {
        chunks.insert(to_text(row.get("session_id")), to_number(row.get("chunks")));
    }

    let sessions = page
        .iter()
        .map(|r| {
            let count = chunks
                .get(&to_text(r.get("session_id")))
                .copied()
                .unwrap_or(0.0);
            session_row_from(r, count)
                .ok_or_else(|| PanelError::Engine("Invalid time value".into()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PanelSessionsResult {
        range: to_resolved_range(&range, None),
        sessions,
        has_more,
        next_cursor: has_more.then(|| format!("o{}", offset + spec.limit)),
    })
}
