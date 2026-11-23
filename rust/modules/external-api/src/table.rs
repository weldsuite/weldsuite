//! Writing a request body into a table the way the routes' Drizzle calls do:
//! `db.insert(t).values({ ...body, id, createdAt, updatedAt })` and
//! `db.update(t).set({ ...body, updatedAt })`, where `body` is what the
//! route's Zod schema let through.
//!
//! A generated table (`tables_gen.rs`) maps Drizzle's properties onto the
//! columns of its entity; the values become a `{ column: value }` JSON object
//! that [`weldsuite_db::record`] writes through the entity, so a column the
//! object leaves out gets its database default (insert) or keeps its value
//! (patch), as Drizzle leaves it out of the statement. Rows come back as the
//! entity's model, which serializes as Drizzle returned the row. (The same
//! scheme as `weldsuite_desk_domain::table`, with the hard delete and the
//! any-row read the public API also needs.)

use sea_orm::sea_query::{Expr, Query};
use sea_orm::{
    ConnectionTrait, DbBackend, DbErr, EntityTrait, IdenStatic, Iterable, QueryResult, Statement,
};
use serde_json::{Map, Value};
use weldsuite_db::record::JsonTable;
use weldsuite_db::{PgPool, orm};

/// How Drizzle maps a property's value onto its column.
#[allow(dead_code)] // every Drizzle kind the generator writes
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Text,
    Number,
    Bool,
    Json,
    /// `timestamp` / `date` in `date` mode: Drizzle calls `value.toISOString()`,
    /// so anything but a `Date` (or null) makes the statement throw.
    Date,
    /// `timestamp` / `date` in `string` mode.
    DateString,
    /// `numeric`: read back as a string.
    Numeric,
    Array,
    Other,
}

/// A table property.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Column {
    /// The Drizzle property (`ticketTypeId`).
    pub(crate) prop: &'static str,
    /// The column (`ticket_type_id`).
    pub(crate) name: &'static str,
    pub(crate) kind: Kind,
    /// A `$defaultFn` Drizzle runs when the insert leaves the property out.
    #[allow(dead_code)]
    pub(crate) default_fn: bool,
    /// An `$onUpdateFn` Drizzle runs when an update leaves the property out.
    #[allow(dead_code)]
    pub(crate) on_update: bool,
}

/// A table the public API writes.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Table {
    /// The table, for a reader of the generated file.
    pub(crate) name: &'static str,
    /// The table's entity: the statements, and the row as Drizzle returns it.
    pub(crate) entity: JsonTable,
    /// The hard delete, which [`JsonTable`] leaves out.
    pub(crate) delete: Delete,
    /// The properties the API reads, in the schema's order.
    pub(crate) columns: &'static [Column],
    /// The entity's columns the API never reads (`selectableColumns`: the
    /// ciphertext ones).
    #[allow(dead_code)] // the test that holds each table to its entity
    pub(crate) omitted: &'static [&'static str],
    /// Whether the table has `deleted_at` (the routes' soft delete).
    pub(crate) soft_delete: bool,
}

/// `delete from t where t.id = $1 returning <every column>`, and the reader
/// of the row it returns: what [`JsonTable`] does for its other statements.
#[derive(Clone, Copy)]
pub(crate) struct Delete {
    statement: fn(&str) -> Result<Statement, DbErr>,
    json: fn(&QueryResult) -> Result<Value, DbErr>,
}

impl std::fmt::Debug for Delete {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Delete").finish_non_exhaustive()
    }
}

impl Delete {
    /// The hard delete of the entity `E`'s rows.
    pub(crate) const fn of<E>() -> Self
    where
        E: EntityTrait,
        E::Model: serde::Serialize,
    {
        Self {
            statement: delete_statement::<E>,
            json: weldsuite_db::record::json::<E>,
        }
    }
}

/// `delete from t where t.id = $1 returning <every column>`.
fn delete_statement<E: EntityTrait>(id: &str) -> Result<Statement, DbErr> {
    use sea_orm::ExprTrait as _;
    let table = E::default();
    let id_column = E::Column::iter()
        .find(|column| column.as_str() == "id")
        .ok_or_else(|| DbErr::Custom(format!("{} has no id column", table.table_name())))?;
    let mut delete = Query::delete();
    delete
        .from_table(table.table_ref())
        .and_where(Expr::col((table, id_column)).eq(id))
        .returning(Query::returning().columns(E::Column::iter()));
    Ok(DbBackend::Postgres.build(&delete))
}

/// Why a write could not run.
#[derive(Debug)]
pub(crate) enum WriteError {
    /// A `date`-mode timestamp got a value that is not a `Date`: Drizzle's
    /// `toISOString` throws before the statement runs (the route's 500).
    NotADate(&'static str),
    /// `set({})`: Drizzle throws `No values to set` (the route's 500).
    NoValues,
    Database(DbErr),
}

impl From<DbErr> for WriteError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

impl Table {
    /// A row as the entity serializes it (Drizzle's `select()`), kept to the
    /// schema's properties, in its order: the columns the API never reads
    /// are dropped.
    pub(crate) fn js(&self, row: Value) -> Value {
        let Value::Object(mut row) = row else {
            return row;
        };
        let mut out = Map::with_capacity(self.columns.len());
        for column in self.columns {
            let value = row.remove(column.prop).unwrap_or(Value::Null);
            out.insert(column.prop.to_owned(), value);
        }
        Value::Object(out)
    }

    pub(crate) fn column(&self, prop: &str) -> Option<&'static Column> {
        self.columns.iter().find(|c| c.prop == prop)
    }

    /// `{ ...data }` as `{ column: value }`: the properties of the table in
    /// `data`, in `data`'s order. Keys that are not properties are dropped,
    /// as Drizzle drops them.
    pub(crate) fn values(&self, data: &Map<String, Value>) -> Map<String, Value> {
        let mut out = Map::new();
        for (key, value) in data {
            if let Some(column) = self.column(key) {
                out.insert(column.name.to_owned(), value.clone());
            }
        }
        out
    }

    /// The `date`-mode timestamps in `values` that are not `Date`s: a
    /// string there makes Drizzle throw. `dates` names the properties that
    /// hold one (the route's own values, a `z.coerce.date()` field).
    fn check_dates(&self, values: &Map<String, Value>, dates: &[&str]) -> Result<(), WriteError> {
        for column in self.columns {
            if column.kind == Kind::Date
                && !dates.contains(&column.prop)
                && values.get(column.name).is_some_and(|v| !v.is_null())
            {
                return Err(WriteError::NotADate(column.prop));
            }
        }
        Ok(())
    }

    /// Insert `data` (by property); `dates` names the properties holding a
    /// `Date`. The row as Drizzle returns it.
    pub(crate) async fn insert(
        &self,
        db: &PgPool,
        data: &Map<String, Value>,
        dates: &[&str],
    ) -> Result<Value, WriteError> {
        self.insert_on(&orm(db), data, dates).await
    }

    /// [`Table::insert`] on a SeaORM connection (`OrmConn` in a transaction).
    pub(crate) async fn insert_on<C: ConnectionTrait>(
        &self,
        db: &C,
        data: &Map<String, Value>,
        dates: &[&str],
    ) -> Result<Value, WriteError> {
        let values = self.values(data);
        self.check_dates(&values, dates)?;
        let row = self.entity.insert(db, values).await?;
        Ok(self.js(row))
    }

    /// Update the row `id` with `data` (by property); `live_only` adds
    /// `deleted_at is null`. The changed row, or `None` when none matched.
    pub(crate) async fn patch(
        &self,
        db: &PgPool,
        id: &str,
        data: &Map<String, Value>,
        live_only: bool,
        dates: &[&str],
    ) -> Result<Option<Value>, WriteError> {
        self.patch_on(&orm(db), id, data, live_only, dates).await
    }

    /// [`Table::patch`] on a SeaORM connection (`OrmConn` in a transaction).
    pub(crate) async fn patch_on<C: ConnectionTrait>(
        &self,
        db: &C,
        id: &str,
        data: &Map<String, Value>,
        live_only: bool,
        dates: &[&str],
    ) -> Result<Option<Value>, WriteError> {
        let values = self.values(data);
        if values.is_empty() {
            return Err(WriteError::NoValues);
        }
        self.check_dates(&values, dates)?;
        let row = self.entity.update(db, id, values, live_only).await?;
        Ok(row.map(|row| self.js(row)))
    }

    /// The live row `id` (`deleted_at is null` where the table has it), as
    /// Drizzle returns it.
    pub(crate) async fn find_live(&self, db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
        let row = self.entity.find(&orm(db), id, true).await?;
        Ok(row.map(|row| self.js(row)))
    }

    /// The row `id`, removed or not.
    pub(crate) async fn find_any(&self, db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
        let row = self.entity.find(&orm(db), id, false).await?;
        Ok(row.map(|row| self.js(row)))
    }

    /// Delete the row `id`; the deleted row, if there was one.
    pub(crate) async fn delete(&self, db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
        let row = orm(db)
            .query_one_raw((self.delete.statement)(id)?)
            .await?;
        row.as_ref()
            .map(self.delete.json)
            .transpose()
            .map(|row| row.map(|row| self.js(row)))
    }

    /// The columns this table names that its entity lacks, and the entity's
    /// columns it neither names nor omits: both empty while the two agree.
    #[cfg(test)]
    pub(crate) fn entity_drift(&self) -> (Vec<&'static str>, Vec<&'static str>) {
        let entity = self.entity.columns();
        let missing = self
            .columns
            .iter()
            .map(|column| column.name)
            .filter(|name| !entity.contains(name))
            .collect();
        let extra = entity
            .into_iter()
            .filter(|name| {
                !self.columns.iter().any(|column| column.name == *name)
                    && !self.omitted.contains(name)
            })
            .collect();
        (missing, extra)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The generated tables keep Drizzle's properties; their columns are the
    /// entities', so a schema change shows up here.
    #[test]
    fn the_tables_match_their_entities() {
        assert_eq!(crate::tables_gen::ALL.len(), 67);
        for table in crate::tables_gen::ALL {
            assert_eq!(table.entity_drift(), (vec![], vec![]), "{}", table.name);
            assert_eq!(table.entity.table_name(), table.name);
            assert_eq!(
                table.soft_delete,
                table.entity.columns().contains(&"deleted_at"),
                "{}",
                table.name
            );
        }
    }

    #[test]
    fn a_hard_delete_returns_the_row() {
        let statement = (crate::tables_gen::DNS_RECORDS.delete.statement)("rec_1")
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(
            statement
                .sql
                .starts_with(r#"DELETE FROM "dns_records" WHERE "dns_records"."id" = $1 RETURNING "id", "#),
            "{}",
            statement.sql
        );
    }

    #[test]
    fn rows_keep_the_schemas_properties_only() {
        let table = &crate::tables_gen::BANK_ACCOUNTS;
        let row = table.js(serde_json::json!({
            "id": "ba_1",
            "accountNumberEncrypted": "secret",
        }));
        assert_eq!(row["id"], "ba_1");
        assert!(row.get("accountNumberEncrypted").is_none());
        assert_eq!(table.omitted, ["account_number_encrypted"]);
    }
}
