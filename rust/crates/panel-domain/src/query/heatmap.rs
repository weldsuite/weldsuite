//! `heatmap` (`heatmap.ts`): clicks per element and position (from
//! `$autocapture` clicks) and scroll depth (from `$pageleave`), for a page
//! group (a URL pattern) at one device class.

use super::context::PanelQueryContext;
use super::result_range::to_resolved_range;
use super::rows::{
    PanelError, PanelSqlExecutor, PanelSqlQuery, Runner, to_nullable_text, to_number, to_text,
};
use super::scope::{ScopeOptions, events_scope};
use super::sql::{LIKE_ESCAPE, PanelQueryError, QueryResult, int, like_pattern, lit};
use super::time::{ResolvedRange, resolve_range};
use crate::device_class::{MOBILE_MAX_WIDTH, TABLET_MAX_WIDTH};
use crate::schemas::{
    DeviceClass, HeatmapSpec, HeatmapType, PanelHeatmapElement, PanelHeatmapPoint,
    PanelHeatmapResult, PanelHeatmapScroll, PanelScrollBucket,
};

const MAX_ELEMENTS: i64 = 200;
const MAX_POINTS: i64 = 2000;
/// Scroll depth is grouped in tenths.
const SCROLL_STEP: i64 = 10;

/// `resolveUrlPattern`: the saved page group's pattern, or the ad-hoc one.
pub fn resolve_url_pattern(spec: &HeatmapSpec, ctx: &PanelQueryContext) -> QueryResult<String> {
    if let Some(group) = spec.page_group_id.as_deref().filter(|g| !g.is_empty()) {
        return ctx
            .page_groups
            .as_ref()
            .and_then(|groups| groups.get(group))
            .filter(|pattern| !pattern.is_empty())
            .cloned()
            .ok_or_else(|| PanelQueryError::new("That page group does not exist"));
    }
    spec.url_pattern
        .clone()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| PanelQueryError::new("Choose a page group or a URL pattern"))
}

fn device_condition(device_class: DeviceClass) -> String {
    match device_class {
        DeviceClass::Mobile => format!("e.viewport_w < {MOBILE_MAX_WIDTH}"),
        DeviceClass::Tablet => {
            format!("(e.viewport_w >= {MOBILE_MAX_WIDTH} AND e.viewport_w < {TABLET_MAX_WIDTH})")
        }
        // An unknown width counts as desktop.
        DeviceClass::Desktop => {
            format!("(e.viewport_w IS NULL OR e.viewport_w >= {TABLET_MAX_WIDTH})")
        }
    }
}

/// `heatmapQueries`.
pub fn heatmap_queries(
    spec: &HeatmapSpec,
    ctx: &PanelQueryContext,
    range: &ResolvedRange,
    pattern: &str,
) -> QueryResult<Vec<PanelSqlQuery>> {
    let scope = events_scope(ctx, range, range.bounds(), ScopeOptions::default())?;
    let page = format!("e.path LIKE {}{LIKE_ESCAPE}", like_pattern(pattern)?);
    let device = device_condition(spec.device_class);
    let click = vec![
        format!("e.name = {}", lit("$autocapture")?),
        "json_get_str(e.properties, '$action') = 'click'".to_owned(),
        "e.el_selector IS NOT NULL".to_owned(),
        page.clone(),
        device.clone(),
    ];

    let pageview_where = scope.where_sql(&[
        format!("e.name = {}", lit("$pageview")?),
        page.clone(),
        device.clone(),
    ]);
    let pageviews = PanelSqlQuery::new(
        "heatmap.pageviews",
        format!(
            "SELECT COUNT(*) AS pageviews FROM {} {pageview_where}",
            scope.from
        ),
        &["pageviews"],
    );

    match spec.heatmap_type {
        HeatmapType::Scroll => {
            let bucket = format!("FLOOR(e.scroll_depth / {SCROLL_STEP}.0) * {SCROLL_STEP}");
            let leave_where = scope.where_sql(&[
                format!("e.name = {}", lit("$pageleave")?),
                "e.scroll_depth IS NOT NULL".to_owned(),
                page,
                device,
            ]);
            Ok(vec![
                pageviews,
                PanelSqlQuery::new(
                    "heatmap.scroll",
                    format!(
                        "SELECT {bucket} AS depth, COUNT(*) AS leaves FROM {} \
                         {leave_where} GROUP BY {bucket} ORDER BY {bucket} ASC",
                        scope.from
                    ),
                    &["depth", "leaves"],
                ),
            ])
        }
        HeatmapType::Area => Ok(vec![
            pageviews,
            PanelSqlQuery::new(
                "heatmap.elements",
                format!(
                    "SELECT e.el_selector AS selector, MAX(e.el_text) AS text, COUNT(*) AS clicks, AVG(e.rel_x) AS rel_x, AVG(e.rel_y) AS rel_y \
                     FROM {} {} GROUP BY e.el_selector ORDER BY COUNT(*) DESC LIMIT {}",
                    scope.from,
                    scope.where_sql(&click),
                    int(MAX_ELEMENTS, MAX_ELEMENTS)?
                ),
                &["selector", "text", "clicks", "rel_x", "rel_y"],
            ),
        ]),
        HeatmapType::Click => {
            let grid_x = "ROUND(e.rel_x * 10) / 10.0";
            let grid_y = "ROUND(e.rel_y * 10) / 10.0";
            let mut point_where = click;
            point_where.push("e.rel_x IS NOT NULL".to_owned());
            point_where.push("e.rel_y IS NOT NULL".to_owned());
            Ok(vec![
                pageviews,
                PanelSqlQuery::new(
                    "heatmap.points",
                    format!(
                        "SELECT e.el_selector AS selector, {grid_x} AS rel_x, {grid_y} AS rel_y, COUNT(*) AS clicks \
                         FROM {} {} \
                         GROUP BY e.el_selector, {grid_x}, {grid_y} ORDER BY COUNT(*) DESC LIMIT {}",
                        scope.from,
                        scope.where_sql(&point_where),
                        int(MAX_POINTS, MAX_POINTS)?
                    ),
                    &["selector", "rel_x", "rel_y", "clicks"],
                ),
            ])
        }
    }
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

/// `runHeatmap`.
pub async fn run_heatmap<E: PanelSqlExecutor + ?Sized>(
    spec: &HeatmapSpec,
    ctx: &PanelQueryContext,
    runner: &Runner<'_, E>,
) -> Result<PanelHeatmapResult, PanelError> {
    let range = resolve_range(&spec.date_range, &spec.timezone, ctx)?;
    let pattern = resolve_url_pattern(spec, ctx)?;
    let queries = heatmap_queries(spec, ctx, &range, &pattern)?;
    let mut results = runner.run(&queries).await?.into_iter();
    let pageview_rows = results.next().unwrap_or_default();
    let data_rows = results.next().unwrap_or_default();
    let pageviews = to_number(pageview_rows.first().and_then(|r| r.get("pageviews")));

    let mut elements = Vec::new();
    let mut points = Vec::new();
    let mut clicks = 0.0;
    let mut scroll = PanelHeatmapScroll {
        leaves: 0.0,
        buckets: Vec::new(),
    };

    match spec.heatmap_type {
        HeatmapType::Area => {
            clicks = data_rows
                .iter()
                .fold(0.0, |sum, r| sum + to_number(r.get("clicks")));
            elements = data_rows
                .iter()
                .map(|r| PanelHeatmapElement {
                    selector: to_text(r.get("selector")),
                    text: to_nullable_text(r.get("text")),
                    clicks: to_number(r.get("clicks")),
                    share: if clicks > 0.0 {
                        to_number(r.get("clicks")) / clicks
                    } else {
                        0.0
                    },
                    rel_x: clamp01(to_number(r.get("rel_x"))),
                    rel_y: clamp01(to_number(r.get("rel_y"))),
                })
                .collect();
        }
        HeatmapType::Click => {
            points = data_rows
                .iter()
                .map(|r| PanelHeatmapPoint {
                    selector: to_text(r.get("selector")),
                    rel_x: clamp01(to_number(r.get("rel_x"))),
                    rel_y: clamp01(to_number(r.get("rel_y"))),
                    count: to_number(r.get("clicks")),
                })
                .collect::<Vec<_>>();
            clicks = points.iter().fold(0.0, |sum, p| sum + p.count);
        }
        HeatmapType::Scroll => {
            let leaves = data_rows
                .iter()
                .fold(0.0, |sum, r| sum + to_number(r.get("leaves")));
            // `Map<depth, leaves>` in insertion order (a later row for the same depth wins).
            let mut by_depth: Vec<(f64, f64)> = Vec::new();
            for row in &data_rows {
                let depth = to_number(row.get("depth")) + 0.0;
                let count = to_number(row.get("leaves"));
                match by_depth.iter_mut().find(|(d, _)| *d == depth) {
                    Some((_, value)) => *value = count,
                    None => by_depth.push((depth, count)),
                }
            }
            // Share of leaves that scrolled at least `depth` percent.
            let mut buckets = Vec::new();
            let mut depth = 0;
            while depth <= 100 {
                let reached = by_depth
                    .iter()
                    .filter(|(d, _)| *d >= f64::from(depth))
                    .fold(0.0, |sum, (_, count)| sum + count);
                buckets.push(PanelScrollBucket {
                    depth: f64::from(depth),
                    reached_share: if leaves > 0.0 { reached / leaves } else { 0.0 },
                });
                depth += SCROLL_STEP as i32;
            }
            scroll = PanelHeatmapScroll { leaves, buckets };
        }
    }

    Ok(PanelHeatmapResult {
        range: to_resolved_range(&range, None),
        heatmap_type: spec.heatmap_type,
        device_class: spec.device_class,
        url_pattern: pattern,
        pageviews,
        clicks,
        elements,
        points,
        scroll,
    })
}
