//! The catalog: Iceberg's SQL catalog (`iceberg-catalog-sql`) in a database
//! (the master Postgres in production), and the tables' storage (the
//! install's S3 bucket, or the local filesystem in tests).
//!
//! The SQL catalog keeps one row per table in `iceberg_tables`, pointing at
//! the table's current metadata file; every commit is a compare-and-swap on
//! that row's `metadata_location`. Appends and snapshot expiry go through
//! the library's `Transaction`; the commits it can't make (replace files)
//! are written here and swapped in with the same compare-and-swap
//! ([`Lakehouse::swap_metadata`]), so the two kinds of commit exclude each
//! other.
//!
//! The library runs `CREATE TABLE IF NOT EXISTS` for its two tables on
//! every start and can't be told not to; with the tables already made by
//! the master migration that is a no-op (the role still needs `CREATE` on
//! the schema, since Postgres checks it before it sees the table exists).
//! The DDL it expects, Postgres flavour (`VARCHAR` in both):
//!
//! ```sql
//! CREATE TABLE iceberg_tables (
//!     catalog_name VARCHAR(255) NOT NULL,
//!     table_namespace VARCHAR(255) NOT NULL,
//!     table_name VARCHAR(255) NOT NULL,
//!     metadata_location VARCHAR(1000),
//!     previous_metadata_location VARCHAR(1000),
//!     iceberg_type VARCHAR(5),
//!     PRIMARY KEY (catalog_name, table_namespace, table_name)
//! );
//! CREATE TABLE iceberg_namespace_properties (
//!     catalog_name VARCHAR(255) NOT NULL,
//!     namespace VARCHAR(255) NOT NULL,
//!     property_key VARCHAR(255),
//!     property_value VARCHAR(1000),
//!     PRIMARY KEY (catalog_name, namespace, property_key)
//! );
//! ```

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use iceberg::table::Table;
use iceberg::{Catalog, CatalogBuilder, ErrorKind, NamespaceIdent, TableIdent};
use iceberg_catalog_sql::{
    SQL_CATALOG_PROP_BIND_STYLE, SQL_CATALOG_PROP_URI, SQL_CATALOG_PROP_WAREHOUSE, SqlBindStyle,
    SqlCatalog, SqlCatalogBuilder,
};
use iceberg_storage_opendal::OpenDalResolvingStorageFactory;
use sqlx_iceberg::AnyPool;
use sqlx_iceberg::any::{AnyPoolOptions, install_default_drivers};

use crate::error::Result;
use crate::tables::{NAMESPACE, PanelTable};

/// Where the catalog and the tables are.
#[derive(Clone)]
pub struct LakehouseConfig {
    /// The catalog database: `postgres://…` (the master database; any URL
    /// sqlx 0.8's `Any` driver takes works, tests use a scratch Postgres).
    pub catalog_url: String,
    /// The catalog's name, the `catalog_name` column (`weldsuite`).
    pub catalog_name: String,
    /// Where new tables go: `s3://<bucket>/lake` or `file:/…`.
    pub warehouse: String,
    /// Storage properties for S3: `s3.endpoint`, `s3.region`,
    /// `s3.access-key-id`, `s3.secret-access-key`, `s3.path-style-access`.
    pub storage: HashMap<String, String>,
}

impl fmt::Debug for LakehouseConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LakehouseConfig")
            .field("catalog_name", &self.catalog_name)
            .field("warehouse", &self.warehouse)
            .field("storage", &self.storage.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

/// The store: the catalog and a pool on its database for the commits the
/// library can't make.
pub struct Lakehouse {
    catalog: Arc<SqlCatalog>,
    pool: AnyPool,
    catalog_name: String,
    dollar_binds: bool,
}

impl fmt::Debug for Lakehouse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Lakehouse")
            .field("catalog_name", &self.catalog_name)
            .finish_non_exhaustive()
    }
}

impl Lakehouse {
    /// Connects to the catalog.
    pub async fn connect(config: &LakehouseConfig) -> Result<Self> {
        let dollar_binds = config.catalog_url.starts_with("postgres");
        let bind_style = if dollar_binds {
            SqlBindStyle::DollarNumeric
        } else {
            SqlBindStyle::QMark
        };
        let mut props = config.storage.clone();
        props.insert(SQL_CATALOG_PROP_URI.to_owned(), config.catalog_url.clone());
        props.insert(
            SQL_CATALOG_PROP_WAREHOUSE.to_owned(),
            config.warehouse.clone(),
        );
        props.insert(
            SQL_CATALOG_PROP_BIND_STYLE.to_owned(),
            bind_style.to_string(),
        );
        let catalog = SqlCatalogBuilder::default()
            .with_storage_factory(Arc::new(OpenDalResolvingStorageFactory::new()))
            .load(config.catalog_name.clone(), props)
            .await?;
        install_default_drivers();
        let pool = AnyPoolOptions::new()
            .max_connections(2)
            .connect(&config.catalog_url)
            .await?;
        Ok(Self {
            catalog: Arc::new(catalog),
            pool,
            catalog_name: config.catalog_name.clone(),
            dollar_binds,
        })
    }

    /// The Iceberg catalog, for the library's own operations.
    pub fn catalog(&self) -> &SqlCatalog {
        &self.catalog
    }

    /// The catalog as a trait object (DataFusion's providers want one).
    pub fn catalog_arc(&self) -> Arc<dyn Catalog> {
        self.catalog.clone()
    }

    /// Creates the `panel` namespace and the five tables where missing (at
    /// startup). Two pods racing are fine: the loser sees the table exists.
    pub async fn ensure_tables(&self) -> Result<()> {
        let namespace = NamespaceIdent::new(NAMESPACE.to_owned());
        if !self.catalog.namespace_exists(&namespace).await? {
            match self
                .catalog
                .create_namespace(&namespace, HashMap::new())
                .await
            {
                Ok(_) => {}
                Err(error) if self.catalog.namespace_exists(&namespace).await? => {
                    tracing::debug!(%error, "namespace made by another pod");
                }
                Err(error) => return Err(error.into()),
            }
        }
        for table in PanelTable::ALL {
            if self.catalog.table_exists(&table.ident()).await? {
                continue;
            }
            match self
                .catalog
                .create_table(&namespace, table.creation()?)
                .await
            {
                Ok(_) => {}
                Err(error)
                    if error.kind() == ErrorKind::TableAlreadyExists
                        || self.catalog.table_exists(&table.ident()).await? =>
                {
                    tracing::debug!(%error, table = table.name(), "table made by another pod");
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    /// The table's current state.
    pub async fn load(&self, table: PanelTable) -> Result<Table> {
        Ok(self.catalog.load_table(&table.ident()).await?)
    }

    /// Points the table at `new_location` if it still points at `expected`:
    /// the same compare-and-swap the SQL catalog commits with. False when
    /// another commit got there first.
    pub(crate) async fn swap_metadata(
        &self,
        ident: &TableIdent,
        expected: &str,
        new_location: &str,
    ) -> Result<bool> {
        let sql = if self.dollar_binds {
            "UPDATE iceberg_tables SET metadata_location = $1, previous_metadata_location = $2 \
             WHERE catalog_name = $3 AND table_namespace = $4 AND table_name = $5 \
             AND metadata_location = $6"
        } else {
            "UPDATE iceberg_tables SET metadata_location = ?, previous_metadata_location = ? \
             WHERE catalog_name = ? AND table_namespace = ? AND table_name = ? \
             AND metadata_location = ?"
        };
        let result = sqlx_iceberg::query(sql)
            .bind(new_location)
            .bind(expected)
            .bind(self.catalog_name.as_str())
            .bind(ident.namespace().join("."))
            .bind(ident.name())
            .bind(expected)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected() == 1)
    }
}
