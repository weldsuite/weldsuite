//! What a table's entity can't say about it: SQL defaults, generated
//! columns, indexes, constraints. The entity gives the columns (names, SQL
//! types, nullability, primary key); this gives the rest. [`crate::snapshot`]
//! puts the two together as a drizzle-kit snapshot, the schema state that
//! migrations are diffed against.

/// One table's DDL beyond its entity.
#[derive(Debug, Clone, Copy)]
pub struct Table {
    pub name: &'static str,
    /// The columns with something the entity doesn't carry; most have nothing
    /// and aren't listed.
    pub columns: &'static [Column],
    /// A primary key over several columns. A single-column key is the
    /// entity's `primary_key` field.
    pub primary_key: Option<PrimaryKey>,
    pub indexes: &'static [Index],
    pub foreign_keys: &'static [ForeignKey],
    pub uniques: &'static [Unique],
    pub checks: &'static [Check],
}

/// A column's DDL beyond its entity field.
#[derive(Debug, Clone, Copy)]
pub struct Column {
    pub name: &'static str,
    /// The SQL type, only where drizzle-kit spells it differently from what
    /// the entity's column type renders to (`timestamp  with time zone`).
    pub sql_type: Option<&'static str>,
    /// The column's `DEFAULT`.
    pub default: Option<Default>,
    /// `GENERATED ALWAYS AS (…) STORED`: the expression.
    pub generated: Option<&'static str>,
    /// The application fills the value on insert (Drizzle's `$defaultFn`,
    /// e.g. a prefixed id); Postgres has no default for it.
    pub default_fn: bool,
    /// The application rewrites the value on every update (Drizzle's
    /// `$onUpdate`, e.g. `updated_at`).
    pub on_update: bool,
}

/// A column default, typed as drizzle-kit records it.
#[derive(Debug, Clone, Copy)]
pub enum Default {
    /// SQL text: `now()`, `'draft'`, `'[]'::jsonb`.
    Sql(&'static str),
    /// A number literal, as written: `0`, `3600`.
    Number(&'static str),
    Bool(bool),
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

/// A materialized view. Views have no entity: their columns are query
/// expressions, typed by the database.
#[derive(Debug, Clone, Copy)]
pub struct View {
    pub name: &'static str,
    /// The `SELECT` it materializes.
    pub definition: &'static str,
    pub materialized: bool,
    /// `WITH NO DATA`: created empty, filled by `REFRESH MATERIALIZED VIEW`.
    pub with_no_data: bool,
    /// The columns drizzle-kit records for the view, as its snapshot JSON.
    pub columns_json: &'static str,
}
