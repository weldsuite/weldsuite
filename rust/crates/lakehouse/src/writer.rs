//! Writing: rows to zstd Parquet data files, split by the table's partition
//! spec (fanout: rows may come in any partition order), and one fast-append
//! commit per flush that records the last NATS stream sequence it holds
//! ([`STREAM_SEQ_PROPERTY`]), so a writer that restarts skips what is
//! already committed.
//!
//! [`Lakehouse::append_after`] is the writer's commit. It is fenced on that
//! sequence: of two writers that both believe they hold a table (a lease
//! that ran out under a long pause), only the one that read the current
//! sequence commits; the other gets [`LakehouseError::Conflict`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use arrow_array::RecordBatch;
use arrow_schema::SchemaRef;
use async_trait::async_trait;
use iceberg::arrow::{RecordBatchPartitionSplitter, schema_to_arrow_schema};
use iceberg::spec::{DataFile, DataFileFormat, TableMetadata};
use iceberg::table::Table;
use iceberg::transaction::{ApplyTransactionAction, Transaction};
use iceberg::writer::base_writer::data_file_writer::DataFileWriterBuilder;
use iceberg::writer::file_writer::ParquetWriterBuilder;
use iceberg::writer::file_writer::location_generator::{
    DefaultFileNameGenerator, DefaultLocationGenerator,
};
use iceberg::writer::file_writer::rolling_writer::RollingFileWriterBuilder;
use iceberg::writer::partitioning::PartitioningWriter;
use iceberg::writer::partitioning::fanout_writer::FanoutWriter;
use iceberg::{
    Catalog, Error, ErrorKind, Namespace, NamespaceIdent, TableCommit, TableCreation, TableIdent,
};
use serde_json::Value;
use std::sync::Arc;

use crate::catalog::Lakehouse;
use crate::error::{LakehouseError, Result};
use crate::pg_catalog::PgCatalog;
use crate::replace::delete_quietly;
use crate::rows::rows_to_batch;
use crate::tables::PanelTable;

/// The snapshot summary property holding the last NATS stream sequence a
/// commit holds. Replace commits carry it forward, so it survives expiry.
pub const STREAM_SEQ_PROPERTY: &str = "weldsuite.stream-seq";

/// What one flush committed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppendOutcome {
    /// The new snapshot.
    pub snapshot_id: i64,
    /// The data files it added.
    pub data_files: Vec<String>,
}

impl Lakehouse {
    /// Writes `rows` to `table` and commits them with a fast append, with
    /// `stream_seq` (the last NATS sequence among them) in the snapshot
    /// summary. Nothing to write is no commit. The library retries the commit
    /// on top of a concurrent one; the data files are written once.
    pub async fn append_rows(
        &self,
        table: PanelTable,
        rows: &[Value],
        stream_seq: Option<u64>,
    ) -> Result<Option<AppendOutcome>> {
        if rows.is_empty() {
            return Ok(None);
        }
        let current = self.load(table).await?;
        let schema = Arc::new(schema_to_arrow_schema(current.metadata().current_schema())?);
        let batch = rows_to_batch(&schema, rows)?;
        let data_files = write_data_files(&current, &[batch]).await?;
        let paths = data_files
            .iter()
            .map(|file| file.file_path().to_owned())
            .collect();
        let mut properties = HashMap::new();
        if let Some(seq) = stream_seq {
            properties.insert(STREAM_SEQ_PROPERTY.to_owned(), seq.to_string());
        }
        let tx = Transaction::new(&current);
        let tx = tx
            .fast_append()
            .add_data_files(data_files)
            .set_snapshot_properties(properties)
            .apply(tx)?;
        let committed = tx.commit(self.catalog()).await?;
        let snapshot_id = committed
            .metadata()
            .current_snapshot_id()
            .unwrap_or_default();
        Ok(Some(AppendOutcome {
            snapshot_id,
            data_files: paths,
        }))
    }

    /// The last NATS stream sequence committed to `table`: the newest
    /// snapshot in the current one's ancestry that records one.
    pub async fn last_stream_seq(&self, table: PanelTable) -> Result<Option<u64>> {
        let current = self.load(table).await?;
        Ok(stream_seq_of(current.metadata()))
    }

    /// The table's current schema in Arrow, with the field ids the writer
    /// matches columns by: what [`crate::rows_to_batch`] builds batches in.
    pub async fn arrow_schema(&self, table: PanelTable) -> Result<SchemaRef> {
        let current = self.load(table).await?;
        Ok(Arc::new(schema_to_arrow_schema(
            current.metadata().current_schema(),
        )?))
    }

    /// The writer's commit: `batches` (in [`Self::arrow_schema`]) as data
    /// files and one fast append recording `stream_seq`, only if the table's
    /// last committed sequence is still `expected` (what this writer read
    /// when it took the table, or committed last). Losing the swap to another
    /// commit retries on top of it (a maintenance replace, an expiry); a
    /// sequence that moved is [`LakehouseError::Conflict`], and nothing is
    /// committed. On any failure the data files written are deleted again.
    /// Nothing to write is no commit.
    pub async fn append_after(
        &self,
        table: PanelTable,
        batches: &[RecordBatch],
        stream_seq: u64,
        expected: Option<u64>,
    ) -> Result<Option<AppendOutcome>> {
        if batches.iter().all(|batch| batch.num_rows() == 0) {
            return Ok(None);
        }
        let current = self.load(table).await?;
        let found = stream_seq_of(current.metadata());
        if found != expected {
            return Err(moved(table, expected, found));
        }
        let data_files = write_data_files(&current, batches).await?;
        let paths: Vec<String> = data_files
            .iter()
            .map(|file| file.file_path().to_owned())
            .collect();
        let fence = SequenceFence {
            inner: self.catalog(),
            table: table.ident(),
            expected,
            tripped: AtomicBool::new(false),
        };
        let tx = Transaction::new(&current);
        let committed = tx
            .fast_append()
            .add_data_files(data_files)
            .set_snapshot_properties(HashMap::from([(
                STREAM_SEQ_PROPERTY.to_owned(),
                stream_seq.to_string(),
            )]))
            .apply(tx)
            .map_err(LakehouseError::from);
        let committed = match committed {
            Ok(tx) => tx.commit(&fence).await.map_err(|error| {
                if fence.tripped.load(Ordering::Relaxed) {
                    moved(table, expected, None)
                } else {
                    error.into()
                }
            }),
            Err(error) => Err(error),
        };
        match committed {
            Ok(committed) => Ok(Some(AppendOutcome {
                snapshot_id: committed
                    .metadata()
                    .current_snapshot_id()
                    .unwrap_or_default(),
                data_files: paths,
            })),
            Err(error) => {
                delete_quietly(current.file_io(), &paths).await;
                Err(error)
            }
        }
    }
}

fn moved(table: PanelTable, expected: Option<u64>, found: Option<u64>) -> LakehouseError {
    LakehouseError::Conflict(format!(
        "{}: the committed stream sequence moved (expected {expected:?}, found {})",
        table.name(),
        found.map_or_else(|| "another".to_owned(), |seq| seq.to_string()),
    ))
}

/// The catalog as [`Lakehouse::append_after`]'s commit sees it: the library
/// reloads the table before every attempt, and here that reload fails (not
/// retryably) when the table's committed stream sequence is no longer the
/// one expected, so a retry never lands on another writer's commit.
struct SequenceFence<'a> {
    inner: &'a PgCatalog,
    table: TableIdent,
    expected: Option<u64>,
    tripped: AtomicBool,
}

impl std::fmt::Debug for SequenceFence<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SequenceFence")
            .field("table", &self.table)
            .field("expected", &self.expected)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl Catalog for SequenceFence<'_> {
    async fn list_namespaces(
        &self,
        parent: Option<&NamespaceIdent>,
    ) -> iceberg::Result<Vec<NamespaceIdent>> {
        self.inner.list_namespaces(parent).await
    }

    async fn create_namespace(
        &self,
        namespace: &NamespaceIdent,
        properties: HashMap<String, String>,
    ) -> iceberg::Result<Namespace> {
        self.inner.create_namespace(namespace, properties).await
    }

    async fn get_namespace(&self, namespace: &NamespaceIdent) -> iceberg::Result<Namespace> {
        self.inner.get_namespace(namespace).await
    }

    async fn namespace_exists(&self, namespace: &NamespaceIdent) -> iceberg::Result<bool> {
        self.inner.namespace_exists(namespace).await
    }

    async fn update_namespace(
        &self,
        namespace: &NamespaceIdent,
        properties: HashMap<String, String>,
    ) -> iceberg::Result<()> {
        self.inner.update_namespace(namespace, properties).await
    }

    async fn drop_namespace(&self, namespace: &NamespaceIdent) -> iceberg::Result<()> {
        self.inner.drop_namespace(namespace).await
    }

    async fn list_tables(&self, namespace: &NamespaceIdent) -> iceberg::Result<Vec<TableIdent>> {
        self.inner.list_tables(namespace).await
    }

    async fn create_table(
        &self,
        namespace: &NamespaceIdent,
        creation: TableCreation,
    ) -> iceberg::Result<Table> {
        self.inner.create_table(namespace, creation).await
    }

    async fn load_table(&self, table: &TableIdent) -> iceberg::Result<Table> {
        let loaded = self.inner.load_table(table).await?;
        if *table == self.table && stream_seq_of(loaded.metadata()) != self.expected {
            self.tripped.store(true, Ordering::Relaxed);
            return Err(Error::new(
                ErrorKind::CatalogCommitConflicts,
                format!("{table}: another writer committed"),
            )
            .with_retryable(false));
        }
        Ok(loaded)
    }

    async fn drop_table(&self, table: &TableIdent) -> iceberg::Result<()> {
        self.inner.drop_table(table).await
    }

    async fn purge_table(&self, table: &TableIdent) -> iceberg::Result<()> {
        self.inner.purge_table(table).await
    }

    async fn table_exists(&self, table: &TableIdent) -> iceberg::Result<bool> {
        self.inner.table_exists(table).await
    }

    async fn rename_table(&self, src: &TableIdent, dest: &TableIdent) -> iceberg::Result<()> {
        self.inner.rename_table(src, dest).await
    }

    async fn register_table(
        &self,
        table: &TableIdent,
        metadata_location: String,
    ) -> iceberg::Result<Table> {
        self.inner.register_table(table, metadata_location).await
    }

    async fn update_table(&self, commit: TableCommit) -> iceberg::Result<Table> {
        self.inner.update_table(commit).await
    }
}

/// [`STREAM_SEQ_PROPERTY`] of the current snapshot or its nearest ancestor.
pub(crate) fn stream_seq_of(metadata: &TableMetadata) -> Option<u64> {
    let mut snapshot = metadata.current_snapshot();
    while let Some(at) = snapshot {
        if let Some(seq) = at
            .summary()
            .additional_properties
            .get(STREAM_SEQ_PROPERTY)
            .and_then(|text| text.parse().ok())
        {
            return Some(seq);
        }
        snapshot = at
            .parent_snapshot_id()
            .and_then(|parent| metadata.snapshot_by_id(parent));
    }
    None
}

/// Writes the batches as data files of `table` (current schema and
/// partition spec, the table's Parquet settings: zstd), one or more per
/// partition. Nothing is committed.
pub(crate) async fn write_data_files(
    table: &Table,
    batches: &[RecordBatch],
) -> Result<Vec<DataFile>> {
    let mut sink = DataFileSink::new(table)?;
    for batch in batches {
        sink.write(batch).await?;
    }
    sink.close().await
}

/// Data files of a table being written batch by batch (a rewrite streams
/// through one, so it never holds more than a batch and the open row
/// groups), split by the partition spec and rolled at the target size.
pub(crate) struct DataFileSink {
    fanout: FanoutWriter<
        DataFileWriterBuilder<
            ParquetWriterBuilder,
            DefaultLocationGenerator,
            DefaultFileNameGenerator,
        >,
    >,
    splitter: RecordBatchPartitionSplitter,
}

impl DataFileSink {
    pub(crate) fn new(table: &Table) -> Result<Self> {
        let metadata = table.metadata();
        let schema = metadata.current_schema().clone();
        let spec = metadata.default_partition_spec().clone();
        let properties = metadata.table_properties();
        let parquet = ParquetWriterBuilder::from_table_properties(&properties, schema.clone())?;
        let rolling = RollingFileWriterBuilder::new(
            parquet,
            properties.write_target_file_size_bytes()?,
            table.file_io().clone(),
            DefaultLocationGenerator::new(metadata)?,
            // Unique per sink: the generator only counts within itself.
            DefaultFileNameGenerator::new(
                uuid::Uuid::new_v4().to_string(),
                None,
                DataFileFormat::Parquet,
            ),
        );
        Ok(Self {
            fanout: FanoutWriter::new(DataFileWriterBuilder::new(rolling)),
            splitter: RecordBatchPartitionSplitter::try_new_with_computed_values(schema, spec)?,
        })
    }

    /// Writes one batch (in the table's Arrow schema, with its field ids).
    pub(crate) async fn write(&mut self, batch: &RecordBatch) -> Result<()> {
        if batch.num_rows() == 0 {
            return Ok(());
        }
        for (key, part) in self.splitter.split(batch)? {
            self.fanout.write(key, part).await?;
        }
        Ok(())
    }

    /// Closes the open files: the data files written, uncommitted.
    pub(crate) async fn close(self) -> Result<Vec<DataFile>> {
        Ok(self.fanout.close().await?)
    }
}
