//! Capacity rules (`@weldsuite/flow-domain/capacity`): load per member and
//! ISO week, free hours, suggestions for a resource request, and the wire
//! shapes of bookings, requests and profiles (design:
//! weldflow-delivery-and-portfolio.md, "Capacity").
//!
//! Pure functions, no database and no clock. Every message returned here goes
//! to the client as it is, so both backends answer alike. The sums are added in
//! the order the TypeScript adds them in, and every figure that is shown is
//! rounded to two decimals with `Math.round` ([`round2`]), so the two
//! produce the same numbers.
//!
//! Dates are calendar dates (`YYYY-MM-DD`), handled as whole days since
//! 1970-01-01. The load per member and week is the bookings (a tentative one
//! only when asked for) plus the estimates of the member's open tasks, split
//! over the assignees and spread over the working days of the task, except in
//! a week where the member has a booking on the task's project.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::{Value, json};

use crate::js::{civil_from_days, days_from_civil, math_round, number_value, numeric};

pub const MAX_CAPACITY_WEEKS: i64 = 26;
pub const DEFAULT_CAPACITY_WEEKS: i64 = 14;
pub const MAX_ROADMAP_QUARTERS: i64 = 8;
pub const DEFAULT_ROADMAP_QUARTERS: i64 = 4;
/// Contract hours of a member without a profile.
pub const DEFAULT_WEEKLY_HOURS: f64 = 40.0;
/// A project name the caller may not see.
pub const OTHER_PROJECT_NAME: &str = "Other project";

/// `CAPACITY_BANDS`.
pub const CAPACITY_BANDS: [&str; 6] = ["none", "under", "ok", "full", "over", "critical"];
/// `RESOURCE_REQUEST_STATUSES`.
pub const RESOURCE_REQUEST_STATUSES: [&str; 3] = ["open", "booked", "cancelled"];
/// `PROJECT_REQUEST_STATUSES`.
pub const PROJECT_REQUEST_STATUSES: [&str; 5] =
    ["new", "assessing", "approved", "rejected", "converted"];

/// `CAPACITY_MESSAGES`: the messages of every refusal.
pub mod messages {
    pub const INVALID_DATE: &str = "Use a real calendar date";
    pub const PERIOD_ORDER: &str = "The end date cannot be before the start date";
    pub const RANGE_TOO_LONG: &str = "The range can span at most 26 weeks";
    pub const ROADMAP_TOO_LONG: &str = "The roadmap spans at most 8 quarters";
    pub const BOOKING_TARGET: &str =
        "A booking is for a project or for a request, not both and not neither";
    pub const BOOKING_FORBIDDEN: &str = "You do not have permission to book people on this";
    pub const PROFILE_FORBIDDEN: &str = "You can only change your own profile";
    pub const REQUEST_FORBIDDEN: &str =
        "You do not have permission to request people for this project";
    pub const REQUEST_NOT_OPEN: &str = "Only an open resource request can be changed";
    pub const REQUEST_NOT_BOOKABLE: &str = "This resource request is no longer open";
    pub const HELD_BOOKING_TENTATIVE: &str = "A booking held for a request is always tentative";
    pub const HELD_REQUEST_CLOSED: &str = "This request is no longer open for bookings";
}

// ── Dates ───────────────────────────────────────────────────────────────────

const MIN_YEAR: i64 = 1970;
const MAX_YEAR: i64 = 2200;

/// `parseDate(text)`: the whole days since 1970-01-01 of a real
/// `YYYY-MM-DD` date, or `None`.
pub fn parse_date(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        });
    if !shaped {
        return None;
    }
    let year: i64 = text[0..4].parse().ok()?;
    let month: i64 = text[5..7].parse().ok()?;
    let day: i64 = text[8..10].parse().ok()?;
    if !(MIN_YEAR..=MAX_YEAR).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    (civil_from_days(days) == (year, month, day)).then_some(days)
}

/// `formatDate(days)`.
pub fn format_date(days: i64) -> String {
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// `weekdayOf(days)`: 0 for Monday to 6 for Sunday.
pub fn weekday_of(days: i64) -> i64 {
    (days + 3).rem_euclid(7)
}

/// `mondayOf(days)`.
pub fn monday_of(days: i64) -> i64 {
    days - weekday_of(days)
}

/// `isoWeekLabel(monday)`: `2026-W45`.
pub fn iso_week_label(monday: i64) -> String {
    let thursday = monday + 3;
    let (year, _, _) = civil_from_days(thursday);
    let january1 = days_from_civil(year, 1, 1);
    let week = (thursday - january1).div_euclid(7) + 1;
    format!("{year}-W{week:02}")
}

fn working_days_up_to(days: i64) -> i64 {
    let shifted = days + 3;
    5 * shifted.div_euclid(7) + (shifted.rem_euclid(7) + 1).min(5)
}

/// `workingDaysBetween(from, to)`: Monday to Friday days in `[from, to]`.
pub fn working_days_between(from: i64, to: i64) -> i64 {
    if to < from {
        0
    } else {
        working_days_up_to(to) - working_days_up_to(from - 1)
    }
}

fn working_days_in_week(from: i64, to: i64, monday: i64) -> i64 {
    let a = from.max(monday);
    let b = to.min(monday + 4);
    if b >= a { b - a + 1 } else { 0 }
}

/// `round2(value)`: `Math.round(value × 100) ÷ 100`.
pub fn round2(value: f64) -> f64 {
    math_round(value * 100.0) / 100.0
}

/// `periodError(startsOn, endsOn)`.
pub fn period_error(starts_on: &str, ends_on: &str) -> Option<&'static str> {
    let (Some(start), Some(end)) = (parse_date(starts_on), parse_date(ends_on)) else {
        return Some(messages::INVALID_DATE);
    };
    (end < start).then_some(messages::PERIOD_ORDER)
}

/// `bookingTargetError(target)`: a project or a request, exactly one.
pub fn booking_target_error(
    project_id: Option<&str>,
    request_id: Option<&str>,
) -> Option<&'static str> {
    let project = project_id.is_some_and(|id| !id.is_empty());
    let request = request_id.is_some_and(|id| !id.is_empty());
    (project == request).then_some(messages::BOOKING_TARGET)
}

// ── Ranges ──────────────────────────────────────────────────────────────────

/// `CapacityRange`: whole weeks, the Monday of the first to the Sunday of the last.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapacityRange {
    pub from: String,
    pub to: String,
    pub weeks: i64,
}

/// `capacityRange(from, to, today)`.
pub fn capacity_range(
    from: Option<&str>,
    to: Option<&str>,
    today: &str,
) -> Result<CapacityRange, &'static str> {
    let today_days = parse_date(today).ok_or(messages::INVALID_DATE)?;
    let from_days = match from {
        None => today_days,
        Some(text) => parse_date(text).ok_or(messages::INVALID_DATE)?,
    };
    let first = monday_of(from_days);
    let to_days = match to {
        None => first + DEFAULT_CAPACITY_WEEKS * 7 - 1,
        Some(text) => parse_date(text).ok_or(messages::INVALID_DATE)?,
    };
    if to_days < from_days {
        return Err(messages::PERIOD_ORDER);
    }
    let weeks = (monday_of(to_days) - first) / 7 + 1;
    if weeks > MAX_CAPACITY_WEEKS {
        return Err(messages::RANGE_TOO_LONG);
    }
    Ok(CapacityRange {
        from: format_date(first),
        to: format_date(monday_of(to_days) + 6),
        weeks,
    })
}

/// `fitRange(desiredStart, desiredEnd, today)`.
pub fn fit_range(
    desired_start: Option<&str>,
    desired_end: Option<&str>,
    today: &str,
) -> CapacityRange {
    let today_days = parse_date(today).unwrap_or(0);
    let start = desired_start
        .filter(|text| !text.is_empty())
        .and_then(parse_date);
    let first = monday_of(start.unwrap_or(today_days));
    let end = desired_end
        .filter(|text| !text.is_empty())
        .and_then(parse_date);
    let longest = first + MAX_CAPACITY_WEEKS * 7 - 1;
    let last = match end {
        Some(end) if end >= first => (monday_of(end) + 6).min(longest),
        _ => first + DEFAULT_CAPACITY_WEEKS * 7 - 1,
    };
    CapacityRange {
        from: format_date(first),
        to: format_date(last),
        weeks: (last - first + 1) / 7,
    }
}

/// `weeksCovering(from, to)`.
pub fn weeks_covering(from: &str, to: &str) -> CapacityRange {
    let first = monday_of(parse_date(from).unwrap_or(0));
    let last = monday_of(parse_date(to).unwrap_or(0));
    CapacityRange {
        from: format_date(first),
        to: format_date(last + 6),
        weeks: (last - first) / 7 + 1,
    }
}

/// The first day of month `month0` (0-based, may run past the year) of `year`.
fn first_of_month(year: i64, month0: i64) -> i64 {
    days_from_civil(year + month0.div_euclid(12), month0.rem_euclid(12) + 1, 1)
}

fn quarter_start(days: i64) -> i64 {
    let (year, month, _) = civil_from_days(days);
    first_of_month(year, (month - 1) / 3 * 3)
}

fn quarter_end(days: i64) -> i64 {
    let (year, month, _) = civil_from_days(days);
    first_of_month(year, (month - 1) / 3 * 3 + 3) - 1
}

/// `RoadmapRange`: whole quarters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoadmapRange {
    pub from: String,
    pub to: String,
    pub quarters: i64,
}

/// `roadmapRange(from, to, today)`.
pub fn roadmap_range(
    from: Option<&str>,
    to: Option<&str>,
    today: &str,
) -> Result<RoadmapRange, &'static str> {
    let today_days = parse_date(today).ok_or(messages::INVALID_DATE)?;
    let from_days = match from {
        None => today_days,
        Some(text) => parse_date(text).ok_or(messages::INVALID_DATE)?,
    };
    let first = quarter_start(from_days);
    let last = match to {
        None => {
            let mut last = quarter_end(first);
            for _ in 1..DEFAULT_ROADMAP_QUARTERS {
                last = quarter_end(last + 1);
            }
            last
        }
        Some(text) => {
            let to_days = parse_date(text).ok_or(messages::INVALID_DATE)?;
            if to_days < from_days {
                return Err(messages::PERIOD_ORDER);
            }
            quarter_end(to_days)
        }
    };
    let mut quarters = 1;
    let mut cursor = quarter_end(first);
    while cursor < last {
        cursor = quarter_end(cursor + 1);
        quarters += 1;
    }
    if quarters > MAX_ROADMAP_QUARTERS {
        return Err(messages::ROADMAP_TOO_LONG);
    }
    Ok(RoadmapRange {
        from: format_date(first),
        to: format_date(last),
        quarters,
    })
}

// ── Inputs ──────────────────────────────────────────────────────────────────

/// `CapacityMember`.
#[derive(Debug, Clone, PartialEq)]
pub struct CapacityMember {
    pub member_id: String,
    pub weekly_hours: f64,
    pub skills: Vec<String>,
    pub has_profile: bool,
}

/// `CapacityBooking`.
#[derive(Debug, Clone, PartialEq)]
pub struct CapacityBooking {
    pub member_id: String,
    pub project_id: Option<String>,
    pub request_id: Option<String>,
    pub starts_on: String,
    pub ends_on: String,
    pub hours_per_week: f64,
    pub tentative: bool,
}

/// `CapacityTask`.
#[derive(Debug, Clone, PartialEq)]
pub struct CapacityTask {
    pub project_id: String,
    pub assignee_id: Option<String>,
    pub assignee_ids: Option<Vec<String>>,
    pub starts_on: Option<String>,
    pub due_on: Option<String>,
    pub estimated_hours: f64,
}

/// `CapacityProfileInput`.
#[derive(Debug, Clone, PartialEq)]
pub struct CapacityProfile {
    pub member_id: String,
    pub weekly_hours: f64,
    pub skills: Vec<String>,
}

/// `taskAssignees(task)`: `assigneeIds`, else the one `assigneeId`; each once, in order.
pub fn task_assignees(task: &CapacityTask) -> Vec<String> {
    assignees_of(task.assignee_id.as_deref(), task.assignee_ids.as_deref())
}

fn assignees_of(assignee_id: Option<&str>, assignee_ids: Option<&[String]>) -> Vec<String> {
    let listed: Vec<&str> = assignee_ids
        .unwrap_or_default()
        .iter()
        .map(String::as_str)
        .filter(|id| !id.is_empty())
        .collect();
    let ids: Vec<&str> = if listed.is_empty() {
        assignee_id
            .filter(|id| !id.is_empty())
            .into_iter()
            .collect()
    } else {
        listed
    };
    let mut seen = HashSet::new();
    ids.into_iter()
        .filter(|id| seen.insert(*id))
        .map(str::to_owned)
        .collect()
}

/// `collectMembers`: everyone with a profile, a booking or an open task, plus
/// `people`, each once, by id; those without a profile get 40 contract hours.
pub fn collect_members(
    profiles: &[CapacityProfile],
    bookings: &[CapacityBooking],
    tasks: &[CapacityTask],
    people: &[String],
) -> Vec<CapacityMember> {
    let mut by_id: BTreeMap<String, CapacityMember> = BTreeMap::new();
    for profile in profiles {
        by_id.insert(
            profile.member_id.clone(),
            CapacityMember {
                member_id: profile.member_id.clone(),
                weekly_hours: profile.weekly_hours,
                skills: profile.skills.clone(),
                has_profile: true,
            },
        );
    }
    let ids = bookings
        .iter()
        .map(|b| b.member_id.clone())
        .chain(tasks.iter().flat_map(task_assignees))
        .chain(people.iter().cloned());
    for id in ids {
        if !id.is_empty() {
            by_id.entry(id.clone()).or_insert_with(|| CapacityMember {
                member_id: id,
                weekly_hours: DEFAULT_WEEKLY_HOURS,
                skills: Vec::new(),
                has_profile: false,
            });
        }
    }
    by_id.into_values().collect()
}

/// `normalizeSkill(skill)`: trimmed, lower case.
pub fn normalize_skill(skill: &str) -> String {
    weldsuite_kit::validation::js_trim(skill).to_lowercase()
}

/// `normalizeSkills(skills)`: trimmed, each once (case aside), in the order given.
pub fn normalize_skills(skills: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for skill in skills {
        let trimmed = weldsuite_kit::validation::js_trim(skill);
        let key = normalize_skill(trimmed);
        if !key.is_empty() && seen.insert(key) {
            out.push(trimmed.to_owned());
        }
    }
    out
}

fn has_skill(skills: &[String], skill: &str) -> bool {
    let wanted = normalize_skill(skill);
    skills.iter().any(|s| normalize_skill(s) == wanted)
}

// ── Load ────────────────────────────────────────────────────────────────────

/// A band of a week's load (`CapacityBand`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapacityBand {
    None,
    Under,
    Ok,
    Full,
    Over,
    Critical,
}

impl CapacityBand {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Under => "under",
            Self::Ok => "ok",
            Self::Full => "full",
            Self::Over => "over",
            Self::Critical => "critical",
        }
    }
}

/// `loadPercent(hours, weeklyHours)`.
pub fn load_percent(hours: f64, weekly_hours: f64) -> Option<f64> {
    (weekly_hours > 0.0).then(|| round2(hours / weekly_hours * 100.0))
}

/// `capacityBand(hours, percent)`.
pub fn capacity_band(hours: f64, percent: Option<f64>) -> CapacityBand {
    if hours <= 0.0 {
        return CapacityBand::None;
    }
    match percent {
        Some(p) if p < 50.0 => CapacityBand::Under,
        Some(p) if p < 80.0 => CapacityBand::Ok,
        Some(p) if p <= 100.0 => CapacityBand::Full,
        Some(p) if p <= 120.0 => CapacityBand::Over,
        None | Some(_) => CapacityBand::Critical,
    }
}

/// `CapacityInput`.
#[derive(Debug, Clone)]
pub struct CapacityInput<'a> {
    pub from: &'a str,
    pub weeks: usize,
    pub members: &'a [CapacityMember],
    pub bookings: &'a [CapacityBooking],
    pub tasks: &'a [CapacityTask],
    pub include_tentative: bool,
    pub skill: Option<&'a str>,
}

/// `CapacityWeek`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapacityWeek {
    pub week: String,
    pub starts_on: String,
    pub ends_on: String,
}

impl CapacityWeek {
    pub fn to_json(&self) -> Value {
        json!({ "week": self.week, "startsOn": self.starts_on, "endsOn": self.ends_on })
    }
}

/// `CapacityCell`.
#[derive(Debug, Clone, PartialEq)]
pub struct CapacityCell {
    pub hours: f64,
    pub tentative_hours: f64,
    pub percent: Option<f64>,
    pub band: CapacityBand,
}

impl CapacityCell {
    pub fn to_json(&self) -> Value {
        json!({
            "hours": number_value(self.hours),
            "tentativeHours": number_value(self.tentative_hours),
            "percent": self.percent.map_or(Value::Null, number_value),
            "band": self.band.as_str(),
        })
    }
}

/// `LoadRow`: one project, or request, in a member's load.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadRow {
    pub project_id: Option<String>,
    pub request_id: Option<String>,
    pub hours: Vec<f64>,
    pub tentative_hours: Vec<f64>,
}

/// `MemberLoad`.
#[derive(Debug, Clone, PartialEq)]
pub struct MemberLoad {
    pub member_id: String,
    pub weekly_hours: f64,
    pub skills: Vec<String>,
    pub has_profile: bool,
    pub cells: Vec<CapacityCell>,
    pub projects: Vec<LoadRow>,
}

/// `CapacityTotals`.
#[derive(Debug, Clone, PartialEq)]
pub struct CapacityTotals {
    pub booked_hours: f64,
    pub capacity_hours: f64,
}

impl CapacityTotals {
    pub fn to_json(&self) -> Value {
        json!({
            "bookedHours": number_value(self.booked_hours),
            "capacityHours": number_value(self.capacity_hours),
        })
    }
}

/// `CapacityLoad.summary`.
#[derive(Debug, Clone, PartialEq)]
pub struct CapacitySummary {
    pub member_count: usize,
    pub booked_hours: f64,
    pub capacity_hours: f64,
    pub percent: Option<f64>,
    pub overbooked_person_weeks: i64,
}

impl CapacitySummary {
    pub fn to_json(&self) -> Value {
        json!({
            "memberCount": self.member_count,
            "bookedHours": number_value(self.booked_hours),
            "capacityHours": number_value(self.capacity_hours),
            "percent": self.percent.map_or(Value::Null, number_value),
            "overbookedPersonWeeks": self.overbooked_person_weeks,
        })
    }
}

/// `CapacityLoad`.
#[derive(Debug, Clone, PartialEq)]
pub struct CapacityLoad {
    pub weeks: Vec<CapacityWeek>,
    pub totals: Vec<CapacityTotals>,
    pub members: Vec<MemberLoad>,
    pub summary: CapacitySummary,
}

struct Accumulator {
    project_id: Option<String>,
    request_id: Option<String>,
    hours: Vec<f64>,
    tentative: Vec<f64>,
}

fn row_key(project_id: Option<&str>, request_id: Option<&str>) -> String {
    match project_id.filter(|id| !id.is_empty()) {
        Some(id) => format!("p:{id}"),
        None => format!("r:{}", request_id.unwrap_or_default()),
    }
}

/// One member's hours per project and week, while they are added up.
struct MemberRows<'a> {
    starts: &'a [i64],
    rows: BTreeMap<String, Accumulator>,
    /// (project, week index) pairs a booking covers.
    covered: HashSet<(String, usize)>,
}

impl<'a> MemberRows<'a> {
    fn new(starts: &'a [i64]) -> Self {
        Self {
            starts,
            rows: BTreeMap::new(),
            covered: HashSet::new(),
        }
    }

    fn row(&mut self, project_id: Option<&str>, request_id: Option<&str>) -> &mut Accumulator {
        let weeks = self.starts.len();
        self.rows
            .entry(row_key(project_id, request_id))
            .or_insert_with(|| Accumulator {
                project_id: project_id.map(str::to_owned),
                request_id: request_id.map(str::to_owned),
                hours: vec![0.0; weeks],
                tentative: vec![0.0; weeks],
            })
    }

    /// A booking adds `hoursPerWeek × (working days it covers ÷ 5)` to each week it touches.
    fn add_booking(&mut self, booking: &CapacityBooking) {
        let (Some(from), Some(to)) = (parse_date(&booking.starts_on), parse_date(&booking.ends_on))
        else {
            return;
        };
        let starts = self.starts;
        for (i, monday) in starts.iter().enumerate() {
            let days = working_days_in_week(from, to, *monday);
            if days == 0 {
                continue;
            }
            #[allow(clippy::cast_precision_loss)]
            let hours = (booking.hours_per_week * days as f64) / 5.0;
            let acc = self.row(booking.project_id.as_deref(), booking.request_id.as_deref());
            acc.hours[i] += hours;
            if booking.tentative {
                acc.tentative[i] += hours;
            }
            if let Some(project) = booking.project_id.as_deref().filter(|p| !p.is_empty()) {
                self.covered.insert((project.to_owned(), i));
            }
        }
    }

    /// An open task adds its share of the estimate over its working days, except in a week a booking covers its project.
    fn add_task(&mut self, task: &CapacityTask, share: f64) {
        let a = task.starts_on.as_deref().and_then(parse_date);
        let b = task.due_on.as_deref().and_then(parse_date);
        let (Some(first), Some(last)) = (a.or(b), b.or(a)) else {
            return;
        };
        let lo = first.min(last);
        let hi = first.max(last);
        let working_days = working_days_between(lo, hi);
        let starts = self.starts;
        for (i, monday) in starts.iter().enumerate() {
            if self.covered.contains(&(task.project_id.clone(), i)) {
                continue;
            }
            // A window without a working day lands whole in the week of its first day.
            #[allow(clippy::cast_precision_loss)]
            let hours = if working_days == 0 {
                if lo >= *monday && lo <= *monday + 6 {
                    share
                } else {
                    0.0
                }
            } else {
                (share / working_days as f64) * working_days_in_week(lo, hi, *monday) as f64
            };
            if hours > 0.0 {
                self.row(Some(task.project_id.as_str()), None).hours[i] += hours;
            }
        }
    }
}

/// A member's cells and project rows from their summed hours; adds their weeks to the team totals.
fn member_load(
    member: &CapacityMember,
    sums: &MemberRows<'_>,
    totals: &mut [(f64, f64)],
    overbooked: &mut i64,
) -> MemberLoad {
    let accumulators: Vec<&Accumulator> = sums.rows.values().collect();
    let mut cells = Vec::with_capacity(totals.len());
    for (i, total) in totals.iter_mut().enumerate() {
        let mut sum = 0.0;
        let mut tentative_sum = 0.0;
        for acc in &accumulators {
            sum += acc.hours[i];
            tentative_sum += acc.tentative[i];
        }
        let hours = round2(sum);
        let percent = load_percent(hours, member.weekly_hours);
        let band = capacity_band(hours, percent);
        if percent.map_or(hours > 0.0, |p| p > 100.0) {
            *overbooked += 1;
        }
        total.0 += hours;
        total.1 += member.weekly_hours;
        cells.push(CapacityCell {
            hours,
            tentative_hours: round2(tentative_sum),
            percent,
            band,
        });
    }
    MemberLoad {
        member_id: member.member_id.clone(),
        weekly_hours: member.weekly_hours,
        skills: member.skills.clone(),
        has_profile: member.has_profile,
        cells,
        projects: accumulators
            .iter()
            .map(|acc| LoadRow {
                project_id: acc.project_id.clone(),
                request_id: acc.request_id.clone(),
                hours: acc.hours.iter().map(|h| round2(*h)).collect(),
                tentative_hours: acc.tentative.iter().map(|h| round2(*h)).collect(),
            })
            .filter(|row| row.hours.iter().any(|h| *h > 0.0))
            .collect(),
    }
}

/// `computeCapacity(input)`: load per member per week, with the projects behind it.
pub fn compute_capacity(input: &CapacityInput<'_>) -> CapacityLoad {
    let first_day = monday_of(parse_date(input.from).unwrap_or(0));
    let starts: Vec<i64> = (0..input.weeks)
        .map(|i| first_day + i64::try_from(i).unwrap_or(0) * 7)
        .collect();
    let weeks: Vec<CapacityWeek> = starts
        .iter()
        .map(|monday| CapacityWeek {
            week: iso_week_label(*monday),
            starts_on: format_date(*monday),
            ends_on: format_date(*monday + 6),
        })
        .collect();

    let mut bookings_of: HashMap<&str, Vec<&CapacityBooking>> = HashMap::new();
    for booking in input.bookings {
        if booking.tentative && !input.include_tentative {
            continue;
        }
        bookings_of
            .entry(booking.member_id.as_str())
            .or_default()
            .push(booking);
    }
    let mut tasks_of: HashMap<String, Vec<(&CapacityTask, f64)>> = HashMap::new();
    for task in input.tasks {
        let assignees = task_assignees(task);
        #[allow(clippy::cast_precision_loss)]
        let count = assignees.len() as f64;
        for id in assignees {
            tasks_of
                .entry(id)
                .or_default()
                .push((task, task.estimated_hours / count));
        }
    }

    let mut loads: Vec<MemberLoad> = Vec::new();
    let mut totals: Vec<(f64, f64)> = starts.iter().map(|_| (0.0, 0.0)).collect();
    let mut overbooked: i64 = 0;
    let members = input
        .members
        .iter()
        .filter(|m| input.skill.is_none_or(|skill| has_skill(&m.skills, skill)));
    for member in members {
        let mut sums = MemberRows::new(&starts);
        for booking in bookings_of
            .get(member.member_id.as_str())
            .map_or(&[][..], Vec::as_slice)
        {
            sums.add_booking(booking);
        }
        for (task, share) in tasks_of
            .get(member.member_id.as_str())
            .map_or(&[][..], Vec::as_slice)
        {
            sums.add_task(task, *share);
        }

        loads.push(member_load(member, &sums, &mut totals, &mut overbooked));
    }

    let rounded: Vec<CapacityTotals> = totals
        .iter()
        .map(|(booked, capacity)| CapacityTotals {
            booked_hours: round2(*booked),
            capacity_hours: round2(*capacity),
        })
        .collect();
    let booked_hours = round2(rounded.iter().fold(0.0, |sum, t| sum + t.booked_hours));
    let capacity_hours = round2(rounded.iter().fold(0.0, |sum, t| sum + t.capacity_hours));
    CapacityLoad {
        weeks,
        totals: rounded,
        summary: CapacitySummary {
            member_count: loads.len(),
            booked_hours,
            capacity_hours,
            percent: (capacity_hours > 0.0).then(|| round2(booked_hours / capacity_hours * 100.0)),
            overbooked_person_weeks: overbooked,
        },
        members: loads,
    }
}

// ── Suggestions and fit ─────────────────────────────────────────────────────

/// Free hours of a member in each week of the load that overlaps `[starts_on, ends_on]`.
fn free_hours_over(
    member: &MemberLoad,
    weeks: &[CapacityWeek],
    starts_on: &str,
    ends_on: &str,
) -> Vec<f64> {
    let (Some(from), Some(to)) = (parse_date(starts_on), parse_date(ends_on)) else {
        return Vec::new();
    };
    let mut free = Vec::new();
    for (i, week) in weeks.iter().enumerate() {
        let monday = parse_date(&week.starts_on).unwrap_or(0);
        if from <= monday + 6 && to >= monday {
            free.push(round2(
                (member.weekly_hours - member.cells[i].hours).max(0.0),
            ));
        }
    }
    free
}

/// A person for a resource request (`MemberSuggestion`).
#[derive(Debug, Clone, PartialEq)]
pub struct MemberSuggestion {
    pub member_id: String,
    pub skills: Vec<String>,
    pub weekly_hours: f64,
    pub free_hours_per_week: f64,
    pub average_free_hours_per_week: f64,
    pub covers_request: bool,
}

impl MemberSuggestion {
    pub fn to_json(&self) -> Value {
        json!({
            "memberId": self.member_id,
            "skills": self.skills,
            "weeklyHours": number_value(self.weekly_hours),
            "freeHoursPerWeek": number_value(self.free_hours_per_week),
            "averageFreeHoursPerWeek": number_value(self.average_free_hours_per_week),
            "coversRequest": self.covers_request,
        })
    }
}

/// What a resource request needs.
#[derive(Debug, Clone)]
pub struct ResourceNeed<'a> {
    pub skill: &'a str,
    pub hours_per_week: f64,
    pub starts_on: &'a str,
    pub ends_on: &'a str,
}

/// `suggestMembers(load, need)`.
pub fn suggest_members(load: &CapacityLoad, need: &ResourceNeed<'_>) -> Vec<MemberSuggestion> {
    let mut out = Vec::new();
    for member in &load.members {
        if !has_skill(&member.skills, need.skill) {
            continue;
        }
        let free = free_hours_over(member, &load.weeks, need.starts_on, need.ends_on);
        if free.is_empty() {
            continue;
        }
        let least = free.iter().copied().fold(f64::INFINITY, f64::min);
        #[allow(clippy::cast_precision_loss)]
        let average = round2(free.iter().fold(0.0, |sum, h| sum + h) / free.len() as f64);
        out.push(MemberSuggestion {
            member_id: member.member_id.clone(),
            skills: member.skills.clone(),
            weekly_hours: member.weekly_hours,
            free_hours_per_week: least,
            average_free_hours_per_week: average,
            covers_request: least >= need.hours_per_week,
        });
    }
    out.sort_by(|a, b| {
        b.covers_request
            .cmp(&a.covers_request)
            .then_with(|| {
                b.free_hours_per_week
                    .partial_cmp(&a.free_hours_per_week)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.member_id.cmp(&b.member_id))
    });
    out
}

/// A skill a request needs, with the hours per week when stated.
#[derive(Debug, Clone, PartialEq)]
pub struct NeededSkill {
    pub skill: String,
    pub hours_per_week: Option<f64>,
}

/// `skillFit(load, needs)`: one `SkillFit` object per need.
pub fn skill_fit(load: &CapacityLoad, needs: &[NeededSkill]) -> Vec<Value> {
    needs
        .iter()
        .map(|need| {
            let people: Vec<&MemberLoad> = load
                .members
                .iter()
                .filter(|m| has_skill(&m.skills, &need.skill))
                .collect();
            let free: Vec<f64> = (0..load.weeks.len())
                .map(|i| {
                    round2(people.iter().fold(0.0, |sum, m| {
                        sum + (m.weekly_hours - m.cells[i].hours).max(0.0)
                    }))
                })
                .collect();
            let short_weeks = need
                .hours_per_week
                .map_or(0, |hours| free.iter().filter(|h| **h < hours).count());
            let least = if free.is_empty() {
                0.0
            } else {
                free.iter().copied().fold(f64::INFINITY, f64::min)
            };
            json!({
                "skill": need.skill,
                "needHoursPerWeek": need.hours_per_week.map_or(Value::Null, number_value),
                "freeHoursPerWeek": number_value(least),
                "shortWeeks": short_weeks,
                "weeks": free.len(),
                "short": short_weeks > 0,
            })
        })
        .collect()
}

// ── Roadmap line ────────────────────────────────────────────────────────────

fn bucket_key(days: i64, quarter: bool) -> String {
    let (year, month, _) = civil_from_days(days);
    if quarter {
        format!("{year}-Q{}", (month - 1) / 3 + 1)
    } else {
        format!("{year}-{month:02}")
    }
}

/// `rollupLoad(load, from, to, quarter)`: one `RoadmapBucket` object per month
/// (or quarter) of the range, in order.
pub fn rollup_load(
    weeks: &[CapacityWeek],
    totals: &[CapacityTotals],
    from: &str,
    to: &str,
    quarter: bool,
) -> Vec<Value> {
    let from_days = parse_date(from).unwrap_or(0);
    let to_days = parse_date(to).unwrap_or(0);
    // (starts_on, ends_on, booked, capacity), by key.
    let mut buckets: BTreeMap<String, (i64, i64, f64, f64)> = BTreeMap::new();
    let mut day = from_days;
    while day <= to_days {
        let (year, month, _) = civil_from_days(day);
        let month0 = if quarter {
            (month - 1) / 3 * 3
        } else {
            month - 1
        };
        let starts_on = first_of_month(year, month0);
        let ends_on = first_of_month(year, month0 + if quarter { 3 } else { 1 }) - 1;
        buckets.insert(bucket_key(day, quarter), (starts_on, ends_on, 0.0, 0.0));
        day = ends_on + 1;
    }
    for (i, week) in weeks.iter().enumerate() {
        let thursday = parse_date(&week.starts_on).unwrap_or(0) + 3;
        if thursday < from_days || thursday > to_days {
            continue;
        }
        if let Some(bucket) = buckets.get_mut(&bucket_key(thursday, quarter)) {
            bucket.2 += totals[i].booked_hours;
            bucket.3 += totals[i].capacity_hours;
        }
    }
    buckets
        .into_iter()
        .map(|(key, (starts_on, ends_on, booked, capacity))| {
            let booked_hours = round2(booked);
            let capacity_hours = round2(capacity);
            json!({
                "key": key,
                "startsOn": format_date(starts_on),
                "endsOn": format_date(ends_on),
                "bookedHours": number_value(booked_hours),
                "capacityHours": number_value(capacity_hours),
                "percent": if capacity_hours > 0.0 {
                    number_value(round2(booked_hours / capacity_hours * 100.0))
                } else {
                    Value::Null
                },
            })
        })
        .collect()
}

// ── Wire shapes ─────────────────────────────────────────────────────────────
//
// Rows are read as `weldsuite_db::js_row` gives them: camelCase keys,
// timestamps as ISO strings, `numeric` columns as text.

fn field(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// `presentBooking(row)`.
pub fn present_booking(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "memberId": field(row, "memberId"),
        "projectId": field(row, "projectId"),
        "requestId": field(row, "requestId"),
        "startsOn": field(row, "startsOn"),
        "endsOn": field(row, "endsOn"),
        "hoursPerWeek": field(row, "hoursPerWeek"),
        "tentative": field(row, "tentative"),
        "createdBy": field(row, "createdBy"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `presentResourceRequest(row, projectName)`.
pub fn present_resource_request(row: &Value, project_name: &str) -> Value {
    let mut out = resource_request_event_data(row);
    if let Value::Object(fields) = &mut out {
        fields.insert("projectName".to_owned(), json!(project_name));
    }
    out
}

/// `resourceRequestEventData(row)`: the request without the project name.
pub fn resource_request_event_data(row: &Value) -> Value {
    json!({
        "id": field(row, "id"),
        "projectId": field(row, "projectId"),
        "skill": field(row, "skill"),
        "hoursPerWeek": field(row, "hoursPerWeek"),
        "startsOn": field(row, "startsOn"),
        "endsOn": field(row, "endsOn"),
        "status": field(row, "status"),
        "bookingId": field(row, "bookingId"),
        "createdBy": field(row, "createdBy"),
        "createdAt": field(row, "createdAt"),
        "updatedAt": field(row, "updatedAt"),
    })
}

/// `presentProfile(row, memberId)`: a member without a row gets the defaults.
pub fn present_profile(row: Option<&Value>, member_id: &str) -> Value {
    json!({
        "memberId": member_id,
        "weeklyHours": number_value(row.map_or(DEFAULT_WEEKLY_HOURS, |r| numeric(&r["weeklyHours"]))),
        "skills": row.map_or_else(|| json!([]), |r| field(r, "skills")),
        "hasProfile": row.is_some(),
        "updatedAt": row.map_or(Value::Null, |r| field(r, "updatedAt")),
    })
}

/// `hoursText(hours)`: two decimals, as the numeric column stores them.
pub fn hours_text(hours: f64) -> String {
    crate::js::to_fixed(hours, 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(text: &str) -> i64 {
        parse_date(text).expect("a real date")
    }

    #[test]
    fn dates_are_real_calendar_dates_only() {
        assert_eq!(format_date(day("2026-11-02")), "2026-11-02");
        assert_eq!(day("1970-01-01"), 0);
        for bad in [
            "2026-02-30",
            "2026-13-01",
            "2026-00-10",
            "26-01-01",
            "2026-1-01",
            "1969-12-31",
            "2201-01-01",
            "abc",
            "2026-11-0٣",
        ] {
            assert_eq!(parse_date(bad), None, "{bad}");
        }
        assert_eq!(day("2028-02-29"), day("2028-02-28") + 1);
    }

    #[test]
    fn the_iso_week_of_a_day() {
        assert_eq!(weekday_of(day("2026-11-02")), 0);
        assert_eq!(weekday_of(day("2026-11-08")), 6);
        assert_eq!(format_date(monday_of(day("2026-11-08"))), "2026-11-02");
        assert_eq!(iso_week_label(day("2026-11-02")), "2026-W45");
        assert_eq!(iso_week_label(day("2026-12-28")), "2026-W53");
        assert_eq!(iso_week_label(day("2027-01-04")), "2027-W01");
        assert_eq!(iso_week_label(day("2024-12-30")), "2025-W01");
        assert_eq!(iso_week_label(day("2026-01-05")), "2026-W02");
    }

    #[test]
    fn working_days_run_monday_to_friday() {
        assert_eq!(
            working_days_between(day("2026-11-02"), day("2026-11-06")),
            5
        );
        assert_eq!(
            working_days_between(day("2026-11-02"), day("2026-11-08")),
            5
        );
        assert_eq!(
            working_days_between(day("2026-11-07"), day("2026-11-08")),
            0
        );
        assert_eq!(
            working_days_between(day("2026-11-04"), day("2026-11-10")),
            5
        );
        assert_eq!(
            working_days_between(day("2026-11-03"), day("2026-11-02")),
            0
        );
        assert_eq!(
            working_days_between(day("2026-11-02"), day("2026-12-31")),
            44
        );
    }

    #[test]
    fn rounding_is_math_round() {
        assert!((round2(1.005) - 1.0).abs() < f64::EPSILON);
        assert!((round2(2.675) - 2.68).abs() < f64::EPSILON);
        assert!((round2(0.125) - 0.13).abs() < f64::EPSILON);
    }

    #[test]
    fn periods_and_booking_targets() {
        assert_eq!(period_error("2026-11-02", "2026-11-02"), None);
        assert_eq!(
            period_error("2026-11-03", "2026-11-02"),
            Some(messages::PERIOD_ORDER)
        );
        assert_eq!(
            period_error("2026-02-30", "2026-03-02"),
            Some(messages::INVALID_DATE)
        );
        assert_eq!(booking_target_error(Some("p"), None), None);
        assert_eq!(booking_target_error(None, Some("r")), None);
        assert_eq!(
            booking_target_error(Some("p"), Some("r")),
            Some(messages::BOOKING_TARGET)
        );
        assert_eq!(
            booking_target_error(None, None),
            Some(messages::BOOKING_TARGET)
        );
    }

    #[test]
    fn ranges() {
        let r = capacity_range(None, None, "2026-11-04").expect("range");
        assert_eq!(
            (r.from.as_str(), r.to.as_str(), r.weeks),
            ("2026-11-02", "2027-02-07", 14)
        );
        let r =
            capacity_range(Some("2026-11-04"), Some("2026-11-18"), "2026-11-04").expect("range");
        assert_eq!(
            (r.from.as_str(), r.to.as_str(), r.weeks),
            ("2026-11-02", "2026-11-22", 3)
        );
        assert_eq!(
            capacity_range(Some("2026-02-30"), None, "2026-11-04"),
            Err(messages::INVALID_DATE)
        );
        assert_eq!(
            capacity_range(Some("2026-11-10"), Some("2026-11-09"), "2026-11-04"),
            Err(messages::PERIOD_ORDER)
        );
        assert_eq!(
            capacity_range(Some("2026-11-02"), Some("2027-05-03"), "2026-11-04"),
            Err(messages::RANGE_TOO_LONG)
        );
        let r = capacity_range(Some("2026-11-02"), Some("2027-05-02"), "2026-11-04").expect("26");
        assert_eq!((r.to.as_str(), r.weeks), ("2027-05-02", 26));

        let road = roadmap_range(None, None, "2026-11-03").expect("roadmap");
        assert_eq!(
            (road.from.as_str(), road.to.as_str(), road.quarters),
            ("2026-10-01", "2027-09-30", 4)
        );
        let road = roadmap_range(Some("2026-05-20"), Some("2026-06-01"), "2026-11-03").expect("q");
        assert_eq!(
            (road.from.as_str(), road.to.as_str(), road.quarters),
            ("2026-04-01", "2026-06-30", 1)
        );
        let road = roadmap_range(Some("2026-01-01"), Some("2027-12-31"), "2026-11-03").expect("8");
        assert_eq!(road.quarters, 8);
        assert_eq!(
            roadmap_range(Some("2026-01-01"), Some("2028-01-01"), "2026-11-03"),
            Err(messages::ROADMAP_TOO_LONG)
        );
        assert_eq!(
            roadmap_range(Some("2026-05-02"), Some("2026-05-01"), "2026-11-03"),
            Err(messages::PERIOD_ORDER)
        );
    }

    #[test]
    fn the_fit_window() {
        let w = fit_range(Some("2027-01-11"), Some("2027-03-31"), "2026-11-03");
        assert_eq!(
            (w.from.as_str(), w.to.as_str(), w.weeks),
            ("2027-01-11", "2027-04-04", 12)
        );
        let w = fit_range(Some("2027-01-11"), Some("2028-12-31"), "2026-11-03");
        assert_eq!((w.to.as_str(), w.weeks), ("2027-07-11", 26));
        let w = fit_range(None, None, "2026-11-04");
        assert_eq!(
            (w.from.as_str(), w.to.as_str(), w.weeks),
            ("2026-11-02", "2027-02-07", 14)
        );
        let w = fit_range(Some("2027-01-11"), Some("2026-12-01"), "2026-11-04");
        assert_eq!((w.to.as_str(), w.weeks), ("2027-04-18", 14));
        let w = weeks_covering("2026-10-01", "2027-09-30");
        assert_eq!(
            (w.from.as_str(), w.to.as_str(), w.weeks),
            ("2026-09-28", "2027-10-03", 53)
        );
    }

    fn member(id: &str, hours: f64, skills: &[&str]) -> CapacityMember {
        CapacityMember {
            member_id: id.to_owned(),
            weekly_hours: hours,
            skills: skills.iter().map(|s| (*s).to_owned()).collect(),
            has_profile: true,
        }
    }

    fn booking(project: Option<&str>, from: &str, to: &str, hours: f64) -> CapacityBooking {
        CapacityBooking {
            member_id: "anna".to_owned(),
            project_id: project.map(str::to_owned),
            request_id: None,
            starts_on: from.to_owned(),
            ends_on: to.to_owned(),
            hours_per_week: hours,
            tentative: false,
        }
    }

    fn task(from: Option<&str>, to: Option<&str>, hours: f64) -> CapacityTask {
        CapacityTask {
            project_id: "p1".to_owned(),
            assignee_id: Some("anna".to_owned()),
            assignee_ids: None,
            starts_on: from.map(str::to_owned),
            due_on: to.map(str::to_owned),
            estimated_hours: hours,
        }
    }

    fn load(
        members: &[CapacityMember],
        bookings: &[CapacityBooking],
        tasks: &[CapacityTask],
        tentative: bool,
    ) -> CapacityLoad {
        compute_capacity(&CapacityInput {
            from: "2026-11-02",
            weeks: 3,
            members,
            bookings,
            tasks,
            include_tentative: tentative,
            skill: None,
        })
    }

    fn hours(load: &CapacityLoad, id: &str) -> Vec<f64> {
        load.members
            .iter()
            .find(|m| m.member_id == id)
            .expect("member")
            .cells
            .iter()
            .map(|c| c.hours)
            .collect()
    }

    #[test]
    fn bookings_add_their_hours_per_week_scaled_by_working_days() {
        let m = [member("anna", 40.0, &[])];
        let l = load(
            &m,
            &[booking(Some("p1"), "2026-11-02", "2026-11-13", 20.0)],
            &[],
            false,
        );
        assert_eq!(hours(&l, "anna"), vec![20.0, 20.0, 0.0]);
        assert_eq!(l.weeks[0].week, "2026-W45");
        let l = load(
            &m,
            &[booking(Some("p1"), "2026-11-04", "2026-11-10", 30.0)],
            &[],
            false,
        );
        assert_eq!(hours(&l, "anna"), vec![18.0, 12.0, 0.0]);
        let l = load(
            &m,
            &[booking(Some("p1"), "2026-11-07", "2026-11-08", 20.0)],
            &[],
            false,
        );
        assert_eq!(hours(&l, "anna"), vec![0.0, 0.0, 0.0]);
        assert_eq!(l.members[0].projects.len(), 0);
    }

    #[test]
    fn tentative_bookings_count_only_when_asked() {
        let m = [member("anna", 40.0, &[])];
        let mut held = booking(None, "2026-11-02", "2026-11-13", 10.0);
        held.request_id = Some("prq_1".to_owned());
        held.tentative = true;
        let all = [booking(Some("p1"), "2026-11-02", "2026-11-13", 20.0), held];
        assert_eq!(
            hours(&load(&m, &all, &[], false), "anna"),
            vec![20.0, 20.0, 0.0]
        );
        let with = load(&m, &all, &[], true);
        assert_eq!(hours(&with, "anna"), vec![30.0, 30.0, 0.0]);
        let tentative: Vec<f64> = with.members[0]
            .cells
            .iter()
            .map(|c| c.tentative_hours)
            .collect();
        assert_eq!(tentative, vec![10.0, 10.0, 0.0]);
        assert_eq!(with.members[0].projects.len(), 2);
    }

    #[test]
    fn task_estimates_spread_over_working_days_and_yield_to_a_booking() {
        let m = [member("anna", 40.0, &[])];
        let t = [task(Some("2026-11-02"), Some("2026-11-13"), 20.0)];
        assert_eq!(
            hours(&load(&m, &[], &t, false), "anna"),
            vec![10.0, 10.0, 0.0]
        );
        let t = [task(Some("2026-11-04"), Some("2026-11-10"), 10.0)];
        assert_eq!(
            hours(&load(&m, &[], &t, false), "anna"),
            vec![6.0, 4.0, 0.0]
        );
        let t = [task(None, Some("2026-11-11"), 8.0)];
        assert_eq!(
            hours(&load(&m, &[], &t, false), "anna"),
            vec![0.0, 8.0, 0.0]
        );
        let t = [task(None, None, 8.0)];
        assert_eq!(
            hours(&load(&m, &[], &t, false), "anna"),
            vec![0.0, 0.0, 0.0]
        );
        let t = [task(Some("2026-11-07"), Some("2026-11-08"), 5.0)];
        assert_eq!(
            hours(&load(&m, &[], &t, false), "anna"),
            vec![5.0, 0.0, 0.0]
        );
        let t = [task(Some("2026-11-06"), Some("2026-11-02"), 10.0)];
        assert_eq!(
            hours(&load(&m, &[], &t, false), "anna"),
            vec![10.0, 0.0, 0.0]
        );

        let b = [booking(Some("p1"), "2026-11-02", "2026-11-08", 20.0)];
        let t = [task(Some("2026-11-02"), Some("2026-11-13"), 20.0)];
        assert_eq!(
            hours(&load(&m, &b, &t, false), "anna"),
            vec![20.0, 10.0, 0.0]
        );
        let b = [booking(Some("p2"), "2026-11-02", "2026-11-08", 20.0)];
        let t = [task(Some("2026-11-02"), Some("2026-11-06"), 10.0)];
        assert_eq!(
            hours(&load(&m, &b, &t, false), "anna"),
            vec![30.0, 0.0, 0.0]
        );
    }

    #[test]
    fn an_estimate_is_split_over_the_assignees() {
        let m = [member("anna", 40.0, &[]), member("bob", 40.0, &[])];
        let mut shared = task(Some("2026-11-02"), Some("2026-11-06"), 10.0);
        shared.assignee_ids = Some(vec!["anna".to_owned(), "bob".to_owned()]);
        let l = load(&m, &[], &[shared], false);
        assert_eq!(hours(&l, "anna"), vec![5.0, 0.0, 0.0]);
        assert_eq!(hours(&l, "bob"), vec![5.0, 0.0, 0.0]);
    }

    #[test]
    fn bands_and_the_summary() {
        assert_eq!(capacity_band(0.0, Some(0.0)), CapacityBand::None);
        assert_eq!(capacity_band(10.0, Some(25.0)), CapacityBand::Under);
        assert_eq!(capacity_band(20.0, Some(50.0)), CapacityBand::Ok);
        assert_eq!(capacity_band(32.0, Some(80.0)), CapacityBand::Full);
        assert_eq!(capacity_band(40.4, Some(101.0)), CapacityBand::Over);
        assert_eq!(capacity_band(48.4, Some(121.0)), CapacityBand::Critical);
        assert_eq!(capacity_band(5.0, None), CapacityBand::Critical);
        assert_eq!(load_percent(10.0, 0.0), None);

        let m = [
            member("anna", 40.0, &[]),
            member("bob", 20.0, &[]),
            member("cleo", 0.0, &[]),
        ];
        let mut bob = booking(Some("p1"), "2026-11-02", "2026-11-13", 30.0);
        bob.member_id = "bob".to_owned();
        let mut cleo = booking(Some("p1"), "2026-11-02", "2026-11-13", 4.0);
        cleo.member_id = "cleo".to_owned();
        let l = load(
            &m,
            &[
                booking(Some("p1"), "2026-11-02", "2026-11-13", 30.0),
                bob,
                cleo,
            ],
            &[],
            false,
        );
        assert_eq!(l.summary.member_count, 3);
        assert!((l.summary.booked_hours - 128.0).abs() < f64::EPSILON);
        assert!((l.summary.capacity_hours - 180.0).abs() < f64::EPSILON);
        assert_eq!(l.summary.percent, Some(71.11));
        assert_eq!(l.summary.overbooked_person_weeks, 4);
    }

    #[test]
    fn suggestions_and_fit() {
        let members = [
            member("anna", 40.0, &["Frontend"]),
            member("bob", 40.0, &["frontend", "Design"]),
            member("cleo", 40.0, &["Backend"]),
            member("dan", 32.0, &["Frontend"]),
        ];
        let mut anna = booking(Some("p1"), "2026-11-02", "2026-11-22", 30.0);
        anna.member_id = "anna".to_owned();
        let mut bob = booking(Some("p1"), "2026-11-09", "2026-11-15", 10.0);
        bob.member_id = "bob".to_owned();
        let mut dan = booking(Some("p1"), "2026-11-02", "2026-11-08", 8.0);
        dan.member_id = "dan".to_owned();
        dan.tentative = true;
        let l = load(&members, &[anna, bob, dan], &[], true);
        let need = ResourceNeed {
            skill: "frontend",
            hours_per_week: 20.0,
            starts_on: "2026-11-04",
            ends_on: "2026-11-18",
        };
        let s = suggest_members(&l, &need);
        let got: Vec<(&str, f64, f64, bool)> = s
            .iter()
            .map(|x| {
                (
                    x.member_id.as_str(),
                    x.free_hours_per_week,
                    x.average_free_hours_per_week,
                    x.covers_request,
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                ("bob", 30.0, 36.67, true),
                ("dan", 24.0, 29.33, true),
                ("anna", 10.0, 10.0, false),
            ]
        );
        let fit = skill_fit(
            &l,
            &[
                NeededSkill {
                    skill: "Frontend".to_owned(),
                    hours_per_week: Some(75.0),
                },
                NeededSkill {
                    skill: "Security".to_owned(),
                    hours_per_week: Some(4.0),
                },
                NeededSkill {
                    skill: "Backend".to_owned(),
                    hours_per_week: None,
                },
            ],
        );
        assert_eq!(fit[0]["freeHoursPerWeek"], json!(72));
        assert_eq!(fit[0]["shortWeeks"], json!(2));
        assert_eq!(fit[0]["short"], json!(true));
        assert_eq!(fit[1]["shortWeeks"], json!(3));
        assert_eq!(fit[2]["needHoursPerWeek"], Value::Null);
        assert_eq!(fit[2]["freeHoursPerWeek"], json!(40));
    }

    #[test]
    fn members_are_collected_once_by_id() {
        let profiles = [CapacityProfile {
            member_id: "zoe".to_owned(),
            weekly_hours: 32.0,
            skills: vec!["QA".to_owned()],
        }];
        let bookings = [booking(Some("p"), "2026-11-02", "2026-11-03", 1.0)];
        let mut task_a = task(None, None, 1.0);
        task_a.assignee_id = Some("cleo".to_owned());
        let mut task_b = task(None, None, 1.0);
        task_b.assignee_id = None;
        task_b.assignee_ids = Some(vec!["dan".to_owned(), "anna".to_owned()]);
        let people = ["zoe".to_owned(), "eve".to_owned(), String::new()];
        let members = collect_members(&profiles, &bookings, &[task_a, task_b], &people);
        let ids: Vec<&str> = members.iter().map(|m| m.member_id.as_str()).collect();
        assert_eq!(ids, vec!["anna", "cleo", "dan", "eve", "zoe"]);
        assert!(members[3].weekly_hours.eq(&40.0) && !members[3].has_profile);
        assert_eq!(
            normalize_skills(&[
                " Backend ".to_owned(),
                "backend".to_owned(),
                "QA".to_owned(),
                String::new(),
                "qa ".to_owned()
            ]),
            vec!["Backend".to_owned(), "QA".to_owned()]
        );
    }

    #[test]
    fn the_roll_up_follows_the_thursday_of_each_week() {
        let members = [member("anna", 40.0, &[])];
        let l = compute_capacity(&CapacityInput {
            from: "2026-09-28",
            weeks: 14,
            members: &members,
            bookings: &[booking(Some("p1"), "2026-09-28", "2027-01-03", 20.0)],
            tasks: &[],
            include_tentative: false,
            skill: None,
        });
        let quarters = rollup_load(&l.weeks, &l.totals, "2026-10-01", "2026-12-31", true);
        assert_eq!(quarters.len(), 1);
        assert_eq!(quarters[0]["key"], json!("2026-Q4"));
        assert_eq!(quarters[0]["bookedHours"], json!(280));
        assert_eq!(quarters[0]["capacityHours"], json!(560));
        assert_eq!(quarters[0]["percent"], json!(50));
        let months = rollup_load(&l.weeks, &l.totals, "2026-10-01", "2026-12-31", false);
        let capacity: Vec<&Value> = months.iter().map(|m| &m["capacityHours"]).collect();
        assert_eq!(capacity, vec![&json!(200), &json!(160), &json!(200)]);
        let empty = rollup_load(
            &l.weeks[..1],
            &l.totals[..1],
            "2026-11-01",
            "2026-12-31",
            false,
        );
        assert_eq!(empty[1]["percent"], Value::Null);
        assert_eq!(empty[1]["startsOn"], json!("2026-12-01"));
    }

    #[test]
    fn rows_are_presented_as_the_routes_answer_them() {
        let booking = json!({
            "id": "bkg_1", "memberId": "m", "projectId": "p", "requestId": null,
            "startsOn": "2026-11-02", "endsOn": "2026-11-13", "hoursPerWeek": "12.50",
            "tentative": false, "createdBy": "u", "createdAt": "2026-11-01T00:00:00.000Z",
            "updatedAt": "2026-11-01T00:00:00.000Z", "deletedAt": null,
        });
        let shown = present_booking(&booking);
        assert_eq!(shown["hoursPerWeek"], json!("12.50"));
        assert!(shown.get("deletedAt").is_none());
        assert!(
            resource_request_event_data(&booking)
                .get("projectName")
                .is_none()
        );
        assert_eq!(
            present_profile(None, "m"),
            json!({ "memberId": "m", "weeklyHours": 40, "skills": [], "hasProfile": false, "updatedAt": null })
        );
        let profile = json!({ "weeklyHours": "32.00", "skills": ["QA"], "updatedAt": "2026-11-01T00:00:00.000Z" });
        assert_eq!(
            present_profile(Some(&profile), "m")["weeklyHours"],
            json!(32)
        );
        assert_eq!(hours_text(12.5), "12.50");
    }
}
