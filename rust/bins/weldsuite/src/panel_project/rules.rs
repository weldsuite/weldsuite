//! The `PanelProject` Durable Object's rules
//! (`apps/workers/panel-ingest/src/durable-objects/panel-project.ts`) as
//! pure functions: what an operation does to a profile's properties, the
//! limits, the people and group cursors, the search pattern, the group type
//! slots and the live view's counts. The tenant tables, the applier and the
//! collector's caches all go through these, so the three agree with the
//! object and with each other.
//!
//! Lengths are JavaScript's (UTF-16 code units), as the object measures
//! them. Properties are a `serde_json::Map` (keys sorted), so the stored
//! text and the `people_v1` / `groups_v1` rows list keys in sorted order
//! where the object keeps insertion order; the keys and values are the same.

use std::collections::HashSet;
use std::fmt::Write as _;

use base64::Engine as _;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde_json::{Map, Value};
use weldsuite_panel::project_state::{GroupOp, LiveSession, PeopleOp, Properties};

const MINUTE_MS: i64 = 60 * 1000;
/// `perMinute` has one bucket per minute of the live window.
pub(crate) const LIVE_MINUTES: usize = 30;
/// The live view keeps and answers the sessions seen in the last 30 minutes
/// ([`LIVE_MINUTES`] minutes).
pub(crate) const LIVE_WINDOW_MS: i64 = 30 * MINUTE_MS;
/// `visitors` counts the visitors seen in the last five minutes.
pub(crate) const LIVE_RECENT_MS: i64 = 5 * MINUTE_MS;
/// At most this many sessions are kept per project (the newest).
pub(crate) const MAX_LIVE_SESSIONS: usize = 2000;
/// `live()` answers at most this many sessions.
pub(crate) const LIVE_SESSIONS_RETURNED: usize = 500;
/// A profile takes no new property past this many.
const MAX_PROFILE_PROPERTIES: usize = 200;
/// An operation that would make a profile's JSON longer than this is skipped.
pub(crate) const MAX_PROFILE_BYTES: usize = 32 * 1024;
const MAX_EMAIL: usize = 320;
const MAX_NAME: usize = 255;
/// The largest page of people or groups.
const MAX_PAGE: u32 = 200;
/// `findByEmail` answers at most this many profiles.
pub(crate) const FIND_BY_EMAIL_LIMIT: i64 = 50;
/// `MAX_GROUP_TYPES` (`@weldsuite/panel-domain/wire`).
pub(crate) const MAX_GROUP_TYPES: usize = 5;
/// `MAX_GROUP_KEY`.
const MAX_GROUP_KEY: usize = 255;
/// A key that would set a prototype instead of a property.
const FORBIDDEN_KEY: &str = "__proto__";
/// The largest integer a JavaScript number holds exactly, plus one.
const SAFE_INTEGER_LIMIT: f64 = 9_007_199_254_740_992.0;

/// What one operation does to a profile's or a group's properties.
#[derive(Debug, Clone, Copy)]
pub(crate) enum PropsOp<'a> {
    Set(&'a Properties),
    SetOnce(&'a Properties),
    Unset(&'a [String]),
    /// Numbers to add.
    Increment(&'a Map<String, Value>),
}

impl<'a> From<&'a PeopleOp> for PropsOp<'a> {
    fn from(op: &'a PeopleOp) -> Self {
        match op {
            PeopleOp::Set { props, .. } => Self::Set(props),
            PeopleOp::SetOnce { props, .. } => Self::SetOnce(props),
            PeopleOp::Unset { keys, .. } => Self::Unset(keys),
            PeopleOp::Increment { props, .. } => Self::Increment(props),
        }
    }
}

impl<'a> From<&'a GroupOp> for PropsOp<'a> {
    fn from(op: &'a GroupOp) -> Self {
        match op {
            GroupOp::Set { props, .. } => Self::Set(props),
            GroupOp::SetOnce { props, .. } => Self::SetOnce(props),
            GroupOp::Unset { keys, .. } => Self::Unset(keys),
        }
    }
}

/// A people operation's user id and time.
pub(crate) fn person_of(op: &PeopleOp) -> (&str, &str) {
    match op {
        PeopleOp::Set { user_id, ts, .. }
        | PeopleOp::SetOnce { user_id, ts, .. }
        | PeopleOp::Unset { user_id, ts, .. }
        | PeopleOp::Increment { user_id, ts, .. } => (user_id, ts),
    }
}

/// A group operation's type and key.
pub(crate) fn group_of(op: &GroupOp) -> (&str, &str) {
    match op {
        GroupOp::Set {
            group_type,
            group_key,
            ..
        }
        | GroupOp::SetOnce {
            group_type,
            group_key,
            ..
        }
        | GroupOp::Unset {
            group_type,
            group_key,
            ..
        } => (group_type, group_key),
    }
}

/// `applyOp`: one operation on `props`, in place.
pub(crate) fn apply_op(props: &mut Properties, op: PropsOp<'_>) {
    match op {
        PropsOp::Set(values) => {
            for (key, value) in values {
                assign(props, key, value.clone(), false);
            }
        }
        PropsOp::SetOnce(values) => {
            for (key, value) in values {
                assign(props, key, value.clone(), true);
            }
        }
        PropsOp::Unset(keys) => {
            for key in keys {
                props.remove(key);
            }
        }
        PropsOp::Increment(values) => {
            for (key, by) in values {
                // `Number.isFinite(by)`: a number (JSON numbers are finite).
                let Some(by) = by.as_f64().filter(|by| by.is_finite()) else {
                    continue;
                };
                if key == FORBIDDEN_KEY {
                    continue;
                }
                let current = props.get(key).and_then(Value::as_f64).unwrap_or(0.0);
                assign(props, key, js_number(current + by), false);
            }
        }
    }
}

fn assign(props: &mut Properties, key: &str, value: Value, only_if_missing: bool) {
    if key == FORBIDDEN_KEY {
        return;
    }
    let present = props.contains_key(key);
    if only_if_missing && present {
        return;
    }
    if !present && props.len() >= MAX_PROFILE_PROPERTIES {
        return;
    }
    if let Some(value) = normalise(key, value) {
        props.insert(key.to_owned(), value);
    }
}

/// `$email` is kept trimmed and lower-cased so lookups by email are exact;
/// anything else than a short string (or `null`) is dropped.
fn normalise(key: &str, value: Value) -> Option<Value> {
    let value = js_value(value);
    if key != "$email" {
        return Some(value);
    }
    match value {
        Value::Null => Some(Value::Null),
        Value::String(text) => {
            let email = js_trim(&text).to_lowercase();
            (!email.is_empty() && js_len(&email) <= MAX_EMAIL).then_some(Value::String(email))
        }
        _ => None,
    }
}

/// A number as JavaScript keeps it: a whole number is written without a
/// fraction (`3`, not `3.0`), and anything not finite is `null` (what
/// `JSON.stringify` makes of it).
pub(crate) fn js_number(number: f64) -> Value {
    if !number.is_finite() {
        return Value::Null;
    }
    #[allow(clippy::float_cmp, reason = "an exact test for a whole number")]
    if number.trunc() == number && number.abs() < SAFE_INTEGER_LIMIT {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a whole number below 2^53 fits"
        )]
        return Value::from(number as i64);
    }
    serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
}

fn js_value(value: Value) -> Value {
    match value {
        Value::Number(number) if number.is_f64() => number.as_f64().map_or(Value::Null, js_number),
        other => other,
    }
}

/// `emailOf`: the `$email` property when it is a non-empty string.
pub(crate) fn email_of(props: &Properties) -> Option<String> {
    props
        .get("$email")
        .and_then(Value::as_str)
        .filter(|email| !email.is_empty())
        .map(str::to_owned)
}

/// `nameOf`: the `$name` property's first 255 characters, when it is a
/// non-empty string.
pub(crate) fn name_of(props: &Properties) -> Option<String> {
    props
        .get("$name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(|name| js_slice(name, MAX_NAME).to_owned())
}

/// A new person's properties: `{ $created: ts }`.
pub(crate) fn created(ts: &str) -> Properties {
    Map::from_iter([("$created".to_owned(), Value::String(ts.to_owned()))])
}

/// `JSON.stringify(props)`.
pub(crate) fn props_text(props: &Properties) -> String {
    serde_json::to_string(props).unwrap_or_else(|_| "{}".to_owned())
}

/// `parseProps`: an object, or none when the text is not one.
pub(crate) fn parse_props(text: &str) -> Properties {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(props)) => props,
        _ => Map::new(),
    }
}

/// A string's length as JavaScript counts it (UTF-16 code units).
pub(crate) fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, n)` in UTF-16 code units (a pair it would split is left
/// out whole).
fn js_slice(text: &str, n: usize) -> &str {
    let mut units = 0;
    for (at, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > n {
            return &text[..at];
        }
    }
    text
}

/// `String.prototype.trim`: JavaScript's white space and line terminators.
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(|ch: char| {
        matches!(
            ch,
            '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200A}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202F}'
                    | '\u{205F}'
                    | '\u{3000}'
                    | '\u{FEFF}'
        )
    })
}

/// `escapeLike`: `\`, `%` and `_` taken literally.
fn escape_like(term: &str) -> String {
    let mut out = String::with_capacity(term.len());
    for ch in term.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// The `LIKE` pattern of a search (`%term%`, escaped), or none for no or a
/// blank search. Lower-cased in ASCII: the object's SQLite `LIKE` folds
/// ASCII case only, and the queries fold the column the same way.
pub(crate) fn search_pattern(search: Option<&str>) -> Option<String> {
    let search = js_trim(search?);
    if search.is_empty() {
        return None;
    }
    Some(format!("%{}%", escape_like(search)).to_ascii_lowercase())
}

/// `Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_PAGE)`.
pub(crate) fn page_limit(limit: u32) -> i64 {
    i64::from(limit.clamp(1, MAX_PAGE))
}

/// A page cursor: `btoa(encodeURIComponent(JSON.stringify([lastSeen, key])))`.
pub(crate) fn encode_cursor(last_seen: &str, key: &str) -> String {
    let json = serde_json::to_string(&[last_seen, key]).unwrap_or_default();
    base64::engine::general_purpose::STANDARD.encode(encode_uri_component(&json))
}

/// The `[lastSeen, key]` of a cursor, or none when it isn't one.
pub(crate) fn decode_cursor(cursor: Option<&str>) -> Option<(String, String)> {
    let cursor = cursor.filter(|cursor| !cursor.is_empty())?;
    let bytes = atob(cursor)?;
    // `atob` answers a binary string: one character per byte.
    let binary: String = bytes.iter().map(|&byte| char::from(byte)).collect();
    let text = decode_uri_component(&binary)?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let items = value.as_array()?;
    Some((
        items.first()?.as_str()?.to_owned(),
        items.get(1)?.as_str()?.to_owned(),
    ))
}

fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `decodeURIComponent`: none where it would throw (a bad escape, or bytes
/// that are not UTF-8).
fn decode_uri_component(text: &str) -> Option<String> {
    fn hex_byte(chars: &mut std::str::Chars<'_>) -> Option<u8> {
        let high = chars.next()?.to_digit(16)?;
        let low = chars.next()?.to_digit(16)?;
        u8::try_from(high * 16 + low).ok()
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            out.push(ch);
            continue;
        }
        let lead = hex_byte(&mut chars)?;
        let len = match lead {
            0x00..=0x7F => 1,
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => return None,
        };
        let mut bytes = vec![lead];
        for _ in 1..len {
            if chars.next()? != '%' {
                return None;
            }
            bytes.push(hex_byte(&mut chars)?);
        }
        out.push_str(std::str::from_utf8(&bytes).ok()?);
    }
    Some(out)
}

/// `atob`'s forgiving base64: white space ignored, padding optional.
fn atob(text: &str) -> Option<Vec<u8>> {
    let mut data: String = text
        .chars()
        .filter(|ch| !matches!(ch, '\t' | '\n' | '\u{C}' | '\r' | ' '))
        .collect();
    if data.len().is_multiple_of(4) {
        for _ in 0..2 {
            if data.ends_with('=') {
                data.pop();
            }
        }
    }
    if data.len() % 4 == 1 {
        return None;
    }
    let engine = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::RequireNone)
            .with_decode_allow_trailing_bits(true),
    );
    engine.decode(data).ok()
}

/// An ISO 8601 time in milliseconds since 1970.
pub(crate) fn iso_millis(text: &str) -> Option<i64> {
    let at =
        time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).ok()?;
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok()
}

/// Milliseconds since 1970 as the object writes times
/// (`new Date(ms).toISOString()`).
pub(crate) fn iso(ms: i64) -> String {
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    weldsuite_events::iso_timestamp(at)
}

/// Now, in milliseconds since 1970.
pub(crate) fn now_ms() -> i64 {
    i64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000)
        .unwrap_or_default()
}

/// The live view's counts (`PanelLiveCounts`), over every session kept in
/// the window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LiveCounts {
    /// Distinct visitors seen in the last five minutes.
    pub(crate) visitors: u64,
    /// Distinct visitors seen in the last 30 minutes.
    pub(crate) visitors_30m: u64,
    /// Distinct visitors in each of the last 30 minutes, oldest first.
    pub(crate) per_minute: Vec<u64>,
}

/// `liveCounts(rows, nowMs)` (`@weldsuite/panel-domain/project-object`):
/// the counts at `now_ms`. Bucket `i` of `per_minute` covers
/// `[now - (30 - i) min, now - (29 - i) min)`, and a session counts in it when
/// it started before the bucket's end and was last seen at or after its
/// start. A session whose `ts` is before the window (or not a time) counts
/// nowhere; one whose `startedAt` is not a time counts in `visitors` and
/// `visitors_30m` but in no minute.
pub(crate) fn live_counts(sessions: &[LiveSession], now_ms: i64) -> LiveCounts {
    let window_start = now_ms - LIVE_WINDOW_MS;
    let recent_start = now_ms - LIVE_RECENT_MS;
    let mut recent: HashSet<&str> = HashSet::new();
    let mut in_window: HashSet<&str> = HashSet::new();
    let mut minutes: Vec<HashSet<&str>> = vec![HashSet::new(); LIVE_MINUTES];
    for session in sessions {
        let Some(ts) = iso_millis(&session.touch.ts) else {
            continue;
        };
        if ts < window_start {
            continue;
        }
        let id = session.touch.distinct_id.as_str();
        in_window.insert(id);
        if ts >= recent_start {
            recent.insert(id);
        }
        let Some(started_at) = iso_millis(&session.started_at) else {
            continue;
        };
        // Bucket 0 starts where the window does.
        let mut bucket_start = window_start;
        for visitors in &mut minutes {
            let bucket_end = bucket_start + MINUTE_MS;
            if started_at < bucket_end && ts >= bucket_start {
                visitors.insert(id);
            }
            bucket_start = bucket_end;
        }
    }
    let count = |set: &HashSet<&str>| u64::try_from(set.len()).unwrap_or(u64::MAX);
    LiveCounts {
        visitors: count(&recent),
        visitors_30m: count(&in_window),
        per_minute: minutes.iter().map(count).collect(),
    }
}

/// `GROUP_TYPE`: `^[a-z][a-z0-9_]{0,31}$`.
pub(crate) fn valid_group_type(group_type: &str) -> bool {
    let mut bytes = group_type.bytes();
    bytes.next().is_some_and(|first| first.is_ascii_lowercase())
        && group_type.len() <= 32
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// `takeGroupTypes`: each valid type not taken gets a slot while fewer than
/// [`MAX_GROUP_TYPES`] are; true when any did.
pub(crate) fn take_group_types(current: &mut Vec<String>, types: &[String]) -> bool {
    let mut changed = false;
    for group_type in types {
        if current.contains(group_type)
            || current.len() >= MAX_GROUP_TYPES
            || !valid_group_type(group_type)
        {
            continue;
        }
        current.push(group_type.clone());
        changed = true;
    }
    changed
}

/// The operations' group types, each once, in the order they first appear.
pub(crate) fn op_group_types(ops: &[GroupOp]) -> Vec<String> {
    let mut types: Vec<String> = Vec::new();
    for op in ops {
        let (group_type, _) = group_of(op);
        if !types.iter().any(|known| known == group_type) {
            types.push(group_type.to_owned());
        }
    }
    types
}

/// Whether a group operation can apply with the project's `types`: its
/// type has a slot and its key is set and short enough. (Whether the
/// profile stays under [`MAX_PROFILE_BYTES`] only its properties tell.)
pub(crate) fn group_op_fits(op: &GroupOp, types: &[String]) -> bool {
    let (group_type, group_key) = group_of(op);
    types.iter().any(|known| known == group_type)
        && !group_key.is_empty()
        && js_len(group_key) <= MAX_GROUP_KEY
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use weldsuite_panel::project_state::LiveTouch;

    use super::*;

    fn props(value: Value) -> Properties {
        match value {
            Value::Object(map) => map,
            _ => panic!("an object"),
        }
    }

    /// The live view's "now" in the tests.
    fn live_now() -> i64 {
        iso_millis("2026-11-20T12:00:00.000Z").expect("a time")
    }

    /// A session of `distinct_id` that started `started_ago` ms before
    /// [`live_now`] and was last seen `last_ago` ms before it.
    fn seen(distinct_id: &str, started_ago: i64, last_ago: i64) -> LiveSession {
        let now = live_now();
        LiveSession {
            touch: LiveTouch {
                session_id: format!("s-{distinct_id}-{started_ago}"),
                distinct_id: distinct_id.to_owned(),
                path: "/".to_owned(),
                title: None,
                country: None,
                device_type: None,
                ts: iso(now - last_ago),
            },
            started_at: iso(now - started_ago),
            pageviews: 1,
        }
    }

    /// 30 zeros, plus one in each bucket listed (a bucket listed twice holds 2).
    fn minutes(buckets: &[usize]) -> Vec<u64> {
        let mut out = vec![0; LIVE_MINUTES];
        for &bucket in buckets {
            out[bucket] += 1;
        }
        out
    }

    fn counts(visitors: u64, visitors_30m: u64, per_minute: Vec<u64>) -> LiveCounts {
        LiveCounts {
            visitors,
            visitors_30m,
            per_minute,
        }
    }

    #[test]
    fn set_set_once_unset_and_increment_change_properties_as_the_object_does() {
        let mut p = created("2026-11-18T10:00:00.000Z");
        apply_op(
            &mut p,
            PropsOp::Set(&props(
                json!({ "plan": "pro", "$email": "  Ann@Example.COM ", "seats": 2.0 }),
            )),
        );
        assert_eq!(p["$email"], json!("ann@example.com"));
        assert_eq!(p["plan"], json!("pro"));
        // A whole number is written as JavaScript writes it.
        assert_eq!(
            props_text(&p),
            r#"{"$created":"2026-11-18T10:00:00.000Z","$email":"ann@example.com","plan":"pro","seats":2}"#
        );

        apply_op(
            &mut p,
            PropsOp::SetOnce(&props(json!({ "plan": "free", "source": "ads" }))),
        );
        assert_eq!(p["plan"], json!("pro"));
        assert_eq!(p["source"], json!("ads"));

        apply_op(
            &mut p,
            PropsOp::Increment(&props(json!({ "seats": 3, "logins": 1, "bad": "x" }))),
        );
        assert_eq!(p["seats"], json!(5));
        assert_eq!(p["logins"], json!(1));
        assert!(!p.contains_key("bad"));
        apply_op(&mut p, PropsOp::Increment(&props(json!({ "seats": 0.5 }))));
        assert_eq!(p["seats"], json!(5.5));

        apply_op(
            &mut p,
            PropsOp::Unset(&["plan".to_owned(), "missing".to_owned()]),
        );
        assert!(!p.contains_key("plan"));

        // A non-string email is dropped, null clears it, `__proto__` never lands.
        apply_op(
            &mut p,
            PropsOp::Set(&props(json!({ "$email": 5, "__proto__": "x" }))),
        );
        assert_eq!(p["$email"], json!("ann@example.com"));
        assert!(!p.contains_key("__proto__"));
        apply_op(&mut p, PropsOp::Set(&props(json!({ "$email": null }))));
        assert_eq!(p["$email"], Value::Null);
        assert_eq!(email_of(&p), None);
    }

    #[test]
    fn a_profile_takes_no_new_property_past_two_hundred() {
        let mut p = Map::new();
        let many: Properties = (0..250).map(|n| (format!("k{n:03}"), json!(n))).collect();
        apply_op(&mut p, PropsOp::Set(&many));
        assert_eq!(p.len(), 200);
        // An existing key still changes.
        apply_op(
            &mut p,
            PropsOp::Set(&props(json!({ "k000": "changed", "new": 1 }))),
        );
        assert_eq!(p["k000"], json!("changed"));
        assert!(!p.contains_key("new"));
    }

    #[test]
    fn names_and_emails_are_measured_in_utf16() {
        let long = "é".repeat(300);
        let p = props(json!({ "$name": long }));
        assert_eq!(js_len(&name_of(&p).expect("a name")), 255);
        // A pair the cut would split is left out whole.
        let emoji = format!("{}😀", "a".repeat(254));
        assert_eq!(
            name_of(&props(json!({ "$name": emoji })))
                .expect("a name")
                .len(),
            254
        );
        let mut p = Map::new();
        apply_op(
            &mut p,
            PropsOp::Set(&props(
                json!({ "$email": format!("{}@x.io", "a".repeat(400)) }),
            )),
        );
        assert!(!p.contains_key("$email"));
        assert_eq!(js_trim("\u{FEFF}\u{3000} a \n"), "a");
    }

    #[test]
    fn cursors_round_trip_and_read_what_the_object_wrote() {
        let cursor = encode_cursor("2026-11-18T10:00:00.000Z", "user 1/é");
        // `btoa(encodeURIComponent(JSON.stringify(["2026-11-18T10:00:00.000Z","user 1/é"])))`
        assert_eq!(
            cursor,
            "JTVCJTIyMjAyNi0xMS0xOFQxMCUzQTAwJTNBMDAuMDAwWiUyMiUyQyUyMnVzZXIlMjAxJTJGJUMzJUE5JTIyJTVE"
        );
        assert_eq!(
            decode_cursor(Some(&cursor)),
            Some(("2026-11-18T10:00:00.000Z".to_owned(), "user 1/é".to_owned()))
        );
        // Unpadded, or with white space, still reads.
        let trimmed = cursor.trim_end_matches('=');
        assert!(decode_cursor(Some(trimmed)).is_some());
        for bad in ["", "%%%", "bm90IGpzb24=", "WzFd", "JUU5"] {
            assert_eq!(decode_cursor(Some(bad)), None, "{bad}");
        }
        assert_eq!(decode_cursor(None), None);
    }

    #[test]
    fn searches_are_escaped_and_folded_in_ascii() {
        assert_eq!(search_pattern(None), None);
        assert_eq!(search_pattern(Some("   ")), None);
        assert_eq!(
            search_pattern(Some(" Ann_50%\\ ")).as_deref(),
            Some("%ann\\_50\\%\\\\%")
        );
        assert_eq!(page_limit(0), 1);
        assert_eq!(page_limit(50), 50);
        assert_eq!(page_limit(5000), 200);
    }

    #[test]
    fn group_types_take_free_slots_in_order() {
        assert!(valid_group_type("company"));
        assert!(valid_group_type("a1_b"));
        for bad in ["", "Company", "1co", "co-op", &"a".repeat(33)] {
            assert!(!valid_group_type(bad), "{bad}");
        }
        let mut current = vec!["company".to_owned()];
        let named: Vec<String> = ["company", "Bad", "team", "org", "a", "b", "c"]
            .iter()
            .map(|t| (*t).to_owned())
            .collect();
        assert!(take_group_types(&mut current, &named));
        assert_eq!(current, ["company", "team", "org", "a", "b"]);
        assert!(!take_group_types(&mut current, &named));
        let ops = vec![
            GroupOp::Set {
                group_type: "team".into(),
                group_key: "t1".into(),
                props: Map::new(),
            },
            GroupOp::Unset {
                group_type: "c".into(),
                group_key: "x".into(),
                keys: vec![],
            },
            GroupOp::Set {
                group_type: "team".into(),
                group_key: String::new(),
                props: Map::new(),
            },
        ];
        assert_eq!(op_group_types(&ops), ["team", "c"]);
        let fits: Vec<bool> = ops.iter().map(|op| group_op_fits(op, &current)).collect();
        assert_eq!(fits, [true, false, false]);
    }

    #[test]
    fn live_counts_count_a_visitor_once_per_minute_from_start_to_last_activity() {
        assert_eq!(live_counts(&[], live_now()), counts(0, 0, minutes(&[])));
        let sessions = [
            seen("a-1", 10 * MINUTE_MS, 15 * MINUTE_MS / 2),
            // The same visitor in another session, in a minute it already counts in.
            seen("a-1", 9 * MINUTE_MS, 9 * MINUTE_MS),
            seen("a-2", 30_000, 30_000),
            seen("a-3", 4 * MINUTE_MS, 2 * MINUTE_MS),
        ];
        assert_eq!(
            live_counts(&sessions, live_now()),
            counts(2, 3, minutes(&[20, 21, 22, 26, 27, 28, 29]))
        );
    }

    #[test]
    fn live_counts_include_a_bucket_start_and_exclude_its_end() {
        let now = live_now();
        // Started exactly when bucket 29 starts: in 29, not in 28.
        let one = live_counts(&[seen("a-1", MINUTE_MS, MINUTE_MS)], now);
        assert_eq!(one.per_minute, minutes(&[29]));
        // Last seen exactly when bucket 28 ends (= bucket 29 starts): in 29 too.
        let two = live_counts(&[seen("a-1", 2 * MINUTE_MS, MINUTE_MS)], now);
        assert_eq!(two.per_minute, minutes(&[28, 29]));
        // Starting right now is past the last bucket.
        assert_eq!(
            live_counts(&[seen("a-1", 0, 0)], now),
            counts(1, 1, minutes(&[]))
        );
    }

    #[test]
    fn live_counts_take_five_minutes_for_visitors_and_thirty_for_the_rest() {
        let now = live_now();
        let edge = live_counts(&[seen("a-1", 5 * MINUTE_MS, 5 * MINUTE_MS)], now);
        assert_eq!((edge.visitors, edge.visitors_30m), (1, 1));
        let past = live_counts(&[seen("a-1", 6 * MINUTE_MS, 5 * MINUTE_MS + 1)], now);
        assert_eq!((past.visitors, past.visitors_30m), (0, 1));
        assert_eq!(
            live_counts(&[seen("a-1", LIVE_WINDOW_MS, LIVE_WINDOW_MS)], now),
            counts(0, 1, minutes(&[0]))
        );
        // A session that started before the window counts from the first minute.
        let long = live_counts(&[seen("a-1", 45 * MINUTE_MS, 59 * MINUTE_MS / 2)], now);
        assert_eq!(long.per_minute, minutes(&[0]));
        let before = LIVE_WINDOW_MS + 1;
        assert_eq!(
            live_counts(&[seen("a-1", before, before)], now),
            counts(0, 0, minutes(&[]))
        );
    }

    #[test]
    fn live_counts_leave_out_what_is_not_a_time() {
        let now = live_now();
        let mut no_ts = seen("a-1", MINUTE_MS, MINUTE_MS);
        no_ts.touch.ts = "later".to_owned();
        assert_eq!(live_counts(&[no_ts], now), counts(0, 0, minutes(&[])));
        let mut no_start = seen("a-1", MINUTE_MS, MINUTE_MS);
        no_start.started_at = "earlier".to_owned();
        assert_eq!(live_counts(&[no_start], now), counts(1, 1, minutes(&[])));
    }
}
