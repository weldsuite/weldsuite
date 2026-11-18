//! What can go wrong in the store.

use std::fmt;

/// An error from the store: the table format, the catalog, a query, or rows
/// that don't fit a table.
#[derive(Debug)]
pub enum LakehouseError {
    /// The table format (iceberg-rust): metadata, manifests, data files, storage.
    Iceberg(iceberg::Error),
    /// The catalog database (the compare-and-swap commit, the ledger).
    Catalog(sqlx::Error),
    /// Planning or running a query.
    Query(datafusion::error::DataFusionError),
    /// Building Arrow data.
    Arrow(arrow_schema::ArrowError),
    /// A row that doesn't fit its table.
    Rows(String),
    /// The table changed under a commit in a way a retry can't fix (a file
    /// to remove is gone), or the retries ran out.
    Conflict(String),
    /// A query ran longer than its limit.
    Timeout,
}

impl fmt::Display for LakehouseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Iceberg(error) => write!(f, "iceberg: {error}"),
            Self::Catalog(error) => write!(f, "catalog: {error}"),
            Self::Query(error) => write!(f, "query: {error}"),
            Self::Arrow(error) => write!(f, "arrow: {error}"),
            Self::Rows(message) => write!(f, "rows: {message}"),
            Self::Conflict(message) => write!(f, "commit conflict: {message}"),
            Self::Timeout => f.write_str("the query ran out of time"),
        }
    }
}

impl std::error::Error for LakehouseError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Iceberg(error) => Some(error),
            Self::Catalog(error) => Some(error),
            Self::Query(error) => Some(error),
            Self::Arrow(error) => Some(error),
            Self::Rows(_) | Self::Conflict(_) | Self::Timeout => None,
        }
    }
}

impl From<iceberg::Error> for LakehouseError {
    fn from(error: iceberg::Error) -> Self {
        Self::Iceberg(error)
    }
}

impl From<sqlx::Error> for LakehouseError {
    fn from(error: sqlx::Error) -> Self {
        Self::Catalog(error)
    }
}

impl From<datafusion::error::DataFusionError> for LakehouseError {
    fn from(error: datafusion::error::DataFusionError) -> Self {
        Self::Query(error)
    }
}

impl From<arrow_schema::ArrowError> for LakehouseError {
    fn from(error: arrow_schema::ArrowError) -> Self {
        Self::Arrow(error)
    }
}

/// The store's result.
pub type Result<T> = std::result::Result<T, LakehouseError>;
