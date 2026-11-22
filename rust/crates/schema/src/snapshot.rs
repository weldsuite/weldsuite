//! A database's schema as a drizzle-kit snapshot (version 7), built from the
//! entities and their DDL (ADR DATA-019): what the generator diffs the newest
//! journaled snapshot against, and writes as the new migration's snapshot.
//! `tests/snapshot.rs` checks that the entities build exactly the newest one.
//!
//! Each column comes from its entity: the name, the SQL type (rendered from
//! SeaORM's column type, as drizzle-kit spells it), nullability and the
//! primary key. The rest comes from [`crate::ddl`].

use indexmap::IndexMap;
use sea_orm::sea_query::{ColumnType, StringLen};
use sea_orm::{ActiveEnum, ColumnTrait, EntityTrait, IdenStatic, Iterable, PrimaryKeyToColumn};
use serde_json::{Number, Value};

use crate::{ddl, drizzle};

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

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn column(
    column: &EntityColumn,
    extra: Option<&ddl::Column>,
    composite_key: bool,
) -> drizzle::Column {
    drizzle::Column {
        name: column.name.to_owned(),
        sql_type: extra
            .and_then(|extra| extra.sql_type)
            .map_or_else(|| sql_type(&column.column_type), str::to_owned),
        type_schema: matches!(column.column_type, ColumnType::Enum { .. })
            .then(|| "public".to_owned()),
        primary_key: column.primary_key && !composite_key,
        not_null: !column.nullable,
        default: extra.and_then(|extra| extra.default).map(default_json),
        generated: extra
            .and_then(|extra| extra.generated)
            .map(|expression| drizzle::Generated {
                expression: expression.to_owned(),
                kind: "stored".to_owned(),
            }),
        identity: None,
        is_unique: None,
        unique_name: None,
        nulls_not_distinct: None,
    }
}

fn index(index: &ddl::Index) -> drizzle::Index {
    drizzle::Index {
        name: index.name.to_owned(),
        columns: index
            .columns
            .iter()
            .map(|column| drizzle::IndexColumn {
                expression: column.expression.to_owned(),
                is_expression: column.is_expression,
                asc: column.asc,
                nulls: Some("last".to_owned()),
                opclass: None,
            })
            .collect(),
        is_unique: index.unique,
        filter: index.filter.map(str::to_owned),
        concurrently: false,
        method: index.method.to_owned(),
        with: IndexMap::new(),
    }
}

fn table_snapshot(table: &TableSchema) -> drizzle::Table {
    let ddl = table.ddl;
    let composite_key = ddl.primary_key.is_some();
    let named = |name: &str| name.to_owned();
    drizzle::Table {
        name: ddl.name.to_owned(),
        schema: String::new(),
        columns: table
            .columns
            .iter()
            .map(|entity| {
                let extra = ddl.columns.iter().find(|extra| extra.name == entity.name);
                (named(entity.name), column(entity, extra, composite_key))
            })
            .collect(),
        indexes: ddl
            .indexes
            .iter()
            .map(|item| (named(item.name), index(item)))
            .collect(),
        foreign_keys: ddl
            .foreign_keys
            .iter()
            .map(|key| {
                let fk = drizzle::ForeignKey {
                    name: key.name.to_owned(),
                    table_from: ddl.name.to_owned(),
                    table_to: key.references.to_owned(),
                    columns_from: strings(key.columns),
                    columns_to: strings(key.referenced_columns),
                    on_delete: Some(key.on_delete.to_owned()),
                    on_update: Some(key.on_update.to_owned()),
                    schema_to: None,
                };
                (named(key.name), fk)
            })
            .collect(),
        composite_primary_keys: ddl
            .primary_key
            .iter()
            .map(|key| {
                let pk = drizzle::CompositePrimaryKey {
                    name: key.name.to_owned(),
                    columns: strings(key.columns),
                };
                (named(key.name), pk)
            })
            .collect(),
        unique_constraints: ddl
            .uniques
            .iter()
            .map(|unique| {
                let constraint = drizzle::Unique {
                    name: unique.name.to_owned(),
                    nulls_not_distinct: unique.nulls_not_distinct,
                    columns: strings(unique.columns),
                };
                (named(unique.name), constraint)
            })
            .collect(),
        policies: IndexMap::new(),
        check_constraints: ddl
            .checks
            .iter()
            .map(|check| {
                let constraint = drizzle::Check {
                    name: check.name.to_owned(),
                    value: check.expression.to_owned(),
                };
                (named(check.name), constraint)
            })
            .collect(),
        is_rls_enabled: false,
    }
}

fn view_snapshot(view: &ddl::View) -> drizzle::View {
    drizzle::View {
        columns: serde_json::from_str(view.columns_json).unwrap_or_default(),
        definition: Some(view.definition.to_owned()),
        name: view.name.to_owned(),
        schema: "public".to_owned(),
        is_existing: false,
        with_no_data: Some(view.with_no_data),
        materialized: view.materialized,
        with: None,
        using: None,
        tablespace: None,
    }
}

/// The snapshot of a database with these tables, enums and views, in their
/// order and without an `id` or `prevId`: what a migration generated from the
/// entities leaves the database as.
pub fn build(
    tables: &[TableSchema],
    enums: &[EnumSchema],
    views: &[ddl::View],
) -> drizzle::Snapshot {
    let mut snapshot = drizzle::Snapshot::empty();
    snapshot.tables = tables
        .iter()
        .map(|table| (format!("public.{}", table.ddl.name), table_snapshot(table)))
        .collect();
    snapshot.enums = enums
        .iter()
        .map(|e| {
            let schema = drizzle::Enum {
                name: e.name.clone(),
                schema: "public".to_owned(),
                values: e.values.clone(),
            };
            (format!("public.{}", e.name), schema)
        })
        .collect();
    snapshot.views = views
        .iter()
        .map(|view| (format!("public.{}", view.name), view_snapshot(view)))
        .collect();
    snapshot
}

/// [`build`] as JSON, without drizzle-kit's `id` and `prevId` (a migration's
/// place in the journal, not part of the schema).
pub fn snapshot(tables: &[TableSchema], enums: &[EnumSchema], views: &[ddl::View]) -> Value {
    serde_json::to_value(build(tables, enums, views)).unwrap_or(Value::Null)
}
