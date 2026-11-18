//! WeldPanel's five tables, with Global's columns and types
//! (`packages/domains/panel/src/*-v1-schema.json`, `tables.ts`), and the
//! partitioning these editions choose (Basin has none): every table by
//! `workspace_id`, events and recording chunks also by the day of their time.
//!
//! A column change is a `_v2` table, as on Global.

use std::collections::HashMap;

use iceberg::spec::{
    FormatVersion, NestedField, PrimitiveType, Schema, TableProperties, Transform, Type,
    UnboundPartitionSpec,
};
use iceberg::{NamespaceIdent, TableCreation, TableIdent};

/// The namespace the tables live in, so SQL says `panel.events_v1`.
pub const NAMESPACE: &str = "panel";

/// Data files are rolled at this size (the writer flushes at 64 MB of rows,
/// so a flush is one file per partition; compaction aims here).
pub const TARGET_FILE_SIZE_BYTES: usize = 128 * 1024 * 1024;

/// A column's type, as the stream schema files name them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnType {
    /// `string`
    String,
    /// `timestamp`: a UTC instant, microseconds (`timestamptz`).
    Timestamp,
    /// `bool`
    Bool,
    /// `int32`
    Int32,
    /// `int64`
    Int64,
    /// `float64`
    Float64,
}

/// One column of a table.
#[derive(Debug, Clone, Copy)]
pub struct Column {
    /// The column name.
    pub name: &'static str,
    /// Its type.
    pub kind: ColumnType,
    /// `required` in the schema file: never null.
    pub required: bool,
}

const fn req(name: &'static str, kind: ColumnType) -> Column {
    Column {
        name,
        kind,
        required: true,
    }
}

const fn opt(name: &'static str, kind: ColumnType) -> Column {
    Column {
        name,
        kind,
        required: false,
    }
}

use ColumnType::{Bool, Float64, Int32, Int64, String as Text, Timestamp};

/// `events-v1-schema.json`.
const EVENTS: &[Column] = &[
    req("event_id", Text),
    req("workspace_id", Text),
    req("project_id", Text),
    req("name", Text),
    req("ts", Timestamp),
    req("received_at", Timestamp),
    req("distinct_id", Text),
    req("anon_id", Text),
    opt("user_id", Text),
    opt("session_id", Text),
    req("cookieless", Bool),
    req("url", Text),
    req("host", Text),
    req("path", Text),
    opt("title", Text),
    opt("referrer", Text),
    opt("referrer_host", Text),
    opt("utm_source", Text),
    opt("utm_medium", Text),
    opt("utm_campaign", Text),
    opt("utm_content", Text),
    opt("utm_term", Text),
    opt("country", Text),
    opt("region", Text),
    opt("city", Text),
    opt("device_type", Text),
    opt("browser", Text),
    opt("os", Text),
    opt("viewport_w", Int32),
    opt("el_tag", Text),
    opt("el_selector", Text),
    opt("el_text", Text),
    opt("x", Int32),
    opt("y", Int32),
    opt("rel_x", Float64),
    opt("rel_y", Float64),
    opt("scroll_depth", Int32),
    opt("error_message", Text),
    req("properties", Text),
    req("lib", Text),
    req("lib_version", Text),
];

/// `identities-v1-schema.json`.
const IDENTITIES: &[Column] = &[
    req("workspace_id", Text),
    req("project_id", Text),
    req("anon_id", Text),
    req("user_id", Text),
    req("ts", Timestamp),
];

/// `people-v1-schema.json`.
const PEOPLE: &[Column] = &[
    req("workspace_id", Text),
    req("project_id", Text),
    req("user_id", Text),
    req("version", Int64),
    req("ts", Timestamp),
    req("properties", Text),
    req("deleted", Bool),
];

/// `groups-v1-schema.json`.
const GROUPS: &[Column] = &[
    req("workspace_id", Text),
    req("project_id", Text),
    req("group_type", Text),
    req("group_key", Text),
    req("version", Int64),
    req("ts", Timestamp),
    req("properties", Text),
    req("deleted", Bool),
];

/// `replay-chunks-v1-schema.json`.
const REPLAY_CHUNKS: &[Column] = &[
    req("workspace_id", Text),
    req("project_id", Text),
    req("session_id", Text),
    req("seq", Int32),
    req("ts_start", Timestamp),
    req("ts_end", Timestamp),
    req("bytes", Int64),
    req("has_full_snapshot", Bool),
    req("r2_key", Text),
];

/// One of WeldPanel's tables.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PanelTable {
    /// `panel.events_v1`
    Events,
    /// `panel.identities_v1`
    Identities,
    /// `panel.people_v1`
    People,
    /// `panel.groups_v1`
    Groups,
    /// `panel.replay_chunks_v1`
    ReplayChunks,
}

impl PanelTable {
    /// Every table.
    pub const ALL: [Self; 5] = [
        Self::Events,
        Self::Identities,
        Self::People,
        Self::Groups,
        Self::ReplayChunks,
    ];

    /// The table's name in [`NAMESPACE`].
    pub const fn name(self) -> &'static str {
        match self {
            Self::Events => "events_v1",
            Self::Identities => "identities_v1",
            Self::People => "people_v1",
            Self::Groups => "groups_v1",
            Self::ReplayChunks => "replay_chunks_v1",
        }
    }

    /// The table by name, `events_v1`.
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|table| table.name() == name)
    }

    /// The columns, in schema-file order.
    pub const fn columns(self) -> &'static [Column] {
        match self {
            Self::Events => EVENTS,
            Self::Identities => IDENTITIES,
            Self::People => PEOPLE,
            Self::Groups => GROUPS,
            Self::ReplayChunks => REPLAY_CHUNKS,
        }
    }

    /// The column partitioned by day, if any: retention drops whole days of it.
    pub const fn day_column(self) -> Option<&'static str> {
        match self {
            Self::Events => Some("ts"),
            Self::ReplayChunks => Some("ts_start"),
            Self::Identities | Self::People | Self::Groups => None,
        }
    }

    /// `panel.<name>`.
    pub fn ident(self) -> TableIdent {
        TableIdent::new(
            NamespaceIdent::new(NAMESPACE.to_owned()),
            self.name().to_owned(),
        )
    }

    /// The Iceberg schema: field ids 1… in column order.
    pub fn schema(self) -> iceberg::Result<Schema> {
        let fields = self.columns().iter().zip(1..).map(|(column, id)| {
            let kind = Type::Primitive(match column.kind {
                ColumnType::String => PrimitiveType::String,
                ColumnType::Timestamp => PrimitiveType::Timestamptz,
                ColumnType::Bool => PrimitiveType::Boolean,
                ColumnType::Int32 => PrimitiveType::Int,
                ColumnType::Int64 => PrimitiveType::Long,
                ColumnType::Float64 => PrimitiveType::Double,
            });
            let field = if column.required {
                NestedField::required(id, column.name, kind)
            } else {
                NestedField::optional(id, column.name, kind)
            };
            field.into()
        });
        Schema::builder()
            .with_schema_id(0)
            .with_fields(fields)
            .build()
    }

    /// Identity on `workspace_id`, then `day(<day column>)` where there is one.
    pub fn partition_spec(self) -> iceberg::Result<UnboundPartitionSpec> {
        let mut builder = UnboundPartitionSpec::builder()
            .with_spec_id(0)
            .add_partition_field(
                self.field_id("workspace_id"),
                "workspace_id",
                Transform::Identity,
            )?;
        if let Some(day) = self.day_column() {
            builder = builder.add_partition_field(
                self.field_id(day),
                format!("{day}_day"),
                Transform::Day,
            )?;
        }
        Ok(builder.build())
    }

    /// What `create_table` gets.
    pub fn creation(self) -> iceberg::Result<TableCreation> {
        Ok(TableCreation::builder()
            .name(self.name().to_owned())
            .schema(self.schema()?)
            .partition_spec(self.partition_spec()?)
            .properties(table_properties())
            .format_version(FormatVersion::V2)
            .build())
    }

    fn field_id(self, name: &str) -> i32 {
        self.columns()
            .iter()
            .zip(1..)
            .find_map(|(column, id)| (column.name == name).then_some(id))
            .unwrap_or_default()
    }
}

/// The tables' properties: zstd Parquet, the target file size, and no
/// automatic retries inside iceberg-rust longer than the writer's own.
fn table_properties() -> HashMap<String, String> {
    HashMap::from([
        (
            TableProperties::PROPERTY_PARQUET_COMPRESSION_CODEC.to_owned(),
            "zstd".to_owned(),
        ),
        (
            TableProperties::PROPERTY_WRITE_TARGET_FILE_SIZE_BYTES.to_owned(),
            TARGET_FILE_SIZE_BYTES.to_string(),
        ),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_table_has_a_schema_and_a_partition_spec() {
        for table in PanelTable::ALL {
            let schema = table.schema().expect("a schema");
            assert_eq!(schema.as_struct().fields().len(), table.columns().len());
            let spec = table.partition_spec().expect("a spec");
            assert_eq!(spec.fields()[0].source_id, table.field_id("workspace_id"));
            assert_eq!(
                spec.fields().len(),
                1 + usize::from(table.day_column().is_some())
            );
            assert_eq!(PanelTable::from_name(table.name()), Some(table));
        }
    }
}
