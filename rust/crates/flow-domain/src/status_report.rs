//! Status report rules (`@weldsuite/flow-domain/status-report`): the colour of
//! each area and of the report, the period and the slots a project's cadence
//! reports on, how a refresh merges the computed parts with what the project
//! manager wrote, and the shapes a report takes on the wire and in entity
//! events (design: weldflow-delivery-and-portfolio.md, ADR FLOW-018).
//!
//! Pure functions, no database. Instants are milliseconds since the epoch.
//! Rows are read as `weldsuite_db::js_row` gives them (camelCase keys, ISO
//! timestamps). Every message returned here goes to the client as it is.

use serde_json::{Map, Value, json};

use crate::js::{
    civil_from_days, days_from_civil, iso_from_millis, js_date, math_round, millis_of, number_value,
};

pub const AREAS: [&str; 5] = ["schedule", "budget", "scope", "risk", "benefits"];
pub const SNAPSHOT_VERSION: i64 = 1;

const DAY_MS: i64 = 86_400_000;

pub const GO_LIVE_RED_DAYS: i64 = 7;
pub const SCHEDULE_ITEM_RED_DAYS: i64 = 14;
pub const CPI_AMBER_BELOW: f64 = 0.95;
pub const CPI_RED_BELOW: f64 = 0.85;
pub const FORECAST_RED_OVER: f64 = 0.1;
pub const SCOPE_RED_PENDING: i64 = 3;
pub const CRITICAL_SCORE: i64 = 17;
pub const BENEFIT_AMBER_GAP: f64 = 0.1;
pub const BENEFIT_RED_GAP: f64 = 0.25;
pub const TOP_RISKS: usize = 3;
pub const DECISIONS_LISTED: usize = 5;
pub const CHANGES_LISTED: usize = 5;
pub const MILESTONES_LISTED: usize = 10;
pub const ITEMS_LISTED: usize = 10;

// ── Messages ────────────────────────────────────────────────────────────────

pub const PUBLISHED_IMMUTABLE: &str = "A published report cannot be changed";
pub const SUMMARY_REQUIRED: &str = "Write a summary before publishing";
pub const OVERALL_REQUIRED: &str = "Set an overall status before publishing";
pub const PERIOD_DRAFT_EXISTS: &str = "A draft already exists for this period";

// ── Days ────────────────────────────────────────────────────────────────────

pub fn start_of_day(ms: i64) -> i64 {
    ms.div_euclid(DAY_MS) * DAY_MS
}

pub fn add_days(ms: i64, days: i64) -> i64 {
    ms + days * DAY_MS
}

/// Whole UTC days from `from` to `to`.
pub fn day_diff(from: i64, to: i64) -> i64 {
    (start_of_day(to) - start_of_day(from)) / DAY_MS
}

/// ISO weekday: 1 = Monday ... 7 = Sunday.
pub fn iso_weekday(ms: i64) -> i64 {
    // 1970-01-01 was a Thursday (4).
    (ms.div_euclid(DAY_MS) + 3).rem_euclid(7) + 1
}

/// `(year, civil month, day of month)` of an instant.
fn civil(ms: i64) -> (i64, i64, i64) {
    civil_from_days(ms.div_euclid(DAY_MS))
}

fn utc(year: i64, month: i64, day: i64) -> i64 {
    days_from_civil(year, month, day) * DAY_MS
}

/// The ISO 8601 week a date falls in.
pub fn iso_week(ms: i64) -> (i64, i64) {
    let day = start_of_day(ms);
    let thursday = add_days(day, 4 - iso_weekday(day));
    let (year, _, _) = civil(thursday);
    let first = utc(year, 1, 1);
    (year, day_diff(first, thursday) / 7 + 1)
}

/// `2026-W45`.
pub fn week_period(ms: i64) -> String {
    let (year, week) = iso_week(ms);
    format!("{year}-W{week:02}")
}

/// `2026-11`.
pub fn month_period(ms: i64) -> String {
    let (year, month, _) = civil(ms);
    format!("{year}-{month:02}")
}

/// Days a report of this period looks back and forward over.
pub fn window_days(period: &str, cadence: Option<&str>) -> i64 {
    if period.contains('W') {
        if cadence == Some("biweekly") { 14 } else { 7 }
    } else {
        31
    }
}

// ── Slots ───────────────────────────────────────────────────────────────────

const SLOT_SEARCH_DAYS: i64 = 62;

/// Whether `day` is a slot day of the cadence.
pub fn is_slot_day(cadence: &str, weekday: i64, day: i64) -> bool {
    let day_of_week = iso_weekday(day);
    if cadence == "monthly" {
        let (_, _, dom) = civil(day);
        return day_of_week <= 5 && (dom == 1 || (day_of_week == 1 && dom <= 3));
    }
    if day_of_week != weekday {
        return false;
    }
    cadence == "weekly" || iso_week(day).1 % 2 == 0
}

/// The latest slot day at or before `now`.
pub fn last_slot_on_or_before(cadence: &str, weekday: i64, now: i64) -> i64 {
    let mut day = start_of_day(now);
    for _ in 0..SLOT_SEARCH_DAYS {
        if is_slot_day(cadence, weekday, day) {
            return day;
        }
        day = add_days(day, -1);
    }
    start_of_day(now)
}

/// The first slot day after `now`.
pub fn next_slot_after(cadence: &str, weekday: i64, now: i64) -> i64 {
    let mut day = add_days(start_of_day(now), 1);
    for _ in 0..SLOT_SEARCH_DAYS {
        if is_slot_day(cadence, weekday, day) {
            return day;
        }
        day = add_days(day, 1);
    }
    add_days(start_of_day(now), 1)
}

/// The period a slot's report covers.
pub fn period_for_slot(cadence: &str, slot: i64) -> String {
    if cadence == "monthly" {
        let (year, month, _) = civil(slot);
        return month_period(utc(year, month - 1, 1));
    }
    week_period(add_days(slot, -1))
}

/// The period `POST /` reports on when the body names none.
pub fn default_period(schedule: Option<(&str, i64)>, now: i64) -> String {
    match schedule {
        None => week_period(now),
        Some((cadence, weekday)) => {
            period_for_slot(cadence, next_slot_after(cadence, weekday, now))
        }
    }
}

// ── Colours ─────────────────────────────────────────────────────────────────

/// What an area computed: its colour, a code the UI turns into a sentence, and the parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct AreaResult {
    pub colour: &'static str,
    pub code: &'static str,
    pub params: Value,
}

impl AreaResult {
    fn new(colour: &'static str, code: &'static str, params: Value) -> Self {
        Self {
            colour,
            code,
            params,
        }
    }

    pub fn to_value(&self) -> Value {
        json!({ "colour": self.colour, "code": self.code, "params": self.params })
    }
}

fn rank(colour: &str) -> i64 {
    match colour {
        "green" => 1,
        "amber" => 2,
        "red" => 3,
        _ => 0,
    }
}

/// The worst of the colours; grey when none has data.
pub fn worst_colour<'a>(colours: impl IntoIterator<Item = &'a str>) -> &'static str {
    let mut worst = "grey";
    for colour in colours {
        if rank(colour) > rank(worst) {
            worst = match colour {
                "green" => "green",
                "amber" => "amber",
                _ => "red",
            };
        }
    }
    worst
}

pub fn overall_colour(areas: &[AreaResult]) -> &'static str {
    worst_colour(areas.iter().map(|area| area.colour))
}

fn round2(value: f64) -> f64 {
    math_round(value * 100.0) / 100.0
}

// -- Schedule --

#[derive(Debug, Clone)]
pub struct ScheduleItem {
    /// `milestone`, `deliverable` or `go_live`.
    pub kind: &'static str,
    pub id: Option<String>,
    pub name: String,
    pub baseline: Option<i64>,
    pub current: Option<i64>,
    pub done: bool,
}

fn iso(ms: i64) -> Value {
    iso_from_millis(ms).map_or(Value::Null, Value::String)
}

/// The schedule area and the rows of the milestone table.
pub fn schedule_area(
    baseline_version: Option<i64>,
    items: &[ScheduleItem],
    as_of: i64,
) -> (AreaResult, Vec<Value>) {
    struct Row<'a> {
        item: &'a ScheduleItem,
        forecast: Option<i64>,
        variance: Option<i64>,
    }
    let mut rows: Vec<Row<'_>> = items
        .iter()
        .filter(|item| !item.done && (item.current.is_some() || item.baseline.is_some()))
        .map(|item| {
            let forecast = item.current.or(item.baseline);
            let slipped = match forecast {
                Some(at) if day_diff(as_of, at) < 0 => Some(start_of_day(as_of)),
                other => other,
            };
            let variance = match (item.baseline, slipped) {
                (Some(base), Some(at)) => Some(day_diff(base, at)),
                _ => None,
            };
            Row {
                item,
                forecast: slipped,
                variance,
            }
        })
        .collect();
    rows.sort_by_key(|row| row.item.baseline.unwrap_or(i64::MAX));
    let listed: Vec<Value> = rows
        .iter()
        .take(MILESTONES_LISTED)
        .map(|row| {
            json!({
                "kind": row.item.kind,
                "id": row.item.id,
                "name": row.item.name,
                "baselineDate": row.item.baseline.map_or(Value::Null, iso),
                "forecastDate": row.forecast.map_or(Value::Null, iso),
                "varianceDays": row.variance,
            })
        })
        .collect();
    let Some(version) = baseline_version else {
        return (
            AreaResult::new("grey", "schedule.no_baseline", json!({})),
            listed,
        );
    };
    let go_live_days = rows
        .iter()
        .find(|row| row.item.kind == "go_live")
        .and_then(|row| row.variance);
    let mut worst_days = 0;
    let mut worst_name: Option<&str> = None;
    let mut behind = 0;
    for row in &rows {
        let Some(variance) = row.variance else {
            continue;
        };
        if variance <= 0 {
            continue;
        }
        behind += 1;
        if variance > worst_days {
            worst_days = variance;
            worst_name = Some(&row.item.name);
        }
    }
    let colour = if go_live_days.is_some_and(|days| days > GO_LIVE_RED_DAYS)
        || worst_days > SCHEDULE_ITEM_RED_DAYS
    {
        "red"
    } else if worst_days > 0 {
        "amber"
    } else {
        "green"
    };
    let area = if colour == "green" {
        AreaResult::new(
            "green",
            "schedule.on_track",
            json!({ "baselineVersion": version }),
        )
    } else {
        AreaResult::new(
            colour,
            "schedule.behind",
            json!({
                "baselineVersion": version,
                "worstDays": worst_days,
                "worstName": worst_name,
                "behindCount": behind,
                "goLiveDays": go_live_days,
            }),
        )
    };
    (area, listed)
}

// -- Budget --

/// The latest finance snapshot, numeric columns as text.
#[derive(Debug, Clone)]
pub struct FinanceFigures {
    pub week: String,
    pub budget: Option<String>,
    pub planned_value: String,
    pub earned_value: String,
    pub actual_cost: String,
    pub forecast: Option<String>,
}

fn number(text: &str) -> f64 {
    weldsuite_kit::validation::js_number(text)
}

fn optional_number(text: Option<&String>) -> Option<f64> {
    text.map(|text| number(text))
}

fn ratio(numerator: f64, divisor: f64) -> Option<f64> {
    (divisor > 0.0).then(|| round2(numerator / divisor))
}

/// The `figures.budget` object: the snapshot with CPI and SPI.
pub fn budget_figures(finance: &FinanceFigures) -> Value {
    let earned = number(&finance.earned_value);
    json!({
        "week": finance.week,
        "budget": finance.budget,
        "plannedValue": finance.planned_value,
        "earnedValue": finance.earned_value,
        "actualCost": finance.actual_cost,
        "forecast": finance.forecast,
        "cpi": ratio(earned, number(&finance.actual_cost)).map_or(Value::Null, number_value),
        "spi": ratio(earned, number(&finance.planned_value)).map_or(Value::Null, number_value),
    })
}

/// The budget area (grey without a snapshot) and the figures.
pub fn budget_area(
    finance: Option<&FinanceFigures>,
    currency: Option<&str>,
) -> (AreaResult, Value) {
    let Some(finance) = finance else {
        return (
            AreaResult::new("grey", "budget.no_data", json!({})),
            Value::Null,
        );
    };
    let figures = budget_figures(finance);
    let earned = number(&finance.earned_value);
    let actual = number(&finance.actual_cost);
    let cpi = (actual > 0.0).then(|| earned / actual);
    let budget = optional_number(finance.budget.as_ref());
    let forecast = optional_number(finance.forecast.as_ref());
    let overrun = match (budget, forecast) {
        (Some(budget), Some(forecast)) if budget > 0.0 => Some((forecast - budget) / budget),
        _ => None,
    };
    let colour = if cpi.is_some_and(|cpi| cpi < CPI_RED_BELOW)
        || overrun.is_some_and(|over| over > FORECAST_RED_OVER)
    {
        "red"
    } else if cpi.is_some_and(|cpi| cpi < CPI_AMBER_BELOW) || overrun.is_some_and(|over| over > 0.0)
    {
        "amber"
    } else {
        "green"
    };
    let params = json!({
        "week": finance.week,
        "cpi": figures["cpi"],
        "budget": finance.budget,
        "forecast": finance.forecast,
        "actualCost": finance.actual_cost,
        "earnedValue": finance.earned_value,
        "currency": currency,
    });
    let code = if colour == "green" {
        "budget.on_budget"
    } else {
        "budget.over"
    };
    (AreaResult::new(colour, code, params), figures)
}

// -- Scope --

pub fn scope_area(pending: i64) -> AreaResult {
    if pending == 0 {
        return AreaResult::new("green", "scope.none_pending", json!({}));
    }
    let colour = if pending >= SCOPE_RED_PENDING {
        "red"
    } else {
        "amber"
    };
    AreaResult::new(colour, "scope.pending", json!({ "count": pending }))
}

// -- Risk --

#[derive(Debug, Clone)]
pub struct OpenRisk {
    pub code: String,
    pub score: i64,
}

pub fn risk_area(risks: &[OpenRisk], appetite: i64) -> AreaResult {
    let Some(first) = risks.first() else {
        return AreaResult::new("green", "risk.no_open_risks", json!({}));
    };
    let mut highest = first;
    for risk in risks {
        if risk.score > highest.score {
            highest = risk;
        }
    }
    if highest.score <= appetite {
        return AreaResult::new(
            "green",
            "risk.within_appetite",
            json!({ "highest": highest.score, "code": highest.code, "appetite": appetite }),
        );
    }
    let above = risks.iter().filter(|risk| risk.score > appetite).count();
    let colour = if highest.score >= CRITICAL_SCORE {
        "red"
    } else {
        "amber"
    };
    AreaResult::new(
        colour,
        "risk.above_appetite",
        json!({
            "highest": highest.score,
            "code": highest.code,
            "appetite": appetite,
            "aboveCount": above,
        }),
    )
}

// -- Benefits --

#[derive(Debug, Clone)]
pub struct BenefitInput {
    pub code: String,
    pub status: String,
    pub baseline: Option<f64>,
    pub target: Option<f64>,
    pub latest: Option<f64>,
    pub created_at: i64,
    pub realise_by: Option<i64>,
}

/// 0 at the baseline, 1 at the target; `None` without the three figures.
pub fn benefit_progress(
    baseline: Option<f64>,
    target: Option<f64>,
    latest: Option<f64>,
) -> Option<f64> {
    let (baseline, target, latest) = (baseline?, target?, latest?);
    #[allow(clippy::float_cmp)]
    if baseline == target {
        return None;
    }
    Some(((latest - baseline) / (target - baseline)).max(0.0))
}

#[allow(clippy::cast_precision_loss)]
pub fn benefit_expected(created_at: i64, realise_by: Option<i64>, as_of: i64) -> f64 {
    let Some(realise_by) = realise_by else {
        return 0.0;
    };
    let span = realise_by - created_at;
    if span <= 0 {
        return 1.0;
    }
    ((as_of - created_at) as f64 / span as f64).clamp(0.0, 1.0)
}

pub fn benefits_area(benefits: &[BenefitInput], as_of: i64) -> AreaResult {
    if benefits.is_empty() {
        return AreaResult::new("grey", "benefits.none", json!({}));
    }
    let measured: Vec<&BenefitInput> = benefits
        .iter()
        .filter(|b| benefit_progress(b.baseline, b.target, b.latest).is_some())
        .collect();
    if measured.is_empty() {
        return AreaResult::new(
            "grey",
            "benefits.no_measurements",
            json!({ "count": benefits.len() }),
        );
    }
    let mut colour = "green";
    let mut behind = 0;
    let mut worst_code: Option<&str> = None;
    let mut worst_gap = 0.0;
    for benefit in &measured {
        let progress =
            benefit_progress(benefit.baseline, benefit.target, benefit.latest).unwrap_or(0.0);
        let gap = if benefit.status == "realised" {
            0.0
        } else {
            benefit_expected(benefit.created_at, benefit.realise_by, as_of) - progress
        };
        let own = if gap > BENEFIT_RED_GAP {
            "red"
        } else if gap > BENEFIT_AMBER_GAP || benefit.status == "at_risk" {
            "amber"
        } else {
            "green"
        };
        if own != "green" {
            behind += 1;
        }
        colour = worst_colour([colour, own]);
        if gap > worst_gap {
            worst_gap = gap;
            worst_code = Some(&benefit.code);
        }
    }
    if colour == "green" {
        AreaResult::new(
            "green",
            "benefits.on_track",
            json!({ "count": measured.len() }),
        )
    } else {
        AreaResult::new(
            colour,
            "benefits.behind",
            json!({ "count": measured.len(), "behind": behind, "worstCode": worst_code }),
        )
    }
}

// ── Draft building ──────────────────────────────────────────────────────────

/// `computed.areas` of the snapshot, in the report's area order.
pub fn computed_areas_of(areas: &[AreaResult; 5]) -> Value {
    let mut out = Map::new();
    for (key, area) in AREAS.iter().zip(areas) {
        out.insert((*key).to_owned(), area.to_value());
    }
    Value::Object(out)
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// The stored areas after a recomputation: an override keeps its colour and reason.
pub fn merge_areas(existing: Option<&[Value]>, computed: &[AreaResult; 5]) -> Vec<Value> {
    AREAS
        .iter()
        .zip(computed)
        .map(|(key, area)| {
            let own = existing.and_then(|areas| areas.iter().find(|a| text(a, "key") == Some(key)));
            match own {
                Some(own) if own.get("auto") == Some(&Value::Bool(false)) => json!({
                    "key": key,
                    "colour": own.get("colour").cloned().unwrap_or(Value::Null),
                    "reason": own.get("reason").cloned().unwrap_or(Value::Null),
                    "auto": false,
                }),
                _ => json!({ "key": key, "colour": area.colour, "reason": null, "auto": true }),
            }
        })
        .collect()
}

/// The overall colour after a refresh.
pub fn merge_overall(current: Option<&str>, previous: Option<&str>, suggestion: &str) -> String {
    match current {
        None => suggestion.to_owned(),
        Some(current) if Some(current) == previous => suggestion.to_owned(),
        Some(current) => current.to_owned(),
    }
}

/// A line the report filled in carries a code.
pub fn is_filled_in(item: &Value) -> bool {
    item.get("code").is_some_and(|code| !code.is_null())
}

/// Fresh lines first, then the ones the project manager wrote.
pub fn merge_items(existing: &[Value], fresh: &[Value]) -> Vec<Value> {
    fresh
        .iter()
        .cloned()
        .chain(existing.iter().filter(|item| !is_filled_in(item)).cloned())
        .collect()
}

/// A line as stored: every key present, `date` as `toISOString` writes it.
pub fn stored_item(item: &Map<String, Value>) -> Value {
    let date = item
        .get("date")
        .and_then(Value::as_str)
        .filter(|raw| !raw.is_empty())
        .map_or(Value::Null, |raw| {
            js_date(raw).map_or(Value::Null, Value::String)
        });
    json!({
        "taskId": item.get("taskId").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null),
        "text": item.get("text").cloned().unwrap_or(Value::Null),
        "code": item.get("code").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null),
        "date": date,
    })
}

// ── Recipients ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct RecipientCandidate {
    pub stakeholder_id: Option<String>,
    pub user_id: Option<String>,
    pub name: Option<String>,
    pub email: Option<String>,
    /// `member` or `contact`.
    pub kind: &'static str,
    pub portal_access: bool,
}

/// The `recipients` of a schedule: named stakeholders, or a rule.
#[derive(Debug, Clone, Default)]
pub struct ScheduleRecipients {
    pub stakeholder_ids: Option<Vec<String>>,
    pub rule: Option<String>,
}

fn ids_of(value: &Value) -> Option<Vec<String>> {
    value
        .get("stakeholderIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect()
        })
}

/// Who a report goes to: its own list, else the schedule's list, else the rule.
pub fn recipient_targets(
    stored: Option<&Value>,
    schedule: Option<&ScheduleRecipients>,
    register: &[RecipientCandidate],
    sponsor: Option<&RecipientCandidate>,
) -> Vec<RecipientCandidate> {
    let ids = stored
        .and_then(ids_of)
        .or_else(|| schedule.and_then(|s| s.stakeholder_ids.clone()));
    if let Some(ids) = ids {
        return ids
            .iter()
            .flat_map(|id| {
                register
                    .iter()
                    .filter(move |c| c.stakeholder_id.as_deref() == Some(id))
            })
            .cloned()
            .collect();
    }
    let rule = schedule
        .and_then(|s| s.rule.as_deref())
        .unwrap_or("sponsor");
    match rule {
        "all_stakeholders" => register.to_vec(),
        "portal_contacts" => register
            .iter()
            .filter(|c| c.portal_access && c.kind == "contact")
            .cloned()
            .collect(),
        _ => sponsor.cloned().into_iter().collect(),
    }
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

fn get(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// `computed.areas` of a stored snapshot.
fn snapshot_computed_areas(snapshot: &Value) -> Option<&Value> {
    snapshot.get("computed")?.get("areas")
}

pub fn present_areas(areas: &Value, snapshot: &Value) -> Value {
    let computed = snapshot_computed_areas(snapshot);
    let list = areas.as_array().map_or(&[][..], Vec::as_slice);
    Value::Array(
        list.iter()
            .map(|area| {
                let key = text(area, "key").unwrap_or_default();
                json!({
                    "key": get(area, "key"),
                    "colour": get(area, "colour"),
                    "reason": get(area, "reason"),
                    "auto": get(area, "auto"),
                    "computed": computed.and_then(|c| c.get(key)).cloned().unwrap_or(Value::Null),
                })
            })
            .collect(),
    )
}

fn present_item(item: &Value) -> Value {
    json!({
        "taskId": get(item, "taskId"),
        "text": get(item, "text"),
        "code": get(item, "code"),
        "date": get(item, "date"),
    })
}

pub fn present_summary(row: &Value, superseded_by: Option<&str>) -> Value {
    json!({
        "id": get(row, "id"),
        "projectId": get(row, "projectId"),
        "period": get(row, "period"),
        "status": get(row, "status"),
        "overall": get(row, "overall"),
        "areas": present_areas(&get(row, "areas"), &get(row, "snapshot")),
        "summary": get(row, "summary"),
        "clientVisible": get(row, "clientVisible"),
        "supersedesId": get(row, "supersedesId"),
        "supersededById": superseded_by,
        "publishedBy": get(row, "publishedBy"),
        "publishedAt": get(row, "publishedAt"),
        "createdBy": get(row, "createdBy"),
        "createdAt": get(row, "createdAt"),
        "updatedAt": get(row, "updatedAt"),
    })
}

pub fn present_report(row: &Value, superseded_by: Option<&str>, resolved: Vec<Value>) -> Value {
    let mut out = present_summary(row, superseded_by);
    let list = |key: &str| -> Value {
        Value::Array(
            row.get(key)
                .and_then(Value::as_array)
                .map_or_else(Vec::new, |items| items.iter().map(present_item).collect()),
        )
    };
    let recipients = match row.get("recipients") {
        Some(stored) if !stored.is_null() => match ids_of(stored) {
            Some(ids) => json!({ "stakeholderIds": ids }),
            None => json!({}),
        },
        _ => Value::Null,
    };
    if let Value::Object(fields) = &mut out {
        fields.insert("done".to_owned(), list("done"));
        fields.insert("next".to_owned(), list("next"));
        fields.insert("snapshot".to_owned(), get(row, "snapshot"));
        fields.insert("recipients".to_owned(), recipients);
        fields.insert("resolvedRecipients".to_owned(), Value::Array(resolved));
    }
    out
}

/// What an entity event of a report carries.
pub fn event_data(row: &Value) -> Value {
    json!({
        "id": get(row, "id"),
        "projectId": get(row, "projectId"),
        "period": get(row, "period"),
        "status": get(row, "status"),
        "overall": get(row, "overall"),
        "clientVisible": get(row, "clientVisible"),
        "supersedesId": get(row, "supersedesId"),
        "publishedAt": get(row, "publishedAt"),
    })
}

/// `projects.health` for a published colour; grey leaves it alone.
pub fn health_for_colour(colour: &str) -> Option<&'static str> {
    match colour {
        "green" => Some("on_track"),
        "amber" => Some("at_risk"),
        "red" => Some("off_track"),
        _ => None,
    }
}

/// Milliseconds of an ISO timestamp (a baseline's dates, a row's).
pub fn ms(text: &str) -> Option<i64> {
    millis_of(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(date: &str) -> i64 {
        millis_of(&format!("{date}T00:00:00.000Z")).expect("date")
    }

    #[test]
    fn iso_weeks_and_periods() {
        assert_eq!(week_period(d("2026-11-02")), "2026-W45");
        assert_eq!(week_period(d("2026-11-08")), "2026-W45");
        assert_eq!(week_period(d("2026-11-09")), "2026-W46");
        assert_eq!(week_period(d("2026-01-01")), "2026-W01");
        assert_eq!(week_period(d("2025-12-29")), "2026-W01");
        assert_eq!(week_period(d("2027-01-03")), "2026-W53");
        assert_eq!(week_period(d("2021-01-03")), "2020-W53");
        assert_eq!(iso_week(d("2024-12-30")), (2025, 1));
        assert_eq!(month_period(d("2026-11-30")), "2026-11");
        assert_eq!(month_period(d("2026-01-01")), "2026-01");
        assert_eq!(window_days("2026-W45", Some("weekly")), 7);
        assert_eq!(window_days("2026-W45", Some("biweekly")), 14);
        assert_eq!(window_days("2026-W45", None), 7);
        assert_eq!(window_days("2026-10", Some("monthly")), 31);
    }

    fn at(text: &str) -> i64 {
        millis_of(text).expect("instant")
    }

    #[test]
    fn weekly_slots() {
        let now = at("2026-11-04T10:12:00.000Z");
        assert_eq!(last_slot_on_or_before("weekly", 1, now), d("2026-11-02"));
        assert_eq!(next_slot_after("weekly", 1, now), d("2026-11-09"));
        let now = at("2026-11-09T00:00:00.000Z");
        assert_eq!(last_slot_on_or_before("weekly", 1, now), d("2026-11-09"));
        assert_eq!(next_slot_after("weekly", 1, now), d("2026-11-16"));
    }

    #[test]
    fn biweekly_and_monthly_slots() {
        assert!(!is_slot_day("biweekly", 1, d("2026-11-02")));
        assert!(is_slot_day("biweekly", 1, d("2026-11-09")));
        assert!(!is_slot_day("biweekly", 1, d("2026-11-10")));
        assert!(!is_slot_day("biweekly", 1, d("2026-11-16")));
        assert!(is_slot_day("biweekly", 1, d("2026-11-23")));
        assert_eq!(
            next_slot_after("biweekly", 1, at("2026-11-10T08:00:00.000Z")),
            d("2026-11-23")
        );
        assert!(is_slot_day("monthly", 3, d("2026-12-01")));
        assert!(is_slot_day("monthly", 3, d("2026-08-03")));
        assert!(is_slot_day("monthly", 3, d("2026-02-02")));
        assert!(!is_slot_day("monthly", 3, d("2026-08-01")));
        assert!(!is_slot_day("monthly", 3, d("2026-08-04")));
        let now = at("2026-08-20T00:00:00.000Z");
        assert_eq!(last_slot_on_or_before("monthly", 3, now), d("2026-08-03"));
        assert_eq!(next_slot_after("monthly", 3, now), d("2026-09-01"));
    }

    #[test]
    fn periods_of_slots() {
        assert_eq!(period_for_slot("weekly", d("2026-11-09")), "2026-W45");
        assert_eq!(period_for_slot("weekly", d("2026-11-06")), "2026-W45");
        assert_eq!(period_for_slot("biweekly", d("2026-01-05")), "2026-W01");
        assert_eq!(period_for_slot("monthly", d("2026-08-03")), "2026-07");
        assert_eq!(period_for_slot("monthly", d("2026-01-02")), "2025-12");
        let now = at("2026-11-04T10:12:00.000Z");
        assert_eq!(default_period(Some(("weekly", 1)), now), "2026-W45");
        assert_eq!(default_period(None, now), "2026-W45");
    }

    #[test]
    fn overall_and_health() {
        let areas = |colours: &[&'static str]| -> Vec<AreaResult> {
            colours
                .iter()
                .map(|c| AreaResult::new(c, "x", json!({})))
                .collect()
        };
        assert_eq!(overall_colour(&areas(&["green", "amber", "grey"])), "amber");
        assert_eq!(overall_colour(&areas(&["amber", "red"])), "red");
        assert_eq!(overall_colour(&areas(&["grey", "green"])), "green");
        assert_eq!(overall_colour(&areas(&["grey", "grey"])), "grey");
        assert_eq!(overall_colour(&[]), "grey");
        assert_eq!(health_for_colour("green"), Some("on_track"));
        assert_eq!(health_for_colour("amber"), Some("at_risk"));
        assert_eq!(health_for_colour("red"), Some("off_track"));
        assert_eq!(health_for_colour("grey"), None);
    }

    fn item(
        kind: &'static str,
        id: &str,
        name: &str,
        base: Option<&str>,
        cur: Option<&str>,
        done: bool,
    ) -> ScheduleItem {
        ScheduleItem {
            kind,
            id: Some(id.to_owned()),
            name: name.to_owned(),
            baseline: base.map(d),
            current: cur.map(d),
            done,
        }
    }

    #[test]
    fn schedule_colours() {
        let as_of = at("2026-11-04T10:00:00.000Z");
        let beta = item(
            "milestone",
            "m1",
            "Beta",
            Some("2026-12-01"),
            Some("2026-12-01"),
            false,
        );
        let (area, _) = schedule_area(None, std::slice::from_ref(&beta), as_of);
        assert_eq!((area.colour, area.code), ("grey", "schedule.no_baseline"));
        let (area, rows) = schedule_area(Some(4), std::slice::from_ref(&beta), as_of);
        assert_eq!((area.colour, area.code), ("green", "schedule.on_track"));
        assert_eq!(rows[0]["varianceDays"], 0);

        let items = [
            item(
                "deliverable",
                "d2",
                "D2",
                Some("2026-11-28"),
                Some("2026-12-03"),
                false,
            ),
            item(
                "deliverable",
                "d3",
                "D3",
                Some("2026-12-10"),
                Some("2026-12-18"),
                false,
            ),
            item(
                "go_live",
                "g",
                "Go-live",
                Some("2027-01-15"),
                Some("2027-01-15"),
                false,
            ),
        ];
        let (area, _) = schedule_area(Some(4), &items, as_of);
        assert_eq!((area.colour, area.code), ("amber", "schedule.behind"));
        assert_eq!(
            area.params,
            json!({ "baselineVersion": 4, "worstDays": 8, "worstName": "D3", "behindCount": 2, "goLiveDays": 0 })
        );

        let go_live = |cur: &str| {
            schedule_area(
                Some(4),
                &[item(
                    "go_live",
                    "g",
                    "Go-live",
                    Some("2027-01-15"),
                    Some(cur),
                    false,
                )],
                as_of,
            )
            .0
            .colour
        };
        assert_eq!(go_live("2027-01-22"), "amber");
        assert_eq!(go_live("2027-01-23"), "red");
        let late = item(
            "milestone",
            "m",
            "M",
            Some("2026-12-01"),
            Some("2026-12-16"),
            false,
        );
        assert_eq!(schedule_area(Some(4), &[late], as_of).0.colour, "red");
    }

    #[test]
    fn schedule_forecasts_and_orders() {
        let as_of = at("2026-11-04T10:00:00.000Z");
        let (area, rows) = schedule_area(
            Some(1),
            &[
                item(
                    "milestone",
                    "m1",
                    "Beta",
                    Some("2026-10-30"),
                    Some("2026-10-30"),
                    false,
                ),
                item(
                    "milestone",
                    "m2",
                    "Old",
                    Some("2026-10-01"),
                    Some("2026-10-01"),
                    true,
                ),
            ],
            as_of,
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["forecastDate"], "2026-11-04T00:00:00.000Z");
        assert_eq!(rows[0]["varianceDays"], 5);
        assert_eq!(area.colour, "amber");
        let (_, rows) = schedule_area(
            Some(2),
            &[
                item("milestone", "new", "New", None, Some("2026-12-05"), false),
                item(
                    "milestone",
                    "b",
                    "B",
                    Some("2026-12-10"),
                    Some("2026-12-10"),
                    false,
                ),
                item(
                    "milestone",
                    "a",
                    "A",
                    Some("2026-12-01"),
                    Some("2026-12-01"),
                    false,
                ),
            ],
            as_of,
        );
        let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().expect("id")).collect();
        assert_eq!(ids, ["a", "b", "new"]);
        assert_eq!(rows[2]["baselineDate"], Value::Null);
        assert_eq!(rows[2]["varianceDays"], Value::Null);
    }

    fn finance(earned: &str, forecast: Option<&str>) -> FinanceFigures {
        FinanceFigures {
            week: "2026-W45".to_owned(),
            budget: Some("186400.00".to_owned()),
            planned_value: "110000.00".to_owned(),
            earned_value: earned.to_owned(),
            actual_cost: "104800.00".to_owned(),
            forecast: forecast.map(str::to_owned),
        }
    }

    #[test]
    fn budget_colours() {
        let (area, figures) = budget_area(None, Some("EUR"));
        assert_eq!((area.colour, area.code), ("grey", "budget.no_data"));
        assert_eq!(figures, Value::Null);
        let base = finance("98500.00", Some("196900.00"));
        let figures = budget_figures(&base);
        assert_eq!(figures["cpi"], json!(0.94));
        assert_eq!(figures["spi"], json!(0.9));
        let zero = FinanceFigures {
            actual_cost: "0.00".to_owned(),
            planned_value: "0.00".to_owned(),
            ..base.clone()
        };
        assert_eq!(budget_figures(&zero)["cpi"], Value::Null);
        assert_eq!(budget_figures(&zero)["spi"], Value::Null);
        assert_eq!(budget_area(Some(&base), Some("EUR")).0.colour, "amber");
        assert_eq!(budget_area(Some(&base), Some("EUR")).0.code, "budget.over");
        let even = finance("104800.00", Some("186400.00"));
        assert_eq!(budget_area(Some(&even), None).0.code, "budget.on_budget");
        assert_eq!(
            budget_area(Some(&finance("80000.00", None)), None).0.colour,
            "red"
        );
        let with = |forecast: &str| {
            budget_area(Some(&finance("104800.00", Some(forecast))), None)
                .0
                .colour
        };
        assert_eq!(with("190000.00"), "amber");
        assert_eq!(with("205041.00"), "red");
        assert_eq!(with("186400.00"), "green");
        let idle = FinanceFigures {
            actual_cost: "0.00".to_owned(),
            earned_value: "0.00".to_owned(),
            forecast: None,
            ..base
        };
        assert_eq!(budget_area(Some(&idle), None).0.colour, "green");
    }

    #[test]
    fn scope_and_risk() {
        assert_eq!(scope_area(0).code, "scope.none_pending");
        assert_eq!(
            scope_area(2),
            AreaResult::new("amber", "scope.pending", json!({ "count": 2 }))
        );
        assert_eq!(scope_area(3).colour, "red");
        let risk = |code: &str, score| OpenRisk {
            code: code.to_owned(),
            score,
        };
        assert_eq!(risk_area(&[], 9).code, "risk.no_open_risks");
        assert_eq!(
            risk_area(&[risk("RSK-1", 9), risk("RSK-2", 4)], 9),
            AreaResult::new(
                "green",
                "risk.within_appetite",
                json!({ "highest": 9, "code": "RSK-1", "appetite": 9 })
            )
        );
        assert_eq!(
            risk_area(&[risk("RSK-2", 16), risk("RSK-3", 4)], 12),
            AreaResult::new(
                "amber",
                "risk.above_appetite",
                json!({ "highest": 16, "code": "RSK-2", "appetite": 12, "aboveCount": 1 })
            )
        );
        let red = risk_area(&[risk("RSK-4", 20), risk("RSK-2", 16)], 12);
        assert_eq!(red.colour, "red");
        assert_eq!(red.params["aboveCount"], 2);
        assert_eq!(risk_area(&[risk("RSK-4", 20)], 25).colour, "green");
    }

    fn benefit(latest: Option<f64>, status: &str) -> BenefitInput {
        BenefitInput {
            code: "B-1".to_owned(),
            status: status.to_owned(),
            baseline: Some(100.0),
            target: Some(200.0),
            latest,
            created_at: at("2026-10-01T00:00:00.000Z"),
            realise_by: Some(at("2026-12-01T00:00:00.000Z")),
        }
    }

    #[test]
    fn benefits_colours() {
        let as_of = at("2026-11-04T00:00:00.000Z");
        assert_eq!(benefits_area(&[], as_of).code, "benefits.none");
        assert_eq!(
            benefits_area(&[benefit(None, "measuring")], as_of),
            AreaResult::new("grey", "benefits.no_measurements", json!({ "count": 1 }))
        );
        assert_eq!(
            benefit_progress(Some(100.0), Some(200.0), Some(150.0)),
            Some(0.5)
        );
        assert_eq!(
            benefit_progress(Some(100.0), Some(50.0), Some(75.0)),
            Some(0.5)
        );
        assert_eq!(
            benefit_progress(Some(100.0), Some(200.0), Some(80.0)),
            Some(0.0)
        );
        assert_eq!(
            benefit_progress(Some(100.0), Some(100.0), Some(100.0)),
            None
        );
        assert_eq!(benefit_progress(None, Some(100.0), Some(100.0)), None);
        let created = at("2026-10-01T00:00:00.000Z");
        let by = at("2026-12-01T00:00:00.000Z");
        assert!((benefit_expected(created, Some(by), as_of) - 34.0 / 61.0).abs() < 1e-6);
        assert!(benefit_expected(created, None, as_of).abs() < f64::EPSILON);
        assert!(
            (benefit_expected(created, Some(by), at("2027-01-01T00:00:00.000Z")) - 1.0).abs()
                < f64::EPSILON
        );
        assert_eq!(
            benefits_area(&[benefit(Some(150.0), "measuring")], as_of),
            AreaResult::new("green", "benefits.on_track", json!({ "count": 1 }))
        );
        let amber = benefits_area(&[benefit(Some(140.0), "measuring")], as_of);
        assert_eq!((amber.colour, amber.code), ("amber", "benefits.behind"));
        let red = benefits_area(&[benefit(Some(105.0), "measuring")], as_of);
        assert_eq!(red.colour, "red");
        assert_eq!(
            red.params,
            json!({ "count": 1, "behind": 1, "worstCode": "B-1" })
        );
        assert_eq!(
            benefits_area(&[benefit(Some(150.0), "at_risk")], as_of).colour,
            "amber"
        );
        assert_eq!(
            benefits_area(&[benefit(Some(105.0), "realised")], as_of).colour,
            "green"
        );
    }

    fn computed(colour: &'static str) -> [AreaResult; 5] {
        [
            AreaResult::new(colour, "schedule.on_track", json!({})),
            AreaResult::new(colour, "budget.on_budget", json!({})),
            AreaResult::new(colour, "scope.none_pending", json!({})),
            AreaResult::new(colour, "risk.no_open_risks", json!({})),
            AreaResult::new(colour, "benefits.none", json!({})),
        ]
    }

    #[test]
    fn merging_a_refresh() {
        let existing = [
            json!({ "key": "schedule", "colour": "green", "reason": "Vendor confirmed", "auto": false }),
            json!({ "key": "budget", "colour": "amber", "reason": null, "auto": true }),
        ];
        let merged = merge_areas(Some(&existing), &computed("red"));
        assert_eq!(merged[0], existing[0]);
        assert_eq!(
            merged[1],
            json!({ "key": "budget", "colour": "red", "reason": null, "auto": true })
        );
        assert_eq!(merged.len(), 5);
        assert_eq!(merge_areas(None, &computed("grey")).len(), 5);
        assert_eq!(merge_overall(Some("red"), Some("amber"), "green"), "red");
        assert_eq!(
            merge_overall(Some("amber"), Some("amber"), "green"),
            "green"
        );
        assert_eq!(merge_overall(None, None, "amber"), "amber");
        let merged = merge_items(
            &[
                json!({ "taskId": "t1", "text": "Old", "code": "TASK-1", "date": null }),
                json!({ "taskId": null, "text": "Call the client", "code": null, "date": null }),
            ],
            &[
                json!({ "taskId": "t2", "text": "New", "code": "TASK-2", "date": "2026-11-03T00:00:00.000Z" }),
            ],
        );
        let texts: Vec<&str> = merged
            .iter()
            .map(|i| i["text"].as_str().expect("text"))
            .collect();
        assert_eq!(texts, ["New", "Call the client"]);
    }

    fn person(id: &str, portal: bool) -> RecipientCandidate {
        let member = id.starts_with('m');
        RecipientCandidate {
            stakeholder_id: Some(id.to_owned()),
            user_id: member.then(|| format!("user_{id}")),
            name: Some(id.to_owned()),
            email: Some(format!("{id}@example.com")),
            kind: if member { "member" } else { "contact" },
            portal_access: portal,
        }
    }

    #[test]
    fn recipients() {
        let register = [person("m1", false), person("c1", true), person("c2", false)];
        let sponsor = RecipientCandidate {
            stakeholder_id: None,
            user_id: Some("user_sponsor".to_owned()),
            name: Some("Sponsor".to_owned()),
            email: None,
            kind: "member",
            portal_access: false,
        };
        let ids = |targets: Vec<RecipientCandidate>| -> Vec<Option<String>> {
            targets.into_iter().map(|t| t.stakeholder_id).collect()
        };
        let own = json!({ "stakeholderIds": ["c2", "m1", "gone"] });
        assert_eq!(
            ids(recipient_targets(
                Some(&own),
                None,
                &register,
                Some(&sponsor)
            )),
            [Some("c2".to_owned()), Some("m1".to_owned())]
        );
        let all = ScheduleRecipients {
            stakeholder_ids: None,
            rule: Some("all_stakeholders".to_owned()),
        };
        let empty = json!({ "stakeholderIds": [] });
        assert_eq!(
            recipient_targets(Some(&empty), Some(&all), &register, Some(&sponsor)).len(),
            0
        );
        let listed = ScheduleRecipients {
            stakeholder_ids: Some(vec!["m1".to_owned()]),
            rule: None,
        };
        assert_eq!(
            ids(recipient_targets(
                None,
                Some(&listed),
                &register,
                Some(&sponsor)
            )),
            [Some("m1".to_owned())]
        );
        assert_eq!(
            recipient_targets(None, Some(&all), &register, Some(&sponsor)).len(),
            3
        );
        let portal = ScheduleRecipients {
            stakeholder_ids: None,
            rule: Some("portal_contacts".to_owned()),
        };
        let none = json!({});
        assert_eq!(
            ids(recipient_targets(
                Some(&none),
                Some(&portal),
                &register,
                Some(&sponsor)
            )),
            [Some("c1".to_owned())]
        );
        assert_eq!(
            recipient_targets(None, None, &register, Some(&sponsor)),
            vec![sponsor.clone()]
        );
        assert_eq!(recipient_targets(None, None, &register, None).len(), 0);
    }
}
