//! CSV export of WeldDesk reports (`services/desk-report-export.ts`,
//! TASK-1228): the overview as one flat table, and a saved report as the
//! points of all its charts. The same builders feed the CSV routes
//! (`GET /overview/export`, `GET /reports/:reportId/export`) and the CSV
//! attached to a scheduled report email ([`super::report_mail`]).
//!
//! - overview: `section,label,metric,value,previous`
//! - saved report: `chart,label,value`
//!
//! Durations are whole seconds, exactly as the overview returns them; chart
//! values are in the chart's own unit. The writer is `@weldsuite/worker-kit/csv`:
//! RFC 4180 quoting, CRLF line breaks, a UTF-8 byte order mark and a guard
//! against spreadsheet formula injection.

use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;

use super::reports::{self, ChartQuery, date_key, is_breakdown};
use crate::js::query_param;
use crate::{Caller, Refusal};

// ── the CSV writer (`@weldsuite/worker-kit/csv`) ────────────────────────────

/// `/^-?\d+(\.\d+)?$/`
fn is_plain_number(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    let (whole, fraction) = match digits.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (digits, None),
    };
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
}

/// `neutralizeCsvText(value)`: a text a spreadsheet would run as a formula
/// (`=`, `+`, `@`, a tab or a return at the start, or a `-` that is not a
/// plain number) gets a leading quote.
fn neutralize(value: &str) -> String {
    let risky = value.starts_with(['=', '+', '@', '\t', '\r'])
        || (value.starts_with('-') && !is_plain_number(value));
    if risky {
        format!("'{value}")
    } else {
        value.to_owned()
    }
}

fn quote(text: &str) -> String {
    if text.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_owned()
    }
}

/// `csvCell(value)`: one cell as CSV text; `null` is empty, a number is
/// written as it is (so a negative number stays one).
fn csv_cell(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::String(text) => quote(&neutralize(text)),
        other => quote(&neutralize(&other.to_string())),
    }
}

/// `toCsv(header, rows)`: the CSV document of a header row and data rows.
fn to_csv(header: &[&str], rows: &[Vec<Value>]) -> String {
    let mut lines = Vec::with_capacity(rows.len() + 1);
    lines.push(
        header
            .iter()
            .map(|cell| quote(&neutralize(cell)))
            .collect::<Vec<_>>()
            .join(","),
    );
    for row in rows {
        lines.push(row.iter().map(csv_cell).collect::<Vec<_>>().join(","));
    }
    format!("\u{feff}{}\r\n", lines.join("\r\n"))
}

/// `csvResponse(csv, filename)`: a CSV download. The filename is reduced to
/// letters, digits, dot, dash and underscore.
fn csv_response(csv: String, filename: &str) -> Response {
    let safe: String = filename
        .chars()
        .flat_map(|c| {
            let keep = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
            // JavaScript replaces per UTF-16 unit.
            let units = if keep { 1 } else { c.len_utf16() };
            std::iter::repeat_n(if keep { c } else { '_' }, units)
        })
        .collect();
    (
        [
            (CONTENT_TYPE, "text/csv; charset=utf-8".to_owned()),
            (
                CONTENT_DISPOSITION,
                format!("attachment; filename=\"{safe}\""),
            ),
        ],
        csv,
    )
        .into_response()
}

// ── the overview ────────────────────────────────────────────────────────────

const OVERVIEW_CSV_HEADER: [&str; 5] = ["section", "label", "metric", "value", "previous"];
const REPORT_CSV_HEADER: [&str; 3] = ["chart", "label", "value"];

/// `OVERVIEW_KPIS`: the KPIs in the order the overview CSV lists them, with
/// how each is measured.
const OVERVIEW_KPIS: [(&str, &str); 8] = [
    ("created", "count"),
    ("resolved", "count"),
    ("firstResponseAvg", "seconds"),
    ("firstResponseMedian", "seconds"),
    ("resolutionAvg", "seconds"),
    ("resolutionMedian", "seconds"),
    ("slaCompliance", "percent"),
    ("csat", "percent"),
];

fn row(section: &str, label: &Value, metric: &str, value: &Value, previous: &Value) -> Vec<Value> {
    vec![
        json!(section),
        label.clone(),
        json!(metric),
        value.clone(),
        previous.clone(),
    ]
}

/// `personRows(section, people)`.
fn person_rows(rows: &mut Vec<Vec<Value>>, section: &str, people: &Value) {
    for person in people.as_array().map_or(&[][..], Vec::as_slice) {
        for metric in [
            "created",
            "resolved",
            "firstResponseAvg",
            "resolutionAvg",
            "ratings",
            "csat",
        ] {
            rows.push(row(
                section,
                &person["name"],
                metric,
                &person[metric],
                &Value::Null,
            ));
        }
    }
}

/// `overviewCsv(overview)`: the overview ([`reports::overview`]) as
/// `section,label,metric,value,previous`. Empty `value` / `previous` means
/// there is no data.
pub(super) fn overview_csv(overview: &Value) -> String {
    let none = Value::Null;
    let range = &overview["range"];
    let mut rows = vec![
        row("period", &json!("range"), "text", &range["key"], &none),
        row("period", &json!("start"), "date", &range["start"], &none),
        row("period", &json!("end"), "date", &range["end"], &none),
    ];
    for (key, metric) in OVERVIEW_KPIS {
        let pair = &overview["kpis"][key];
        rows.push(row(
            "kpi",
            &json!(key),
            metric,
            &pair["value"],
            &pair["previous"],
        ));
    }
    let counts = &overview["counts"];
    for (key, metric) in [
        ("firstResponses", "count"),
        ("resolutions", "count"),
        ("slaMet", "count"),
        ("slaBreached", "count"),
        ("ratings", "count"),
        ("ratingAverage", "rating"),
    ] {
        rows.push(row("count", &json!(key), metric, &counts[key], &none));
    }
    for key in ["open", "unassigned", "waiting"] {
        rows.push(row(
            "backlog",
            &json!(key),
            "count",
            &overview["backlog"][key],
            &none,
        ));
    }
    for point in overview["series"].as_array().map_or(&[][..], Vec::as_slice) {
        for metric in ["created", "resolved", "firstResponseAvg", "resolutionAvg"] {
            rows.push(row(
                "series",
                &point["label"],
                metric,
                &point[metric],
                &none,
            ));
        }
    }
    for (section, list) in [("channel", "byChannel"), ("priority", "byPriority")] {
        for item in overview[list].as_array().map_or(&[][..], Vec::as_slice) {
            rows.push(row(section, &item["key"], "created", &item["count"], &none));
        }
    }
    person_rows(&mut rows, "agent", &overview["agents"]);
    person_rows(&mut rows, "team", &overview["teams"]);
    to_csv(&OVERVIEW_CSV_HEADER, &rows)
}

/// `overviewCsvFilename(range, now)`.
pub(super) fn overview_csv_filename(range: &str, now: i64) -> String {
    format!("welddesk-overview-{range}-{}.csv", date_key(now))
}

// ── a saved report ──────────────────────────────────────────────────────────

/// `SavedReportChartData`.
pub(super) struct SavedChart {
    pub(super) title: String,
    /// The chart's metric is a breakdown (by channel, agent, …) rather than
    /// a time series.
    pub(super) breakdown: bool,
    /// `{ label, value }` points.
    pub(super) points: Vec<Value>,
}

/// `SavedReportData`.
pub(super) struct SavedReport {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) charts: Vec<SavedChart>,
}

/// `loadSavedReport(db, reportId, now)`: a saved report with every chart's
/// data as of `now`; `None` when the report does not exist or was deleted.
pub(super) async fn load_saved_report(
    db: &PgPool,
    report_id: &str,
    now: i64,
) -> Result<Option<SavedReport>, sqlx::Error> {
    let report: Option<(String, String)> = sqlx::query_as(
        "select id, title from helpdesk_analytics_reports where id = $1 and deleted_at is null limit 1",
    )
    .bind(report_id)
    .fetch_optional(db)
    .await?;
    let Some((id, title)) = report else {
        return Ok(None);
    };
    let charts: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from helpdesk_analytics_charts t
         where t.report_id = $1 and t.deleted_at is null
         order by t.sort_index asc, t.created_at asc",
    )
    .bind(report_id)
    .fetch_all(db)
    .await?;
    let mut with_data = Vec::with_capacity(charts.len());
    for chart in &charts {
        // The stored value, or the builder's default where the column is null.
        let or = |column: &str, fallback: &str| match &chart[column] {
            Value::Null => json!(fallback),
            value => value.clone(),
        };
        let mut query = Map::new();
        query.insert("metric".to_owned(), chart["metric"].clone());
        query.insert("timeRange".to_owned(), or("time_range", "last_30_days"));
        query.insert("groupBy".to_owned(), or("group_by", "day"));
        query.insert("aggregation".to_owned(), or("aggregation", "sum"));
        query.insert("sortOrder".to_owned(), chart["sort_order"].clone());
        query.insert("limit".to_owned(), chart["limit"].clone());
        let points = reports::chart_data(db, &ChartQuery::from_fields(&query), now).await?;
        with_data.push(SavedChart {
            title: chart["title"].as_str().unwrap_or_default().to_owned(),
            breakdown: chart["metric"].as_str().is_some_and(is_breakdown),
            points,
        });
    }
    Ok(Some(SavedReport {
        id,
        title,
        charts: with_data,
    }))
}

/// `savedReportCsv(report)`: a saved report as `chart,label,value`: one row
/// per point of every chart, in the report's chart order. A chart without
/// data still gets one row (its title, empty label and value) so it does not
/// vanish from the file.
pub(super) fn saved_report_csv(report: &SavedReport) -> String {
    let mut rows = Vec::new();
    for chart in &report.charts {
        let title = json!(chart.title);
        if chart.points.is_empty() {
            rows.push(vec![title, Value::Null, Value::Null]);
            continue;
        }
        for point in &chart.points {
            rows.push(vec![
                title.clone(),
                point["label"].clone(),
                point["value"].clone(),
            ]);
        }
    }
    to_csv(&REPORT_CSV_HEADER, &rows)
}

/// `reportCsvFilename(report, now)`: `welddesk-report-<slug>-<YYYY-MM-DD>.csv`,
/// the slug being the title in lower case with every run of characters other
/// than a-z and 0-9 turned into `-`, trimmed of dashes and cut at 40
/// characters (the report id when nothing is left).
pub(super) fn report_csv_filename(report: &SavedReport, now: i64) -> String {
    let mut slug = String::new();
    for c in report.title.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(40).collect();
    let slug = slug.trim_end_matches('-');
    let name = if slug.is_empty() { &report.id } else { slug };
    format!("welddesk-report-{name}-{}.csv", date_key(now))
}

// ── routes ──────────────────────────────────────────────────────────────────

/// `GET /overview/export?range=`: the overview as CSV.
pub(super) async fn overview_export(caller: Caller, RawQuery(query): RawQuery) -> Response {
    let range = query_param(query.as_deref(), "range");
    let now = reports::clock_ms(&caller);
    match reports::overview(&caller.db, range.as_deref(), now).await {
        Ok(overview) => {
            let range = overview["range"]["key"].as_str().unwrap_or_default();
            csv_response(overview_csv(&overview), &overview_csv_filename(range, now))
        }
        Err(error) => Refusal::Database(error).respond("Failed to export the reports overview"),
    }
}

/// `GET /reports/:reportId/export`: every chart of a saved report as CSV.
pub(super) async fn report_export(caller: Caller, Path(report_id): Path<String>) -> Response {
    let message = "Failed to export the report";
    let now = reports::clock_ms(&caller);
    match load_saved_report(&caller.db, &report_id, now).await {
        Ok(Some(report)) => csv_response(
            saved_report_csv(&report),
            &report_csv_filename(&report, now),
        ),
        Ok(None) => Refusal::not_found("Report", &report_id).respond(message),
        Err(error) => Refusal::Database(error).respond(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cells_guard_formulas_and_quote() {
        assert_eq!(neutralize("=SUM(A1)"), "'=SUM(A1)");
        assert_eq!(neutralize("+31 6"), "'+31 6");
        assert_eq!(neutralize("@home"), "'@home");
        assert_eq!(neutralize("-12.50"), "-12.50");
        assert_eq!(neutralize("-x"), "'-x");
        assert_eq!(neutralize("plain"), "plain");
        assert_eq!(csv_cell(&json!(null)), "");
        assert_eq!(csv_cell(&json!(-3)), "-3");
        assert_eq!(csv_cell(&json!(87.5)), "87.5");
        assert_eq!(csv_cell(&json!(true)), "true");
        assert_eq!(
            csv_cell(&json!("=HYPERLINK(\"http://evil\")")),
            "\"'=HYPERLINK(\"\"http://evil\"\")\""
        );
        assert_eq!(csv_cell(&json!("a,b")), "\"a,b\"");
        assert_eq!(csv_cell(&json!("line\nbreak")), "\"line\nbreak\"");
    }

    #[test]
    fn documents_have_a_bom_and_crlf() {
        let csv = to_csv(
            &REPORT_CSV_HEADER,
            &[
                vec![json!("By channel"), json!("email"), json!(1)],
                vec![json!("Empty"), Value::Null, Value::Null],
            ],
        );
        assert_eq!(
            csv,
            "\u{feff}chart,label,value\r\nBy channel,email,1\r\nEmpty,,\r\n"
        );
        assert_eq!(
            to_csv(&REPORT_CSV_HEADER, &[]),
            "\u{feff}chart,label,value\r\n"
        );
    }

    #[test]
    fn the_overview_is_one_flat_table() {
        let overview = json!({
            "range": { "key": "last_7_days", "start": "2026-03-09", "end": "2026-03-16" },
            "kpis": {
                "created": { "value": 2, "previous": 0 },
                "firstResponseMedian": { "value": 2700, "previous": null },
                "slaCompliance": { "value": null, "previous": null },
                "csat": { "value": 87.5, "previous": 100 },
            },
            "counts": { "firstResponses": 2, "ratingAverage": 4.5 },
            "backlog": { "open": 1, "unassigned": 0, "waiting": 1 },
            "series": [{ "label": "2026-03-10", "created": 1, "resolved": 1, "firstResponseAvg": 1800, "resolutionAvg": null }],
            "byChannel": [{ "key": "email", "count": 1 }],
            "byPriority": [{ "key": "high", "count": 1 }],
            "agents": [{ "id": "user_bob", "name": "=HYPERLINK(\"http://evil\")", "created": 1, "resolved": 0, "firstResponseAvg": 3600, "resolutionAvg": null, "ratings": 0, "csat": null }],
            "teams": [],
        });
        let csv = overview_csv(&overview);
        let lines: Vec<&str> = csv
            .trim_start_matches('\u{feff}')
            .trim_end_matches("\r\n")
            .split("\r\n")
            .collect();
        assert_eq!(lines[0], "section,label,metric,value,previous");
        assert_eq!(lines[1], "period,range,text,last_7_days,");
        assert_eq!(lines[3], "period,end,date,2026-03-16,");
        assert!(lines.contains(&"kpi,created,count,2,0"));
        assert!(lines.contains(&"kpi,firstResponseMedian,seconds,2700,"));
        assert!(lines.contains(&"kpi,slaCompliance,percent,,"));
        assert!(lines.contains(&"kpi,csat,percent,87.5,100"));
        assert!(lines.contains(&"count,ratingAverage,rating,4.5,"));
        assert!(lines.contains(&"backlog,open,count,1,"));
        assert!(lines.contains(&"series,2026-03-10,resolutionAvg,,"));
        assert!(lines.contains(&"channel,email,created,1,"));
        assert!(lines.contains(&"agent,\"'=HYPERLINK(\"\"http://evil\"\")\",created,1,"));
    }

    #[test]
    fn files_are_named_after_the_range_or_the_title() {
        // 2026-03-15T12:00:00Z
        let now = 1_773_576_000_000;
        assert_eq!(
            overview_csv_filename("last_7_days", now),
            "welddesk-overview-last_7_days-2026-03-15.csv"
        );
        let report = |title: &str| SavedReport {
            id: "rpt_exp_empty".to_owned(),
            title: title.to_owned(),
            charts: Vec::new(),
        };
        assert_eq!(
            report_csv_filename(&report("Weekly volume / \"Q1\""), now),
            "welddesk-report-weekly-volume-q1-2026-03-15.csv"
        );
        assert_eq!(
            report_csv_filename(&report("!!!"), now),
            "welddesk-report-rpt_exp_empty-2026-03-15.csv"
        );
        // Cut at 40 characters, without a dash left at the end.
        assert_eq!(
            report_csv_filename(
                &report("An exceptionally long report title that goes on"),
                now
            ),
            "welddesk-report-an-exceptionally-long-report-title-that-2026-03-15.csv"
        );
    }
}
