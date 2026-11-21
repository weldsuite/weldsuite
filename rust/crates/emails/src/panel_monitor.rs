//! WeldPanel's alert, scheduled report and failing export emails
//! (`packages/core/emails/src/templates/panel/alert.tsx`,
//! `report-digest.tsx`, `export-failing.tsx`), and the copy every channel
//! writes them in (`monitor-text.ts`): panel-api's Slack, WeldChat and in-app
//! messages say the same thing in the same words, so `weldsuite-panel` calls
//! [`alert_text`] and [`digest_text`] here.
//!
//! Numbers are `Intl.NumberFormat`'s for `en-US` and `nl-NL` (at most two
//! decimals; a percentage with at most one), rounded half away from zero on
//! the shortest decimal that reads back as the number, as ICU rounds it.
//!
//! The alert is exported once per event (`panel.alert.fired`, …) and the
//! digest once per target (`panel.report-digest.report`, `.dashboard`); a
//! digest's blocks are a loop (`rows`), each block's headline figures and
//! top rows loops inside it (`row.headline`, `row.rows`).

use std::collections::BTreeMap;
use std::sync::LazyLock;

use minijinja::Value as Jinja;
use serde::Deserialize;
use serde_json::Value;

use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, render};

// ── strings ─────────────────────────────────────────────────────────────────

static STRINGS: LazyLock<(Value, Value)> = LazyLock::new(|| {
    let read = |json: &str| -> Value {
        let all: Value = serde_json::from_str(json).expect("the email strings parse");
        all["panel"].clone()
    };
    (
        read(include_str!("../../../catalogs/emails/strings.en.json")),
        read(include_str!("../../../catalogs/emails/strings.nl.json")),
    )
});

/// `emailStrings(locale).panel.<path>` (dot separated).
fn t(locale: EmailLocale, path: &str) -> &'static str {
    let root = match locale {
        EmailLocale::En => &STRINGS.0,
        EmailLocale::Nl => &STRINGS.1,
    };
    path.split('.')
        .fold(root, |value, key| &value[key])
        .as_str()
        .unwrap_or_default()
}

/// `fill(template, values)`: `{name}` placeholders whose name is given.
fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let close = after.find('}');
        let name = close.map(|close| &after[..close]);
        match name {
            Some(name)
                if !name.is_empty()
                    && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') =>
            {
                if let Some((_, value)) = values.iter().find(|(key, _)| *key == name) {
                    out.push_str(value);
                } else {
                    out.push('{');
                    out.push_str(name);
                    out.push('}');
                }
                rest = &after[name.len() + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

// ── numbers ─────────────────────────────────────────────────────────────────

/// `PanelDigestFormat`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NumberFormat {
    #[default]
    Number,
    Percent,
}

/// `Math.round(value)`: halves go up.
fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `String(n)` of a whole JavaScript number.
fn js_integer(value: f64) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }
    if value.abs() < 1e21 {
        return format!("{value:.0}");
    }
    let text = format!("{value:e}");
    match text.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => {
            format!("{mantissa}e+{exponent}")
        }
        _ => text,
    }
}

/// The shortest decimal digits of `value` (no sign) and the power of ten of
/// the first one: `1234.5` is `("12345", 3)`.
fn decimal_digits(value: f64) -> (Vec<u8>, i32) {
    let text = format!("{:e}", value.abs());
    let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
    let digits: Vec<u8> = mantissa
        .bytes()
        .filter(u8::is_ascii_digit)
        .map(|b| b - b'0')
        .collect();
    (digits, exponent.parse().unwrap_or(0))
}

/// `Intl.NumberFormat(locale, { maximumFractionDigits: max })` of `value`
/// times 10^`shift` (2 for a percentage).
fn intl_number(value: f64, shift: i32, max_fraction: i32, locale: EmailLocale) -> String {
    let negative = value.is_sign_negative();
    let (mut digits, mut exponent) = if value == 0.0 {
        (vec![0], 0)
    } else {
        decimal_digits(value)
    };
    exponent += shift;
    // The digit at index i stands for 10^(exponent - i); keep the ones down
    // to 10^-max_fraction and round half away from zero on the next.
    let keep = exponent + 1 + max_fraction;
    if keep < 0 {
        digits = vec![0];
        exponent = 0;
    } else {
        let keep = usize::try_from(keep).unwrap_or(0);
        if digits.len() > keep {
            let round_up = digits[keep] >= 5;
            digits.truncate(keep);
            if round_up {
                let mut i = digits.len();
                loop {
                    if i == 0 {
                        digits.insert(0, 1);
                        exponent += 1;
                        break;
                    }
                    i -= 1;
                    if digits[i] == 9 {
                        digits[i] = 0;
                    } else {
                        digits[i] += 1;
                        break;
                    }
                }
            }
            if digits.is_empty() {
                digits = vec![0];
                exponent = 0;
            }
        }
    }
    // Integer and fraction digits.
    let mut integer = String::new();
    let mut fraction = String::new();
    if exponent < 0 {
        integer.push('0');
        for _ in 0..(-exponent - 1) {
            fraction.push('0');
        }
        for d in &digits {
            fraction.push(char::from(b'0' + d));
        }
    } else {
        let whole = usize::try_from(exponent + 1).unwrap_or(0);
        for i in 0..whole {
            integer.push(char::from(b'0' + digits.get(i).copied().unwrap_or(0)));
        }
        for d in digits.iter().skip(whole) {
            fraction.push(char::from(b'0' + d));
        }
    }
    let fraction = fraction.trim_end_matches('0');
    let integer = integer.trim_start_matches('0');
    let integer = if integer.is_empty() { "0" } else { integer };
    let (group, decimal) = match locale {
        EmailLocale::En => (',', '.'),
        EmailLocale::Nl => ('.', ','),
    };
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    let len = integer.len();
    for (i, c) in integer.chars().enumerate() {
        if i > 0 && (len - i) % 3 == 0 {
            out.push(group);
        }
        out.push(c);
    }
    if !fraction.is_empty() {
        out.push(decimal);
        out.push_str(fraction);
    }
    out
}

/// `formatPanelValue(value, format, locale)`: `1,234` / `1.234`, `12.5%` /
/// `12,5%`; `–` without a finite number.
pub fn format_value(value: Option<f64>, format: NumberFormat, locale: EmailLocale) -> String {
    let Some(value) = value.filter(|v| v.is_finite()) else {
        return "–".to_owned();
    };
    match format {
        NumberFormat::Percent => format!("{}%", intl_number(value, 2, 1, locale)),
        NumberFormat::Number => intl_number(value, 0, 2, locale),
    }
}

// ── alerts ──────────────────────────────────────────────────────────────────

/// `PanelAlertEvent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlertEvent {
    Fired,
    Resolved,
    Test,
}

impl AlertEvent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fired => "fired",
            Self::Resolved => "resolved",
            Self::Test => "test",
        }
    }
}

/// `PanelAlertInterval`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlertInterval {
    Hourly,
    Daily,
    Weekly,
}

impl AlertInterval {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hourly => "hourly",
            Self::Daily => "daily",
            Self::Weekly => "weekly",
        }
    }
}

/// `PanelAlertConditionText`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AlertCondition {
    Threshold { operator: String, value: f64 },
    Change { direction: String, percent: f64 },
    Anomaly { sensitivity: String },
}

/// `PanelAlertEmailProps`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertProps {
    pub alert_name: String,
    pub project_name: String,
    pub event: AlertEvent,
    /// The series watched, as its report names it.
    pub metric: String,
    pub value: Option<f64>,
    pub bound: Option<f64>,
    pub condition: AlertCondition,
    pub interval: AlertInterval,
    /// `2026-11-16` (a day, or a week's Monday) or `2026-11-16T10:00` (an hour).
    pub period: Option<String>,
    pub url: String,
}

/// A title and one or two sentences (`PanelMessageText`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageText {
    pub title: String,
    pub body: String,
}

/// `November 16, 2026` / `16 november 2026` of `YYYY-MM-DD`.
fn long_day(day: &str, locale: EmailLocale) -> Option<String> {
    const EN: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    const NL: [&str; 12] = [
        "januari",
        "februari",
        "maart",
        "april",
        "mei",
        "juni",
        "juli",
        "augustus",
        "september",
        "oktober",
        "november",
        "december",
    ];
    let date: jiff::civil::Date = day.parse().ok()?;
    let month = usize::try_from(date.month() - 1).ok()?;
    Some(match locale {
        EmailLocale::En => format!("{} {}, {}", EN[month], date.day(), date.year()),
        EmailLocale::Nl => format!("{} {} {}", date.day(), NL[month], date.year()),
    })
}

fn is_day(text: &str) -> bool {
    text.len() == 10
        && text.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

/// `formatAlertPeriod(period, interval, locale)`: the period as a reader
/// says it; empty without one.
pub fn format_alert_period(
    period: Option<&str>,
    interval: AlertInterval,
    locale: EmailLocale,
) -> String {
    let Some(period) = period.filter(|p| !p.is_empty()) else {
        return String::new();
    };
    // `/^(\d{4}-\d{2}-\d{2})T(\d{2}):00$/`
    let hour = (period.len() == 16
        && is_day(&period[..10])
        && &period[10..11] == "T"
        && period[11..13].bytes().all(|b| b.is_ascii_digit())
        && &period[13..] == ":00")
        .then(|| (&period[..10], &period[11..13]));
    let day = if is_day(period) {
        Some(period)
    } else {
        hour.map(|(day, _)| day)
    };
    let Some(date) = day.and_then(|day| long_day(day, locale)) else {
        return period.to_owned();
    };
    if let Some((_, hh)) = hour {
        return format!("{date} {hh}:00");
    }
    if interval == AlertInterval::Weekly {
        fill(t(locale, "alert.weekOf"), &[("date", &date)])
    } else {
        date
    }
}

/// `alertConditionText(condition, locale)`.
pub fn alert_condition_text(condition: &AlertCondition, locale: EmailLocale) -> String {
    let number = |v: f64| format_value(Some(v), NumberFormat::Number, locale);
    match condition {
        AlertCondition::Threshold { operator, value } => {
            let key = if operator == "above" {
                "alert.conditionAbove"
            } else {
                "alert.conditionBelow"
            };
            fill(t(locale, key), &[("value", &number(*value))])
        }
        AlertCondition::Change { direction, percent } => {
            let key = match direction.as_str() {
                "increase" => "alert.conditionIncrease",
                "decrease" => "alert.conditionDecrease",
                _ => "alert.conditionAny",
            };
            fill(t(locale, key), &[("percent", &number(*percent))])
        }
        AlertCondition::Anomaly { sensitivity } => format!(
            "{} ({})",
            t(locale, "alert.conditionAnomaly"),
            t(locale, &format!("alert.sensitivity.{sensitivity}"))
        ),
    }
}

/// `panelAlertText(props, locale)`: an alert message as text, for every channel.
pub fn alert_text(props: &AlertProps, locale: EmailLocale) -> MessageText {
    let value = match props.value {
        None => t(locale, "alert.noData").to_owned(),
        Some(value) => format_value(Some(value), NumberFormat::Number, locale),
    };
    let period = format_alert_period(props.period.as_deref(), props.interval, locale);
    let condition = alert_condition_text(&props.condition, locale);
    let values = [
        ("alert", props.alert_name.as_str()),
        ("metric", props.metric.as_str()),
        ("value", value.as_str()),
        ("period", period.as_str()),
        ("condition", condition.as_str()),
    ];
    let (title, body) = match props.event {
        AlertEvent::Test => (
            fill(t(locale, "alert.headingTest"), &values),
            t(locale, "alert.bodyTest").to_owned(),
        ),
        AlertEvent::Resolved => (
            fill(t(locale, "alert.headingResolved"), &values),
            fill(t(locale, "alert.bodyResolved"), &values),
        ),
        AlertEvent::Fired => (
            fill(t(locale, "alert.headingFired"), &values),
            fill(t(locale, "alert.bodyFired"), &values),
        ),
    };
    MessageText { title, body }
}

fn vars(pairs: &[(&str, String)]) -> BTreeMap<String, Jinja> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), Jinja::from(value.as_str())))
        .collect()
}

/// `panel.alert`: an alert fired, resolved or was tested.
pub fn alert(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &AlertProps,
) -> Result<RenderedEmail, EmailError> {
    let period = format_alert_period(props.period.as_deref(), props.interval, locale);
    let mut flags = Vec::new();
    if props.value.is_some() {
        flags.push("value");
    }
    if props.bound.is_some() {
        flags.push("limit");
    }
    if !period.is_empty() {
        flags.push("period");
    }
    let values = vars(&[
        ("alert_name", props.alert_name.clone()),
        ("project_name", props.project_name.clone()),
        ("metric", props.metric.clone()),
        (
            "value",
            format_value(props.value, NumberFormat::Number, locale),
        ),
        (
            "limit",
            format_value(props.bound, NumberFormat::Number, locale),
        ),
        ("period", period),
        ("condition", alert_condition_text(&props.condition, locale)),
        (
            "checked",
            t(
                locale,
                &format!("alert.intervals.{}", props.interval.as_str()),
            )
            .to_owned(),
        ),
        ("url", props.url.clone()),
    ]);
    render(
        &format!("panel.alert.{}", props.event.as_str()),
        locale,
        brand,
        &flags,
        values,
    )
}

// ── scheduled reports ───────────────────────────────────────────────────────

/// `PanelDigestFigure`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestFigure {
    pub label: String,
    pub value: Option<f64>,
    /// The same figure for the period before; `None` when not compared.
    pub previous: Option<f64>,
    pub format: NumberFormat,
}

/// `PanelDigestRow`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestRow {
    pub label: String,
    pub value: f64,
    pub format: NumberFormat,
}

/// `PanelDigestBlock`.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DigestBlock {
    pub title: String,
    pub headline: Vec<DigestFigure>,
    /// Top rows (pages, steps, breakdown values), at most 10.
    pub rows: Vec<DigestRow>,
    /// The report could not be run.
    pub failed: bool,
    /// A kind of report the message cannot summarise.
    pub open_only: bool,
    /// Absolute link to the report.
    pub url: Option<String>,
}

/// `PanelReportDigestEmailProps`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestProps {
    pub subscription_name: String,
    pub project_name: String,
    /// `report` or `dashboard`.
    pub target_type: String,
    pub target_name: String,
    pub blocks: Vec<DigestBlock>,
    /// Report tiles of the dashboard that did not fit.
    #[serde(default)]
    pub more_count: Option<u64>,
    pub url: String,
}

/// `formatPanelChange(figure, locale)`: `+12%`, `-3%`, "no change" or "new";
/// `None` when there is nothing to compare.
pub fn format_change(figure: &DigestFigure, locale: EmailLocale) -> Option<String> {
    let (value, previous) = (figure.value?, figure.previous?);
    if figure.format == NumberFormat::Percent {
        let points = js_round((value - previous) * 1000.0) / 10.0;
        if points == 0.0 {
            return Some(t(locale, "reportDigest.noChange").to_owned());
        }
        let sign = if points > 0.0 { '+' } else { '-' };
        let text = format_value(Some(points.abs() / 100.0), NumberFormat::Percent, locale);
        return Some(format!("{sign}{text}"));
    }
    if previous == 0.0 {
        let key = if value == 0.0 {
            "reportDigest.noChange"
        } else {
            "reportDigest.newValue"
        };
        return Some(t(locale, key).to_owned());
    }
    let percent = js_round((value - previous) / previous.abs() * 100.0);
    if percent == 0.0 {
        return Some(t(locale, "reportDigest.noChange").to_owned());
    }
    let sign = if percent > 0.0 { '+' } else { '-' };
    Some(format!("{sign}{}%", js_integer(percent.abs())))
}

/// `digestFigureText(figure, locale)`: `Visitors: 1,234 (+12%)`.
pub fn digest_figure_text(figure: &DigestFigure, locale: EmailLocale) -> String {
    let value = format_value(figure.value, figure.format, locale);
    match format_change(figure, locale) {
        Some(change) => format!("{}: {value} ({change})", figure.label),
        None => format!("{}: {value}", figure.label),
    }
}

/// A scheduled report as text: a title, a sentence and the lines below.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestText {
    pub title: String,
    pub body: String,
    pub lines: Vec<String>,
}

/// `panelDigestText(props, locale)`.
pub fn digest_text(props: &DigestProps, locale: EmailLocale) -> DigestText {
    let mut lines = Vec::new();
    for block in &props.blocks {
        lines.push(block.title.clone());
        if block.failed {
            lines.push(format!("  {}", t(locale, "reportDigest.failed")));
        } else if block.open_only {
            lines.push(format!("  {}", t(locale, "reportDigest.openToSee")));
        } else if block.headline.is_empty() && block.rows.is_empty() {
            lines.push(format!("  {}", t(locale, "reportDigest.noData")));
        }
        for figure in &block.headline {
            lines.push(format!("  {}", digest_figure_text(figure, locale)));
        }
        for row in &block.rows {
            lines.push(format!(
                "  {}: {}",
                row.label,
                format_value(Some(row.value), row.format, locale)
            ));
        }
    }
    if let Some(count) = props.more_count.filter(|c| *c > 0) {
        lines.push(fill(
            t(locale, "reportDigest.more"),
            &[("count", &count.to_string())],
        ));
    }
    DigestText {
        title: fill(
            t(locale, "reportDigest.subject"),
            &[
                ("name", &props.subscription_name),
                ("target", &props.target_name),
            ],
        ),
        body: fill(
            t(locale, "reportDigest.preview"),
            &[("target", &props.target_name)],
        ),
        lines,
    }
}

/// One block as a row of the exported loop: its variant and its lists.
fn block_row(block: &DigestBlock, locale: EmailLocale) -> Jinja {
    let url = block.url.as_deref().filter(|u| !u.is_empty());
    let variant: Vec<&str> = [
        ("link", url.is_some()),
        ("failed", block.failed),
        ("open", block.open_only),
        ("headline", !block.headline.is_empty()),
        ("rows", !block.rows.is_empty()),
    ]
    .into_iter()
    .filter_map(|(flag, on)| on.then_some(flag))
    .collect();
    let headline: Vec<Jinja> = block
        .headline
        .iter()
        .map(|figure| {
            let value = format_value(figure.value, figure.format, locale);
            let value = match format_change(figure, locale) {
                Some(change) => format!("{value} · {change}"),
                None => value,
            };
            Jinja::from(vars(&[("label", figure.label.clone()), ("value", value)]))
        })
        .collect();
    let rows: Vec<Jinja> = block
        .rows
        .iter()
        .map(|row| {
            Jinja::from(vars(&[
                ("label", row.label.clone()),
                ("value", format_value(Some(row.value), row.format, locale)),
            ]))
        })
        .collect();
    let mut fields = vars(&[
        ("v", variant.join("+")),
        ("title", block.title.clone()),
        ("url", url.unwrap_or_default().to_owned()),
    ]);
    fields.insert("headline".to_owned(), Jinja::from(headline));
    fields.insert("rows".to_owned(), Jinja::from(rows));
    Jinja::from(fields)
}

/// `panel.report-digest`: a scheduled report or dashboard.
pub fn report_digest(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &DigestProps,
) -> Result<RenderedEmail, EmailError> {
    let target = if props.target_type == "dashboard" {
        "dashboard"
    } else {
        "report"
    };
    let mut flags = Vec::new();
    let mut values = vars(&[
        ("subscription_name", props.subscription_name.clone()),
        ("project_name", props.project_name.clone()),
        ("target_name", props.target_name.clone()),
        ("url", props.url.clone()),
        (
            "more_count",
            props.more_count.unwrap_or_default().to_string(),
        ),
    ]);
    if !props.blocks.is_empty() {
        flags.push("blocks");
        let rows: Vec<Jinja> = props
            .blocks
            .iter()
            .map(|block| block_row(block, locale))
            .collect();
        values.insert("rows".to_owned(), Jinja::from(rows));
    }
    if props.more_count.is_some_and(|c| c > 0) {
        flags.push("more");
    }
    render(
        &format!("panel.report-digest.{target}"),
        locale,
        brand,
        &flags,
        values,
    )
}

// ── exports ─────────────────────────────────────────────────────────────────

/// `PanelExportFailingEmailProps`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFailingProps {
    pub export_name: String,
    pub project_name: String,
    /// The destination bucket (and prefix).
    pub bucket: String,
    /// Consecutive failed attempts.
    pub failures: u32,
    pub last_error: Option<String>,
    pub url: String,
}

/// `panel.export-failing`: a raw export failed several times in a row.
pub fn export_failing(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &ExportFailingProps,
) -> Result<RenderedEmail, EmailError> {
    let last_error = props.last_error.clone().unwrap_or_default();
    let flags: &[&str] = if last_error.is_empty() {
        &[]
    } else {
        &["error"]
    };
    let values = vars(&[
        ("export_name", props.export_name.clone()),
        ("project_name", props.project_name.clone()),
        ("bucket", props.bucket.clone()),
        ("failures", props.failures.to_string()),
        ("last_error", last_error),
        ("url", props.url.clone()),
    ]);
    render("panel.export-failing", locale, brand, flags, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_read_like_intl() {
        let en = |v: f64| format_value(Some(v), NumberFormat::Number, EmailLocale::En);
        let nl = |v: f64| format_value(Some(v), NumberFormat::Number, EmailLocale::Nl);
        let pct = |v: f64, l| format_value(Some(v), NumberFormat::Percent, l);
        assert_eq!(en(1234.5), "1,234.5");
        assert_eq!(nl(1234.5), "1.234,5");
        assert_eq!(en(-1_234_567.891), "-1,234,567.89");
        assert_eq!(en(1.005), "1.01");
        assert_eq!(en(2.675), "2.68");
        assert_eq!(en(0.125), "0.13");
        assert_eq!(en(0.000_001), "0");
        assert_eq!(en(-0.0004), "-0");
        assert_eq!(en(99.995), "100");
        assert_eq!(en(1e21), "1,000,000,000,000,000,000,000");
        assert_eq!(en(123_456_789_012.0), "123,456,789,012");
        assert_eq!(en(42.0), "42");
        assert_eq!(pct(0.1234, EmailLocale::En), "12.3%");
        assert_eq!(pct(0.1234, EmailLocale::Nl), "12,3%");
        assert_eq!(pct(1234.5, EmailLocale::En), "123,450%");
        assert_eq!(pct(0.0005, EmailLocale::Nl), "0,1%");
        assert_eq!(pct(99.995, EmailLocale::Nl), "9.999,5%");
        assert_eq!(pct(0.07, EmailLocale::En), "7%");
        assert_eq!(
            format_value(None, NumberFormat::Number, EmailLocale::En),
            "–"
        );
        assert_eq!(
            format_value(Some(f64::NAN), NumberFormat::Number, EmailLocale::En),
            "–"
        );
    }

    #[test]
    fn periods_and_changes_read_like_the_copy() {
        assert_eq!(
            format_alert_period(Some("2026-11-16"), AlertInterval::Weekly, EmailLocale::Nl),
            "week van 16 november 2026"
        );
        assert_eq!(
            format_alert_period(
                Some("2026-11-16T10:00"),
                AlertInterval::Hourly,
                EmailLocale::En
            ),
            "November 16, 2026 10:00"
        );
        assert_eq!(
            format_alert_period(Some("soon"), AlertInterval::Daily, EmailLocale::En),
            "soon"
        );
        let figure = |value, previous, format| DigestFigure {
            label: "Visitors".to_owned(),
            value: Some(value),
            previous,
            format,
        };
        assert_eq!(
            format_change(
                &figure(42.0, Some(21.0), NumberFormat::Number),
                EmailLocale::En
            )
            .as_deref(),
            Some("+100%")
        );
        assert_eq!(
            format_change(
                &figure(0.412, Some(0.455), NumberFormat::Percent),
                EmailLocale::En
            )
            .as_deref(),
            Some("-4.3%")
        );
        assert_eq!(
            format_change(
                &figure(5.0, Some(0.0), NumberFormat::Number),
                EmailLocale::En
            )
            .as_deref(),
            Some("new")
        );
        assert_eq!(
            digest_figure_text(
                &figure(120.0, Some(100.0), NumberFormat::Number),
                EmailLocale::En
            ),
            "Visitors: 120 (+20%)"
        );
        assert_eq!(fill("{a} {b} {c}", &[("a", "1"), ("b", "2")]), "1 2 {c}");
    }
}
