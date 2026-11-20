//! The seam between the compiler and the engine (`rows.ts`): an executor runs
//! SQL, the compiler only sees normalised rows (objects keyed by the aliases
//! it selected), and a runner runs a spec's statements a few at a time.

use std::future::Future;
use std::sync::Mutex;

use futures_util::stream::{self, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::sql::PanelQueryError;
use crate::js;

/// One SQL statement. `name` is for logs and test fakes; `columns` are the
/// aliases selected, in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelSqlQuery {
    pub name: String,
    pub sql: String,
    pub columns: Vec<String>,
}

impl PanelSqlQuery {
    pub(crate) fn new(name: impl Into<String>, sql: String, columns: &[&str]) -> Self {
        Self {
            name: name.into(),
            sql,
            columns: columns.iter().map(|c| (*c).to_owned()).collect(),
        }
    }
}

/// What the engine answered: rows as arrays (in `columns` order) or objects.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PanelSqlResult {
    pub rows: Vec<Value>,
    /// Bytes the engine scanned, when it says.
    pub bytes_scanned: Option<f64>,
}

/// An engine failure (the route answers 5xx).
pub type EngineError = Box<dyn std::error::Error + Send + Sync>;

/// What running a spec can fail with.
#[derive(Debug)]
pub enum PanelError {
    /// The compiler refused the spec (a 400 with the message).
    Query(PanelQueryError),
    /// The engine failed, or its answer could not be read.
    Engine(EngineError),
}

impl std::fmt::Display for PanelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Query(err) => err.fmt(f),
            Self::Engine(err) => err.fmt(f),
        }
    }
}

impl std::error::Error for PanelError {}

impl From<PanelQueryError> for PanelError {
    fn from(err: PanelQueryError) -> Self {
        Self::Query(err)
    }
}

/// Runs one SQL statement. A closure `Fn(PanelSqlQuery) -> impl Future`
/// is one; the DataFusion and Basin REST adapters implement it.
pub trait PanelSqlExecutor: Sync {
    fn execute(
        &self,
        query: PanelSqlQuery,
    ) -> impl Future<Output = Result<PanelSqlResult, EngineError>> + Send;
}

impl<F, Fut> PanelSqlExecutor for F
where
    F: Fn(PanelSqlQuery) -> Fut + Sync,
    Fut: Future<Output = Result<PanelSqlResult, EngineError>> + Send,
{
    fn execute(
        &self,
        query: PanelSqlQuery,
    ) -> impl Future<Output = Result<PanelSqlResult, EngineError>> + Send {
        self(query)
    }
}

/// A normalised row: the selected aliases. An absent key is JavaScript's
/// `undefined`, a JSON null its `null`.
pub type Row = Map<String, Value>;

/// `normalizeRows`: rows as objects keyed by `columns`, whether the engine
/// answered with arrays or objects (other-cased keys tolerated).
pub fn normalize_rows(rows: &[Value], columns: &[String]) -> Vec<Row> {
    rows.iter()
        .map(|raw| {
            let mut row = Row::new();
            match raw {
                Value::Array(items) => {
                    for (index, name) in columns.iter().enumerate() {
                        match items.get(index) {
                            Some(value) => {
                                row.insert(name.clone(), value.clone());
                            }
                            None => {
                                row.remove(name);
                            }
                        }
                    }
                }
                Value::Object(object) => {
                    for name in columns {
                        let value = object.get(name).or_else(|| {
                            let lower = name.to_lowercase();
                            object
                                .iter()
                                .filter(|(key, _)| key.to_lowercase() == lower)
                                .map(|(_, value)| value)
                                .next_back()
                        });
                        match value {
                            Some(value) => {
                                row.insert(name.clone(), value.clone());
                            }
                            None => {
                                row.remove(name);
                            }
                        }
                    }
                }
                _ => {}
            }
            row
        })
        .collect()
}

/// `toNumber`: a number from an engine value (numbers, numeric strings); 0
/// when it is none.
pub fn to_number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|n| n.is_finite()).unwrap_or(0.0),
        Some(Value::String(text)) if !js::trim(text).is_empty() => {
            let n = js::string_to_number(text);
            if n.is_finite() { n } else { 0.0 }
        }
        _ => 0.0,
    }
}

/// `toText`: `String(value)`, empty for null and undefined.
pub fn to_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js::value_text(value),
    }
}

/// `toNullableText`: `None` for null, undefined and `''`.
pub fn to_nullable_text(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(value) => Some(js::value_text(value)),
    }
}

/// `toIso`: an ISO 8601 string from an engine timestamp (text or epoch
/// millis). Text without a zone is UTC; text that is no date stays as it is.
/// `None` where JavaScript throws (`toISOString()` of an invalid date).
pub fn to_iso(value: Option<&Value>) -> Option<String> {
    if let Some(Value::Number(number)) = value {
        let millis = number.as_f64().unwrap_or(f64::NAN).trunc();
        if millis.is_nan() || millis.abs() > 8.64e15 {
            return None;
        }
        return Some(js::iso_string(millis as i64));
    }
    let text = to_text(value);
    if text.is_empty() {
        return Some(String::new());
    }
    let normalised = if has_zone(&text) {
        text.clone()
    } else {
        format!("{}Z", text.replacen(' ', "T", 1))
    };
    Some(js::parse_iso(&normalised).map_or(text, js::iso_string))
}

/// `/(?:Z|[+-]\d{2}:?\d{2})$/`.
fn has_zone(text: &str) -> bool {
    if text.ends_with('Z') {
        return true;
    }
    let bytes = text.as_bytes();
    let tail = |n: usize| bytes.len().checked_sub(n).map(|start| &bytes[start..]);
    let zone = |t: &[u8], colon: bool| {
        let digits = |range: &[u8]| range.iter().all(u8::is_ascii_digit);
        matches!(t[0], b'+' | b'-')
            && if colon {
                digits(&t[1..3]) && t[3] == b':' && digits(&t[4..6])
            } else {
                digits(&t[1..5])
            }
    };
    tail(6).is_some_and(|t| zone(t, true)) || tail(5).is_some_and(|t| zone(t, false))
}

/// How many statements run at once for one spec.
pub const QUERY_CONCURRENCY: usize = 6;

/// What one spec's run reports besides the result.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStats {
    pub queries: u64,
    pub bytes_scanned: Option<f64>,
}

/// `createRunner`: runs statements through the executor, at most
/// [`QUERY_CONCURRENCY`] at once, in order, and totals what they scanned.
pub struct Runner<'a, E: ?Sized> {
    executor: &'a E,
    stats: Mutex<RunStats>,
}

impl<'a, E: PanelSqlExecutor + ?Sized> Runner<'a, E> {
    pub fn new(executor: &'a E) -> Self {
        Self {
            executor,
            stats: Mutex::new(RunStats::default()),
        }
    }

    /// The statements so far and the bytes they scanned.
    pub fn stats(&self) -> RunStats {
        *self
            .stats
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Runs `queries` (sent in order) and answers their rows in order.
    pub async fn run(&self, queries: &[PanelSqlQuery]) -> Result<Vec<Vec<Row>>, PanelError> {
        stream::iter(queries.iter().cloned())
            .map(|query| {
                let columns = query.columns.clone();
                // Sent now, in order, like the TypeScript's workers.
                let pending = self.executor.execute(query);
                async move {
                    let result = pending.await.map_err(PanelError::Engine)?;
                    {
                        let mut stats = self
                            .stats
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        stats.queries += 1;
                        if let Some(bytes) = result.bytes_scanned {
                            stats.bytes_scanned = Some(stats.bytes_scanned.unwrap_or(0.0) + bytes);
                        }
                    }
                    Ok(normalize_rows(&result.rows, &columns))
                }
            })
            .buffered(QUERY_CONCURRENCY)
            .try_collect()
            .await
    }

    /// Runs one statement and answers its rows.
    pub async fn run_one(&self, query: PanelSqlQuery) -> Result<Vec<Row>, PanelError> {
        Ok(self
            .run(&[query])
            .await?
            .into_iter()
            .next()
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_positional_and_keyed_rows_alike() {
        let columns = vec!["n".to_owned(), "b".to_owned()];
        let rows = normalize_rows(&[json!([1, "a"]), json!({ "N": 2, "B": "b" })], &columns);
        assert_eq!(Value::Object(rows[0].clone()), json!({ "n": 1, "b": "a" }));
        assert_eq!(Value::Object(rows[1].clone()), json!({ "n": 2, "b": "b" }));
    }

    #[test]
    fn reads_numbers_text_and_instants_as_javascript() {
        assert_eq!(to_number(Some(&json!(" 12.5 "))), 12.5);
        assert_eq!(to_number(Some(&json!("12abc"))), 0.0);
        assert_eq!(to_number(Some(&json!("0x10"))), 16.0);
        assert_eq!(to_number(Some(&json!(true))), 0.0);
        assert_eq!(to_text(Some(&json!(1.5))), "1.5");
        assert_eq!(to_text(Some(&json!(null))), "");
        assert_eq!(to_nullable_text(Some(&json!(""))), None);
        assert_eq!(
            to_iso(Some(&json!("2026-11-14 10:00:00"))).as_deref(),
            Some("2026-11-14T10:00:00.000Z")
        );
        assert_eq!(
            to_iso(Some(&json!("2026-11-14T10:05:00+01:00"))).as_deref(),
            Some("2026-11-14T09:05:00.000Z")
        );
        assert_eq!(to_iso(Some(&json!("soon"))).as_deref(), Some("soon"));
        assert_eq!(
            to_iso(Some(&json!(0))).as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
    }
}
