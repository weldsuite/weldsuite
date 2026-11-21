//! JavaScript semantics the TypeScript compiler depends on: how numbers print
//! (`String(n)`, `toPrecision`, `toFixed`), `Math.round`, `Number(text)`,
//! `String(value)`, `trim()`, UTF-16 lengths and order, `Date` arithmetic in
//! epoch milliseconds (`Date.UTC`, `toISOString`, ISO parsing), the `Intl`
//! time zone offsets and `localeCompare`.

use std::cmp::Ordering;

use serde_json::Value;

/// Milliseconds in a day.
pub const DAY_MS: i64 = 86_400_000;

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/// `String(number)`: the shortest digits that read back as `number`, plain
/// from 1e-6 to 1e21 and in exponent form (`1e+21`, `1.5e-7`) outside.
pub fn number_text(number: f64) -> String {
    if number.is_nan() {
        return "NaN".to_owned();
    }
    if number == 0.0 {
        return "0".to_owned();
    }
    if number.is_infinite() {
        return if number > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .to_owned();
    }
    let sign = if number < 0.0 { "-" } else { "" };
    // Rust's `{:e}` writes the shortest round-trip digits, as JavaScript picks them.
    let scientific = format!("{:e}", number.abs());
    let (mantissa, exponent) = scientific
        .split_once('e')
        .unwrap_or((scientific.as_str(), "0"));
    let exponent: i64 = exponent.parse().unwrap_or(0);
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len() as i64;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e_text = if e >= 0 {
            format!("+{e}")
        } else {
            e.to_string()
        };
        if k == 1 {
            format!("{digits}e{e_text}")
        } else {
            format!("{}.{}e{e_text}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// The exact decimal digits of `|number|` (no point) and the exponent of the
/// first one, as `{:e}` with enough digits to be exact (a double has at most
/// 767 significant decimal digits).
fn exact_digits(number: f64) -> (Vec<u8>, i64) {
    let exact = format!("{:.780e}", number.abs());
    let (mantissa, exponent) = exact.split_once('e').unwrap_or((exact.as_str(), "0"));
    let digits = mantissa.bytes().filter(u8::is_ascii_digit).collect();
    (digits, exponent.parse().unwrap_or(0))
}

/// Adds one to the last of `digits` (decimal digits as ASCII); true when it
/// carried out of the first (`999` → `000`).
fn increment(digits: &mut [u8]) -> bool {
    for digit in digits.iter_mut().rev() {
        if *digit == b'9' {
            *digit = b'0';
        } else {
            *digit += 1;
            return false;
        }
    }
    true
}

/// `Number(number.toPrecision(precision))`: the exact value rounded to
/// `precision` significant digits, a tie going to the larger magnitude (as
/// JavaScript picks the larger `n`), read back as a double.
pub fn to_precision(number: f64, precision: usize) -> f64 {
    if !number.is_finite() || number == 0.0 || precision == 0 {
        return number;
    }
    let (digits, mut exponent) = exact_digits(number);
    let mut kept = digits[..precision].to_vec();
    if digits.get(precision).is_some_and(|d| *d >= b'5') && increment(&mut kept) {
        kept.insert(0, b'1');
        kept.pop();
        exponent += 1;
    }
    let text = format!(
        "{}e{}",
        String::from_utf8_lossy(&kept),
        exponent - (precision as i64 - 1)
    );
    let value = text.parse::<f64>().unwrap_or(f64::NAN);
    if number < 0.0 { -value } else { value }
}

/// `number.toFixed(digits)` for `|number| < 1e21`: the exact value rounded
/// half away from zero at `digits` places.
pub fn to_fixed(number: f64, digits: usize) -> String {
    if !number.is_finite() || number.abs() >= 1e21 {
        return number_text(number);
    }
    // A double below 1e21 has at most 1074 binary, so decimal, places.
    let exact = format!("{:.1100}", number.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut kept: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).collect();
    if fraction.as_bytes().get(digits).is_some_and(|d| *d >= b'5') && increment(&mut kept) {
        kept.insert(0, b'1');
    }
    let split = kept.len() - digits;
    let mut out = String::new();
    if number < 0.0 {
        out.push('-');
    }
    out.push_str(&String::from_utf8_lossy(&kept[..split]));
    if digits > 0 {
        out.push('.');
        out.push_str(&String::from_utf8_lossy(&kept[split..]));
    }
    out
}

/// `Math.round(number)`: halves go up.
pub fn math_round(number: f64) -> f64 {
    if !number.is_finite() {
        return number;
    }
    let floor = number.floor();
    if number - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// `10 ** exponent` for a whole exponent, correctly rounded.
pub fn pow10(exponent: f64) -> f64 {
    format!("1e{}", exponent as i64).parse().unwrap_or(f64::NAN)
}

/// JavaScript's `WhiteSpace` and `LineTerminator` (what `trim()` removes).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `text.trim()`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `Number(text)`: trimmed, empty is 0, a decimal literal, `0x`/`0o`/`0b`
/// digits or `Infinity`; anything else is NaN.
pub fn string_to_number(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = text.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            let mut value = 0.0;
            for c in digits.chars() {
                let Some(digit) = c.to_digit(radix) else {
                    return f64::NAN;
                };
                value = value * f64::from(radix) + f64::from(digit);
            }
            return value;
        }
    }
    let (negative, unsigned) = match text.as_bytes()[0] {
        b'-' => (true, &text[1..]),
        b'+' => (false, &text[1..]),
        _ => (false, text),
    };
    if unsigned == "Infinity" {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    if !is_decimal_literal(unsigned) {
        return f64::NAN;
    }
    let value = unsigned.parse::<f64>().unwrap_or(f64::NAN);
    if negative { -value } else { value }
}

/// `digits [. digits] [e [+-] digits]` or `. digits [...]`, with a digit
/// somewhere before the exponent (`StrUnsignedDecimalLiteral`).
fn is_decimal_literal(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut at = 0;
    let mut mantissa_digits = 0;
    while bytes.get(at).is_some_and(u8::is_ascii_digit) {
        at += 1;
        mantissa_digits += 1;
    }
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
            mantissa_digits += 1;
        }
    }
    if mantissa_digits == 0 {
        return false;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let start = at;
        while bytes.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == start {
            return false;
        }
    }
    at == bytes.len()
}

/// `String(value)` for a JSON value: arrays joined with `,` (null items
/// empty), objects `[object Object]`.
pub fn value_text(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_text(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => value_text(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// A JSON value with whole numbers written as integers, as `JSON.stringify`
/// writes them (`2`, not serde's `2.0`).
pub fn json_numbers(value: Value) -> Value {
    match value {
        Value::Number(number) if !number.is_i64() && !number.is_u64() => {
            let float = number.as_f64().unwrap_or(f64::NAN);
            if float.fract() == 0.0 && float.abs() < 9_007_199_254_740_992.0 {
                Value::from(float as i64)
            } else if float.is_finite() {
                Value::Number(number)
            } else {
                Value::Null
            }
        }
        Value::Array(items) => Value::Array(items.into_iter().map(json_numbers).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, json_numbers(v))).collect())
        }
        other => other,
    }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/// `text.length`: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `text.slice(start, end)` in UTF-16 units (a surrogate pair cut in half
/// becomes U+FFFD).
pub fn slice_utf16(text: &str, start: usize, end: usize) -> String {
    let mut out = String::new();
    let mut at = 0;
    for c in text.chars() {
        let width = c.len_utf16();
        let next = at + width;
        if next <= start {
            at = next;
            continue;
        }
        if at >= end {
            break;
        }
        if at >= start && next <= end {
            out.push(c);
        } else {
            out.push('\u{fffd}');
        }
        at = next;
    }
    out
}

/// How a bare `.sort()` and `<` order text: by UTF-16 code unit.
pub fn compare_text(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `a.localeCompare(b)`: ICU's root collation, as the runtime's default
/// locale sorts.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    use icu_collator::options::CollatorOptions;
    use icu_collator::{CollatorBorrowed, CollatorPreferences};
    static COLLATOR: std::sync::LazyLock<Option<CollatorBorrowed<'static>>> =
        std::sync::LazyLock::new(|| {
            CollatorBorrowed::try_new(CollatorPreferences::default(), CollatorOptions::default())
                .ok()
        });
    COLLATOR
        .as_ref()
        .map_or_else(|| a.cmp(b), |collator| collator.compare(a, b))
}

/// The items in first-seen order without repeats (`[...new Set(items)]`).
pub fn distinct<T: PartialEq + Clone>(items: impl IntoIterator<Item = T>) -> Vec<T> {
    let mut out: Vec<T> = Vec::new();
    for item in items {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Dates (epoch milliseconds, UTC)
// ---------------------------------------------------------------------------

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// `(year, month, day)` of a day count since 1970-01-01.
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `Date.UTC(year, month0, day)`: months and days past their end roll over.
pub fn date_utc(year: i64, month0: i64, day: i64) -> i64 {
    let year = year + month0.div_euclid(12);
    let month = month0.rem_euclid(12) + 1;
    (days_from_civil(year, month, 1) + day - 1) * DAY_MS
}

/// The UTC calendar fields of an instant (`getUTC…`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DateParts {
    pub year: i64,
    /// 1-12.
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub millis: i64,
    /// 0 is Sunday.
    pub weekday: i64,
}

/// The UTC calendar fields of `millis`.
pub fn date_parts(millis: i64) -> DateParts {
    let days = millis.div_euclid(DAY_MS);
    let in_day = millis.rem_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    DateParts {
        year,
        month,
        day,
        hour: in_day / 3_600_000,
        minute: in_day / 60_000 % 60,
        second: in_day / 1000 % 60,
        millis: in_day % 1000,
        weekday: (days + 4).rem_euclid(7),
    }
}

/// `new Date(millis).toISOString()`.
pub fn iso_string(millis: i64) -> String {
    let p = date_parts(millis);
    let year = if (0..=9999).contains(&p.year) {
        format!("{:04}", p.year)
    } else if p.year < 0 {
        format!("-{:06}", -p.year)
    } else {
        format!("+{:06}", p.year)
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        p.month, p.day, p.hour, p.minute, p.second, p.millis
    )
}

/// `toISOString().slice(0, 10)`: the UTC day (`YYYY-MM-DD`).
pub fn iso_day(millis: i64) -> String {
    iso_string(millis).chars().take(10).collect()
}

/// `new Date(text).getTime()` for the ISO 8601 forms JavaScript reads: a
/// date (`2026`, `2026-03`, `2026-03-04`, or a six-digit signed year),
/// optionally a time (`T`, `t` or a space; `HH:mm`, seconds, a fraction) and
/// an offset (`Z`, `±HH:mm`, `±HHmm`). A time without an offset is read as
/// UTC. Other forms (the engine's legacy parser) are `None`, an invalid date.
pub fn parse_iso(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let mut at = 0;
    let digits = |at: &mut usize, min: usize, max: usize| -> Option<i64> {
        let start = *at;
        while *at - start < max && bytes.get(*at).is_some_and(u8::is_ascii_digit) {
            *at += 1;
        }
        if *at - start < min {
            return None;
        }
        text[start..*at].parse().ok()
    };
    let year = match bytes.first() {
        Some(sign @ (b'+' | b'-')) => {
            at += 1;
            let value = digits(&mut at, 6, 6)?;
            if *sign == b'-' && value == 0 {
                return None;
            }
            if *sign == b'-' { -value } else { value }
        }
        _ => digits(&mut at, 4, 4)?,
    };
    let mut month = 1;
    let mut day = 1;
    if bytes.get(at) == Some(&b'-') {
        at += 1;
        month = digits(&mut at, 2, 2)?;
        if bytes.get(at) == Some(&b'-') {
            at += 1;
            day = digits(&mut at, 2, 2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut millis_of_day = 0;
    let mut offset_minutes = 0;
    if matches!(bytes.get(at), Some(b'T' | b't' | b' ')) {
        at += 1;
        let hour = digits(&mut at, 2, 2)?;
        if bytes.get(at) != Some(&b':') {
            return None;
        }
        at += 1;
        let minute = digits(&mut at, 2, 2)?;
        let mut second = 0;
        let mut millis = 0;
        if bytes.get(at) == Some(&b':') {
            at += 1;
            second = digits(&mut at, 2, 2)?;
            if bytes.get(at) == Some(&b'.') {
                at += 1;
                let start = at;
                while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                    at += 1;
                }
                if at == start {
                    return None;
                }
                let padded: String = text[start..at]
                    .chars()
                    .chain("000".chars())
                    .take(3)
                    .collect();
                millis = padded.parse::<i64>().ok()?;
            }
        }
        if hour > 24
            || minute > 59
            || second > 59
            || (hour == 24 && (minute, second, millis) != (0, 0, 0))
        {
            return None;
        }
        millis_of_day = ((hour * 60 + minute) * 60 + second) * 1000 + millis;
        match bytes.get(at) {
            Some(b'Z' | b'z') => at += 1,
            Some(sign @ (b'+' | b'-')) => {
                let negative = *sign == b'-';
                at += 1;
                let hours = digits(&mut at, 2, 2)?;
                if bytes.get(at) == Some(&b':') {
                    at += 1;
                }
                let minutes = digits(&mut at, 2, 2)?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                let total = hours * 60 + minutes;
                offset_minutes = if negative { -total } else { total };
            }
            _ => {}
        }
    }
    if at != bytes.len() {
        return None;
    }
    let days = days_from_civil(year, month, 1) + day - 1;
    let millis = days * DAY_MS + millis_of_day - offset_minutes * 60_000;
    // Past ±8.64e15 ms a JavaScript date is invalid.
    (millis.abs() <= 8_640_000_000_000_000).then_some(millis)
}

/// The milliseconds of a clock now.
pub fn now_millis() -> i64 {
    jiff::Timestamp::now().as_millisecond()
}

// ---------------------------------------------------------------------------
// Time zones (`Intl.DateTimeFormat`)
// ---------------------------------------------------------------------------

/// The IANA time zone `name` names, as `Intl.DateTimeFormat` accepts it
/// (case-insensitive); `None` when there is none.
pub fn time_zone(name: &str) -> Option<jiff::tz::TimeZone> {
    if name == "UTC" {
        return Some(jiff::tz::TimeZone::UTC);
    }
    jiff::tz::TimeZone::get(name).ok()
}

/// Seconds east of UTC that `zone` is at `millis`.
pub fn offset_seconds(zone: &jiff::tz::TimeZone, millis: i64) -> i64 {
    jiff::Timestamp::from_millisecond(millis)
        .map_or(0, |at| i64::from(zone.to_offset(at).seconds()))
}
