//! drizzle-kit's Postgres snapshot (version 7) as types: the schema state a
//! migration is diffed against (ADR DATA-019). The fields keep drizzle-kit's
//! names and order, and maps keep their order, so a snapshot read from
//! `rust/migrations/<database>/meta` and written back is drizzle-kit's file,
//! and the differ ([`crate::diff`]) sees tables and columns in the order
//! drizzle-kit did.

use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// One database's schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// The migration's id; `None` for a snapshot built from the entities.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The previous migration's id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev_id: Option<String>,
    pub version: String,
    pub dialect: String,
    pub tables: IndexMap<String, Table>,
    #[serde(default)]
    pub enums: IndexMap<String, Enum>,
    #[serde(default)]
    pub schemas: IndexMap<String, String>,
    #[serde(default)]
    pub sequences: IndexMap<String, Value>,
    #[serde(default)]
    pub roles: IndexMap<String, Value>,
    #[serde(default)]
    pub policies: IndexMap<String, Value>,
    #[serde(default)]
    pub views: IndexMap<String, View>,
    /// drizzle-kit's record of the renames a migration made.
    #[serde(rename = "_meta", default)]
    pub meta: Meta,
}

/// The renames a migration made, as drizzle-kit records them.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Meta {
    #[serde(default)]
    pub columns: IndexMap<String, String>,
    #[serde(default)]
    pub schemas: IndexMap<String, String>,
    #[serde(default)]
    pub tables: IndexMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub name: String,
    /// `""` for `public`.
    #[serde(default)]
    pub schema: String,
    pub columns: IndexMap<String, Column>,
    #[serde(default)]
    pub indexes: IndexMap<String, Index>,
    #[serde(default)]
    pub foreign_keys: IndexMap<String, ForeignKey>,
    #[serde(default)]
    pub composite_primary_keys: IndexMap<String, CompositePrimaryKey>,
    #[serde(default)]
    pub unique_constraints: IndexMap<String, Unique>,
    #[serde(default)]
    pub policies: IndexMap<String, Value>,
    #[serde(default)]
    pub check_constraints: IndexMap<String, Check>,
    #[serde(rename = "isRLSEnabled", default)]
    pub is_rls_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub sql_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_schema: Option<String>,
    pub primary_key: bool,
    pub not_null: bool,
    /// SQL text, or a JSON number or boolean. An explicit `null` (some old
    /// snapshots have one) is `Some(Value::Null)`: drizzle-kit tells it from
    /// no default.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub default: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated: Option<Generated>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<Value>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub is_unique: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unique_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nulls_not_distinct: Option<bool>,
}

/// A stored generated column.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Generated {
    #[serde(rename = "as")]
    pub expression: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub name: String,
    pub columns: Vec<IndexColumn>,
    pub is_unique: bool,
    #[serde(rename = "where", default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    #[serde(default)]
    pub concurrently: bool,
    #[serde(default = "btree")]
    pub method: String,
    #[serde(default)]
    pub with: IndexMap<String, Value>,
}

/// A field that is there, `null` included, as `Some`; `#[serde(default)]`
/// makes a missing one `None`.
fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

fn btree() -> String {
    "btree".to_owned()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexColumn {
    pub expression: String,
    pub is_expression: bool,
    pub asc: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nulls: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opclass: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub name: String,
    pub table_from: String,
    pub table_to: String,
    pub columns_from: Vec<String>,
    pub columns_to: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_delete: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_update: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompositePrimaryKey {
    pub name: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unique {
    pub name: String,
    #[serde(default)]
    pub nulls_not_distinct: bool,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Check {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Enum {
    pub name: String,
    pub schema: String,
    pub values: Vec<String>,
}

/// A view; ours are materialized and have no entity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    #[serde(default)]
    pub columns: IndexMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition: Option<String>,
    pub name: String,
    pub schema: String,
    #[serde(default)]
    pub is_existing: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub with_no_data: Option<bool>,
    #[serde(default)]
    pub materialized: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub with: Option<IndexMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub using: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tablespace: Option<String>,
}

impl Snapshot {
    /// An empty version-7 Postgres snapshot.
    pub fn empty() -> Self {
        Self {
            id: None,
            prev_id: None,
            version: "7".to_owned(),
            dialect: "postgresql".to_owned(),
            tables: IndexMap::new(),
            enums: IndexMap::new(),
            schemas: IndexMap::new(),
            sequences: IndexMap::new(),
            roles: IndexMap::new(),
            policies: IndexMap::new(),
            views: IndexMap::new(),
            meta: Meta::default(),
        }
    }
}
