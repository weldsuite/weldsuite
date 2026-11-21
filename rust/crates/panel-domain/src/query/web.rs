//! `web` (`web.ts`): the Overview. Visitors, visits, pageviews, bounce rate
//! and visit duration, a series, top pages, entry and exit pages, channels
//! and the usual dimensions, and conversion goals. One statement per list;
//! visits are derived from 30-minute gaps for cookieless visitors.

use std::collections::HashMap;

use super::context::PanelQueryContext;
use super::paths::cleaned_path;
use super::result_range::to_resolved_range;
use super::rows::{PanelError, PanelSqlExecutor, PanelSqlQuery, Row, Runner, to_number, to_text};
use super::scope::{
    EventsScope, ScopeOptions, ScopeUse, event_with_filters, events_scope, scope_needs,
};
use super::sql::{LIKE_ESCAPE, QueryResult, int, like_pattern, lit};
use super::time::{
    ResolvedRange, TimeBounds, bucket_label, bucket_labels, bucket_sql, previous_bounds,
    resolve_range,
};
use crate::js;
use crate::schemas::{
    Interval, PANEL_WEB_DEFAULT_PANELS, PanelBreakdownRow, PanelEntryExitRow, PanelTotals,
    PanelWebGoalResult, PanelWebPoint, PanelWebResult, WebPanel, WebSpec,
};

const SESSION_GAP_SECONDS: i64 = 1800;

fn pageview() -> QueryResult<String> {
    lit("$pageview")
}

/// `webInterval`: hours for short ranges, days for longer ones.
pub fn web_interval(range: &ResolvedRange) -> Interval {
    let days = (range.to - range.from) as f64 / 86_400_000.0;
    if days <= 2.0 {
        Interval::Hour
    } else {
        Interval::Day
    }
}

struct DimensionDef {
    key: WebPanel,
    expr: String,
    /// Rows without a value are left out (utm), or labelled.
    not_null: bool,
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

const SEARCH_HOSTS: [&str; 10] = [
    "google.",
    "bing.",
    "duckduckgo.",
    "yahoo.",
    "baidu.",
    "yandex.",
    "ecosia.",
    "search.brave.",
    "startpage.",
    "qwant.",
];
const SOCIAL_HOSTS: [&str; 15] = [
    "facebook.",
    "instagram.",
    "t.co",
    "twitter.",
    "x.com",
    "linkedin.",
    "lnkd.in",
    "reddit.",
    "pinterest.",
    "tiktok.",
    "threads.",
    "mastodon.",
    "bsky.",
    "news.ycombinator.",
    "quora.",
];
const VIDEO_HOSTS: [&str; 5] = ["youtube.", "youtu.be", "vimeo.", "twitch.", "dailymotion."];
const MAIL_HOSTS: [&str; 5] = [
    "mail.google.",
    "outlook.",
    "mail.yahoo.",
    "webmail.",
    "mail.",
];

const PAID_SEARCH_MEDIUMS: [&str; 6] = [
    "cpc",
    "ppc",
    "paidsearch",
    "paid-search",
    "paid_search",
    "sem",
];
const PAID_SOCIAL_MEDIUMS: [&str; 6] = [
    "paid-social",
    "paidsocial",
    "paid_social",
    "social-paid",
    "social_paid",
    "cpm-social",
];
const DISPLAY_MEDIUMS: [&str; 5] = ["display", "banner", "cpm", "expandable", "interstitial"];
const SOCIAL_MEDIUMS: [&str; 6] = [
    "social",
    "social-network",
    "social-media",
    "sm",
    "social network",
    "social media",
];

fn host_like(hosts: &[&str]) -> QueryResult<String> {
    // Each host is matched at the start or after a dot.
    let parts = hosts
        .iter()
        .map(|h| {
            let at_start = like_pattern(&format!("{h}*"))?;
            let after_dot = like_pattern(&format!("*.{h}*"))?;
            Ok(format!(
                "(e.referrer_host LIKE {at_start}{LIKE_ESCAPE} OR e.referrer_host LIKE {after_dot}{LIKE_ESCAPE})"
            ))
        })
        .collect::<QueryResult<Vec<_>>>()?;
    Ok(parts.join(" OR "))
}

fn in_values(column: &str, values: &[&str]) -> QueryResult<String> {
    let items = values
        .iter()
        .map(|v| lit(v))
        .collect::<QueryResult<Vec<_>>>()?;
    Ok(format!("{column} IN ({})", items.join(", ")))
}

/// `channelSql`: the channel of an event from its referrer host and
/// `utm_medium` (GA4's default channel grouping, simplified).
pub fn channel_sql() -> QueryResult<String> {
    let medium = "LOWER(COALESCE(e.utm_medium, ''))";
    let referrer = "e.referrer_host";
    let external = format!(
        "({referrer} IS NOT NULL AND {referrer} <> '' AND (e.host IS NULL OR {referrer} <> e.host))"
    );
    let whens: Vec<(String, &str)> = vec![
        (
            format!(
                "({} AND NOT ({}))",
                in_values(medium, &PAID_SEARCH_MEDIUMS)?,
                host_like(&SOCIAL_HOSTS)?
            ),
            "Paid Search",
        ),
        (
            format!(
                "({} OR ({} AND ({})))",
                in_values(medium, &PAID_SOCIAL_MEDIUMS)?,
                in_values(medium, &PAID_SEARCH_MEDIUMS)?,
                host_like(&SOCIAL_HOSTS)?
            ),
            "Paid Social",
        ),
        (in_values(medium, &DISPLAY_MEDIUMS)?, "Display"),
        (format!("{medium} = 'affiliate'"), "Affiliate"),
        (
            format!(
                "({} OR LOWER(COALESCE(e.utm_source, '')) IN ('email', 'newsletter'))",
                in_values(medium, &["email", "e-mail", "e_mail", "newsletter"])?
            ),
            "Email",
        ),
        (
            format!(
                "({medium} = 'video' OR ({external} AND ({})))",
                host_like(&VIDEO_HOSTS)?
            ),
            "Video",
        ),
        (
            format!(
                "({medium} = 'organic' OR ({external} AND ({})))",
                host_like(&SEARCH_HOSTS)?
            ),
            "Organic Search",
        ),
        (
            format!(
                "({} OR ({external} AND ({})))",
                in_values(medium, &SOCIAL_MEDIUMS)?,
                host_like(&SOCIAL_HOSTS)?
            ),
            "Organic Social",
        ),
        (
            format!("({external} AND ({}))", host_like(&MAIL_HOSTS)?),
            "Email",
        ),
        (
            format!(
                "(NOT {external} AND e.utm_source IS NULL AND e.utm_medium IS NULL AND e.utm_campaign IS NULL)"
            ),
            "Direct",
        ),
        (format!("({external} OR {medium} = 'referral')"), "Referral"),
    ];
    let cases = whens
        .iter()
        .map(|(cond, label)| Ok(format!("WHEN {cond} THEN {}", lit(label)?)))
        .collect::<QueryResult<Vec<_>>>()?;
    Ok(format!("CASE {} ELSE 'Other' END", cases.join(" ")))
}

/// `screenSizeSql`: the viewport width class (`PANEL_SCREEN_SIZES`).
pub fn screen_size_sql() -> QueryResult<String> {
    Ok(format!(
        "CASE WHEN e.viewport_w IS NULL OR e.viewport_w <= 0 THEN {} WHEN e.viewport_w < 768 THEN {} \
         WHEN e.viewport_w < 1024 THEN {} WHEN e.viewport_w < 1440 THEN {} \
         WHEN e.viewport_w < 1920 THEN {} ELSE {} END",
        lit("(unknown)")?,
        lit("mobile")?,
        lit("tablet")?,
        lit("laptop")?,
        lit("desktop")?,
        lit("wide")?
    ))
}

fn dimensions(ctx: &PanelQueryContext, spec: &WebSpec) -> QueryResult<Vec<DimensionDef>> {
    let def = |key, expr: &str, not_null| DimensionDef {
        key,
        expr: expr.to_owned(),
        not_null,
    };
    Ok(vec![
        def(
            WebPanel::TopPages,
            &cleaned_path(ctx, spec.clean_paths)?,
            false,
        ),
        def(
            WebPanel::Sources,
            "COALESCE(e.referrer_host, '(direct)')",
            false,
        ),
        def(WebPanel::UtmSources, "e.utm_source", true),
        def(WebPanel::UtmMediums, "e.utm_medium", true),
        def(WebPanel::UtmCampaigns, "e.utm_campaign", true),
        def(
            WebPanel::Countries,
            "COALESCE(e.country, '(unknown)')",
            false,
        ),
        def(
            WebPanel::Devices,
            "COALESCE(e.device_type, '(unknown)')",
            false,
        ),
        def(
            WebPanel::Browsers,
            "COALESCE(e.browser, '(unknown)')",
            false,
        ),
        def(
            WebPanel::OperatingSystems,
            "COALESCE(e.os, '(unknown)')",
            false,
        ),
        def(WebPanel::Hostnames, "COALESCE(e.host, '(unknown)')", false),
        def(
            WebPanel::Regions,
            "(COALESCE(e.country, '??') || ' / ' || e.region)",
            true,
        ),
        def(
            WebPanel::Cities,
            "(COALESCE(e.country, '??') || ' / ' || e.city)",
            true,
        ),
        def(WebPanel::Channels, &channel_sql()?, false),
        def(WebPanel::ScreenSizes, &screen_size_sql()?, false),
    ])
}

/// Events with their visit key: gaps over 30 minutes start a new visit.
fn visits_sql(scope: &EventsScope) -> QueryResult<String> {
    let partition = "COALESCE(session_id, anon_id)";
    let pv = pageview()?;
    Ok(format!(
        "WITH ev AS (SELECT {person} AS person, e.session_id AS session_id, e.anon_id AS anon_id, e.ts AS ts, e.name AS name, e.event_id AS event_id, \
         LAG(e.ts) OVER (PARTITION BY COALESCE(e.session_id, e.anon_id) ORDER BY e.ts, e.event_id) AS prev_ts \
         FROM {from} {where_}), \
         seg AS (SELECT person, session_id, anon_id, ts, name, \
         SUM(CASE WHEN prev_ts IS NULL OR to_unixtime(ts) - to_unixtime(prev_ts) > {SESSION_GAP_SECONDS} THEN 1 ELSE 0 END) \
         OVER (PARTITION BY {partition} ORDER BY ts, event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS seg_no FROM ev), \
         visit AS (SELECT {partition} AS visit_key, seg_no, MIN(person) AS person, MIN(ts) AS t0, MAX(ts) AS t1, \
         SUM(CASE WHEN name = {pv} THEN 1 ELSE 0 END) AS pageviews, \
         SUM(CASE WHEN name NOT IN ({pv}, '$pageleave') THEN 1 ELSE 0 END) AS actions \
         FROM seg GROUP BY {partition}, seg_no)",
        person = scope.person,
        from = scope.from,
        where_ = scope.where_base(),
    ))
}

const SUMMARY_COLUMNS: [&str; 5] = [
    "visitors",
    "visits",
    "pageviews",
    "bounces",
    "duration_seconds",
];

fn spec_scope(
    spec: &WebSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    bounds: TimeBounds,
) -> QueryResult<EventsScope> {
    events_scope(
        ctx,
        range,
        bounds,
        ScopeOptions {
            filters: Some(&spec.base.filters),
            ..ScopeOptions::default()
        },
    )
}

fn summary_query(
    name: &str,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    bounds: TimeBounds,
    spec: &WebSpec,
) -> QueryResult<PanelSqlQuery> {
    let scope = spec_scope(spec, ctx, range, bounds)?;
    let sql = format!(
        "{} SELECT COUNT(DISTINCT person) AS visitors, COUNT(*) AS visits, SUM(pageviews) AS pageviews, \
         SUM(CASE WHEN pageviews <= 1 AND actions = 0 THEN 1 ELSE 0 END) AS bounces, \
         SUM(to_unixtime(t1) - to_unixtime(t0)) AS duration_seconds FROM visit",
        visits_sql(&scope)?
    );
    Ok(PanelSqlQuery::new(name, sql, &SUMMARY_COLUMNS))
}

fn series_query(
    name: &str,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    bounds: TimeBounds,
    interval: Interval,
    spec: &WebSpec,
) -> QueryResult<PanelSqlQuery> {
    let scope = spec_scope(spec, ctx, range, bounds)?;
    let bucket = bucket_sql("e.ts", interval, range.offset_minutes);
    let pv_where = scope.where_sql(&[format!("e.name = {}", pageview()?)]);
    let sql = format!(
        "SELECT {bucket} AS bucket, COUNT(DISTINCT {}) AS visitors, COUNT(*) AS pageviews \
         FROM {} {pv_where} GROUP BY {bucket} ORDER BY {bucket} ASC",
        scope.person, scope.from
    );
    Ok(PanelSqlQuery::new(
        name,
        sql,
        &["bucket", "visitors", "pageviews"],
    ))
}

fn entry_exit_query(
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    spec: &WebSpec,
) -> QueryResult<PanelSqlQuery> {
    let scope = spec_scope(spec, ctx, range, range.bounds())?;
    let partition = "COALESCE(session_id, anon_id)";
    let pv_where = scope.where_sql(&[format!("e.name = {}", pageview()?)]);
    let sql = format!(
        "WITH pv AS (SELECT {path} AS path, e.session_id AS session_id, e.anon_id AS anon_id, e.ts AS ts, e.event_id AS event_id, \
         LAG(e.ts) OVER (PARTITION BY COALESCE(e.session_id, e.anon_id) ORDER BY e.ts, e.event_id) AS prev_ts \
         FROM {from} {pv_where}), \
         seg AS (SELECT path, session_id, anon_id, ts, event_id, \
         SUM(CASE WHEN prev_ts IS NULL OR to_unixtime(ts) - to_unixtime(prev_ts) > {SESSION_GAP_SECONDS} THEN 1 ELSE 0 END) \
         OVER (PARTITION BY {partition} ORDER BY ts, event_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS seg_no FROM pv), \
         ranked AS (SELECT path, \
         ROW_NUMBER() OVER (PARTITION BY {partition}, seg_no ORDER BY ts ASC, event_id ASC) AS rn_first, \
         ROW_NUMBER() OVER (PARTITION BY {partition}, seg_no ORDER BY ts DESC, event_id DESC) AS rn_last FROM seg) \
         SELECT path, SUM(CASE WHEN rn_first = 1 THEN 1 ELSE 0 END) AS entries, SUM(CASE WHEN rn_last = 1 THEN 1 ELSE 0 END) AS exits \
         FROM ranked GROUP BY path ORDER BY SUM(CASE WHEN rn_first = 1 THEN 1 ELSE 0 END) + SUM(CASE WHEN rn_last = 1 THEN 1 ELSE 0 END) DESC LIMIT {limit}",
        path = cleaned_path(ctx, spec.clean_paths)?,
        from = scope.from,
        limit = int(spec.limit * 2, 200)?,
    );
    Ok(PanelSqlQuery::new(
        "web.entryExit",
        sql,
        &["path", "entries", "exits"],
    ))
}

fn dimension_query(
    def: &DimensionDef,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    spec: &WebSpec,
) -> QueryResult<PanelSqlQuery> {
    let scope = spec_scope(spec, ctx, range, range.bounds())?;
    let mut extra = vec![format!("e.name = {}", pageview()?)];
    if def.not_null {
        extra.push(format!("{} IS NOT NULL", def.expr));
    }
    let sql = format!(
        "SELECT {expr} AS value, COUNT(DISTINCT {p}) AS visitors, COUNT(*) AS events \
         FROM {} {} GROUP BY {expr} ORDER BY COUNT(DISTINCT {p}) DESC, COUNT(*) DESC LIMIT {}",
        scope.from,
        scope.where_sql(&extra),
        int(spec.limit, 50)?,
        expr = def.expr,
        p = scope.person
    );
    Ok(PanelSqlQuery::new(
        format!("web.{}", def.key),
        sql,
        &["value", "visitors", "events"],
    ))
}

/// Every goal as a conditional count over one scan of the events that reach any goal.
fn goals_query(
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    spec: &WebSpec,
) -> QueryResult<Option<PanelSqlQuery>> {
    let goals = spec.goals.as_deref().unwrap_or_default();
    if goals.is_empty() {
        return Ok(None);
    }
    let filters: Vec<&[_]> = goals.iter().map(|g| g.filters.as_slice()).collect();
    let events: Vec<&str> = goals.iter().filter_map(|g| g.event.as_deref()).collect();
    let needs = scope_needs(
        ctx,
        &ScopeUse {
            filters: &filters,
            events: &events,
            ..ScopeUse::default()
        },
    )?;
    let scope = events_scope(
        ctx,
        range,
        range.bounds(),
        ScopeOptions::with_needs(Some(&spec.base.filters), &needs),
    )?;
    let conds = goals
        .iter()
        .map(|g| {
            let reach = match &g.event {
                Some(event) => event_with_filters(event, &g.filters, ctx, range, &scope.person)?,
                None => format!(
                    "{} AND e.path LIKE {}{LIKE_ESCAPE}",
                    event_with_filters("$pageview", &g.filters, ctx, range, &scope.person)?,
                    like_pattern(g.path_pattern.as_deref().unwrap_or("/"))?
                ),
            };
            Ok(format!("({reach})"))
        })
        .collect::<QueryResult<Vec<_>>>()?;
    let mut selects = Vec::new();
    let mut columns = Vec::new();
    for (i, cond) in conds.iter().enumerate() {
        selects.push(format!("COUNT(CASE WHEN {cond} THEN 1 END) AS g{i}_n"));
        selects.push(format!(
            "COUNT(DISTINCT CASE WHEN {cond} THEN {} END) AS g{i}_u",
            scope.person
        ));
        columns.push(format!("g{i}_n"));
        columns.push(format!("g{i}_u"));
    }
    let any_goal = format!("({})", conds.join(" OR "));
    let sql = format!(
        "SELECT {} FROM {} {}",
        selects.join(", "),
        scope.from,
        scope.where_sql(&[any_goal])
    );
    Ok(Some(PanelSqlQuery {
        name: "web.goals".to_owned(),
        sql,
        columns,
    }))
}

fn totals_from(rows: &[Row]) -> PanelTotals {
    let empty = Row::new();
    let row = rows.first().unwrap_or(&empty);
    let visits = to_number(row.get("visits"));
    PanelTotals {
        visitors: to_number(row.get("visitors")),
        visits,
        pageviews: to_number(row.get("pageviews")),
        bounce_rate: if visits > 0.0 {
            (to_number(row.get("bounces")) / visits).min(1.0)
        } else {
            0.0
        },
        avg_visit_duration_seconds: if visits > 0.0 {
            js::math_round(to_number(row.get("duration_seconds")) / visits)
        } else {
            0.0
        },
    }
}

fn series_from(
    rows: &[Row],
    bounds: TimeBounds,
    interval: Interval,
    offset: i64,
) -> Vec<PanelWebPoint> {
    let mut by_bucket: HashMap<String, &Row> = HashMap::new();
    for row in rows {
        by_bucket.insert(bucket_label(row.get("bucket"), interval), row);
    }
    bucket_labels(bounds, interval, offset)
        .into_iter()
        .map(|bucket| {
            let row = by_bucket.get(&bucket).copied();
            PanelWebPoint {
                visitors: to_number(row.and_then(|r| r.get("visitors"))),
                pageviews: to_number(row.and_then(|r| r.get("pageviews"))),
                bucket,
            }
        })
        .collect()
}

fn breakdown_from(rows: &[Row]) -> Vec<PanelBreakdownRow> {
    rows.iter()
        .map(|r| PanelBreakdownRow {
            value: to_text(r.get("value")),
            visitors: to_number(r.get("visitors")),
            events: to_number(r.get("events")),
        })
        .collect()
}

fn entry_exit_from(rows: &[Row], limit: i64) -> Vec<PanelEntryExitRow> {
    rows.iter()
        .take(usize::try_from(limit).unwrap_or(0))
        .map(|r| PanelEntryExitRow {
            value: to_text(r.get("path")),
            entries: to_number(r.get("entries")),
            exits: to_number(r.get("exits")),
        })
        .collect()
}

fn goals_from(spec: &WebSpec, rows: &[Row], visitors: f64) -> Vec<PanelWebGoalResult> {
    let empty = Row::new();
    let row = rows.first().unwrap_or(&empty);
    spec.goals
        .iter()
        .flatten()
        .enumerate()
        .map(|(i, goal)| {
            let unique = to_number(row.get(&format!("g{i}_u")));
            PanelWebGoalResult {
                label: goal.label.clone(),
                conversions: to_number(row.get(&format!("g{i}_n"))),
                unique_converters: unique,
                conversion_rate: if visitors > 0.0 {
                    (unique / visitors).min(1.0)
                } else {
                    0.0
                },
            }
        })
        .collect()
}

/// `runWeb`.
pub async fn run_web<E: PanelSqlExecutor + ?Sized>(
    spec: &WebSpec,
    ctx: &PanelQueryContext,
    runner: &Runner<'_, E>,
) -> Result<PanelWebResult, PanelError> {
    let range = resolve_range(&spec.base.date_range, &spec.base.timezone, ctx)?;
    let interval = web_interval(&range);
    let previous = spec
        .compare
        .then(|| previous_bounds(range.bounds(), range.floor));
    let panels: Vec<WebPanel> = spec
        .panels
        .clone()
        .unwrap_or_else(|| PANEL_WEB_DEFAULT_PANELS.to_vec());
    let defs: Vec<DimensionDef> = dimensions(ctx, spec)?
        .into_iter()
        .filter(|def| panels.contains(&def.key))
        .collect();

    let mut queries = vec![
        summary_query("web.summary", ctx, &range, range.bounds(), spec)?,
        series_query("web.series", ctx, &range, range.bounds(), interval, spec)?,
    ];
    if panels.contains(&WebPanel::EntryExitPages) {
        queries.push(entry_exit_query(ctx, &range, spec)?);
    }
    for def in &defs {
        queries.push(dimension_query(def, ctx, &range, spec)?);
    }
    if let Some(goals) = goals_query(ctx, &range, spec)? {
        queries.push(goals);
    }
    if let Some(previous) = previous {
        queries.push(summary_query(
            "web.summary.previous",
            ctx,
            &range,
            previous,
            spec,
        )?);
        queries.push(series_query(
            "web.series.previous",
            ctx,
            &range,
            previous,
            interval,
            spec,
        )?);
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
    let list = |key: WebPanel| breakdown_from(at(&format!("web.{key}")));
    let optional = |key: WebPanel| panels.contains(&key).then(|| list(key));

    let totals = totals_from(at("web.summary"));
    let visitors = totals.visitors;
    Ok(PanelWebResult {
        range: to_resolved_range(&range, previous),
        interval,
        previous_totals: previous.map(|_| totals_from(at("web.summary.previous"))),
        totals,
        series: series_from(
            at("web.series"),
            range.bounds(),
            interval,
            range.offset_minutes,
        ),
        previous_series: previous
            .map(|p| series_from(at("web.series.previous"), p, interval, range.offset_minutes)),
        entry_exit_pages: entry_exit_from(at("web.entryExit"), spec.limit),
        top_pages: list(WebPanel::TopPages),
        sources: list(WebPanel::Sources),
        utm_sources: list(WebPanel::UtmSources),
        utm_mediums: list(WebPanel::UtmMediums),
        utm_campaigns: list(WebPanel::UtmCampaigns),
        countries: list(WebPanel::Countries),
        devices: list(WebPanel::Devices),
        browsers: list(WebPanel::Browsers),
        operating_systems: list(WebPanel::OperatingSystems),
        hostnames: optional(WebPanel::Hostnames),
        regions: optional(WebPanel::Regions),
        cities: optional(WebPanel::Cities),
        channels: optional(WebPanel::Channels),
        screen_sizes: optional(WebPanel::ScreenSizes),
        goals: spec
            .goals
            .as_ref()
            .filter(|goals| !goals.is_empty())
            .map(|_| goals_from(spec, at("web.goals"), visitors)),
    })
}
