//! Order numbers and the workspace's commerce settings (`commerce_settings`).
//!
//! One row per workspace holds the prefix and the next number
//! (`WC-1001`). The row is created on first use; taking a number locks it
//! until the order's transaction ends, so two orders never share a number and
//! a rolled-back order gives its number back. Imported orders keep their
//! source's number and never come through here.

use sea_orm::ActiveValue::{Set, Unchanged};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use sqlx::PgConnection;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{commerce_settings, orders};

use crate::db;
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
const LOCK: &str = "weldcommerce:settings";

fn settings_of(row: commerce_settings::Model) -> Settings {
    Settings {
        id: row.id,
        order_number_prefix: row.order_number_prefix,
        next_order_number: row.next_order_number,
        default_currency: row.default_currency,
    }
}

/// The settings row, created with the defaults when there is none, and
/// locked until the transaction ends.
///
/// # Errors
/// A failed statement.
pub async fn load_or_create(conn: &mut PgConnection) -> Result<Settings, DbErr> {
    // Two first uses at once would each create a row; the advisory lock
    // makes the second wait for the first.
    db::advisory_lock(conn, LOCK).await?;
    let found = commerce_settings::Entity::find()
        .order_by_asc(commerce_settings::Column::CreatedAt)
        .order_by_asc(commerce_settings::Column::Id)
        .lock_exclusive()
        .one(&db::on(conn))
        .await?;
    if let Some(row) = found {
        return Ok(settings_of(row));
    }
    let row = commerce_settings::ActiveModel {
        id: Set(generate_id("cset")),
        ..Default::default()
    }
    .insert(&db::on(conn))
    .await?;
    Ok(settings_of(row))
}

/// The next free number of `source`'s orders (`WC-1001`), taken from the
/// sequence. A number a live order of that source already has is skipped.
///
/// # Errors
/// A failed statement.
pub async fn take(conn: &mut PgConnection, source: &str) -> Result<String, DbErr> {
    let settings = load_or_create(conn).await?;
    let mut next = settings.next_order_number;
    loop {
        let candidate = format!("{}{next}", settings.order_number_prefix);
        next += 1;
        let taken = orders::Entity::find()
            .filter(orders::Column::DeletedAt.is_null())
            .filter(orders::Column::Source.eq(source))
            .filter(orders::Column::OrderNumber.eq(candidate.as_str()))
            .count(&db::on(conn))
            .await?
            > 0;
        if !taken {
            commerce_settings::ActiveModel {
                id: Unchanged(settings.id.clone()),
                next_order_number: Set(next),
                updated_at: Set(db::now()),
                ..Default::default()
            }
            .update(&db::on(conn))
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
    let mut row = commerce_settings::ActiveModel {
        id: Unchanged(current.id),
        updated_at: Set(db::now()),
        ..Default::default()
    };
    if let Some(prefix) = &change.order_number_prefix {
        row.order_number_prefix = Set(prefix.clone());
    }
    if let Some(next) = change.next_order_number {
        row.next_order_number = Set(next);
    }
    if let Some(currency) = &change.default_currency {
        row.default_currency = Set(currency.clone());
    }
    Ok(settings_of(row.update(&db::on(conn)).await?))
}
