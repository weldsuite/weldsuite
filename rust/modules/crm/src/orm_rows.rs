//! The SeaORM pieces the CRM routes share (ADR DATA-019): a keyset page's
//! cursor row, a Drizzle `toISOString()` as the `timestamp` it names, a
//! body's values by column as Drizzle's `insert().values()` and
//! `update().set()` wrote them (`jsonb_populate_record`, through
//! [`weldsuite_db::record::JsonTable`]), and a `timestamp` as Drizzle
//! returns it.

use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value};
use time::PrimitiveDateTime;
use weldsuite_crm_domain::Table;
use weldsuite_db::{PgPool, orm};

/// A keyset page's cursor: the row's timestamp to the millisecond, as
/// Drizzle reads it back and binds it (`date_trunc('milliseconds', …)`),
/// and its id.
pub(crate) type CursorRow = (PrimitiveDateTime, String);

/// `date_trunc('milliseconds', at)`.
pub(crate) fn millis(at: PrimitiveDateTime) -> PrimitiveDateTime {
    weldsuite_db::utc_timestamp(at.assume_utc())
}

/// The cursor row `cursor` of a table (deleted or not): its `at` column and
/// its id.
pub(crate) async fn cursor_row<E: EntityTrait>(
    db: &PgPool,
    at: E::Column,
    id: E::Column,
    cursor: &str,
) -> Result<Option<CursorRow>, DbErr> {
    let row: Option<(PrimitiveDateTime, String)> = E::find()
        .select_only()
        .column(at)
        .column(id)
        .filter(id.eq(cursor))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.map(|(at, id)| (millis(at), id)))
}

/// `at < cursor or (at = cursor and id < cursorId)`: past the cursor,
/// newest first.
pub(crate) fn before<C: ColumnTrait>(
    at: C,
    id: C,
    (cursor_at, cursor_id): &CursorRow,
) -> Condition {
    Condition::any().add(at.lt(*cursor_at)).add(
        Condition::all()
            .add(at.eq(*cursor_at))
            .add(id.lt(cursor_id.as_str())),
    )
}

/// `at > cursor or (at = cursor and id > cursorId)`: past the cursor,
/// oldest first.
pub(crate) fn after<C: ColumnTrait>(at: C, id: C, (cursor_at, cursor_id): &CursorRow) -> Condition {
    Condition::any().add(at.gt(*cursor_at)).add(
        Condition::all()
            .add(at.eq(*cursor_at))
            .add(id.gt(cursor_id.as_str())),
    )
}

/// `.limit(limit + 1)`, the page's probe; Postgres refuses a negative
/// `LIMIT` (the route's 500).
pub(crate) fn probe_limit(limit: i64) -> Result<u64, DbErr> {
    u64::try_from(limit.saturating_add(1))
        .map_err(|_| DbErr::Custom("LIMIT must not be negative".to_owned()))
}

/// `$n::timestamp` of a `toISOString()` the route wrote: its UTC wall
/// clock. A text Postgres can't read is the failed cast (the route's 500).
pub(crate) fn timestamp_of(iso: &str) -> Result<PrimitiveDateTime, DbErr> {
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    PrimitiveDateTime::parse(iso, format).map_err(|_| {
        DbErr::Type(format!(
            "invalid input syntax for type timestamp: \"{iso}\""
        ))
    })
}

/// `insert().values(values)` as `insert_sql!` wrote it: every column of the
/// Drizzle table by name, the ones `values` leaves out as their literal
/// default or `null`.
pub(crate) fn insert_values(table: &Table, values: &Map<String, Value>) -> Map<String, Value> {
    let given = match table.values(values) {
        Value::Object(given) => given,
        _ => Map::new(),
    };
    table
        .columns
        .iter()
        .map(|(_, column)| {
            let value = given.get(*column).cloned().unwrap_or(Value::Null);
            ((*column).to_owned(), value)
        })
        .collect()
}

/// `update().set(values)`: the values by column, keys the table doesn't
/// have dropped.
pub(crate) fn set_values(table: &Table, values: &Map<String, Value>) -> Map<String, Value> {
    match table.set(values) {
        Value::Object(set) => set,
        _ => Map::new(),
    }
}

/// A `timestamp` as Drizzle returns it: `toISOString()`.
pub(crate) fn js_date(at: PrimitiveDateTime) -> Value {
    weldsuite_schema::js::timestamp::serialize(&at, serde_json::value::Serializer)
        .unwrap_or(Value::Null)
}

/// A nullable `timestamp` as Drizzle returns it.
pub(crate) fn js_date_or_null(at: Option<PrimitiveDateTime>) -> Value {
    at.map_or(Value::Null, js_date)
}

/// A model as the route returns it (`serde_json::to_value(model)`); one
/// that would not serialize is the query's failure.
pub(crate) fn json(model: Result<Value, serde_json::Error>) -> Result<Value, DbErr> {
    model.map_err(|error| DbErr::Json(error.to_string()))
}
