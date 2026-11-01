//! FLSA (and California) overtime per workweek (`us/overtime.ts`).

use crate::PayrollError;
use crate::js::math_round;
use crate::money::{Cents, js_max, js_min, round_half_away_from_zero};
use crate::ordered::OrderedMap;
use crate::periods::{add_days, weekday};
use crate::us::ytd::US_OT_CARRY_PREFIX;

#[derive(Debug, Clone, PartialEq)]
pub struct HoursEntry {
    pub date: String,
    pub hours: f64,
    pub rate_cents: f64,
    pub multiplier: Option<f64>,
}

pub struct OvertimeInput<'a> {
    pub entries: &'a [HoursEntry],
    pub period_start: &'a str,
    pub period_end: &'a str,
    pub workweek_start_day: i64,
    pub california: bool,
    pub salaried_regular_rate_cents: Option<f64>,
    pub ytd: &'a OrderedMap<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkweekResult {
    pub week_start: String,
    pub week_end: String,
    pub hours: f64,
    pub regular_rate_cents: f64,
    pub flsa_overtime_hours: f64,
    pub overtime_hours: f64,
    pub double_time_hours: f64,
    pub required_cents: f64,
    pub credited_cents: f64,
    pub qualified_overtime_cents: Cents,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OvertimeKind {
    OvertimePremium,
    DoubleTimePremium,
    Overtime,
    DoubleTime,
}

impl OvertimeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OvertimePremium => "overtime_premium",
            Self::DoubleTimePremium => "double_time_premium",
            Self::Overtime => "overtime",
            Self::DoubleTime => "double_time",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OvertimeLine {
    pub kind: OvertimeKind,
    pub hours: Option<f64>,
    pub rate: Option<f64>,
    pub amount_cents: Cents,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OvertimeResult {
    pub weeks: Vec<WorkweekResult>,
    pub lines: Vec<OvertimeLine>,
    pub qualified_overtime_cents: Cents,
    pub carry_out: OrderedMap<Cents>,
    pub settled_carry_keys: Vec<String>,
}

/// `workweekStart(date, workweekStartDay)`.
pub fn workweek_start(date: &str, workweek_start_day: i64) -> Result<String, PayrollError> {
    let offset = (weekday(date)? - workweek_start_day + 7).rem_euclid(7);
    add_days(date, -offset)
}

struct WeekBucket {
    week_start: String,
    day_hours: [f64; 7],
    straight_pay_cents: f64,
    manual_premium_cents: f64,
    manual_full_cents: f64,
    carry_keys: Vec<String>,
}

fn carry_key(week_start: &str, field: &str) -> String {
    format!("{US_OT_CARRY_PREFIX}{week_start}.{field}")
}

const DAY_FIELDS: [&str; 7] = ["d0", "d1", "d2", "d3", "d4", "d5", "d6"];

/// `californiaSplit(dayHours)`.
pub fn california_split(day_hours: &[f64; 7]) -> (f64, f64, f64) {
    let seventh_day = day_hours.iter().all(|h| *h > 0.0);
    let (mut regular, mut overtime, mut double_time) = (0.0, 0.0, 0.0);
    for (i, h) in day_hours.iter().copied().enumerate() {
        if h <= 0.0 {
            continue;
        }
        if seventh_day && i == 6 {
            overtime += js_min(h, 8.0);
            double_time += js_max(0.0, h - 8.0);
            continue;
        }
        regular += js_min(h, 8.0);
        overtime += js_min(js_max(h - 8.0, 0.0), 4.0);
        double_time += js_max(0.0, h - 12.0);
    }
    if regular > 40.0 {
        overtime += regular - 40.0;
        regular = 40.0;
    }
    (regular, overtime, double_time)
}

fn round2(n: f64) -> f64 {
    math_round(n * 100.0) / 100.0
}

fn is_iso_date(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// The workweek's bucket, made on first use (the TypeScript's `Map`).
fn bucket<'b>(buckets: &'b mut Vec<WeekBucket>, week_start: &str) -> &'b mut WeekBucket {
    let at = match buckets.iter().position(|b| b.week_start == week_start) {
        Some(at) => at,
        None => {
            buckets.push(WeekBucket {
                week_start: week_start.to_owned(),
                day_hours: [0.0; 7],
                straight_pay_cents: 0.0,
                manual_premium_cents: 0.0,
                manual_full_cents: 0.0,
                carry_keys: vec![],
            });
            buckets.len() - 1
        }
    };
    &mut buckets[at]
}

/// `computeOvertime(input)`.
pub fn compute_overtime(input: &OvertimeInput<'_>) -> Result<OvertimeResult, PayrollError> {
    let mut buckets: Vec<WeekBucket> = vec![];
    for (key, value) in input.ytd.iter() {
        let Some(rest) = key.strip_prefix(US_OT_CARRY_PREFIX) else {
            continue;
        };
        let Some(dot) = rest.rfind('.') else {
            continue;
        };
        let (week_start, field) = (&rest[..dot], &rest[dot + 1..]);
        if !is_iso_date(week_start) {
            continue;
        }
        let b = bucket(&mut buckets, week_start);
        b.carry_keys.push(key.clone());
        if let Some(day) = DAY_FIELDS.iter().position(|f| *f == field) {
            b.day_hours[day] += value / 100.0;
        } else if field == "pay" {
            b.straight_pay_cents += value;
        } else if field == "premium" {
            b.manual_premium_cents += value;
            b.manual_full_cents += value;
        }
    }
    for e in input.entries {
        // `!(e.hours > 0)`: NaN hours are skipped too.
        if e.hours.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            continue;
        }
        let week_start = workweek_start(&e.date, input.workweek_start_day)?;
        let day = (weekday(&e.date)? - input.workweek_start_day + 7).rem_euclid(7);
        let b = bucket(&mut buckets, &week_start);
        b.day_hours[day as usize] += e.hours;
        b.straight_pay_cents += e.hours * e.rate_cents;
        if let Some(m) = e.multiplier {
            b.manual_premium_cents += e.hours * e.rate_cents * js_max(0.0, m - 1.0);
            b.manual_full_cents += e.hours * e.rate_cents * m;
        }
    }
    let salaried = input.salaried_regular_rate_cents.is_some();
    let mut weeks = vec![];
    let mut lines = vec![];
    let mut carry_out: OrderedMap<f64> = OrderedMap::new();
    let mut settled: Vec<String> = vec![];
    let mut qualified = 0.0;
    buckets.sort_by(|a, b| a.week_start.cmp(&b.week_start));
    for b in &buckets {
        let week_end = add_days(&b.week_start, 6)?;
        if week_end.as_str() > input.period_end {
            for (i, h) in b.day_hours.iter().enumerate() {
                if *h > 0.0 {
                    carry_out.insert(
                        carry_key(&b.week_start, DAY_FIELDS[i]),
                        math_round(h * 100.0),
                    );
                }
            }
            if !salaried && b.straight_pay_cents > 0.0 {
                carry_out.insert(
                    carry_key(&b.week_start, "pay"),
                    round_half_away_from_zero(b.straight_pay_cents),
                );
            }
            let credit = if salaried {
                b.manual_full_cents
            } else {
                b.manual_premium_cents
            };
            if credit > 0.0 {
                carry_out.insert(
                    carry_key(&b.week_start, "premium"),
                    round_half_away_from_zero(credit),
                );
            }
            settled.extend(
                b.carry_keys
                    .iter()
                    .filter(|k| !carry_out.contains_key(k))
                    .cloned(),
            );
            continue;
        }
        settled.extend(b.carry_keys.iter().cloned());
        let hours = round2(b.day_hours.iter().fold(0.0, |s, h| s + h));
        if hours <= 0.0 {
            continue;
        }
        let regular_rate = match input.salaried_regular_rate_cents {
            Some(rate) => rate,
            None => b.straight_pay_cents / hours,
        };
        let flsa_overtime_hours = round2(js_max(0.0, hours - 40.0));
        let mut overtime_hours = flsa_overtime_hours;
        let mut double_time_hours = 0.0;
        if input.california {
            let (_, overtime, double_time) = california_split(&b.day_hours);
            overtime_hours = round2(overtime);
            double_time_hours = round2(double_time);
        }
        let ot_factor = if salaried { 1.5 } else { 0.5 };
        let dt_factor = if salaried { 2.0 } else { 1.0 };
        let ot_cents = overtime_hours * ot_factor * regular_rate;
        let dt_cents = double_time_hours * dt_factor * regular_rate;
        let required = ot_cents + dt_cents;
        let credited = if salaried {
            b.manual_full_cents
        } else {
            b.manual_premium_cents
        };
        let qualified_cents = round_half_away_from_zero(flsa_overtime_hours * 0.5 * regular_rate);
        qualified += qualified_cents;
        weeks.push(WorkweekResult {
            week_start: b.week_start.clone(),
            week_end,
            hours,
            regular_rate_cents: regular_rate,
            flsa_overtime_hours,
            overtime_hours,
            double_time_hours,
            required_cents: required,
            credited_cents: credited,
            qualified_overtime_cents: qualified_cents,
        });
        let ot_kind = if salaried {
            OvertimeKind::Overtime
        } else {
            OvertimeKind::OvertimePremium
        };
        if credited <= 0.0 {
            if overtime_hours > 0.0 {
                lines.push(OvertimeLine {
                    kind: ot_kind,
                    hours: Some(overtime_hours),
                    rate: Some((ot_factor * regular_rate) / 100.0),
                    amount_cents: round_half_away_from_zero(ot_cents),
                });
            }
            if double_time_hours > 0.0 {
                lines.push(OvertimeLine {
                    kind: if salaried {
                        OvertimeKind::DoubleTime
                    } else {
                        OvertimeKind::DoubleTimePremium
                    },
                    hours: Some(double_time_hours),
                    rate: Some((dt_factor * regular_rate) / 100.0),
                    amount_cents: round_half_away_from_zero(dt_cents),
                });
            }
        } else {
            let due = round_half_away_from_zero(js_max(0.0, required - credited));
            if due > 0.0 {
                lines.push(OvertimeLine {
                    kind: ot_kind,
                    hours: None,
                    rate: None,
                    amount_cents: due,
                });
            }
        }
    }
    Ok(OvertimeResult {
        weeks,
        lines,
        qualified_overtime_cents: qualified,
        carry_out,
        settled_carry_keys: settled,
    })
}
