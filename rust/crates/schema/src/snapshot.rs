//! A database's schema as a drizzle-kit snapshot (version 7), built from the
//! entities and their DDL (ADR DATA-019). The snapshot is the schema state a
//! migration is diffed against: until the flip drizzle-kit writes it, and
//! `tests/snapshot.rs` checks that the entities build exactly the newest one;
//! after the flip this builds it.
//!
//! Each column comes from its entity: the name, the SQL type (rendered from
//! SeaORM's column type, as drizzle-kit spells it), nullability and the
//! primary key. The rest comes from [`crate::ddl`].

use sea_orm::sea_query::{ColumnType, StringLen};
use sea_orm::{ActiveEnum, ColumnTrait, EntityTrait, IdenStatic, Iterable, PrimaryKeyToColumn};
use serde_json::{Map, Number, Value, json};

use crate::ddl;

/// One column as its entity defines it.
#[derive(Debug, Clone)]
pub struct EntityColumn {
    pub name: &'static str,
    pub column_type: ColumnType,
    pub nullable: bool,
    pub primary_key: bool,
}

/// One table: its entity's columns and its DDL.
#[derive(Debug, Clone)]
pub struct TableSchema {
    pub ddl: &'static ddl::Table,
    pub columns: Vec<EntityColumn>,
}

/// A Postgres enum: its name and values, from the active enum.
#[derive(Debug, Clone)]
pub struct EnumSchema {
    pub name: String,
    pub values: Vec<String>,
}

/// `E`'s table: the entity's columns, in field order, with `ddl`.
pub fn table<E: EntityTrait>(ddl: &'static ddl::Table) -> TableSchema {
    let primary_key: Vec<&'static str> = E::PrimaryKey::iter()
        .map(|key| key.into_column().as_str())
        .collect();
    let columns = E::Column::iter()
        .map(|column| {
            let def = column.def();
            EntityColumn {
                name: column.as_str(),
                column_type: def.get_column_type().clone(),
                nullable: def.is_null(),
                primary_key: primary_key.contains(&column.as_str()),
            }
        })
        .collect();
    TableSchema { ddl, columns }
}

/// The enum `A` as the snapshot lists it.
pub fn enum_schema<A>() -> EnumSchema
where
    A: ActiveEnum<Value = String> + Iterable,
{
    EnumSchema {
        name: A::name().to_string(),
        values: A::iter().map(|variant| variant.to_value()).collect(),
    }
}

/// A column type as drizzle-kit writes it in a snapshot (`varchar(30)`,
/// `numeric(15, 2)`, `timestamp with time zone`, an enum's name).
pub fn sql_type(column_type: &ColumnType) -> String {
    match column_type {
        ColumnType::String(StringLen::N(length)) => format!("varchar({length})"),
        ColumnType::String(_) => "varchar".to_owned(),
        ColumnType::Char(Some(length)) => format!("char({length})"),
        ColumnType::Char(None) => "char".to_owned(),
        ColumnType::Text => "text".to_owned(),
        ColumnType::SmallInteger => "smallint".to_owned(),
        ColumnType::Integer => "integer".to_owned(),
        ColumnType::BigInteger => "bigint".to_owned(),
        ColumnType::Float => "real".to_owned(),
        ColumnType::Double => "double precision".to_owned(),
        ColumnType::Decimal(Some((precision, scale))) => format!("numeric({precision}, {scale})"),
        ColumnType::Decimal(None) => "numeric".to_owned(),
        ColumnType::Boolean => "boolean".to_owned(),
        ColumnType::Json => "json".to_owned(),
        ColumnType::JsonBinary => "jsonb".to_owned(),
        ColumnType::DateTime | ColumnType::Timestamp => "timestamp".to_owned(),
        ColumnType::TimestampWithTimeZone => "timestamp with time zone".to_owned(),
        ColumnType::Date => "date".to_owned(),
        ColumnType::Time => "time".to_owned(),
        ColumnType::Uuid => "uuid".to_owned(),
        ColumnType::Enum { name, .. } => name.to_string(),
        ColumnType::Vector(Some(dimensions)) => format!("vector({dimensions})"),
        ColumnType::Vector(None) => "vector".to_owned(),
        ColumnType::Array(inner) => format!("{}[]", sql_type(inner)),
        // Not in the schema today; the snapshot test names the column.
        other => format!("{other:?}"),
    }
}

fn default_json(default: ddl::Default) -> Value {
    match default {
        ddl::Default::Sql(text) => Value::String(text.to_owned()),
        ddl::Default::Number(text) => text
            .parse::<Number>()
            .map_or_else(|_| Value::String(text.to_owned()), Value::Number),
        ddl::Default::Bool(value) => Value::Bool(value),
    }
}

fn names(items: &[&str]) -> Value {
    Value::Array(
        items
            .iter()
            .map(|item| Value::String((*item).to_owned()))
            .collect(),
    )
}

/// `{ name: item }` for snapshot sections keyed by name.
fn by_name<T>(items: &[T], name: impl Fn(&T) -> &str, json: impl Fn(&T) -> Value) -> Value {
    Value::Object(
        items
            .iter()
            .map(|item| (name(item).to_owned(), json(item)))
            .collect(),
    )
}

fn column_json(column: &EntityColumn, extra: Option<&ddl::Column>, composite_key: bool) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), json!(column.name));
    let sql = extra
        .and_then(|extra| extra.sql_type)
        .map_or_else(|| sql_type(&column.column_type), str::to_owned);
    out.insert("type".into(), json!(sql));
    if matches!(column.column_type, ColumnType::Enum { .. }) {
        out.insert("typeSchema".into(), json!("public"));
    }
    out.insert(
        "primaryKey".into(),
        json!(column.primary_key && !composite_key),
    );
    out.insert("notNull".into(), json!(!column.nullable));
    if let Some(default) = extra.and_then(|extra| extra.default) {
        out.insert("default".into(), default_json(default));
    }
    if let Some(expression) = extra.and_then(|extra| extra.generated) {
        out.insert(
            "generated".into(),
            json!({ "as": expression, "type": "stored" }),
        );
    }
    Value::Object(out)
}

fn index_json(index: &ddl::Index) -> Value {
    let columns: Vec<Value> = index
        .columns
        .iter()
        .map(|column| {
            json!({
                "expression": column.expression,
                "isExpression": column.is_expression,
                "asc": column.asc,
                "nulls": "last",
            })
        })
        .collect();
    let mut out = json!({
        "name": index.name,
        "columns": columns,
        "isUnique": index.unique,
        "concurrently": false,
        "method": index.method,
        "with": {},
    });
    if let (Some(filter), Value::Object(map)) = (index.filter, &mut out) {
        map.insert("where".into(), json!(filter));
    }
    out
}

fn table_json(table: &TableSchema) -> Value {
    let ddl = table.ddl;
    let composite_key = ddl.primary_key.is_some();
    let columns: Map<String, Value> = table
        .columns
        .iter()
        .map(|column| {
            let extra = ddl.columns.iter().find(|extra| extra.name == column.name);
            (
                column.name.to_owned(),
                column_json(column, extra, composite_key),
            )
        })
        .collect();
    let foreign_keys = by_name(
        ddl.foreign_keys,
        |key| key.name,
        |key| {
            json!({
                "name": key.name,
                "tableFrom": ddl.name,
                "tableTo": key.references,
                "columnsFrom": names(key.columns),
                "columnsTo": names(key.referenced_columns),
                "onDelete": key.on_delete,
                "onUpdate": key.on_update,
            })
        },
    );
    let primary_keys: Vec<ddl::PrimaryKey> = ddl.primary_key.into_iter().collect();
    json!({
        "name": ddl.name,
        "schema": "",
        "columns": columns,
        "indexes": by_name(ddl.indexes, |index| index.name, index_json),
        "foreignKeys": foreign_keys,
        "compositePrimaryKeys": by_name(&primary_keys, |key| key.name, |key| {
            json!({ "name": key.name, "columns": names(key.columns) })
        }),
        "uniqueConstraints": by_name(ddl.uniques, |unique| unique.name, |unique| {
            json!({
                "name": unique.name,
                "nullsNotDistinct": unique.nulls_not_distinct,
                "columns": names(unique.columns),
            })
        }),
        "policies": {},
        "checkConstraints": by_name(ddl.checks, |check| check.name, |check| {
            json!({ "name": check.name, "value": check.expression })
        }),
        "isRLSEnabled": false,
    })
}

fn view_json(view: &ddl::View) -> Value {
    let columns: Value = serde_json::from_str(view.columns_json).unwrap_or_else(|_| json!({}));
    json!({
        "columns": columns,
        "definition": view.definition,
        "name": view.name,
        "schema": "public",
        "isExisting": false,
        "withNoData": view.with_no_data,
        "materialized": view.materialized,
    })
}

/// The snapshot of a database with these tables, enums and views, without
/// drizzle-kit's `id` and `prevId` (a migration's place in the journal, not
/// part of the schema).
pub fn snapshot(tables: &[TableSchema], enums: &[EnumSchema], views: &[ddl::View]) -> Value {
    let tables: Map<String, Value> = tables
        .iter()
        .map(|table| (format!("public.{}", table.ddl.name), table_json(table)))
        .collect();
    let enums: Map<String, Value> = enums
        .iter()
        .map(|e| {
            (
                format!("public.{}", e.name),
                json!({ "name": e.name, "schema": "public", "values": e.values }),
            )
        })
        .collect();
    let views: Map<String, Value> = views
        .iter()
        .map(|view| (format!("public.{}", view.name), view_json(view)))
        .collect();
    json!({
        "version": "7",
        "dialect": "postgresql",
        "tables": tables,
        "enums": enums,
        "schemas": {},
        "sequences": {},
        "roles": {},
        "policies": {},
        "views": views,
        "_meta": { "columns": {}, "schemas": {}, "tables": {} },
    })
}
