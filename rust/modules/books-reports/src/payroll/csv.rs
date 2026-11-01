//! CSV reading for payroll exports (`services/payroll/csv.ts`): an RFC 4180
//! parser (quoted fields, doubled quotes, CRLF, a BOM, comma / semicolon /
//! tab delimiters) and the money and date formats payroll reports use.

use weldsuite_books_domain::dates::{days_in_month, format_iso, is_iso_date};
use weldsuite_books_domain::jurisdictions::{is_js_space, js_trim};

/// `ParsedCsv`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedCsv {
    pub(crate) headers: Vec<String>,
    pub(crate) rows: Vec<Vec<String>>,
}

fn detect_delimiter(text: &str) -> char {
    // `text.split(/\r?\n/, 1)[0]`
    let first_line = text.split('\n').next().unwrap_or_default();
    let first_line = first_line.strip_suffix('\r').unwrap_or(first_line);
    let mut best = ',';
    let mut best_count = 0;
    for delimiter in [',', ';', '\t'] {
        let mut count = 0;
        let mut quoted = false;
        for c in first_line.chars() {
            if c == '"' {
                quoted = !quoted;
            } else if c == delimiter && !quoted {
                count += 1;
            }
        }
        if count > best_count {
            best = delimiter;
            best_count = count;
        }
    }
    best
}

/// `parseCsv(input)`.
pub(crate) fn parse_csv(input: &str) -> ParsedCsv {
    let text = input.strip_prefix('\u{feff}').unwrap_or(input);
    let delimiter = detect_delimiter(text);
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut record: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if quoted {
            if c == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    field.push('"');
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                field.push(c);
            }
            i += 1;
            continue;
        }
        if c == '"' && field.is_empty() {
            quoted = true;
        } else if c == delimiter {
            record.push(std::mem::take(&mut field));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            record.push(std::mem::take(&mut field));
            records.push(std::mem::take(&mut record));
        } else {
            field.push(c);
        }
        i += 1;
    }
    if !field.is_empty() || !record.is_empty() {
        record.push(field);
        records.push(record);
    }
    let mut non_empty = records
        .into_iter()
        .filter(|row| row.iter().any(|value| !js_trim(value).is_empty()));
    let headers = non_empty
        .next()
        .unwrap_or_default()
        .iter()
        .map(|h| js_trim(h).to_owned())
        .collect();
    ParsedCsv {
        headers,
        rows: non_empty.collect(),
    }
}

/// `columnIndex(headers, name)`: by header name, case and surrounding
/// spaces ignored; `None` is -1.
pub(crate) fn column_index(headers: &[String], name: Option<&str>) -> Option<usize> {
    let name = name.filter(|n| !n.is_empty())?;
    let wanted = js_trim(name).to_lowercase();
    headers
        .iter()
        .position(|h| js_trim(h).to_lowercase() == wanted)
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// `/^\d{1,3}(\.\d{3})+,\d{1,2}$/`
fn is_european_grouped(value: &str) -> bool {
    let Some((whole, cents)) = value.rsplit_once(',') else {
        return false;
    };
    if !all_digits(cents) || cents.len() > 2 {
        return false;
    }
    let mut groups = whole.split('.');
    let Some(first) = groups.next() else {
        return false;
    };
    let rest: Vec<&str> = groups.collect();
    all_digits(first)
        && first.len() <= 3
        && !rest.is_empty()
        && rest.iter().all(|g| g.len() == 3 && all_digits(g))
}

/// `/^\d+,\d{1,2}$/`
fn is_european_plain(value: &str) -> bool {
    value
        .split_once(',')
        .is_some_and(|(w, c)| all_digits(w) && all_digits(c) && c.len() <= 2)
}

/// `/^\d*\.?\d+$|^\d+\.$/`
fn is_amount(value: &str) -> bool {
    if let Some(whole) = value.strip_suffix('.')
        && all_digits(whole)
    {
        return true;
    }
    match value.split_once('.') {
        Some((whole, fraction)) => (whole.is_empty() || all_digits(whole)) && all_digits(fraction),
        None => all_digits(value),
    }
}

/// Strip `/^(USD|US\$|\$)\s*/i`.
fn strip_currency_prefix(value: &str) -> &str {
    let upper = value.to_ascii_uppercase();
    let len = if upper.starts_with("USD") || upper.starts_with("US$") {
        3
    } else if value.starts_with('$') {
        1
    } else {
        return value;
    };
    value[len..].trim_start_matches(is_js_space)
}

/// Strip `/\s*(USD)$/i`.
fn strip_currency_suffix(value: &str) -> &str {
    if value.len() >= 3 && value.is_char_boundary(value.len() - 3) {
        let (rest, tail) = value.split_at(value.len() - 3);
        if tail.eq_ignore_ascii_case("USD") {
            return rest.trim_end_matches(is_js_space);
        }
    }
    value
}

/// `parseMoney(raw)`: `1,234.56`, `$1,234.56`, `(1,234.56)`, `1234.56-`;
/// `1.234,56` read as European; empty or a dash is `None`; anything else
/// that isn't a number is an error (`RangeError`).
pub(crate) fn parse_money(raw: Option<&str>) -> Result<Option<f64>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let mut value = js_trim(raw).to_owned();
    if value.is_empty() || value == "-" || value == "--" {
        return Ok(None);
    }
    let mut negative = false;
    if value.len() >= 2
        && value.starts_with('(')
        && value.ends_with(')')
        && !value[1..value.len() - 1].chars().any(is_line_terminator)
    {
        negative = true;
        value = value[1..value.len() - 1].to_owned();
    }
    if let Some(stripped) = value.strip_suffix('-') {
        negative = true;
        value = stripped.to_owned();
    }
    if let Some(stripped) = value.strip_prefix('-') {
        negative = !negative;
        value = stripped.to_owned();
    }
    let without_plus = value.strip_prefix('+').unwrap_or(&value);
    let value = js_trim(strip_currency_suffix(strip_currency_prefix(without_plus))).to_owned();
    let value = if is_european_grouped(&value) {
        value.replace('.', "").replacen(',', ".", 1)
    } else if is_european_plain(&value) {
        value.replacen(',', ".", 1)
    } else {
        value.replace(',', "")
    };
    if !is_amount(&value) {
        return Err(format!("\"{raw}\" is not an amount"));
    }
    let number = weldsuite_kit::validation::js_number(&value);
    let amount = weldsuite_books_domain::js::math_round(number * 100.0) / 100.0;
    Ok(Some(if negative { -amount } else { amount }))
}

/// `DateFormat`: `auto`, `mdy`, `dmy` or `iso`.
fn build(year: i64, month: i64, day: i64) -> Option<String> {
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    Some(format_iso(year, month, day))
}

fn digits_between(text: &str, min: usize, max: usize) -> Option<i64> {
    (text.len() >= min && text.len() <= max && all_digits(text))
        .then(|| text.parse().ok())
        .flatten()
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// `parseDate(raw, format)`: `YYYY-MM-DD`, or `None` when not a date. Slash
/// dates are month first unless `format` is `dmy`.
pub(crate) fn parse_date(raw: Option<&str>, format: &str) -> Option<String> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let value = js_trim(raw);
    // /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/
    let bytes = value.as_bytes();
    if bytes.len() >= 10
        && value.is_char_boundary(10)
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && all_digits(&value[0..4])
        && all_digits(&value[5..7])
        && all_digits(&value[8..10])
    {
        let rest = &value[10..];
        let tail_ok = rest.is_empty()
            || ((rest.starts_with('T') || rest.starts_with(' '))
                && !rest[1..].chars().any(is_line_terminator));
        if tail_ok {
            let day = &value[0..10];
            return is_iso_date(day).then(|| day.to_owned());
        }
    }
    // /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/
    let parts: Vec<&str> = value.split(['/', '.']).collect();
    if parts.len() == 3
        && let (Some(y), Some(m), Some(d)) = (
            digits_between(parts[0], 4, 4),
            digits_between(parts[1], 1, 2),
            digits_between(parts[2], 1, 2),
        )
    {
        return build(y, m, d);
    }
    // /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/
    let parts: Vec<&str> = value.split(['/', '.', '-']).collect();
    if parts.len() == 3
        && let (Some(first), Some(second), Some(year)) = (
            digits_between(parts[0], 1, 2),
            digits_between(parts[1], 1, 2),
            digits_between(parts[2], 2, 4).filter(|_| parts[2].len() != 3),
        )
    {
        let year = if year < 100 { 2000 + year } else { year };
        return if format == "dmy" {
            build(year, second, first)
        } else {
            build(year, first, second)
        };
    }
    // /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/
    let (name, rest) = value.split_once(' ')?;
    let name = name.strip_suffix('.').unwrap_or(name);
    if !(3..=9).contains(&name.len()) || !name.bytes().all(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    let (day, year) = rest.split_once(' ')?;
    let day = day.strip_suffix(',').unwrap_or(day);
    let day = digits_between(day, 1, 2)?;
    let year = digits_between(year, 4, 4)?;
    let month = MONTHS
        .iter()
        .position(|m| *m == name[..3].to_ascii_lowercase())?;
    #[allow(clippy::cast_possible_wrap)]
    build(year, month as i64 + 1, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_fields_and_delimiters() {
        let parsed = parse_csv("\u{feff}a;b\r\n\"x;y\";\"say \"\"hi\"\"\"\r\n\r\n");
        assert_eq!(parsed.headers, ["a", "b"]);
        assert_eq!(
            parsed.rows,
            [vec!["x;y".to_owned(), "say \"hi\"".to_owned()]]
        );
    }

    #[test]
    fn money_formats() {
        assert_eq!(
            parse_money(Some("\"10,000.00\"".trim_matches('"'))),
            Ok(Some(10000.0))
        );
        assert_eq!(parse_money(Some("(1,234.56)")), Ok(Some(-1234.56)));
        assert_eq!(parse_money(Some("1.234,56")), Ok(Some(1234.56)));
        assert_eq!(parse_money(Some("$12.50-")), Ok(Some(-12.5)));
        assert_eq!(parse_money(Some(" - ")), Ok(None));
        assert!(parse_money(Some("abc")).is_err());
    }

    #[test]
    fn date_formats() {
        assert_eq!(
            parse_date(Some("01/15/2026"), "auto").as_deref(),
            Some("2026-01-15")
        );
        assert_eq!(
            parse_date(Some("15.01.26"), "dmy").as_deref(),
            Some("2026-01-15")
        );
        assert_eq!(
            parse_date(Some("2026-01-15T10:00"), "auto").as_deref(),
            Some("2026-01-15")
        );
        assert_eq!(
            parse_date(Some("2026/1/5"), "auto").as_deref(),
            Some("2026-01-05")
        );
        assert_eq!(
            parse_date(Some("Jan. 5, 2026"), "auto").as_deref(),
            Some("2026-01-05")
        );
        assert_eq!(parse_date(Some("02/30/2026"), "auto"), None);
    }
}
