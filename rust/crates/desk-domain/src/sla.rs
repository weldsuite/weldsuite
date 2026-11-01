//! The WeldDesk SLA engine (`@weldsuite/db/lib/desk-sla`,
//! `packages/core/db/src/lib/desk-sla.ts`).
//!
//! Every clock is derived from two things that are always in the tenant
//! database: the conversation's timeline (`desk_messages`) and the SLA
//! policy that matches its ticket fields (`helpdesk_slas`). [`refresh`]
//! replays the timeline under the policy's targets and calendar, stores the
//! result in `desk_sla_clocks` and a summary on `desk_conversations`, and is
//! the only writer of both. Because a clock can always be rebuilt, every
//! writer can just call it again.
//!
//! Rules (as in TypeScript):
//!   - first_response: from the visitor's first message to the first agent
//!     reply. A conversation the team started has none.
//!   - next_response: from a visitor message that follows an agent reply to
//!     the next agent reply; restarts every cycle (the policy's `updateTime`).
//!   - resolution: from the first message to the close. It pauses while the
//!     team has answered and waits on the customer, and resumes when the
//!     customer writes. A reopen resumes it.
//!   - Closing stops the reply clocks without meeting them (cancelled).
//!   - Bot and system messages never meet or pause a clock.
//!   - Time counts on the policy's calendar ([`crate::sla_calendar`]).
//!
//! Scheduling (ADR DATA-008): `next_check_at` on a clock says when the sweep
//! has to look again. Writers copy the earliest one into the due index (kind
//! [`DUE_KIND`], `weldsuite_db::due_index`); desk-api's sweep opens only due
//! workspaces and calls [`refresh`] with `acknowledge`, which returns the
//! warnings and breaches to announce.
//!
//! Instants are JavaScript time values (milliseconds). Stored policy JSON is
//! read with JavaScript's coercions; where TypeScript would throw on a
//! malformed value (a `conditions` that is not an array), [`SlaError::Malformed`]
//! is returned instead, and callers treat it as TypeScript treats the throw.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::js_number_of;

use crate::sla_calendar::{SlaCalendar, add_business_ms, business_ms_between, iso, to_calendar};
use crate::table::WriteError;
use crate::webchat::DESK_CONVERSATIONS;
use crate::workflow::shared::js_string;

/// The due index kind the SLA sweep keeps (`desk_sla`).
pub const DUE_KIND: &str = "desk_sla";

const MINUTE_MS: f64 = 60_000.0;

/// Share of the target after which agents are warned when the policy sets no reminder.
const DEFAULT_WARN_SHARE: f64 = 0.75;

/// `DeskSlaMetric`, in `DESK_SLA_METRICS` order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Metric {
    FirstResponse,
    NextResponse,
    Resolution,
}

impl Metric {
    pub const ALL: [Self; 3] = [Self::FirstResponse, Self::NextResponse, Self::Resolution];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::FirstResponse => "first_response",
            Self::NextResponse => "next_response",
            Self::Resolution => "resolution",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|m| m.as_str() == text)
    }
}

/// `DeskSlaClockStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockStatus {
    Running,
    Paused,
    Completed,
    Cancelled,
}

impl ClockStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Why the engine could not derive the clocks.
#[derive(Debug)]
pub enum SlaError {
    /// A stored value TypeScript would throw on (`conditions` that is not an array).
    Malformed(&'static str),
    Write(WriteError),
}

impl From<sqlx::Error> for SlaError {
    fn from(error: sqlx::Error) -> Self {
        Self::Write(WriteError::Database(error))
    }
}

impl From<WriteError> for SlaError {
    fn from(error: WriteError) -> Self {
        Self::Write(error)
    }
}

impl std::fmt::Display for SlaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(what) => write!(f, "malformed SLA policy: {what}"),
            Self::Write(error) => error.fmt(f),
        }
    }
}

// ── JavaScript semantics ────────────────────────────────────────────────────

/// `Math.round(x)`: halves round up.
pub fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

fn is_nullish(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

/// `(value ?? [])` used as an array: a value that is neither nullish nor an
/// array makes TypeScript's `.filter` / `.find` / `.every` throw.
fn list<'a>(value: Option<&'a Value>, what: &'static str) -> Result<&'a [Value], SlaError> {
    match value {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(SlaError::Malformed(what)),
    }
}

/// `item.field` on an array element: `null` makes TypeScript throw; any
/// other non-object has no fields.
fn field<'a>(item: &'a Value, key: &str, what: &'static str) -> Result<Option<&'a Value>, SlaError> {
    match item {
        Value::Null => Err(SlaError::Malformed(what)),
        Value::Object(fields) => Ok(fields.get(key)),
        _ => Ok(None),
    }
}

/// A JSON number as JavaScript would hand it to Postgres (`60`, not `60.0`).
#[allow(clippy::cast_possible_truncation)]
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// A `Date` column read back as a time value (ISO text from a JS row).
pub fn time_value(value: Option<&Value>) -> Option<i64> {
    let text = value?.as_str()?;
    let text = weldsuite_db::js_timestamp(text).unwrap_or_else(|| text.to_owned());
    text.parse::<jiff::Timestamp>()
        .ok()
        .map(jiff::Timestamp::as_millisecond)
}

fn date_json(at: Option<i64>) -> Value {
    at.map_or(Value::Null, |ms| Value::String(iso(ms)))
}

// ── Policy selection ────────────────────────────────────────────────────────

/// A `helpdesk_slas` row, as `selectDeskSlaPolicy` reads it.
#[derive(Debug, Clone)]
pub struct Policy {
    pub id: String,
    /// `createdAt.getTime()`.
    pub created_at: i64,
    /// `priority ?? 0`.
    pub priority: f64,
    pub is_default: bool,
    pub is_active: bool,
    pub deleted: bool,
    pub conditions: Value,
    pub first_response_time: Value,
    pub resolution_time: Value,
    pub update_time: Value,
    pub operational_hours: Value,
    pub business_hours: Value,
    pub reminders: Value,
}

impl Policy {
    /// From the row as Drizzle returns it (`createdAt` ISO, or a time value).
    pub fn from_js(row: &Value) -> Self {
        let get = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
        let created_at = match row.get("createdAt") {
            Some(Value::Number(n)) => n.as_i64().unwrap_or_default(),
            other => time_value(other).unwrap_or_default(),
        };
        Self {
            id: row["id"].as_str().unwrap_or_default().to_owned(),
            created_at,
            priority: row
                .get("priority")
                .and_then(Value::as_f64)
                .unwrap_or_default(),
            is_default: truthy(row.get("isDefault")),
            is_active: row.get("isActive").is_none_or(|v| truthy(Some(v))),
            deleted: truthy(row.get("deletedAt")),
            conditions: get("conditions"),
            first_response_time: get("firstResponseTime"),
            resolution_time: get("resolutionTime"),
            update_time: get("updateTime"),
            operational_hours: get("operationalHours"),
            business_hours: get("businessHours"),
            reminders: get("reminders"),
        }
    }
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: Option<&Value>) -> bool {
    crate::workflow::shared::truthy(value)
}

/// `CONDITION_FIELDS`: the conversation property a condition field reads.
fn condition_field(field: &str) -> Option<&'static str> {
    Some(match field {
        "priority" => "priority",
        "channel" => "channel",
        "ticketTypeId" | "ticketType" | "type" => "ticketTypeId",
        "departmentId" | "department" | "teamId" | "team" => "departmentId",
        "tags" | "tag" => "tags",
        "assigneeId" | "assignee" => "assigneeId",
        "email" => "email",
        _ => return None,
    })
}

/// `same(a, b)`: case-insensitive equality of `String()`s; nullish only
/// equals nullish.
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    if is_nullish(a) || is_nullish(b) {
        return is_nullish(a) && is_nullish(b);
    }
    js_string(a).to_lowercase() == js_string(b).to_lowercase()
}

/// `rankOf(field, value)`.
fn rank_of(field: &str, value: Option<&Value>) -> f64 {
    if field == "priority" {
        let key = if is_nullish(value) {
            String::new()
        } else {
            js_string(value).to_lowercase()
        };
        return match key.as_str() {
            "low" => 1.0,
            "medium" => 2.0,
            "high" => 3.0,
            "urgent" => 4.0,
            "critical" => 5.0,
            _ => 0.0,
        };
    }
    let n = js_number_of(value);
    if n.is_finite() { n } else { f64::NAN }
}

/// `String(value ?? '')`.
fn string_or_empty(value: Option<&Value>) -> String {
    if is_nullish(value) {
        String::new()
    } else {
        js_string(value)
    }
}

/// `conditionHolds(condition, conversation)`.
fn condition_holds(condition: &Value, conversation: &Value) -> Result<bool, SlaError> {
    let field_name = field(condition, "field", "condition")?;
    // A condition the engine can't evaluate (a legacy ticket field) never matches.
    let Some(field_name) = field_name.and_then(Value::as_str) else {
        return Ok(false);
    };
    let Some(property) = condition_field(field_name) else {
        return Ok(false);
    };
    let actual = conversation.get(property);
    let value = field(condition, "value", "condition")?;
    let expected: Vec<Option<&Value>> = match value {
        Some(Value::Array(items)) => items.iter().map(Some).collect(),
        other => vec![other],
    };
    let equals = match actual {
        Some(Value::Array(items)) => expected
            .iter()
            .any(|v| items.iter().any(|a| same(Some(a), *v))),
        _ => expected.iter().any(|v| same(actual, *v)),
    };
    let operator = field(condition, "operator", "condition")?;
    Ok(match operator.and_then(Value::as_str) {
        Some("equals") => equals,
        Some("not_equals") => !equals,
        Some("contains") => match actual {
            Some(Value::Array(_)) => equals,
            _ => {
                let haystack = string_or_empty(actual).to_lowercase();
                expected
                    .iter()
                    .any(|v| haystack.contains(&string_or_empty(*v).to_lowercase()))
            }
        },
        Some("greater_than") => rank_of(field_name, actual) > rank_of(field_name, value),
        Some("less_than") => rank_of(field_name, actual) < rank_of(field_name, value),
        _ => false,
    })
}

/// `selectDeskSlaPolicy(candidates, conversation)`: the first active policy
/// (by `priority`, lowest first, then oldest) whose conditions all hold,
/// else the default policy. A non-default policy without conditions
/// matches everything.
pub fn select_policy<'a>(
    candidates: &'a [Policy],
    conversation: &Value,
) -> Result<Option<&'a Policy>, SlaError> {
    let mut active: Vec<&Policy> = candidates
        .iter()
        .filter(|p| p.is_active && !p.deleted)
        .collect();
    active.sort_by(|a, b| {
        a.priority
            .partial_cmp(&b.priority)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.created_at.cmp(&b.created_at))
    });
    for policy in &active {
        if policy.is_default {
            continue;
        }
        let mut holds = true;
        for condition in list(Some(&policy.conditions), "conditions")? {
            if !condition_holds(condition, conversation)? {
                holds = false;
                break;
            }
        }
        if holds {
            return Ok(Some(policy));
        }
    }
    Ok(active.into_iter().find(|p| p.is_default))
}

/// `DeskSlaTarget`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Target {
    pub target_minutes: f64,
    pub warn_before_minutes: Option<f64>,
}

/// `warnBeforeFor(policy, target)`.
fn warn_before_for(policy: &Policy, target: &Value) -> Result<Option<f64>, SlaError> {
    let mut reminders = Vec::new();
    for reminder in list(Some(&policy.reminders), "reminders")? {
        let kind = field(reminder, "type", "reminder")?;
        let time = field(reminder, "time", "reminder")?;
        if kind.and_then(Value::as_str) == Some("before_breach") && js_number_of(time) > 0.0 {
            reminders.push(js_number_of(time));
        }
    }
    let mut shares = Vec::new();
    for share in list(target.get("notifyAt"), "notifyAt")? {
        let n = js_number_of(Some(share));
        if n > 0.0 && n < 100.0 {
            shares.push(n);
        }
    }
    let time = js_number_of(target.get("time"));
    let before = if !reminders.is_empty() {
        reminders.into_iter().fold(f64::NEG_INFINITY, f64::max)
    } else if !shares.is_empty() {
        let min = shares.into_iter().fold(f64::INFINITY, f64::min);
        js_round((time * (100.0 - min)) / 100.0)
    } else {
        js_round(time * (1.0 - DEFAULT_WARN_SHARE))
    };
    Ok((before > 0.0 && before < time).then_some(before))
}

/// `deskSlaTargets(policy, priority)`: targets per metric for a
/// conversation's priority (`medium` when it has none).
pub fn targets(
    policy: &Policy,
    priority: Option<&Value>,
) -> Result<Vec<(Metric, Target)>, SlaError> {
    let wanted = match priority {
        None | Some(Value::Null) => Value::String("medium".to_owned()),
        Some(value) => value.clone(),
    };
    let pick = |list_value: &Value, what: &'static str| -> Result<Option<Target>, SlaError> {
        for target in list(Some(list_value), what)? {
            let priority = field(target, "priority", what)?;
            let time = field(target, "time", what)?;
            if priority == Some(&wanted) && js_number_of(time) > 0.0 {
                return Ok(Some(Target {
                    target_minutes: js_round(js_number_of(time)),
                    warn_before_minutes: warn_before_for(policy, target)?,
                }));
            }
        }
        Ok(None)
    };
    let mut out = Vec::new();
    let first = pick(&policy.first_response_time, "firstResponseTime")?;
    let next = pick(&policy.update_time, "updateTime")?;
    let resolution = pick(&policy.resolution_time, "resolutionTime")?;
    if let Some(target) = first {
        out.push((Metric::FirstResponse, target));
    }
    if let Some(target) = next {
        out.push((Metric::NextResponse, target));
    }
    if let Some(target) = resolution {
        out.push((Metric::Resolution, target));
    }
    Ok(out)
}

/// `deskSlaBusinessHours(policy, workspaceHours)`: the calendar a policy
/// counts on; `Null` = 24x7.
pub fn business_hours(policy: &Policy, workspace_hours: &Value) -> Value {
    match policy.operational_hours.as_str() {
        Some("24x7") => Value::Null,
        Some("custom") => policy.business_hours.clone(),
        _ if !policy.business_hours.is_null() => policy.business_hours.clone(),
        _ => workspace_hours.clone(),
    }
}

// ── Timeline replay ─────────────────────────────────────────────────────────

/// `DeskSlaTimelineEntry`.
#[derive(Debug, Clone)]
pub struct TimelineEntry {
    pub at: i64,
    pub kind: String,
    pub author_type: String,
    pub event_type: Option<String>,
}

/// `DerivedDeskSlaClock`.
#[derive(Debug, Clone, PartialEq)]
pub struct DerivedClock {
    pub metric: Metric,
    pub status: ClockStatus,
    pub target_minutes: f64,
    pub warn_before_minutes: Option<f64>,
    pub started_at: i64,
    pub elapsed_seconds: i64,
    pub due_at: Option<i64>,
    pub warn_at: Option<i64>,
    pub breached_at: Option<i64>,
    pub completed_at: Option<i64>,
}

/// One clock while the timeline is replayed (`ReplayClock`).
struct ReplayClock<'c> {
    metric: Metric,
    target: Target,
    started_at: i64,
    calendar: Option<&'c SlaCalendar>,
    status: ClockStatus,
    /// Business milliseconds counted so far.
    elapsed: i64,
    running_since: Option<i64>,
    warn_reached_at: Option<i64>,
    breached_at: Option<i64>,
    completed_at: Option<i64>,
}

impl<'c> ReplayClock<'c> {
    fn new(metric: Metric, target: Target, at: i64, calendar: Option<&'c SlaCalendar>) -> Self {
        Self {
            metric,
            target,
            started_at: at,
            calendar,
            status: ClockStatus::Running,
            elapsed: 0,
            running_since: Some(at),
            warn_reached_at: None,
            breached_at: None,
            completed_at: None,
        }
    }

    fn target_ms(&self) -> f64 {
        self.target.target_minutes * MINUTE_MS
    }

    /// Elapsed time at which the warning comes due.
    fn warn_after_ms(&self) -> Option<f64> {
        self.target
            .warn_before_minutes
            .map(|before| self.target_ms() - before * MINUTE_MS)
    }

    fn running(&self) -> bool {
        self.status == ClockStatus::Running
    }

    /// Count the business time up to `at`, noting when the warning and
    /// breach points were passed.
    #[allow(clippy::cast_precision_loss)]
    fn advance(&mut self, at: i64) {
        let Some(since) = self.running_since.filter(|_| self.running()) else {
            return;
        };
        let segment = business_ms_between(self.calendar, since, at);
        let reached = (self.elapsed + segment) as f64;
        if let Some(warn_after) = self.warn_after_ms()
            && self.warn_reached_at.is_none()
            && reached >= warn_after
        {
            self.warn_reached_at = Some(add_business_ms(
                self.calendar,
                since,
                warn_after - self.elapsed as f64,
            ));
        }
        if self.breached_at.is_none() && reached > self.target_ms() {
            self.breached_at = Some(add_business_ms(
                self.calendar,
                since,
                self.target_ms() - self.elapsed as f64,
            ));
        }
        self.elapsed += segment;
        self.running_since = Some(at);
    }

    fn stop(&mut self, at: i64, status: ClockStatus) {
        if !self.running() {
            return;
        }
        self.advance(at);
        self.status = status;
        self.running_since = None;
        if status != ClockStatus::Paused {
            self.completed_at = Some(at);
        }
    }

    fn resume(&mut self, at: i64) {
        if self.running() {
            return;
        }
        self.status = ClockStatus::Running;
        self.running_since = Some(at);
        self.completed_at = None;
    }

    /// Close: a clock waiting on the customer is done as it stands.
    fn finish(&mut self, at: i64) {
        if self.status == ClockStatus::Paused {
            self.status = ClockStatus::Completed;
            self.completed_at = Some(at);
        } else {
            self.stop(at, ClockStatus::Completed);
        }
    }

    /// Reopened by the team: waiting on the customer until they write.
    fn reopen(&mut self) {
        if self.status != ClockStatus::Completed {
            return;
        }
        self.status = ClockStatus::Paused;
        self.completed_at = None;
    }

    #[allow(clippy::cast_precision_loss)]
    fn derived(&mut self, now: i64) -> DerivedClock {
        let running = self.running();
        if running {
            self.advance(now);
        }
        let (mut due_at, mut warn_at) = (None, None);
        if running {
            due_at = Some(self.breached_at.unwrap_or_else(|| {
                add_business_ms(self.calendar, now, self.target_ms() - self.elapsed as f64)
            }));
            if let Some(warn_after) = self.warn_after_ms() {
                warn_at = Some(self.warn_reached_at.unwrap_or_else(|| {
                    add_business_ms(self.calendar, now, warn_after - self.elapsed as f64)
                }));
            }
        }
        DerivedClock {
            metric: self.metric,
            status: self.status,
            target_minutes: self.target.target_minutes,
            warn_before_minutes: self.target.warn_before_minutes,
            started_at: self.started_at,
            elapsed_seconds: self.elapsed.div_euclid(1000),
            due_at,
            warn_at,
            breached_at: self.breached_at,
            completed_at: self.completed_at,
        }
    }
}

/// The conversation as the replay walks its timeline (`SlaReplay`).
struct Replay<'c> {
    targets: &'c [(Metric, Target)],
    calendar: Option<&'c SlaCalendar>,
    clocks: Vec<ReplayClock<'c>>,
    open: bool,
    first_response_started: bool,
    agent_replied: bool,
}

impl<'c> Replay<'c> {
    fn clock(&mut self, metric: Metric) -> Option<&mut ReplayClock<'c>> {
        self.clocks.iter_mut().find(|c| c.metric == metric)
    }

    fn start(&mut self, metric: Metric, at: i64) -> bool {
        let Some((_, target)) = self.targets.iter().find(|(m, _)| *m == metric) else {
            return false;
        };
        let clock = ReplayClock::new(metric, *target, at, self.calendar);
        match self.clocks.iter_mut().find(|c| c.metric == metric) {
            Some(existing) => *existing = clock,
            None => self.clocks.push(clock),
        }
        true
    }

    /// The running reply clock (first or next response), if any.
    fn reply_clock(&mut self) -> Option<&mut ReplayClock<'c>> {
        let metric = [Metric::FirstResponse, Metric::NextResponse]
            .into_iter()
            .find(|m| {
                self.clocks
                    .iter()
                    .any(|c| c.metric == *m && c.running())
            })?;
        self.clock(metric)
    }

    fn apply(&mut self, entry: &TimelineEntry) {
        match (entry.kind.as_str(), entry.author_type.as_str()) {
            ("message", "visitor") => self.visitor_message(entry.at),
            ("message", "agent") => self.agent_message(entry.at),
            ("event", _) => match entry.event_type.as_deref() {
                Some("closed") => self.closed(entry.at),
                Some("reopened") => self.reopened(),
                _ => {}
            },
            _ => {}
        }
    }

    fn visitor_message(&mut self, at: i64) {
        self.open = true;
        if self.reply_clock().is_none() {
            let first = !self.first_response_started && !self.agent_replied;
            self.first_response_started = true;
            self.start(
                if first {
                    Metric::FirstResponse
                } else {
                    Metric::NextResponse
                },
                at,
            );
        }
        match self.clock(Metric::Resolution) {
            Some(resolution) => resolution.resume(at),
            None => {
                self.start(Metric::Resolution, at);
            }
        }
    }

    fn agent_message(&mut self, at: i64) {
        self.agent_replied = true;
        self.first_response_started = true;
        if let Some(reply) = self.reply_clock() {
            reply.stop(at, ClockStatus::Completed);
        }
        if !self.open {
            return;
        }
        if self.clock(Metric::Resolution).is_none() {
            self.start(Metric::Resolution, at);
        }
        if let Some(resolution) = self.clock(Metric::Resolution) {
            resolution.stop(at, ClockStatus::Paused);
        }
    }

    fn closed(&mut self, at: i64) {
        self.open = false;
        if let Some(reply) = self.reply_clock() {
            reply.stop(at, ClockStatus::Cancelled);
        }
        if let Some(resolution) = self.clock(Metric::Resolution) {
            resolution.finish(at);
        }
    }

    fn reopened(&mut self) {
        self.open = true;
        if let Some(resolution) = self.clock(Metric::Resolution) {
            resolution.reopen();
        }
    }
}

/// `deriveDeskSlaClocks({ timeline, targets, calendar, now })`: replay a
/// conversation's timeline (oldest first) and return each clock as it
/// stands at `now`, in metric order. Pure.
pub fn derive_clocks(
    timeline: &[TimelineEntry],
    targets: &[(Metric, Target)],
    calendar: Option<&SlaCalendar>,
    now: i64,
) -> Vec<DerivedClock> {
    let mut replay = Replay {
        targets,
        calendar,
        clocks: Vec::new(),
        open: true,
        first_response_started: false,
        agent_replied: false,
    };
    for entry in timeline {
        replay.apply(entry);
    }
    let mut derived: Vec<DerivedClock> = replay
        .clocks
        .iter_mut()
        .map(|clock| clock.derived(now))
        .collect();
    derived.sort_by_key(|clock| clock.metric);
    derived
}

// ── Summary + scheduling ────────────────────────────────────────────────────

/// A clock row (`DeskSlaClock`).
#[derive(Debug, Clone, PartialEq)]
pub struct ClockRow {
    pub id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub conversation_id: String,
    pub metric: Metric,
    pub policy_id: Option<String>,
    pub target_minutes: f64,
    pub warn_before_minutes: Option<f64>,
    pub calendar: Value,
    pub status: ClockStatus,
    pub started_at: i64,
    pub elapsed_seconds: i64,
    pub due_at: Option<i64>,
    pub warn_at: Option<i64>,
    pub breached_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub warned_at: Option<i64>,
    pub breach_notified_at: Option<i64>,
    pub next_check_at: Option<i64>,
}

impl ClockRow {
    /// The row as `{ column: value }` for `jsonb_populate_recordset`.
    fn columns(&self) -> Value {
        json!({
            "id": self.id,
            "created_at": iso(self.created_at),
            "updated_at": iso(self.updated_at),
            "conversation_id": self.conversation_id,
            "metric": self.metric.as_str(),
            "policy_id": self.policy_id,
            "target_minutes": number(self.target_minutes),
            "warn_before_minutes": self.warn_before_minutes.map(number),
            "calendar": self.calendar,
            "status": self.status.as_str(),
            "started_at": iso(self.started_at),
            "elapsed_seconds": self.elapsed_seconds,
            "due_at": date_json(self.due_at),
            "warn_at": date_json(self.warn_at),
            "breached_at": date_json(self.breached_at),
            "completed_at": date_json(self.completed_at),
            "warned_at": date_json(self.warned_at),
            "breach_notified_at": date_json(self.breach_notified_at),
            "next_check_at": date_json(self.next_check_at),
        })
    }
}

/// The times `deskSlaNextCheckAt` and `summarizeDeskSla` read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockTimes {
    pub metric: Metric,
    pub status: ClockStatus,
    pub due_at: Option<i64>,
    pub warn_at: Option<i64>,
    pub breached_at: Option<i64>,
    pub warned_at: Option<i64>,
    pub breach_notified_at: Option<i64>,
}

impl From<&ClockRow> for ClockTimes {
    fn from(row: &ClockRow) -> Self {
        Self {
            metric: row.metric,
            status: row.status,
            due_at: row.due_at,
            warn_at: row.warn_at,
            breached_at: row.breached_at,
            warned_at: row.warned_at,
            breach_notified_at: row.breach_notified_at,
        }
    }
}

/// `deskSlaNextCheckAt(clock)`: when the sweep must look at a clock again;
/// `None` when there is nothing left to announce.
pub fn next_check_at(clock: &ClockTimes) -> Option<i64> {
    if clock.status != ClockStatus::Running {
        return None;
    }
    if let Some(breached) = clock.breached_at {
        return if clock.breach_notified_at.is_some() {
            None
        } else {
            Some(breached)
        };
    }
    if let (Some(warn), None, Some(due)) = (clock.warn_at, clock.warned_at, clock.due_at) {
        return Some(if warn < due { warn } else { due });
    }
    clock.due_at
}

/// `DeskSlaSummary`: what the inbox shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub status: Option<&'static str>,
    pub due_at: Option<i64>,
    pub metric: Option<Metric>,
}

/// `summarizeDeskSla(rows, now)`.
pub fn summarize(rows: &[ClockTimes], now: i64) -> Summary {
    let mut running: Vec<&ClockTimes> = rows
        .iter()
        .filter(|c| c.status == ClockStatus::Running && c.due_at.is_some())
        .collect();
    running.sort_by_key(|c| c.due_at);
    if let Some(soonest) = running.first() {
        let status = if running
            .iter()
            .any(|c| c.breached_at.is_some_and(|b| b <= now))
        {
            "breached"
        } else if running.iter().any(|c| c.warn_at.is_some_and(|w| w <= now)) {
            "warning"
        } else {
            "active"
        };
        return Summary {
            status: Some(status),
            due_at: soonest.due_at,
            metric: Some(soonest.metric),
        };
    }
    if rows.iter().any(|c| c.status == ClockStatus::Paused) {
        return Summary {
            status: Some("paused"),
            due_at: None,
            metric: None,
        };
    }
    if !rows.is_empty() {
        let status = if rows.iter().any(|c| c.breached_at.is_some()) {
            "breached"
        } else {
            "achieved"
        };
        return Summary {
            status: Some(status),
            due_at: None,
            metric: None,
        };
    }
    Summary {
        status: None,
        due_at: None,
        metric: None,
    }
}

// ── Persistence ─────────────────────────────────────────────────────────────

/// `DeskSlaAlert`: a warning or breach the sweep must announce.
#[derive(Debug, Clone, PartialEq)]
pub struct Alert {
    /// `warning` or `breach`.
    pub kind: &'static str,
    pub metric: Metric,
    pub due_at: Option<i64>,
    pub clock: ClockRow,
}

/// `DeskSlaRefreshResult`.
#[derive(Debug, Clone, Default)]
pub struct Refreshed {
    /// The conversation after the refresh (as Drizzle returns it); `None`
    /// when it no longer exists.
    pub conversation: Option<Value>,
    pub clocks: Vec<ClockRow>,
    /// Earliest `next_check_at` of this conversation's clocks.
    pub next_check_at: Option<i64>,
    /// Only with `acknowledge`: warnings and breaches to announce now.
    pub alerts: Vec<Alert>,
}

/// The conversation [`refresh`] works on.
pub enum ConversationRef<'a> {
    Row(Value),
    Id(&'a str),
}

async fn load_policies(db: &PgPool) -> Result<Vec<Policy>, sqlx::Error> {
    // Times as JavaScript time values: `floor(extract(epoch from t) * 1000)`.
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object(
            'id', id, 'createdAt', floor(extract(epoch from created_at) * 1000)::int8,
            'priority', priority, 'isDefault', is_default,
            'isActive', is_active, 'deletedAt', deleted_at, 'conditions', conditions,
            'firstResponseTime', first_response_time, 'resolutionTime', resolution_time,
            'updateTime', update_time, 'operationalHours', operational_hours,
            'businessHours', business_hours, 'reminders', reminders)
         from helpdesk_slas where is_active = true and deleted_at is null",
    )
    .fetch_all(db)
    .await?;
    Ok(rows.iter().map(Policy::from_js).collect())
}

async fn load_timeline(db: &PgPool, conversation_id: &str) -> Result<Vec<TimelineEntry>, sqlx::Error> {
    let rows: Vec<(i64, String, String, Option<String>)> = sqlx::query_as(
        "select floor(extract(epoch from created_at) * 1000)::int8, kind, author_type,
                metadata->>'eventType'
         from desk_messages where conversation_id = $1 and kind in ('message', 'event')
         order by created_at asc, id asc",
    )
        .bind(conversation_id)
        .fetch_all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(at, kind, author_type, event_type)| TimelineEntry {
            at,
            kind,
            author_type,
            event_type,
        })
        .collect())
}

/// `loadWorkspaceHours(db)`: `helpdesk_settings.general.businessHours`.
async fn load_workspace_hours(db: &PgPool) -> Result<Value, sqlx::Error> {
    let general: Option<Option<Value>> = sqlx::query_scalar(
        "select general from helpdesk_settings where deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    Ok(general
        .flatten()
        .and_then(|g| g.get("businessHours").cloned())
        .unwrap_or(Value::Null))
}

/// A stored clock, as the refresh reads it back.
struct StoredClock {
    id: String,
    created_at: i64,
    metric: String,
    started_at: i64,
    warned_at: Option<i64>,
    breach_notified_at: Option<i64>,
}

async fn load_clocks(db: &PgPool, conversation_id: &str) -> Result<Vec<StoredClock>, sqlx::Error> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, i64, String, i64, Option<i64>, Option<i64>)> = sqlx::query_as(
        "select id, floor(extract(epoch from created_at) * 1000)::int8, metric,
                floor(extract(epoch from started_at) * 1000)::int8,
                floor(extract(epoch from warned_at) * 1000)::int8,
                floor(extract(epoch from breach_notified_at) * 1000)::int8
         from desk_sla_clocks where conversation_id = $1",
    )
        .bind(conversation_id)
        .fetch_all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, created_at, metric, started_at, warned_at, breach_notified_at)| StoredClock {
                id,
                created_at,
                metric,
                started_at,
                warned_at,
                breach_notified_at,
            },
        )
        .collect())
}

/// `sameSummary(conversation, summary, policyId)`.
fn same_summary(conversation: &Value, summary: &Summary, policy_id: Option<&str>) -> bool {
    conversation["slaPolicyId"].as_str() == policy_id
        && conversation["slaStatus"].as_str() == summary.status
        && conversation["slaMetric"].as_str() == summary.metric.map(Metric::as_str)
        && time_value(conversation.get("slaDueAt")) == summary.due_at
}

/// `writeSummary(db, conversation, summary, policyId)`.
async fn write_summary(
    db: &PgPool,
    conversation: Value,
    summary: &Summary,
    policy_id: Option<&str>,
) -> Result<Value, SlaError> {
    if same_summary(&conversation, summary, policy_id) {
        return Ok(conversation);
    }
    let id = conversation["id"].as_str().unwrap_or_default().to_owned();
    let mut values = Map::new();
    values.insert("sla_policy_id".to_owned(), json!(policy_id));
    values.insert("sla_status".to_owned(), json!(summary.status));
    values.insert("sla_due_at".to_owned(), date_json(summary.due_at));
    values.insert(
        "sla_metric".to_owned(),
        json!(summary.metric.map(Metric::as_str)),
    );
    let updated = DESK_CONVERSATIONS
        .patch(db, &id, values, false, &["slaDueAt"])
        .await?;
    Ok(updated.unwrap_or_else(|| {
        let mut merged = conversation;
        merged["slaPolicyId"] = json!(policy_id);
        merged["slaStatus"] = json!(summary.status);
        merged["slaDueAt"] = date_json(summary.due_at);
        merged["slaMetric"] = json!(summary.metric.map(Metric::as_str));
        merged
    }))
}

/// `clearDeskSla(db, conversation)`.
async fn clear(db: &PgPool, conversation: Value) -> Result<Refreshed, SlaError> {
    if truthy(conversation.get("slaPolicyId")) || truthy(conversation.get("slaStatus")) {
        sqlx::query("delete from desk_sla_clocks where conversation_id = $1")
            .bind(conversation["id"].as_str().unwrap_or_default())
            .execute(db)
            .await?;
    }
    let empty = Summary {
        status: None,
        due_at: None,
        metric: None,
    };
    let updated = write_summary(db, conversation, &empty, None).await?;
    Ok(Refreshed {
        conversation: Some(updated),
        ..Refreshed::default()
    })
}

/// Within one cycle an announcement already recorded by a concurrent
/// refresh is kept.
const UPSERT: &str = "insert into desk_sla_clocks as t
        (id, created_at, updated_at, conversation_id, metric, policy_id, target_minutes,
         warn_before_minutes, calendar, status, started_at, elapsed_seconds, due_at, warn_at,
         breached_at, completed_at, warned_at, breach_notified_at, next_check_at)
    select r.id, r.created_at, r.updated_at, r.conversation_id, r.metric, r.policy_id,
           r.target_minutes, r.warn_before_minutes, r.calendar, r.status, r.started_at,
           r.elapsed_seconds, r.due_at, r.warn_at, r.breached_at, r.completed_at, r.warned_at,
           r.breach_notified_at, r.next_check_at
    from jsonb_populate_recordset(null::desk_sla_clocks, $1::jsonb) r
    on conflict (conversation_id, metric) do update set
        updated_at = excluded.updated_at,
        policy_id = excluded.policy_id,
        target_minutes = excluded.target_minutes,
        warn_before_minutes = excluded.warn_before_minutes,
        calendar = excluded.calendar,
        status = excluded.status,
        started_at = excluded.started_at,
        elapsed_seconds = excluded.elapsed_seconds,
        due_at = excluded.due_at,
        warn_at = excluded.warn_at,
        breached_at = excluded.breached_at,
        completed_at = excluded.completed_at,
        warned_at = case when t.started_at = excluded.started_at
            then coalesce(t.warned_at, excluded.warned_at) else excluded.warned_at end,
        breach_notified_at = case when t.started_at = excluded.started_at
            then coalesce(t.breach_notified_at, excluded.breach_notified_at)
            else excluded.breach_notified_at end,
        next_check_at = excluded.next_check_at";

/// `refreshDeskSla(db, conversationOrId, { now, acknowledge })`: re-derive
/// a conversation's SLA clocks from its timeline and the policy that
/// matches it now, and store them with the inbox summary. Safe to call any
/// number of times.
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
pub async fn refresh(
    db: &PgPool,
    conversation: ConversationRef<'_>,
    now: i64,
    acknowledge: bool,
) -> Result<Refreshed, SlaError> {
    let conversation = match conversation {
        ConversationRef::Row(row) => row,
        ConversationRef::Id(id) => {
            let row: Option<Value> = sqlx::query_scalar(
                "select to_jsonb(t) from desk_conversations t where t.id = $1 limit 1",
            )
            .bind(id)
            .fetch_optional(db)
            .await?;
            let Some(row) = row else {
                sqlx::query("delete from desk_sla_clocks where conversation_id = $1")
                    .bind(id)
                    .execute(db)
                    .await?;
                return Ok(Refreshed::default());
            };
            DESK_CONVERSATIONS.js(row)
        }
    };
    let conversation_id = conversation["id"].as_str().unwrap_or_default().to_owned();

    let candidates = load_policies(db).await?;
    let Some(policy) = select_policy(&candidates, &conversation)? else {
        return clear(db, conversation).await;
    };
    let targets = targets(policy, conversation.get("priority"))?;
    if targets.is_empty() {
        return clear(db, conversation).await;
    }

    let workspace_hours = if policy.operational_hours.as_str() == Some("business")
        && !truthy(Some(&policy.business_hours))
    {
        load_workspace_hours(db).await?
    } else {
        Value::Null
    };
    let hours = business_hours(policy, &workspace_hours);
    let calendar = to_calendar(&hours);
    let timeline = load_timeline(db, &conversation_id).await?;
    let derived = derive_clocks(&timeline, &targets, calendar.as_ref(), now);
    if derived.is_empty() {
        return clear(db, conversation).await;
    }

    let existing = load_clocks(db, &conversation_id).await?;
    let by_metric: HashMap<&str, &StoredClock> =
        existing.iter().map(|c| (c.metric.as_str(), c)).collect();
    let mut alerts = Vec::new();
    let mut rows = Vec::with_capacity(derived.len());
    for clock in &derived {
        let stored = by_metric.get(clock.metric.as_str()).copied();
        let cycle = stored.filter(|s| s.started_at == clock.started_at);
        let mut warned_at = cycle.and_then(|c| c.warned_at);
        let mut breach_notified_at = cycle.and_then(|c| c.breach_notified_at);
        let mut alert = None;
        if acknowledge && clock.status == ClockStatus::Running {
            if clock.breached_at.is_some_and(|b| b <= now) && breach_notified_at.is_none() {
                breach_notified_at = Some(now);
                alert = Some("breach");
            } else if clock.breached_at.is_none()
                && clock.warn_at.is_some_and(|w| w <= now)
                && warned_at.is_none()
            {
                warned_at = Some(now);
                alert = Some("warning");
            }
        }
        let mut row = ClockRow {
            id: stored.map_or_else(|| generate_id("dsla"), |s| s.id.clone()),
            created_at: stored.map_or(now, |s| s.created_at),
            updated_at: now,
            conversation_id: conversation_id.clone(),
            metric: clock.metric,
            policy_id: Some(policy.id.clone()),
            target_minutes: clock.target_minutes,
            warn_before_minutes: clock.warn_before_minutes,
            calendar: hours.clone(),
            status: clock.status,
            started_at: clock.started_at,
            elapsed_seconds: clock.elapsed_seconds,
            due_at: clock.due_at,
            warn_at: clock.warn_at,
            breached_at: clock.breached_at,
            completed_at: clock.completed_at,
            warned_at,
            breach_notified_at,
            next_check_at: None,
        };
        row.next_check_at = next_check_at(&ClockTimes::from(&row));
        if let Some(kind) = alert {
            alerts.push(Alert {
                kind,
                metric: clock.metric,
                due_at: clock.due_at,
                clock: row.clone(),
            });
        }
        rows.push(row);
    }

    let values = Value::Array(rows.iter().map(ClockRow::columns).collect());
    sqlx::query(UPSERT).bind(values).execute(db).await?;
    let metrics: Vec<&str> = rows.iter().map(|r| r.metric.as_str()).collect();
    if existing.iter().any(|c| !metrics.contains(&c.metric.as_str())) {
        sqlx::query(
            "delete from desk_sla_clocks where conversation_id = $1 and metric <> all($2)",
        )
        .bind(&conversation_id)
        .bind(&metrics)
        .execute(db)
        .await?;
    }

    let times: Vec<ClockTimes> = rows.iter().map(ClockTimes::from).collect();
    let summary = summarize(&times, now);
    let updated = write_summary(db, conversation, &summary, Some(&policy.id)).await?;
    let next = rows.iter().filter_map(|r| r.next_check_at).min();
    Ok(Refreshed {
        conversation: Some(updated),
        clocks: rows,
        next_check_at: next,
        alerts,
    })
}

/// `listDueDeskSlaConversations(db, now, limit)`: conversations with a clock
/// to look at by `now`, the most overdue first.
pub async fn list_due(db: &PgPool, now: i64, limit: i64) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select conversation_id from desk_sla_clocks
         where next_check_at <= $1::timestamp
         group by conversation_id order by min(next_check_at) asc limit $2",
    )
    .bind(iso(now))
    .bind(limit)
    .fetch_all(db)
    .await
}

/// `nextDeskSlaCheckAt(db)`: when this workspace next has an SLA clock to
/// look at; `None` when none.
pub async fn workspace_next_check_at(db: &PgPool) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar(
        "select floor(extract(epoch from next_check_at) * 1000)::int8 from desk_sla_clocks
         where next_check_at is not null order by next_check_at asc limit 1",
    )
    .fetch_optional(db)
    .await
}

/// `releaseDeskSlaAlert(db, alert, retryAt)`: undo an `acknowledge` whose
/// announcement failed. The clock's warning or breach mark for this cycle
/// is cleared and it is looked at again at `retry_at`, or sooner when it
/// has something due before then.
pub async fn release_alert(db: &PgPool, alert: &Alert, retry_at: i64) -> Result<(), sqlx::Error> {
    let next = match alert.clock.next_check_at {
        Some(due) if due < retry_at => due,
        _ => retry_at,
    };
    sqlx::query(
        "update desk_sla_clocks set
             warned_at = case when $4 then null else warned_at end,
             breach_notified_at = case when $4 then breach_notified_at else null end,
             next_check_at = $3::timestamp
         where id = $1 and started_at = $2::timestamp",
    )
    .bind(&alert.clock.id)
    .bind(iso(alert.clock.started_at))
    .bind(iso(next))
    .bind(alert.kind == "warning")
    .execute(db)
    .await?;
    Ok(())
}

/// The conversation's clocks to look at again after `retry_at` (the sweep's
/// back-off for a conversation whose refresh failed).
pub async fn back_off(db: &PgPool, conversation_id: &str, retry_at: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update desk_sla_clocks set next_check_at = $2::timestamp where conversation_id = $1",
    )
    .bind(conversation_id)
    .bind(iso(retry_at))
    .execute(db)
    .await?;
    Ok(())
}

/// `movesDeskSla(input)`: appends that can start, stop, pause or retarget a
/// clock. Assignment counts: a policy can have a condition on the assignee.
pub fn moves_sla(kind: &str, author_type: &str, event_type: Option<&str>) -> bool {
    match kind {
        "message" => matches!(author_type, "visitor" | "agent"),
        "event" => matches!(
            event_type,
            Some("closed" | "reopened" | "attributes_changed" | "assigned" | "unassigned")
        ),
        _ => false,
    }
}

/// The current time value.
pub fn now_ms() -> i64 {
    let nanos = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    i64::try_from(nanos).unwrap_or_default()
}

/// A time value as a `time` instant (for the due index).
pub fn instant(ms: i64) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(fields: Value) -> Policy {
        let mut base = json!({
            "id": "sla_1",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "priority": 0,
            "isDefault": false,
            "isActive": true,
            "conditions": [],
            "firstResponseTime": [{ "priority": "medium", "time": 60 }],
            "resolutionTime": [{ "priority": "medium", "time": 480 }],
            "updateTime": [{ "priority": "medium", "time": 120 }],
            "operationalHours": "24x7",
        });
        if let (Some(base), Some(fields)) = (base.as_object_mut(), fields.as_object()) {
            base.extend(fields.clone());
        }
        Policy::from_js(&base)
    }

    #[test]
    fn picks_the_matching_policy_else_the_default() {
        let candidates = vec![
            policy(json!({ "id": "default", "isDefault": true })),
            policy(json!({
                "id": "urgent",
                "conditions": [{ "field": "priority", "operator": "equals", "value": "URGENT" }],
            })),
        ];
        let urgent = json!({ "priority": "urgent" });
        let low = json!({ "priority": "low" });
        let chosen = select_policy(&candidates, &urgent).unwrap().unwrap();
        assert_eq!(chosen.id, "urgent");
        let chosen = select_policy(&candidates, &low).unwrap().unwrap();
        assert_eq!(chosen.id, "default");
    }

    #[test]
    fn warns_at_75_percent_by_default() {
        let targets = targets(&policy(json!({})), None).unwrap();
        assert_eq!(
            targets[0],
            (
                Metric::FirstResponse,
                Target {
                    target_minutes: 60.0,
                    warn_before_minutes: Some(15.0),
                }
            )
        );
    }

    #[test]
    fn rounds_like_javascript() {
        assert!((js_round(2.5) - 3.0).abs() < f64::EPSILON);
        assert!((js_round(-2.5) + 2.0).abs() < f64::EPSILON);
        assert!(js_round(0.499_999_999_999_999_94).abs() < f64::EPSILON);
    }

    #[test]
    fn replays_a_late_first_response() {
        let targets = targets(&policy(json!({})), None).unwrap();
        let timeline = vec![
            TimelineEntry {
                at: 0,
                kind: "message".to_owned(),
                author_type: "visitor".to_owned(),
                event_type: None,
            },
            TimelineEntry {
                at: 90 * 60_000,
                kind: "message".to_owned(),
                author_type: "agent".to_owned(),
                event_type: None,
            },
        ];
        let clocks = derive_clocks(&timeline, &targets, None, 100 * 60_000);
        assert_eq!(clocks[0].metric, Metric::FirstResponse);
        assert_eq!(clocks[0].status, ClockStatus::Completed);
        assert_eq!(clocks[0].breached_at, Some(60 * 60_000));
        assert_eq!(clocks[1].metric, Metric::Resolution);
        assert_eq!(clocks[1].status, ClockStatus::Paused);
        assert_eq!(clocks[1].elapsed_seconds, 90 * 60);
    }
}
