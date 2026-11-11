//! WeldDesk's scheduled report
//! (`packages/core/emails/src/templates/desk/report.tsx`): the overview (a
//! row per KPI with its change against the period before, the backlog now and
//! the top agents) or a saved report (a small table per chart).
//!
//! The rows are lists in the exported template: [`report`] passes one value
//! per row with the `shape` its React row takes, and writes no markup. The
//! figures arrive raw and are formatted here the way the template's
//! `formatReportNumber`, `formatReportDuration`, `formatKpi` and `changeOf`
//! do. [`overview_period_label`] and [`short_date`] write the period the
//! sender puts in the subject (`overviewPeriodLabel` and `shortDate` of
//! desk-api's `services/desk-report-schedules.ts`).

use std::collections::BTreeMap;
use std::sync::LazyLock;

use minijinja::Value;

use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, render};

/// `DeskReportKpiKey`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KpiKey {
    Created,
    Resolved,
    FirstResponseMedian,
    ResolutionMedian,
    SlaCompliance,
    Csat,
}

/// How a KPI is written (`KpiKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KpiKind {
    Count,
    Duration,
    Percent,
}

/// Which direction of change is an improvement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Good {
    Up,
    Down,
}

impl KpiKey {
    /// The key as the template's props spell it (`firstResponseMedian`).
    pub fn parse(key: &str) -> Option<Self> {
        match key {
            "created" => Some(Self::Created),
            "resolved" => Some(Self::Resolved),
            "firstResponseMedian" => Some(Self::FirstResponseMedian),
            "resolutionMedian" => Some(Self::ResolutionMedian),
            "slaCompliance" => Some(Self::SlaCompliance),
            "csat" => Some(Self::Csat),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Resolved => "resolved",
            Self::FirstResponseMedian => "firstResponseMedian",
            Self::ResolutionMedian => "resolutionMedian",
            Self::SlaCompliance => "slaCompliance",
            Self::Csat => "csat",
        }
    }

    /// `KPI_FORMAT[key]`.
    fn format(self) -> (KpiKind, Option<Good>) {
        match self {
            Self::Created => (KpiKind::Count, None),
            Self::Resolved => (KpiKind::Count, Some(Good::Up)),
            Self::FirstResponseMedian | Self::ResolutionMedian => {
                (KpiKind::Duration, Some(Good::Down))
            }
            Self::SlaCompliance | Self::Csat => (KpiKind::Percent, Some(Good::Up)),
        }
    }
}

/// `DeskReportKpi`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DeskReportKpi {
    pub key: KpiKey,
    /// Whole counts, seconds (the two medians) or a percentage; `None`: no
    /// data in the period.
    pub value: Option<f64>,
    /// The same figure for the period just before.
    pub previous: Option<f64>,
}

/// One row of a chart (`DeskReportChart['rows'][number]`).
#[derive(Debug, Clone, PartialEq)]
pub struct DeskReportPoint {
    pub label: String,
    pub value: f64,
}

/// `DeskReportChart`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DeskReportChart {
    pub title: String,
    /// Up to 10 rows; an empty list reads as "no data".
    pub rows: Vec<DeskReportPoint>,
}

/// `DeskReportAgent`.
#[derive(Debug, Clone, PartialEq)]
pub struct DeskReportAgent {
    pub name: String,
    pub resolved: f64,
    /// Percentage of ratings that were 4 or 5.
    pub csat: Option<f64>,
}

/// `DeskReportEmailProps['backlog']`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DeskReportBacklog {
    pub open: f64,
    pub unassigned: f64,
    pub waiting: f64,
}

/// `DeskReportEmailProps`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DeskReport {
    /// Name of the schedule, shown in the footer.
    pub schedule_name: String,
    /// Title of the saved report. `None` (or blank): the overview.
    pub report_title: Option<String>,
    /// The period as the recipient reads it; for a saved report the day it
    /// was sent.
    pub period_label: String,
    /// Overview: the KPIs, in the order shown.
    pub kpis: Vec<DeskReportKpi>,
    /// Overview: the backlog now.
    pub backlog: Option<DeskReportBacklog>,
    /// Overview: the top agents.
    pub agents: Vec<DeskReportAgent>,
    /// Saved report: its charts.
    pub charts: Vec<DeskReportChart>,
    /// Absolute link that opens the report in WeldDesk.
    pub url: String,
    /// Name of the member who set the schedule up.
    pub scheduled_by: Option<String>,
    /// The numbers are also attached as a CSV file.
    pub csv_attached: bool,
}

// ── strings ─────────────────────────────────────────────────────────────────

/// `emailStrings(locale).deskReport`, as far as the formatting reads it.
struct Strings {
    kpi: BTreeMap<String, String>,
    period_range: String,
    no_value: String,
    no_change: String,
    new_value: String,
    points: String,
    second: String,
    minute: String,
    hour: String,
    day: String,
}

fn read_strings(json: &str) -> Strings {
    let all: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    let t = &all["deskReport"];
    let text = |value: &serde_json::Value| value.as_str().unwrap_or_default().to_owned();
    Strings {
        kpi: t["kpi"]
            .as_object()
            .map(|labels| {
                labels
                    .iter()
                    .map(|(key, label)| (key.clone(), text(label)))
                    .collect()
            })
            .unwrap_or_default(),
        period_range: text(&t["periodRange"]),
        no_value: text(&t["noValue"]),
        no_change: text(&t["noChange"]),
        new_value: text(&t["newValue"]),
        points: text(&t["points"]),
        second: text(&t["units"]["second"]),
        minute: text(&t["units"]["minute"]),
        hour: text(&t["units"]["hour"]),
        day: text(&t["units"]["day"]),
    }
}

static STRINGS: LazyLock<(Strings, Strings)> = LazyLock::new(|| {
    (
        read_strings(include_str!("../../../catalogs/emails/strings.en.json")),
        read_strings(include_str!("../../../catalogs/emails/strings.nl.json")),
    )
});

fn strings(locale: EmailLocale) -> &'static Strings {
    match locale {
        EmailLocale::En => &STRINGS.0,
        EmailLocale::Nl => &STRINGS.1,
    }
}

// ── numbers ─────────────────────────────────────────────────────────────────

/// `Math.round(value)`: halves go up.
fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `String(value)` of a JavaScript number, for the figures a report holds.
fn js_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    if value.fract() == 0.0 && value.abs() < 1e21 {
        return format!("{value:.0}");
    }
    value.to_string()
}

/// `formatReportNumber(value, locale)`: `12`, `12.5`; Dutch with a decimal
/// comma. One decimal at most.
pub fn format_number(value: f64, locale: EmailLocale) -> String {
    let text = js_number(js_round(value * 10.0) / 10.0);
    match locale {
        EmailLocale::En => text,
        EmailLocale::Nl => text.replacen('.', ",", 1),
    }
}

/// `formatReportDuration(seconds, locale)`: seconds as `45s`, `12m`,
/// `1h 30m` or `2d 3h`. From a minute up the duration is rounded to whole
/// minutes once and every unit is read from that, so a unit never shows its
/// own full count: 59m 30s is `1h`, not `60m`, and 23h 59m 30s is `1d`,
/// not `24h`.
pub fn format_duration(seconds: f64, locale: EmailLocale) -> String {
    let u = strings(locale);
    let total = js_round(seconds).max(0.0);
    if total < 60.0 {
        return format!("{}{}", js_number(total), u.second);
    }
    let minutes = js_round(total / 60.0);
    if minutes < 60.0 {
        return format!("{}{}", js_number(minutes), u.minute);
    }
    let hours = (minutes / 60.0).floor();
    if hours < 24.0 {
        let rest = minutes % 60.0;
        return if rest == 0.0 {
            format!("{}{}", js_number(hours), u.hour)
        } else {
            format!(
                "{}{} {}{}",
                js_number(hours),
                u.hour,
                js_number(rest),
                u.minute
            )
        };
    }
    let days = (hours / 24.0).floor();
    let rest_hours = hours % 24.0;
    if rest_hours == 0.0 {
        format!("{}{}", js_number(days), u.day)
    } else {
        format!(
            "{}{} {}{}",
            js_number(days),
            u.day,
            js_number(rest_hours),
            u.hour
        )
    }
}

/// `formatKpi(kpi, locale)`.
fn format_kpi(kpi: &DeskReportKpi, locale: EmailLocale) -> String {
    let Some(value) = kpi.value else {
        return strings(locale).no_value.clone();
    };
    match kpi.key.format().0 {
        KpiKind::Duration => format_duration(value, locale),
        KpiKind::Percent => format!("{}%", format_number(value, locale)),
        KpiKind::Count => format_number(value, locale),
    }
}

/// The colour a change is written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tone {
    Green,
    Red,
}

/// `changeOf(kpi, t, locale)`: the change against the previous period;
/// `None` when either figure is missing.
fn change_of(kpi: &DeskReportKpi, locale: EmailLocale) -> Option<(String, Option<Tone>)> {
    let (value, previous) = (kpi.value?, kpi.previous?);
    let t = strings(locale);
    let (kind, good) = kpi.key.format();
    let sign = |delta: f64| if delta > 0.0 { '+' } else { '-' };
    let (delta, text) = if kind == KpiKind::Percent {
        let delta = js_round((value - previous) * 10.0) / 10.0;
        let text = format!(
            "{}{} {}",
            sign(delta),
            format_number(delta.abs(), locale),
            t.points
        );
        (delta, text)
    } else if previous == 0.0 {
        (if value == 0.0 { 0.0 } else { 1.0 }, t.new_value.clone())
    } else {
        let percent = js_round(((value - previous) / previous) * 100.0);
        (
            percent,
            format!("{}{}%", sign(percent), js_number(percent.abs())),
        )
    };
    if delta == 0.0 {
        return Some((t.no_change.clone(), None));
    }
    let Some(good) = good else {
        return Some((text, None));
    };
    let improved = (delta > 0.0) == (good == Good::Up);
    Some((text, Some(if improved { Tone::Green } else { Tone::Red })))
}

// ── the period ──────────────────────────────────────────────────────────────

const MONTHS_EN: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTHS_NL: [&str; 12] = [
    "jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec",
];

/// `YYYY-MM-DD` as a date.
fn civil(date_key: &str) -> Result<jiff::civil::Date, EmailError> {
    date_key
        .parse()
        .map_err(|error| EmailError::Date(format!("{date_key}: {error}")))
}

fn short(date: jiff::civil::Date, locale: EmailLocale) -> String {
    let month = usize::try_from(date.month() - 1).unwrap_or(0);
    match locale {
        EmailLocale::En => format!("{} {}, {}", MONTHS_EN[month], date.day(), date.year()),
        EmailLocale::Nl => format!("{} {} {}", date.day(), MONTHS_NL[month], date.year()),
    }
}

/// `shortDate(dateKey, locale)`: "Mar 15, 2026" / "15 mrt 2026", of a UTC
/// date key (`YYYY-MM-DD`), as `Intl.DateTimeFormat` writes a short month.
pub fn short_date(date_key: &str, locale: EmailLocale) -> Result<String, EmailError> {
    Ok(short(civil(date_key)?, locale))
}

/// `overviewPeriodLabel(range, locale)`: the days an overview covers as the
/// reader sees them: one date, or "start to end" (`end` is exclusive).
pub fn overview_period_label(
    start: &str,
    end: &str,
    locale: EmailLocale,
) -> Result<String, EmailError> {
    let first = civil(start)?;
    let last = civil(end)?
        .yesterday()
        .map_err(|error| EmailError::Date(format!("{end}: {error}")))?;
    if last <= first {
        return Ok(short(first, locale));
    }
    Ok(strings(locale)
        .period_range
        .replace("{start}", &short(first, locale))
        .replace("{end}", &short(last, locale)))
}

// ── the email ───────────────────────────────────────────────────────────────

/// `value?.trim()`, with an empty result counting as absent.
fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

fn row<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::from(
        fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect::<BTreeMap<String, Value>>(),
    )
}

/// The KPI rows: the figure alone (`value`), or with its change, plain
/// (`change`) or coloured (`green`, `red`).
fn kpi_rows(kpis: &[DeskReportKpi], locale: EmailLocale) -> Value {
    let t = strings(locale);
    let rows: Vec<Value> = kpis
        .iter()
        .map(|kpi| {
            let label = t.kpi.get(kpi.key.as_str()).cloned().unwrap_or_default();
            let value = format_kpi(kpi, locale);
            match change_of(kpi, locale) {
                None => row([
                    ("shape", Value::from("value")),
                    ("label", Value::from(label)),
                    ("value", Value::from(value)),
                ]),
                Some((change, tone)) => row([
                    (
                        "shape",
                        Value::from(match tone {
                            None => "change",
                            Some(Tone::Green) => "green",
                            Some(Tone::Red) => "red",
                        }),
                    ),
                    ("label", Value::from(label)),
                    ("value", Value::from(value)),
                    ("change", Value::from(change)),
                ]),
            }
        })
        .collect();
    Value::from(rows)
}

/// The agent rows: with their CSAT (`csat`) or without (`plain`).
fn agent_rows(agents: &[DeskReportAgent], locale: EmailLocale) -> Value {
    let rows: Vec<Value> = agents
        .iter()
        .map(|agent| {
            let name = Value::from(agent.name.as_str());
            let resolved = Value::from(js_number(agent.resolved));
            match agent.csat {
                Some(csat) => row([
                    ("shape", Value::from("csat")),
                    ("name", name),
                    ("resolved", resolved),
                    ("csat", Value::from(format_number(csat, locale))),
                ]),
                None => row([
                    ("shape", Value::from("plain")),
                    ("name", name),
                    ("resolved", resolved),
                ]),
            }
        })
        .collect();
    Value::from(rows)
}

/// The charts: a table of rows (`rows`), or one line saying there is no
/// data (`empty`).
fn chart_rows(charts: &[DeskReportChart], locale: EmailLocale) -> Value {
    let rows: Vec<Value> = charts
        .iter()
        .map(|chart| {
            let title = Value::from(chart.title.as_str());
            if chart.rows.is_empty() {
                return row([("shape", Value::from("empty")), ("title", title)]);
            }
            let points: Vec<Value> = chart
                .rows
                .iter()
                .map(|point| {
                    row([
                        ("label", Value::from(point.label.as_str())),
                        ("value", Value::from(format_number(point.value, locale))),
                    ])
                })
                .collect();
            row([
                ("shape", Value::from("rows")),
                ("title", title),
                ("rows", Value::from(points)),
            ])
        })
        .collect();
    Value::from(rows)
}

/// Render `desk.report` (callers pass the template's brand,
/// `EmailBrand::weldsuite("WeldDesk")`).
pub fn report(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &DeskReport,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = BTreeMap::new();
    values.insert(
        "schedule_name".to_owned(),
        Value::from(props.schedule_name.as_str()),
    );
    values.insert(
        "period_label".to_owned(),
        Value::from(props.period_label.as_str()),
    );
    values.insert("url".to_owned(), Value::from(props.url.as_str()));
    // `props.reportTitle?.trim() || t.overview`
    if let Some(title) = trimmed(props.report_title.as_deref()) {
        flags.push("saved");
        values.insert("report_title".to_owned(), Value::from(title));
    }
    if let Some(backlog) = &props.backlog {
        flags.push("backlog");
        for (key, count) in [
            ("backlog_open", backlog.open),
            ("backlog_unassigned", backlog.unassigned),
            ("backlog_waiting", backlog.waiting),
        ] {
            values.insert(key.to_owned(), Value::from(js_number(count)));
        }
    }
    // `props.scheduledBy?.trim()`
    if let Some(by) = trimmed(props.scheduled_by.as_deref()) {
        flags.push("by");
        values.insert("scheduled_by".to_owned(), Value::from(by));
    }
    if props.csv_attached {
        flags.push("csv");
    }

    values.insert("kpis".to_owned(), kpi_rows(&props.kpis, locale));
    values.insert("agents".to_owned(), agent_rows(&props.agents, locale));
    values.insert("charts".to_owned(), chart_rows(&props.charts, locale));

    render("desk.report", locale, brand, &flags, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kpi(key: KpiKey, value: Option<f64>, previous: Option<f64>) -> DeskReportKpi {
        DeskReportKpi {
            key,
            value,
            previous,
        }
    }

    #[test]
    fn numbers_like_the_template() {
        assert_eq!(format_number(12.0, EmailLocale::En), "12");
        assert_eq!(format_number(12.45, EmailLocale::En), "12.5");
        assert_eq!(format_number(93.5, EmailLocale::Nl), "93,5");
        assert_eq!(format_number(-0.04, EmailLocale::En), "0");
        assert_eq!(js_number(128.0), "128");
        assert_eq!(js_number(21.5), "21.5");
    }

    #[test]
    fn durations_like_the_template() {
        let en = |seconds| format_duration(seconds, EmailLocale::En);
        assert_eq!(en(45.0), "45s");
        assert_eq!(en(-3.0), "0s");
        assert_eq!(en(1260.0), "21m");
        assert_eq!(en(3600.0), "1h");
        assert_eq!(en(15300.0), "4h 15m");
        assert_eq!(en(86_400.0), "1d");
        assert_eq!(en(183_600.0), "2d 3h");
        assert_eq!(format_duration(15300.0, EmailLocale::Nl), "4u 15m");
    }

    /// The same cases as `packages/core/emails/src/templates/desk/report.test.ts`.
    #[test]
    fn a_duration_never_shows_a_full_unit() {
        let en = |seconds| format_duration(seconds, EmailLocale::En);
        // Seconds to minutes.
        assert_eq!(en(59.0), "59s");
        assert_eq!(en(59.4), "59s");
        assert_eq!(en(59.5), "1m");
        assert_eq!(en(60.0), "1m");
        assert_eq!(en(89.0), "1m");
        assert_eq!(en(90.0), "2m");
        // Minutes to hours: 59m 30s and up is an hour, not `60m`.
        assert_eq!(en(3569.0), "59m");
        assert_eq!(en(3570.0), "1h");
        assert_eq!(en(3599.0), "1h");
        assert_eq!(en(3600.0), "1h");
        assert_eq!(en(3629.0), "1h");
        assert_eq!(en(3630.0), "1h 1m");
        assert_eq!(en(7169.0), "1h 59m");
        assert_eq!(en(7170.0), "2h");
        // Hours to days: 23h 59m 30s and up is a day, not `24h` or `23h 60m`.
        assert_eq!(en(86_369.0), "23h 59m");
        assert_eq!(en(86_370.0), "1d");
        assert_eq!(en(86_399.0), "1d");
        assert_eq!(en(86_400.0), "1d");
        assert_eq!(en(89_999.0), "1d 1h");
        // Days keep whole hours only.
        assert_eq!(en(172_799.0), "2d");
        assert_eq!(en(169_200.0), "1d 23h");
        assert_eq!(format_duration(3599.0, EmailLocale::Nl), "1u");
        assert_eq!(format_duration(86_399.0, EmailLocale::Nl), "1d");
    }

    #[test]
    fn changes_like_the_template() {
        let change = |kpi: DeskReportKpi| change_of(&kpi, EmailLocale::En);
        // A count with no good direction is never coloured.
        assert_eq!(
            change(kpi(KpiKey::Created, Some(128.0), Some(110.0))),
            Some(("+16%".to_owned(), None))
        );
        assert_eq!(
            change(kpi(KpiKey::Resolved, Some(119.0), Some(101.0))),
            Some(("+18%".to_owned(), Some(Tone::Green)))
        );
        // Faster is better.
        assert_eq!(
            change(kpi(KpiKey::FirstResponseMedian, Some(1260.0), Some(1800.0))),
            Some(("-30%".to_owned(), Some(Tone::Green)))
        );
        assert_eq!(
            change(kpi(KpiKey::ResolutionMedian, Some(15300.0), Some(14400.0))),
            Some(("+6%".to_owned(), Some(Tone::Red)))
        );
        assert_eq!(
            change(kpi(KpiKey::SlaCompliance, Some(93.5), Some(91.2))),
            Some(("+2.3 pts".to_owned(), Some(Tone::Green)))
        );
        assert_eq!(
            change_of(&kpi(KpiKey::Csat, Some(88.4), Some(90.0)), EmailLocale::Nl),
            Some(("-1,6 pnt".to_owned(), Some(Tone::Red)))
        );
        assert_eq!(
            change(kpi(KpiKey::Created, Some(0.0), Some(0.0))),
            Some(("no change".to_owned(), None))
        );
        assert_eq!(
            change(kpi(KpiKey::Resolved, Some(3.0), Some(0.0))),
            Some(("new".to_owned(), Some(Tone::Green)))
        );
        assert_eq!(
            change(kpi(KpiKey::FirstResponseMedian, None, Some(600.0))),
            None
        );
        assert_eq!(change(kpi(KpiKey::Csat, Some(80.0), None)), None);
    }

    #[test]
    fn periods_like_the_worker() {
        let label = |start, end, locale| overview_period_label(start, end, locale).expect("label");
        assert_eq!(
            label("2026-03-15", "2026-03-16", EmailLocale::En),
            "Mar 15, 2026"
        );
        assert_eq!(
            label("2026-03-09", "2026-03-16", EmailLocale::En),
            "Mar 9, 2026 to Mar 15, 2026"
        );
        assert_eq!(
            label("2026-03-09", "2026-03-16", EmailLocale::Nl),
            "9 mrt 2026 t/m 15 mrt 2026"
        );
        assert_eq!(
            short_date("2026-12-01", EmailLocale::Nl).expect("date"),
            "1 dec 2026"
        );
        assert!(short_date("soon", EmailLocale::En).is_err());
    }

    #[test]
    fn an_overview_lists_its_rows_and_a_saved_report_its_charts() {
        let brand = EmailBrand::weldsuite("WeldDesk");
        let overview = DeskReport {
            schedule_name: "Weekly".to_owned(),
            period_label: "Mar 9, 2026 to Mar 15, 2026".to_owned(),
            kpis: vec![
                kpi(KpiKey::Created, Some(2.0), Some(0.0)),
                kpi(KpiKey::Csat, None, None),
            ],
            backlog: Some(DeskReportBacklog {
                open: 1.0,
                unassigned: 0.0,
                waiting: 1.0,
            }),
            agents: vec![DeskReportAgent {
                name: "Ann <b>".to_owned(),
                resolved: 1.0,
                csat: Some(100.0),
            }],
            url: "https://app.weldsuite.org/welddesk/reports".to_owned(),
            scheduled_by: Some(" Sanne ".to_owned()),
            csv_attached: true,
            ..DeskReport::default()
        };
        let en = report(EmailLocale::En, &brand, &overview).expect("renders");
        assert_eq!(
            en.subject,
            "WeldDesk report: Overview (Mar 9, 2026 to Mar 15, 2026)"
        );
        assert!(
            en.text
                .contains("New tickets: 2 · new\n\nCSAT: No data\n\n")
        );
        assert!(en.text.contains("Ann <b> · 1 resolved — CSAT 100%"));
        assert!(en.html.contains("Ann &lt;b&gt;"));
        assert!(
            en.text
                .contains("Sanne scheduled this report (\"Weekly\") in WeldDesk.")
        );
        assert!(en.text.contains("The numbers are attached as a CSV file."));

        let saved = DeskReport {
            schedule_name: "Monthly".to_owned(),
            report_title: Some("Volume".to_owned()),
            period_label: "Mar 15, 2026".to_owned(),
            charts: vec![
                DeskReportChart {
                    title: "By channel".to_owned(),
                    rows: vec![DeskReportPoint {
                        label: "email".to_owned(),
                        value: 21.5,
                    }],
                },
                DeskReportChart {
                    title: "Ratings".to_owned(),
                    rows: Vec::new(),
                },
            ],
            url: "https://app.weldsuite.org/welddesk/reports/custom/rpt_1".to_owned(),
            ..DeskReport::default()
        };
        let nl = report(EmailLocale::Nl, &brand, &saved).expect("renders");
        assert_eq!(nl.subject, "WeldDesk-rapport: Volume (Mar 15, 2026)");
        assert!(
            nl.text
                .contains("By channel\n\nemail — 21,5\n\nRatings: geen gegevens.\n\n")
        );
        assert!(!nl.text.contains("Backlog"));
        assert!(
            nl.text
                .contains("Dit rapport wordt verstuurd door het schema \"Monthly\"")
        );
    }
}
