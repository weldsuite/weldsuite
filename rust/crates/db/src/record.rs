//! A request body written into an entity's table the way Drizzle's
//! `db.insert(t).values({ ...data })` and `db.update(t).set({ ...data })`
//! wrote it, for the routes that pass a validated body straight through.
//!
//! The body arrives as a `{ column: value }` object. `jsonb_populate_record`
//! turns it into a row of the table, so Postgres converts each value to its
//! column's type (as the driver left it to Postgres under Drizzle), and the
//! statement names only the columns the object has:
//!
//! - insert: a column the object leaves out gets its database default, one it
//!   sets to `null` gets NULL;
//! - update: a column the object leaves out keeps its value, and `id` is
//!   never rewritten.
//!
//! The statements are built from the entity's columns, and the row comes back
//! as the entity's model, which serializes as Drizzle returned the row.
//! [`JsonTable`] holds an entity's statements behind function pointers, so a
//! `const` list of tables can name its entity. Lists of such a table start from
//! [`JsonTable::select`], add their conditions, order and limit, and read the
//! rows back the same way.

use sea_orm::sea_query::{
    Alias, Asterisk, Expr, ExprTrait, Func, IntoIden, Query, SelectStatement, TableRef,
};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, DbErr, EntityTrait, FromQueryResult, IdenStatic,
    Iterable, QueryFilter, QueryResult, QueryTrait, Statement,
};
use serde_json::{Map, Value};

/// The alias of the populated record in the statements.
const RECORD: &str = "r";

/// `jsonb_populate_record(null::"table", $1::jsonb) as r`.
fn record<E: EntityTrait>(values: Map<String, Value>) -> TableRef {
    let call = Func::cust("jsonb_populate_record")
        .arg(Expr::cust(format!(
            "null::\"{}\"",
            E::default().table_name()
        )))
        .arg(Expr::val(Value::Object(values)).cast_as("jsonb"));
    TableRef::FunctionCall(call, Alias::new(RECORD).into_iden())
}

/// The entity's column called `name`.
fn column<E: EntityTrait>(name: &str) -> Option<E::Column> {
    E::Column::iter().find(|column| column.as_str() == name)
}

fn id_column<E: EntityTrait>() -> Result<E::Column, DbErr> {
    column::<E>("id")
        .ok_or_else(|| DbErr::Custom(format!("{} has no id column", E::default().table_name())))
}

/// The entity's columns that `values` sets.
fn sent<E: EntityTrait>(values: &Map<String, Value>) -> Vec<E::Column> {
    E::Column::iter()
        .filter(|column| values.contains_key(column.as_str()))
        .collect()
}

/// The table's column names, as the database has them.
pub fn columns<E: EntityTrait>() -> Vec<&'static str> {
    E::Column::iter().map(|column| column.as_str()).collect()
}

/// The entity's table name.
fn table_name<E: EntityTrait>() -> &'static str {
    E::default().table_name()
}

/// `select <every column> from t`.
fn select_statement<E: EntityTrait>() -> SelectStatement {
    E::find().into_query()
}

/// `select count(*) from t …` with the conditions of `select` (its columns,
/// order, limit and offset dropped).
pub fn count_statement(select: &SelectStatement) -> Statement {
    let mut count = select.clone();
    count
        .clear_selects()
        .clear_order_by()
        .reset_limit()
        .reset_offset()
        .expr_as(Func::count(Expr::col(Asterisk)), Alias::new("count"));
    DbBackend::Postgres.build(&count)
}

/// `insert into t (<columns sent>) select r.<column>, … from
/// jsonb_populate_record(…) r returning <every column>` (an enum column as
/// text, as `E::find()` reads it, so the model decodes).
pub fn insert_statement<E: EntityTrait>(values: Map<String, Value>) -> Result<Statement, DbErr> {
    let columns = sent::<E>(&values);
    let mut insert = Query::insert();
    insert.into_table(E::default().table_ref()).returning(
        Query::returning()
            .exprs(E::Column::iter().map(|column| column.select_as(Expr::col(column)))),
    );
    if columns.is_empty() {
        insert.or_default_values();
    } else {
        let mut select = Query::select();
        select
            .columns(columns.iter().map(|column| (Alias::new(RECORD), *column)))
            .from(record::<E>(values));
        insert
            .columns(columns)
            .select_from(select)
            .map_err(|error| DbErr::Custom(error.to_string()))?;
    }
    Ok(DbBackend::Postgres.build(&insert))
}

/// The row `id`; `live_only` adds `deleted_at is null` where the table has
/// that column.
pub fn find_statement<E: EntityTrait>(id: &str, live_only: bool) -> Result<Statement, DbErr> {
    let mut find = E::find().filter(id_column::<E>()?.eq(id));
    if live_only && let Some(deleted_at) = column::<E>("deleted_at") {
        find = find.filter(deleted_at.is_null());
    }
    Ok(find.build(DbBackend::Postgres))
}

/// `update t set <column> = r.<column>, … from jsonb_populate_record(…) r
/// where t.id = $id returning <every column>` (enums as text, as in
/// [`insert_statement`]); `live_only` as in [`find_statement`]. With nothing
/// to set, the row as it is.
pub fn update_statement<E: EntityTrait>(
    values: Map<String, Value>,
    id: &str,
    live_only: bool,
) -> Result<Statement, DbErr> {
    let id_column = id_column::<E>()?;
    let columns: Vec<E::Column> = sent::<E>(&values)
        .into_iter()
        .filter(|column| column.as_str() != id_column.as_str())
        .collect();
    if columns.is_empty() {
        return find_statement::<E>(id, live_only);
    }
    let table = E::default();
    let mut update = Query::update();
    update.table(table.table_ref());
    for column in &columns {
        update.value(*column, Expr::col((Alias::new(RECORD), *column)));
    }
    update
        .from(record::<E>(values))
        .and_where(Expr::col((table, id_column)).eq(id));
    if live_only && let Some(deleted_at) = column::<E>("deleted_at") {
        update.and_where(Expr::col((table, deleted_at)).is_null());
    }
    update.returning(
        Query::returning()
            .exprs(E::Column::iter().map(|column| column.select_as(Expr::col((table, column))))),
    );
    Ok(DbBackend::Postgres.build(&update))
}

/// A returned row as the entity's model, serialized as Drizzle returned it.
pub fn json<E>(row: &QueryResult) -> Result<Value, DbErr>
where
    E: EntityTrait,
    E::Model: serde::Serialize,
{
    let model = E::Model::from_query_result(row, "")?;
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// Builds a statement from a `{ column: value }` object.
type FromValues = fn(Map<String, Value>) -> Result<Statement, DbErr>;
/// Builds an update of the row `id`; the flag is `live_only`.
type UpdateValues = fn(Map<String, Value>, &str, bool) -> Result<Statement, DbErr>;
/// Builds the lookup of the row `id`; the flag is `live_only`.
type FindRow = fn(&str, bool) -> Result<Statement, DbErr>;

/// An entity's statements and rows behind function pointers:
/// `JsonTable::of::<tenant::people::Entity>()` in a `const`.
#[derive(Clone, Copy)]
pub struct JsonTable {
    insert: FromValues,
    update: UpdateValues,
    find: FindRow,
    json: fn(&QueryResult) -> Result<Value, DbErr>,
    columns: fn() -> Vec<&'static str>,
    name: fn() -> &'static str,
    select: fn() -> SelectStatement,
}

impl std::fmt::Debug for JsonTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsonTable")
            .field("columns", &(self.columns)())
            .finish_non_exhaustive()
    }
}

impl JsonTable {
    #[must_use]
    pub const fn of<E>() -> Self
    where
        E: EntityTrait,
        E::Model: serde::Serialize,
    {
        Self {
            insert: insert_statement::<E>,
            update: update_statement::<E>,
            find: find_statement::<E>,
            json: json::<E>,
            columns: columns::<E>,
            name: table_name::<E>,
            select: select_statement::<E>,
        }
    }

    /// The entity's column names.
    #[must_use]
    pub fn columns(&self) -> Vec<&'static str> {
        (self.columns)()
    }

    /// The entity's table name.
    #[must_use]
    pub fn table_name(&self) -> &'static str {
        (self.name)()
    }

    /// `t.<name>`, for a condition or an order on the entity's column `name`
    /// in a statement built on [`JsonTable::select`]; `None` when the entity
    /// has no such column.
    #[must_use]
    pub fn column(&self, name: &str) -> Option<Expr> {
        let name = self.columns().into_iter().find(|column| *column == name)?;
        Some(Expr::col((Alias::new(self.table_name()), Alias::new(name))))
    }

    /// `select <every column> from t`: a list adds its conditions, order and
    /// limit, and reads the rows with [`JsonTable::rows`] and their number
    /// with [`JsonTable::count`].
    #[must_use]
    pub fn select(&self) -> SelectStatement {
        (self.select)()
    }

    /// The rows of a statement built on [`JsonTable::select`], as Drizzle
    /// returns them.
    pub async fn rows<C: ConnectionTrait>(
        &self,
        db: &C,
        select: &SelectStatement,
    ) -> Result<Vec<Value>, DbErr> {
        let rows = db.query_all_raw(DbBackend::Postgres.build(select)).await?;
        rows.iter().map(self.json).collect()
    }

    /// `count(*)` of the rows a statement built on [`JsonTable::select`]
    /// matches: its conditions, whatever its order and limit.
    pub async fn count<C: ConnectionTrait>(
        &self,
        db: &C,
        select: &SelectStatement,
    ) -> Result<i64, DbErr> {
        let row = db
            .query_one_raw(count_statement(select))
            .await?
            .ok_or_else(|| DbErr::RecordNotFound("count".to_owned()))?;
        row.try_get("", "count")
    }

    /// Insert `values` (`{ column: value }`): the new row.
    pub async fn insert<C: ConnectionTrait>(
        &self,
        db: &C,
        values: Map<String, Value>,
    ) -> Result<Value, DbErr> {
        let row = db
            .query_one_raw((self.insert)(values)?)
            .await?
            .ok_or(DbErr::RecordNotInserted)?;
        (self.json)(&row)
    }

    /// Update the row `id` with `values`: the changed row, or `None` when no
    /// row matched.
    pub async fn update<C: ConnectionTrait>(
        &self,
        db: &C,
        id: &str,
        values: Map<String, Value>,
        live_only: bool,
    ) -> Result<Option<Value>, DbErr> {
        let row = db
            .query_one_raw((self.update)(values, id, live_only)?)
            .await?;
        row.as_ref().map(self.json).transpose()
    }

    /// The row `id`; `live_only` skips a soft-deleted one.
    pub async fn find<C: ConnectionTrait>(
        &self,
        db: &C,
        id: &str,
        live_only: bool,
    ) -> Result<Option<Value>, DbErr> {
        let row = db.query_one_raw((self.find)(id, live_only)?).await?;
        row.as_ref().map(self.json).transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(unreachable_pub)]
    mod things {
        use sea_orm::entity::prelude::*;

        #[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
        #[sea_orm(table_name = "things")]
        pub struct Model {
            #[sea_orm(primary_key, auto_increment = false)]
            pub id: String,
            pub title: Option<String>,
            pub deleted_at: Option<TimeDateTime>,
        }

        #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
        pub enum Relation {}

        impl ActiveModelBehavior for ActiveModel {}
    }

    #[allow(unreachable_pub)]
    mod tasks {
        use sea_orm::entity::prelude::*;

        #[derive(Clone, Debug, PartialEq, Eq, EnumIter, DeriveActiveEnum, serde::Serialize)]
        #[sea_orm(rs_type = "String", db_type = "Enum", enum_name = "task_status")]
        pub enum Status {
            #[sea_orm(string_value = "open")]
            Open,
        }

        #[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
        #[sea_orm(table_name = "tasks")]
        pub struct Model {
            #[sea_orm(primary_key, auto_increment = false)]
            pub id: String,
            pub status: Status,
        }

        #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
        pub enum Relation {}

        impl ActiveModelBehavior for ActiveModel {}
    }

    fn object(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => Map::new(),
        }
    }

    #[test]
    fn insert_names_only_the_columns_sent() {
        let statement = insert_statement::<things::Entity>(object(
            serde_json::json!({ "id": "t1", "title": null, "other": 1 }),
        ))
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            statement.sql,
            r#"INSERT INTO "things" ("id", "title") SELECT "r"."id", "r"."title" FROM jsonb_populate_record(null::"things", CAST($1 AS jsonb)) AS "r" RETURNING "id", "title", "deleted_at""#
        );
    }

    #[test]
    fn writes_return_an_enum_as_text() {
        let values = || object(serde_json::json!({ "id": "t1", "status": "open" }));
        let insert =
            insert_statement::<tasks::Entity>(values()).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            insert.sql,
            r#"INSERT INTO "tasks" ("id", "status") SELECT "r"."id", "r"."status" FROM jsonb_populate_record(null::"tasks", CAST($1 AS jsonb)) AS "r" RETURNING "id", CAST("status" AS "text")"#
        );
        let update = update_statement::<tasks::Entity>(values(), "t1", true)
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            update.sql,
            r#"UPDATE "tasks" SET "status" = "r"."status" FROM jsonb_populate_record(null::"tasks", CAST($1 AS jsonb)) AS "r" WHERE "tasks"."id" = $2 RETURNING "tasks"."id", CAST("tasks"."status" AS "text")"#
        );
    }

    #[test]
    fn insert_of_nothing_takes_the_defaults() {
        let statement = insert_statement::<things::Entity>(Map::new())
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            statement.sql,
            r#"INSERT INTO "things" VALUES (DEFAULT) RETURNING "id", "title", "deleted_at""#
        );
    }

    #[test]
    fn update_never_rewrites_the_id() {
        let statement = update_statement::<things::Entity>(
            object(serde_json::json!({ "id": "other", "title": "x" })),
            "t1",
            true,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            statement.sql,
            r#"UPDATE "things" SET "title" = "r"."title" FROM jsonb_populate_record(null::"things", CAST($1 AS jsonb)) AS "r" WHERE "things"."id" = $2 AND "things"."deleted_at" IS NULL RETURNING "things"."id", "things"."title", "things"."deleted_at""#
        );
    }

    #[test]
    fn a_list_counts_its_conditions_only() {
        let table = JsonTable::of::<things::Entity>();
        let mut select = table.select();
        select
            .and_where(
                table
                    .column("deleted_at")
                    .unwrap_or_else(|| panic!("deleted_at"))
                    .is_null(),
            )
            .order_by(
                (Alias::new("things"), Alias::new("id")),
                sea_orm::Order::Desc,
            )
            .limit(26);
        assert_eq!(
            DbBackend::Postgres.build(&select).sql,
            r#"SELECT "things"."id", "things"."title", "things"."deleted_at" FROM "things" WHERE "things"."deleted_at" IS NULL ORDER BY "things"."id" DESC LIMIT $1"#
        );
        assert_eq!(
            count_statement(&select).sql,
            r#"SELECT COUNT(*) AS "count" FROM "things" WHERE "things"."deleted_at" IS NULL"#
        );
        assert!(table.column("nope").is_none());
    }

    #[test]
    fn update_of_nothing_reads_the_row() {
        let statement = update_statement::<things::Entity>(
            object(serde_json::json!({ "id": "x" })),
            "t1",
            false,
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            statement.sql,
            r#"SELECT "things"."id", "things"."title", "things"."deleted_at" FROM "things" WHERE "things"."id" = $1"#
        );
    }
}
