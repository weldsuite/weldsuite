//! Rows as Drizzle reads them (camelCase keys, `toISOString()` times), and
//! the helpers every service uses.

use serde_json::Value;
use weldsuite_db::{PgPool, js_row};

/// One row of a `select to_jsonb(t) …` query.
pub(crate) type Row = Value;

/// Every row of `sql`, a `select to_jsonb(<alias>) …` with its binds applied
/// by `bind`.
pub(crate) fn rows_of(values: Vec<Value>) -> Vec<Row> {
    values.into_iter().map(js_row).collect()
}

/// A text column of a row (`row.title`).
pub(crate) fn text<'a>(row: &'a Row, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// A nullable text column.
pub(crate) fn opt_text(row: &Row, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// A column as it is (`null` when missing).
pub(crate) fn col(row: &Row, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// An integer column.
pub(crate) fn int(row: &Row, key: &str) -> i64 {
    row.get(key).and_then(Value::as_i64).unwrap_or_default()
}

/// A boolean column.
pub(crate) fn flag(row: &Row, key: &str) -> bool {
    row.get(key).and_then(Value::as_bool).unwrap_or_default()
}

/// `likePattern(text)`: `%`, `_` and `\` escaped for an `ilike … escape '\'`.
pub(crate) fn like_pattern(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('%');
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// `isUniqueViolation(err)`.
pub(crate) fn is_unique_violation(error: &sqlx::Error) -> bool {
    weldsuite_db::is_unique_violation(error)
}

/// One row by a `select to_jsonb(t) … limit 1` query with one text bind.
pub(crate) async fn one_by_id(
    db: &PgPool,
    sql: &'static str,
    id: &str,
) -> Result<Option<Row>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(sql).bind(id).fetch_optional(db).await?;
    Ok(row.map(js_row))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_wildcards_and_the_escape_itself() {
        assert_eq!(like_pattern("50%_a\\b"), "%50\\%\\_a\\\\b%");
    }
}
