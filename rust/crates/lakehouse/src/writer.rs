//! Writing: rows to zstd Parquet data files, split by the table's partition
//! spec (fanout: rows may come in any partition order), and one fast-append
//! commit per flush that records the last NATS stream sequence it holds
//! ([`STREAM_SEQ_PROPERTY`]), so a writer that restarts skips what is
//! already committed.

use std::collections::HashMap;

use arrow_array::RecordBatch;
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
use serde_json::Value;
use std::sync::Arc;

use crate::catalog::Lakehouse;
use crate::error::Result;
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
        // Unique per flush: the generator only counts within itself.
        DefaultFileNameGenerator::new(
            uuid::Uuid::new_v4().to_string(),
            None,
            DataFileFormat::Parquet,
        ),
    );
    let mut fanout = FanoutWriter::new(DataFileWriterBuilder::new(rolling));
    let splitter = RecordBatchPartitionSplitter::try_new_with_computed_values(schema, spec)?;
    for batch in batches {
        for (key, part) in splitter.split(batch)? {
            fanout.write(key, part).await?;
        }
    }
    Ok(fanout.close().await?)
}
