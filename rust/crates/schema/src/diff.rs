//! The migration differ (ADR DATA-019, plan phase 3): the SQL that takes a
//! database from one snapshot to the next.
//!
//! It writes what drizzle-kit 0.30 wrote, statement for statement and in its
//! order, for every kind of change the schema has used; `tests/differ.rs`
//! replays drizzle-kit's output for every pair of consecutive snapshots in
//! git history. drizzle-kit's quirks are kept on purpose, so a migration
//! reads like the ones before it: it compares constraints in their
//! "squashed" string form, emits `DISABLE ROW LEVEL SECURITY` for a dropped
//! table whenever another table is altered, and `SET DATA TYPE` takes the
//! snapshot's type text as it is.
//!
//! It refuses what it would have to guess, and what the schema doesn't use:
//! a table, column, enum or view that disappears while another appears
//! (drizzle-kit asks whether that is a rename), schemas, sequences, roles,
//! row-level security and policies, identity columns, a change to a
//! generated column, dropping a column's primary key, and view options.

use std::fmt;

use indexmap::IndexMap;
use serde_json::Value;

use crate::drizzle::{Column, Enum, Snapshot, Table, View};

/// What drizzle-kit writes between two statements of one migration file.
pub const BREAKPOINT: &str = "--> statement-breakpoint\n";

/// Why two snapshots can't be diffed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffError {
    /// Something disappears while something else appears: a rename,
    /// perhaps, which the differ never guesses.
    Ambiguous(Vec<String>),
    /// A change the differ doesn't write.
    Unsupported(Vec<String>),
}

impl fmt::Display for DiffError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ambiguous(found) => write!(f, "looks like a rename: {}", found.join("; ")),
            Self::Unsupported(found) => write!(f, "not supported: {}", found.join("; ")),
        }
    }
}

impl std::error::Error for DiffError {}

/// What to do when something disappears while something else appears.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ambiguity {
    /// Stop with [`DiffError::Ambiguous`]: the generator's choice.
    Refuse,
    /// Drop the old and create the new, as drizzle-kit did when told nothing
    /// was renamed (the history replay).
    DropAndCreate,
}

/// The statements that take a database at `prev` to `next`, as drizzle-kit
/// writes them (joined with [`BREAKPOINT`] in a migration file). Refuses
/// anything that could be a rename.
pub fn diff(prev: &Snapshot, next: &Snapshot) -> Result<Vec<String>, DiffError> {
    diff_with(prev, next, Ambiguity::Refuse)
}

/// [`diff`], choosing what an apparent rename does.
pub fn diff_with(
    prev: &Snapshot,
    next: &Snapshot,
    ambiguity: Ambiguity,
) -> Result<Vec<String>, DiffError> {
    let ambiguous = ambiguities(prev, next);
    if ambiguity == Ambiguity::Refuse && !ambiguous.is_empty() {
        return Err(DiffError::Ambiguous(ambiguous));
    }
    let mut out = Differ {
        prev,
        next,
        unsupported: unsupported(prev, next),
        groups: Groups::default(),
    };
    out.run();
    if !out.unsupported.is_empty() {
        return Err(DiffError::Unsupported(out.unsupported));
    }
    Ok(out.groups.into_statements())
}

/// Keys of `next` not in `prev` (in `next`'s order), and of `prev` not in
/// `next` (in `prev`'s order).
fn added_and_gone<'a, V>(
    prev: &'a IndexMap<String, V>,
    next: &'a IndexMap<String, V>,
) -> (Vec<&'a String>, Vec<&'a String>) {
    let added = next.keys().filter(|key| !prev.contains_key(*key)).collect();
    let gone = prev.keys().filter(|key| !next.contains_key(*key)).collect();
    (added, gone)
}

fn ambiguities(prev: &Snapshot, next: &Snapshot) -> Vec<String> {
    fn check<V>(
        label: &str,
        prev: &IndexMap<String, V>,
        next: &IndexMap<String, V>,
        out: &mut Vec<String>,
    ) {
        let (added, gone) = added_and_gone(prev, next);
        if !added.is_empty() && !gone.is_empty() {
            out.push(format!(
                "{label}: {} gone and {} new",
                join(&gone),
                join(&added)
            ));
        }
    }
    let mut found = Vec::new();
    check("tables", &prev.tables, &next.tables, &mut found);
    for (key, table) in &next.tables {
        if let Some(before) = prev.tables.get(key) {
            check(
                &format!("{key}: columns"),
                &before.columns,
                &table.columns,
                &mut found,
            );
        }
    }
    check("enums", &prev.enums, &next.enums, &mut found);
    check("views", &prev.views, &next.views, &mut found);
    found
}

fn join(keys: &[&String]) -> String {
    keys.iter()
        .map(|key| key.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Changes outside what the differ writes, found before diffing.
fn unsupported(prev: &Snapshot, next: &Snapshot) -> Vec<String> {
    let mut found = Vec::new();
    if prev.schemas != next.schemas {
        found.push("schemas".to_owned());
    }
    if prev.sequences != next.sequences {
        found.push("sequences".to_owned());
    }
    if prev.roles != next.roles {
        found.push("roles".to_owned());
    }
    if prev.policies != next.policies {
        found.push("policies".to_owned());
    }
    for (key, table) in &next.tables {
        if table.is_rls_enabled || !table.policies.is_empty() {
            found.push(format!("{key}: row-level security or policies"));
        }
        if table
            .columns
            .values()
            .any(|column| column.identity.is_some())
        {
            found.push(format!("{key}: identity columns"));
        }
    }
    found
}

/// `"name"`, or `"schema"."name"` when the schema isn't empty.
fn qualified(schema: &str, name: &str) -> String {
    if schema.is_empty() {
        format!("\"{name}\"")
    } else {
        format!("\"{schema}\".\"{name}\"")
    }
}

/// A JSON value as JavaScript's template literals print it.
fn js_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        other => other.to_string(),
    }
}

/// JavaScript truthiness.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// JSON equality as JavaScript sees it (`1` and `1.0` are one number).
fn same_value(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

/// drizzle-kit's native types; any other type is quoted as a user type.
const PG_NATIVE_TYPES: &[&str] = &[
    "uuid",
    "smallint",
    "integer",
    "bigint",
    "boolean",
    "text",
    "varchar",
    "serial",
    "bigserial",
    "decimal",
    "numeric",
    "real",
    "json",
    "jsonb",
    "time",
    "time with time zone",
    "time without time zone",
    "timestamp",
    "timestamp with time zone",
    "timestamp without time zone",
    "date",
    "interval",
    "double precision",
    "interval year",
    "interval month",
    "interval day",
    "interval hour",
    "interval minute",
    "interval second",
    "interval year to month",
    "interval day to hour",
    "interval day to minute",
    "interval day to second",
    "interval hour to minute",
    "interval hour to second",
    "interval minute to second",
    "char",
    "vector",
    "geometry",
];

/// drizzle-kit's `parseType`: a native type as it is, a user type quoted (and
/// schema-qualified outside `public`), array brackets kept at the end.
fn parse_type(type_schema: Option<&str>, sql_type: &str) -> String {
    let mut without = String::new();
    let mut arrays = String::new();
    let mut rest = sql_type;
    while let Some(open) = rest.find('[') {
        let tail = &rest[open + 1..];
        let digits = tail.chars().take_while(char::is_ascii_digit).count();
        if tail[digits..].starts_with(']') {
            without.push_str(&rest[..open]);
            arrays.push_str(&rest[open..open + digits + 2]);
            rest = &rest[open + digits + 2..];
        } else {
            without.push_str(&rest[..=open]);
            rest = tail;
        }
    }
    without.push_str(rest);
    if PG_NATIVE_TYPES
        .iter()
        .any(|native| sql_type.starts_with(native))
    {
        format!("{without}{arrays}")
    } else {
        let prefix = type_schema
            .filter(|schema| !schema.is_empty() && *schema != "public")
            .map(|schema| format!("\"{schema}\"."))
            .unwrap_or_default();
        format!("{prefix}\"{without}\"{arrays}")
    }
}

// ── drizzle-kit's squashed forms ────────────────────────────────────────────
//
// drizzle-kit compares indexes and constraints as these strings and builds
// their SQL from the strings split again, so a value holding a separator
// comes out as drizzle-kit wrote it.

fn opt(value: Option<&str>) -> &str {
    value.unwrap_or("undefined")
}

fn squash_index(index: &crate::drizzle::Index) -> String {
    let columns: Vec<String> = index
        .columns
        .iter()
        .map(|c| {
            let opclass = c.opclass.as_deref().filter(|s| !s.is_empty()).unwrap_or("");
            format!(
                "{}--{}--{}--{}--{opclass}",
                c.expression,
                c.is_expression,
                c.asc,
                opt(c.nulls.as_deref())
            )
        })
        .collect();
    let with = serde_json::to_string(&index.with).unwrap_or_else(|_| "{}".to_owned());
    format!(
        "{};{};{};{};{};{};{with}",
        index.name,
        columns.join(",,"),
        index.is_unique,
        index.concurrently,
        index.method,
        opt(index.filter.as_deref()),
    )
}

struct IndexParts<'a> {
    name: &'a str,
    columns: Vec<IndexColumnParts<'a>>,
    unique: bool,
    concurrently: bool,
    method: &'a str,
    filter: Option<&'a str>,
    with: IndexMap<String, Value>,
}

struct IndexColumnParts<'a> {
    expression: &'a str,
    is_expression: bool,
    asc: bool,
    nulls: &'a str,
    opclass: Option<&'a str>,
}

fn unsquash_index(squashed: &str) -> IndexParts<'_> {
    let parts: Vec<&str> = squashed.split(';').collect();
    let part = |i: usize| parts.get(i).copied().unwrap_or("undefined");
    let columns = part(1)
        .split(",,")
        .map(|column| {
            let pieces: Vec<&str> = column.split("--").collect();
            let piece = |i: usize| pieces.get(i).copied().unwrap_or("undefined");
            IndexColumnParts {
                expression: piece(0),
                is_expression: piece(1) == "true",
                asc: piece(2) == "true",
                nulls: piece(3),
                opclass: Some(piece(4)).filter(|s| *s != "undefined" && !s.is_empty()),
            }
        })
        .collect();
    let with_text = parts
        .get(6)
        .copied()
        .filter(|s| !s.is_empty() && *s != "undefined");
    IndexParts {
        name: part(0),
        columns,
        unique: part(2) == "true",
        concurrently: part(3) == "true",
        method: part(4),
        filter: Some(part(5)).filter(|s| *s != "undefined"),
        with: with_text
            .and_then(|text| serde_json::from_str(text).ok())
            .unwrap_or_default(),
    }
}

fn squash_foreign_key(fk: &crate::drizzle::ForeignKey) -> String {
    format!(
        "{};{};{};{};{};{};{};{}",
        fk.name,
        fk.table_from,
        fk.columns_from.join(","),
        fk.table_to,
        fk.columns_to.join(","),
        fk.on_update.as_deref().unwrap_or(""),
        fk.on_delete.as_deref().unwrap_or(""),
        fk.schema_to
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("public"),
    )
}

fn squash_primary_key(pk: &crate::drizzle::CompositePrimaryKey) -> String {
    format!("{};{}", pk.columns.join(","), pk.name)
}

/// (name, columns) of a squashed primary key.
fn unsquash_primary_key(squashed: &str) -> (String, Vec<String>) {
    let mut parts = squashed.split(';');
    let columns = parts
        .next()
        .unwrap_or_default()
        .split(',')
        .map(str::to_owned)
        .collect();
    let name = parts.next().unwrap_or("undefined").to_owned();
    (name, columns)
}

fn squash_unique(unique: &crate::drizzle::Unique) -> String {
    format!(
        "{};{};{}",
        unique.name,
        unique.columns.join(","),
        unique.nulls_not_distinct
    )
}

fn squash_check(check: &crate::drizzle::Check) -> String {
    format!("{};{}", check.name, check.value)
}

/// The first two `;`-separated parts, as JavaScript's `split(";")` destructures them.
fn two_parts(squashed: &str) -> (&str, &str) {
    let mut parts = squashed.split(';');
    (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or("undefined"),
    )
}

// ── SQL ─────────────────────────────────────────────────────────────────────

fn create_index_sql(schema: &str, table: &str, squashed: &str) -> String {
    let index = unsquash_index(squashed);
    let columns: Vec<String> = index
        .columns
        .iter()
        .map(|c| {
            let expression = if c.is_expression {
                c.expression.to_owned()
            } else {
                format!("\"{}\"", c.expression)
            };
            let order = match c.opclass {
                Some(opclass) => format!(" {opclass}"),
                None if c.asc => String::new(),
                None => " DESC".to_owned(),
            };
            let nulls = if (c.asc && c.nulls == "last") || c.opclass.is_some() {
                String::new()
            } else {
                format!(" NULLS {}", c.nulls.to_uppercase())
            };
            format!("{expression}{order}{nulls}")
        })
        .collect();
    let with = if index.with.is_empty() {
        String::new()
    } else {
        let pairs: Vec<String> = index
            .with
            .iter()
            .map(|(k, v)| format!("{k}={}", js_text(v)))
            .collect();
        format!(" WITH ({})", pairs.join(","))
    };
    let filter = index
        .filter
        .map(|w| format!(" WHERE {w}"))
        .unwrap_or_default();
    format!(
        "CREATE {}{} \"{}\" ON {} USING {} ({}){with}{filter};",
        if index.unique {
            "UNIQUE INDEX"
        } else {
            "INDEX"
        },
        if index.concurrently {
            " CONCURRENTLY"
        } else {
            ""
        },
        index.name,
        qualified(schema, table),
        index.method,
        columns.join(","),
    )
}

fn drop_index_sql(schema: &str, squashed: &str) -> String {
    let name = squashed.split(';').next().unwrap_or_default();
    format!("DROP INDEX {};", qualified(schema, name))
}

fn create_foreign_key_sql(schema: &str, squashed: &str) -> String {
    let parts: Vec<&str> = squashed.split(';').collect();
    let part = |i: usize| parts.get(i).copied().unwrap_or("");
    let quoted = |list: &str| {
        list.split(',')
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(",")
    };
    let on_delete = Some(part(6))
        .filter(|s| !s.is_empty())
        .map(|s| format!(" ON DELETE {s}"))
        .unwrap_or_default();
    let on_update = Some(part(5))
        .filter(|s| !s.is_empty())
        .map(|s| format!(" ON UPDATE {s}"))
        .unwrap_or_default();
    format!(
        "ALTER TABLE {} ADD CONSTRAINT \"{}\" FOREIGN KEY ({}) REFERENCES {}({}){on_delete}{on_update};",
        qualified(schema, part(1)),
        part(0),
        quoted(part(2)),
        qualified(part(7), part(3)),
        quoted(part(4)),
    )
}

fn drop_foreign_key_sql(schema: &str, table: &str, squashed: &str) -> String {
    let name = squashed.split(';').next().unwrap_or_default();
    format!(
        "ALTER TABLE {} DROP CONSTRAINT \"{name}\";\n",
        qualified(schema, table)
    )
}

fn column_definition(column: &Column, create_table: bool) -> String {
    let primary_key = if column.primary_key {
        " PRIMARY KEY"
    } else {
        ""
    };
    let default = column
        .default
        .as_ref()
        .map(|value| format!(" DEFAULT {}", js_text(value)))
        .unwrap_or_default();
    let generated = column
        .generated
        .as_ref()
        .map(|g| format!(" GENERATED ALWAYS AS ({}) STORED", g.expression))
        .unwrap_or_default();
    let not_null = if column.not_null && !(create_table && column.identity.is_some()) {
        " NOT NULL"
    } else {
        ""
    };
    let unique = if create_table && truthy(column.is_unique.as_ref()) {
        format!(
            " CONSTRAINT \"{}\" UNIQUE{}",
            column.unique_name.as_deref().unwrap_or("undefined"),
            if column.nulls_not_distinct == Some(true) {
                " NULLS NOT DISTINCT"
            } else {
                ""
            }
        )
    } else {
        String::new()
    };
    format!(
        "\"{}\" {}{primary_key}{default}{generated}{not_null}{unique}",
        column.name,
        parse_type(column.type_schema.as_deref(), &column.sql_type),
    )
}

fn create_table_sql(table: &Table) -> String {
    let mut lines: Vec<String> = table
        .columns
        .values()
        .map(|column| format!("\t{}", column_definition(column, true)))
        .collect();
    if let Some(pk) = table.composite_primary_keys.values().next() {
        let (_, columns) = unsquash_primary_key(&squash_primary_key(pk));
        lines.push(format!(
            "\tCONSTRAINT \"{}\" PRIMARY KEY(\"{}\")",
            pk.name,
            columns.join("\",\"")
        ));
    }
    for unique in table.unique_constraints.values() {
        let squashed = squash_unique(unique);
        let parts: Vec<&str> = squashed.split(';').collect();
        lines.push(format!(
            "\tCONSTRAINT \"{}\" UNIQUE{}(\"{}\")",
            parts[0],
            if parts.get(2) == Some(&"true") {
                " NULLS NOT DISTINCT"
            } else {
                ""
            },
            parts
                .get(1)
                .copied()
                .unwrap_or_default()
                .split(',')
                .collect::<Vec<_>>()
                .join("\",\""),
        ));
    }
    for check in table.check_constraints.values() {
        let squashed = squash_check(check);
        let (name, value) = two_parts(&squashed);
        lines.push(format!("\tCONSTRAINT \"{name}\" CHECK ({value})"));
    }
    format!(
        "CREATE TABLE {} (\n{}\n);\n",
        qualified(&table.schema, &table.name),
        lines.join(",\n")
    )
}

fn create_enum_sql(e: &Enum) -> String {
    let values: Vec<String> = e
        .values
        .iter()
        .map(|v| format!("'{}'", v.replace('\'', "''")))
        .collect();
    format!(
        "CREATE TYPE {} AS ENUM({});",
        qualified(&e.schema, &e.name),
        values.join(", ")
    )
}

fn create_view_sql(view: &View) -> String {
    let kind = if view.materialized {
        "CREATE MATERIALIZED VIEW"
    } else {
        "CREATE VIEW"
    };
    let definition = view.definition.as_deref().unwrap_or("undefined");
    let no_data = if view.with_no_data == Some(true) {
        " WITH NO DATA"
    } else {
        ""
    };
    format!(
        "{kind} {} AS ({definition}){no_data};",
        qualified(&view.schema, &view.name)
    )
}

fn drop_view_sql(view: &View) -> String {
    format!(
        "DROP{} VIEW {};",
        if view.materialized {
            " MATERIALIZED"
        } else {
            ""
        },
        qualified(&view.schema, &view.name)
    )
}

// ── The diff ────────────────────────────────────────────────────────────────

/// drizzle-kit's statement groups, in the order it writes them.
#[derive(Default)]
struct Groups {
    create_enums: Vec<String>,
    add_enum_values: Vec<(String, String)>,
    create_tables: Vec<String>,
    disable_rls: Vec<String>,
    drop_views: Vec<String>,
    drop_tables: Vec<String>,
    drop_uniques: Vec<String>,
    drop_checks: Vec<String>,
    drop_foreign_keys: Vec<String>,
    drop_indexes: Vec<String>,
    drop_altered_indexes: Vec<String>,
    drop_primary_keys: Vec<String>,
    alter_columns: Vec<String>,
    add_primary_keys: Vec<String>,
    add_columns: Vec<String>,
    created_tables_foreign_keys: Vec<String>,
    created_tables_indexes: Vec<String>,
    add_foreign_keys: Vec<String>,
    create_indexes: Vec<String>,
    create_altered_indexes: Vec<String>,
    drop_columns: Vec<String>,
    alter_primary_keys: Vec<String>,
    add_uniques: Vec<String>,
    add_checks: Vec<String>,
    drop_enum_values: Vec<(String, Vec<String>)>,
    create_views: Vec<String>,
    drop_enums: Vec<String>,
}

impl Groups {
    fn into_statements(self) -> Vec<String> {
        // An enum that loses a value is rebuilt, so its added values go.
        let rebuilt: Vec<String> = self
            .drop_enum_values
            .iter()
            .map(|(key, _)| key.clone())
            .collect();
        let add_values: Vec<String> = self
            .add_enum_values
            .into_iter()
            .filter(|(key, _)| !rebuilt.contains(key))
            .map(|(_, sql)| sql)
            .collect();
        let all = self
            .create_enums
            .into_iter()
            .chain(add_values)
            .chain(self.create_tables)
            .chain(self.disable_rls)
            .chain(self.drop_views)
            .chain(self.drop_tables)
            .chain(self.drop_uniques)
            .chain(self.drop_checks)
            .chain(self.drop_foreign_keys)
            .chain(self.drop_indexes)
            .chain(self.drop_altered_indexes)
            .chain(self.drop_primary_keys)
            .chain(self.alter_columns)
            .chain(self.add_primary_keys)
            .chain(self.add_columns)
            .chain(self.created_tables_foreign_keys)
            .chain(self.created_tables_indexes)
            .chain(self.add_foreign_keys)
            .chain(self.create_indexes)
            .chain(self.create_altered_indexes)
            .chain(self.drop_columns)
            .chain(self.alter_primary_keys)
            .chain(self.add_uniques)
            .chain(self.add_checks)
            .chain(self.drop_enum_values.into_iter().flat_map(|(_, sql)| sql))
            .chain(self.create_views)
            .chain(self.drop_enums);
        let mut unique: Vec<String> = Vec::new();
        for statement in all {
            if !unique.contains(&statement) {
                unique.push(statement);
            }
        }
        unique
    }
}

struct Differ<'a> {
    prev: &'a Snapshot,
    next: &'a Snapshot,
    unsupported: Vec<String>,
    groups: Groups,
}

/// The keys of two maps that are in both and differ, in `prev`'s order.
fn changed<'a, V, F>(
    prev: &'a IndexMap<String, V>,
    next: &'a IndexMap<String, V>,
    squash: F,
) -> Vec<(&'a String, String, String)>
where
    F: Fn(&V) -> String,
{
    prev.iter()
        .filter_map(|(key, old)| {
            let new = next.get(key)?;
            let (old, new) = (squash(old), squash(new));
            (old != new).then_some((key, old, new))
        })
        .collect()
}

fn added<V, F>(prev: &IndexMap<String, V>, next: &IndexMap<String, V>, squash: F) -> Vec<String>
where
    F: Fn(&V) -> String,
{
    next.iter()
        .filter(|(key, _)| !prev.contains_key(*key))
        .map(|(_, v)| squash(v))
        .collect()
}

fn gone<V, F>(prev: &IndexMap<String, V>, next: &IndexMap<String, V>, squash: F) -> Vec<String>
where
    F: Fn(&V) -> String,
{
    prev.iter()
        .filter(|(key, _)| !next.contains_key(*key))
        .map(|(_, v)| squash(v))
        .collect()
}

/// Whether a column differs in anything drizzle-kit compares.
fn column_changed(old: &Column, new: &Column) -> bool {
    old.name != new.name
        || old.sql_type != new.sql_type
        || old.type_schema != new.type_schema
        || old.primary_key != new.primary_key
        || old.not_null != new.not_null
        || !same_value(old.default.as_ref(), new.default.as_ref())
        || old.generated != new.generated
        || old.identity != new.identity
        || !same_value(old.is_unique.as_ref(), new.is_unique.as_ref())
        || old.unique_name != new.unique_name
        || old.nulls_not_distinct != new.nulls_not_distinct
}

/// Whether a kept table differs in anything but added or dropped columns:
/// drizzle-kit's "altered" tables.
fn table_altered(old: &Table, new: &Table) -> bool {
    let columns = old.columns.iter().any(|(key, column)| {
        new.columns
            .get(key)
            .is_some_and(|other| column_changed(column, other))
    });
    let squashed = |a: &Table, b: &Table| {
        let indexes = |t: &Table| {
            t.indexes
                .iter()
                .map(|(k, v)| (k.clone(), squash_index(v)))
                .collect::<Vec<_>>()
        };
        let fks = |t: &Table| {
            t.foreign_keys
                .iter()
                .map(|(k, v)| (k.clone(), squash_foreign_key(v)))
                .collect::<Vec<_>>()
        };
        let pks = |t: &Table| {
            t.composite_primary_keys
                .iter()
                .map(|(k, v)| (k.clone(), squash_primary_key(v)))
                .collect::<Vec<_>>()
        };
        let uniques = |t: &Table| {
            t.unique_constraints
                .iter()
                .map(|(k, v)| (k.clone(), squash_unique(v)))
                .collect::<Vec<_>>()
        };
        let checks = |t: &Table| {
            t.check_constraints
                .iter()
                .map(|(k, v)| (k.clone(), squash_check(v)))
                .collect::<Vec<_>>()
        };
        let sorted = |mut v: Vec<(String, String)>| {
            v.sort();
            v
        };
        sorted(indexes(a)) != sorted(indexes(b))
            || sorted(fks(a)) != sorted(fks(b))
            || sorted(pks(a)) != sorted(pks(b))
            || sorted(uniques(a)) != sorted(uniques(b))
            || sorted(checks(a)) != sorted(checks(b))
            || a.policies != b.policies
            || a.is_rls_enabled != b.is_rls_enabled
    };
    columns || squashed(old, new)
}

impl Differ<'_> {
    fn run(&mut self) {
        self.enums();
        self.created_and_dropped_tables();
        self.kept_tables();
        self.views();
    }

    fn enums(&mut self) {
        let (prev, next) = {
            let (a, b) = (self.prev, self.next);
            (&a.enums, &b.enums)
        };
        let (new, old) = added_and_gone(prev, next);
        for key in new {
            self.groups.create_enums.push(create_enum_sql(&next[key]));
        }
        for (key, before) in prev {
            let Some(after) = next.get(key) else { continue };
            if before == after {
                continue;
            }
            let name = qualified(&before.schema, &before.name);
            for (value, following) in added_values(&before.values, &after.values) {
                let position = if following.is_empty() {
                    String::new()
                } else {
                    format!(" BEFORE '{following}'")
                };
                self.groups.add_enum_values.push((
                    key.clone(),
                    format!("ALTER TYPE {name} ADD VALUE '{value}'{position};"),
                ));
            }
            let dropped = before
                .values
                .iter()
                .any(|value| !after.values.contains(value));
            if dropped {
                let rebuild = self.rebuild_enum(before, after);
                self.groups.drop_enum_values.push((key.clone(), rebuild));
            }
        }
        for key in old {
            let e = &prev[key];
            self.groups
                .drop_enums
                .push(format!("DROP TYPE {};", qualified(&e.schema, &e.name)));
        }
    }

    /// drizzle-kit's rebuild of an enum that loses a value: its columns to
    /// text, the type dropped and created again, the columns cast back.
    fn rebuild_enum(&self, before: &Enum, after: &Enum) -> Vec<String> {
        let mut columns = Vec::new();
        for table in self.next.tables.values() {
            for column in table.columns.values() {
                if column.sql_type == before.name
                    && column.type_schema.as_deref() == Some(before.schema.as_str())
                {
                    let schema = if table.schema.is_empty() {
                        "public"
                    } else {
                        &table.schema
                    };
                    columns.push((schema.to_owned(), table.name.clone(), column.name.clone()));
                }
            }
        }
        let mut sql: Vec<String> = columns
            .iter()
            .map(|(schema, table, column)| format!("ALTER TABLE \"{schema}\".\"{table}\" ALTER COLUMN \"{column}\" SET DATA TYPE text;"))
            .collect();
        sql.push(format!(
            "DROP TYPE {};",
            qualified(&before.schema, &before.name)
        ));
        sql.push(create_enum_sql(&Enum {
            name: before.name.clone(),
            schema: before.schema.clone(),
            values: after.values.clone(),
        }));
        let type_name = format!("\"{}\".\"{}\"", before.schema, before.name);
        sql.extend(columns.iter().map(|(schema, table, column)| {
            format!("ALTER TABLE \"{schema}\".\"{table}\" ALTER COLUMN \"{column}\" SET DATA TYPE {type_name} USING \"{column}\"::{type_name};")
        }));
        sql
    }

    fn created_and_dropped_tables(&mut self) {
        let (prev, next) = {
            let (a, b) = (self.prev, self.next);
            (&a.tables, &b.tables)
        };
        let (new, old) = added_and_gone(prev, next);
        for key in &new {
            let table = &next[*key];
            self.groups.create_tables.push(create_table_sql(table));
            for fk in table.foreign_keys.values() {
                self.groups
                    .created_tables_foreign_keys
                    .push(create_foreign_key_sql(
                        &table.schema,
                        &squash_foreign_key(fk),
                    ));
            }
            for index in table.indexes.values() {
                self.groups.created_tables_indexes.push(create_index_sql(
                    &table.schema,
                    &table.name,
                    &squash_index(index),
                ));
            }
        }
        for key in &old {
            let table = &prev[*key];
            self.groups.drop_tables.push(format!(
                "DROP TABLE {} CASCADE;",
                qualified(&table.schema, &table.name)
            ));
        }
    }

    fn kept_tables(&mut self) {
        let (prev, next) = (self.prev, self.next);
        let mut any_altered = false;
        for (key, before) in &prev.tables {
            let Some(after) = next.tables.get(key) else {
                continue;
            };
            let schema = after.schema.as_str();
            // Added and dropped columns: every table that differs at all.
            for column in after
                .columns
                .values()
                .filter(|c| !before.columns.contains_key(&c.name))
            {
                self.groups.add_columns.push(format!(
                    "ALTER TABLE {} ADD COLUMN {};",
                    qualified(schema, &after.name),
                    column_definition(column, false)
                ));
            }
            for column in before
                .columns
                .values()
                .filter(|c| !after.columns.contains_key(&c.name))
            {
                self.groups.drop_columns.push(format!(
                    "ALTER TABLE {} DROP COLUMN \"{}\";",
                    qualified(schema, &after.name),
                    column.name
                ));
            }
            if table_altered(before, after) {
                any_altered = true;
                self.altered_table(key, before, after);
            }
        }
        if any_altered {
            for (key, table) in &prev.tables {
                if !next.tables.contains_key(key) && !table.is_rls_enabled {
                    self.groups.disable_rls.push(format!(
                        "ALTER TABLE {} DISABLE ROW LEVEL SECURITY;",
                        qualified(&table.schema, &table.name)
                    ));
                }
            }
        }
    }

    fn altered_table(&mut self, key: &str, before: &Table, after: &Table) {
        let schema = after.schema.as_str();
        let table = qualified(schema, &after.name);

        // Composite primary keys.
        let pks_added = added(
            &before.composite_primary_keys,
            &after.composite_primary_keys,
            squash_primary_key,
        );
        let pks_gone = gone(
            &before.composite_primary_keys,
            &after.composite_primary_keys,
            squash_primary_key,
        );
        if pks_added.last().map(|s| unsquash_primary_key(s))
            != pks_gone.last().map(|s| unsquash_primary_key(s))
        {
            for pk in &pks_added {
                let (name, columns) = unsquash_primary_key(pk);
                self.groups.add_primary_keys.push(format!(
                    "ALTER TABLE {table} ADD CONSTRAINT \"{name}\" PRIMARY KEY(\"{}\");",
                    columns.join("\",\"")
                ));
            }
            for pk in &pks_gone {
                let (name, _) = unsquash_primary_key(pk);
                self.groups
                    .drop_primary_keys
                    .push(format!("ALTER TABLE {table} DROP CONSTRAINT \"{name}\";"));
            }
        }
        for (_, old, new) in changed(
            &before.composite_primary_keys,
            &after.composite_primary_keys,
            squash_primary_key,
        ) {
            let (old_name, _) = unsquash_primary_key(&old);
            let (new_name, columns) = unsquash_primary_key(&new);
            self.groups.alter_primary_keys.push(format!(
                "ALTER TABLE {table} DROP CONSTRAINT \"{old_name}\";\n{BREAKPOINT}ALTER TABLE {table} ADD CONSTRAINT \"{new_name}\" PRIMARY KEY(\"{}\");",
                columns.join("\",\"")
            ));
        }

        // Unique constraints, then checks: the added and altered ones' new
        // forms are added, the dropped and altered ones' old forms dropped.
        let unique_sql = |squashed: &str| {
            let parts: Vec<&str> = squashed.split(';').collect();
            format!(
                "ALTER TABLE {table} ADD CONSTRAINT \"{}\" UNIQUE{}(\"{}\");",
                parts[0],
                if parts.get(2) == Some(&"true") {
                    " NULLS NOT DISTINCT"
                } else {
                    ""
                },
                parts
                    .get(1)
                    .copied()
                    .unwrap_or_default()
                    .split(',')
                    .collect::<Vec<_>>()
                    .join("\",\"")
            )
        };
        let drop_constraint = |squashed: &str| {
            format!(
                "ALTER TABLE {table} DROP CONSTRAINT \"{}\";",
                two_parts(squashed).0
            )
        };
        let uniques_changed = changed(
            &before.unique_constraints,
            &after.unique_constraints,
            squash_unique,
        );
        for squashed in added(
            &before.unique_constraints,
            &after.unique_constraints,
            squash_unique,
        )
        .iter()
        .chain(uniques_changed.iter().map(|(_, _, new)| new))
        {
            self.groups.add_uniques.push(unique_sql(squashed));
        }
        for squashed in gone(
            &before.unique_constraints,
            &after.unique_constraints,
            squash_unique,
        )
        .iter()
        .chain(uniques_changed.iter().map(|(_, old, _)| old))
        {
            self.groups.drop_uniques.push(drop_constraint(squashed));
        }
        let checks_changed = changed(
            &before.check_constraints,
            &after.check_constraints,
            squash_check,
        );
        for squashed in added(
            &before.check_constraints,
            &after.check_constraints,
            squash_check,
        )
        .iter()
        .chain(checks_changed.iter().map(|(_, _, new)| new))
        {
            let (name, value) = two_parts(squashed);
            self.groups.add_checks.push(format!(
                "ALTER TABLE {table} ADD CONSTRAINT \"{name}\" CHECK ({value});"
            ));
        }
        for squashed in gone(
            &before.check_constraints,
            &after.check_constraints,
            squash_check,
        )
        .iter()
        .chain(checks_changed.iter().map(|(_, old, _)| old))
        {
            self.groups.drop_checks.push(drop_constraint(squashed));
        }

        // Altered columns.
        self.altered_columns(key, before, after);

        // Indexes: the added ones, then (after every table's) the altered ones.
        for squashed in added(&before.indexes, &after.indexes, squash_index) {
            self.groups
                .create_indexes
                .push(create_index_sql(schema, &after.name, &squashed));
        }
        for squashed in gone(&before.indexes, &after.indexes, squash_index) {
            self.groups
                .drop_indexes
                .push(drop_index_sql(schema, &squashed));
        }
        for (_, old, new) in changed(&before.indexes, &after.indexes, squash_index) {
            self.groups
                .create_altered_indexes
                .push(create_index_sql(schema, &after.name, &new));
            self.groups
                .drop_altered_indexes
                .push(drop_index_sql(schema, &old));
        }

        // Foreign keys: added, dropped, then each altered one dropped and added.
        for squashed in added(
            &before.foreign_keys,
            &after.foreign_keys,
            squash_foreign_key,
        ) {
            self.groups
                .add_foreign_keys
                .push(create_foreign_key_sql(schema, &squashed));
        }
        for squashed in gone(
            &before.foreign_keys,
            &after.foreign_keys,
            squash_foreign_key,
        ) {
            self.groups.drop_foreign_keys.push(drop_foreign_key_sql(
                schema,
                &after.name,
                &squashed,
            ));
        }
        for (_, old, new) in changed(
            &before.foreign_keys,
            &after.foreign_keys,
            squash_foreign_key,
        ) {
            self.groups
                .drop_foreign_keys
                .push(drop_foreign_key_sql(schema, &after.name, &old));
            self.groups
                .add_foreign_keys
                .push(create_foreign_key_sql(schema, &new));
        }
    }

    fn altered_columns(&mut self, key: &str, before: &Table, after: &Table) {
        let table = qualified(&after.schema, &after.name);
        let mut set_pks = Vec::new();
        let mut statements = Vec::new();
        for (name, old) in &before.columns {
            let Some(new) = after.columns.get(name) else {
                continue;
            };
            if !column_changed(old, new) {
                continue;
            }
            let type_changed = old.sql_type != new.sql_type;
            if type_changed
                && old.sql_type.replacen(" (", "(", 1) == new.sql_type.replacen(" (", "(", 1)
            {
                // drizzle-kit drops the whole column's changes here.
                continue;
            }
            if type_changed {
                statements.push(format!(
                    "ALTER TABLE {table} ALTER COLUMN \"{name}\" SET DATA TYPE {};",
                    new.sql_type
                ));
            }
            if old.primary_key && !new.primary_key {
                let composite = format!("{}_{name}", after.name);
                if !after.composite_primary_keys.contains_key(&composite) {
                    self.unsupported
                        .push(format!("{key}.{name}: dropping the column's primary key"));
                }
            }
            match (&old.default, &new.default) {
                (None, Some(value)) => {
                    statements.push(format!(
                        "ALTER TABLE {table} ALTER COLUMN \"{name}\" SET DEFAULT {};",
                        js_text(value)
                    ));
                }
                (Some(a), Some(b)) if !same_value(Some(a), Some(b)) => {
                    statements.push(format!(
                        "ALTER TABLE {table} ALTER COLUMN \"{name}\" SET DEFAULT {};",
                        js_text(b)
                    ));
                }
                (Some(_), None) => statements.push(format!(
                    "ALTER TABLE {table} ALTER COLUMN \"{name}\" DROP DEFAULT;"
                )),
                _ => {}
            }
            if old.not_null != new.not_null {
                let action = if new.not_null {
                    "SET NOT NULL"
                } else {
                    "DROP NOT NULL"
                };
                statements.push(format!(
                    "ALTER TABLE {table} ALTER COLUMN \"{name}\" {action};"
                ));
            }
            if old.generated != new.generated {
                self.unsupported
                    .push(format!("{key}.{name}: changing a generated column"));
            }
            if !old.primary_key && new.primary_key {
                set_pks.push(format!("ALTER TABLE {table} ADD PRIMARY KEY (\"{name}\");"));
            }
        }
        self.groups.alter_columns.extend(set_pks);
        self.groups.alter_columns.extend(statements);
    }

    fn views(&mut self) {
        let (prev, next) = {
            let (a, b) = (self.prev, self.next);
            (&a.views, &b.views)
        };
        let (new, old) = added_and_gone(prev, next);
        for key in old {
            if !prev[key].is_existing {
                self.groups.drop_views.push(drop_view_sql(&prev[key]));
            }
        }
        for key in new {
            if !next[key].is_existing {
                self.check_view_options(key, &next[key]);
                self.groups.create_views.push(create_view_sql(&next[key]));
            }
        }
        for (key, before) in prev {
            let Some(after) = next.get(key) else { continue };
            if after.is_existing || before == after {
                continue;
            }
            if before.definition != after.definition || before.is_existing != after.is_existing {
                self.check_view_options(key, after);
                self.groups.drop_views.push(drop_view_sql(after));
                self.groups.create_views.push(create_view_sql(after));
            } else if before.with != after.with
                || before.using != after.using
                || before.tablespace != after.tablespace
            {
                self.unsupported.push(format!("{key}: view options"));
            }
        }
    }

    fn check_view_options(&mut self, key: &str, view: &View) {
        if view.with.as_ref().is_some_and(|with| !with.is_empty())
            || view.using.is_some()
            || view.tablespace.is_some()
        {
            self.unsupported.push(format!("{key}: view options"));
        }
    }
}

/// The values `after` adds to `before`, each with the value it comes before
/// (`""` at the end), as drizzle-kit's `mapArraysDiff` reports them.
fn added_values<'a>(before: &[String], after: &'a [String]) -> Vec<(&'a str, &'a str)> {
    after
        .iter()
        .enumerate()
        .filter(|(_, value)| !before.contains(value))
        .map(|(i, value)| {
            let following = after[i + 1..]
                .iter()
                .find(|v| before.contains(v))
                .map_or("", String::as_str);
            (value.as_str(), following)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_type_quotes_user_types_and_keeps_arrays_last() {
        assert_eq!(parse_type(None, "varchar(30)"), "varchar(30)");
        assert_eq!(
            parse_type(Some("public"), "ticket_status"),
            "\"ticket_status\""
        );
        assert_eq!(parse_type(Some("crm"), "stage"), "\"crm\".\"stage\"");
        assert_eq!(parse_type(None, "text[]"), "text[]");
        assert_eq!(parse_type(Some("public"), "status[][]"), "\"status\"[][]");
    }

    #[test]
    fn added_values_know_what_follows_them() {
        let before = ["a".to_owned(), "c".to_owned()];
        let after = [
            "a".to_owned(),
            "b".to_owned(),
            "c".to_owned(),
            "d".to_owned(),
        ];
        assert_eq!(added_values(&before, &after), vec![("b", "c"), ("d", "")]);
    }
}
