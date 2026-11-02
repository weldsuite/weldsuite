//! The tables the CRM writes ([`Table`]), and the `insert_sql!`/`update_sql!`
//! statements over `jsonb_populate_record` (generated in `tables_gen.rs`).

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
}
