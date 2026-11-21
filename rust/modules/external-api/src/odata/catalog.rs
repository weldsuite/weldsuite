//! The feed's catalogue (`routes/v1/odata/catalog.ts`): every entity set,
//! its table and its properties, as data.
//!
//! The TypeScript catalogue is the one source: `pnpm rust:catalogs` exports
//! `odataCatalogJson()` to `rust/catalogs/odata.json` (CI fails when it is
//! stale), which is embedded here. The service document, `$metadata`, the
//! SQL and the checks of `$select` / `$filter` / `$orderby` are all driven
//! from it, and a name in a request is only ever looked up in it: what
//! reaches SQL is this file's tables, columns and expressions, never the
//! request's text.

use std::sync::LazyLock;

use serde::Deserialize;

/// `EdmType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub(crate) enum EdmType {
    #[serde(rename = "Edm.String")]
    String,
    #[serde(rename = "Edm.Int32")]
    Int32,
    #[serde(rename = "Edm.Int64")]
    Int64,
    #[serde(rename = "Edm.Boolean")]
    Boolean,
    #[serde(rename = "Edm.DateTimeOffset")]
    DateTimeOffset,
    #[serde(rename = "Edm.Double")]
    Double,
    #[serde(rename = "Collection(Edm.String)")]
    StringCollection,
}

impl EdmType {
    /// The type as the catalogue, `$metadata` and the messages name it.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::String => "Edm.String",
            Self::Int32 => "Edm.Int32",
            Self::Int64 => "Edm.Int64",
            Self::Boolean => "Edm.Boolean",
            Self::DateTimeOffset => "Edm.DateTimeOffset",
            Self::Double => "Edm.Double",
            Self::StringCollection => "Collection(Edm.String)",
        }
    }
}

/// `ODataProperty`.
#[allow(clippy::struct_excessive_bools)] // the catalogue's own flags, as exported
#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Property {
    /// Name on the wire.
    pub(crate) name: String,
    /// SQL column, or a fixed SQL expression for a derived value.
    pub(crate) column: String,
    #[serde(rename = "type")]
    pub(crate) edm: EdmType,
    pub(crate) nullable: bool,
    pub(crate) filterable: bool,
    pub(crate) sortable: bool,
    /// The column is `timestamptz` (the others are `timestamp` holding UTC).
    #[serde(default)]
    pub(crate) with_time_zone: bool,
}

/// `ODataEntitySet`.
#[derive(Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EntitySet {
    pub(crate) name: String,
    pub(crate) entity_type: String,
    /// SQL table name.
    pub(crate) table: String,
    /// Name of the key property (a string property, never null).
    pub(crate) key: String,
    /// SQL column holding the soft-delete time: rows where it is set are not served.
    #[serde(default)]
    pub(crate) soft_delete: Option<String>,
    pub(crate) properties: Vec<Property>,
}

impl EntitySet {
    /// `findProperty(set, name)`.
    pub(crate) fn property(&self, name: &str) -> Option<&Property> {
        self.properties.iter().find(|prop| prop.name == name)
    }

    /// `findProperty(set, set.key)!`: `None` only for a catalogue the
    /// TypeScript tests would have refused.
    pub(crate) fn key_property(&self) -> Option<&Property> {
        self.property(&self.key)
    }
}

/// `ODataCatalog`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Catalog {
    pub(crate) namespace: String,
    pub(crate) container: String,
    /// Rows per response; more rows than this come with `@odata.nextLink`.
    pub(crate) page_size: i64,
    pub(crate) entity_sets: Vec<EntitySet>,
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../../catalogs/odata.json"))
        .expect("odata.json matches Catalog (checked by the tests)")
});

/// The catalogue (`ODATA_CATALOG`).
pub(crate) fn catalog() -> &'static Catalog {
    &CATALOG
}

/// `findEntitySet(name)`.
pub(crate) fn find_entity_set(name: &str) -> Option<&'static EntitySet> {
    catalog().entity_sets.iter().find(|set| set.name == name)
}

/// `isPlainColumn(column)`: a plain column name (`/^[a-z_][a-z0-9_]*$/`), as
/// opposed to a fixed SQL expression.
pub(crate) fn is_plain_column(column: &str) -> bool {
    let mut bytes = column.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first == b'_')
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_catalogue_is_the_exported_one() {
        let catalog = catalog();
        assert_eq!(catalog.namespace, "WeldSuite.Desk");
        assert_eq!(catalog.container, "Feed");
        assert_eq!(catalog.page_size, 1000);
        let names: Vec<&str> = catalog
            .entity_sets
            .iter()
            .map(|set| set.name.as_str())
            .collect();
        assert_eq!(
            names,
            [
                "Conversations",
                "Messages",
                "SlaClocks",
                "Calls",
                "Teams",
                "TicketTypes",
                "Agents",
                "Problems",
                "CatalogItems",
                "Articles"
            ]
        );
    }

    /// What `odata-catalog.test.ts` holds the TypeScript catalogue to, and
    /// what the SQL here relies on.
    #[test]
    fn every_set_has_a_plain_string_key_and_reviewed_expressions() {
        for set in &catalog().entity_sets {
            assert!(is_plain_column(&set.table), "{}", set.table);
            let key = set.key_property().expect("the key is a property");
            assert_eq!(key.edm, EdmType::String, "{}", set.name);
            assert!(!key.nullable, "{}", set.name);
            assert!(is_plain_column(&key.column), "{}", set.name);
            if let Some(column) = &set.soft_delete {
                assert!(is_plain_column(column), "{}", set.name);
            }
            for prop in &set.properties {
                assert!(
                    prop.name.starts_with(|c: char| c.is_ascii_lowercase())
                        && prop.name.chars().all(|c| c.is_ascii_alphanumeric()),
                    "{}.{}",
                    set.name,
                    prop.name
                );
                if !is_plain_column(&prop.column) {
                    assert!(
                        ["metadata->>'eventType'", "status = 'ACTIVE'"]
                            .contains(&prop.column.as_str()),
                        "{}.{}",
                        set.name,
                        prop.name
                    );
                }
            }
        }
    }

    #[test]
    fn properties_read_their_flags() {
        let conversations = find_entity_set("Conversations").expect("set");
        let tags = conversations.property("tags").expect("tags");
        assert_eq!(tags.edm, EdmType::StringCollection);
        assert_eq!(tags.edm.name(), "Collection(Edm.String)");
        assert!(!tags.sortable);
        assert!(tags.filterable);
        let agents = find_entity_set("Agents").expect("set");
        assert!(
            agents
                .property("createdAt")
                .expect("createdAt")
                .with_time_zone
        );
        assert!(
            !conversations
                .property("createdAt")
                .expect("createdAt")
                .with_time_zone
        );
        assert_eq!(agents.soft_delete.as_deref(), Some("deleted_at"));
        assert_eq!(conversations.soft_delete, None);
        assert!(find_entity_set("conversations").is_none());
        assert!(conversations.property("Title").is_none());
    }

    #[test]
    fn plain_columns_are_lower_snake_names() {
        for column in ["id", "created_at", "_x", "a1"] {
            assert!(is_plain_column(column), "{column}");
        }
        for column in [
            "",
            "1a",
            "Id",
            "metadata->>'eventType'",
            "status = 'ACTIVE'",
            "a b",
            "a\"",
        ] {
            assert!(!is_plain_column(column), "{column}");
        }
    }
}
