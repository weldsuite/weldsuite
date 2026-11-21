//! A table's definition as the migrations create it: SQL types, defaults,
//! indexes, constraints. The entity says how Rust reads and writes a row;
//! this says what Postgres holds. The snapshot builder (phase 1) turns every
//! table's [`Table`] into a drizzle-kit snapshot.

/// One table.
#[derive(Debug, Clone, Copy)]
pub struct Table {
    pub name: &'static str,
    pub columns: &'static [Column],
    /// A primary key over several columns; a single-column key is
    /// [`Column::primary_key`].
    pub primary_key: Option<PrimaryKey>,
    pub indexes: &'static [Index],
    pub foreign_keys: &'static [ForeignKey],
    pub uniques: &'static [Unique],
    pub checks: &'static [Check],
}

/// One column, as the snapshot has it.
#[derive(Debug, Clone, Copy)]
pub struct Column {
    pub name: &'static str,
    /// The SQL type as drizzle-kit writes it: `varchar(30)`, `numeric(15, 2)`,
    /// `timestamp with time zone`, an enum's name.
    pub sql_type: &'static str,
    pub not_null: bool,
    pub primary_key: bool,
    /// The default as SQL: `now()`, `'draft'`, `0`.
    pub default: Option<&'static str>,
    /// `GENERATED ALWAYS AS (…) STORED`: the expression.
    pub generated: Option<&'static str>,
}

#[derive(Debug, Clone, Copy)]
pub struct PrimaryKey {
    pub name: &'static str,
    pub columns: &'static [&'static str],
}

#[derive(Debug, Clone, Copy)]
pub struct Index {
    pub name: &'static str,
    pub columns: &'static [IndexColumn],
    pub unique: bool,
    /// `btree`, `gin`.
    pub method: &'static str,
    /// A partial index's `WHERE`.
    pub filter: Option<&'static str>,
}

#[derive(Debug, Clone, Copy)]
pub struct IndexColumn {
    /// A column name, or an SQL expression when `is_expression`.
    pub expression: &'static str,
    pub is_expression: bool,
    pub asc: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct ForeignKey {
    pub name: &'static str,
    pub columns: &'static [&'static str],
    pub references: &'static str,
    pub referenced_columns: &'static [&'static str],
    pub on_delete: &'static str,
    pub on_update: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct Unique {
    pub name: &'static str,
    pub columns: &'static [&'static str],
    pub nulls_not_distinct: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct Check {
    pub name: &'static str,
    pub expression: &'static str,
}
