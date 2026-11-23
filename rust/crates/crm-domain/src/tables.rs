//! The tables the CRM writes ([`Table`]), and their writes over
//! `jsonb_populate_record`: a JSON object of column values, Postgres
//! converting each to its column's type, as Drizzle's `values()`/`set()`
//! left it to the driver ([`insert_row`], [`update_rows`]).

use sea_orm::sea_query::{Alias, Expr, Func, IntoIden, Query, TableRef, UpdateStatement};
use sea_orm::{Condition, ConnectionTrait, DbErr, EntityTrait, IdenStatic, Iterable};
use serde_json::{Map, Value};

pub use crate::tables_gen::*;

/// A table: its name, each column's Drizzle key and SQL name, and the
/// literal defaults of the columns that have one (JSON, by column).
#[derive(Debug, Clone, Copy)]
pub struct Table {
    pub name: &'static str,
    pub columns: &'static [(&'static str, &'static str)],
    pub defaults: &'static str,
}

impl Table {
    /// The SQL column of a Drizzle key.
    pub fn column(&self, key: &str) -> Option<&'static str> {
        self.columns
            .iter()
            .find(|(js, _)| *js == key)
            .map(|(_, sql)| *sql)
    }

    /// `set(values)`: the values by column, keys the table doesn't have
    /// dropped (Drizzle ignores them).
    pub fn set(&self, values: &Map<String, Value>) -> Value {
        let mut out = Map::new();
        for (key, value) in values {
            if let Some(column) = self.column(key) {
                out.insert(column.to_owned(), value.clone());
            }
        }
        Value::Object(out)
    }

    /// `insert().values(values)`: the values by column, with the literal
    /// default of each column the values leave out.
    pub fn values(&self, values: &Map<String, Value>) -> Value {
        let mut out: Map<String, Value> = serde_json::from_str(self.defaults).unwrap_or_default();
        if let Value::Object(set) = self.set(values) {
            for (column, value) in set {
                out.insert(column, value);
            }
        }
        Value::Object(out)
    }

    /// [`Table::values`] naming every column of the table: one the values
    /// leave out without a literal default is `null`, as
    /// `jsonb_populate_record` reads a missing key.
    pub fn insert_values(&self, values: &Map<String, Value>) -> Map<String, Value> {
        let given = match self.values(values) {
            Value::Object(given) => given,
            _ => Map::new(),
        };
        self.columns
            .iter()
            .map(|(_, column)| {
                let value = given.get(*column).cloned().unwrap_or(Value::Null);
                ((*column).to_owned(), value)
            })
            .collect()
    }

    /// [`Table::set`] as an object.
    fn set_values(&self, values: &Map<String, Value>) -> Map<String, Value> {
        match self.set(values) {
            Value::Object(set) => set,
            _ => Map::new(),
        }
    }
}

/// The alias of the populated record in [`update_statement`].
const RECORD: &str = "r";

/// Insert the row `values` (by Drizzle key) describe, every column named
/// (one the values leave out as its literal default or `null`), from
/// `jsonb_populate_record(null::<table>, $1)`: Drizzle's `insert().values()`.
pub(crate) async fn insert_row<E: EntityTrait>(
    db: &impl ConnectionTrait,
    table: &Table,
    values: &Map<String, Value>,
) -> Result<(), DbErr> {
    let statement = weldsuite_db::record::insert_statement::<E>(table.insert_values(values))?;
    db.execute_raw(statement).await?;
    Ok(())
}

/// Update the rows `condition` matches with the columns `values` (by
/// Drizzle key) set, from `jsonb_populate_record(null::<table>, $1) r`
/// (`set <column> = r.<column>`), `id` never rewritten, returning the ids:
/// Drizzle's `update().set()`.
pub(crate) fn update_statement<E: EntityTrait>(
    table: &Table,
    values: &Map<String, Value>,
    condition: Condition,
) -> UpdateStatement {
    use sea_orm::ExprTrait as _;
    let set = table.set_values(values);
    let entity = E::default();
    let record = Func::cust("jsonb_populate_record")
        .arg(Expr::null().cast_as(Alias::new(entity.table_name())))
        .arg(Expr::val(Value::Object(set.clone())).cast_as("jsonb"));
    let mut update = Query::update();
    update.table(entity.table_ref());
    for column in E::Column::iter() {
        if column.as_str() != "id" && set.contains_key(column.as_str()) {
            update.value(column, Expr::col((Alias::new(RECORD), column)));
        }
    }
    update
        .from(TableRef::FunctionCall(
            record,
            Alias::new(RECORD).into_iden(),
        ))
        .cond_where(condition)
        .returning(Query::returning().expr(Expr::col((
            Alias::new(entity.table_name()),
            Alias::new("id"),
        ))));
    update
}

/// [`update_statement`], run: the ids of the rows written.
pub(crate) async fn update_rows<E: EntityTrait>(
    db: &impl ConnectionTrait,
    table: &Table,
    values: &Map<String, Value>,
    condition: Condition,
) -> Result<Vec<String>, DbErr> {
    let rows = db
        .query_all(&update_statement::<E>(table, values, condition))
        .await?;
    rows.iter().map(|row| row.try_get("", "id")).collect()
}

#[cfg(test)]
mod tests {
    use sea_orm::{ColumnTrait, DbBackend};
    use serde_json::json;
    use weldsuite_schema::tenant::parties;

    use super::*;
    use crate::tables_gen::PARTIES;

    #[test]
    fn an_update_sets_only_the_columns_sent() {
        let Value::Object(values) = json!({ "id": "x", "displayName": "Acme", "nope": 1 }) else {
            unreachable!()
        };
        let update = update_statement::<parties::Entity>(
            &PARTIES,
            &values,
            Condition::all().add(parties::Column::Id.eq("party_1")),
        );
        assert_eq!(
            DbBackend::Postgres.build(&update).sql,
            r#"UPDATE "parties" SET "display_name" = "r"."display_name" FROM jsonb_populate_record(CAST(NULL AS parties), CAST($1 AS jsonb)) AS "r" WHERE "parties"."id" = $2 RETURNING "parties"."id""#
        );
    }
}
