//! Economic nexus (`us-compliance/nexus.ts` on the rules of
//! `jurisdictions/us/nexus-thresholds.ts`): a seller's sales into each state
//! measured against that state's threshold, window and base, with the day it
//! was crossed and when collecting has to start.
//!
//! The rules are the domain's `NEXUS_RULES` (versioned by effective date),
//! exported into `data/jurisdictions.json` by `tools/export.mts`.
//!
//! Amounts are dollars, summed in cents. A negative amount (a credit memo)
//! reduces the sales total and is not a transaction.

use std::sync::LazyLock;

use serde_json::{Map, Value, json};

use crate::dates::{
    add_days, add_months, days_in_month, end_of_month, format_iso, parse_iso, start_of_month,
};
use crate::js::{locale_compare, math_round, number_value};
use crate::jurisdictions::{DATA, us};

/// `NEXUS_APPROACHING_PERCENT`.
pub const NEXUS_APPROACHING_PERCENT: f64 = 80.0;

/// `CollectionStartRule`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CollectionStart {
    NextTransaction,
    FirstDayOfNextMonth,
    DaysAfter(i64),
}

/// `NexusRule`.
#[derive(Debug, Clone)]
pub struct NexusRule {
    pub state_code: String,
    pub effective_from: String,
    pub has_sales_tax: bool,
    pub sales_threshold: Option<f64>,
    pub transaction_threshold: Option<f64>,
    /// `none` | `or` | `and`.
    pub test: String,
    /// `gte` | `gt`.
    pub comparison: String,
    /// `gross` | `retail` | `taxable`.
    pub base: String,
    pub window: String,
    pub quarter_first_month: Option<i64>,
    pub tested_quarterly: bool,
    pub marketplace_sales_count: bool,
    pub collection_start: CollectionStart,
    pub unverified: Vec<String>,
    pub source_url: String,
    pub notes: Option<String>,
}

fn rule_of(raw: &Value) -> NexusRule {
    let text = |key: &str| raw[key].as_str().unwrap_or_default().to_owned();
    let start = &raw["collectionStart"];
    NexusRule {
        state_code: text("stateCode"),
        effective_from: text("effectiveFrom"),
        has_sales_tax: raw["hasSalesTax"].as_bool().unwrap_or(false),
        sales_threshold: raw["salesThreshold"].as_f64(),
        transaction_threshold: raw["transactionThreshold"].as_f64(),
        test: text("test"),
        comparison: text("comparison"),
        base: text("base"),
        window: text("window"),
        quarter_first_month: raw["quarterFirstMonth"].as_i64(),
        tested_quarterly: raw["testedQuarterly"].as_bool().unwrap_or(false),
        marketplace_sales_count: raw["marketplaceSalesCount"].as_bool().unwrap_or(false),
        collection_start: match start["kind"].as_str() {
            Some("first_day_of_next_month") => CollectionStart::FirstDayOfNextMonth,
            Some("days_after") => CollectionStart::DaysAfter(start["days"].as_i64().unwrap_or(0)),
            _ => CollectionStart::NextTransaction,
        },
        unverified: raw["unverified"]
            .as_array()
            .map(|u| {
                u.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        source_url: text("sourceUrl"),
        notes: raw["notes"].as_str().map(str::to_owned),
    }
}

/// `BY_STATE`: every version of every state's rule, by state, oldest first.
static BY_STATE: LazyLock<Vec<(String, Vec<NexusRule>)>> = LazyLock::new(|| {
    let mut out: Vec<(String, Vec<NexusRule>)> = Vec::new();
    for raw in DATA["us"]["nexusRules"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
    {
        let rule = rule_of(raw);
        match out.iter_mut().find(|(code, _)| *code == rule.state_code) {
            Some((_, list)) => list.push(rule),
            None => out.push((rule.state_code.clone(), vec![rule])),
        }
    }
    for (_, list) in &mut out {
        list.sort_by(|a, b| a.effective_from.cmp(&b.effective_from));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
});

/// `nexusMonitoredCodes()`: jurisdictions a seller can have to collect in.
pub fn nexus_monitored_codes() -> Vec<String> {
    BY_STATE
        .iter()
        .filter(|(_, rules)| rules.iter().any(|r| r.has_sales_tax))
        .map(|(code, _)| code.clone())
        .collect()
}

/// `getNexusRule(stateCode, asOf)`: the rule in force on a date.
pub fn get_nexus_rule(state_code: &str, as_of: &str) -> Option<&'static NexusRule> {
    let code = state_code.trim().to_uppercase();
    let (_, history) = BY_STATE.iter().find(|(c, _)| *c == code)?;
    history
        .iter()
        .rev()
        .find(|rule| rule.effective_from.as_str() <= as_of)
}

/// `NexusSale`.
#[derive(Debug, Clone)]
pub struct NexusSale {
    pub date: String,
    pub amount: f64,
    pub state_code: String,
    pub marketplace_facilitated: bool,
    pub taxable: bool,
    pub retail: bool,
}

#[derive(Debug, Clone)]
struct Entry {
    date: String,
    cents: i64,
    count: i64,
}

#[derive(Debug, Clone, Copy, Default)]
struct Total {
    cents: i64,
    count: i64,
}

fn day_plus(date: &str, days: i64) -> String {
    add_days(date, days).unwrap_or_default()
}

fn month_plus(date: &str, months: i64) -> String {
    add_months(date, months).unwrap_or_default()
}

/// `SaleSeries`: day-aggregated sales with prefix sums.
struct SaleSeries {
    entries: Vec<Entry>,
    prefix_cents: Vec<i64>,
    prefix_count: Vec<i64>,
}

impl SaleSeries {
    fn new(entries: Vec<Entry>) -> Self {
        let mut prefix_cents = vec![0];
        let mut prefix_count = vec![0];
        for entry in &entries {
            prefix_cents.push(prefix_cents.last().copied().unwrap_or(0) + entry.cents);
            prefix_count.push(prefix_count.last().copied().unwrap_or(0) + entry.count);
        }
        Self {
            entries,
            prefix_cents,
            prefix_count,
        }
    }

    fn first_date(&self) -> Option<&str> {
        self.entries.first().map(|e| e.date.as_str())
    }

    fn before(&self, date: &str) -> usize {
        self.entries.partition_point(|e| e.date.as_str() < date)
    }

    fn up_to(&self, date: &str) -> usize {
        self.before(&day_plus(date, 1))
    }

    fn total(&self, from: &str, to: &str) -> Total {
        if to < from {
            return Total::default();
        }
        let a = self.before(from);
        let b = self.up_to(to);
        Total {
            cents: self.prefix_cents[b] - self.prefix_cents[a],
            count: self.prefix_count[b] - self.prefix_count[a],
        }
    }

    fn first_crossing(&self, from: &str, to: &str, test: impl Fn(Total) -> bool) -> Option<String> {
        let mut running = Total::default();
        for entry in &self.entries[self.before(from)..] {
            if entry.date.as_str() > to {
                break;
            }
            running.cents += entry.cents;
            running.count += entry.count;
            if test(running) {
                return Some(entry.date.clone());
            }
        }
        None
    }

    fn dates_up_to(&self, to: &str) -> Vec<String> {
        self.entries[..self.up_to(to)]
            .iter()
            .map(|e| e.date.clone())
            .collect()
    }
}

fn reaches(value: f64, threshold: f64, comparison: &str) -> bool {
    if comparison == "gt" {
        value > threshold
    } else {
        value >= threshold
    }
}

#[allow(clippy::cast_precision_loss)]
fn dollars(cents: i64) -> f64 {
    cents as f64 / 100.0
}

/// `meets(rule, total)`.
#[allow(clippy::cast_precision_loss)]
fn meets(rule: &NexusRule, total: Total) -> bool {
    let sales_ok = rule
        .sales_threshold
        .is_some_and(|t| reaches(dollars(total.cents), t, &rule.comparison));
    let count_ok = rule
        .transaction_threshold
        .is_some_and(|t| reaches(total.count as f64, t, &rule.comparison));
    match rule.test.as_str() {
        "or" => sales_ok || count_ok,
        "and" => sales_ok && count_ok,
        _ => sales_ok,
    }
}

/// `progress(rule, total)`: percent toward the threshold.
#[allow(clippy::cast_precision_loss)]
fn progress(rule: &NexusRule, total: Total) -> f64 {
    let sales = match rule.sales_threshold {
        Some(t) if t != 0.0 => (dollars(total.cents) / t) * 100.0,
        _ => 0.0,
    };
    let count = match rule.transaction_threshold {
        Some(t) if t != 0.0 => (total.count as f64 / t) * 100.0,
        _ => 0.0,
    };
    let value = match rule.test.as_str() {
        "or" => sales.max(count),
        "and" => sales.min(count),
        _ => sales,
    };
    value.max(0.0)
}

fn floor2(value: f64) -> f64 {
    (value * 100.0 + 1e-9).floor() / 100.0
}

/// `applyCollectionStart(rule, exceededOn)`.
pub fn apply_collection_start(rule: &CollectionStart, exceeded_on: &str) -> String {
    match rule {
        CollectionStart::NextTransaction => day_plus(exceeded_on, 1),
        CollectionStart::FirstDayOfNextMonth => {
            day_plus(&end_of_month(exceeded_on).unwrap_or_default(), 1)
        }
        CollectionStart::DaysAfter(days) => day_plus(exceeded_on, *days),
    }
}

fn last_quarter_end_on_or_before(date: &str, first_month: i64) -> String {
    let Some(p) = parse_iso(date) else {
        return String::new();
    };
    for back in 0..4 {
        let index = p.y * 12 + (p.m - 1) - back;
        let year = index.div_euclid(12);
        let month = index.rem_euclid(12) + 1;
        if ((month - first_month - 2) % 3 + 3) % 3 != 0 {
            continue;
        }
        let end = format_iso(year, month, days_in_month(year, month));
        if end.as_str() <= date {
            return end;
        }
    }
    String::new()
}

fn next_quarter_end(quarter_end: &str) -> String {
    end_of_month(&month_plus(
        &start_of_month(quarter_end).unwrap_or_default(),
        3,
    ))
    .unwrap_or_default()
}

fn trailing_year_start(end: &str) -> String {
    day_plus(&month_plus(end, -12), 1)
}

fn test_dates(start: &str, last: &str, next: impl Fn(&str) -> String) -> Vec<String> {
    let mut dates = Vec::new();
    let mut date = start.to_owned();
    while date.as_str() <= last && !date.is_empty() {
        dates.push(date.clone());
        date = next(&date);
    }
    dates
}

fn quarter_end_on_or_after(date: &str, first_month: i64) -> String {
    let previous = last_quarter_end_on_or_before(date, first_month);
    if previous == date {
        date.to_owned()
    } else {
        next_quarter_end(&previous)
    }
}

fn year_of(date: &str) -> i64 {
    parse_iso(date).map_or(0, |p| p.y)
}

fn next_september_30(date: &str) -> String {
    format_iso(year_of(date) + 1, 9, 30)
}

fn september_on_or_after(date: &str) -> String {
    let candidate = format_iso(year_of(date), 9, 30);
    if candidate.as_str() >= date {
        candidate
    } else {
        next_september_30(&candidate)
    }
}

fn last_september_30_on_or_before(date: &str) -> String {
    let y = year_of(date);
    let candidate = format_iso(y, 9, 30);
    if candidate.as_str() <= date {
        candidate
    } else {
        format_iso(y - 1, 9, 30)
    }
}

/// `NexusPeriod`.
#[derive(Debug, Clone)]
pub struct NexusPeriod {
    /// `binding` | `look_ahead`.
    pub role: &'static str,
    pub label: String,
    pub from: String,
    pub to: String,
    pub sales_total: f64,
    pub transaction_count: i64,
    pub percent_of_threshold: f64,
    pub exceeded: bool,
    pub exceeded_on: Option<String>,
}

impl NexusPeriod {
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("role".into(), json!(self.role));
        out.insert("label".into(), json!(self.label));
        out.insert("from".into(), json!(self.from));
        out.insert("to".into(), json!(self.to));
        out.insert("salesTotal".into(), number_value(self.sales_total));
        out.insert("transactionCount".into(), json!(self.transaction_count));
        out.insert(
            "percentOfThreshold".into(),
            number_value(self.percent_of_threshold),
        );
        out.insert("exceeded".into(), json!(self.exceeded));
        if let Some(on) = &self.exceeded_on {
            out.insert("exceededOn".into(), json!(on));
        }
        Value::Object(out)
    }
}

struct RawPeriod {
    period: NexusPeriod,
    raw: f64,
}

fn make_period(
    rule: &NexusRule,
    series: &SaleSeries,
    period_role: &'static str,
    label: String,
    from: &str,
    to: &str,
    exceeded_on_at_end: bool,
) -> RawPeriod {
    let total = series.total(from, to);
    let exceeded = meets(rule, total);
    let raw = progress(rule, total);
    let exceeded_on = if exceeded {
        if exceeded_on_at_end {
            Some(to.to_owned())
        } else {
            series.first_crossing(from, to, |running| meets(rule, running))
        }
    } else {
        None
    };
    RawPeriod {
        period: NexusPeriod {
            role: period_role,
            label,
            from: from.to_owned(),
            to: to.to_owned(),
            sales_total: dollars(total.cents),
            transaction_count: total.count,
            percent_of_threshold: floor2(raw),
            exceeded,
            exceeded_on,
        },
        raw,
    }
}

fn streak_start(results: &[(String, bool)]) -> Option<String> {
    let mut start: Option<String> = None;
    for (date, passed) in results {
        if *passed {
            if start.is_none() {
                start = Some(date.clone());
            }
        } else {
            start = None;
        }
    }
    start
}

fn rolling_streak_start(rule: &NexusRule, series: &SaleSeries, as_of: &str) -> Option<String> {
    let mut events: Vec<String> = vec![as_of.to_owned()];
    for date in series.dates_up_to(as_of) {
        events.push(date.clone());
        let year_later = month_plus(&date, 12);
        for leaves in [year_later.clone(), day_plus(&year_later, 1)] {
            if leaves.as_str() <= as_of {
                events.push(leaves);
            }
        }
    }
    events.sort();
    events.dedup();
    let results: Vec<(String, bool)> = events
        .into_iter()
        .map(|date| {
            let passed = meets(rule, series.total(&trailing_year_start(&date), &date));
            (date, passed)
        })
        .collect();
    streak_start(&results)
}

/// `pending`: below the threshold today, but the look-ahead crossed it.
#[derive(Debug, Clone)]
pub struct Pending {
    pub exceeded_on: String,
    pub test_date: String,
    pub collect_from: String,
}

#[derive(Default)]
struct Build {
    periods: Vec<RawPeriod>,
    exceeded_on: Option<String>,
    collect_from: Option<String>,
    pending: Option<Pending>,
}

fn build_calendar_years(rule: &NexusRule, series: &SaleSeries, as_of: &str) -> Build {
    let year = year_of(as_of);
    let previous_only = rule.window == "previous_calendar_year";
    let previous = make_period(
        rule,
        series,
        "binding",
        format!("{}", year - 1),
        &format!("{}-01-01", year - 1),
        &format!("{}-12-31", year - 1),
        false,
    );
    let current = make_period(
        rule,
        series,
        if previous_only {
            "look_ahead"
        } else {
            "binding"
        },
        format!("{year} to date"),
        &format!("{year}-01-01"),
        as_of,
        false,
    );
    let mut build = Build::default();
    let crossed: Vec<&RawPeriod> = [&previous, &current]
        .into_iter()
        .filter(|p| p.period.role == "binding" && p.period.exceeded)
        .collect();
    if crossed.is_empty() {
        if previous_only
            && current.period.exceeded
            && let Some(on) = &current.period.exceeded_on
        {
            build.pending = Some(Pending {
                exceeded_on: on.clone(),
                test_date: format!("{year}-12-31"),
                collect_from: format!("{}-01-01", year + 1),
            });
        }
    } else {
        let mut crossings: Vec<String> = crossed
            .iter()
            .filter_map(|p| p.period.exceeded_on.clone())
            .collect();
        crossings.sort();
        build.exceeded_on = crossings.into_iter().next();
        if previous_only {
            build.collect_from = Some(format!("{year}-01-01"));
        } else if let Some(on) = &build.exceeded_on {
            build.collect_from = Some(apply_collection_start(&rule.collection_start, on));
        }
    }
    build.periods = vec![previous, current];
    build
}

fn build_rolling(rule: &NexusRule, series: &SaleSeries, as_of: &str) -> Build {
    let period = make_period(
        rule,
        series,
        "binding",
        "12 months".to_owned(),
        &trailing_year_start(as_of),
        as_of,
        false,
    );
    let mut build = Build::default();
    if period.period.exceeded {
        build.exceeded_on =
            rolling_streak_start(rule, series, as_of).or_else(|| period.period.exceeded_on.clone());
        if let Some(on) = &build.exceeded_on {
            build.collect_from = Some(apply_collection_start(&rule.collection_start, on));
        }
    }
    build.periods = vec![period];
    build
}

struct Scheme<'a> {
    last_test: String,
    next_test: String,
    window_start: &'a dyn Fn(&str) -> String,
    all_tests: Vec<String>,
    label: &'a dyn Fn(&str) -> String,
}

fn build_tested(rule: &NexusRule, series: &SaleSeries, as_of: &str, scheme: &Scheme<'_>) -> Build {
    let binding = make_period(
        rule,
        series,
        "binding",
        (scheme.label)(&scheme.last_test),
        &(scheme.window_start)(&scheme.last_test),
        &scheme.last_test,
        true,
    );
    let look_from = (scheme.window_start)(&scheme.next_test);
    let look_ahead = make_period(
        rule,
        series,
        "look_ahead",
        format!("{} so far", (scheme.label)(&scheme.next_test)),
        &look_from,
        as_of,
        false,
    );
    let mut build = Build::default();
    if binding.period.exceeded {
        let results: Vec<(String, bool)> = scheme
            .all_tests
            .iter()
            .map(|date| {
                (
                    date.clone(),
                    meets(rule, series.total(&(scheme.window_start)(date), date)),
                )
            })
            .collect();
        let on = streak_start(&results).unwrap_or_else(|| scheme.last_test.clone());
        build.collect_from = Some(apply_collection_start(&rule.collection_start, &on));
        build.exceeded_on = Some(on);
    } else if look_ahead.period.exceeded
        && let Some(on) = &look_ahead.period.exceeded_on
    {
        build.pending = Some(Pending {
            exceeded_on: on.clone(),
            test_date: scheme.next_test.clone(),
            collect_from: apply_collection_start(&rule.collection_start, &scheme.next_test),
        });
    }
    build.periods = vec![binding, look_ahead];
    build
}

fn build_quarter_tested(rule: &NexusRule, series: &SaleSeries, as_of: &str) -> Build {
    let first_month = rule.quarter_first_month.unwrap_or(1);
    let last_test = last_quarter_end_on_or_before(as_of, first_month);
    let first = series.first_date().unwrap_or(as_of).to_owned();
    let window_start = |date: &str| trailing_year_start(date);
    let label = |date: &str| format!("12 months to {date}");
    let scheme = Scheme {
        next_test: next_quarter_end(&last_test),
        all_tests: test_dates(
            &quarter_end_on_or_after(&first, first_month),
            &last_test,
            next_quarter_end,
        ),
        last_test,
        window_start: &window_start,
        label: &label,
    };
    build_tested(rule, series, as_of, &scheme)
}

fn build_connecticut(rule: &NexusRule, series: &SaleSeries, as_of: &str) -> Build {
    let last_test = last_september_30_on_or_before(as_of);
    let first = series.first_date().unwrap_or(as_of).to_owned();
    let window_start = |date: &str| day_plus(&format_iso(year_of(date) - 1, 9, 30), 1);
    let label = |date: &str| format!("Oct {} to Sep {}", year_of(date) - 1, year_of(date));
    let scheme = Scheme {
        next_test: next_september_30(&last_test),
        all_tests: test_dates(
            &september_on_or_after(&first),
            &last_test,
            next_september_30,
        ),
        last_test,
        window_start: &window_start,
        label: &label,
    };
    build_tested(rule, series, as_of, &scheme)
}

fn build_series(rule: &NexusRule, sales: &[NexusSale]) -> SaleSeries {
    let mut by_day: Vec<Entry> = Vec::new();
    for sale in sales {
        if sale.state_code.trim().to_uppercase() != rule.state_code {
            continue;
        }
        if sale.marketplace_facilitated && !rule.marketplace_sales_count {
            continue;
        }
        if (rule.base == "retail" && !sale.retail) || (rule.base == "taxable" && !sale.taxable) {
            continue;
        }
        let date = sale.date.get(..10).unwrap_or(&sale.date).to_owned();
        #[allow(clippy::cast_possible_truncation)]
        let cents = math_round(sale.amount * 100.0) as i64;
        let index = by_day
            .iter()
            .position(|e| e.date == date)
            .unwrap_or_else(|| {
                by_day.push(Entry {
                    date,
                    cents: 0,
                    count: 0,
                });
                by_day.len() - 1
            });
        by_day[index].cents += cents;
        if sale.amount > 0.0 {
            by_day[index].count += 1;
        }
    }
    by_day.sort_by(|a, b| a.date.cmp(&b.date));
    SaleSeries::new(by_day)
}

/// `NexusMeasurement`.
#[derive(Debug, Clone)]
pub struct NexusMeasurement {
    pub state_code: String,
    pub applicable: bool,
    pub rule_effective_from: String,
    pub sales_total: f64,
    pub transaction_count: i64,
    pub threshold_sales: Option<f64>,
    pub threshold_transactions: Option<f64>,
    pub percent_of_threshold: f64,
    /// `below` | `approaching` | `exceeded`.
    pub status: &'static str,
    pub exceeded_on: Option<String>,
    pub collect_from: Option<String>,
    pub collect_from_verified: bool,
    pub window: (String, String),
    pub periods: Vec<NexusPeriod>,
    pub pending: Option<Pending>,
    pub unverified: Vec<String>,
}

fn optional_number(value: Option<f64>) -> Value {
    value.map_or(Value::Null, number_value)
}

impl NexusMeasurement {
    pub fn to_json(&self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("stateCode".into(), json!(self.state_code));
        out.insert("applicable".into(), json!(self.applicable));
        out.insert("ruleEffectiveFrom".into(), json!(self.rule_effective_from));
        out.insert("salesTotal".into(), number_value(self.sales_total));
        out.insert("transactionCount".into(), json!(self.transaction_count));
        out.insert(
            "thresholdSales".into(),
            optional_number(self.threshold_sales),
        );
        out.insert(
            "thresholdTransactions".into(),
            optional_number(self.threshold_transactions),
        );
        out.insert(
            "percentOfThreshold".into(),
            number_value(self.percent_of_threshold),
        );
        out.insert("status".into(), json!(self.status));
        if let Some(on) = &self.exceeded_on {
            out.insert("exceededOn".into(), json!(on));
        }
        if let Some(from) = &self.collect_from {
            out.insert("collectFrom".into(), json!(from));
        }
        out.insert(
            "collectFromVerified".into(),
            json!(self.collect_from_verified),
        );
        out.insert(
            "window".into(),
            json!({ "from": self.window.0, "to": self.window.1 }),
        );
        out.insert(
            "periods".into(),
            Value::Array(self.periods.iter().map(NexusPeriod::to_json).collect()),
        );
        if let Some(p) = &self.pending {
            out.insert(
                "pending".into(),
                json!({ "exceededOn": p.exceeded_on, "testDate": p.test_date, "collectFrom": p.collect_from }),
            );
        }
        out.insert("unverified".into(), json!(self.unverified));
        out
    }
}

/// `measureNexus(rule, sales, asOf)`: one state's rule against the sales.
pub fn measure_nexus(rule: &NexusRule, sales: &[NexusSale], as_of: &str) -> NexusMeasurement {
    let day = as_of.get(..10).unwrap_or(as_of).to_owned();
    if !rule.has_sales_tax || rule.sales_threshold.is_none() {
        return NexusMeasurement {
            state_code: rule.state_code.clone(),
            applicable: false,
            rule_effective_from: rule.effective_from.clone(),
            sales_total: 0.0,
            transaction_count: 0,
            threshold_sales: None,
            threshold_transactions: None,
            percent_of_threshold: 0.0,
            status: "below",
            exceeded_on: None,
            collect_from: None,
            collect_from_verified: true,
            window: (day.clone(), day),
            periods: Vec::new(),
            pending: None,
            unverified: rule.unverified.clone(),
        };
    }
    let series = build_series(rule, sales);
    let build = match rule.window.as_str() {
        "previous_or_current_calendar_year" | "previous_calendar_year" => {
            build_calendar_years(rule, &series, &day)
        }
        "rolling_12_months" if !rule.tested_quarterly => build_rolling(rule, &series, &day),
        "ct_october_september" => build_connecticut(rule, &series, &day),
        _ => build_quarter_tested(rule, &series, &day),
    };
    let exceeded = build
        .periods
        .iter()
        .any(|p| p.period.role == "binding" && p.period.exceeded);
    let mut driver = &build.periods[0];
    for candidate in &build.periods[1..] {
        #[allow(clippy::float_cmp)] // `===` on the same computation, as TypeScript
        let tie_to_binding = candidate.raw == driver.raw
            && candidate.period.role == "binding"
            && driver.period.role != "binding";
        if candidate.raw > driver.raw || tie_to_binding {
            driver = candidate;
        }
    }
    let raw = driver.raw;
    let status = if exceeded {
        "exceeded"
    } else if raw >= NEXUS_APPROACHING_PERCENT {
        "approaching"
    } else {
        "below"
    };
    NexusMeasurement {
        state_code: rule.state_code.clone(),
        applicable: true,
        rule_effective_from: rule.effective_from.clone(),
        sales_total: driver.period.sales_total,
        transaction_count: driver.period.transaction_count,
        threshold_sales: rule.sales_threshold,
        threshold_transactions: rule.transaction_threshold,
        percent_of_threshold: floor2(raw),
        status,
        exceeded_on: if exceeded {
            build.exceeded_on.clone()
        } else {
            None
        },
        collect_from: if exceeded {
            build.collect_from.clone()
        } else {
            None
        },
        collect_from_verified: !rule.unverified.iter().any(|u| u == "collection_start"),
        window: (driver.period.from.clone(), driver.period.to.clone()),
        periods: build.periods.iter().map(|p| p.period.clone()).collect(),
        pending: if exceeded { None } else { build.pending },
        unverified: rule.unverified.clone(),
    }
}

/// `NexusMonitorRow`: a measurement with the state's name, registration and
/// alert (`register` | `watch` | `registered` | `ok`).
#[derive(Debug, Clone)]
pub struct NexusMonitorRow {
    pub measurement: NexusMeasurement,
    pub state_name: String,
    pub registered: bool,
    pub alert: &'static str,
}

impl NexusMonitorRow {
    pub fn to_json(&self) -> Map<String, Value> {
        let mut out = self.measurement.to_json();
        out.insert("stateName".into(), json!(self.state_name));
        out.insert("registered".into(), json!(self.registered));
        out.insert("alert".into(), json!(self.alert));
        out
    }
}

/// `nexusMonitor(states, sales, asOf, registeredStates)`: every requested
/// state's position, nearest to its threshold first.
pub fn nexus_monitor(
    states: &[String],
    sales: &[NexusSale],
    as_of: &str,
    registered_states: &[String],
) -> Vec<NexusMonitorRow> {
    let day = as_of.get(..10).unwrap_or(as_of);
    let registered: Vec<String> = registered_states
        .iter()
        .map(|c| c.trim().to_uppercase())
        .collect();
    let mut seen: Vec<String> = Vec::new();
    let mut rows: Vec<NexusMonitorRow> = Vec::new();
    for code in states.iter().map(|c| c.trim().to_uppercase()) {
        if seen.contains(&code) {
            continue;
        }
        seen.push(code.clone());
        let Some(rule) = get_nexus_rule(&code, day).filter(|r| r.has_sales_tax) else {
            continue;
        };
        let state_sales: Vec<NexusSale> = sales
            .iter()
            .filter(|s| s.state_code.trim().to_uppercase() == code)
            .cloned()
            .collect();
        let measurement = measure_nexus(rule, &state_sales, day);
        let is_registered = registered.contains(&code);
        let alert = match measurement.status {
            "exceeded" if is_registered => "registered",
            "exceeded" => "register",
            "approaching" if !is_registered => "watch",
            _ => "ok",
        };
        rows.push(NexusMonitorRow {
            measurement,
            state_name: if code == "PR" {
                "Puerto Rico".to_owned()
            } else {
                us::state(Some(&code))
                    .and_then(|s| s["name"].as_str())
                    .map_or_else(|| code.clone(), str::to_owned)
            },
            registered: is_registered,
            alert,
        });
    }
    rows.sort_by(|a, b| {
        b.measurement
            .percent_of_threshold
            .total_cmp(&a.measurement.percent_of_threshold)
            .then_with(|| locale_compare(&a.measurement.state_code, &b.measurement.state_code))
    });
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sale(date: &str, amount: f64, state: &str) -> NexusSale {
        NexusSale {
            date: date.to_owned(),
            amount,
            state_code: state.to_owned(),
            marketplace_facilitated: false,
            taxable: true,
            retail: true,
        }
    }

    #[test]
    fn rules_and_codes() {
        let codes = nexus_monitored_codes();
        assert!(codes.contains(&"WA".to_owned()));
        assert!(codes.contains(&"PR".to_owned()));
        assert!(!codes.contains(&"DE".to_owned()));
        let il = get_nexus_rule("il", "2026-03-01").expect("IL");
        assert_eq!(il.effective_from, "2026-01-01");
        assert!(il.tested_quarterly);
        assert!(get_nexus_rule("AL", "2018-01-01").is_none());
    }

    #[test]
    fn calendar_year_crossing() {
        let rule = get_nexus_rule("WA", "2026-10-08").expect("WA");
        let sales: Vec<NexusSale> = [
            "2026-02-10",
            "2026-04-15",
            "2026-06-20",
            "2026-08-20",
            "2026-09-25",
        ]
        .iter()
        .map(|d| sale(d, 20_000.0, "WA"))
        .collect();
        let m = measure_nexus(rule, &sales, "2026-10-08");
        assert_eq!(m.status, "exceeded");
        assert_eq!(m.exceeded_on.as_deref(), Some("2026-09-25"));
        assert_eq!(m.collect_from.as_deref(), Some("2026-09-26"));
        let early = measure_nexus(rule, &sales, "2026-06-30");
        assert_eq!(early.status, "below");
        assert!((early.percent_of_threshold - 60.0).abs() < 1e-9);
    }

    #[test]
    fn quarters() {
        assert_eq!(last_quarter_end_on_or_before("2026-10-08", 1), "2026-09-30");
        assert_eq!(last_quarter_end_on_or_before("2026-10-08", 3), "2026-08-31");
        assert_eq!(next_quarter_end("2026-09-30"), "2026-12-31");
        assert_eq!(quarter_end_on_or_after("2026-02-10", 1), "2026-03-31");
        assert_eq!(trailing_year_start("2026-09-30"), "2025-10-01");
    }
}
