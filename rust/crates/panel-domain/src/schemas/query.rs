//! Query specs (`weldpanel-query.ts`): the typed spec a client posts to
//! `POST /api/panel/query`, parsed (defaults filled in).

use serde::{Deserialize, Serialize};

use super::defaults;

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $($(#[$vmeta])* #[serde(rename = $text)] $variant),+
        }

        impl $name {
            /// The value as the spec writes it.
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

string_enum!(
    /// `PANEL_DATE_PRESETS`.
    DatePreset { Today = "today", Days7 = "7d", Days30 = "30d", Days90 = "90d", Months12 = "12m" }
);

/// A preset, or custom `from` / `to` days (YYYY-MM-DD, both inclusive, in
/// the spec's timezone).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DateRange {
    Preset { preset: DatePreset },
    Custom { from: String, to: String },
}

impl Default for DateRange {
    fn default() -> Self {
        Self::Preset {
            preset: DatePreset::Days30,
        }
    }
}

string_enum!(
    /// `PANEL_INTERVALS`.
    #[derive(Default)]
    Interval { Hour = "hour", #[default] Day = "day", Week = "week", Month = "month" }
);

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

string_enum!(
    /// `PANEL_FILTER_OPERATORS`.
    FilterOperator {
        Eq = "eq",
        Neq = "neq",
        Contains = "contains",
        NotContains = "not_contains",
        Gt = "gt",
        Lt = "lt",
        IsSet = "is_set",
        IsNotSet = "is_not_set",
        In = "in",
    }
);

string_enum!(
    /// `PANEL_FILTER_COLUMNS`: the standard `events_v1` columns a filter or
    /// breakdown may use.
    FilterColumn {
        Path = "path",
        Url = "url",
        Host = "host",
        Title = "title",
        Referrer = "referrer",
        ReferrerHost = "referrer_host",
        UtmSource = "utm_source",
        UtmMedium = "utm_medium",
        UtmCampaign = "utm_campaign",
        UtmContent = "utm_content",
        UtmTerm = "utm_term",
        Country = "country",
        Region = "region",
        City = "city",
        DeviceType = "device_type",
        Browser = "browser",
        Os = "os",
        ElSelector = "el_selector",
        ElText = "el_text",
    }
);

/// One item of an `in` list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterListItem {
    Text(String),
    Number(f64),
}

/// A filter's value: text, a number, a boolean, or a list for `in`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterValue {
    Text(String),
    Number(f64),
    Bool(bool),
    List(Vec<FilterListItem>),
}

/// `panelFilterSchema`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "source",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PanelFilter {
    /// A standard column of the event.
    Column {
        field: FilterColumn,
        operator: FilterOperator,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<FilterValue>,
    },
    /// A custom property of the event, or a computed property (`@pncp_…`).
    Event {
        key: String,
        operator: FilterOperator,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<FilterValue>,
    },
    /// A property of the person, from their latest profile.
    Person {
        key: String,
        operator: FilterOperator,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<FilterValue>,
    },
    /// Membership of a saved cohort.
    Cohort {
        cohort_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        negate: Option<bool>,
    },
    /// A property of the event's group, from the group's latest profile.
    Group {
        group_type: String,
        key: String,
        operator: FilterOperator,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<FilterValue>,
    },
    /// The event's group key itself (`$group_<type>`).
    GroupKey {
        group_type: String,
        operator: FilterOperator,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<FilterValue>,
    },
}

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

/// Numeric bucketing of a breakdown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BreakdownBucket {
    /// `count` (default 5) equal parts of the range of values seen.
    Auto {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        count: Option<i64>,
    },
    /// Cut at the given edges, low to high.
    Custom { edges: Vec<f64> },
}

/// `panelBreakdownSchema`: one property, top N values (the rest `Other`), or
/// numeric buckets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "source",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PanelBreakdown {
    Column {
        field: FilterColumn,
        #[serde(default = "defaults::ten")]
        limit: i64,
    },
    Event {
        key: String,
        #[serde(default = "defaults::ten")]
        limit: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bucket: Option<BreakdownBucket>,
    },
    Person {
        key: String,
        #[serde(default = "defaults::ten")]
        limit: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bucket: Option<BreakdownBucket>,
    },
    Group {
        group_type: String,
        key: String,
        #[serde(default = "defaults::ten")]
        limit: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bucket: Option<BreakdownBucket>,
    },
}

impl PanelBreakdown {
    /// `breakdown.limit`.
    pub fn limit(&self) -> i64 {
        match self {
            Self::Column { limit, .. }
            | Self::Event { limit, .. }
            | Self::Person { limit, .. }
            | Self::Group { limit, .. } => *limit,
        }
    }

    /// The numeric bucketing (never on a column).
    pub fn bucket(&self) -> Option<&BreakdownBucket> {
        match self {
            Self::Column { .. } => None,
            Self::Event { bucket, .. }
            | Self::Person { bucket, .. }
            | Self::Group { bucket, .. } => bucket.as_ref(),
        }
    }

    /// The property key (none for a column).
    pub fn key(&self) -> Option<&str> {
        match self {
            Self::Column { .. } => None,
            Self::Event { key, .. } | Self::Person { key, .. } | Self::Group { key, .. } => {
                Some(key)
            }
        }
    }

    /// `event`, `person`, `group` or `column`.
    pub fn source(&self) -> &'static str {
        match self {
            Self::Column { .. } => "column",
            Self::Event { .. } => "event",
            Self::Person { .. } => "person",
            Self::Group { .. } => "group",
        }
    }

    /// The same breakdown without numeric buckets.
    #[must_use]
    pub fn without_bucket(&self) -> Self {
        let mut out = self.clone();
        match &mut out {
            Self::Column { .. } => {}
            Self::Event { bucket, .. }
            | Self::Person { bucket, .. }
            | Self::Group { bucket, .. } => {
                *bucket = None;
            }
        }
        out
    }
}

/// At most this many breakdowns at once.
pub const PANEL_MAX_BREAKDOWNS: usize = 3;
/// What joins the values of several breakdowns.
pub const PANEL_BREAKDOWN_JOINER: &str = " / ";

/// `specBreakdowns`: `breakdowns`, else `[breakdown]`, else none.
pub fn spec_breakdowns<'a>(
    breakdown: Option<&'a PanelBreakdown>,
    breakdowns: Option<&'a Vec<PanelBreakdown>>,
) -> Vec<&'a PanelBreakdown> {
    if let Some(list) = breakdowns.filter(|list| !list.is_empty()) {
        return list.iter().collect();
    }
    breakdown.into_iter().collect()
}

/// The literal `"person"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PersonLiteral {
    #[serde(rename = "person")]
    Person,
}

/// Who a measure counts: people, or groups of one type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AggregateBy {
    Person(PersonLiteral),
    Group {
        #[serde(rename = "groupType")]
        group_type: String,
    },
}

/// `aggregateGroupType`: the group type an `aggregateBy` names; `None` for people.
pub fn aggregate_group_type(aggregate_by: Option<&AggregateBy>) -> Option<&str> {
    match aggregate_by {
        Some(AggregateBy::Group { group_type }) => Some(group_type),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

/// `projectId`, `dateRange`, `timezone`, `filters`: what every report kind takes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecBase {
    pub project_id: String,
    #[serde(default)]
    pub date_range: DateRange,
    #[serde(default = "defaults::utc")]
    pub timezone: String,
    #[serde(default)]
    pub filters: Vec<PanelFilter>,
}

string_enum!(
    /// `PANEL_WEB_PANELS`.
    WebPanel {
        TopPages = "topPages",
        EntryExitPages = "entryExitPages",
        Sources = "sources",
        Channels = "channels",
        UtmSources = "utmSources",
        UtmMediums = "utmMediums",
        UtmCampaigns = "utmCampaigns",
        Countries = "countries",
        Regions = "regions",
        Cities = "cities",
        Devices = "devices",
        Browsers = "browsers",
        OperatingSystems = "operatingSystems",
        Hostnames = "hostnames",
        ScreenSizes = "screenSizes",
    }
);

/// What an overview without `panels` computes.
pub const PANEL_WEB_DEFAULT_PANELS: [WebPanel; 11] = [
    WebPanel::TopPages,
    WebPanel::EntryExitPages,
    WebPanel::Sources,
    WebPanel::Channels,
    WebPanel::UtmSources,
    WebPanel::UtmMediums,
    WebPanel::UtmCampaigns,
    WebPanel::Countries,
    WebPanel::Devices,
    WebPanel::Browsers,
    WebPanel::OperatingSystems,
];

/// A conversion goal of the web overview.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebGoal {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_pattern: Option<String>,
    #[serde(default)]
    pub filters: Vec<PanelFilter>,
}

/// `web`: the overview.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSpec {
    #[serde(flatten)]
    pub base: SpecBase,
    #[serde(default)]
    pub compare: bool,
    #[serde(default = "defaults::ten")]
    pub limit: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panels: Option<Vec<WebPanel>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goals: Option<Vec<WebGoal>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean_paths: Option<bool>,
}

string_enum!(
    /// `PANEL_TREND_MATHS`.
    #[derive(Default)]
    TrendMath {
        #[default] Total = "total",
        UniqueUsers = "unique_users",
        UniqueGroups = "unique_groups",
        Sessions = "sessions",
        AvgPerUser = "avg_per_user",
        Sum = "sum",
        Avg = "avg",
        Min = "min",
        Max = "max",
    }
);

/// One series of a trends report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendSeries {
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default)]
    pub math: TrendMath,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub property: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_type: Option<String>,
    #[serde(default)]
    pub filters: Vec<PanelFilter>,
}

/// A formula over the series (`A / B * 100`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrendFormula {
    pub expression: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

string_enum!(
    /// `PANEL_TRENDS_DISPLAYS`.
    TrendsDisplay {
        Line = "line",
        Bar = "bar",
        Table = "table",
        Number = "number",
        Area = "area",
        Pie = "pie",
        Cumulative = "cumulative",
    }
);

/// `trends`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendsSpec {
    #[serde(flatten)]
    pub base: SpecBase,
    pub series: Vec<TrendSeries>,
    #[serde(default)]
    pub interval: Interval,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub breakdown: Option<PanelBreakdown>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub breakdowns: Option<Vec<PanelBreakdown>>,
    #[serde(default)]
    pub compare: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<TrendsDisplay>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formulas: Option<Vec<TrendFormula>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub formula_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean_paths: Option<bool>,
}

/// One funnel step (also the anchor of flows).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunnelStep {
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default)]
    pub filters: Vec<PanelFilter>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optional: Option<bool>,
}

string_enum!(
    /// `PANEL_WINDOW_UNITS`.
    WindowUnit { Minute = "minute", Hour = "hour", Day = "day" }
);

/// Time allowed from the first step to the last.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FunnelWindow {
    pub value: i64,
    pub unit: WindowUnit,
}

impl Default for FunnelWindow {
    fn default() -> Self {
        Self {
            value: 7,
            unit: WindowUnit::Day,
        }
    }
}

string_enum!(
    /// `PANEL_FUNNEL_ORDERS`.
    #[derive(Default)]
    FunnelOrder { #[default] Loose = "loose", Strict = "strict", Any = "any" }
);

/// People who do `event` between two steps are left out of the funnel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunnelExclusion {
    pub event: String,
    #[serde(default)]
    pub filters: Vec<PanelFilter>,
    pub from_step: i64,
    pub to_step: i64,
}

string_enum!(
    /// `PANEL_FUNNEL_DISPLAYS`.
    FunnelDisplay { Steps = "steps", Trends = "trends", TimeToConvert = "time_to_convert" }
);

/// `funnel` (and the fields `funnel_correlation` shares).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunnelSpec {
    #[serde(flatten)]
    pub base: SpecBase,
    pub steps: Vec<FunnelStep>,
    #[serde(default)]
    pub window: FunnelWindow,
    #[serde(default)]
    pub order: FunnelOrder,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub breakdown: Option<PanelBreakdown>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub breakdowns: Option<Vec<PanelBreakdown>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclusions: Option<Vec<FunnelExclusion>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold_constant: Option<PanelBreakdown>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregate_by: Option<AggregateBy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<FunnelDisplay>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<Interval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean_paths: Option<bool>,
}

/// `funnel_correlation`: a funnel and how many rows per list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FunnelCorrelationSpec {
    #[serde(flatten)]
    pub funnel: FunnelSpec,
    #[serde(default = "defaults::ten")]
    pub limit: i64,
}

string_enum!(
    /// `PANEL_RETENTION_INTERVALS`.
    RetentionInterval { Day = "day", Week = "week", Month = "month" }
);

impl RetentionInterval {
    /// The same interval as a bucket interval.
    pub fn interval(self) -> Interval {
        match self {
            Self::Day => Interval::Day,
            Self::Week => Interval::Week,
            Self::Month => Interval::Month,
        }
    }
}

string_enum!(
    /// `PANEL_RETENTION_MODES`.
    RetentionMode { FirstTime = "first_time", Recurring = "recurring" }
);

fn week() -> RetentionInterval {
    RetentionInterval::Week
}

fn eight() -> i64 {
    8
}

/// `retention`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionSpec {
    #[serde(flatten)]
    pub base: SpecBase,
    pub first_event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_event: Option<String>,
    #[serde(default = "week")]
    pub interval: RetentionInterval,
    #[serde(default = "eight")]
    pub periods: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub breakdown: Option<PanelBreakdown>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<RetentionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unbounded: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregate_by: Option<AggregateBy>,
}

string_enum!(
    /// Which way flows go from the anchor.
    #[derive(Default)]
    FlowDirection { #[default] After = "after", Before = "before" }
);

string_enum!(
    /// What flows show.
    #[derive(Default)]
    FlowScope { #[default] All = "all", Pageviews = "pageviews", Custom = "custom" }
);

fn three() -> i64 {
    3
}

fn twenty() -> i64 {
    20
}

/// `flows`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowsSpec {
    #[serde(flatten)]
    pub base: SpecBase,
    pub anchor: FunnelStep,
    #[serde(default)]
    pub direction: FlowDirection,
    #[serde(default = "three")]
    pub depth: i64,
    #[serde(default)]
    pub scope: FlowScope,
    #[serde(default = "twenty")]
    pub limit: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean_paths: Option<bool>,
}

string_enum!(
    /// Stickiness intervals.
    #[derive(Default)]
    StickinessInterval { #[default] Day = "day", Week = "week" }
);

impl StickinessInterval {
    /// The same interval as a bucket interval.
    pub fn interval(self) -> Interval {
        match self {
            Self::Day => Interval::Day,
            Self::Week => Interval::Week,
        }
    }
}

string_enum!(
    /// What stickiness measures.
    #[derive(Default)]
    StickinessMeasure { #[default] Intervals = "intervals", Count = "count" }
);

/// `stickiness`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickinessSpec {
    #[serde(flatten)]
    pub base: SpecBase,
    pub event: String,
    #[serde(default)]
    pub interval: StickinessInterval,
    #[serde(default)]
    pub measure: StickinessMeasure,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregate_by: Option<AggregateBy>,
}

fn day_retention() -> RetentionInterval {
    RetentionInterval::Day
}

/// `lifecycle`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleSpec {
    #[serde(flatten)]
    pub base: SpecBase,
    pub event: String,
    #[serde(default = "day_retention")]
    pub interval: RetentionInterval,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregate_by: Option<AggregateBy>,
}

string_enum!(
    /// `PANEL_VITALS_METRICS`.
    #[derive(Default)]
    VitalsMetric { #[default] Lcp = "lcp", Inp = "inp", Cls = "cls", Fcp = "fcp", Ttfb = "ttfb" }
);

string_enum!(
    /// `PANEL_VITALS_PERCENTILES`.
    #[derive(Default)]
    VitalsPercentile { #[default] P75 = "p75", P90 = "p90", P95 = "p95", P99 = "p99" }
);

/// Google's Core Web Vitals thresholds: up to `good` is good, above `poor`
/// is poor.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct VitalsThresholds {
    pub good: f64,
    pub poor: f64,
}

/// `PANEL_VITALS_THRESHOLDS`.
pub fn vitals_thresholds(metric: VitalsMetric) -> VitalsThresholds {
    let (good, poor) = match metric {
        VitalsMetric::Lcp => (2500.0, 4000.0),
        VitalsMetric::Inp => (200.0, 500.0),
        VitalsMetric::Cls => (0.1, 0.25),
        VitalsMetric::Fcp => (1800.0, 3000.0),
        VitalsMetric::Ttfb => (800.0, 1800.0),
    };
    VitalsThresholds { good, poor }
}

/// `vitals`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VitalsSpec {
    #[serde(flatten)]
    pub base: SpecBase,
    #[serde(default)]
    pub metric: VitalsMetric,
    #[serde(default)]
    pub percentile: VitalsPercentile,
    #[serde(default)]
    pub interval: Interval,
    #[serde(default = "defaults::ten")]
    pub limit: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clean_paths: Option<bool>,
}

string_enum!(
    /// `PANEL_IMPACT_MATHS`.
    #[derive(Default)]
    ImpactMath { #[default] Total = "total", UniqueUsers = "unique_users", Sum = "sum", Avg = "avg" }
);

/// The metric an impact report follows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImpactMetric {
    pub event: String,
    #[serde(default)]
    pub math: ImpactMath,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub property: Option<String>,
    #[serde(default)]
    pub filters: Vec<PanelFilter>,
}

fn twenty_eight() -> i64 {
    28
}

/// `impact`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpactSpec {
    #[serde(flatten)]
    pub base: SpecBase,
    pub launch_event: String,
    pub launch_date: String,
    pub metric: ImpactMetric,
    #[serde(default = "twenty_eight")]
    pub window_days: i64,
}

/// The goal of a signal report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SignalGoal {
    pub event: String,
    #[serde(default)]
    pub filters: Vec<PanelFilter>,
}

fn seven() -> i64 {
    7
}

/// `signal`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalSpec {
    #[serde(flatten)]
    pub base: SpecBase,
    pub goal: SignalGoal,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<String>>,
    #[serde(default = "defaults::ten", rename = "topN")]
    pub top_n: i64,
    #[serde(default = "seven")]
    pub window_days: i64,
}

string_enum!(
    /// `PANEL_DEVICE_CLASSES`.
    DeviceClass { Desktop = "desktop", Tablet = "tablet", Mobile = "mobile" }
);

string_enum!(
    /// `PANEL_FRUSTRATION_TYPES`.
    FrustrationType {
        Rage = "rage",
        Dead = "dead",
        Quickback = "quickback",
        ExcessiveScroll = "excessive_scroll",
    }
);

string_enum!(
    /// `PANEL_SESSION_SORTS`.
    #[derive(Default)]
    SessionSort {
        #[default] StartedDesc = "started_desc",
        DurationDesc = "duration_desc",
        PagesDesc = "pages_desc",
        FrustrationDesc = "frustration_desc",
        ErrorsDesc = "errors_desc",
    }
);

fn twenty_five() -> i64 {
    25
}

/// `sessions`: the recordings list (no `filters`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsSpec {
    pub project_id: String,
    #[serde(default)]
    pub date_range: DateRange,
    #[serde(default = "defaults::utc")]
    pub timezone: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_duration_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_duration_seconds: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages_visited: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_page: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_page: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub countries: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub devices: Option<Vec<DeviceClass>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browsers: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distinct_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cohort_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub did_events: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_did_events: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frustration: Option<Vec<FrustrationType>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_errors: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favorites_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_recording: Option<bool>,
    #[serde(default)]
    pub sort: SessionSort,
    #[serde(default = "twenty_five")]
    pub limit: i64,
    /// `.nullish()`: absent, `null` or the previous page's `nextCursor`.
    #[serde(
        default,
        deserialize_with = "super::nullish::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    pub cursor: Option<Option<String>>,
}

string_enum!(
    /// `PANEL_HEATMAP_TYPES`.
    HeatmapType { Click = "click", Area = "area", Scroll = "scroll" }
);

/// `heatmap` (no `filters`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapSpec {
    pub project_id: String,
    #[serde(default)]
    pub date_range: DateRange,
    #[serde(default = "defaults::utc")]
    pub timezone: String,
    #[serde(rename = "type")]
    pub heatmap_type: HeatmapType,
    pub device_class: DeviceClass,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_group_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_pattern: Option<String>,
}

/// `panelQuerySpecSchema`: a parsed spec of any kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PanelQuerySpec {
    Web(WebSpec),
    Trends(TrendsSpec),
    Funnel(FunnelSpec),
    Retention(RetentionSpec),
    Flows(FlowsSpec),
    Sessions(SessionsSpec),
    Heatmap(HeatmapSpec),
    FunnelCorrelation(FunnelCorrelationSpec),
    Stickiness(StickinessSpec),
    Lifecycle(LifecycleSpec),
    Vitals(VitalsSpec),
    Impact(ImpactSpec),
    Signal(SignalSpec),
}

string_enum!(
    /// `PANEL_QUERY_KINDS`.
    PanelQueryKind {
        Web = "web",
        Trends = "trends",
        Funnel = "funnel",
        Retention = "retention",
        Flows = "flows",
        Sessions = "sessions",
        Heatmap = "heatmap",
        FunnelCorrelation = "funnel_correlation",
        Stickiness = "stickiness",
        Lifecycle = "lifecycle",
        Vitals = "vitals",
        Impact = "impact",
        Signal = "signal",
    }
);

impl PanelQuerySpec {
    /// The spec's kind.
    pub fn kind(&self) -> PanelQueryKind {
        match self {
            Self::Web(_) => PanelQueryKind::Web,
            Self::Trends(_) => PanelQueryKind::Trends,
            Self::Funnel(_) => PanelQueryKind::Funnel,
            Self::Retention(_) => PanelQueryKind::Retention,
            Self::Flows(_) => PanelQueryKind::Flows,
            Self::Sessions(_) => PanelQueryKind::Sessions,
            Self::Heatmap(_) => PanelQueryKind::Heatmap,
            Self::FunnelCorrelation(_) => PanelQueryKind::FunnelCorrelation,
            Self::Stickiness(_) => PanelQueryKind::Stickiness,
            Self::Lifecycle(_) => PanelQueryKind::Lifecycle,
            Self::Vitals(_) => PanelQueryKind::Vitals,
            Self::Impact(_) => PanelQueryKind::Impact,
            Self::Signal(_) => PanelQueryKind::Signal,
        }
    }

    /// The project the spec names.
    pub fn project_id(&self) -> &str {
        match self {
            Self::Web(s) => &s.base.project_id,
            Self::Trends(s) => &s.base.project_id,
            Self::Funnel(s) => &s.base.project_id,
            Self::FunnelCorrelation(s) => &s.funnel.base.project_id,
            Self::Retention(s) => &s.base.project_id,
            Self::Flows(s) => &s.base.project_id,
            Self::Sessions(s) => &s.project_id,
            Self::Heatmap(s) => &s.project_id,
            Self::Stickiness(s) => &s.base.project_id,
            Self::Lifecycle(s) => &s.base.project_id,
            Self::Vitals(s) => &s.base.project_id,
            Self::Impact(s) => &s.base.project_id,
            Self::Signal(s) => &s.base.project_id,
        }
    }
}

// ---------------------------------------------------------------------------
// Cohort filters
// ---------------------------------------------------------------------------

string_enum!(
    /// How a cohort's conditions combine.
    #[derive(Default)]
    CohortMatch { #[default] All = "all", Any = "any" }
);

fn one() -> i64 {
    1
}

/// One condition of a cohort.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CohortCondition {
    PersonProperty {
        key: String,
        operator: FilterOperator,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<FilterValue>,
    },
    Performed {
        event: String,
        #[serde(default)]
        filters: Vec<PanelFilter>,
        within_days: i64,
        #[serde(default = "one")]
        min_count: i64,
        #[serde(default)]
        negate: bool,
    },
}

/// A cohort: a saved filter on people (`panel_cohorts.filter`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CohortFilter {
    #[serde(default, rename = "match")]
    pub match_: CohortMatch,
    pub conditions: Vec<CohortCondition>,
}

/// A path rule as the compiler reads it (`panel_path_rules`, by position).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathRule {
    pub pattern: String,
    pub replacement: String,
}
