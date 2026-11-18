//! The store: WeldSuite's Iceberg catalog on the master Postgres
//! ([`PgCatalog`], its two tables made by the master migration) and the
//! tables' storage (the install's S3 bucket, or the local filesystem in
//! tests).
//!
//! Appends and snapshot expiry go through the library's `Transaction`, which
//! commits through [`PgCatalog`]'s `update_table`; the commits the library
//! can't make (replace files) are written here and swapped in with the same
//! compare-and-swap ([`Lakehouse::swap_metadata`]), so the two kinds of
//! commit exclude each other.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use iceberg::table::Table;
use iceberg::{Catalog, ErrorKind, NamespaceIdent, TableIdent};
use sqlx::PgPool;

use crate::error::Result;
use crate::pg_catalog::PgCatalog;
use crate::tables::{NAMESPACE, PanelTable};

/// The catalog name the install's tables are registered under.
pub const CATALOG_NAME: &str = "weldsuite";

/// Where the tables are.
#[derive(Clone)]
pub struct LakehouseConfig {
    /// The catalog's name, the `catalog_name` column ([`CATALOG_NAME`]).
    pub catalog_name: String,
    /// Where new tables go: `s3://<bucket>/lake` or `file:/…`.
    pub warehouse: String,
    /// Storage properties for S3: `s3.endpoint`, `s3.region`,
    /// `s3.access-key-id`, `s3.secret-access-key`, `s3.path-style-access`.
    pub storage: HashMap<String, String>,
}

/// Where the tables go in the bucket: `s3://<bucket>/lake`.
pub const LAKE_PREFIX: &str = "lake";

/// How to reach an S3-compatible store.
#[derive(Clone)]
pub struct S3Store {
    /// `https://fsn1.your-objectstorage.com`, `http://rustfs:9000`, …
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Path-style URLs (RustFS, MinIO, Garage, endpoints reached by IP).
    pub path_style: bool,
}

impl LakehouseConfig {
    /// The install's tables in `s3://<bucket>/lake` under [`CATALOG_NAME`].
    /// The SDK's own credential and region lookups (environment, profile
    /// files, the EC2 metadata endpoint) are off: only these settings count.
    pub fn s3(store: &S3Store) -> Self {
        use iceberg::io::{
            S3_ACCESS_KEY_ID, S3_DISABLE_CONFIG_LOAD, S3_DISABLE_EC2_METADATA, S3_ENDPOINT,
            S3_PATH_STYLE_ACCESS, S3_REGION, S3_SECRET_ACCESS_KEY,
        };
        let storage = HashMap::from([
            (S3_ENDPOINT.to_owned(), store.endpoint.clone()),
            (S3_REGION.to_owned(), store.region.clone()),
            (S3_ACCESS_KEY_ID.to_owned(), store.access_key_id.clone()),
            (
                S3_SECRET_ACCESS_KEY.to_owned(),
                store.secret_access_key.clone(),
            ),
            (
                S3_PATH_STYLE_ACCESS.to_owned(),
                store.path_style.to_string(),
            ),
            (S3_DISABLE_CONFIG_LOAD.to_owned(), "true".to_owned()),
            (S3_DISABLE_EC2_METADATA.to_owned(), "true".to_owned()),
        ]);
        Self {
            catalog_name: CATALOG_NAME.to_owned(),
            warehouse: format!("s3://{}/{LAKE_PREFIX}", store.bucket),
            storage,
        }
    }
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

/// The store. Cheap to clone.
#[derive(Clone)]
pub struct Lakehouse {
    catalog: Arc<PgCatalog>,
    warehouse: String,
}

impl fmt::Debug for Lakehouse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Lakehouse")
            .field("catalog", &self.catalog)
            .finish_non_exhaustive()
    }
}

impl Lakehouse {
    /// The store on `pool` (the master database, where the migration made the
    /// catalog's tables). Nothing is sent until the first call. Must be
    /// called inside a tokio runtime.
    pub fn new(pool: PgPool, config: &LakehouseConfig) -> Result<Self> {
        let catalog = PgCatalog::new(
            pool,
            config.catalog_name.clone(),
            config.warehouse.clone(),
            &config.storage,
        )?;
        Ok(Self {
            catalog: Arc::new(catalog),
            warehouse: config.warehouse.trim_end_matches('/').to_owned(),
        })
    }

    /// The Iceberg catalog, for the library's own operations.
    pub fn catalog(&self) -> &PgCatalog {
        &self.catalog
    }

    /// The catalog as a trait object (DataFusion's providers want one).
    pub fn catalog_arc(&self) -> Arc<dyn Catalog> {
        self.catalog.clone()
    }

    /// Where the tables are: `s3://<bucket>/lake`.
    pub fn warehouse(&self) -> &str {
        &self.warehouse
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
                Err(error) if error.kind() == ErrorKind::NamespaceAlreadyExists => {
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
                Err(error) if error.kind() == ErrorKind::TableAlreadyExists => {
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

    /// Where the table's files are: `s3://<bucket>/lake/panel/events_v1`.
    pub async fn table_location(&self, table: PanelTable) -> Result<String> {
        Ok(self
            .load(table)
            .await?
            .metadata()
            .location()
            .trim_end_matches('/')
            .to_owned())
    }

    /// Points the table at `new_location` if it still points at `expected`:
    /// the same compare-and-swap every commit makes. False when another
    /// commit got there first.
    pub(crate) async fn swap_metadata(
        &self,
        ident: &TableIdent,
        expected: &str,
        new_location: &str,
    ) -> Result<bool> {
        Ok(self
            .catalog
            .swap_metadata(ident, expected, new_location)
            .await?)
    }
}
