//! `lib/rows.ts`: the events of one accepted batch as `events_v1` rows: the
//! clock corrected, the URLs cleaned, geo and device added from the request
//! (a mobile app's screen and device from its events' properties), and the
//! visitor id settled (ADR PANEL-006).

use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::url::{ExcludedPaths, Utm, parse_page_url, parse_referrer, slice_utf16};
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

/// Country, region and city of the request, from a proxy's geo headers
/// (`proxy::request_geo`); null without them (Global also reads
/// Cloudflare's `request.cf`, which nothing in front of this server sets).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
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

/// The columns that describe where an event happened: the page and the
/// browser for the web, the screen and the device for mobile.
struct Place {
    url: String,
    host: String,
    path: String,
    title: Option<String>,
    referrer: Option<String>,
    referrer_host: Option<String>,
    utm: Utm,
    device_type: Option<&'static str>,
    browser: Option<&'static str>,
    os: Option<&'static str>,
}

/// A web event's place: its cleaned URL (none for a non-http page) and the
/// request's user agent.
fn web_place(event: &WireEvent, user_agent: &ParsedUserAgent) -> Option<Place> {
    let page = parse_page_url(&event.url)?;
    let (referrer, referrer_host) = parse_referrer(event.referrer.as_deref());
    Some(Place {
        url: page.url,
        host: page.host,
        path: page.path,
        title: event.title.clone().filter(|title| !title.is_empty()),
        referrer,
        referrer_host,
        utm: page.utm,
        device_type: user_agent.device_type,
        browser: user_agent.browser,
        os: user_agent.os,
    })
}

const MAX_SCREEN: usize = 200;

/// The whitespace a screen name is trimmed of and its path collapses:
/// space, tab, line feed, carriage return, vertical tab and form feed.
const fn is_screen_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c')
}

/// `$app_id`: a bundle id or package name (`com.acme.shop`).
fn is_app_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=255).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `$os` as the user agent parser names it.
fn mobile_os(value: &str) -> Option<&'static str> {
    match value.to_lowercase().as_str() {
        "ios" | "ipados" => Some("iOS"),
        "android" => Some("Android"),
        "windows" => Some("Windows"),
        "macos" => Some("macOS"),
        _ => None,
    }
}

/// A mobile event's place, from the `$` properties the React Native SDK
/// sets: `app://<$app_id>/<$screen_name>` (whitespace runs as `-`), the
/// screen name as the title, `$os` and `$device_type`. Its wire `url` is not
/// read: an `app:` URL is no page.
fn mobile_place(event: &WireEvent) -> Place {
    let prop = |key: &str| match event
        .props
        .as_deref()
        .and_then(|props| props.iter().find(|(k, _)| k == key))
    {
        Some((_, Js::String(text))) => Some(text.as_str()),
        _ => None,
    };
    let app_id = prop("$app_id").filter(|id| is_app_id(id));
    let screen = prop("$screen_name")
        .map(|name| name.trim_matches(is_screen_space))
        .filter(|name| !name.is_empty());
    let path = screen.map_or_else(
        || "/".to_owned(),
        |name| {
            let mut part = String::with_capacity(name.len());
            let mut in_space = false;
            for c in name.chars() {
                if !is_screen_space(c) {
                    part.push(c);
                } else if !in_space {
                    part.push('-');
                }
                in_space = is_screen_space(c);
            }
            format!("/{}", slice_utf16(&part, MAX_SCREEN))
        },
    );
    Place {
        url: app_id.map_or_else(String::new, |id| format!("app://{id}{path}")),
        host: app_id.unwrap_or_default().to_owned(),
        path,
        title: screen.map_or_else(
            || event.title.clone().filter(|title| !title.is_empty()),
            |name| Some(slice_utf16(name, MAX_SCREEN)),
        ),
        referrer: None,
        referrer_host: None,
        utm: Utm::default(),
        device_type: prop("$device_type").and_then(|kind| match kind {
            "mobile" => Some("mobile"),
            "tablet" => Some("tablet"),
            _ => None,
        }),
        browser: None,
        os: prop("$os").and_then(mobile_os),
    }
}

/// `buildEventRows(source)`: one row per event; events on a non-http page,
/// on an excluded path, or that need a cookieless id when none was derived
/// are left out. A mobile batch's events take their place from their
/// properties ([`mobile_place`]).
pub(crate) fn build_event_rows(source: &RowSource<'_>) -> Vec<Value> {
    let excluded = ExcludedPaths::new(&source.record.setting_strings("excludedUrls"));
    let received_iso = iso_millis(source.received_at);
    let mobile = source.batch.lib == "mobile";
    let mut rows = Vec::new();
    for event in &source.batch.events {
        let place = if mobile {
            mobile_place(event)
        } else {
            let Some(place) = web_place(event, &source.user_agent) else {
                continue;
            };
            place
        };
        if excluded.matches(&place.path) {
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
            "url": place.url,
            "host": place.host,
            "path": place.path,
            "title": place.title,
            "referrer": place.referrer,
            "referrer_host": place.referrer_host,
            "utm_source": place.utm.source,
            "utm_medium": place.utm.medium,
            "utm_campaign": place.utm.campaign,
            "utm_content": place.utm.content,
            "utm_term": place.utm.term,
            "country": source.geo.country,
            "region": source.geo.region,
            "city": source.geo.city,
            "device_type": place.device_type,
            "browser": place.browser,
            "os": place.os,
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
        rows_with("web", consent, &json!({}), events)
    }

    /// The rows of a `lib` batch, from a project with `settings`, the
    /// request a Chrome on Windows with a geo.
    fn rows_with(lib: &str, consent: bool, settings: &Value, events: &Value) -> Vec<Value> {
        let body: Js = serde_json::from_value(json!({
            "token": "wpk_0123456789abcdef0123456789abcdef",
            "sent_at": "2026-10-27T12:00:00.000Z",
            "lib": lib,
            "lib_version": "0.1.0",
            "consent": consent,
            "events": events,
            "people": [{ "op": "set", "user_id": "u-1", "ts": "2026-10-27T12:00:00.000Z", "props": {} }],
        }))
        .expect("a body");
        let batch = crate::collector::wire::parse_event_batch(&body).expect("a batch");
        let record = ProjectRecord::parse(Some(
            &json!({ "v": 1, "projectId": "p", "workspaceId": "w", "status": "active",
                     "allowedDomains": [], "settings": settings })
            .to_string(),
        ))
        .expect("a record");
        build_event_rows(&RowSource {
            record: &record,
            batch: &batch,
            received_at: parse_millis("2026-10-27T12:00:00.000Z").expect("a date"),
            user_agent: ParsedUserAgent {
                device_type: Some("desktop"),
                browser: Some("Chrome"),
                os: Some("Windows"),
            },
            geo: Geo {
                country: Some("DE".to_owned()),
                region: None,
                city: Some("Berlin".to_owned()),
            },
            cookieless_id: Some("ck_cookieless".to_owned()),
        })
    }

    fn mobile_event(id: &str, name: &str, props: &Value) -> Value {
        json!({
            "event_id": id, "name": name, "ts": "2026-10-27T12:00:00.000Z",
            "url": "app://com.acme.shop/Product Detail", "title": "Own title",
            "referrer": "https://www.google.com/", "props": props,
        })
    }

    #[test]
    fn takes_a_mobile_event_s_place_from_its_properties() {
        let rows = rows_with(
            "mobile",
            false,
            &json!({}),
            &json!([
                mobile_event(
                    "evt-00000001",
                    "$screen",
                    &json!({
                        "$app_id": "com.acme.shop", "$screen_name": " Product \t\n Detail ",
                        "$os": "ios", "$device_type": "tablet", "$app_version": "2.1.0",
                    })
                ),
                mobile_event(
                    "evt-00000002",
                    "$app_opened",
                    &json!({
                        "$app_id": "com.acme.shop", "$os": "Android", "$device_type": "phone",
                    })
                ),
            ]),
        );
        assert_eq!(rows.len(), 2);
        let screen = &rows[0];
        assert_eq!(screen["host"], json!("com.acme.shop"));
        assert_eq!(screen["path"], json!("/Product-Detail"));
        assert_eq!(screen["url"], json!("app://com.acme.shop/Product-Detail"));
        assert_eq!(screen["title"], json!("Product \t\n Detail"));
        assert_eq!(screen["os"], json!("iOS"));
        assert_eq!(screen["device_type"], json!("tablet"));
        assert_eq!(screen["browser"], Value::Null);
        assert_eq!(screen["referrer"], Value::Null);
        assert_eq!(screen["referrer_host"], Value::Null);
        assert_eq!(screen["utm_source"], Value::Null);
        assert_eq!(screen["country"], json!("DE"));
        assert_eq!(screen["city"], json!("Berlin"));
        assert_eq!(screen["lib"], json!("mobile"));
        // Stored as sent (`json!` sorted the keys before the body was read).
        assert_eq!(
            screen["properties"],
            json!(
                "{\"$app_id\":\"com.acme.shop\",\"$app_version\":\"2.1.0\",\"$device_type\":\"tablet\",\"$os\":\"ios\",\"$screen_name\":\" Product \\t\\n Detail \"}"
            )
        );
        let opened = &rows[1];
        assert_eq!(opened["path"], json!("/"));
        assert_eq!(opened["url"], json!("app://com.acme.shop/"));
        assert_eq!(opened["title"], json!("Own title"));
        assert_eq!(opened["os"], json!("Android"));
        assert_eq!(opened["device_type"], Value::Null);
    }

    #[test]
    fn leaves_an_unusable_app_id_screen_or_os_out() {
        let rows = rows_with(
            "mobile",
            false,
            &json!({}),
            &json!([
                mobile_event(
                    "evt-00000001",
                    "$screen",
                    &json!({
                        "$app_id": ".acme", "$screen_name": " \u{0b}\u{0c} ", "$os": "linux",
                    })
                ),
                mobile_event(
                    "evt-00000002",
                    "$screen",
                    &json!({
                        "$app_id": 42, "$screen_name": "x".repeat(300), "$os": "IPADOS",
                        "$device_type": "mobile",
                    })
                ),
                mobile_event(
                    "evt-00000003",
                    "$screen",
                    &json!({
                        "$app_id": "a".repeat(256), "$screen_name": "\u{a0}Home\u{a0}", "$os": "macOS",
                    })
                ),
            ]),
        );
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["host"], json!(""));
        assert_eq!(rows[0]["url"], json!(""));
        assert_eq!(rows[0]["path"], json!("/"));
        assert_eq!(rows[0]["title"], json!("Own title"));
        assert_eq!(rows[0]["os"], Value::Null);
        assert_eq!(rows[1]["path"], json!(format!("/{}", "x".repeat(200))));
        assert_eq!(rows[1]["title"], json!("x".repeat(200)));
        assert_eq!(rows[1]["os"], json!("iOS"));
        assert_eq!(rows[1]["device_type"], json!("mobile"));
        // Only ASCII whitespace is trimmed.
        assert_eq!(rows[2]["host"], json!(""));
        assert_eq!(rows[2]["path"], json!("/\u{a0}Home\u{a0}"));
        assert_eq!(rows[2]["os"], json!("macOS"));
    }

    #[test]
    fn excludes_mobile_screens_by_their_path() {
        let rows = rows_with(
            "mobile",
            false,
            &json!({ "excludedUrls": ["/Settings*"] }),
            &json!([
                mobile_event(
                    "evt-00000001",
                    "$screen",
                    &json!({ "$app_id": "com.acme.shop", "$screen_name": "Settings Privacy" })
                ),
                mobile_event(
                    "evt-00000002",
                    "$screen",
                    &json!({ "$app_id": "com.acme.shop", "$screen_name": "Home" })
                ),
            ]),
        );
        let ids: Vec<&str> = rows
            .iter()
            .filter_map(|row| row["event_id"].as_str())
            .collect();
        assert_eq!(ids, ["evt-00000002"]);
    }

    #[test]
    fn reads_a_web_event_s_place_from_its_url_and_the_user_agent() {
        let rows = rows_with(
            "server",
            false,
            &json!({}),
            &json!([event(&json!({
                "url": "https://shop.example.com/a?utm_source=news#x", "title": "",
                "referrer": "https://www.google.com/?q=1",
                "props": { "$screen_name": "Ignored", "$os": "ios" },
            }))]),
        );
        assert_eq!(
            rows[0]["url"],
            json!("https://shop.example.com/a?utm_source=news")
        );
        assert_eq!(rows[0]["path"], json!("/a"));
        assert_eq!(rows[0]["title"], Value::Null);
        assert_eq!(rows[0]["utm_source"], json!("news"));
        assert_eq!(rows[0]["referrer_host"], json!("www.google.com"));
        assert_eq!(rows[0]["os"], json!("Windows"));
        assert_eq!(rows[0]["browser"], json!("Chrome"));
        assert_eq!(rows[0]["device_type"], json!("desktop"));
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
