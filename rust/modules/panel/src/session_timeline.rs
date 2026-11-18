//! A recording turned into the compact text an AI summary reads
//! (`services/session-timeline.ts`, ADR PANEL-005).
//!
//! Only what the collector already stores masked: pages and the time on
//! each, the visible text of what was clicked or submitted, frustration
//! signals, error messages and custom event names. Never an input value, a
//! profile property, an email, a name or the visitor's id: the model is told
//! about "the visitor". Custom event properties are left out too.

use std::fmt::Write as _;

use serde_json::Value;
use weldsuite_panel_domain::js;

const MAX_LINES: usize = 150;
const MAX_CHARS: usize = 8000;
const MAX_TEXT: usize = 80;
const MAX_ERROR: usize = 160;

/// `FRUSTRATION_LABELS`.
fn frustration_label(name: &str) -> Option<&'static str> {
    Some(match name {
        "$rageclick" => "rage click (three or more fast clicks)",
        "$deadclick" => "dead click (nothing happened)",
        "$quickback" => "went straight back to the previous page",
        "$excessivescroll" => "scrolled up and down a lot",
        _ => return None,
    })
}

/// `clip(text, max)`: whitespace runs as one space, trimmed, at most `max`
/// UTF-16 units with an ellipsis.
fn clip(text: &str, max: usize) -> String {
    let mut flat = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if js::is_js_whitespace(c) {
            if !in_space {
                flat.push(' ');
            }
            in_space = true;
        } else {
            flat.push(c);
            in_space = false;
        }
    }
    let flat = js::trim(&flat);
    if js::utf16_len(flat) > max {
        format!("{}…", js::slice_utf16(flat, 0, max - 1))
    } else {
        flat.to_owned()
    }
}

/// `Math.max(Math.round(x), 0)` (NaN stays NaN).
fn round_at_least_zero(x: f64) -> f64 {
    let rounded = js::math_round(x);
    if rounded.is_nan() {
        rounded
    } else {
        rounded.max(0.0)
    }
}

/// `clock(ms)`: `m:ss` since the start.
fn clock(ms: f64) -> String {
    let total = round_at_least_zero(ms / 1000.0);
    if total.is_nan() {
        return "NaN:NaN".to_owned();
    }
    format!(
        "{}:{:0>2}",
        js::number_text((total / 60.0).floor()),
        js::number_text(total % 60.0)
    )
}

/// `span(seconds)`: `42s` or `3m 5s`.
fn span(seconds: f64) -> String {
    if seconds < 60.0 {
        return format!("{}s", js::number_text(seconds));
    }
    let minutes = (seconds / 60.0).floor();
    format!(
        "{}m {}s",
        js::number_text(minutes),
        js::number_text(seconds % 60.0)
    )
}

fn number(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(0.0)
}

/// A string field, `None` for null or empty (JavaScript's falsy text).
fn truthy(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn quoted(detail: Option<&str>) -> String {
    let text = detail
        .filter(|d| !d.is_empty())
        .map(|d| clip(d, MAX_TEXT))
        .unwrap_or_default();
    if text.is_empty() {
        "(no visible text)".to_owned()
    } else {
        format!("\"{text}\"")
    }
}

fn counted(n: f64, noun: &str) -> String {
    #[allow(clippy::float_cmp, reason = "JavaScript's `n === 1`")]
    let plural = if n == 1.0 { "" } else { "s" };
    format!("{} {noun}{plural}", js::number_text(n))
}

/// The header line: what kind of visit it was. No person, no ids.
fn header(session: &Value) -> String {
    let mut parts = vec![
        format!("Duration {}", span(number(session.get("durationSeconds")))),
        counted(number(session.get("pageviews")), "page"),
        counted(number(session.get("clicks")), "click"),
    ];
    let signals: Vec<String> = [
        ("rageClicks", "rage click"),
        ("deadClicks", "dead click"),
        ("quickBacks", "quick back"),
        ("errors", "error"),
    ]
    .iter()
    .filter_map(|(key, noun)| {
        let n = number(session.get(*key));
        (n > 0.0).then(|| counted(n, noun))
    })
    .collect();
    if !signals.is_empty() {
        parts.push(format!("signals: {}", signals.join(", ")));
    }
    let device: Vec<&str> = ["deviceType", "browser", "os"]
        .iter()
        .filter_map(|key| truthy(session.get(*key)))
        .collect();
    if !device.is_empty() {
        parts.push(format!("device: {}", device.join(" / ")));
    }
    if let Some(country) = truthy(session.get("country")) {
        parts.push(format!("country: {country}"));
    }
    parts.join(" · ")
}

/// The line for an event that is not a page view, or `None` when it is not
/// worth a line.
fn event_line(event: &Value, stamp: &str) -> Option<String> {
    let name = event["name"].as_str().unwrap_or_default();
    let detail = event["detail"].as_str();
    if name == "$autocapture" {
        let action = if event["properties"]["$action"].as_str() == Some("submit") {
            "Submitted a form via"
        } else {
            "Clicked"
        };
        return Some(format!("[{stamp}] {action} {}", quoted(detail)));
    }
    if name == "$exception" {
        return Some(format!(
            "[{stamp}] Error on the page: {}",
            clip(detail.unwrap_or("unknown error"), MAX_ERROR)
        ));
    }
    if let Some(label) = frustration_label(name) {
        let target = if name == "$rageclick" || name == "$deadclick" {
            format!(" on {}", quoted(detail))
        } else {
            String::new()
        };
        return Some(format!("[{stamp}] Frustration: {label}{target}"));
    }
    (!name.starts_with('$')).then(|| format!("[{stamp}] Event \"{}\"", clip(name, MAX_TEXT)))
}

/// Keeps the start and the end of a long timeline.
fn limit_lines(lines: Vec<String>) -> Vec<String> {
    if lines.len() <= MAX_LINES {
        return lines;
    }
    let head = MAX_LINES * 6 / 10;
    let tail = MAX_LINES - head;
    let omitted = lines.len() - MAX_LINES;
    let mut out: Vec<String> = lines[..head].to_vec();
    out.push(format!("... {omitted} events left out ..."));
    out.extend_from_slice(&lines[lines.len() - tail..]);
    out
}

/// `Date.parse(text)` as a number (NaN when it can't be read).
fn parse_ms(value: Option<&Value>) -> f64 {
    #[allow(clippy::cast_precision_loss, reason = "epoch milliseconds")]
    value
        .and_then(Value::as_str)
        .and_then(js::parse_iso)
        .map_or(f64::NAN, |ms| ms as f64)
}

/// `buildSessionTimeline(session, events)`: the timeline, oldest event
/// first. `session` is a `PanelSessionRow` and `events` the session's
/// `PanelActivityEvent`s (any order), as JSON.
pub(crate) fn build_session_timeline(session: &Value, events: &[Value], now: i64) -> String {
    let mut ordered: Vec<&Value> = events.iter().collect();
    ordered.sort_by(|a, b| {
        let text = |v: &Value, key: &str| v[key].as_str().unwrap_or_default().to_owned();
        js::locale_compare(&text(a, "ts"), &text(b, "ts"))
            .then_with(|| js::locale_compare(&text(a, "eventId"), &text(b, "eventId")))
    });
    let start = parse_ms(session.get("startedAt"));
    let end = parse_ms(session.get("endedAt"));

    let mut lines: Vec<String> = Vec::new();
    // The open page: its line and when it was opened.
    let mut current: Option<(usize, f64)> = None;
    let close_page = |lines: &mut Vec<String>, current: &mut Option<(usize, f64)>, until: f64| {
        if let Some((line, opened)) = current.take() {
            let seconds = round_at_least_zero((until - opened) / 1000.0);
            let _ = write!(lines[line], " ({} on the page)", span(seconds));
        }
    };

    for event in ordered {
        let when = parse_ms(event.get("ts"));
        let stamp = clock(when - start);
        if event["name"].as_str() == Some("$pageview") {
            close_page(&mut lines, &mut current, when);
            let title = truthy(event.get("title"))
                .map(|title| format!(" \"{}\"", clip(title, MAX_TEXT)))
                .unwrap_or_default();
            let path = event["path"].as_str().unwrap_or("(unknown page)");
            lines.push(format!("[{stamp}] Opened {path}{title}"));
            current = Some((lines.len() - 1, when));
        } else if let Some(line) = event_line(event, &stamp) {
            lines.push(line);
        }
    }
    #[allow(clippy::cast_precision_loss, reason = "epoch milliseconds")]
    let until = if end.is_nan() { now as f64 } else { end };
    close_page(&mut lines, &mut current, until);

    let mut text = limit_lines(lines).join("\n");
    if js::utf16_len(&text) > MAX_CHARS {
        text = format!("{}\n... cut ...", js::slice_utf16(&text, 0, MAX_CHARS));
    }
    let ending = match truthy(session.get("exitPage")) {
        Some(page) => format!("The visitor's last page was {page}."),
        None => "The last page is unknown.".to_owned(),
    };
    let entry = truthy(session.get("entryPage"))
        .map(|page| format!("Entry page: {page}\n"))
        .unwrap_or_default();
    let body = if text.is_empty() {
        "(no events)".to_owned()
    } else {
        text
    };
    format!("{}\n{entry}{ending}\n\nTimeline:\n{body}", header(session))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn session() -> Value {
        json!({
            "sessionId": "ses_1",
            "startedAt": "2026-11-10T10:00:00.000Z",
            "endedAt": "2026-11-10T10:05:00.000Z",
            "durationSeconds": 300,
            "pageviews": 2,
            "clicks": 3,
            "events": 9,
            "rageClicks": 1,
            "deadClicks": 0,
            "quickBacks": 0,
            "excessiveScrolls": 0,
            "errors": 1,
            "entryPage": "/pricing",
            "exitPage": "/checkout",
            "deviceType": "mobile",
            "browser": "Safari",
            "os": "iOS",
            "country": "NL",
            "distinctId": "ada@example.com",
            "userId": "ada@example.com",
            "hasRecording": true,
            "chunkCount": 2,
            "favorite": false,
        })
    }

    fn event(id: usize, name: &str, ts: &str, extra: &Value) -> Value {
        let mut event = json!({
            "eventId": format!("e{id}"), "name": name, "ts": ts, "path": null, "url": null,
            "title": null, "sessionId": "ses_1", "detail": null, "properties": {},
        });
        for (key, value) in extra.as_object().into_iter().flatten() {
            event[key] = value.clone();
        }
        event
    }

    fn timeline_lines(text: &str) -> Vec<String> {
        text.split("Timeline:\n")
            .nth(1)
            .unwrap_or_default()
            .split('\n')
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn lists_pages_clicks_frustration_errors_and_custom_events_in_order() {
        let events = [
            event(
                1,
                "$exception",
                "2026-11-10T10:04:00.000Z",
                &json!({ "detail": "pay is not defined" }),
            ),
            event(
                2,
                "$pageview",
                "2026-11-10T10:00:00.000Z",
                &json!({ "path": "/pricing", "title": "Pricing" }),
            ),
            event(
                3,
                "$autocapture",
                "2026-11-10T10:00:30.000Z",
                &json!({ "detail": "Choose Pro", "properties": { "$action": "click" } }),
            ),
            event(
                4,
                "$pageview",
                "2026-11-10T10:01:00.000Z",
                &json!({ "path": "/checkout" }),
            ),
            event(
                5,
                "Started checkout",
                "2026-11-10T10:01:10.000Z",
                &json!({ "properties": { "plan": "pro" } }),
            ),
            event(
                6,
                "$autocapture",
                "2026-11-10T10:02:00.000Z",
                &json!({ "detail": "Place order", "properties": { "$action": "submit" } }),
            ),
            event(
                7,
                "$rageclick",
                "2026-11-10T10:03:00.000Z",
                &json!({ "detail": "Pay now" }),
            ),
        ];
        let text = build_session_timeline(&session(), &events, 0);
        assert!(text.contains(
            "Duration 5m 0s · 2 pages · 3 clicks · signals: 1 rage click, 1 error · device: mobile / Safari / iOS · country: NL"
        ));
        assert!(text.contains("Entry page: /pricing"));
        assert!(text.contains("The visitor's last page was /checkout."));
        assert_eq!(
            timeline_lines(&text),
            [
                "[0:00] Opened /pricing \"Pricing\" (1m 0s on the page)",
                "[0:30] Clicked \"Choose Pro\"",
                "[1:00] Opened /checkout (4m 0s on the page)",
                "[1:10] Event \"Started checkout\"",
                "[2:00] Submitted a form via \"Place order\"",
                "[3:00] Frustration: rage click (three or more fast clicks) on \"Pay now\"",
                "[4:00] Error on the page: pay is not defined",
            ]
        );
    }

    #[test]
    fn never_names_the_person_or_event_properties() {
        let events = [event(
            1,
            "Started checkout",
            "2026-11-10T10:01:10.000Z",
            &json!({ "properties": { "email": "ada@example.com", "card": "4111" } }),
        )];
        let text = build_session_timeline(&session(), &events, 0);
        assert!(!text.contains("ada@example.com"));
        assert!(!text.contains("4111"));
        assert!(!text.contains("email"));
    }

    #[test]
    fn says_so_for_no_visible_text_and_cuts_long_text() {
        let long = format!("  {}  ", "x".repeat(300));
        let events = [
            event(
                1,
                "$autocapture",
                "2026-11-10T10:01:00.000Z",
                &json!({ "properties": { "$action": "click" } }),
            ),
            event(
                2,
                "$autocapture",
                "2026-11-10T10:02:00.000Z",
                &json!({ "detail": long, "properties": { "$action": "click" } }),
            ),
        ];
        let text = build_session_timeline(&session(), &events, 0);
        assert!(text.contains("Clicked (no visible text)"));
        assert!(text.contains(&format!("\"{}…\"", "x".repeat(79))));
        assert!(!text.contains(&"x".repeat(100)));
    }

    #[test]
    fn keeps_the_start_and_the_end_of_a_long_session() {
        let start = js::parse_iso("2026-11-10T10:00:00.000Z").expect("a date");
        let many: Vec<Value> = (0..400)
            .map(|i| {
                event(
                    i,
                    "Step",
                    &js::iso_string(start + i64::try_from(i).unwrap_or(0) * 500),
                    &json!({}),
                )
            })
            .collect();
        let text = build_session_timeline(&session(), &many, 0);
        let lines = timeline_lines(&text);
        assert!(lines.len() <= 151);
        assert!(lines[0].contains("[0:00] Event \"Step\""));
        assert!(lines.iter().any(|l| l.contains("events left out")));
        assert!(lines.last().is_some_and(|l| l.contains("Event \"Step\"")));
        assert!(text.len() < 9000);
    }

    #[test]
    fn handles_a_session_without_events() {
        assert!(build_session_timeline(&session(), &[], 0).contains("(no events)"));
    }
}
