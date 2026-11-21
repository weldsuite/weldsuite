//! Result shapes per kind (`weldpanel-query.ts` "Results"). Fields are in the
//! order the TypeScript builds its objects; a `?` field of the TypeScript is
//! left out when absent, a `| null` field is written as `null`. Numbers are
//! JavaScript numbers (`f64`); [`crate::js::json_numbers`] writes the whole
//! ones as integers, as `JSON.stringify` does.

use serde::Serialize;

use super::query::{
    DeviceClass, FlowDirection, HeatmapType, Interval, RetentionInterval, RetentionMode,
    StickinessInterval, StickinessMeasure, VitalsMetric, VitalsPercentile, VitalsThresholds,
};

/// The concrete time range a query ran over (ISO 8601, UTC).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelResolvedRange {
    pub from: String,
    pub to: String,
    pub timezone: String,
    pub clamped_to_retention: bool,
    pub previous_from: Option<String>,
    pub previous_to: Option<String>,
}

// ---------------------------------------------------------------------------
// web
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelTotals {
    pub visitors: f64,
    pub visits: f64,
    pub pageviews: f64,
    pub bounce_rate: f64,
    pub avg_visit_duration_seconds: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelBreakdownRow {
    pub value: String,
    pub visitors: f64,
    pub events: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelEntryExitRow {
    pub value: String,
    pub entries: f64,
    pub exits: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelWebPoint {
    pub bucket: String,
    pub visitors: f64,
    pub pageviews: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelWebGoalResult {
    pub label: String,
    pub conversions: f64,
    pub unique_converters: f64,
    pub conversion_rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelWebResult {
    pub range: PanelResolvedRange,
    pub interval: Interval,
    pub totals: PanelTotals,
    pub previous_totals: Option<PanelTotals>,
    pub series: Vec<PanelWebPoint>,
    pub previous_series: Option<Vec<PanelWebPoint>>,
    pub entry_exit_pages: Vec<PanelEntryExitRow>,
    pub top_pages: Vec<PanelBreakdownRow>,
    pub sources: Vec<PanelBreakdownRow>,
    pub utm_sources: Vec<PanelBreakdownRow>,
    pub utm_mediums: Vec<PanelBreakdownRow>,
    pub utm_campaigns: Vec<PanelBreakdownRow>,
    pub countries: Vec<PanelBreakdownRow>,
    pub devices: Vec<PanelBreakdownRow>,
    pub browsers: Vec<PanelBreakdownRow>,
    pub operating_systems: Vec<PanelBreakdownRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostnames: Option<Vec<PanelBreakdownRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub regions: Option<Vec<PanelBreakdownRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cities: Option<Vec<PanelBreakdownRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<Vec<PanelBreakdownRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_sizes: Option<Vec<PanelBreakdownRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goals: Option<Vec<PanelWebGoalResult>>,
}

// ---------------------------------------------------------------------------
// trends
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelTrendPoint {
    pub bucket: String,
    pub value: f64,
}

/// A line's total and points (a series' `previous`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelTrendLine {
    pub total: f64,
    pub points: Vec<PanelTrendPoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelTrendSeriesResult {
    pub series_index: i64,
    pub label: String,
    pub breakdown_value: Option<String>,
    /// Present (maybe `null`) only when the spec has breakdowns.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub breakdown_parts: Option<Option<Vec<String>>>,
    pub total: f64,
    pub points: Vec<PanelTrendPoint>,
    pub previous: Option<PanelTrendLine>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelFormulaPoint {
    pub bucket: String,
    pub value: Option<f64>,
}

/// A formula's total and points (its `previous`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelFormulaLine {
    pub total: Option<f64>,
    pub points: Vec<PanelFormulaPoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelTrendFormulaResult {
    pub formula_index: i64,
    pub label: String,
    pub expression: String,
    pub breakdown_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub breakdown_parts: Option<Option<Vec<String>>>,
    pub total: Option<f64>,
    pub points: Vec<PanelFormulaPoint>,
    pub previous: Option<PanelFormulaLine>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelTrendsResult {
    pub range: PanelResolvedRange,
    pub interval: Interval,
    pub series: Vec<PanelTrendSeriesResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cumulative: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formulas: Option<Vec<PanelTrendFormulaResult>>,
}

// ---------------------------------------------------------------------------
// funnel
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelFunnelStepResult {
    pub index: i64,
    pub event: String,
    pub label: String,
    pub count: f64,
    pub conversion_from_previous: f64,
    pub conversion_from_first: f64,
    pub dropped_off: f64,
    pub avg_seconds_from_previous: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optional: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelTimeHistogramBucket {
    pub from_seconds: f64,
    pub to_seconds: Option<f64>,
    pub count: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelTimeToConvertStats {
    pub count: f64,
    pub median_seconds: Option<f64>,
    pub p90_seconds: Option<f64>,
    pub avg_seconds: Option<f64>,
    pub histogram: Vec<PanelTimeHistogramBucket>,
}

/// One step's time to convert: `{ index, ...stats }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelStepTimeToConvert {
    pub index: i64,
    #[serde(flatten)]
    pub stats: PanelTimeToConvertStats,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelFunnelTimeToConvert {
    pub overall: PanelTimeToConvertStats,
    pub steps: Vec<PanelStepTimeToConvert>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelFunnelTrendPoint {
    pub bucket: String,
    pub entered: f64,
    pub converted: f64,
    pub conversion: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelFunnelBreakdown {
    pub value: String,
    pub parts: Option<Vec<String>>,
    pub steps: Vec<PanelFunnelStepResult>,
    pub overall_conversion: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelFunnelResult {
    pub range: PanelResolvedRange,
    pub steps: Vec<PanelFunnelStepResult>,
    pub overall_conversion: f64,
    pub breakdowns: Option<Vec<PanelFunnelBreakdown>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_to_convert: Option<PanelFunnelTimeToConvert>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trend: Option<Vec<PanelFunnelTrendPoint>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<Interval>,
}

// ---------------------------------------------------------------------------
// funnel_correlation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CorrelationType {
    Event,
    Property,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CorrelationDirection {
    Positive,
    Negative,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelCorrelationRow {
    #[serde(rename = "type")]
    pub row_type: CorrelationType,
    pub property: Option<String>,
    pub value: String,
    pub success_count: f64,
    pub failure_count: f64,
    pub success_rate_with: f64,
    pub success_rate_without: f64,
    pub odds_ratio: f64,
    pub correlation: CorrelationDirection,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelFunnelCorrelationResult {
    pub range: PanelResolvedRange,
    pub converted: f64,
    pub dropped: f64,
    pub events: Vec<PanelCorrelationRow>,
    pub properties: Vec<PanelCorrelationRow>,
}

// ---------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelRetentionCohort {
    pub cohort: String,
    pub size: f64,
    pub counts: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelRetentionBreakdown {
    pub value: String,
    pub cohorts: Vec<PanelRetentionCohort>,
    pub average_retention: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelRetentionResult {
    pub range: PanelResolvedRange,
    pub interval: RetentionInterval,
    pub periods: i64,
    pub cohorts: Vec<PanelRetentionCohort>,
    pub average_retention: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<RetentionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unbounded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub breakdowns: Option<Vec<PanelRetentionBreakdown>>,
}

// ---------------------------------------------------------------------------
// stickiness, lifecycle
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelStickinessBucket {
    pub label: String,
    pub from: f64,
    pub to: Option<f64>,
    pub count: f64,
    pub share: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelStickinessResult {
    pub range: PanelResolvedRange,
    pub interval: StickinessInterval,
    pub measure: StickinessMeasure,
    pub total: f64,
    pub intervals_in_range: i64,
    pub buckets: Vec<PanelStickinessBucket>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelLifecycleBucket {
    pub bucket: String,
    pub new: f64,
    pub returning: f64,
    pub resurrecting: f64,
    pub dormant: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelLifecycleTotals {
    pub new: f64,
    pub returning: f64,
    pub resurrecting: f64,
    pub dormant: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelLifecycleResult {
    pub range: PanelResolvedRange,
    pub interval: RetentionInterval,
    pub buckets: Vec<PanelLifecycleBucket>,
    pub totals: PanelLifecycleTotals,
}

// ---------------------------------------------------------------------------
// vitals
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PanelVitalsRating {
    Good,
    NeedsImprovement,
    Poor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PanelVitalsUnit {
    Ms,
    Unitless,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelVitalsRow {
    pub value: String,
    pub metric: Option<f64>,
    pub samples: f64,
    pub rating: Option<PanelVitalsRating>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelVitalsShares {
    pub good: f64,
    pub needs_improvement: f64,
    pub poor: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelVitalsPoint {
    pub bucket: String,
    pub value: Option<f64>,
    pub samples: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelVitalsResult {
    pub range: PanelResolvedRange,
    pub interval: Interval,
    pub metric: VitalsMetric,
    pub percentile: VitalsPercentile,
    pub unit: PanelVitalsUnit,
    pub thresholds: VitalsThresholds,
    pub value: Option<f64>,
    pub rating: Option<PanelVitalsRating>,
    pub samples: f64,
    pub shares: PanelVitalsShares,
    pub score: Option<f64>,
    pub series: Vec<PanelVitalsPoint>,
    pub paths: Vec<PanelVitalsRow>,
    pub elements: Vec<PanelVitalsRow>,
    pub countries: Vec<PanelVitalsRow>,
    pub devices: Vec<PanelVitalsRow>,
}

// ---------------------------------------------------------------------------
// impact, signal
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelImpactGroup {
    pub users: f64,
    pub before: Option<f64>,
    pub after: Option<f64>,
    pub change: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelAdoptionPoint {
    pub bucket: String,
    pub new_adopters: f64,
    pub adopters: f64,
    pub rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelImpactResult {
    pub range: PanelResolvedRange,
    pub launch_date: String,
    pub window_days: i64,
    pub adoption: Vec<PanelAdoptionPoint>,
    pub adopters: PanelImpactGroup,
    pub non_adopters: PanelImpactGroup,
    pub difference_in_differences: Option<f64>,
    pub relative_impact: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelSignalCandidate {
    pub event: String,
    pub did_users: f64,
    pub did_goal_rate: f64,
    pub did_not_users: f64,
    pub did_not_goal_rate: f64,
    pub lift: Option<f64>,
    pub correlation: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelSignalResult {
    pub range: PanelResolvedRange,
    pub goal: String,
    pub window_days: i64,
    pub users: f64,
    pub goal_users: f64,
    pub goal_rate: f64,
    pub candidates: Vec<PanelSignalCandidate>,
}

// ---------------------------------------------------------------------------
// flows, sessions, heatmap
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelFlowPath {
    pub steps: Vec<Option<String>>,
    pub count: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelFlowsResult {
    pub range: PanelResolvedRange,
    pub anchor: String,
    pub direction: FlowDirection,
    pub depth: i64,
    pub anchor_count: f64,
    pub paths: Vec<PanelFlowPath>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelSessionRow {
    pub session_id: String,
    pub started_at: String,
    pub ended_at: String,
    pub duration_seconds: f64,
    pub pageviews: f64,
    pub clicks: f64,
    pub events: f64,
    pub rage_clicks: f64,
    pub dead_clicks: f64,
    pub quick_backs: f64,
    pub excessive_scrolls: f64,
    pub errors: f64,
    pub entry_page: Option<String>,
    pub exit_page: Option<String>,
    pub device_type: Option<DeviceClass>,
    pub browser: Option<String>,
    pub os: Option<String>,
    pub country: Option<String>,
    pub distinct_id: String,
    pub user_id: Option<String>,
    pub has_recording: bool,
    pub chunk_count: f64,
    pub favorite: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelSessionsResult {
    pub range: PanelResolvedRange,
    pub sessions: Vec<PanelSessionRow>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelHeatmapElement {
    pub selector: String,
    pub text: Option<String>,
    pub clicks: f64,
    pub share: f64,
    pub rel_x: f64,
    pub rel_y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelHeatmapPoint {
    pub selector: String,
    pub rel_x: f64,
    pub rel_y: f64,
    pub count: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelScrollBucket {
    pub depth: f64,
    pub reached_share: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanelHeatmapScroll {
    pub leaves: f64,
    pub buckets: Vec<PanelScrollBucket>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelHeatmapResult {
    pub range: PanelResolvedRange,
    #[serde(rename = "type")]
    pub heatmap_type: HeatmapType,
    pub device_class: DeviceClass,
    pub url_pattern: String,
    pub pageviews: f64,
    pub clicks: f64,
    pub elements: Vec<PanelHeatmapElement>,
    pub points: Vec<PanelHeatmapPoint>,
    pub scroll: PanelHeatmapScroll,
}

// ---------------------------------------------------------------------------
// Any kind
// ---------------------------------------------------------------------------

/// `PanelQueryResult`: `{ kind, result }`. One per request, so the variants
/// are not boxed.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", content = "result", rename_all = "snake_case")]
pub enum PanelQueryResult {
    Web(PanelWebResult),
    Trends(PanelTrendsResult),
    Funnel(PanelFunnelResult),
    Retention(PanelRetentionResult),
    Flows(PanelFlowsResult),
    Sessions(PanelSessionsResult),
    Heatmap(PanelHeatmapResult),
    FunnelCorrelation(PanelFunnelCorrelationResult),
    Stickiness(PanelStickinessResult),
    Lifecycle(PanelLifecycleResult),
    Vitals(PanelVitalsResult),
    Impact(PanelImpactResult),
    Signal(PanelSignalResult),
}

impl PanelQueryResult {
    /// The result as JSON, whole numbers as integers (what `JSON.stringify`
    /// writes for the TypeScript's result).
    pub fn to_json(&self) -> serde_json::Value {
        crate::js::json_numbers(serde_json::to_value(self).unwrap_or(serde_json::Value::Null))
    }
}
