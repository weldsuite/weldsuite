//! Cursor-paged lists: the page size a route reads off `?limit=` and the
//! `limit + 1` probe that tells whether there is a next page.
//!
//! The TypeScript routes have no one shared pagination module; these are the
//! helpers several of them share. `parseLimit` exists in two flavours that
//! differ on `0` and negatives (raised to 1, or replaced by the fallback), so
//! both are here. A cursor that cannot be read is never an error in
//! TypeScript: the list starts from the first page.
//!
//! The usual list is keyset-paged newest first on `(created_at, id)`, and the
//! cursor is the id of the last row of the previous page (app-api's services,
//! `external-api/src/lib/list-helpers.ts`, `reach/src/list-query.ts`).

use crate::response::{List, Pagination};

/// Page size when `?limit=` is missing or unreadable (`parseLimit`'s default).
pub const DEFAULT_LIMIT: u32 = 25;
/// Largest page `?limit=` can ask for (`parseLimit`'s default `max`).
pub const MAX_LIMIT: u32 = 100;

/// `parseLimit(raw, fallback, max)` of `@weldsuite/db/lib/custom-objects` and
/// connect-api's `lib/query-params.ts`: `Number.parseInt(raw, 10)` clamped to
/// `1..=max`, so `?limit=0` and `?limit=-5` give 1. A missing or unreadable
/// value gives `fallback`, capped at `max` as connect-api does (the db helper
/// returns the fallback as is; every caller passes one below `max`).
///
/// `Number.parseInt` semantics hold: leading whitespace and a sign are
/// accepted, parsing stops at the first non-digit (`"12abc"` is 12, `"1e3"`
/// is 1), and a digit string too long for a double is `Infinity`, which falls
/// back.
pub fn parse_limit(raw: Option<&str>, fallback: u32, max: u32) -> u32 {
    match raw.map(js_parse_int) {
        Some(JsInt::Finite {
            below_one: true, ..
        }) => 1.min(max),
        Some(JsInt::Finite { value, .. }) => value.min(max),
        Some(JsInt::NotFinite) | None => fallback.min(max),
    }
}

/// `parseLimit` of `reach/src/list-query.ts` and flow-api's
/// `lib/query-params.ts`: like [`parse_limit`], except that a value below 1
/// (`?limit=0`, `?limit=-3`) gives `fallback` instead of 1.
pub fn parse_limit_or_fallback(raw: Option<&str>, fallback: u32, max: u32) -> u32 {
    match raw.map(js_parse_int) {
        Some(JsInt::Finite {
            below_one: false,
            value,
        }) => value.min(max),
        _ => fallback.min(max),
    }
}

/// `Number.parseInt(raw, 10)`, as much of it as a page size needs.
#[derive(Debug, PartialEq, Eq)]
enum JsInt {
    /// `NaN` (no digits) or `±Infinity` (more digits than a double holds).
    NotFinite,
    /// A finite value: whether it is below 1, else the value saturated at
    /// `u32::MAX`.
    Finite { below_one: bool, value: u32 },
}

fn js_parse_int(raw: &str) -> JsInt {
    let rest = raw.trim_start_matches(is_js_whitespace);
    let (negative, rest) = match rest.as_bytes().first() {
        Some(b'-') => (true, &rest[1..]),
        Some(b'+') => (false, &rest[1..]),
        _ => (false, rest),
    };
    let digits = &rest[..rest.bytes().take_while(u8::is_ascii_digit).count()];
    if digits.is_empty() {
        return JsInt::NotFinite;
    }
    // A double overflows to Infinity past ~1.8e308; parseInt does the same.
    if !digits.parse::<f64>().is_ok_and(f64::is_finite) {
        return JsInt::NotFinite;
    }
    let significant = digits.trim_start_matches('0');
    let value = significant
        .parse::<u32>()
        .unwrap_or(if significant.is_empty() { 0 } else { u32::MAX });
    JsInt::Finite {
        below_one: negative || value == 0,
        value,
    }
}

/// JavaScript's `WhiteSpace` and `LineTerminator`, which `parseInt` skips:
/// Unicode `White_Space` without U+0085, plus U+FEFF.
fn is_js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// A page cut from a `limit + 1` query (`pageOf` in `reach/src/list-query.ts`,
/// and the same few lines in `listWithCursor` and app-api's services).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page<T> {
    pub data: Vec<T>,
    pub has_more: bool,
    /// The id of the last row kept, when there is a next page.
    pub next_cursor: Option<String>,
}

impl<T> Page<T> {
    /// Trim the probe row of `rows` (fetched with `LIMIT limit + 1`) and point
    /// the cursor at the last row kept.
    pub fn of(mut rows: Vec<T>, limit: usize, id: impl Fn(&T) -> &str) -> Self {
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        let next_cursor = if has_more {
            rows.last().map(|row| id(row).to_owned())
        } else {
            None
        };
        Self {
            data: rows,
            has_more,
            next_cursor,
        }
    }

    /// Map the rows to their DTOs.
    pub fn map<U>(self, f: impl FnMut(T) -> U) -> Page<U> {
        Page {
            data: self.data.into_iter().map(f).collect(),
            has_more: self.has_more,
            next_cursor: self.next_cursor,
        }
    }

    /// The `{ data, pagination }` envelope (`pageResult` + `list`).
    pub fn into_list(self, total_count: u64) -> List<T> {
        List::new(
            self.data,
            Pagination::new(total_count, self.has_more, self.next_cursor),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // connect-api lib/query-params.test.ts
    #[test]
    fn falls_back_when_the_value_is_missing_empty_or_not_a_number() {
        for raw in [None, Some(""), Some("abc"), Some("NaN"), Some("   ")] {
            assert_eq!(parse_limit(raw, 25, 100), 25, "{raw:?}");
        }
    }

    #[test]
    fn clamps_to_one_through_max() {
        assert_eq!(parse_limit(Some("0"), 25, 100), 1);
        assert_eq!(parse_limit(Some("-5"), 25, 100), 1);
        assert_eq!(parse_limit(Some("-0"), 25, 100), 1);
        assert_eq!(parse_limit(Some("7"), 25, 100), 7);
        assert_eq!(parse_limit(Some("100000"), 25, 100), 100);
    }

    #[test]
    fn never_returns_more_than_max_even_for_the_fallback() {
        assert_eq!(parse_limit(None, 25, 10), 10);
    }

    #[test]
    fn reads_the_number_like_parse_int() {
        assert_eq!(parse_limit(Some(" \t\n7"), 25, 100), 7);
        assert_eq!(parse_limit(Some("\u{feff}8"), 25, 100), 8);
        assert_eq!(parse_limit(Some("\u{85}8"), 25, 100), 25);
        assert_eq!(parse_limit(Some("+9"), 25, 100), 9);
        assert_eq!(parse_limit(Some("12abc"), 25, 100), 12);
        assert_eq!(parse_limit(Some("1e3"), 25, 100), 1);
        assert_eq!(parse_limit(Some("12.9"), 25, 100), 12);
        assert_eq!(parse_limit(Some("0x10"), 25, 100), 1);
        assert_eq!(parse_limit(Some("007"), 25, 100), 7);
        assert_eq!(parse_limit(Some("- 5"), 25, 100), 25);
        assert_eq!(parse_limit(Some("99999999999999999999"), 25, 100), 100);
        // Past a double's range parseInt is Infinity, which is not finite.
        assert_eq!(parse_limit(Some(&"9".repeat(400)), 25, 100), 25);
        assert_eq!(
            parse_limit(Some(&format!("-{}", "9".repeat(400))), 25, 100),
            25
        );
    }

    // reach/src/list-query.test.ts
    #[test]
    fn the_fallback_flavour_defaults_caps_and_ignores_nonsense() {
        let parse = |raw| parse_limit_or_fallback(raw, DEFAULT_LIMIT, MAX_LIMIT);
        assert_eq!(parse(None), 25);
        assert_eq!(parse(Some("10")), 10);
        assert_eq!(parse(Some("500")), 100);
        assert_eq!(parse(Some("0")), 25);
        assert_eq!(parse(Some("-3")), 25);
        assert_eq!(parse(Some("abc")), 25);
        assert_eq!(parse(Some("")), 25);
    }

    #[derive(Debug, Clone, PartialEq)]
    struct Row {
        id: &'static str,
    }

    fn rows() -> Vec<Row> {
        vec![Row { id: "a" }, Row { id: "b" }, Row { id: "c" }]
    }

    // reach/src/list-query.test.ts: pageOf / pageResult
    #[test]
    fn page_trims_the_probe_row_and_points_the_cursor_at_the_last_row_kept() {
        assert_eq!(
            Page::of(rows(), 2, |r| r.id),
            Page {
                data: vec![Row { id: "a" }, Row { id: "b" }],
                has_more: true,
                next_cursor: Some("b".to_owned()),
            }
        );
        assert_eq!(
            Page::of(rows(), 3, |r| r.id),
            Page {
                data: rows(),
                has_more: false,
                next_cursor: None,
            }
        );
        // A zero limit keeps nothing and has no row to point at.
        assert_eq!(Page::of(rows(), 0, |r| r.id).next_cursor, None);
    }

    #[test]
    fn page_maps_rows_to_dtos_and_carries_the_total() {
        let list = Page::of(rows(), 2, |r| r.id)
            .map(|r| r.id.to_uppercase())
            .into_list(7);
        assert_eq!(list.data, ["A", "B"]);
        assert_eq!(
            list.pagination,
            Pagination::new(7, true, Some("b".to_owned()))
        );
    }
}
