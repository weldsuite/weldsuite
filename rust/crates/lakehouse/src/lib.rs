//! WeldPanel's store on the Kubernetes editions (ADR EVT-019): the five
//! `panel.*_v1` tables as Iceberg tables on the install's S3 store, in our
//! own Iceberg catalog on the master Postgres ([`PgCatalog`]); written from
//! NATS with fast appends, kept up with a replace-files commit (compaction,
//! erasure, retention), snapshot expiry and an orphan-file sweep, and queried
//! with Apache DataFusion in the process.
//!
//! - [`tables`]: the tables, their columns and partitioning.
//! - [`Lakehouse`]: the catalog and storage, creating the tables, writing
//!   ([`Lakehouse::append_after`]), replacing files
//!   ([`Lakehouse::replace_files`]) and the upkeep built on it.
//! - [`QueryEngine`]: DataFusion over the tables, and [`json_rows`]: its
//!   rows as the JSON Basin SQL answers on Global.

mod catalog;
mod error;
mod in_subquery;
mod json_rows;
mod like_escape;
mod maintenance;
mod pg_catalog;
mod query;
mod replace;
mod rows;
pub mod tables;
mod writer;

#[cfg(test)]
mod tests;

pub use arrow_array::RecordBatch;
pub use arrow_schema::SchemaRef;
pub use catalog::{CATALOG_NAME, LAKE_PREFIX, Lakehouse, LakehouseConfig, S3Store};
pub use error::{LakehouseError, Result};
pub use iceberg::spec::DataFile;
pub use json_rows::json_rows;
pub use maintenance::{
    Erasure, ErasureCounts, ExpireOutcome, ListedFile, ORPHAN_MIN_AGE, OrphanSweep,
    SMALL_FILE_BYTES, partitions, workspaces_in,
};
pub use pg_catalog::PgCatalog;
pub use query::{QueryEngine, QueryLimits, QueryResult};
pub use replace::{ReplaceFiles, ReplaceOutcome};
pub use rows::{check_row, rows_to_batch};
pub use tables::PanelTable;
pub use writer::{AppendOutcome, STREAM_SEQ_PROPERTY};
