//! Writing a request body into a table the way stash-api's Drizzle calls do:
//! `db.insert(t).values({ id, ...data, createdAt, updatedAt })` and
//! `db.update(t).set({ updatedAt, ...data })`, where `data` is what the
//! route's Zod schema let through (`.passthrough()` included: any key that is
//! one of the table's properties reaches the statement), and the rows the
//! routes build themselves.
//!
//! A [`Table`] (the generated [`crate::tables`]) maps Drizzle's properties
//! onto the columns of its entity; the values become a `{ column: value }`
//! JSON object that [`weldsuite_db::record`] writes through the entity, and a
//! column the object leaves out gets its database default (insert) or keeps
//! its value (patch), as Drizzle leaves it out of the statement. The same
//! helper as `weldsuite-desk-domain`'s, except that a patch may also set `id`
//! (Drizzle's `.set({ id })` renames the row; the passthrough schemas let an
//! `id` through).

use sea_orm::sea_query::{Alias, Expr, Query};
use sea_orm::{ConnectionTrait, DbBackend, DbErr, Statement};
use serde_json::{Map, Value};
use weldsuite_db::record::JsonTable;
use weldsuite_db::{OrmConn, PgPool, orm};

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
    #[allow(dead_code)] // none of the tables has one yet
    /// A `$defaultFn` Drizzle runs when the insert leaves the property out.
    pub(crate) default_fn: bool,
}

/// A table stash-api writes from a request body.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Table {
    #[allow(dead_code)] // the generator names every table
    pub(crate) name: &'static str,
    /// The table's entity: the statements, and the row as Drizzle returns it.
    pub(crate) entity: JsonTable,
    pub(crate) columns: &'static [Column],
    /// Columns the entity gained after the Drizzle schema froze (DATA-019).
    /// The TypeScript worker never reads or writes them, so a row as Drizzle
    /// returns it leaves them out and writes ignore them.
    pub(crate) entity_only: &'static [Column],
}

/// Why a write could not run.
#[derive(Debug)]
pub(crate) enum WriteError {
    /// A `date`-mode timestamp got a value that is not a `Date`: Drizzle's
    /// `toISOString` throws before the statement runs (the route's 500).
    NotADate(&'static str),
    Database(DbErr),
}

impl From<DbErr> for WriteError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

/// For the callers still writing SQL around a [`Table`] write, and the
/// transaction of a patch that renames its row.
impl From<sqlx::Error> for WriteError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(weldsuite_db::orm_error(error))
    }
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotADate(prop) => write!(f, "value.toISOString is not a function ({prop})"),
            Self::Database(error) => error.fmt(f),
        }
    }
}

impl Table {
    /// A row as the entity serializes it (Drizzle's property names, `Date`s
    /// and numerics as Drizzle returns them), with its json strings
    /// re-parsed as Drizzle does.
    pub(crate) fn drizzle(&self, row: Value) -> Value {
        let Value::Object(mut row) = row else {
            return row;
        };
        for column in self.columns {
            if column.kind == Kind::Json
                && let Some(value) = row.get_mut(column.prop)
            {
                *value = json_value(std::mem::take(value));
            }
        }
        for column in self.entity_only {
            row.remove(column.prop);
        }
        Value::Object(row)
    }

    pub(crate) fn column(&self, prop: &str) -> Option<&'static Column> {
        self.columns.iter().find(|c| c.prop == prop)
    }

    /// Set a property the route writes itself (`createdAt: now`). Values the
    /// route builds are what Drizzle got as JavaScript values (a `Date` for a
    /// timestamp), so they are not checked.
    pub(crate) fn set(&self, values: &mut Map<String, Value>, prop: &str, value: Value) {
        if let Some(column) = self.column(prop) {
            values.insert(column.name.to_owned(), value);
        }
    }

    /// The `date`-mode timestamps in `values` that came from the body: a
    /// string there makes Drizzle throw.
    fn check_dates(&self, values: &Map<String, Value>, trusted: &[&str]) -> Result<(), WriteError> {
        for column in self.columns {
            if column.kind == Kind::Date
                && !trusted.contains(&column.prop)
                && values.get(column.name).is_some_and(|v| !v.is_null())
            {
                return Err(WriteError::NotADate(column.prop));
            }
        }
        Ok(())
    }

    /// Insert `values` (`{ column: value }`, see [`Table::set`]); `trusted`
    /// names the properties the route set itself. The row as Drizzle
    /// returns it.
    pub(crate) async fn insert(
        &self,
        db: &PgPool,
        values: Map<String, Value>,
        trusted: &[&str],
    ) -> Result<Value, WriteError> {
        self.insert_on(&orm(db), values, trusted).await
    }

    /// [`Table::insert`] on a SeaORM connection (`OrmConn` in a transaction).
    pub(crate) async fn insert_on<C: ConnectionTrait>(
        &self,
        db: &C,
        values: Map<String, Value>,
        trusted: &[&str],
    ) -> Result<Value, WriteError> {
        self.check_dates(&values, trusted)?;
        let row = self.entity.insert(db, values).await?;
        Ok(self.drizzle(row))
    }

    /// Update the row `id` with `values`; `live_only` adds `deleted_at is
    /// null`. The changed row, or `None` when none matched. A patch that
    /// renames the row runs its two statements in one transaction, as the
    /// one statement it was.
    pub(crate) async fn patch(
        &self,
        db: &PgPool,
        id: &str,
        values: Map<String, Value>,
        live_only: bool,
        trusted: &[&str],
    ) -> Result<Option<Value>, WriteError> {
        self.check_dates(&values, trusted)?;
        if !values.contains_key("id") {
            return self.write(&orm(db), id, values, live_only).await;
        }
        let table = *self;
        let id = id.to_owned();
        weldsuite_db::atomically_with(db, move |tx| {
            Box::pin(async move {
                let db = OrmConn::new(tx);
                table.write(&db, &id, values, live_only).await
            })
        })
        .await
    }

    /// The patch's statements: the rename when `values` sets `id`, then the
    /// other columns of the (renamed) row.
    async fn write<C: ConnectionTrait>(
        &self,
        db: &C,
        id: &str,
        mut values: Map<String, Value>,
        live_only: bool,
    ) -> Result<Option<Value>, WriteError> {
        let id = match values.remove("id") {
            Some(new_id) => match self.rename(db, id, new_id, live_only).await? {
                Some(renamed) => renamed,
                None => return Ok(None),
            },
            None => id.to_owned(),
        };
        let row = self.entity.update(db, &id, values, live_only).await?;
        Ok(row.map(|row| self.drizzle(row)))
    }

    /// The new id, or `None` when no row matched ([`Table::rename_statement`]).
    async fn rename<C: ConnectionTrait>(
        &self,
        db: &C,
        id: &str,
        new_id: Value,
        live_only: bool,
    ) -> Result<Option<String>, DbErr> {
        let statement = self.rename_statement(id, new_id, live_only);
        let row = db.query_one_raw(statement).await?;
        row.map(|row| row.try_get::<String>("", "id")).transpose()
    }

    /// `update t set id = $new where id = $id [and deleted_at is null]
    /// returning id`, `$new` converted to text as `jsonb_populate_record`
    /// converts it (`{ id }->>'id'`).
    fn rename_statement(&self, id: &str, new_id: Value, live_only: bool) -> Statement {
        use sea_orm::ExprTrait as _;
        let table = Alias::new(self.entity.table_name());
        let mut object = Map::new();
        object.insert("id".to_owned(), new_id);
        let new_id = sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(
            Expr::val(Value::Object(object)).cast_as("jsonb"),
            "id",
        );
        let mut update = Query::update();
        update
            .table(table.clone())
            .value(Alias::new("id"), new_id)
            .and_where(Expr::col((table, Alias::new("id"))).eq(id));
        if live_only && let Some(deleted_at) = self.entity.column("deleted_at") {
            update.and_where(deleted_at.is_null());
        }
        update.returning_col(Alias::new("id"));
        DbBackend::Postgres.build(&update)
    }

    /// The live row `id` (`deleted_at is null` where the table has it), as
    /// Drizzle returns it.
    pub(crate) async fn find_live(&self, db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
        self.find_live_on(&orm(db), id).await
    }

    /// [`Table::find_live`] on a SeaORM connection.
    pub(crate) async fn find_live_on<C: ConnectionTrait>(
        &self,
        db: &C,
        id: &str,
    ) -> Result<Option<Value>, DbErr> {
        let row = self.entity.find(db, id, true).await?;
        Ok(row.map(|row| self.drizzle(row)))
    }

    /// The columns this table names that its entity lacks, and the entity's
    /// columns it leaves out (other than [`Table::entity_only`]): both empty
    /// while the two agree.
    #[cfg(test)]
    fn entity_drift(&self) -> (Vec<&'static str>, Vec<&'static str>) {
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
                !self
                    .columns
                    .iter()
                    .chain(self.entity_only)
                    .any(|column| column.name == *name)
            })
            .collect();
        (missing, extra)
    }
}

/// Drizzle's json/jsonb `mapFromDriverValue`: a string is `JSON.parse`d when
/// it parses (`"19.99"` reads back as 19.99).
fn json_value(value: Value) -> Value {
    match value {
        Value::String(text) => serde_json::from_str(&text).unwrap_or(Value::String(text)),
        value => value,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn the_tables_match_their_entities() {
        for table in crate::tables::ALL {
            assert_eq!(table.entity_drift(), (vec![], vec![]), "{}", table.name);
        }
    }

    #[test]
    fn a_patch_renames_with_the_id_as_postgres_reads_it() {
        let statement = crate::tables::BOXES.rename_statement("box_1", json!("box_2"), true);
        assert_eq!(
            statement.sql,
            r#"UPDATE "boxes" SET "id" = CAST($1 AS jsonb) ->> $2 WHERE "boxes"."id" = $3 AND "boxes"."deleted_at" IS NULL RETURNING "id""#
        );
        let statement =
            crate::tables::INVENTORY_MOVEMENTS.rename_statement("mov_1", json!(7), true);
        assert!(!statement.sql.contains("deleted_at"), "{}", statement.sql);
    }

    #[test]
    fn json_strings_read_back_parsed() {
        let row = crate::tables::BOXES.drizzle(json!({
            "id": "box_1",
            "cost": "19.99",
            "name": "19.99",
        }));
        assert_eq!(row["cost"], json!(19.99));
        assert_eq!(row["name"], json!("19.99"));
        let row = crate::tables::BOXES.drizzle(json!({ "cost": "not json" }));
        assert_eq!(row["cost"], json!("not json"));
    }
}
