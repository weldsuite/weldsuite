//! WeldSuite's own Iceberg catalog: iceberg-rust's [`Catalog`] on the master
//! Postgres, over the two tables the master migration makes
//! (`0072_weldpanel_lakehouse`, schema file `weldpanel-lakehouse.ts`):
//!
//! ```sql
//! CREATE TABLE iceberg_tables (
//!     catalog_name varchar(255) NOT NULL,
//!     table_namespace varchar(255) NOT NULL,
//!     table_name varchar(255) NOT NULL,
//!     metadata_location varchar(1000),
//!     previous_metadata_location varchar(1000),
//!     iceberg_type varchar(5),
//!     PRIMARY KEY (catalog_name, table_namespace, table_name)
//! );
//! CREATE TABLE iceberg_namespace_properties (
//!     catalog_name varchar(255) NOT NULL,
//!     namespace varchar(255) NOT NULL,
//!     property_key varchar(255) NOT NULL,
//!     property_value varchar(1000),
//!     PRIMARY KEY (catalog_name, namespace, property_key)
//! );
//! ```
//!
//! The layout is the Iceberg JDBC / SQL catalog's (Java's `JdbcCatalog`,
//! `PyIceberg`'s `SqlCatalog`, `iceberg-catalog-sql`), so those tools can open
//! the catalog too. What differs from `iceberg-catalog-sql`, which this
//! replaces: it runs on the workspace's sqlx 0.9 pool (that crate needs sqlx
//! 0.8's `Any` driver), it never creates or alters its tables (the migration
//! does), and a lost compare-and-swap deletes the metadata file it wrote.
//!
//! Every table commit is a compare-and-swap on the row's `metadata_location`
//! ([`PgCatalog::swap_metadata`]): the library's commits (appends, snapshot
//! expiry) through [`Catalog::update_table`], and the replace-files commit
//! directly, so the two exclude each other.
//!
//! A commit whose database call fails is not taken for lost: the swap runs
//! in a transaction of its own, so a failure before its `COMMIT` changed
//! nothing, but a failure on the `COMMIT` itself may hide a swap that
//! landed. Then the row is read again under a share lock (which waits for a
//! `COMMIT` still in flight) and the swap is [`SwapOutcome::Swapped`] if the
//! table points at the new metadata or descends from it,
//! [`SwapOutcome::Failed`] if it still points at the old one or descends
//! from it without the new one, and [`SwapOutcome::Unknown`] if that can't
//! be read. Only a commit known not to have landed deletes what it wrote; an
//! unknown one leaves it to the orphan sweep and answers an error of its own
//! ([`is_commit_unknown`], `LakehouseError::CommitUnknown`).

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use iceberg::io::{FileIO, FileIOBuilder};
use iceberg::spec::{TableMetadata, TableMetadataBuilder};
use iceberg::table::Table;
use iceberg::{
    Catalog, Error, ErrorKind, MetadataLocation, Namespace, NamespaceIdent, Result, Runtime,
    TableCommit, TableCreation, TableIdent,
};
use iceberg_storage_opendal::OpenDalResolvingStorageFactory;
use sqlx::{PgPool, Row};

/// A namespace's `location` property: where its tables go, instead of
/// `<warehouse>/<namespace>`.
const LOCATION_PROPERTY: &str = "location";

/// `iceberg_type` of a table row (a view would be `VIEW`; null is a table
/// written before the column existed).
const TABLE_TYPE: &str = "TABLE";

/// Reads made to settle a commit whose answer was lost.
const SETTLE_ATTEMPTS: u32 = 3;

/// How long one of them waits for the row's lock (a `COMMIT` still in
/// flight holds it).
const SETTLE_LOCK_TIMEOUT: &str = "5s";

/// How a commit's compare-and-swap ended ([`PgCatalog::swap_metadata`]).
#[derive(Debug)]
pub enum SwapOutcome {
    /// The table points at the new metadata: committed.
    Swapped,
    /// Another commit got there first; nothing changed.
    Lost,
    /// The database failed and the swap didn't happen: before its
    /// transaction could commit, or the table still points at (or descends
    /// from) the metadata it expected without the new one.
    Failed(sqlx::Error),
    /// The database failed while committing and reading the table again
    /// didn't tell whether the swap landed: nothing the commit wrote may be
    /// deleted.
    Unknown(String),
}

/// The source of the error a commit whose outcome is unknown answers (the
/// library only carries an `iceberg::Error` through `Transaction::commit`).
#[derive(Debug)]
struct CommitUnknown(String);

impl fmt::Display for CommitUnknown {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CommitUnknown {}

/// Whether `error` is a commit whose outcome is unknown
/// ([`SwapOutcome::Unknown`] through [`Catalog::update_table`]).
pub(crate) fn is_commit_unknown(error: &Error) -> bool {
    std::error::Error::source(error).is_some_and(<dyn std::error::Error>::is::<CommitUnknown>)
}

fn commit_unknown(table: &TableIdent, reason: &str) -> Error {
    Error::new(
        ErrorKind::Unexpected,
        format!("{table}: whether the commit landed is unknown"),
    )
    .with_source(CommitUnknown(reason.to_owned()))
}

/// Where a transaction that changes the catalog failed.
enum TxFailure {
    /// Before its `COMMIT` was sent: it never commits.
    BeforeCommit(sqlx::Error),
    /// On the `COMMIT`: it may have committed.
    AtCommit(sqlx::Error),
}

/// Failures a test makes the catalog's next commit see.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CommitFault {
    /// The connection drops before the `COMMIT`: nothing changes.
    ConnectionDrops,
    /// The `COMMIT` lands and its answer is lost.
    AnswerLostLanded,
    /// The `COMMIT` never arrives (the transaction rolls back) and the
    /// answer is lost.
    AnswerLostNotLanded,
}

/// What the test failures are set to.
#[cfg(test)]
#[derive(Debug, Default)]
pub(crate) struct Faults {
    /// The next commit's (consumed by it).
    pub(crate) commit: Option<CommitFault>,
    /// Every read made to settle a lost answer fails while set.
    pub(crate) settle_fails: bool,
}

#[cfg(test)]
fn injected() -> sqlx::Error {
    sqlx::Error::Io(std::io::Error::new(
        std::io::ErrorKind::ConnectionReset,
        "the test dropped the connection",
    ))
}

/// The catalog on Postgres. Cheap to clone.
#[derive(Clone)]
pub struct PgCatalog {
    pool: PgPool,
    name: String,
    warehouse: String,
    file_io: FileIO,
    runtime: Runtime,
    #[cfg(test)]
    faults: Arc<std::sync::Mutex<Faults>>,
}

impl fmt::Debug for PgCatalog {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PgCatalog")
            .field("name", &self.name)
            .field("warehouse", &self.warehouse)
            .finish_non_exhaustive()
    }
}

/// An sqlx error as the library's.
fn db_error(error: sqlx::Error) -> Error {
    Error::new(ErrorKind::Unexpected, "the catalog database failed").with_source(error)
}

fn no_namespace<T>(namespace: &NamespaceIdent) -> Result<T> {
    Err(Error::new(
        ErrorKind::NamespaceNotFound,
        format!("no such namespace: {namespace:?}"),
    ))
}

fn no_table<T>(table: &TableIdent) -> Result<T> {
    Err(Error::new(
        ErrorKind::TableNotFound,
        format!("no such table: {table}"),
    ))
}

fn table_exists_error<T>(table: &TableIdent) -> Result<T> {
    Err(Error::new(
        ErrorKind::TableAlreadyExists,
        format!("table {table} already exists"),
    ))
}

fn namespace_key(namespace: &NamespaceIdent) -> String {
    namespace.join(".")
}

impl PgCatalog {
    /// The catalog `name` (the `catalog_name` column) on `pool`, its new
    /// tables under `warehouse` (`s3://<bucket>/lake`, `file:/…`), the files
    /// reached with the `storage` properties (`s3.endpoint`, `s3.region`,
    /// `s3.access-key-id`, `s3.secret-access-key`, `s3.path-style-access`).
    /// Must be called inside a tokio runtime (the tables' readers use it).
    pub fn new(
        pool: PgPool,
        name: impl Into<String>,
        warehouse: impl Into<String>,
        storage: &HashMap<String, String>,
    ) -> Result<Self> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(Error::new(
                ErrorKind::DataInvalid,
                "the catalog name is empty",
            ));
        }
        let file_io = FileIOBuilder::new(Arc::new(OpenDalResolvingStorageFactory::new()))
            .with_props(storage.iter())
            .build();
        Ok(Self {
            pool,
            name,
            warehouse: warehouse.into().trim_end_matches('/').to_owned(),
            file_io,
            runtime: Runtime::try_current()?,
            #[cfg(test)]
            faults: Arc::default(),
        })
    }

    /// The failures the next commits see (tests).
    #[cfg(test)]
    pub(crate) fn faults(&self) -> std::sync::MutexGuard<'_, Faults> {
        self.faults
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The tables' file IO.
    pub fn file_io(&self) -> &FileIO {
        &self.file_io
    }

    /// The catalog's name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The table's current metadata file, if the catalog has the table.
    pub async fn metadata_location(&self, table: &TableIdent) -> Result<Option<String>> {
        let row = sqlx::query(
            "SELECT metadata_location FROM iceberg_tables \
             WHERE catalog_name = $1 AND table_namespace = $2 AND table_name = $3 \
             AND (iceberg_type = 'TABLE' OR iceberg_type IS NULL)",
        )
        .bind(&self.name)
        .bind(namespace_key(table.namespace()))
        .bind(table.name())
        .fetch_optional(&self.pool)
        .await
        .map_err(db_error)?;
        row.map(|row| row.try_get::<Option<String>, _>(0))
            .transpose()
            .map(Option::flatten)
            .map_err(db_error)
    }

    /// Points the table at `new_location` if it still points at `expected`:
    /// the commit. A database failure on its `COMMIT` is settled by reading
    /// the row again ([`SwapOutcome`]).
    pub async fn swap_metadata(
        &self,
        table: &TableIdent,
        expected: &str,
        new_location: &str,
    ) -> SwapOutcome {
        match self.try_swap(table, expected, new_location).await {
            Ok(true) => SwapOutcome::Swapped,
            Ok(false) => SwapOutcome::Lost,
            Err(TxFailure::BeforeCommit(error)) => SwapOutcome::Failed(error),
            Err(TxFailure::AtCommit(error)) => {
                match self.settle(table, Some(expected), new_location).await {
                    Ok(true) => {
                        tracing::warn!(%table, %error, "the catalog lost a commit's answer; it landed");
                        SwapOutcome::Swapped
                    }
                    Ok(false) => SwapOutcome::Failed(error),
                    Err(why) => {
                        tracing::error!(%table, %error, why, "whether a commit landed is unknown; its files are kept");
                        SwapOutcome::Unknown(format!("{error}; reading the table again: {why}"))
                    }
                }
            }
        }
    }

    /// The swap in a transaction of its own: false when another commit got
    /// there first.
    async fn try_swap(
        &self,
        table: &TableIdent,
        expected: &str,
        new_location: &str,
    ) -> std::result::Result<bool, TxFailure> {
        let mut tx = self.pool.begin().await.map_err(TxFailure::BeforeCommit)?;
        let updated = sqlx::query(
            "UPDATE iceberg_tables SET metadata_location = $1, previous_metadata_location = $2 \
             WHERE catalog_name = $3 AND table_namespace = $4 AND table_name = $5 \
             AND (iceberg_type = 'TABLE' OR iceberg_type IS NULL) AND metadata_location = $2",
        )
        .bind(new_location)
        .bind(expected)
        .bind(&self.name)
        .bind(namespace_key(table.namespace()))
        .bind(table.name())
        .execute(&mut *tx)
        .await
        .map_err(TxFailure::BeforeCommit)?;
        if updated.rows_affected() != 1 {
            let _ = tx.rollback().await;
            return Ok(false);
        }
        self.commit_tx(tx).await?;
        Ok(true)
    }

    /// Commits a transaction that changes the catalog.
    async fn commit_tx(
        &self,
        tx: sqlx::Transaction<'static, sqlx::Postgres>,
    ) -> std::result::Result<(), TxFailure> {
        #[cfg(test)]
        {
            let fault = self.faults().commit.take();
            match fault {
                Some(CommitFault::ConnectionDrops) => {
                    let _ = tx.rollback().await;
                    return Err(TxFailure::BeforeCommit(injected()));
                }
                Some(CommitFault::AnswerLostLanded) => {
                    tx.commit().await.map_err(TxFailure::AtCommit)?;
                    return Err(TxFailure::AtCommit(injected()));
                }
                Some(CommitFault::AnswerLostNotLanded) => {
                    let _ = tx.rollback().await;
                    return Err(TxFailure::AtCommit(injected()));
                }
                None => {}
            }
        }
        tx.commit().await.map_err(TxFailure::AtCommit)
    }

    /// Settles a commit pointing the table at `new_location` (from
    /// `expected`, or a new row) whose `COMMIT` failed: whether it landed,
    /// tried [`SETTLE_ATTEMPTS`] times; why it can't be told otherwise.
    async fn settle(
        &self,
        table: &TableIdent,
        expected: Option<&str>,
        new_location: &str,
    ) -> std::result::Result<bool, String> {
        let mut why = String::new();
        for attempt in 1..=SETTLE_ATTEMPTS {
            match self.landed(table, expected, new_location).await {
                Ok(Some(landed)) => return Ok(landed),
                Ok(None) => return Err("the table's history doesn't say".to_owned()),
                Err(error) => why = error.to_string(),
            }
            if attempt < SETTLE_ATTEMPTS {
                tokio::time::sleep(Duration::from_millis(250 << attempt)).await;
            }
        }
        Err(why)
    }

    /// Whether a commit pointing the table at `new_location` (from
    /// `expected`, or a new row) landed, its answer lost: the row read again
    /// under a share lock, so a `COMMIT` still in flight is waited for. Yes
    /// when the table points at it or its history runs through it; no when
    /// it still points at `expected`, or its history runs through `expected`
    /// and not through it; `None` when that can't be told (the row is gone,
    /// or the history was trimmed past both).
    pub(crate) async fn landed(
        &self,
        table: &TableIdent,
        expected: Option<&str>,
        new_location: &str,
    ) -> Result<Option<bool>> {
        #[cfg(test)]
        if self.faults().settle_fails {
            return Err(db_error(injected()));
        }
        let Some(current) = self.locked_location(table).await.map_err(db_error)? else {
            return Ok(None);
        };
        if current == new_location {
            return Ok(Some(true));
        }
        if expected == Some(current.as_str()) {
            return Ok(Some(false));
        }
        // Another commit came since: the history it keeps.
        let metadata = TableMetadata::read_from(&self.file_io, &current).await?;
        let history: HashSet<&str> = metadata
            .metadata_log()
            .iter()
            .map(|entry| entry.metadata_file.as_str())
            .collect();
        Ok(if history.contains(new_location) {
            Some(true)
        } else if expected.is_some_and(|expected| history.contains(expected)) {
            Some(false)
        } else {
            None
        })
    }

    /// The table's metadata file, read under a share lock on its row (a
    /// transaction still holding it is waited for, up to
    /// [`SETTLE_LOCK_TIMEOUT`]).
    async fn locked_location(
        &self,
        table: &TableIdent,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT set_config('lock_timeout', $1, true)")
            .bind(SETTLE_LOCK_TIMEOUT)
            .execute(&mut *tx)
            .await?;
        let row = sqlx::query(
            "SELECT metadata_location FROM iceberg_tables \
             WHERE catalog_name = $1 AND table_namespace = $2 AND table_name = $3 \
             AND (iceberg_type = 'TABLE' OR iceberg_type IS NULL) FOR SHARE",
        )
        .bind(&self.name)
        .bind(namespace_key(table.namespace()))
        .bind(table.name())
        .fetch_optional(&mut *tx)
        .await?;
        let _ = tx.rollback().await;
        row.map(|row| row.try_get::<Option<String>, _>(0))
            .transpose()
            .map(Option::flatten)
    }

    fn table(&self, ident: TableIdent, location: String, metadata: TableMetadata) -> Result<Table> {
        Table::builder()
            .file_io(self.file_io.clone())
            .identifier(ident)
            .metadata_location(location)
            .metadata(metadata)
            .runtime(self.runtime.clone())
            .build()
    }

    async fn namespace_properties(
        &self,
        namespace: &NamespaceIdent,
    ) -> Result<Option<HashMap<String, String>>> {
        let rows = sqlx::query(
            "SELECT property_key, property_value FROM iceberg_namespace_properties \
             WHERE catalog_name = $1 AND namespace = $2",
        )
        .bind(&self.name)
        .bind(namespace_key(namespace))
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;
        if rows.is_empty() {
            // A namespace that only has tables (made by another tool) exists
            // without properties.
            return Ok(self.has_tables_in(namespace).await?.then(HashMap::new));
        }
        rows.iter()
            .map(|row| {
                Ok((
                    row.try_get::<String, _>(0).map_err(db_error)?,
                    row.try_get::<Option<String>, _>(1)
                        .map_err(db_error)?
                        .unwrap_or_default(),
                ))
            })
            .collect::<Result<HashMap<_, _>>>()
            .map(Some)
    }

    async fn has_tables_in(&self, namespace: &NamespaceIdent) -> Result<bool> {
        let row = sqlx::query(
            "SELECT 1 FROM iceberg_tables WHERE catalog_name = $1 AND table_namespace = $2 LIMIT 1",
        )
        .bind(&self.name)
        .bind(namespace_key(namespace))
        .fetch_optional(&self.pool)
        .await
        .map_err(db_error)?;
        Ok(row.is_some())
    }

    /// Inserts the table row pointing at `location`, in a transaction of its
    /// own: [`SwapOutcome::Lost`] when a row was there first, and a failed
    /// `COMMIT` settled as a swap's is.
    async fn insert_table(&self, ident: &TableIdent, location: &str) -> SwapOutcome {
        let inserted = async {
            let mut tx = self.pool.begin().await.map_err(TxFailure::BeforeCommit)?;
            let inserted = sqlx::query(
                "INSERT INTO iceberg_tables \
                 (catalog_name, table_namespace, table_name, metadata_location, iceberg_type) \
                 VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
            )
            .bind(&self.name)
            .bind(namespace_key(ident.namespace()))
            .bind(ident.name())
            .bind(location)
            .bind(TABLE_TYPE)
            .execute(&mut *tx)
            .await
            .map_err(TxFailure::BeforeCommit)?;
            if inserted.rows_affected() == 0 {
                let _ = tx.rollback().await;
                return Ok(false);
            }
            self.commit_tx(tx).await?;
            Ok(true)
        }
        .await;
        match inserted {
            Ok(true) => SwapOutcome::Swapped,
            Ok(false) => SwapOutcome::Lost,
            Err(TxFailure::BeforeCommit(error)) => SwapOutcome::Failed(error),
            Err(TxFailure::AtCommit(error)) => match self.settle(ident, None, location).await {
                Ok(true) => SwapOutcome::Swapped,
                Ok(false) => SwapOutcome::Failed(error),
                Err(why) => {
                    SwapOutcome::Unknown(format!("{error}; reading the table again: {why}"))
                }
            },
        }
    }

    async fn delete_quietly(&self, path: &str) {
        if let Err(error) = self.file_io.delete(path).await {
            tracing::warn!(%error, path, "could not delete a metadata file a failed commit wrote");
        }
    }
}

#[async_trait]
impl Catalog for PgCatalog {
    async fn list_namespaces(
        &self,
        parent: Option<&NamespaceIdent>,
    ) -> Result<Vec<NamespaceIdent>> {
        let rows = sqlx::query(
            "SELECT table_namespace FROM iceberg_tables WHERE catalog_name = $1 \
             UNION SELECT namespace FROM iceberg_namespace_properties WHERE catalog_name = $1",
        )
        .bind(&self.name)
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;
        let names = rows
            .iter()
            .map(|row| row.try_get::<String, _>(0).map_err(db_error))
            .collect::<Result<Vec<String>>>()?;
        let mut out = HashSet::new();
        match parent {
            None => {
                for name in &names {
                    if let Some(first) = name.split('.').next() {
                        out.insert(NamespaceIdent::new(first.to_owned()));
                    }
                }
            }
            Some(parent) => {
                if !self.namespace_exists(parent).await? {
                    return no_namespace(parent);
                }
                let prefix = format!("{}.", namespace_key(parent));
                for name in &names {
                    if name.starts_with(&prefix) {
                        out.insert(NamespaceIdent::from_strs(name.split('.'))?);
                    }
                }
            }
        }
        Ok(out.into_iter().collect())
    }

    async fn create_namespace(
        &self,
        namespace: &NamespaceIdent,
        properties: HashMap<String, String>,
    ) -> Result<Namespace> {
        let mut stored = properties.clone();
        stored.insert("exists".to_owned(), "true".to_owned());
        let mut tx = self.pool.begin().await.map_err(db_error)?;
        for (key, value) in &stored {
            let inserted = sqlx::query(
                "INSERT INTO iceberg_namespace_properties \
                 (catalog_name, namespace, property_key, property_value) \
                 VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
            )
            .bind(&self.name)
            .bind(namespace_key(namespace))
            .bind(key)
            .bind(value)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
            if inserted.rows_affected() == 0 {
                return Err(Error::new(
                    ErrorKind::NamespaceAlreadyExists,
                    format!("namespace {namespace:?} already exists"),
                ));
            }
        }
        tx.commit().await.map_err(db_error)?;
        Ok(Namespace::with_properties(namespace.clone(), properties))
    }

    async fn get_namespace(&self, namespace: &NamespaceIdent) -> Result<Namespace> {
        match self.namespace_properties(namespace).await? {
            Some(properties) => Ok(Namespace::with_properties(namespace.clone(), properties)),
            None => no_namespace(namespace),
        }
    }

    async fn namespace_exists(&self, namespace: &NamespaceIdent) -> Result<bool> {
        let row = sqlx::query(
            "SELECT 1 FROM iceberg_namespace_properties WHERE catalog_name = $1 AND namespace = $2 \
             UNION ALL SELECT 1 FROM iceberg_tables WHERE catalog_name = $1 AND table_namespace = $2 \
             LIMIT 1",
        )
        .bind(&self.name)
        .bind(namespace_key(namespace))
        .fetch_optional(&self.pool)
        .await
        .map_err(db_error)?;
        Ok(row.is_some())
    }

    async fn update_namespace(
        &self,
        namespace: &NamespaceIdent,
        properties: HashMap<String, String>,
    ) -> Result<()> {
        if !self.namespace_exists(namespace).await? {
            return no_namespace(namespace);
        }
        let mut tx = self.pool.begin().await.map_err(db_error)?;
        for (key, value) in &properties {
            sqlx::query(
                "INSERT INTO iceberg_namespace_properties \
                 (catalog_name, namespace, property_key, property_value) VALUES ($1, $2, $3, $4) \
                 ON CONFLICT (catalog_name, namespace, property_key) \
                 DO UPDATE SET property_value = excluded.property_value",
            )
            .bind(&self.name)
            .bind(namespace_key(namespace))
            .bind(key)
            .bind(value)
            .execute(&mut *tx)
            .await
            .map_err(db_error)?;
        }
        tx.commit().await.map_err(db_error)
    }

    async fn drop_namespace(&self, namespace: &NamespaceIdent) -> Result<()> {
        if !self.namespace_exists(namespace).await? {
            return no_namespace(namespace);
        }
        if self.has_tables_in(namespace).await? {
            return Err(Error::new(
                ErrorKind::Unexpected,
                format!("namespace {namespace:?} still has tables"),
            ));
        }
        sqlx::query(
            "DELETE FROM iceberg_namespace_properties WHERE catalog_name = $1 AND namespace = $2",
        )
        .bind(&self.name)
        .bind(namespace_key(namespace))
        .execute(&self.pool)
        .await
        .map_err(db_error)?;
        Ok(())
    }

    async fn list_tables(&self, namespace: &NamespaceIdent) -> Result<Vec<TableIdent>> {
        if !self.namespace_exists(namespace).await? {
            return no_namespace(namespace);
        }
        let rows = sqlx::query(
            "SELECT table_name FROM iceberg_tables \
             WHERE catalog_name = $1 AND table_namespace = $2 \
             AND (iceberg_type = 'TABLE' OR iceberg_type IS NULL) ORDER BY table_name",
        )
        .bind(&self.name)
        .bind(namespace_key(namespace))
        .fetch_all(&self.pool)
        .await
        .map_err(db_error)?;
        rows.iter()
            .map(|row| {
                Ok(TableIdent::new(
                    namespace.clone(),
                    row.try_get::<String, _>(0).map_err(db_error)?,
                ))
            })
            .collect()
    }

    async fn create_table(
        &self,
        namespace: &NamespaceIdent,
        creation: TableCreation,
    ) -> Result<Table> {
        let Some(properties) = self.namespace_properties(namespace).await? else {
            return no_namespace(namespace);
        };
        let ident = TableIdent::new(namespace.clone(), creation.name.clone());
        if self.metadata_location(&ident).await?.is_some() {
            return table_exists_error(&ident);
        }
        let creation = if creation.location.is_some() {
            creation
        } else {
            let base = properties.get(LOCATION_PROPERTY).map_or_else(
                || format!("{}/{}", self.warehouse, namespace.join("/")),
                |location| location.trim_end_matches('/').to_owned(),
            );
            TableCreation {
                location: Some(format!("{base}/{}", ident.name())),
                ..creation
            }
        };
        let metadata = TableMetadataBuilder::from_table_creation(creation)?
            .build()?
            .metadata;
        let location = MetadataLocation::try_new_with_metadata(&metadata)?.to_string();
        metadata
            .write_to(&self.file_io, &MetadataLocation::from_str(&location)?)
            .await?;
        match self.insert_table(&ident, &location).await {
            SwapOutcome::Swapped => {}
            SwapOutcome::Lost => {
                // Another pod made it first: its metadata stands, ours goes.
                self.delete_quietly(&location).await;
                return table_exists_error(&ident);
            }
            SwapOutcome::Failed(error) => {
                self.delete_quietly(&location).await;
                return Err(db_error(error));
            }
            // Kept: the row may name it (the orphan sweep takes it if not).
            SwapOutcome::Unknown(reason) => return Err(commit_unknown(&ident, &reason)),
        }
        self.table(ident, location, metadata)
    }

    async fn load_table(&self, table: &TableIdent) -> Result<Table> {
        let Some(location) = self.metadata_location(table).await? else {
            return no_table(table);
        };
        let metadata = TableMetadata::read_from(&self.file_io, &location).await?;
        self.table(table.clone(), location, metadata)
    }

    async fn drop_table(&self, table: &TableIdent) -> Result<()> {
        let dropped = sqlx::query(
            "DELETE FROM iceberg_tables \
             WHERE catalog_name = $1 AND table_namespace = $2 AND table_name = $3 \
             AND (iceberg_type = 'TABLE' OR iceberg_type IS NULL)",
        )
        .bind(&self.name)
        .bind(namespace_key(table.namespace()))
        .bind(table.name())
        .execute(&self.pool)
        .await
        .map_err(db_error)?;
        if dropped.rows_affected() == 0 {
            return no_table(table);
        }
        Ok(())
    }

    async fn purge_table(&self, table: &TableIdent) -> Result<()> {
        let loaded = self.load_table(table).await?;
        self.drop_table(table).await?;
        iceberg::drop_table_data(&loaded).await
    }

    async fn table_exists(&self, table: &TableIdent) -> Result<bool> {
        Ok(self.metadata_location(table).await?.is_some())
    }

    async fn rename_table(&self, src: &TableIdent, dest: &TableIdent) -> Result<()> {
        if src == dest {
            return Ok(());
        }
        if !self.namespace_exists(dest.namespace()).await? {
            return no_namespace(dest.namespace());
        }
        if self.table_exists(dest).await? {
            return table_exists_error(dest);
        }
        let renamed = sqlx::query(
            "UPDATE iceberg_tables SET table_namespace = $1, table_name = $2 \
             WHERE catalog_name = $3 AND table_namespace = $4 AND table_name = $5 \
             AND (iceberg_type = 'TABLE' OR iceberg_type IS NULL)",
        )
        .bind(namespace_key(dest.namespace()))
        .bind(dest.name())
        .bind(&self.name)
        .bind(namespace_key(src.namespace()))
        .bind(src.name())
        .execute(&self.pool)
        .await
        .map_err(db_error)?;
        if renamed.rows_affected() == 0 {
            return no_table(src);
        }
        Ok(())
    }

    async fn register_table(&self, table: &TableIdent, metadata_location: String) -> Result<Table> {
        if !self.namespace_exists(table.namespace()).await? {
            return no_namespace(table.namespace());
        }
        let metadata = TableMetadata::read_from(&self.file_io, &metadata_location).await?;
        match self.insert_table(table, &metadata_location).await {
            SwapOutcome::Swapped => {}
            SwapOutcome::Lost => return table_exists_error(table),
            SwapOutcome::Failed(error) => return Err(db_error(error)),
            SwapOutcome::Unknown(reason) => return Err(commit_unknown(table, &reason)),
        }
        self.table(table.clone(), metadata_location, metadata)
    }

    /// The library's commits: the commit's requirements checked against the
    /// current metadata, the new metadata written, then the compare-and-swap.
    /// Losing it is a retryable [`ErrorKind::CatalogCommitConflicts`]
    /// (`Transaction::commit` then starts over on the new state); a database
    /// failure that settles as landed is the commit, one that settles as not
    /// landed an error (the metadata file deleted either way it didn't
    /// land), and one that can't be settled an error [`is_commit_unknown`]
    /// tells, the metadata file kept.
    async fn update_table(&self, commit: TableCommit) -> Result<Table> {
        let ident = commit.identifier().clone();
        let current = self.load_table(&ident).await?;
        let base = current.metadata_location_result()?.to_owned();
        let staged = commit.apply(current)?;
        let location = MetadataLocation::from_str(staged.metadata_location_result()?)?;
        staged
            .metadata()
            .write_to(staged.file_io(), &location)
            .await?;
        let location = location.to_string();
        match self.swap_metadata(&ident, &base, &location).await {
            SwapOutcome::Swapped => Ok(staged),
            SwapOutcome::Lost => {
                self.delete_quietly(&location).await;
                Err(Error::new(
                    ErrorKind::CatalogCommitConflicts,
                    format!("{ident} changed under the commit"),
                )
                .with_retryable(true))
            }
            SwapOutcome::Failed(error) => {
                self.delete_quietly(&location).await;
                Err(db_error(error))
            }
            SwapOutcome::Unknown(reason) => Err(commit_unknown(&ident, &reason)),
        }
    }
}
