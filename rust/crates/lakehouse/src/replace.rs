//! Replace files: one commit that removes a set of data files and adds a
//! set, the primitive compaction, erasure and retention are built on.
//! iceberg-rust 0.11 has no such commit (only fast append), so it is
//! written here from the library's public parts, following the Iceberg spec
//! and Java's `MergingSnapshotProducer`:
//!
//! - every data manifest of the current snapshot that holds a file to remove
//!   is rewritten: the removed files as `DELETED` entries and the others as
//!   `EXISTING`, both keeping their data and file sequence numbers and the
//!   snapshot that added them; entries already `DELETED` are dropped, and so
//!   are untouched manifests left with only deleted entries;
//! - the added files go in a new manifest, at the new sequence number;
//! - a new manifest list and snapshot (`replace` for compaction, `overwrite`
//!   or `delete` otherwise) with the summary's added, deleted and total
//!   counts, and [`STREAM_SEQ_PROPERTY`] carried forward;
//! - new metadata, swapped in with the catalog's compare-and-swap. Losing
//!   the swap to a concurrent commit (an append) starts over on the new
//!   state, so its files are kept; a file to remove that is gone (another
//!   maintenance run) is a [`LakehouseError::Conflict`]. A database failure
//!   is settled by the catalog (`SwapOutcome`): landed is the commit, not
//!   landed deletes what the attempt wrote and fails, and unknown fails
//!   with [`LakehouseError::CommitUnknown`], deleting nothing.
//!
//! When upstream ships `RewriteFiles`, this switches to it.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use iceberg::io::FileIO;
use iceberg::spec::{
    DataFile, MAIN_BRANCH, ManifestContentType, ManifestFile, ManifestListWriter,
    ManifestWriterBuilder, Operation, Snapshot, SnapshotReference, SnapshotRetention,
    SnapshotSummaryCollector, Summary, TableMetadata, TableProperties,
};
use iceberg::table::Table;
use iceberg::{MetadataLocation, TableUpdate};
use uuid::Uuid;

use crate::catalog::Lakehouse;
use crate::error::{LakehouseError, Result};
use crate::pg_catalog::SwapOutcome;
use crate::tables::PanelTable;
use crate::writer::{STREAM_SEQ_PROPERTY, stream_seq_of};

/// How many times a replace starts over after losing the swap.
const MAX_ATTEMPTS: u32 = 6;

/// One replace: the files to remove (by path) and the files to add.
#[derive(Debug, Clone)]
pub struct ReplaceFiles {
    /// `Replace` (rows unchanged: compaction), `Overwrite` (rows changed:
    /// erasure) or `Delete` (files only removed: retention).
    pub operation: Operation,
    /// Paths of live data files to remove.
    pub remove: HashSet<String>,
    /// New data files (written, not yet committed).
    pub add: Vec<DataFile>,
}

/// What a replace committed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaceOutcome {
    /// The new snapshot.
    pub snapshot_id: i64,
    /// Attempts it took (more than one: it lost the swap to another commit).
    pub attempts: u32,
}

impl Lakehouse {
    /// Commits `change` to `table`.
    pub async fn replace_files(
        &self,
        table: PanelTable,
        change: &ReplaceFiles,
    ) -> Result<ReplaceOutcome> {
        self.replace_files_with(table, change, |_| async { Ok(()) })
            .await
    }

    /// [`Self::replace_files`], running `before_swap(attempt)` between
    /// writing an attempt's metadata and swapping it in (tests race it).
    pub(crate) async fn replace_files_with<H, F>(
        &self,
        table: PanelTable,
        change: &ReplaceFiles,
        mut before_swap: H,
    ) -> Result<ReplaceOutcome>
    where
        H: FnMut(u32) -> F,
        F: Future<Output = Result<()>>,
    {
        let ident = table.ident();
        for attempt in 1..=MAX_ATTEMPTS {
            let current = self.load(table).await?;
            let base = current.metadata_location_result()?.to_owned();
            let staged = stage(&current, change, attempt).await?;
            let location = MetadataLocation::from_str(&base)?
                .with_next_version()
                .try_with_new_metadata(&staged.metadata)?;
            let mut written = staged.written;
            written.push(location.to_string());
            if let Err(error) = staged.metadata.write_to(current.file_io(), &location).await {
                delete_quietly(current.file_io(), &written).await;
                return Err(error.into());
            }
            before_swap(attempt).await?;
            match self
                .swap_metadata(&ident, &base, &location.to_string())
                .await
            {
                SwapOutcome::Swapped => {
                    return Ok(ReplaceOutcome {
                        snapshot_id: staged.snapshot_id,
                        attempts: attempt,
                    });
                }
                SwapOutcome::Lost => {}
                SwapOutcome::Failed(error) => {
                    delete_quietly(current.file_io(), &written).await;
                    return Err(error.into());
                }
                // Kept: the table may name them now.
                SwapOutcome::Unknown(reason) => {
                    return Err(LakehouseError::CommitUnknown(format!(
                        "{}: {reason}",
                        table.name()
                    )));
                }
            }
            tracing::info!(
                table = table.name(),
                attempt,
                "replace lost the swap to another commit, starting over"
            );
            delete_quietly(current.file_io(), &written).await;
            tokio::time::sleep(Duration::from_millis(25 << attempt)).await;
        }
        Err(LakehouseError::Conflict(format!(
            "{}: gave up after {MAX_ATTEMPTS} attempts",
            table.name()
        )))
    }
}

/// An attempt's new metadata, and the files it wrote (removed again if the
/// swap is lost).
struct Staged {
    metadata: TableMetadata,
    snapshot_id: i64,
    written: Vec<String>,
}

async fn stage(table: &Table, change: &ReplaceFiles, attempt: u32) -> Result<Staged> {
    let mut written = Vec::new();
    match stage_into(table, change, attempt, &mut written).await {
        Ok((metadata, snapshot_id)) => Ok(Staged {
            metadata,
            snapshot_id,
            written,
        }),
        Err(error) => {
            delete_quietly(table.file_io(), &written).await;
            Err(error)
        }
    }
}

#[allow(clippy::too_many_lines)] // one commit, step by step
async fn stage_into(
    table: &Table,
    change: &ReplaceFiles,
    attempt: u32,
    written: &mut Vec<String>,
) -> Result<(TableMetadata, i64)> {
    let metadata = table.metadata();
    let schema = metadata.current_schema().clone();
    let snapshot_id = new_snapshot_id(metadata);
    let sequence_number = metadata.next_sequence_number();
    let commit_id = Uuid::new_v4();
    let metadata_dir = metadata.metadata_location()?;
    let mut manifest_count = 0_u32;
    let mut next_manifest_path = || {
        manifest_count += 1;
        format!("{metadata_dir}/{commit_id}-m{manifest_count}.avro")
    };

    let mut summary = SnapshotSummaryCollector::default();
    summary.set_partition_summary_limit(
        metadata
            .properties()
            .get(TableProperties::PROPERTY_WRITE_PARTITION_SUMMARY_LIMIT)
            .and_then(|limit| limit.parse().ok())
            .unwrap_or(TableProperties::PROPERTY_WRITE_PARTITION_SUMMARY_LIMIT_DEFAULT),
    );

    let mut manifests: Vec<ManifestFile> = Vec::new();
    let mut removed: HashSet<String> = HashSet::new();
    let parent = metadata.current_snapshot();
    if let Some(parent) = parent {
        let list = table.manifest_list_reader(parent).load().await?;
        for manifest_file in list.consume_entries() {
            if manifest_file.content != ManifestContentType::Data {
                manifests.push(manifest_file);
                continue;
            }
            let manifest = table.manifest_reader().read(&manifest_file).await?;
            let touches = manifest
                .entries()
                .iter()
                .any(|entry| entry.is_alive() && change.remove.contains(entry.file_path()));
            if !touches {
                if manifest_file.has_added_files() || manifest_file.has_existing_files() {
                    manifests.push(manifest_file);
                }
                continue;
            }
            let spec = metadata
                .partition_spec_by_id(manifest_file.partition_spec_id)
                .ok_or_else(|| {
                    LakehouseError::Conflict(format!(
                        "partition spec {} is gone",
                        manifest_file.partition_spec_id
                    ))
                })?;
            let path = next_manifest_path();
            let output = table.file_io().new_output(&path)?;
            written.push(path);
            let mut writer = ManifestWriterBuilder::new(
                output,
                Some(snapshot_id),
                schema.clone(),
                spec.as_ref().clone(),
            )
            .build_v2_data();
            for entry in manifest.entries() {
                if !entry.is_alive() {
                    continue;
                }
                let data_sequence = entry.sequence_number.ok_or_else(|| {
                    LakehouseError::Conflict(format!(
                        "{} has no sequence number",
                        entry.file_path()
                    ))
                })?;
                let file = entry.data_file().clone();
                if change.remove.contains(entry.file_path()) {
                    summary.remove_file(&file, schema.clone(), spec.clone());
                    removed.insert(entry.file_path().to_owned());
                    writer.add_delete_file(file, data_sequence, entry.file_sequence_number)?;
                } else {
                    let added_by = entry
                        .snapshot_id()
                        .unwrap_or(manifest_file.added_snapshot_id);
                    writer.add_existing_file(
                        file,
                        added_by,
                        data_sequence,
                        entry.file_sequence_number,
                    )?;
                }
            }
            manifests.push(writer.write_manifest_file().await?);
        }
    }
    if removed.len() != change.remove.len() {
        let missing: Vec<&String> = change.remove.difference(&removed).collect();
        return Err(LakehouseError::Conflict(format!(
            "files to remove are no longer in the table: {missing:?}"
        )));
    }

    if !change.add.is_empty() {
        let spec = metadata.default_partition_spec();
        let path = next_manifest_path();
        let output = table.file_io().new_output(&path)?;
        written.push(path);
        let mut writer = ManifestWriterBuilder::new(
            output,
            Some(snapshot_id),
            schema.clone(),
            spec.as_ref().clone(),
        )
        .build_v2_data();
        for file in &change.add {
            summary.add_file(file, schema.clone(), spec.clone());
            writer.add_file(file.clone(), sequence_number)?;
        }
        manifests.push(writer.write_manifest_file().await?);
    }

    let mut properties = summary.build();
    if let Some(seq) = stream_seq_of(metadata) {
        properties.insert(STREAM_SEQ_PROPERTY.to_owned(), seq.to_string());
    }
    let properties = with_totals(properties, parent.map(|snapshot| snapshot.summary()));

    let list_path = format!("{metadata_dir}/snap-{snapshot_id}-{attempt}-{commit_id}.avro");
    let list_output = table.file_io().new_output(&list_path)?;
    written.push(list_path.clone());
    let mut list = ManifestListWriter::v2(
        list_output.writer().await?,
        snapshot_id,
        metadata.current_snapshot_id(),
        sequence_number,
    );
    list.add_manifests(manifests.into_iter())?;
    list.close().await?;

    let snapshot = Snapshot::builder()
        .with_snapshot_id(snapshot_id)
        .with_parent_snapshot_id(metadata.current_snapshot_id())
        .with_sequence_number(sequence_number)
        .with_timestamp_ms(now_ms())
        .with_manifest_list(list_path)
        .with_summary(Summary {
            operation: change.operation.clone(),
            additional_properties: properties,
        })
        .with_schema_id(metadata.current_schema_id())
        .build();
    let mut builder = metadata
        .clone()
        .into_builder(Some(table.metadata_location_result()?.to_owned()));
    for update in [
        TableUpdate::AddSnapshot { snapshot },
        TableUpdate::SetSnapshotRef {
            ref_name: MAIN_BRANCH.to_owned(),
            reference: SnapshotReference::new(
                snapshot_id,
                SnapshotRetention::branch(None, None, None),
            ),
        },
    ] {
        builder = update.apply(builder)?;
    }
    Ok((builder.build()?.metadata, snapshot_id))
}

/// The `total-*` counts: the parent's plus what this snapshot added and
/// removed (what iceberg-rust's own summary update does, which is private).
fn with_totals(
    mut properties: HashMap<String, String>,
    previous: Option<&Summary>,
) -> HashMap<String, String> {
    const TOTALS: [(&str, &str, &str); 6] = [
        ("total-data-files", "added-data-files", "deleted-data-files"),
        (
            "total-delete-files",
            "added-delete-files",
            "removed-delete-files",
        ),
        ("total-records", "added-records", "deleted-records"),
        ("total-files-size", "added-files-size", "removed-files-size"),
        (
            "total-position-deletes",
            "added-position-deletes",
            "removed-position-deletes",
        ),
        (
            "total-equality-deletes",
            "added-equality-deletes",
            "removed-equality-deletes",
        ),
    ];
    fn get(map: &HashMap<String, String>, key: &str) -> u64 {
        map.get(key)
            .and_then(|value| value.parse().ok())
            .unwrap_or(0)
    }
    for (total, added, removed) in TOTALS {
        let before = previous.map_or(0, |summary| get(&summary.additional_properties, total));
        let value = (before + get(&properties, added)).saturating_sub(get(&properties, removed));
        properties.insert(total.to_owned(), value.to_string());
    }
    properties
}

/// A positive snapshot id the table doesn't use yet.
fn new_snapshot_id(metadata: &TableMetadata) -> i64 {
    loop {
        let (high, low) = Uuid::new_v4().as_u64_pair();
        let id = i64::try_from((high ^ low) >> 1).unwrap_or(1);
        if id > 0 && metadata.snapshot_by_id(id).is_none() {
            return id;
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or_default()
}

/// Deletes files a failed attempt wrote; what can't be deleted is left for
/// the orphan sweep.
pub(crate) async fn delete_quietly(file_io: &FileIO, paths: &[String]) {
    for path in paths {
        if let Err(error) = file_io.delete(path).await {
            tracing::warn!(%error, path, "could not delete a file a failed commit wrote");
        }
    }
}
