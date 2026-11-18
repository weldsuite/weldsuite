//! Table upkeep on [`Lakehouse::replace_files`]: compaction, erasure and
//! retention, then snapshot expiry and deleting the files no remaining
//! snapshot references.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use arrow_array::{Array, ArrayRef, BooleanArray, RecordBatch, StringArray};
use datafusion::arrow::compute::filter_record_batch;
use futures_util::{StreamExt, TryStreamExt};
use iceberg::arrow::schema_to_arrow_schema;
use iceberg::spec::{DataFile, Literal, Operation, PrimitiveLiteral, Struct};
use iceberg::table::Table;
use iceberg::transaction::{ApplyTransactionAction, Transaction};

use crate::catalog::Lakehouse;
use crate::error::{LakehouseError, Result};
use crate::replace::{ReplaceFiles, ReplaceOutcome, delete_quietly};
use crate::tables::PanelTable;
use crate::writer::write_data_files;

/// Files smaller than this are compacted (a quarter of the target size).
pub const SMALL_FILE_BYTES: u64 = 32 * 1024 * 1024;

/// What expiry did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExpireOutcome {
    /// Snapshots removed from the table's metadata.
    pub expired_snapshots: usize,
    /// Files deleted: data files, manifests, manifest lists, metadata files.
    pub deleted_files: Vec<String>,
}

impl Lakehouse {
    /// The current snapshot's live data files.
    pub async fn live_data_files(&self, table: PanelTable) -> Result<Vec<DataFile>> {
        live_files(&self.load(table).await?).await
    }

    /// Bin-packs the small files of one partition (its `workspace_id`, and
    /// its day as days since 1970 for the day-partitioned tables) into one.
    /// Rows are unchanged. Nothing to do (fewer than two small files) is
    /// `None`.
    pub async fn compact_partition(
        &self,
        table: PanelTable,
        workspace_id: &str,
        day: Option<i32>,
    ) -> Result<Option<ReplaceOutcome>> {
        let current = self.load(table).await?;
        let small: Vec<DataFile> = live_files(&current)
            .await?
            .into_iter()
            .filter(|file| {
                partition_workspace(file.partition()) == Some(workspace_id)
                    && partition_day(file.partition()) == day
                    && file.file_size_in_bytes() < SMALL_FILE_BYTES
            })
            .collect();
        if small.len() < 2 {
            return Ok(None);
        }
        let remove: HashSet<String> = small
            .iter()
            .map(|file| file.file_path().to_owned())
            .collect();
        let batches = read_files(&current, &remove).await?;
        let add = write_data_files(&current, &batches).await?;
        self.commit_or_clean(
            table,
            &current,
            ReplaceFiles {
                operation: Operation::Replace,
                remove,
                add,
            },
        )
        .await
        .map(Some)
    }

    /// Rewrites `workspace_id`'s files of `table` without the rows whose
    /// `columns` (`distinct_id`, `anon_id`, `user_id`, …) hold one of `ids`.
    /// Files without such rows are left alone; a file with only such rows is
    /// removed. Nothing to erase is `None`.
    pub async fn erase(
        &self,
        table: PanelTable,
        workspace_id: &str,
        columns: &[&str],
        ids: &HashSet<String>,
    ) -> Result<Option<ReplaceOutcome>> {
        let current = self.load(table).await?;
        let files: Vec<DataFile> = live_files(&current)
            .await?
            .into_iter()
            .filter(|file| partition_workspace(file.partition()) == Some(workspace_id))
            .collect();
        let mut remove = HashSet::new();
        let mut keep = Vec::new();
        for file in files {
            let path = HashSet::from([file.file_path().to_owned()]);
            let batches = read_files(&current, &path).await?;
            let mut erased = false;
            let mut kept = Vec::new();
            for batch in batches {
                let mask = not_erased(&batch, columns, ids)?;
                if mask.true_count() < batch.num_rows() {
                    erased = true;
                }
                if mask.true_count() > 0 {
                    kept.push(filter_record_batch(&batch, &mask)?);
                }
            }
            if erased {
                remove.extend(path);
                keep.extend(kept);
            }
        }
        if remove.is_empty() {
            return Ok(None);
        }
        let add = if keep.is_empty() {
            Vec::new()
        } else {
            write_data_files(&current, &keep).await?
        };
        let operation = if add.is_empty() {
            Operation::Delete
        } else {
            Operation::Overwrite
        };
        self.commit_or_clean(
            table,
            &current,
            ReplaceFiles {
                operation,
                remove,
                add,
            },
        )
        .await
        .map(Some)
    }

    /// Drops `workspace_id`'s whole day partitions before `before_day` (days
    /// since 1970) from a day-partitioned table. Nothing is rewritten.
    pub async fn drop_days_before(
        &self,
        table: PanelTable,
        workspace_id: &str,
        before_day: i32,
    ) -> Result<Option<ReplaceOutcome>> {
        if table.day_column().is_none() {
            return Err(LakehouseError::Rows(format!(
                "{} has no day partitions",
                table.name()
            )));
        }
        let current = self.load(table).await?;
        let remove: HashSet<String> = live_files(&current)
            .await?
            .into_iter()
            .filter(|file| {
                partition_workspace(file.partition()) == Some(workspace_id)
                    && partition_day(file.partition()).is_some_and(|day| day < before_day)
            })
            .map(|file| file.file_path().to_owned())
            .collect();
        if remove.is_empty() {
            return Ok(None);
        }
        self.replace_files(
            table,
            &ReplaceFiles {
                operation: Operation::Delete,
                remove,
                add: Vec::new(),
            },
        )
        .await
        .map(Some)
    }

    /// Expires snapshots older than `older_than_ms` (keeping at least the
    /// newest `retain_last`, at least one) with the library's action, then
    /// deletes every file the expired snapshots reached that no remaining
    /// snapshot does: data files, manifests, manifest lists, and the metadata
    /// files the table's log let go of.
    pub async fn expire_snapshots(
        &self,
        table: PanelTable,
        older_than_ms: i64,
        retain_last: usize,
    ) -> Result<ExpireOutcome> {
        let before = self.load(table).await?;
        let tx = Transaction::new(&before);
        let tx = tx
            .expire_snapshots()
            .expire_older_than_ms(older_than_ms)
            .retain_last(retain_last.max(1))
            .apply(tx)?;
        let after = tx.commit(self.catalog()).await?;

        let remaining: HashSet<i64> = after
            .metadata()
            .snapshots()
            .map(|snapshot| snapshot.snapshot_id())
            .collect();
        let expired: Vec<i64> = before
            .metadata()
            .snapshots()
            .map(|snapshot| snapshot.snapshot_id())
            .filter(|id| !remaining.contains(id))
            .collect();
        if expired.is_empty() {
            return Ok(ExpireOutcome::default());
        }
        let mut kept = HashSet::new();
        for id in &remaining {
            reachable(&after, *id, true, &mut kept).await?;
        }
        let mut candidates = HashSet::new();
        for id in &expired {
            reachable(&before, *id, false, &mut candidates).await?;
        }
        let logged = |table: &Table| -> HashSet<String> {
            table
                .metadata()
                .metadata_log()
                .iter()
                .map(|entry| entry.metadata_file.clone())
                .chain(table.metadata_location().map(str::to_owned))
                .collect()
        };
        let still_logged = logged(&after);
        candidates.extend(
            logged(&before)
                .into_iter()
                .filter(|file| !still_logged.contains(file)),
        );
        let mut deleted: Vec<String> = candidates.difference(&kept).cloned().collect();
        deleted.sort();
        for path in &deleted {
            after.file_io().delete(path).await?;
        }
        Ok(ExpireOutcome {
            expired_snapshots: expired.len(),
            deleted_files: deleted,
        })
    }

    /// Commits `change`; if that fails, deletes the data files it would have
    /// added (nothing references them).
    async fn commit_or_clean(
        &self,
        table: PanelTable,
        current: &Table,
        change: ReplaceFiles,
    ) -> Result<ReplaceOutcome> {
        match self.replace_files(table, &change).await {
            Ok(outcome) => Ok(outcome),
            Err(error) => {
                let added: Vec<String> = change
                    .add
                    .iter()
                    .map(|file| file.file_path().to_owned())
                    .collect();
                delete_quietly(current.file_io(), &added).await;
                Err(error)
            }
        }
    }
}

/// Live data files of the table's current snapshot.
pub(crate) async fn live_files(table: &Table) -> Result<Vec<DataFile>> {
    let Some(snapshot) = table.metadata().current_snapshot() else {
        return Ok(Vec::new());
    };
    let list = table.manifest_list_reader(snapshot).load().await?;
    let mut files = Vec::new();
    for manifest_file in list.entries() {
        let manifest = table.manifest_reader().read(manifest_file).await?;
        files.extend(
            manifest
                .entries()
                .iter()
                .filter(|entry| entry.is_alive())
                .map(|entry| entry.data_file().clone()),
        );
    }
    Ok(files)
}

/// The files `snapshot_id` reaches: its manifest list, its manifests, and
/// the data files they list (only live ones with `live_only`).
async fn reachable(
    table: &Table,
    snapshot_id: i64,
    live_only: bool,
    into: &mut HashSet<String>,
) -> Result<()> {
    let Some(snapshot) = table.metadata().snapshot_by_id(snapshot_id) else {
        return Ok(());
    };
    into.insert(snapshot.manifest_list().to_owned());
    let list = table.manifest_list_reader(snapshot).load().await?;
    for manifest_file in list.entries() {
        into.insert(manifest_file.manifest_path.clone());
        let manifest = table.manifest_reader().read(manifest_file).await?;
        into.extend(
            manifest
                .entries()
                .iter()
                .filter(|entry| !live_only || entry.is_alive())
                .map(|entry| entry.file_path().to_owned()),
        );
    }
    Ok(())
}

/// The rows of the given data files (of the current snapshot), in the
/// table's Arrow schema.
pub(crate) async fn read_files(table: &Table, paths: &HashSet<String>) -> Result<Vec<RecordBatch>> {
    let Some(snapshot) = table.metadata().current_snapshot() else {
        return Ok(Vec::new());
    };
    let scan = table
        .scan()
        .snapshot_id(snapshot.snapshot_id())
        .select_all()
        .build()?;
    let wanted = paths.clone();
    let tasks = scan
        .plan_files()
        .await?
        .try_filter(move |task| std::future::ready(wanted.contains(task.data_file_path())))
        .boxed();
    let schema = Arc::new(schema_to_arrow_schema(table.metadata().current_schema())?);
    let batches: Vec<RecordBatch> = table
        .reader_builder()
        .build()
        .read(tasks)?
        .stream()
        .try_collect()
        .await?;
    // The writer matches columns by field id: give every batch the table's
    // schema (same columns, with the ids).
    batches
        .into_iter()
        .map(|batch| {
            Ok(RecordBatch::try_new(
                schema.clone(),
                batch.columns().to_vec(),
            )?)
        })
        .collect()
}

/// True for the rows to keep: none of `columns` holds one of `ids`.
fn not_erased(
    batch: &RecordBatch,
    columns: &[&str],
    ids: &HashSet<String>,
) -> Result<BooleanArray> {
    let mut keep = vec![true; batch.num_rows()];
    for name in columns {
        let column: &ArrayRef = batch
            .column_by_name(name)
            .ok_or_else(|| LakehouseError::Rows(format!("no column {name}")))?;
        let values = column
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| LakehouseError::Rows(format!("{name} is not text")))?;
        for (row, flag) in keep.iter_mut().enumerate() {
            if values.is_valid(row) && ids.contains(values.value(row)) {
                *flag = false;
            }
        }
    }
    Ok(BooleanArray::from(keep))
}

fn partition_workspace(partition: &Struct) -> Option<&str> {
    match partition.fields().first() {
        Some(Some(Literal::Primitive(PrimitiveLiteral::String(workspace)))) => {
            Some(workspace.as_str())
        }
        _ => None,
    }
}

/// The day partition value (days since 1970), if the table has one.
fn partition_day(partition: &Struct) -> Option<i32> {
    match partition.fields().get(1) {
        Some(Some(Literal::Primitive(PrimitiveLiteral::Int(day)))) => Some(*day),
        _ => None,
    }
}

/// The table's live files grouped by partition (`workspace_id`, day): what
/// a nightly compaction walks.
pub async fn partitions(
    lakehouse: &Lakehouse,
    table: PanelTable,
) -> Result<BTreeMap<(String, Option<i32>), Vec<DataFile>>> {
    let mut groups: BTreeMap<(String, Option<i32>), Vec<DataFile>> = BTreeMap::new();
    for file in lakehouse.live_data_files(table).await? {
        let key = (
            partition_workspace(file.partition())
                .unwrap_or_default()
                .to_owned(),
            partition_day(file.partition()),
        );
        groups.entry(key).or_default().push(file);
    }
    Ok(groups)
}
