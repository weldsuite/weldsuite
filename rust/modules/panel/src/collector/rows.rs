//! `lib/rows.ts`: the events of one accepted batch as `events_v1` rows: the
//! clock corrected, the URLs cleaned, geo and device added from the request,
//! and the visitor id settled (ADR PANEL-006).

use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::url::{ExcludedPaths, parse_page_url, parse_referrer};
use super::user_agent::ParsedUserAgent;
use super::visitor::COOKIELESS_PREFIX;
use super::wire::{EventBatch, WireEvent};
use crate::domain::ProjectRecord;
use crate::js::{Js, number_value, stringify};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_AGE_MS: i64 = 7 * DAY_MS;
const MAX_AHEAD_MS: i64 = 60 * 1000;

/// `Date.parse(text)` of a string `.datetime({ offset: true })` accepted:
/// milliseconds since the epoch (a longer fraction is cut to milliseconds).
pub(crate) fn parse_millis(text: &str) -> Option<i64> {
    // `+0200` → `+02:00`, which RFC 3339 needs.
    let normalized = match text.len().checked_sub(5) {
        Some(at)
            if text.is_char_boundary(at)
                && matches!(&text[at..=at], "+" | "-")
                && text[at + 1..].bytes().all(|b| b.is_ascii_digit()) =>
        {
            format!("{}{}:{}", &text[..at + 3], "", &text[at + 3..])
        }
        _ => text.to_owned(),
    };
    // RFC 3339 needs seconds; a datetime may leave them out (`T10:00Z`).
    let with_seconds = add_missing_seconds(&normalized);
    let at = OffsetDateTime::parse(&with_seconds, &Rfc3339).ok()?;
    let nanos = at.unix_timestamp_nanos();
    i64::try_from(nanos.div_euclid(1_000_000)).ok()
}

fn add_missing_seconds(text: &str) -> String {
    let Some(t) = text.find('T') else {
        return text.to_owned();
    };
    let time = &text[t + 1..];
    // `HH:MM` then the zone right away.
    if time.len() >= 5 && !matches!(time.as_bytes().get(5), Some(b':')) {
        return format!("{}:00{}", &text[..t + 6], &time[5..]);
    }
    text.to_owned()
}

/// `new Date(ms).toISOString()`.
pub(crate) fn iso_millis(ms: i64) -> String {
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH);
    weldsuite_events::iso_timestamp(at)
}

/// `correctTimestamp(ts, sentAt, receivedAt)`: the event time on the
/// server's clock, clamped to a sane window.
pub(crate) fn correct_timestamp(ts: &str, sent_at: &str, received_at: i64) -> Option<i64> {
    let corrected = parse_millis(ts)? + (received_at - parse_millis(sent_at)?);
    Some(corrected.clamp(received_at - MAX_AGE_MS, received_at + MAX_AHEAD_MS))
}

/// `consentedAnonId(batch, event)`: the browser's own id, usable only with
/// consent; the `ck_` prefix is ours.
pub(crate) fn consented_anon_id<'a>(batch: &EventBatch, event: &'a WireEvent) -> Option<&'a str> {
    let anon = event.anon_id.as_deref().filter(|id| !id.is_empty())?;
    (batch.consent && !anon.starts_with(COOKIELESS_PREFIX)).then_some(anon)
}

/// What a row is built from besides the batch.
pub(crate) struct RowSource<'a> {
    pub(crate) record: &'a ProjectRecord,
    pub(crate) batch: &'a EventBatch,
    pub(crate) received_at: i64,
    pub(crate) user_agent: ParsedUserAgent,
    pub(crate) geo: Geo,
    pub(crate) cookieless_id: Option<String>,
}

/// Country, region and city of the request. Cloudflare sets them on
/// Global; nothing in front of this server does, so they stay null.
#[derive(Debug, Clone, Default)]
pub(crate) struct Geo {
    pub(crate) country: Option<String>,
    pub(crate) region: Option<String>,
    pub(crate) city: Option<String>,
}

fn or_null(value: Option<&str>) -> Value {
    match value {
        Some(text) if !text.is_empty() => json!(text),
        _ => Value::Null,
    }
}

/// `buildEventRows(source)`: one row per event; events on a non-http page,
/// on an excluded path, or that need a cookieless id when none was derived
/// are left out.
pub(crate) fn build_event_rows(source: &RowSource<'_>) -> Vec<Value> {
    let excluded = ExcludedPaths::new(&source.record.setting_strings("excludedUrls"));
    let received_iso = iso_millis(source.received_at);
    let mut rows = Vec::new();
    for event in &source.batch.events {
        let Some(page) = parse_page_url(&event.url) else {
            continue;
        };
        if excluded.matches(&page.path) {
            continue;
        }
        let consented = consented_anon_id(source.batch, event);
        let Some(anon_id) = consented
            .map(str::to_owned)
            .or_else(|| source.cookieless_id.clone())
        else {
            continue;
        };
        let Some(ts) = correct_timestamp(&event.ts, &source.batch.sent_at, source.received_at)
        else {
            continue;
        };
        let (referrer, referrer_host) = parse_referrer(event.referrer.as_deref());
        let mut props: Vec<(String, Js)> = event.props.clone().unwrap_or_default();
        if let Some(el) = &event.el {
            props.retain(|(key, _)| key != "$action");
            props.push(("$action".to_owned(), Js::String(el.action.clone())));
        }
        let el = event.el.as_ref();
        // A user id is personal data like the anonymous id: only with consent
        // (and so only next to a consented id).
        let user_id = consented
            .and(event.user_id.as_deref())
            .filter(|id| !id.is_empty());
        rows.push(json!({
            "event_id": event.event_id,
            "workspace_id": source.record.workspace_id,
            "project_id": source.record.project_id,
            "name": event.name,
            "ts": iso_millis(ts),
            "received_at": received_iso,
            "distinct_id": user_id.map_or_else(|| anon_id.clone(), str::to_owned),
            "anon_id": anon_id,
            "user_id": user_id,
            "session_id": if consented.is_some() { or_null(event.session_id.as_deref()) } else { Value::Null },
            "cookieless": consented.is_none(),
            "url": page.url,
            "host": page.host,
            "path": page.path,
            "title": or_null(event.title.as_deref()),
            "referrer": referrer,
            "referrer_host": referrer_host,
            "utm_source": page.utm.source,
            "utm_medium": page.utm.medium,
            "utm_campaign": page.utm.campaign,
            "utm_content": page.utm.content,
            "utm_term": page.utm.term,
            "country": source.geo.country,
            "region": source.geo.region,
            "city": source.geo.city,
            "device_type": source.user_agent.device_type,
            "browser": source.user_agent.browser,
            "os": source.user_agent.os,
            "viewport_w": event.viewport_w,
            "el_tag": or_null(el.map(|el| el.tag.as_str())),
            "el_selector": or_null(el.map(|el| el.selector.as_str())),
            "el_text": or_null(el.and_then(|el| el.text.as_deref())),
            "x": event.x,
            "y": event.y,
            "rel_x": event.rel_x.map_or(Value::Null, number_value),
            "rel_y": event.rel_y.map_or(Value::Null, number_value),
            "scroll_depth": event.scroll_depth,
            "error_message": or_null(event.error_message.as_deref()),
            "properties": stringify(&Js::Object(props)),
            "lib": source.batch.lib,
            "lib_version": source.batch.lib_version,
        }));
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_datetimes_zod_accepts() {
        assert_eq!(parse_millis("1970-01-01T00:00:01.000Z"), Some(1000));
        assert_eq!(parse_millis("1970-01-01T01:00:01+01:00"), Some(1000));
        assert_eq!(parse_millis("1970-01-01T01:00:01+0100"), Some(1000));
        assert_eq!(parse_millis("1970-01-01T00:00:01.1239Z"), Some(1123));
        assert_eq!(parse_millis("1970-01-01T00:01Z"), Some(60_000));
    }

    #[test]
    fn corrects_and_clamps_the_clock() {
        let received = parse_millis("2026-10-27T12:00:00.000Z").expect("a date");
        let ts = correct_timestamp(
            "2026-10-27T11:00:00.000Z",
            "2026-10-27T11:00:05.000Z",
            received,
        )
        .expect("a time");
        assert_eq!(iso_millis(ts), "2026-10-27T11:59:55.000Z");
        let ahead = correct_timestamp("2030-01-01T00:00:00Z", "2026-10-27T12:00:00Z", received)
            .expect("a time");
        assert_eq!(ahead, received + MAX_AHEAD_MS);
    }

    fn rows_of(consent: bool, events: &Value) -> Vec<Value> {
        let body: Js = serde_json::from_value(json!({
            "token": "wpk_0123456789abcdef0123456789abcdef",
            "sent_at": "2026-10-27T12:00:00.000Z",
            "lib": "web",
            "lib_version": "0.1.0",
            "consent": consent,
            "events": events,
            "people": [{ "op": "set", "user_id": "u-1", "ts": "2026-10-27T12:00:00.000Z", "props": {} }],
        }))
        .expect("a body");
        let batch = crate::collector::wire::parse_event_batch(&body).expect("a batch");
        let record = ProjectRecord::parse(Some(
            &json!({ "v": 1, "projectId": "p", "workspaceId": "w", "status": "active",
                     "allowedDomains": [], "settings": {} })
            .to_string(),
        ))
        .expect("a record");
        build_event_rows(&RowSource {
            record: &record,
            batch: &batch,
            received_at: parse_millis("2026-10-27T12:00:00.000Z").expect("a date"),
            user_agent: ParsedUserAgent::default(),
            geo: Geo::default(),
            cookieless_id: Some("ck_cookieless".to_owned()),
        })
    }

    fn event(extra: &Value) -> Value {
        let mut event = json!({
            "event_id": "evt-00000001", "name": "$rageclick",
            "ts": "2026-10-27T12:00:00.000Z", "url": "https://shop.example.com/",
        });
        event
            .as_object_mut()
            .expect("an object")
            .extend(extra.as_object().expect("an object").clone());
        event
    }

    #[test]
    fn writes_user_id_click_position_and_error_message() {
        let rows = rows_of(
            true,
            &json!([event(&json!({
                "anon_id": "a-1", "user_id": "u-1", "rel_x": 0.25, "rel_y": 1,
                "error_message": "boom", "props": { "$source": "app.js" }
            }))]),
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["user_id"], json!("u-1"));
        assert_eq!(rows[0]["distinct_id"], json!("u-1"));
        assert_eq!(rows[0]["anon_id"], json!("a-1"));
        assert_eq!(rows[0]["rel_x"], json!(0.25));
        assert_eq!(rows[0]["rel_y"], json!(1));
        assert_eq!(rows[0]["error_message"], json!("boom"));
        assert_eq!(rows[0]["properties"], json!("{\"$source\":\"app.js\"}"));
    }

    #[test]
    fn leaves_the_user_id_out_without_consent() {
        let rows = rows_of(
            false,
            &json!([event(&json!({ "anon_id": "a-1", "user_id": "u-1" }))]),
        );
        assert_eq!(rows[0]["user_id"], Value::Null);
        assert_eq!(rows[0]["distinct_id"], json!("ck_cookieless"));
        assert_eq!(rows[0]["rel_x"], Value::Null);
        assert_eq!(rows[0]["error_message"], Value::Null);
    }

    #[test]
    fn drops_events_with_a_bad_user_id_or_click_position() {
        let rows = rows_of(
            true,
            &json!([
                event(&json!({ "event_id": "evt-00000001", "user_id": "" })),
                event(&json!({ "event_id": "evt-00000002", "user_id": "a\nb" })),
                event(&json!({ "event_id": "evt-00000003", "rel_x": 1.5 })),
                event(&json!({ "event_id": "evt-00000004", "props": { "$action": "x" } })),
                event(&json!({ "event_id": "evt-00000005", "user_id": "ok", "anon_id": "a-1" })),
            ]),
        );
        let ids: Vec<&str> = rows
            .iter()
            .filter_map(|row| row["event_id"].as_str())
            .collect();
        assert_eq!(ids, ["evt-00000005"]);
    }
}
