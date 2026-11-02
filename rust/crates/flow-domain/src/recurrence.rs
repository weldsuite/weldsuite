//! Recurring tasks (`@weldsuite/flow-domain/recurrence`): the next due date
//! of a repeating task, and the next occurrence created when one is
//! completed (see [`crate::tasks::create_next_occurrence`]).

use serde_json::Value;

use crate::js::{civil_from_days, days_from_civil};

const DAY_MS: i64 = 86_400_000;

/// Upper bound on roll-forward steps, so a bad interval can never spin.
const MAX_ROLL_FORWARD: i64 = 1000;

/// A task's `repeat` (`RepeatConfig`).
#[derive(Debug, Clone, PartialEq)]
pub struct RepeatConfig {
    pub frequency: String,
    pub interval: Option<f64>,
    pub unit: Option<String>,
}

impl RepeatConfig {
    /// The config of a `repeat` value (a `jsonb` column or a body);
    /// `None` for null or a value without a `frequency` string.
    pub fn of(value: &Value) -> Option<Self> {
        let frequency = value.get("frequency")?.as_str()?.to_owned();
        Some(Self {
            frequency,
            interval: value.get("interval").and_then(Value::as_f64),
            unit: value.get("unit").and_then(Value::as_str).map(str::to_owned),
        })
    }

    /// `{ months, days }` one step adds (`stepOf`), `None` for an unknown
    /// frequency or unit.
    pub fn step(&self) -> Option<(i64, i64)> {
        match self.frequency.as_str() {
            "daily" => Some((0, 1)),
            "weekly" => Some((0, 7)),
            "biweekly" => Some((0, 14)),
            "monthly" => Some((1, 0)),
            "yearly" => Some((12, 0)),
            "custom" => {
                // `Math.max(1, Math.floor(repeat.interval || 1))`.
                let raw = self
                    .interval
                    .filter(|n| *n != 0.0 && !n.is_nan())
                    .unwrap_or(1.0);
                #[allow(clippy::cast_possible_truncation)]
                let interval = raw.floor().max(1.0) as i64;
                match self
                    .unit
                    .as_deref()
                    .filter(|u| !u.is_empty())
                    .unwrap_or("days")
                {
                    "days" => Some((0, interval)),
                    "weeks" => Some((0, interval * 7)),
                    "months" => Some((interval, 0)),
                    "years" => Some((interval * 12, 0)),
                    _ => None,
                }
            }
            _ => None,
        }
    }
}

/// `addSteps(anchor, step, steps)`: the anchor plus `steps` repetitions,
/// a month-end day clamped (Jan 31 + 1 month = Feb 28/29), time kept.
fn add_steps(anchor: i64, (months, days): (i64, i64), steps: i64) -> i64 {
    if months > 0 {
        let day_number = anchor.div_euclid(DAY_MS);
        let time_of_day = anchor.rem_euclid(DAY_MS);
        let (year, month, day) = civil_from_days(day_number);
        let total = year * 12 + (month - 1) + months * steps;
        let new_year = total.div_euclid(12);
        let new_month = total.rem_euclid(12) + 1;
        let last_day =
            days_from_civil(new_year + i64::from(new_month == 12), new_month % 12 + 1, 1)
                - days_from_civil(new_year, new_month, 1);
        let new_day = day.min(last_day);
        return days_from_civil(new_year, new_month, new_day) * DAY_MS + time_of_day;
    }
    anchor + days * steps * DAY_MS
}

/// `nextOccurrenceDate(currentDueDate, repeat, now)`: counted from the
/// previous due date (or now) and rolled forward until it is after now,
/// each candidate from the original anchor. Epoch milliseconds.
pub fn next_occurrence_date(due_ms: Option<i64>, repeat: &RepeatConfig, now_ms: i64) -> i64 {
    let anchor = due_ms.unwrap_or(now_ms);
    let Some(step) = repeat.step() else {
        return anchor;
    };
    let mut candidate = add_steps(anchor, step, 1);
    let mut steps = 2;
    while candidate <= now_ms && steps <= MAX_ROLL_FORWARD {
        candidate = add_steps(anchor, step, steps);
        steps += 1;
    }
    candidate
}

/// `isCompletion(oldStatus, newStatus)`: the change lands on `done` from
/// anything else.
pub fn is_completion(old_status: Option<&str>, new_status: Option<&str>) -> bool {
    new_status == Some("done") && old_status != Some("done")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ms(iso: &str) -> i64 {
        crate::js::js_date_millis(iso).expect("date")
    }

    #[allow(clippy::needless_pass_by_value)]
    fn repeat(value: Value) -> RepeatConfig {
        RepeatConfig::of(&value).expect("repeat")
    }

    #[test]
    fn month_ends_clamp_without_drifting() {
        let monthly = repeat(json!({ "frequency": "monthly" }));
        let jan31 = ms("2026-01-31T09:00:00Z");
        let now = ms("2026-01-01T00:00:00Z");
        assert_eq!(
            next_occurrence_date(Some(jan31), &monthly, now),
            ms("2026-02-28T09:00:00Z")
        );
        // Rolled forward past now from the original anchor: March 31, not 28.
        let later = ms("2026-03-01T00:00:00Z");
        assert_eq!(
            next_occurrence_date(Some(jan31), &monthly, later),
            ms("2026-03-31T09:00:00Z")
        );
    }

    #[test]
    fn custom_steps_follow_the_unit() {
        let every_two_weeks =
            repeat(json!({ "frequency": "custom", "interval": 2, "unit": "weeks" }));
        let start = ms("2026-03-02T00:00:00Z");
        assert_eq!(
            next_occurrence_date(Some(start), &every_two_weeks, start),
            ms("2026-03-16T00:00:00Z")
        );
        let bad = repeat(json!({ "frequency": "custom", "unit": "fortnights" }));
        assert_eq!(bad.step(), None);
        assert_eq!(next_occurrence_date(Some(start), &bad, start), start);
        let yearly = repeat(json!({ "frequency": "yearly" }));
        assert_eq!(
            next_occurrence_date(Some(ms("2024-02-29T00:00:00Z")), &yearly, 0),
            ms("2025-02-28T00:00:00Z")
        );
    }

    #[test]
    fn completion_is_a_move_onto_done() {
        assert!(is_completion(Some("todo"), Some("done")));
        assert!(is_completion(None, Some("done")));
        assert!(!is_completion(Some("done"), Some("done")));
        assert!(!is_completion(Some("todo"), Some("review")));
    }
}
