//! Rows as Drizzle reads them (camelCase keys, `toISOString()` times), and
//! the helpers every service uses.

use sea_orm::{ColumnTrait, Condition, DbErr};
use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::js_date_parse;

/// One row as the services read it: an entity model serialized (its entity
/// writes the JSON Drizzle returned), or a `select to_jsonb(t) …` row.
pub(crate) type Row = Value;

/// Every row of `sql`, a `select to_jsonb(<alias>) …` with its binds applied
/// by `bind`.
pub(crate) fn rows_of(values: Vec<Value>) -> Vec<Row> {
    values.into_iter().map(js_row).collect()
}

/// A model as Drizzle returned its row: `serde_json::to_value(model)`, the
/// entity's serializers deciding the JSON.
pub(crate) fn json_row(value: serde_json::Result<Value>) -> Result<Row, DbErr> {
    value.map_err(|error| DbErr::Json(error.to_string()))
}

/// Models as Drizzle returned their rows ([`json_row`] each):
/// `json_rows(models.into_iter().map(serde_json::to_value))`.
pub(crate) fn json_rows<I>(values: I) -> Result<Vec<Row>, DbErr>
where
    I: IntoIterator<Item = serde_json::Result<Value>>,
{
    values.into_iter().map(json_row).collect()
}

/// A moment to the millisecond, as a JavaScript `Date` holds it.
pub(crate) fn millis(at: OffsetDateTime) -> OffsetDateTime {
    at.replace_millisecond(at.millisecond()).unwrap_or(at)
}

/// `new Date()`: its `toISOString()` (what `crate::now` gives) and the same
/// moment as a `timestamptz` column value, so a row and the event or answer
/// that names the time agree.
pub(crate) fn now_at() -> (String, OffsetDateTime) {
    let at = millis(OffsetDateTime::now_utc());
    (weldsuite_events::iso_timestamp(at), at)
}

/// An ISO time (`toISOString()`, as the services keep times) where the SQL
/// bound it as `$n::timestamptz`. One that is no time is a database error,
/// as Postgres refused it.
pub(crate) fn instant(iso: &str) -> Result<OffsetDateTime, DbErr> {
    #[allow(clippy::cast_possible_truncation)] // `Date.parse` gives whole milliseconds
    let at = js_date_parse(iso).and_then(|ms| {
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms as i64) * 1_000_000).ok()
    });
    at.ok_or_else(|| {
        DbErr::Type(format!(
            "invalid input syntax for type timestamp with time zone: \"{iso}\""
        ))
    })
}

/// [`instant`] of a nullable time.
pub(crate) fn instant_opt(iso: Option<&str>) -> Result<Option<OffsetDateTime>, DbErr> {
    iso.map(instant).transpose()
}

/// A `not null` time column given no valid time: Postgres refused the null.
pub(crate) fn required(at: Option<OffsetDateTime>, column: &str) -> Result<OffsetDateTime, DbErr> {
    at.ok_or_else(|| {
        DbErr::Type(format!(
            "null value in column \"{column}\" violates not-null constraint"
        ))
    })
}

/// A `YYYY-MM-DD` text where the SQL bound it as `$n::date`; one that is no
/// date is a database error, as Postgres refused it.
pub(crate) fn date(text: &str) -> Result<time::Date, DbErr> {
    time::Date::parse(text, time::macros::format_description!("[year]-[month]-[day]"))
        .map_err(|_| DbErr::Type(format!("invalid input syntax for type date: \"{text}\"")))
}

/// `case when $n::text is null then <column> is null else <column> = $n end`.
pub(crate) fn same_or_null<C: ColumnTrait>(column: C, value: Option<&str>) -> Condition {
    match value {
        Some(value) => Condition::all().add(column.eq(value)),
        None => Condition::all().add(column.is_null()),
    }
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

/// `ilike(column, likePattern(text))`: `<column> ilike $n escape '\'`.
pub(crate) fn ilike<C: ColumnTrait>(column: C, pattern: &str) -> sea_orm::sea_query::Expr {
    column.ilike(sea_orm::sea_query::LikeExpr::new(pattern).escape('\\'))
}

/// `isUniqueViolation(err)`, through a SeaORM error or an sqlx one.
pub(crate) fn is_unique_violation(error: &(dyn std::error::Error + 'static)) -> bool {
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

    #[test]
    fn reads_times_and_dates_as_postgres_did() {
        let at = instant("2026-11-05T10:20:00.123Z").map(weldsuite_events::iso_timestamp);
        assert_eq!(at.ok().as_deref(), Some("2026-11-05T10:20:00.123Z"));
        assert!(instant("not a time").is_err());
        assert!(date("2026-11-05").is_ok());
        assert!(date("2026-13-45").is_err());
    }
}
