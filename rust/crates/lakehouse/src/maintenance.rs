//! Table upkeep on [`Lakehouse::replace_files`]: compaction, erasure and
//! retention; then snapshot expiry, deleting the files no remaining snapshot
//! references, and the orphan sweep (files under a table that no metadata
//! references at all: what a writer that crashed before its commit, a
//! commit that failed and couldn't clean up, or a commit whose outcome was
//! unknown and didn't land, left behind).
//!
//! Rewrites stream: a file's rows go from the reader through a filter into
//! the new files batch by batch, so compacting a busy day or erasing a
//! long-time visitor never holds more than a batch and the open row groups.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use arrow_array::{Array, ArrayRef, BooleanArray, RecordBatch, StringArray};
use arrow_schema::{DataType, SchemaRef};
use datafusion::arrow::compute::{cast, filter_record_batch};
use futures_util::{StreamExt, TryStreamExt};
use iceberg::arrow::schema_to_arrow_schema;
use iceberg::scan::{ArrowRecordBatchStream, FileScanTask};
use iceberg::spec::{DataFile, Literal, Operation, PrimitiveLiteral, Struct};
use iceberg::table::Table;
use iceberg::transaction::{ApplyTransactionAction, Transaction};

use crate::catalog::Lakehouse;
use crate::error::{LakehouseError, Result};
use crate::replace::{ReplaceFiles, ReplaceOutcome, delete_quietly};
use crate::tables::PanelTable;
use crate::writer::DataFileSink;

/// Files smaller than this are compacted (a quarter of the target size).
pub const SMALL_FILE_BYTES: u64 = 32 * 1024 * 1024;

/// A file under a table that nothing references is deleted only once it is
/// this old: a writer's data files exist before the commit that names them
/// (Java's `remove_orphan_files` waits three days too).
pub const ORPHAN_MIN_AGE: Duration = Duration::from_hours(3 * 24);

/// What expiry did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExpireOutcome {
    /// Snapshots removed from the table's metadata.
    pub expired_snapshots: usize,
    /// Files deleted: data files, manifests, manifest lists, metadata files.
    pub deleted_files: Vec<String>,
}

/// Who to erase from one workspace's rows: per project, the ids (distinct
/// ids, anonymous ids, user ids; session ids for the recording chunks). A
/// row is erased only in its own project, so one person's id in another
/// project of the workspace stays.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Erasure {
    /// The workspace (the partition the rewrite touches).
    pub workspace_id: String,
    /// Project id → the ids to erase there.
    pub ids_by_project: BTreeMap<String, HashSet<String>>,
}

impl Erasure {
    /// One project's ids.
    pub fn new(
        workspace_id: impl Into<String>,
        project_id: impl Into<String>,
        ids: HashSet<String>,
    ) -> Self {
        Self {
            workspace_id: workspace_id.into(),
            ids_by_project: BTreeMap::from([(project_id.into(), ids)]),
        }
    }

    fn is_empty(&self) -> bool {
        self.ids_by_project.values().all(HashSet::is_empty)
    }
}

/// Rows erased per table.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ErasureCounts {
    pub events: u64,
    pub identities: u64,
    pub people: u64,
    pub replay_chunks: u64,
}

/// A file under a table's location, as the object store lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedFile {
    /// The full path, as the table's metadata names files
    /// (`s3://<bucket>/lake/panel/events_v1/data/…`).
    pub path: String,
    /// When it was last written, milliseconds since 1970; unknown is never
    /// an orphan.
    pub modified_ms: Option<i64>,
}

/// What the orphan sweep found (and deleted).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrphanSweep {
    /// Files listed under the table's location.
    pub listed: usize,
    /// Files the table's metadata references.
    pub referenced: usize,
    /// The unreferenced files old enough to delete.
    pub orphans: Vec<String>,
}

impl Lakehouse {
    /// The current snapshot's live data files.
    pub async fn live_data_files(&self, table: PanelTable) -> Result<Vec<DataFile>> {
        live_files(&self.load(table).await?).await
    }

    /// Bin-packs the small files of one partition (its `workspace_id`, and
    /// its day as days since 1970 for the day-partitioned tables) into files
    /// of the target size. Rows are unchanged. Nothing to do (fewer than two
    /// small files) is `None`.
    pub async fn compact_partition(
        &self,
        table: PanelTable,
        workspace_id: &str,
        day: Option<i32>,
    ) -> Result<Option<ReplaceOutcome>> {
        let current = self.load(table).await?;
        let remove: HashSet<String> = live_files(&current)
            .await?
            .into_iter()
            .filter(|file| {
                partition_workspace(file.partition()) == Some(workspace_id)
                    && partition_day(file.partition()) == day
                    && file.file_size_in_bytes() < SMALL_FILE_BYTES
            })
            .map(|file| file.file_path().to_owned())
            .collect();
        if remove.len() < 2 {
            return Ok(None);
        }
        let tasks = planned_tasks(&current, &remove).await?;
        let schema = table_schema(&current)?;
        let mut sink = DataFileSink::new(&current)?;
        let copied: Result<()> = async {
            for task in tasks.into_values() {
                let mut batches = read_task(&current, task)?;
                while let Some(batch) = batches.try_next().await? {
                    sink.write(&with_schema(&schema, &batch)?).await?;
                }
            }
            Ok(())
        }
        .await;
        let add = finish(sink, copied, &current).await?;
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

    /// Rewrites the erasure's workspace's files of `table` without the rows
    /// of its projects whose `columns` (`distinct_id`, `anon_id`,
    /// `user_id`, …) hold one of the project's ids. Files without such rows
    /// are left alone (found by reading only those columns first); a file
    /// with only such rows is removed. Nothing to erase is `None`.
    pub async fn erase(
        &self,
        table: PanelTable,
        erasure: &Erasure,
        columns: &[&str],
    ) -> Result<Option<ReplaceOutcome>> {
        Ok(self.erase_counting(table, erasure, columns).await?.0)
    }

    /// Erases people from all four tables in Global's order
    /// (`panel-maintenance/container/maintenance.py`): the recording chunk
    /// rows of the sessions the people's events name, their identity links,
    /// their profile snapshots, and the events last, so a run that stops
    /// halfway still finds the sessions the next time. Groups are not
    /// personal and stay.
    pub async fn erase_people(&self, erasure: &Erasure) -> Result<ErasureCounts> {
        let mut counts = ErasureCounts::default();
        if erasure.is_empty() {
            return Ok(counts);
        }
        let sessions = self.erased_sessions(erasure).await?;
        if !sessions.is_empty() {
            let chunks = Erasure {
                workspace_id: erasure.workspace_id.clone(),
                ids_by_project: sessions,
            };
            counts.replay_chunks = self
                .erase_counting(PanelTable::ReplayChunks, &chunks, &["session_id"])
                .await?
                .1;
        }
        counts.identities = self
            .erase_counting(PanelTable::Identities, erasure, &["anon_id", "user_id"])
            .await?
            .1;
        counts.people = self
            .erase_counting(PanelTable::People, erasure, &["user_id"])
            .await?
            .1;
        counts.events = self
            .erase_counting(
                PanelTable::Events,
                erasure,
                &["distinct_id", "anon_id", "user_id"],
            )
            .await?
            .1;
        Ok(counts)
    }

    /// The sessions (per project) of the events an erasure names.
    async fn erased_sessions(
        &self,
        erasure: &Erasure,
    ) -> Result<BTreeMap<String, HashSet<String>>> {
        let current = self.load(PanelTable::Events).await?;
        let columns = ["distinct_id", "anon_id", "user_id"];
        let mut sessions: BTreeMap<String, HashSet<String>> = BTreeMap::new();
        for_each_matching_file(
            &current,
            erasure,
            &columns,
            Some("session_id"),
            |_, project, session| {
                sessions
                    .entry(project.to_owned())
                    .or_default()
                    .insert(session.to_owned());
            },
        )
        .await?;
        Ok(sessions)
    }

    async fn erase_counting(
        &self,
        table: PanelTable,
        erasure: &Erasure,
        columns: &[&str],
    ) -> Result<(Option<ReplaceOutcome>, u64)> {
        if erasure.is_empty() {
            return Ok((None, 0));
        }
        let current = self.load(table).await?;
        let mut remove = HashSet::new();
        for_each_matching_file(&current, erasure, columns, None, |path, _, _| {
            remove.insert(path.to_owned());
        })
        .await?;
        if remove.is_empty() {
            return Ok((None, 0));
        }
        let tasks = planned_tasks(&current, &remove).await?;
        let schema = table_schema(&current)?;
        let mut sink = DataFileSink::new(&current)?;
        let mut erased = 0_u64;
        let copied: Result<()> = async {
            for task in tasks.into_values() {
                let mut batches = read_task(&current, task)?;
                while let Some(batch) = batches.try_next().await? {
                    let batch = with_schema(&schema, &batch)?;
                    let doomed = erased_rows(&batch, erasure, columns)?;
                    let gone = doomed.true_count();
                    erased += u64::try_from(gone).unwrap_or(u64::MAX);
                    if gone < batch.num_rows() {
                        let keep = datafusion::arrow::compute::not(&doomed)?;
                        sink.write(&filter_record_batch(&batch, &keep)?).await?;
                    }
                }
            }
            Ok(())
        }
        .await;
        let add = finish(sink, copied, &current).await?;
        let operation = if add.is_empty() {
            Operation::Delete
        } else {
            Operation::Overwrite
        };
        let outcome = self
            .commit_or_clean(
                table,
                &current,
                ReplaceFiles {
                    operation,
                    remove,
                    add,
                },
            )
            .await?;
        Ok((Some(outcome), erased))
    }

    /// Drops `workspace_id`'s whole day partitions before `before_day` (days
    /// since 1970) from a day-partitioned table. Nothing is rewritten.
    pub async fn drop_days_before(
        &self,
        table: PanelTable,
        workspace_id: &str,
        before_day: i32,
    ) -> Result<Option<ReplaceOutcome>> {
        Ok(self
            .drop_expired_days(table, &|workspace| {
                (workspace == workspace_id).then_some(before_day)
            })
            .await?
            .map(|(outcome, _)| outcome))
    }

    /// Retention: drops, in one commit, every workspace's whole day
    /// partitions before its cutoff (`cutoff(workspace)`, days since 1970;
    /// `None` keeps the workspace's days). Nothing is rewritten. Returns the
    /// commit and the rows it dropped; nothing to drop is `None`.
    pub async fn drop_expired_days(
        &self,
        table: PanelTable,
        cutoff: &(dyn Fn(&str) -> Option<i32> + Sync),
    ) -> Result<Option<(ReplaceOutcome, u64)>> {
        if table.day_column().is_none() {
            return Err(LakehouseError::Rows(format!(
                "{} has no day partitions",
                table.name()
            )));
        }
        let current = self.load(table).await?;
        let mut rows = 0_u64;
        let remove: HashSet<String> = live_files(&current)
            .await?
            .into_iter()
            .filter(|file| {
                let Some(workspace) = partition_workspace(file.partition()) else {
                    return false;
                };
                let expired = cutoff(workspace).is_some_and(|cutoff| {
                    partition_day(file.partition()).is_some_and(|day| day < cutoff)
                });
                if expired {
                    rows += file.record_count();
                }
                expired
            })
            .map(|file| file.file_path().to_owned())
            .collect();
        if remove.is_empty() {
            return Ok(None);
        }
        let outcome = self
            .replace_files(
                table,
                &ReplaceFiles {
                    operation: Operation::Delete,
                    remove,
                    add: Vec::new(),
                },
            )
            .await?;
        Ok(Some((outcome, rows)))
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
        let still_logged = metadata_files(&after);
        candidates.extend(
            metadata_files(&before)
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

    /// Every file the table's metadata references: the current metadata file
    /// and the ones its log keeps, every snapshot's manifest list, manifests
    /// and live data and delete files, and statistics files.
    pub async fn referenced_files(&self, table: PanelTable) -> Result<HashSet<String>> {
        let current = self.load(table).await?;
        let mut files = metadata_files(&current);
        let metadata = current.metadata();
        files.extend(
            metadata
                .statistics_iter()
                .map(|statistics| statistics.statistics_path.clone()),
        );
        files.extend(
            metadata
                .partition_statistics_iter()
                .map(|statistics| statistics.statistics_path.clone()),
        );
        let mut manifests = HashSet::new();
        for snapshot in metadata.snapshots() {
            files.insert(snapshot.manifest_list().to_owned());
            let list = current.manifest_list_reader(snapshot).load().await?;
            for manifest_file in list.entries() {
                if !manifests.insert(manifest_file.manifest_path.clone()) {
                    continue;
                }
                files.insert(manifest_file.manifest_path.clone());
                let manifest = current.manifest_reader().read(manifest_file).await?;
                files.extend(
                    manifest
                        .entries()
                        .iter()
                        .filter(|entry| entry.is_alive())
                        .map(|entry| entry.file_path().to_owned()),
                );
            }
        }
        Ok(files)
    }

    /// The orphan sweep of one table: of `listed` (what the object store
    /// holds under the table's location, listed before this call), the files
    /// its metadata doesn't reference and that were last written before
    /// `older_than_ms` are deleted. Anything outside the table's location,
    /// or of unknown age, is left alone.
    pub async fn sweep_orphans(
        &self,
        table: PanelTable,
        listed: &[ListedFile],
        older_than_ms: i64,
    ) -> Result<OrphanSweep> {
        let current = self.load(table).await?;
        let location = format!("{}/", current.metadata().location().trim_end_matches('/'));
        let referenced = self.referenced_files(table).await?;
        let mut orphans: Vec<String> = listed
            .iter()
            .filter(|file| {
                file.path.starts_with(&location)
                    && !referenced.contains(&file.path)
                    && file.modified_ms.is_some_and(|at| at < older_than_ms)
            })
            .map(|file| file.path.clone())
            .collect();
        orphans.sort();
        for path in &orphans {
            current.file_io().delete(path).await?;
        }
        Ok(OrphanSweep {
            listed: listed.len(),
            referenced: referenced.len(),
            orphans,
        })
    }

    /// Commits `change`; if that fails, deletes the data files it would have
    /// added (nothing references them), except when whether it landed is
    /// unknown ([`LakehouseError::CommitUnknown`]): then the table may name
    /// them, and the orphan sweep takes them if it doesn't.
    async fn commit_or_clean(
        &self,
        table: PanelTable,
        current: &Table,
        change: ReplaceFiles,
    ) -> Result<ReplaceOutcome> {
        match self.replace_files(table, &change).await {
            Ok(outcome) => Ok(outcome),
            Err(error @ LakehouseError::CommitUnknown(_)) => Err(error),
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

/// Closes a rewrite's sink: its data files if the copy went well; else the
/// copy's error, the files it wrote deleted again.
async fn finish(sink: DataFileSink, copied: Result<()>, table: &Table) -> Result<Vec<DataFile>> {
    let closed = sink.close().await;
    match (copied, closed) {
        (Ok(()), closed) => closed,
        (Err(error), Ok(files)) => {
            let written: Vec<String> = files
                .iter()
                .map(|file| file.file_path().to_owned())
                .collect();
            delete_quietly(table.file_io(), &written).await;
            Err(error)
        }
        (Err(error), Err(_)) => Err(error),
    }
}

/// The current metadata file and the ones the table's log keeps.
fn metadata_files(table: &Table) -> HashSet<String> {
    table
        .metadata()
        .metadata_log()
        .iter()
        .map(|entry| entry.metadata_file.clone())
        .chain(table.metadata_location().map(str::to_owned))
        .collect()
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

/// The table's Arrow schema, with the field ids the writer matches by.
fn table_schema(table: &Table) -> Result<SchemaRef> {
    Ok(Arc::new(schema_to_arrow_schema(
        table.metadata().current_schema(),
    )?))
}

/// A batch read back, in the table's schema (same columns, with the ids).
fn with_schema(schema: &SchemaRef, batch: &RecordBatch) -> Result<RecordBatch> {
    Ok(RecordBatch::try_new(
        schema.clone(),
        batch.columns().to_vec(),
    )?)
}

/// The current snapshot's scan tasks of the given files, by path, reading
/// `columns` (all with `None`).
async fn scan_tasks(
    table: &Table,
    paths: &HashSet<String>,
    columns: Option<&[&str]>,
) -> Result<BTreeMap<String, FileScanTask>> {
    let Some(snapshot) = table.metadata().current_snapshot() else {
        return Ok(BTreeMap::new());
    };
    let scan = table.scan().snapshot_id(snapshot.snapshot_id());
    let scan = match columns {
        Some(columns) => scan.select(columns.iter().copied()),
        None => scan.select_all(),
    }
    .build()?;
    let wanted = paths.clone();
    let tasks: Vec<FileScanTask> = scan
        .plan_files()
        .await?
        .try_filter(move |task| std::future::ready(wanted.contains(task.data_file_path())))
        .try_collect()
        .await?;
    Ok(tasks
        .into_iter()
        .map(|task| (task.data_file_path().to_owned(), task))
        .collect())
}

/// [`scan_tasks`] of every column.
async fn planned_tasks(
    table: &Table,
    paths: &HashSet<String>,
) -> Result<BTreeMap<String, FileScanTask>> {
    scan_tasks(table, paths, None).await
}

/// One file's rows, batch by batch.
fn read_task(table: &Table, task: FileScanTask) -> Result<ArrowRecordBatchStream> {
    let tasks = futures_util::stream::iter([Ok(task)]).boxed();
    Ok(table.reader_builder().build().read(tasks)?.stream())
}

/// Reads only `project_id`, `columns` (and `collect`) of the erasure's
/// workspace's files, and calls `found(path, project, collected)` for each
/// row the erasure names (`collected` empty without `collect`; rows whose
/// `collect` value is null are skipped then).
async fn for_each_matching_file(
    table: &Table,
    erasure: &Erasure,
    columns: &[&str],
    collect: Option<&str>,
    mut found: impl FnMut(&str, &str, &str),
) -> Result<()> {
    let paths: HashSet<String> = live_files(table)
        .await?
        .into_iter()
        .filter(|file| partition_workspace(file.partition()) == Some(erasure.workspace_id.as_str()))
        .map(|file| file.file_path().to_owned())
        .collect();
    if paths.is_empty() {
        return Ok(());
    }
    let mut selected: Vec<&str> = vec!["project_id"];
    selected.extend(columns.iter().copied());
    if let Some(column) = collect.filter(|column| !selected.contains(column)) {
        selected.push(column);
    }
    for (path, task) in scan_tasks(table, &paths, Some(&selected)).await? {
        let mut batches = read_task(table, task)?;
        while let Some(batch) = batches.try_next().await? {
            let doomed = erased_rows(&batch, erasure, columns)?;
            if doomed.true_count() == 0 {
                continue;
            }
            let projects = text_column(&batch, "project_id")?;
            let collected = collect
                .map(|column| text_column(&batch, column))
                .transpose()?;
            for row in 0..batch.num_rows() {
                if !doomed.value(row) {
                    continue;
                }
                match &collected {
                    None => found(&path, projects.value(row), ""),
                    Some(values) if values.is_valid(row) => {
                        found(&path, projects.value(row), values.value(row));
                    }
                    Some(_) => {}
                }
            }
            if collect.is_none() {
                // Only the file matters.
                break;
            }
        }
    }
    Ok(())
}

/// A text column as a `StringArray` (Parquet may come back as a view or a
/// large string).
fn text_column(batch: &RecordBatch, name: &str) -> Result<StringArray> {
    let column: &ArrayRef = batch
        .column_by_name(name)
        .ok_or_else(|| LakehouseError::Rows(format!("no column {name}")))?;
    let column = cast(column, &DataType::Utf8)?;
    column
        .as_any()
        .downcast_ref::<StringArray>()
        .cloned()
        .ok_or_else(|| LakehouseError::Rows(format!("{name} is not text")))
}

/// True for the rows to erase: in one of the erasure's projects, with one of
/// `columns` holding one of that project's ids.
fn erased_rows(batch: &RecordBatch, erasure: &Erasure, columns: &[&str]) -> Result<BooleanArray> {
    let projects = text_column(batch, "project_id")?;
    let values = columns
        .iter()
        .map(|name| text_column(batch, name))
        .collect::<Result<Vec<_>>>()?;
    let mut doomed = vec![false; batch.num_rows()];
    for (row, flag) in doomed.iter_mut().enumerate() {
        if !projects.is_valid(row) {
            continue;
        }
        let Some(ids) = erasure.ids_by_project.get(projects.value(row)) else {
            continue;
        };
        *flag = values
            .iter()
            .any(|column| column.is_valid(row) && ids.contains(column.value(row)));
    }
    Ok(BooleanArray::from(doomed))
}

/// The rows of the given data files (of the current snapshot), in the
/// table's Arrow schema.
#[cfg(test)]
pub(crate) async fn read_files(table: &Table, paths: &HashSet<String>) -> Result<Vec<RecordBatch>> {
    let schema = table_schema(table)?;
    let mut out = Vec::new();
    for task in planned_tasks(table, paths).await?.into_values() {
        let batches: Vec<RecordBatch> = read_task(table, task)?.try_collect().await?;
        for batch in batches {
            out.push(with_schema(&schema, &batch)?);
        }
    }
    Ok(out)
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

/// The workspaces with live files in the table.
pub async fn workspaces_in(lakehouse: &Lakehouse, table: PanelTable) -> Result<HashSet<String>> {
    Ok(lakehouse
        .live_data_files(table)
        .await?
        .iter()
        .filter_map(|file| partition_workspace(file.partition()).map(str::to_owned))
        .collect())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow_array::StringArray;
    use arrow_schema::{Field, Schema};

    use super::*;

    #[test]
    fn erasure_matches_only_the_project_s_ids() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("project_id", DataType::Utf8, false),
            Field::new("user_id", DataType::Utf8, true),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(StringArray::from(vec!["p1", "p2", "p1", "p1"])),
                Arc::new(StringArray::from(vec![
                    Some("u"),
                    Some("u"),
                    None,
                    Some("v"),
                ])),
            ],
        )
        .expect("a batch");
        let erasure = Erasure::new("ws", "p1", HashSet::from(["u".to_owned()]));
        let doomed = erased_rows(&batch, &erasure, &["user_id"]).expect("a mask");
        assert_eq!(
            (0..4).map(|row| doomed.value(row)).collect::<Vec<_>>(),
            [true, false, false, false]
        );
    }
}
