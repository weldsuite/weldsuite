//! Raw event reads (`activity.ts`) for the places that show events as they
//! happened: a person's activity feed, a recording's timeline markers, the
//! lexicon's names. Like every statement they are built on
//! [`events_scope`].

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::context::PanelQueryContext;
use super::rows::{
    PanelError, PanelSqlExecutor, PanelSqlQuery, Row, Runner, to_iso, to_nullable_text, to_number,
    to_text,
};
use super::scope::{ScopeOptions, events_scope, people_latest};
use super::sql::{QueryResult, int, lit};
use super::time::{ResolvedRange, query_now, resolve_range};
use crate::js;
use crate::schemas::{DatePreset, DateRange};
use crate::wire::{CUSTOM_EVENT_NAME, PROPERTY_KEY};

/// What an activity read is for.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityOptions {
    /// One recording's events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// One person's events (user id or anonymous id).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distinct_id: Option<String>,
    /// Look back this many days (default 90), within the plan's retention.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub days: Option<i64>,
    /// Newest first.
    pub limit: i64,
    /// Leave out the noise a timeline does not need (`$pageleave`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude_names: Option<Vec<String>>,
}

const ACTIVITY_COLUMNS: [&str; 10] = [
    "event_id",
    "name",
    "ts",
    "path",
    "url",
    "title",
    "session_id",
    "el_text",
    "error_message",
    "properties",
];

fn window_for(ctx: &PanelQueryContext, days: Option<i64>) -> QueryResult<ResolvedRange> {
    let d = days.unwrap_or(90);
    let preset = if d <= 30 {
        DatePreset::Days30
    } else if d <= 90 {
        DatePreset::Days90
    } else {
        DatePreset::Months12
    };
    resolve_range(&DateRange::Preset { preset }, "UTC", ctx)
}

/// `activityQuery`.
pub fn activity_query(
    ctx: &PanelQueryContext,
    options: &ActivityOptions,
) -> QueryResult<PanelSqlQuery> {
    let range = window_for(ctx, options.days)?;
    let scope = events_scope(ctx, &range, range.bounds(), ScopeOptions::default())?;
    let mut extra = Vec::new();
    if let Some(session_id) = options.session_id.as_deref().filter(|s| !s.is_empty()) {
        extra.push(format!("e.session_id = {}", lit(session_id)?));
    }
    if let Some(distinct_id) = options.distinct_id.as_deref().filter(|d| !d.is_empty()) {
        extra.push(format!("{} = {}", scope.person, lit(distinct_id)?));
    }
    if let Some(names) = options.exclude_names.as_ref().filter(|n| !n.is_empty()) {
        let items = names
            .iter()
            .map(|n| lit(n))
            .collect::<QueryResult<Vec<_>>>()?;
        extra.push(format!("e.name NOT IN ({})", items.join(", ")));
    }
    let sql = format!(
        "SELECT e.event_id AS event_id, e.name AS name, e.ts AS ts, e.path AS path, e.url AS url, e.title AS title, e.session_id AS session_id, \
         e.el_text AS el_text, e.error_message AS error_message, e.properties AS properties \
         FROM {} {} ORDER BY e.ts DESC LIMIT {}",
        scope.from,
        scope.where_sql(&extra),
        int(options.limit, 2000)?
    );
    Ok(PanelSqlQuery::new(
        "activity.events",
        sql,
        &ACTIVITY_COLUMNS,
    ))
}

/// `activityCountQuery`: events a person has had in the window.
pub fn activity_count_query(
    ctx: &PanelQueryContext,
    distinct_id: &str,
    days: i64,
) -> QueryResult<PanelSqlQuery> {
    let range = window_for(ctx, Some(days))?;
    let scope = events_scope(ctx, &range, range.bounds(), ScopeOptions::default())?;
    let person_is = format!("{} = {}", scope.person, lit(distinct_id)?);
    Ok(PanelSqlQuery::new(
        "activity.count",
        format!(
            "SELECT COUNT(*) AS n FROM {} {}",
            scope.from,
            scope.where_sql(&[person_is])
        ),
        &["n"],
    ))
}

/// A scalar property value (`PanelPropertyScalar`).
pub type PropertyScalar = Value;

fn scalar_properties(raw: Option<&Value>) -> BTreeMap<String, PropertyScalar> {
    let Some(Value::String(text)) = raw else {
        return BTreeMap::new();
    };
    if text.is_empty() {
        return BTreeMap::new();
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(object)) => object
            .into_iter()
            .filter(|(_, v)| {
                matches!(
                    v,
                    Value::Null | Value::String(_) | Value::Number(_) | Value::Bool(_)
                )
            })
            .collect(),
        _ => BTreeMap::new(),
    }
}

/// `PanelActivityEvent`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelActivityEvent {
    pub event_id: String,
    pub name: String,
    pub ts: String,
    pub path: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub session_id: Option<String>,
    pub detail: Option<String>,
    pub properties: BTreeMap<String, PropertyScalar>,
}

/// `activityEventFrom`. `None` where JavaScript throws (a timestamp that is no date).
pub fn activity_event_from(row: &Row) -> Option<PanelActivityEvent> {
    Some(PanelActivityEvent {
        event_id: to_text(row.get("event_id")),
        name: to_text(row.get("name")),
        ts: to_iso(row.get("ts"))?,
        path: to_nullable_text(row.get("path")),
        url: to_nullable_text(row.get("url")),
        title: to_nullable_text(row.get("title")),
        session_id: to_nullable_text(row.get("session_id")),
        detail: to_nullable_text(row.get("error_message"))
            .or_else(|| to_nullable_text(row.get("el_text"))),
        properties: scalar_properties(row.get("properties")),
    })
}

// ---------------------------------------------------------------------------
// Lexicon: names seen in the data
// ---------------------------------------------------------------------------

/// An event name and how often it was seen.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LexiconEvent {
    pub name: String,
    pub count: f64,
}

/// `LexiconScan`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LexiconScan {
    pub events: Vec<LexiconEvent>,
    /// Property keys seen on events and on profiles.
    pub properties: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scanned_at: Option<String>,
}

const SEEN_DAYS: i64 = 30;
const MAX_PROPERTY_SAMPLES: i64 = 2000;

static LEXICON_SYSTEM_EVENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\$[a-z]{2,32}$").expect("a valid pattern"));

fn valid_key(key: &str) -> bool {
    PROPERTY_KEY.is_match(key.strip_prefix('$').unwrap_or(key))
}

/// `lexiconQueries`: event names with counts, the property bags of the most
/// common (event, properties) combinations, and the current profiles. Last 30 days.
pub fn lexicon_queries(ctx: &PanelQueryContext) -> QueryResult<Vec<PanelSqlQuery>> {
    let range = resolve_range(
        &DateRange::Preset {
            preset: DatePreset::Days30,
        },
        "UTC",
        ctx,
    )?;
    let scope = events_scope(ctx, &range, range.bounds(), ScopeOptions::default())?;
    let props_where = scope.where_sql(&["e.properties <> '{}'"]);
    Ok(vec![
        PanelSqlQuery::new(
            "lexicon.events",
            format!(
                "SELECT e.name AS name, COUNT(*) AS n FROM {} {} GROUP BY e.name ORDER BY COUNT(*) DESC LIMIT 500",
                scope.from,
                scope.where_base()
            ),
            &["name", "n"],
        ),
        PanelSqlQuery::new(
            "lexicon.eventProperties",
            format!(
                "SELECT e.properties AS properties, COUNT(*) AS n FROM {} {props_where} \
                 GROUP BY e.properties ORDER BY COUNT(*) DESC LIMIT {}",
                scope.from,
                int(MAX_PROPERTY_SAMPLES, MAX_PROPERTY_SAMPLES)?
            ),
            &["properties", "n"],
        ),
        PanelSqlQuery::new(
            "lexicon.personProperties",
            format!(
                "SELECT user_id, properties FROM {} AS latest LIMIT 1000",
                people_latest(ctx, &range)?
            ),
            &["user_id", "properties"],
        ),
    ])
}

/// `lexiconFromRows`.
pub fn lexicon_from_rows(
    event_rows: &[Row],
    property_rows: &[Row],
    person_rows: &[Row],
) -> LexiconScan {
    let events = event_rows
        .iter()
        .map(|r| LexiconEvent {
            name: to_text(r.get("name")),
            count: to_number(r.get("n")),
        })
        .filter(|e| {
            !e.name.is_empty()
                && (CUSTOM_EVENT_NAME.is_match(&e.name) || LEXICON_SYSTEM_EVENT.is_match(&e.name))
        })
        .collect();
    let mut keys: Vec<String> = Vec::new();
    for row in property_rows.iter().chain(person_rows) {
        for key in scalar_properties(row.get("properties")).into_keys() {
            if valid_key(&key) && !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    keys.sort_by(|a, b| js::locale_compare(a, b));
    LexiconScan {
        events,
        properties: keys,
        scanned_at: None,
    }
}

/// `lexiconWindowDays`.
pub fn lexicon_window_days() -> i64 {
    SEEN_DAYS
}

/// `runLexiconScan`: the lexicon scan through `runner`.
pub async fn run_lexicon_scan<E: PanelSqlExecutor + ?Sized>(
    ctx: &PanelQueryContext,
    runner: &Runner<'_, E>,
) -> Result<LexiconScan, PanelError> {
    let mut results = runner.run(&lexicon_queries(ctx)?).await?.into_iter();
    let events = results.next().unwrap_or_default();
    let event_props = results.next().unwrap_or_default();
    let people = results.next().unwrap_or_default();
    let mut scan = lexicon_from_rows(&events, &event_props, &people);
    scan.scanned_at = Some(js::iso_string(query_now(ctx)));
    Ok(scan)
}
