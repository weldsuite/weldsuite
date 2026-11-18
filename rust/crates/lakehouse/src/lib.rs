//! WeldPanel's store on the Kubernetes editions (ADR EVT-019): the five
//! `panel.*_v1` tables as Iceberg tables on the install's S3 store, in a SQL
//! catalog on the master Postgres; written from NATS with fast appends,
//! kept up with a replace-files commit (compaction, erasure, retention) and
//! snapshot expiry, and queried with Apache DataFusion in the process.
//!
//! - [`tables`]: the tables, their columns and partitioning.
//! - [`Lakehouse`]: the catalog and storage, creating the tables, writing
//!   ([`Lakehouse::append_rows`]), replacing files
//!   ([`Lakehouse::replace_files`]) and the upkeep built on it.
//! - [`QueryEngine`]: DataFusion over the tables.

mod catalog;
mod error;
mod like_escape;
mod maintenance;
mod query;
mod replace;
mod rows;
pub mod tables;
mod writer;

#[cfg(test)]
mod tests;

pub use catalog::{Lakehouse, LakehouseConfig};
pub use error::{LakehouseError, Result};
pub use maintenance::{ExpireOutcome, SMALL_FILE_BYTES, partitions};
pub use query::{QueryEngine, QueryLimits, QueryResult};
pub use replace::{ReplaceFiles, ReplaceOutcome};
pub use rows::rows_to_batch;
pub use tables::PanelTable;
pub use writer::{AppendOutcome, STREAM_SEQ_PROPERTY};
