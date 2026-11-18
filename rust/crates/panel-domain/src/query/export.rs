//! Raw exports (`export.ts`, panel-api's export runner): one page of one
//! table for one time window, scoped like every other query. Windows are
//! half-open `[from, to)` on the table's time column (`received_at` for
//! events, `ts` for the others), at most an hour. Paging is keyset: rows are
//! ordered by the time column and a tie-break key, and the next page starts
//! after the last row of the previous one; the cursor keeps every
//! fractional digit the engine returned.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::context::{BASIN_NAMESPACE, PanelQueryContext};
use super::rows::{PanelSqlQuery, Row};
use super::scope::scope_conds;
use super::sql::{PanelQueryError, QueryResult, in_list, int, lit, num};
use crate::js;
use crate::tables;

/// The tables an export reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PanelExportTableName {
    Events,
    People,
    Groups,
    Identities,
}

impl PanelExportTableName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Events => "events",
            Self::People => "people",
            Self::Groups => "groups",
            Self::Identities => "identities",
        }
    }
}

/// `PANEL_EXPORT_TABLE_NAMES`.
pub const PANEL_EXPORT_TABLE_NAMES: [PanelExportTableName; 4] = [
    PanelExportTableName::Events,
    PanelExportTableName::People,
    PanelExportTableName::Groups,
    PanelExportTableName::Identities,
];

/// Rows per page, well inside Basin SQL's 10,000-row `LIMIT` ceiling.
pub const PANEL_EXPORT_PAGE_SIZE: i64 = 5000;

/// Longest window one statement reads.
pub const PANEL_EXPORT_MAX_WINDOW_MS: i64 = 3_600_000;

const MAX_ERASED_IN_SQL: usize = 5000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyKind {
    Text,
    Number,
}

struct ExportTableDef {
    table: &'static str,
    /// The window's column.
    time: &'static str,
    /// Tie-break after the time column, in order.
    keys: &'static [(&'static str, KeyKind)],
    /// Columns written to the file, in this order.
    columns: &'static [&'static str],
    /// Expressions whose value must not be an erased id.
    erased: &'static [&'static str],
}

const EVENT_COLUMNS: [&str; 40] = [
    "event_id",
    "project_id",
    "name",
    "ts",
    "received_at",
    "distinct_id",
    "anon_id",
    "user_id",
    "session_id",
    "cookieless",
    "url",
    "host",
    "path",
    "title",
    "referrer",
    "referrer_host",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "country",
    "region",
    "city",
    "device_type",
    "browser",
    "os",
    "viewport_w",
    "el_tag",
    "el_selector",
    "el_text",
    "x",
    "y",
    "rel_x",
    "rel_y",
    "scroll_depth",
    "error_message",
    "properties",
    "lib",
    "lib_version",
];

fn def(table: PanelExportTableName) -> ExportTableDef {
    match table {
        PanelExportTableName::Events => ExportTableDef {
            table: tables::EVENTS,
            time: "received_at",
            keys: &[("event_id", KeyKind::Text)],
            columns: &EVENT_COLUMNS,
            erased: &["anon_id", "distinct_id", "COALESCE(user_id, '')"],
        },
        PanelExportTableName::People => ExportTableDef {
            table: tables::PEOPLE,
            time: "ts",
            keys: &[("user_id", KeyKind::Text), ("version", KeyKind::Number)],
            columns: &[
                "project_id",
                "user_id",
                "version",
                "ts",
                "properties",
                "deleted",
            ],
            erased: &["user_id"],
        },
        PanelExportTableName::Identities => ExportTableDef {
            table: tables::IDENTITIES,
            time: "ts",
            keys: &[("anon_id", KeyKind::Text), ("user_id", KeyKind::Text)],
            columns: &["project_id", "anon_id", "user_id", "ts"],
            erased: &["anon_id", "user_id"],
        },
        PanelExportTableName::Groups => ExportTableDef {
            table: tables::GROUPS,
            time: "ts",
            keys: &[
                ("group_type", KeyKind::Text),
                ("group_key", KeyKind::Text),
                ("version", KeyKind::Number),
            ],
            columns: &[
                "project_id",
                "group_type",
                "group_key",
                "version",
                "ts",
                "properties",
                "deleted",
            ],
            // A group is a company or an account, not a person: nothing to erase.
            erased: &[],
        },
    }
}

/// `exportColumns`: the columns a file of `table` has, in order.
pub fn export_columns(table: PanelExportTableName) -> &'static [&'static str] {
    def(table).columns
}

/// A cursor key: text or a number.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ExportKey {
    Text(String),
    Number(f64),
}

/// Where the next page starts: the last row's time (as the engine returned
/// it) and tie-break values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExportCursor {
    pub time: String,
    pub keys: Vec<ExportKey>,
}

static UTC_TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]([0-9]{2}:[0-9]{2}:[0-9]{2})(\.[0-9]{1,9})?(?:Z|[+-]00:?00)?$")
        .expect("a valid pattern")
});

/// `exactTimestamp` of a text: a UTC instant as a `TIMESTAMP` literal with
/// every fractional digit kept.
pub fn exact_timestamp(value: &str) -> QueryResult<String> {
    let caps = UTC_TIMESTAMP
        .captures(js::trim(value))
        .ok_or_else(|| PanelQueryError::new("Not a UTC timestamp"))?;
    let part = |i: usize| caps.get(i).map_or("", |m| m.as_str());
    Ok(format!("TIMESTAMP '{} {}{}'", part(1), part(2), part(3)))
}

/// `exactTimestamp` of a date (epoch milliseconds): three fractional digits.
pub fn exact_timestamp_millis(millis: i64) -> QueryResult<String> {
    exact_timestamp(&js::iso_string(millis))
}

fn key_literal(value: &ExportKey, kind: KeyKind) -> QueryResult<String> {
    match (kind, value) {
        (KeyKind::Number, ExportKey::Number(n)) => num(*n),
        (KeyKind::Number, ExportKey::Text(text)) => num(js::string_to_number(text)),
        (KeyKind::Text, ExportKey::Text(text)) => lit(text),
        (KeyKind::Text, ExportKey::Number(n)) => lit(&js::number_text(*n)),
    }
}

/// `(t > T) OR (t = T AND (k1 > a OR (k1 = a AND …)))`: strictly after the cursor.
fn after_cursor(def: &ExportTableDef, cursor: &ExportCursor) -> QueryResult<String> {
    if cursor.keys.len() != def.keys.len() {
        return Err(PanelQueryError::new("Malformed export cursor"));
    }
    let time = exact_timestamp(&cursor.time)?;
    let mut tail = String::new();
    for (i, (column, kind)) in def.keys.iter().enumerate().rev() {
        let value = key_literal(&cursor.keys[i], *kind)?;
        tail = if tail.is_empty() {
            format!("{column} > {value}")
        } else {
            format!("({column} > {value} OR ({column} = {value} AND {tail}))")
        };
    }
    Ok(format!(
        "({t} > {time} OR ({t} = {time} AND {tail}))",
        t = def.time
    ))
}

fn erased_conds(def: &ExportTableDef, ctx: &PanelQueryContext) -> QueryResult<Vec<String>> {
    let ids = js::distinct(ctx.erased_ids.iter().cloned());
    if ids.is_empty() || def.erased.is_empty() {
        return Ok(Vec::new());
    }
    if ids.len() > MAX_ERASED_IN_SQL {
        return Err(PanelQueryError::new(
            "Too many erasures are waiting to be applied; try again shortly",
        ));
    }
    let list = in_list(&ids)?;
    Ok(def
        .erased
        .iter()
        .map(|expr| format!("{expr} NOT IN {list}"))
        .collect())
}

/// One page to read.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportPageInput {
    pub table: PanelExportTableName,
    /// Window start (inclusive), epoch milliseconds.
    pub from: i64,
    /// Window end (exclusive), at most an hour after `from`.
    pub to: i64,
    /// Start after this row (the previous page's last).
    pub after: Option<ExportCursor>,
    pub limit: Option<i64>,
}

/// `exportPageQuery`: one page of a table's rows in a window, scoped to the
/// context's workspace and project.
pub fn export_page_query(
    ctx: &PanelQueryContext,
    input: &ExportPageInput,
) -> QueryResult<PanelSqlQuery> {
    let def = def(input.table);
    let span = input.to - input.from;
    if span <= 0 || span > PANEL_EXPORT_MAX_WINDOW_MS {
        return Err(PanelQueryError::new("An export window is at most an hour"));
    }
    let mut conds = scope_conds(ctx, "")?;
    conds.push(format!(
        "{} >= {}",
        def.time,
        exact_timestamp_millis(input.from)?
    ));
    conds.push(format!(
        "{} < {}",
        def.time,
        exact_timestamp_millis(input.to)?
    ));
    conds.extend(erased_conds(&def, ctx)?);
    if let Some(after) = &input.after {
        conds.push(after_cursor(&def, after)?);
    }
    let limit = int(input.limit.unwrap_or(PANEL_EXPORT_PAGE_SIZE), 10_000)?;
    let order = std::iter::once(def.time)
        .chain(def.keys.iter().map(|(column, _)| *column))
        .map(|c| format!("{c} ASC"))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(PanelSqlQuery::new(
        format!("export_{}", input.table.as_str()),
        format!(
            "SELECT {} FROM {BASIN_NAMESPACE}.{} WHERE {} ORDER BY {order} LIMIT {limit}",
            def.columns.join(", "),
            def.table,
            conds.join(" AND ")
        ),
        def.columns,
    ))
}

fn time_text(time: Option<&Value>) -> String {
    match time {
        Some(Value::Number(n)) => js::iso_string(n.as_f64().unwrap_or(0.0).trunc() as i64),
        None | Some(Value::Null) => String::new(),
        Some(value) => js::value_text(value),
    }
}

/// `exportCursorOf`: the cursor after `row` (the last row of a page).
pub fn export_cursor_of(table: PanelExportTableName, row: &Row) -> ExportCursor {
    let def = def(table);
    ExportCursor {
        time: time_text(row.get(def.time)),
        keys: def
            .keys
            .iter()
            .map(|(column, kind)| {
                let value = row.get(*column);
                match kind {
                    KeyKind::Number => ExportKey::Number(match value {
                        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
                        Some(Value::Null) => 0.0,
                        Some(Value::String(text)) => js::string_to_number(text),
                        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
                        None | Some(_) => f64::NAN,
                    }),
                    KeyKind::Text => ExportKey::Text(match value {
                        None | Some(Value::Null) => String::new(),
                        Some(value) => js::value_text(value),
                    }),
                }
            })
            .collect(),
    }
}
