//! Order numbers and the workspace's commerce settings (`commerce_settings`).
//!
//! One row per workspace holds the prefix and the next number
//! (`WC-1001`). The row is created on first use; taking a number locks it
//! until the order's transaction ends, so two orders never share a number and
//! a rolled-back order gives its number back. Imported orders keep their
//! source's number and never come through here.

use sqlx::PgConnection;
use weldsuite_kit::generate_id;

use crate::error::Error;

/// The settings row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub id: String,
    pub order_number_prefix: String,
    pub next_order_number: i64,
    pub default_currency: String,
}

/// Serialises the first use and every change of the settings row.
const LOCK: &str = "select pg_advisory_xact_lock(hashtext('weldcommerce:settings'))";

type Row = (String, String, i64, String);

fn settings_of((id, prefix, next, currency): Row) -> Settings {
    Settings {
        id,
        order_number_prefix: prefix,
        next_order_number: next,
        default_currency: currency,
    }
}

/// The settings row, created with the defaults when there is none, and
/// locked until the transaction ends.
///
/// # Errors
/// A failed statement.
pub async fn load_or_create(conn: &mut PgConnection) -> Result<Settings, sqlx::Error> {
    // Two first uses at once would each create a row; the advisory lock
    // makes the second wait for the first.
    sqlx::query(LOCK).execute(&mut *conn).await?;
    let found: Option<Row> = sqlx::query_as(
        "select id, order_number_prefix, next_order_number, default_currency \
         from commerce_settings order by created_at asc, id asc limit 1 for update",
    )
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(row) = found {
        return Ok(settings_of(row));
    }
    let row: Row = sqlx::query_as(
        "insert into commerce_settings (id) values ($1) \
         returning id, order_number_prefix, next_order_number, default_currency",
    )
    .bind(generate_id("cset"))
    .fetch_one(&mut *conn)
    .await?;
    Ok(settings_of(row))
}

/// The next free number of `source`'s orders (`WC-1001`), taken from the
/// sequence. A number a live order of that source already has is skipped.
///
/// # Errors
/// A failed statement.
pub async fn take(conn: &mut PgConnection, source: &str) -> Result<String, sqlx::Error> {
    let settings = load_or_create(conn).await?;
    let mut next = settings.next_order_number;
    loop {
        let candidate = format!("{}{next}", settings.order_number_prefix);
        next += 1;
        let taken: bool = sqlx::query_scalar(
            "select exists (select 1 from orders \
             where deleted_at is null and source = $1 and order_number = $2)",
        )
        .bind(source)
        .bind(&candidate)
        .fetch_one(&mut *conn)
        .await?;
        if !taken {
            sqlx::query(
                "update commerce_settings set next_order_number = $2, updated_at = now() where id = $1",
            )
            .bind(&settings.id)
            .bind(next)
            .execute(&mut *conn)
            .await?;
            return Ok(candidate);
        }
    }
}

/// A settings change; `None` leaves the field.
#[derive(Debug, Default, Clone)]
pub struct Change {
    pub order_number_prefix: Option<String>,
    pub next_order_number: Option<i64>,
    pub default_currency: Option<String>,
}

/// Apply `change`; the settings as they are now.
///
/// # Errors
/// [`Error::SequenceBackwards`] when `next_order_number` is below the
/// sequence (the same number is fine).
pub async fn update(conn: &mut PgConnection, change: &Change) -> Result<Settings, Error> {
    let current = load_or_create(conn).await?;
    if let Some(next) = change.next_order_number
        && next < current.next_order_number
    {
        return Err(Error::SequenceBackwards {
            current: current.next_order_number,
        });
    }
    let row: Row = sqlx::query_as(
        "update commerce_settings set \
           order_number_prefix = coalesce($2, order_number_prefix), \
           next_order_number = coalesce($3, next_order_number), \
           default_currency = coalesce($4, default_currency), \
           updated_at = now() \
         where id = $1 \
         returning id, order_number_prefix, next_order_number, default_currency",
    )
    .bind(&current.id)
    .bind(change.order_number_prefix.as_deref())
    .bind(change.next_order_number)
    .bind(change.default_currency.as_deref())
    .fetch_one(&mut *conn)
    .await?;
    Ok(settings_of(row))
}
