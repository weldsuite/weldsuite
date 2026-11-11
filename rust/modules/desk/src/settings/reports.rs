//! WeldDesk reports on the live inbox (`services/desk-reports.ts`, ADR
//! DESK-011): the overview and the report builder's chart data, aggregated
//! from the tenant database (`desk_conversations`, `desk_messages`,
//! `desk_sla_clocks`).
//!
//! The statements are the worker's, text for text: every value is computed
//! and rounded in SQL, and the only parameters are period timestamps, bound
//! as text and cast with `::timestamp` like Drizzle does. Periods are whole
//! UTC days, `start` inclusive and `end` exclusive.

use serde_json::{Map, Value, json};
use sqlx::Row;
use sqlx::postgres::PgRow;
use time::{Date, Month, OffsetDateTime};
use weldsuite_db::PgPool;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::js_number;

use crate::Caller;

const DAY_MS: i64 = 86_400_000;
const MAX_BUCKETS: f64 = 1000.0;
const MAX_LIMIT: f64 = 1000.0;
const PEOPLE_LIMIT: u32 = 50;
const DEFAULT_RANGE: &str = "last_30_days";

const RANGES: [&str; 13] = [
    "today",
    "yesterday",
    "last_7_days",
    "last_14_days",
    "last_30_days",
    "last_90_days",
    "last_180_days",
    "last_365_days",
    "this_month",
    "this_quarter",
    "this_year",
    "last_year",
    "all_time",
];

// ── clock ───────────────────────────────────────────────────────────────────

/// `new Date().getTime()` as the request sees it: the test's faked clock in
/// conformance (`CONFORMANCE_NOW`, which only the harness sets), else the
/// real one.
pub(super) fn clock_ms(caller: &Caller) -> i64 {
    let fixed = caller
        .env("CONFORMANCE_NOW")
        .and_then(|at| {
            OffsetDateTime::parse(&at, &time::format_description::well_known::Rfc3339).ok()
        })
        .unwrap_or_else(OffsetDateTime::now_utc);
    i64::try_from(fixed.unix_timestamp_nanos().div_euclid(1_000_000)).unwrap_or_default()
}

pub(super) fn iso_of(ms: i64) -> String {
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    iso_timestamp(at)
}

/// `dateKey`: `toISOString().slice(0, 10)`.
pub(super) fn date_key(ms: i64) -> String {
    iso_of(ms).chars().take(10).collect()
}

/// `Date.UTC(year, month, 1)`, `month` being 1 to 12.
fn first_of(year: i32, month: u8, fallback: i64) -> i64 {
    Month::try_from(month)
        .ok()
        .and_then(|month| Date::from_calendar_date(year, month, 1).ok())
        .map_or(fallback, |day| {
            day.midnight().assume_utc().unix_timestamp() * 1000
        })
}

// ── periods ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub(super) struct Period {
    pub(super) range: &'static str,
    /// UTC midnight, inclusive.
    pub(super) start: i64,
    /// UTC midnight, exclusive.
    pub(super) end: i64,
}

/// `deskReportRangeOf`: a known key, else the last 30 days.
pub(super) fn range_of(value: Option<&str>) -> &'static str {
    value
        .and_then(|value| RANGES.iter().find(|range| **range == value))
        .copied()
        .unwrap_or(DEFAULT_RANGE)
}

fn last_days(range: &str) -> Option<i64> {
    match range {
        "last_7_days" => Some(7),
        "last_14_days" => Some(14),
        "last_30_days" => Some(30),
        "last_90_days" => Some(90),
        "last_180_days" => Some(180),
        "last_365_days" => Some(365),
        _ => None,
    }
}

/// `deskReportPeriod`: the days a range covers on `now`'s UTC calendar.
/// `all_time` starts on the day of `first_activity` (the oldest
/// conversation), today when there is none.
pub(super) fn period_of(range: &'static str, now: i64, first_activity: Option<i64>) -> Period {
    let today = now.div_euclid(DAY_MS) * DAY_MS;
    let tomorrow = today + DAY_MS;
    let at = OffsetDateTime::from_unix_timestamp(now.div_euclid(1000))
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    let year = at.year();
    let month = u8::from(at.month());
    let period = |start: i64, end: i64| Period { range, start, end };
    if let Some(days) = last_days(range) {
        return period(today - (days - 1) * DAY_MS, tomorrow);
    }
    match range {
        "today" => period(today, tomorrow),
        "yesterday" => period(today - DAY_MS, today),
        "this_month" => period(first_of(year, month, today), tomorrow),
        "this_quarter" => {
            let start = month - (month - 1) % 3;
            period(first_of(year, start, today), tomorrow)
        }
        "this_year" => period(first_of(year, 1, today), tomorrow),
        "last_year" => period(first_of(year - 1, 1, today), first_of(year, 1, tomorrow)),
        "all_time" => {
            let first = first_activity.map_or(today, |at| at.div_euclid(DAY_MS) * DAY_MS);
            period(first.min(today), tomorrow)
        }
        _ => period(today - 29 * DAY_MS, tomorrow),
    }
}

/// The period of the same length just before `period`.
pub(super) fn previous_of(period: Period) -> Period {
    let length = period.end - period.start;
    Period {
        range: period.range,
        start: period.start - length,
        end: period.start,
    }
}

// ── buckets ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Unit {
    Hour,
    Day,
    Week,
    Month,
    Quarter,
    Year,
}

const UNITS: [Unit; 6] = [
    Unit::Hour,
    Unit::Day,
    Unit::Week,
    Unit::Month,
    Unit::Quarter,
    Unit::Year,
];

impl Unit {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Hour => "hour",
            Self::Day => "day",
            Self::Week => "week",
            Self::Month => "month",
            Self::Quarter => "quarter",
            Self::Year => "year",
        }
    }

    /// Approximate length, only to keep a series under [`MAX_BUCKETS`].
    fn ms(self) -> i64 {
        match self {
            Self::Hour => 3_600_000,
            Self::Day => DAY_MS,
            Self::Week => 7 * DAY_MS,
            Self::Month => 30 * DAY_MS,
            Self::Quarter => 91 * DAY_MS,
            Self::Year => 365 * DAY_MS,
        }
    }

    fn interval(self) -> &'static str {
        match self {
            Self::Hour => "1 hour",
            Self::Day => "1 day",
            Self::Week => "1 week",
            Self::Month => "1 month",
            Self::Quarter => "3 months",
            Self::Year => "1 year",
        }
    }

    /// Labels sort chronologically.
    fn label(self) -> &'static str {
        match self {
            Self::Hour => "YYYY-MM-DD\"T\"HH24\":00\"",
            Self::Day | Self::Week => "YYYY-MM-DD",
            Self::Month => "YYYY-MM",
            Self::Quarter => "YYYY-\"Q\"Q",
            Self::Year => "YYYY",
        }
    }
}

/// `deskReportUnit`: the unit asked for, made coarser until the period fits
/// in [`MAX_BUCKETS`].
#[allow(clippy::cast_precision_loss)]
fn unit_of(group_by: Option<&str>, period: Period) -> Unit {
    let span = (period.end - period.start) as f64;
    let mut index = UNITS
        .iter()
        .position(|unit| Some(unit.name()) == group_by)
        .unwrap_or(1);
    while index < UNITS.len() - 1 && (span / UNITS[index].ms() as f64).ceil() > MAX_BUCKETS {
        index += 1;
    }
    UNITS[index]
}

/// The overview's series: days up to three months, weeks up to a year, then
/// months.
#[allow(clippy::cast_precision_loss)]
pub(super) fn overview_unit(period: Period) -> Unit {
    let days = (period.end - period.start) as f64 / DAY_MS as f64;
    if days <= 92.0 {
        Unit::Day
    } else if days <= 371.0 {
        Unit::Week
    } else {
        Unit::Month
    }
}

// ── SQL ─────────────────────────────────────────────────────────────────────

/// Period timestamps, bound in the order they are numbered.
#[derive(Default)]
pub(super) struct Binds(Vec<String>);

impl Binds {
    /// `$n::timestamp` for a moment.
    pub(super) fn ts(&mut self, ms: i64) -> String {
        self.0.push(iso_of(ms));
        format!("${}::timestamp", self.0.len())
    }

    /// `$n` for a text value (a team id).
    pub(super) fn text(&mut self, value: &str) -> String {
        self.0.push(value.to_owned());
        format!("${}", self.0.len())
    }

    /// `inPeriod`.
    pub(super) fn in_period(&mut self, column: &str, period: Period) -> String {
        let start = self.ts(period.start);
        let end = self.ts(period.end);
        format!("({column} >= {start} and {column} < {end})")
    }

    /// `trunc(unit, …)` of the period's start, to its end, as `buckets(bucket)`.
    pub(super) fn buckets(&mut self, unit: Unit, period: Period) -> String {
        let start = self.ts(period.start);
        let end = self.ts(period.end);
        format!(
            "buckets as (
    select generate_series(
      date_trunc('{unit}', {start}),
      {end} - interval '1 millisecond',
      interval '{interval}'
    ) as bucket
  )",
            unit = unit.name(),
            interval = unit.interval(),
        )
    }
}

pub(super) fn trunc(unit: Unit, column: &str) -> String {
    format!("date_trunc('{}', {column})", unit.name())
}

fn label_of(unit: Unit, column: &str) -> String {
    format!("to_char({column}, '{}')", unit.label())
}

pub(super) async fn rows(db: &PgPool, sql: &str, binds: Binds) -> Result<Vec<PgRow>, sqlx::Error> {
    // Built only from the report files' whitelisted fragments; every value is a bind.
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()));
    for value in binds.0 {
        query = query.bind(value);
    }
    query.fetch_all(db).await
}

/// A number as JSON the way JavaScript prints it: integral values without a
/// fraction (`50`, not `50.0`).
fn js_num(value: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        return Value::from(value as i64);
    }
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

pub(super) fn opt_num(value: Option<f64>) -> Value {
    value.map_or(Value::Null, js_num)
}

pub(super) fn opt_int(value: Option<i32>) -> Value {
    value.map_or(Value::Null, Value::from)
}

/// The day of the oldest conversation, for `all_time`.
async fn first_activity(db: &PgPool) -> Result<Option<i64>, sqlx::Error> {
    let first: Option<String> = sqlx::query_scalar(
        "select to_char(min(created_at), 'YYYY-MM-DD') as first from desk_conversations",
    )
    .fetch_one(db)
    .await?;
    Ok(first.as_deref().and_then(day_start))
}

/// `new Date(`${day}T00:00:00.000Z`).getTime()` of a `YYYY-MM-DD` day.
pub(super) fn day_start(day: &str) -> Option<i64> {
    let mut parts = day.split('-').map(str::parse::<i32>);
    let (year, month, date) = (
        parts.next()?.ok()?,
        parts.next()?.ok()?,
        parts.next()?.ok()?,
    );
    let month = Month::try_from(u8::try_from(month).ok()?).ok()?;
    let day = Date::from_calendar_date(year, month, u8::try_from(date).ok()?).ok()?;
    Some(day.midnight().assume_utc().unix_timestamp() * 1000)
}

async fn resolve_period(db: &PgPool, range: Option<&str>, now: i64) -> Result<Period, sqlx::Error> {
    let range = range_of(range);
    let first = if range == "all_time" {
        first_activity(db).await?
    } else {
        None
    };
    Ok(period_of(range, now, first))
}

// ── chart data (the report builder) ─────────────────────────────────────────

/// What a chart asks for, as `deskChartData` reads it: strings where the
/// worker compares strings, the limit as a clamped positive integer.
#[derive(Debug, Default)]
pub(super) struct ChartQuery {
    metric: Option<String>,
    time_range: Option<String>,
    group_by: Option<String>,
    aggregation: Option<String>,
    sort_order: Option<String>,
    limit: Option<usize>,
}

impl ChartQuery {
    pub(super) fn from_fields(fields: &Map<String, Value>) -> Self {
        let text = |key: &str| match fields.get(key) {
            Some(Value::String(text)) => Some(text.clone()),
            _ => None,
        };
        Self {
            metric: text("metric"),
            time_range: text("timeRange"),
            group_by: text("groupBy"),
            aggregation: text("aggregation"),
            sort_order: text("sortOrder"),
            limit: limit_of(fields.get("limit")),
        }
    }

    fn desc(&self) -> bool {
        self.sort_order.as_deref() == Some("desc")
    }
}

/// `limitOf`: a string is read as a number; only an integer from 1 counts,
/// at most [`MAX_LIMIT`].
fn limit_of(value: Option<&Value>) -> Option<usize> {
    let number = match value {
        Some(Value::String(text)) => js_number(text),
        Some(Value::Number(number)) => number.as_f64()?,
        _ => return None,
    };
    if !number.is_finite() || number.fract() != 0.0 || number < 1.0 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(number.min(MAX_LIMIT) as usize)
}

/// What a chart reads: the rows and the dimension joins.
#[derive(Debug, Clone, Copy)]
enum Source {
    Conversations,
    AgentReplies,
    SlaClocks,
}

impl Source {
    fn from(self) -> &'static str {
        match self {
            Self::Conversations => "desk_conversations c",
            Self::AgentReplies => {
                "desk_messages m join desk_conversations c on c.id = m.conversation_id"
            }
            Self::SlaClocks => {
                "desk_sla_clocks s join desk_conversations c on c.id = s.conversation_id"
            }
        }
    }
}

macro_rules! customer_key {
    () => {
        "coalesce(c.contact_id, c.visitor_id, lower(c.email), c.id)"
    };
}

#[derive(Debug, Clone, Copy)]
enum Dim {
    State,
    Priority,
    Channel,
    Type,
    Team,
    Assignee,
    Author,
    Rating,
    Customer,
    SlaMetric,
}

struct DimSpec {
    join: Option<&'static str>,
    /// Grouped on; the label is taken per key.
    key: &'static str,
    label: &'static str,
    /// Listed in the key's own order (1 to 5 stars), not by value.
    ordered: bool,
}

fn dimension(dim: Dim) -> DimSpec {
    let plain = |key, label| DimSpec {
        join: None,
        key,
        label,
        ordered: false,
    };
    match dim {
        Dim::State => plain("c.state", "c.state"),
        Dim::Priority => plain(
            "coalesce(c.priority, 'none')",
            "coalesce(c.priority, 'none')",
        ),
        Dim::Channel => plain("c.channel", "c.channel"),
        Dim::Type => DimSpec {
            join: Some("left join helpdesk_ticket_types tt on tt.id = c.ticket_type_id"),
            key: "c.ticket_type_id",
            label: "coalesce(max(tt.name), '')",
            ordered: false,
        },
        Dim::Team => DimSpec {
            join: Some("left join helpdesk_departments dp on dp.id = c.department_id"),
            key: "c.department_id",
            label: "coalesce(max(dp.name), '')",
            ordered: false,
        },
        Dim::Assignee => DimSpec {
            join: Some("left join workspace_members wm on wm.user_id = c.assignee_id"),
            key: "c.assignee_id",
            label: "coalesce(max(wm.name), max(wm.email), c.assignee_id, '')",
            ordered: false,
        },
        Dim::Author => DimSpec {
            join: Some("left join workspace_members wm on wm.user_id = m.author_id"),
            key: "m.author_id",
            label: "coalesce(max(wm.name), max(wm.email), m.author_id, '')",
            ordered: false,
        },
        Dim::Rating => DimSpec {
            join: None,
            key: "c.rating",
            label: "coalesce(c.rating::text, '')",
            ordered: true,
        },
        Dim::Customer => plain(customer_key!(), "coalesce(max(c.name), max(c.email), '')"),
        Dim::SlaMetric => plain("s.metric", "s.metric"),
    }
}

/// `!!deskChartMetric(metric)?.dimension`: the metric is a breakdown (by
/// channel, agent, …) rather than a time series.
pub(super) fn is_breakdown(metric: &str) -> bool {
    metric_spec(metric).is_some_and(|spec| spec.dimension.is_some())
}

/// How the value of a group is computed.
#[derive(Debug, Clone, Copy)]
enum Measure {
    Count,
    Distinct(&'static str),
    /// A duration in seconds, shown in minutes or hours; honours the chart's
    /// calculation (average, max, min, count).
    Duration {
        column: &'static str,
        hours: bool,
    },
    Average(&'static str),
    /// Share of the rows where `when` holds, among those where `of` holds
    /// (all rows by default).
    Percent {
        when: &'static str,
        of: Option<&'static str>,
    },
}

const FIRST_RESPONSE: Measure = Measure::Duration {
    column: "c.first_response_seconds",
    hours: false,
};
const RESOLUTION: Measure = Measure::Duration {
    column: "c.resolution_seconds",
    hours: true,
};
const CSAT: Measure = Measure::Percent {
    when: "c.rating >= 4",
    of: None,
};
const SLA_MET: Measure = Measure::Percent {
    when: "s.status = 'completed' and s.breached_at is null",
    of: Some("(s.status = 'completed' and s.breached_at is null) or s.breached_at is not null"),
};

const CREATED: &str = "c.created_at";
const RESOLVED: &str = "c.resolved_at";
const ANSWERED: &str = "c.first_response_at";
const RATED: &str = "c.rated_at";
const REPLIED: &str = "m.created_at";
const CLOCK_STARTED: &str = "s.started_at";

const AGENT_REPLY: &str = "m.kind = 'message' and m.author_type = 'agent'";
const PUBLIC_MESSAGES: &str = "(select count(*) from desk_messages pm where pm.conversation_id = c.id and pm.kind = 'message' and pm.author_type in ('visitor', 'agent'))";
const BREACHED: &str = "exists (select 1 from desk_sla_clocks bs where bs.conversation_id = c.id and bs.breached_at is not null)";
const NEW_CUSTOMER: &str = concat!(
    "not exists (select 1 from desk_conversations pc where coalesce(pc.contact_id, pc.visitor_id, lower(pc.email), pc.id) = ",
    customer_key!(),
    " and pc.created_at < c.created_at)"
);
const RETURNING_CUSTOMER: &str = concat!(
    "exists (select 1 from desk_conversations pc where coalesce(pc.contact_id, pc.visitor_id, lower(pc.email), pc.id) = ",
    customer_key!(),
    " and pc.created_at < c.created_at)"
);

#[derive(Debug, Clone, Copy)]
struct Spec {
    source: Source,
    /// The time column the period filters on (and series bucket by).
    time: &'static str,
    filter: Option<&'static str>,
    measure: Measure,
    /// Grouped on this instead of time.
    dimension: Option<Dim>,
    /// Series always in this unit (the `*_by_day` metrics).
    unit: Option<Unit>,
}

impl Spec {
    const fn new(source: Source, time: &'static str, measure: Measure) -> Self {
        Self {
            source,
            time,
            filter: None,
            measure,
            dimension: None,
            unit: None,
        }
    }

    const fn filter(self, filter: &'static str) -> Self {
        Self {
            filter: Some(filter),
            ..self
        }
    }

    const fn measure(self, measure: Measure) -> Self {
        Self { measure, ..self }
    }

    const fn by(self, dimension: Dim) -> Self {
        Self {
            dimension: Some(dimension),
            ..self
        }
    }

    const fn by_day(self) -> Self {
        Self {
            unit: Some(Unit::Day),
            ..self
        }
    }
}

const TICKETS_CREATED: Spec = Spec::new(Source::Conversations, CREATED, Measure::Count);
const RESOLVED_TICKETS: Spec = Spec::new(Source::Conversations, RESOLVED, Measure::Count);
const FIRST_RESPONSE_SPEC: Spec = Spec::new(Source::Conversations, ANSWERED, FIRST_RESPONSE)
    .filter("c.first_response_seconds is not null");
const RESOLUTION_SPEC: Spec = Spec::new(Source::Conversations, RESOLVED, RESOLUTION)
    .filter("c.resolution_seconds is not null");
const CSAT_SPEC: Spec =
    Spec::new(Source::Conversations, RATED, CSAT).filter("c.rating is not null");
const SLA_COMPLIANCE: Spec = Spec::new(Source::SlaClocks, CLOCK_STARTED, SLA_MET);
const AGENT_REPLIES: Spec =
    Spec::new(Source::AgentReplies, REPLIED, Measure::Count).filter(AGENT_REPLY);

/// The metric an id names, the old analytics ids included (aliases); a
/// metric not listed answers an empty series.
fn metric_spec(metric: &str) -> Option<Spec> {
    let id = match metric {
        "total_tickets" | "total_conversations" => "tickets_created",
        "tickets_by_day" | "conversations_by_day" => "tickets_created_by_day",
        "closed_tickets" => "tickets_resolved",
        "open_tickets" | "active_conversations" => "tickets_open",
        "conversations_by_channel" => "tickets_by_channel",
        "escalated_tickets" => "sla_breached_tickets",
        "customers_by_tickets" => "top_customers",
        "total_agents" | "active_agents" => "agents_replying",
        "agent_performance" => "resolved_per_agent",
        "response_time_trend" => "avg_first_response_by_day",
        "satisfaction_trend" => "csat_score_by_day",
        other => other,
    };
    let customers = |filter: &'static str| {
        Spec::new(
            Source::Conversations,
            CREATED,
            Measure::Distinct(customer_key!()),
        )
        .filter(filter)
    };
    Some(match id {
        // Tickets (a conversation is the ticket, DESK-007)
        "tickets_created" => TICKETS_CREATED,
        "tickets_resolved" => RESOLVED_TICKETS,
        "tickets_open" => TICKETS_CREATED.filter("c.state = 'open'"),
        "tickets_by_status" => TICKETS_CREATED.by(Dim::State),
        "tickets_by_priority" => TICKETS_CREATED.by(Dim::Priority),
        "tickets_by_channel" => TICKETS_CREATED.by(Dim::Channel),
        "tickets_by_type" => TICKETS_CREATED.by(Dim::Type),
        "tickets_by_team" => TICKETS_CREATED.by(Dim::Team),
        "sla_breached_tickets" => TICKETS_CREATED.filter(BREACHED),
        "avg_messages" => TICKETS_CREATED.measure(Measure::Average(PUBLIC_MESSAGES)),
        // Customers
        "total_customers" => Spec::new(
            Source::Conversations,
            CREATED,
            Measure::Distinct(customer_key!()),
        ),
        "new_customers" => customers(NEW_CUSTOMER),
        "returning_customers" => customers(RETURNING_CUSTOMER),
        "top_customers" => TICKETS_CREATED.by(Dim::Customer),
        // Agents
        "agents_replying" => AGENT_REPLIES.measure(Measure::Distinct("m.author_id")),
        "tickets_per_agent" => TICKETS_CREATED.by(Dim::Assignee),
        "resolved_per_agent" => RESOLVED_TICKETS.by(Dim::Assignee),
        "replies_per_agent" => AGENT_REPLIES.by(Dim::Author),
        "agent_response_time" => FIRST_RESPONSE_SPEC.by(Dim::Assignee),
        // Response and resolution times
        "avg_first_response" => FIRST_RESPONSE_SPEC,
        "avg_resolution_time" => RESOLUTION_SPEC,
        "response_by_priority" => FIRST_RESPONSE_SPEC.by(Dim::Priority),
        "resolution_by_priority" => RESOLUTION_SPEC.by(Dim::Priority),
        "sla_compliance" => SLA_COMPLIANCE,
        "sla_compliance_by_metric" => SLA_COMPLIANCE.by(Dim::SlaMetric),
        // Satisfaction (the 1-5 rating after a close; 4 and 5 are satisfied)
        "csat_score" => CSAT_SPEC,
        "avg_rating" => CSAT_SPEC.measure(Measure::Average("c.rating")),
        "ratings_distribution" => CSAT_SPEC.measure(Measure::Count).by(Dim::Rating),
        "satisfaction_by_agent" => CSAT_SPEC.by(Dim::Assignee),
        // Series always by day
        "tickets_created_by_day" => TICKETS_CREATED.by_day(),
        "avg_first_response_by_day" => FIRST_RESPONSE_SPEC.by_day(),
        "csat_score_by_day" => CSAT_SPEC.by_day(),
        _ => return None,
    })
}

/// The SQL value of a measure (rounded where it is not a count).
fn value_sql(measure: Measure, aggregation: Option<&str>) -> String {
    match measure {
        Measure::Count => "count(*)::float8".to_owned(),
        Measure::Distinct(expr) => format!("count(distinct {expr})::float8"),
        Measure::Average(expr) => format!("round(avg({expr})::numeric, 1)::float8"),
        Measure::Percent { when, of } => {
            let of = of.unwrap_or("true");
            format!(
                "round(100.0 * count(*) filter (where {when}) / nullif(count(*) filter (where {of}), 0), 1)::float8"
            )
        }
        Measure::Duration { column, hours } => {
            if aggregation == Some("count") {
                return format!("count({column})::float8");
            }
            let divisor = if hours { "3600.0" } else { "60.0" };
            let function = match aggregation {
                Some("max") => "max",
                Some("min") => "min",
                _ => "avg",
            };
            format!("round(({function}({column}) / {divisor})::numeric, 1)::float8")
        }
    }
}

/// Counts are 0 where a bucket has no rows; averages and shares are left
/// out there.
fn count_like(measure: Measure, aggregation: Option<&str>) -> bool {
    match measure {
        Measure::Count | Measure::Distinct(_) => true,
        Measure::Duration { .. } => aggregation == Some("count"),
        Measure::Average(_) | Measure::Percent { .. } => false,
    }
}

fn where_of(binds: &mut Binds, spec: Spec, period: Period) -> String {
    let in_period = binds.in_period(spec.time, period);
    match spec.filter {
        Some(filter) => format!("{in_period} and {filter}"),
        None => in_period,
    }
}

fn point(label: Option<String>, value: Option<f64>) -> Value {
    json!({ "label": label.unwrap_or_default(), "value": js_num(value.unwrap_or_default()) })
}

async fn series_data(
    db: &PgPool,
    spec: Spec,
    query: &ChartQuery,
    period: Period,
) -> Result<Vec<Value>, sqlx::Error> {
    let unit = spec
        .unit
        .unwrap_or_else(|| unit_of(query.group_by.as_deref(), period));
    let aggregation = query.aggregation.as_deref();
    let value = value_sql(spec.measure, aggregation);
    let mut binds = Binds::default();
    let buckets = binds.buckets(unit, period);
    let filter = where_of(&mut binds, spec, period);
    let sql = format!(
        "with {buckets},
      data as (
        select {bucket} as bucket, {value} as value
        from {from}
        where {filter}
        group by 1
      )
      select {label} as label, d.value
      from buckets b left join data d on d.bucket = b.bucket
      order by b.bucket",
        bucket = trunc(unit, spec.time),
        from = spec.source.from(),
        label = label_of(unit, "b.bucket"),
    );
    let fill = count_like(spec.measure, aggregation);
    let mut points = Vec::new();
    for row in rows(db, &sql, binds).await? {
        let label: Option<String> = row.try_get("label")?;
        let value: Option<f64> = row.try_get("value")?;
        if fill || value.is_some() {
            points.push(point(label, value));
        }
    }
    // A limit keeps the most recent buckets, in the order asked for.
    if let Some(limit) = query.limit
        && points.len() > limit
    {
        points.drain(..points.len() - limit);
    }
    if query.desc() {
        points.reverse();
    }
    Ok(points)
}

async fn dimension_data(
    db: &PgPool,
    spec: Spec,
    dim: Dim,
    query: &ChartQuery,
    period: Period,
) -> Result<Vec<Value>, sqlx::Error> {
    let dimension = dimension(dim);
    let value = value_sql(spec.measure, query.aggregation.as_deref());
    let direction = if query.desc() { "desc" } else { "asc" };
    let order = if dimension.ordered {
        format!("{} {direction}", dimension.key)
    } else {
        format!("2 {direction}, 1 asc")
    };
    let limit = query
        .limit
        .map_or_else(String::new, |limit| format!("limit {limit}"));
    let mut binds = Binds::default();
    let filter = where_of(&mut binds, spec, period);
    let sql = format!(
        "select {label} as label, {value} as value
      from {from} {join}
      where {filter}
      group by {key}
      having {value} is not null
      order by {order}
      {limit}",
        label = dimension.label,
        from = spec.source.from(),
        join = dimension.join.unwrap_or_default(),
        key = dimension.key,
    );
    let mut points = Vec::new();
    for row in rows(db, &sql, binds).await? {
        let label: Option<String> = row.try_get("label")?;
        let value: Option<f64> = row.try_get("value")?;
        points.push(point(label, value));
    }
    Ok(points)
}

/// `deskChartData`: one chart's data points; an unknown metric is an empty
/// series.
pub(super) async fn chart_data(
    db: &PgPool,
    query: &ChartQuery,
    now: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let Some(spec) = query.metric.as_deref().and_then(metric_spec) else {
        return Ok(Vec::new());
    };
    let period = resolve_period(db, query.time_range.as_deref(), now).await?;
    match spec.dimension {
        Some(dim) => dimension_data(db, spec, dim, query, period).await,
        None => series_data(db, spec, query, period).await,
    }
}

// ── overview ────────────────────────────────────────────────────────────────

/// The KPI aggregates of one period, as SQL select items suffixed
/// `_<suffix>`.
fn kpi_columns(binds: &mut Binds, period: Period, s: &str) -> String {
    let created = binds.in_period(CREATED, period);
    let resolved_in = binds.in_period(RESOLVED, period);
    let answered = format!(
        "{} and c.first_response_seconds is not null",
        binds.in_period(ANSWERED, period)
    );
    let resolution = format!("{resolved_in} and c.resolution_seconds is not null");
    let rated = format!(
        "{} and c.rating is not null",
        binds.in_period(RATED, period)
    );
    format!(
        "
    count(*) filter (where {created})::int as created_{s},
    count(*) filter (where {resolved_in})::int as resolved_{s},
    count(*) filter (where {answered})::int as answered_{s},
    round(avg(c.first_response_seconds) filter (where {answered}))::int as frt_avg_{s},
    round(percentile_cont(0.5) within group (order by c.first_response_seconds) filter (where {answered}))::int as frt_median_{s},
    count(*) filter (where {resolution})::int as resolutions_{s},
    round(avg(c.resolution_seconds) filter (where {resolution}))::int as res_avg_{s},
    round(percentile_cont(0.5) within group (order by c.resolution_seconds) filter (where {resolution}))::int as res_median_{s},
    count(*) filter (where {rated})::int as ratings_{s},
    round(100.0 * count(*) filter (where {rated} and c.rating >= 4) / nullif(count(*) filter (where {rated}), 0), 1)::float8 as csat_{s},
    round(avg(c.rating) filter (where {rated})::numeric, 2)::float8 as rating_avg_{s}"
    )
}

/// Rows the overview can touch: active in either period, or open now.
fn touched(binds: &mut Binds, since: i64) -> String {
    let at = binds.ts(since);
    format!(
        "(c.state = 'open' or c.created_at >= {at} or c.resolved_at >= {at} or c.first_response_at >= {at} or c.rated_at >= {at})"
    )
}

#[derive(Clone, Copy)]
enum Group {
    Assignee,
    Team,
}

async fn people(db: &PgPool, period: Period, group: Group) -> Result<Vec<Value>, sqlx::Error> {
    let mut binds = Binds::default();
    let created = binds.in_period(CREATED, period);
    let resolved_in = binds.in_period(RESOLVED, period);
    let answered_in = binds.in_period(ANSWERED, period);
    let answered = format!("{answered_in} and c.first_response_seconds is not null");
    let resolution = format!("{resolved_in} and c.resolution_seconds is not null");
    let rated_in = binds.in_period(RATED, period);
    let rated = format!("{rated_in} and c.rating is not null");
    let dimension = dimension(match group {
        Group::Assignee => Dim::Assignee,
        Group::Team => Dim::Team,
    });
    let sql = format!(
        "select {key} as id, {label} as name,
        count(*) filter (where {created})::int as created,
        count(*) filter (where {resolved_in})::int as resolved,
        round(avg(c.first_response_seconds) filter (where {answered}))::int as frt_avg,
        round(avg(c.resolution_seconds) filter (where {resolution}))::int as res_avg,
        count(*) filter (where {rated})::int as ratings,
        round(100.0 * count(*) filter (where {rated} and c.rating >= 4) / nullif(count(*) filter (where {rated}), 0), 1)::float8 as csat
      from desk_conversations c {join}
      where ({created} or {resolved_in} or {answered_in} or {rated_in})
      group by {key}
      order by 4 desc, 3 desc, 2 asc
      limit {PEOPLE_LIMIT}",
        key = dimension.key,
        label = dimension.label,
        join = dimension.join.unwrap_or_default(),
    );
    let mut out = Vec::new();
    for row in rows(db, &sql, binds).await? {
        let id: Option<String> = row.try_get("id")?;
        let name: Option<String> = row.try_get("name")?;
        out.push(json!({
            "id": id,
            "name": name.unwrap_or_default(),
            "created": row.try_get::<Option<i32>, _>("created")?.unwrap_or_default(),
            "resolved": row.try_get::<Option<i32>, _>("resolved")?.unwrap_or_default(),
            "firstResponseAvg": opt_int(row.try_get("frt_avg")?),
            "resolutionAvg": opt_int(row.try_get("res_avg")?),
            "ratings": row.try_get::<Option<i32>, _>("ratings")?.unwrap_or_default(),
            "csat": opt_num(row.try_get("csat")?),
        }));
    }
    Ok(out)
}

async fn counts_by(db: &PgPool, period: Period, column: &str) -> Result<Vec<Value>, sqlx::Error> {
    let mut binds = Binds::default();
    let in_period = binds.in_period(CREATED, period);
    let sql = format!(
        "select {column} as key, count(*)::int as count
      from desk_conversations c
      where {in_period}
      group by 1
      order by 2 desc, 1 asc"
    );
    let mut out = Vec::new();
    for row in rows(db, &sql, binds).await? {
        let key: Option<String> = row.try_get("key")?;
        let count: Option<i32> = row.try_get("count")?;
        out.push(json!({ "key": key.unwrap_or_default(), "count": count.unwrap_or_default() }));
    }
    Ok(out)
}

pub(super) fn int(row: Option<&PgRow>, column: &str) -> Result<i32, sqlx::Error> {
    row.map_or(Ok(None), |row| row.try_get::<Option<i32>, _>(column))
        .map(Option::unwrap_or_default)
}

pub(super) fn int_or_null(row: Option<&PgRow>, column: &str) -> Result<Value, sqlx::Error> {
    row.map_or(Ok(None), |row| row.try_get::<Option<i32>, _>(column))
        .map(opt_int)
}

pub(super) fn float_or_null(row: Option<&PgRow>, column: &str) -> Result<Value, sqlx::Error> {
    row.map_or(Ok(None), |row| row.try_get::<Option<f64>, _>(column))
        .map(opt_num)
}

pub(super) fn pair(value: Value, previous: Value) -> Value {
    let mut out = Map::new();
    out.insert("value".to_owned(), value);
    out.insert("previous".to_owned(), previous);
    Value::Object(out)
}

/// `deskReportsOverview`.
#[allow(clippy::too_many_lines)] // one statement per block of the overview
pub(super) async fn overview(
    db: &PgPool,
    range: Option<&str>,
    now: i64,
) -> Result<Value, sqlx::Error> {
    let period = resolve_period(db, range, now).await?;
    let previous = previous_of(period);
    let unit = overview_unit(period);

    let mut binds = Binds::default();
    let current = kpi_columns(&mut binds, period, "cur");
    let before = kpi_columns(&mut binds, previous, "prev");
    let touched_rows = touched(&mut binds, previous.start);
    let totals_sql = format!(
        "select {current}, {before},
          count(*) filter (where c.state = 'open')::int as open,
          count(*) filter (where c.state = 'open' and c.assignee_id is null)::int as unassigned,
          count(*) filter (where c.state = 'open' and c.waiting_since is not null)::int as waiting
        from desk_conversations c
        where {touched_rows}"
    );
    let totals = rows(db, &totals_sql, binds).await?;

    let mut binds = Binds::default();
    let in_period = binds.in_period("s.started_at", period);
    let in_period_met = binds.in_period("s.started_at", period);
    let in_previous = binds.in_period("s.started_at", previous);
    let in_previous_met = binds.in_period("s.started_at", previous);
    let since = binds.ts(previous.start);
    let until = binds.ts(period.end);
    let sla_sql = format!(
        "select met_cur, breached_cur,
          round(100.0 * met_cur / nullif(met_cur + breached_cur, 0), 1)::float8 as rate_cur,
          round(100.0 * met_prev / nullif(met_prev + breached_prev, 0), 1)::float8 as rate_prev
        from (
          select
            count(*) filter (where {in_period} and s.status = 'completed' and s.breached_at is null)::int as met_cur,
            count(*) filter (where {in_period_met} and s.breached_at is not null)::int as breached_cur,
            count(*) filter (where {in_previous} and s.status = 'completed' and s.breached_at is null)::int as met_prev,
            count(*) filter (where {in_previous_met} and s.breached_at is not null)::int as breached_prev
          from desk_sla_clocks s
          where s.started_at >= {since} and s.started_at < {until}
        ) clocks"
    );
    let sla = rows(db, &sla_sql, binds).await?;

    let mut binds = Binds::default();
    let buckets = binds.buckets(unit, period);
    let created_in = binds.in_period(CREATED, period);
    let resolved_in = binds.in_period(RESOLVED, period);
    let answered_in = binds.in_period(ANSWERED, period);
    let series_sql = format!(
        "with {buckets},
        created as (
          select {created_bucket} as bucket, count(*)::int as n
          from desk_conversations c where {created_in} group by 1
        ),
        resolved as (
          select {resolved_bucket} as bucket, count(*)::int as n,
            round(avg(c.resolution_seconds))::int as avg
          from desk_conversations c where {resolved_in} group by 1
        ),
        answered as (
          select {answered_bucket} as bucket, round(avg(c.first_response_seconds))::int as avg
          from desk_conversations c
          where {answered_in} and c.first_response_seconds is not null
          group by 1
        )
        select {label} as label,
          coalesce(cr.n, 0) as created, coalesce(rs.n, 0) as resolved,
          an.avg as frt_avg, rs.avg as res_avg
        from buckets b
        left join created cr on cr.bucket = b.bucket
        left join resolved rs on rs.bucket = b.bucket
        left join answered an on an.bucket = b.bucket
        order by b.bucket",
        created_bucket = trunc(unit, CREATED),
        resolved_bucket = trunc(unit, RESOLVED),
        answered_bucket = trunc(unit, ANSWERED),
        label = label_of(unit, "b.bucket"),
    );
    let series_rows = rows(db, &series_sql, binds).await?;

    let by_channel = counts_by(db, period, "c.channel").await?;
    let by_priority = counts_by(db, period, "coalesce(c.priority, 'none')").await?;
    let agents = people(db, period, Group::Assignee).await?;
    let teams = people(db, period, Group::Team).await?;

    let t = totals.first();
    let sla = sla.first();
    let mut series = Vec::new();
    for row in &series_rows {
        let label: Option<String> = row.try_get("label")?;
        series.push(json!({
            "label": label.unwrap_or_default(),
            "created": row.try_get::<Option<i32>, _>("created")?.unwrap_or_default(),
            "resolved": row.try_get::<Option<i32>, _>("resolved")?.unwrap_or_default(),
            "firstResponseAvg": opt_int(row.try_get("frt_avg")?),
            "resolutionAvg": opt_int(row.try_get("res_avg")?),
        }));
    }

    Ok(json!({
        "range": {
            "key": period.range,
            "start": date_key(period.start),
            "end": date_key(period.end),
            "bucket": unit.name(),
        },
        "kpis": {
            "created": pair(int(t, "created_cur")?.into(), int(t, "created_prev")?.into()),
            "resolved": pair(int(t, "resolved_cur")?.into(), int(t, "resolved_prev")?.into()),
            "firstResponseAvg": pair(int_or_null(t, "frt_avg_cur")?, int_or_null(t, "frt_avg_prev")?),
            "firstResponseMedian": pair(int_or_null(t, "frt_median_cur")?, int_or_null(t, "frt_median_prev")?),
            "resolutionAvg": pair(int_or_null(t, "res_avg_cur")?, int_or_null(t, "res_avg_prev")?),
            "resolutionMedian": pair(int_or_null(t, "res_median_cur")?, int_or_null(t, "res_median_prev")?),
            "slaCompliance": pair(float_or_null(sla, "rate_cur")?, float_or_null(sla, "rate_prev")?),
            "csat": pair(float_or_null(t, "csat_cur")?, float_or_null(t, "csat_prev")?),
        },
        "backlog": {
            "open": int(t, "open")?,
            "unassigned": int(t, "unassigned")?,
            "waiting": int(t, "waiting")?,
        },
        "counts": {
            "firstResponses": int(t, "answered_cur")?,
            "resolutions": int(t, "resolutions_cur")?,
            "slaMet": int(sla, "met_cur")?,
            "slaBreached": int(sla, "breached_cur")?,
            "ratings": int(t, "ratings_cur")?,
            "ratingAverage": float_or_null(t, "rating_avg_cur")?,
        },
        "series": series,
        "byChannel": by_channel,
        "byPriority": by_priority,
        "agents": agents,
        "teams": teams,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-03-15T12:00:00Z, a Sunday.
    const NOW: i64 = 1_773_576_000_000;

    #[test]
    fn periods_are_whole_utc_days() {
        let p = period_of("last_7_days", NOW, None);
        assert_eq!(date_key(p.start), "2026-03-09");
        assert_eq!(date_key(p.end), "2026-03-16");
        let p = period_of("this_quarter", NOW, None);
        assert_eq!(date_key(p.start), "2026-01-01");
        let p = period_of("last_year", NOW, None);
        assert_eq!(date_key(p.start), "2025-01-01");
        assert_eq!(date_key(p.end), "2026-01-01");
        let p = previous_of(period_of("last_7_days", NOW, None));
        assert_eq!(date_key(p.start), "2026-03-02");
        assert_eq!(date_key(p.end), "2026-03-09");
        assert_eq!(range_of(Some("next_decade")), "last_30_days");
    }

    #[test]
    fn units_get_coarser_to_fit() {
        let p = period_of("last_365_days", NOW, None);
        assert_eq!(unit_of(Some("hour"), p), Unit::Day);
        assert_eq!(unit_of(Some("week"), p), Unit::Week);
        assert_eq!(unit_of(None, p), Unit::Day);
        assert_eq!(overview_unit(p), Unit::Week);
    }

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(js_num(50.0).to_string(), "50");
        assert_eq!(js_num(66.7).to_string(), "66.7");
        assert_eq!(limit_of(Some(&json!("5"))), Some(5));
        assert_eq!(limit_of(Some(&json!(5000))), Some(1000));
        assert_eq!(limit_of(Some(&json!(1.5))), None);
        assert_eq!(limit_of(Some(&json!(0))), None);
    }
}
