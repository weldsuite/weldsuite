//! `weldsuite cron panel-maintenance` (nightly): WeldPanel's table upkeep on
//! the Kubernetes editions (ADR EVT-019), what panel-maintenance's weekly
//! Workflow and `PyIceberg` container do on Global, plus the upkeep Basin's
//! catalog does there by itself. In order, each step on its own (one that
//! fails is reported and the next runs):
//!
//! 1. **Erasure.** The ids `panel_erasure_ledger` holds (master database)
//!    are erased from events, identity links, profiles and the recording
//!    chunk index, a workspace at a time, and their rows marked applied. An
//!    id requested again during the run stays pending. The ids it covered
//!    then leave the project's erased list (`clearErased`), which opens the
//!    tenant database of those workspaces only, never the others.
//!    Only ids requested before the rows collected until then are in the
//!    tables are taken ([`erasure_cutoff`]): `panel-writer` holds rows up to
//!    its flush interval (`PANEL_WRITER_FLUSH_SECONDS`) before committing
//!    them, so an id must be older than that plus a margin, and when the
//!    writer is behind (a table's committed `weldsuite.stream-seq` short of
//!    its feed, [`WriterLag`], read from NATS) older than the oldest row it
//!    hasn't committed, less the margin. Otherwise rows collected before the
//!    request but committed after the rewrite would survive it, and come
//!    back once the id left the erased list. The later ids wait for a later
//!    night; with NATS configured but out of reach, none is taken.
//! 2. **Retention.** Each workspace's day partitions past its plan's window
//!    are dropped from `events_v1` and `replay_chunks_v1`: 366 days on Free
//!    (or no plan), 762 otherwise, the window Global's queries use
//!    (`eventRetentionDays`); a workspace the master doesn't know keeps the
//!    longest. Plans come from the master database. Then the objects of the
//!    replays bucket past their prefix's age go, which Global's R2 lifecycle
//!    rules do ([`REPLAY_LIFECYCLE`]): recording chunks with their tier,
//!    a favourite's `keep/` copies after their own 13 months (never with
//!    the originals), heatmap snapshots after 90 days.
//! 3. **Compaction** of every partition with two or more small files.
//! 4. **Snapshot expiry** (older than a day, keeping the newest ten), and the
//!    files only expired snapshots used.
//! 5. **The orphan sweep:** files under each table that no metadata names
//!    and that are older than three days (what a crash between writing and
//!    committing leaves).
//!
//! The collector's replay tiers are not refreshed here: as on Global, the
//! usage settlement moves a workspace's project records to its plan's tier
//! (`applyReplayTier`, `weldsuite cron panel-usage` every five minutes), and
//! every record written or repaired from the registry carries it.

use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_lakehouse::{
    Erasure, ErasureCounts, Lakehouse, ListedFile, ORPHAN_MIN_AGE, PanelTable, SMALL_FILE_BYTES,
    partitions, workspaces_in,
};
use weldsuite_panel::{PanelProjectState, ProjectRef};
use weldsuite_ports::{BoxFuture, DynFileStore, FileStore, PortError};

/// Global's lifecycle rules on the replays bucket
/// (`scripts/weldpanel/setup-resources.mjs`, ADR PANEL-005): the objects
/// under each prefix of the replays bucket's keys are deleted this many days
/// after they were written. `keep/` holds a favourite's copies (13 months,
/// `REPLAY_TIER_DAYS.keep`), apart from the tier its originals expire with.
pub(crate) const REPLAY_LIFECYCLE: [(&str, i64); 4] = [
    ("30d/", 30),
    ("90d/", 90),
    ("keep/", 396),
    ("snapshots/", 90),
];

const DAY_MS: i64 = 86_400_000;

/// Deletes the replays bucket's objects past their prefix's lifecycle
/// ([`REPLAY_LIFECYCLE`]), counted from when each was written (as R2
/// counts); an object whose store doesn't say when stays. `replays` is the
/// replays bucket's view of the panel bucket (`PanelBucketReplays`), whose
/// keys are Global's. Answers how many went per prefix; a prefix that fails
/// is reported and the others still run.
pub(crate) async fn expire_replays(
    replays: &dyn DynFileStore,
    now_ms: i64,
) -> (BTreeMap<&'static str, usize>, Vec<String>) {
    let mut deleted = BTreeMap::new();
    let mut errors = Vec::new();
    for (prefix, days) in REPLAY_LIFECYCLE {
        let cutoff = now_ms - days * DAY_MS;
        let expired = async {
            let keys: Vec<String> = replays
                .list_boxed(prefix)
                .await?
                .into_iter()
                .filter(|object| object.last_modified_ms.is_some_and(|at| at <= cutoff))
                .map(|object| object.key)
                .collect();
            replays.delete_many_boxed(&keys).await?;
            Ok::<usize, PortError>(keys.len())
        }
        .await;
        match expired {
            Ok(count) => {
                deleted.insert(prefix, count);
            }
            Err(error) => errors.push(format!("expiring the replays under {prefix}: {error}")),
        }
    }
    (deleted, errors)
}

use crate::panel_store::PanelStoreConfig;

/// Days events are kept on Free, or without a plan (`eventRetentionDays` in
/// `@weldsuite/panel-domain/query/plan-retention.ts`).
pub(crate) const FREE_RETENTION_DAYS: i64 = 366;
/// Days events are kept on every other plan (`MAX_RETENTION_DAYS`).
pub(crate) const MAX_RETENTION_DAYS: i64 = 762;

/// Global's rule: Free or no plan keeps a year, any other plan the most.
pub(crate) fn retention_days(plan_slug: Option<&str>) -> i64 {
    match plan_slug {
        None | Some("" | "free") => FREE_RETENTION_DAYS,
        Some(_) => MAX_RETENTION_DAYS,
    }
}

/// The first day (days since 1970, UTC) a workspace keeping `days` days
/// still has at `now`: whole days before it are dropped. A day partition
/// ends before `now - days` exactly when it is before this day.
pub(crate) fn first_kept_day(now: OffsetDateTime, days: i64) -> i32 {
    let cutoff = now.unix_timestamp() - days * 86_400;
    i32::try_from(cutoff.div_euclid(86_400)).unwrap_or(i32::MIN)
}

/// How long snapshots and orphans are kept, and how long an erasure waits
/// for the writer.
#[derive(Debug, Clone)]
pub(crate) struct MaintenanceSettings {
    /// Snapshots older than this are expired (a query reads a snapshot it
    /// loaded seconds ago; a day is plenty).
    pub(crate) snapshot_age: Duration,
    /// The newest snapshots always kept.
    pub(crate) retain_snapshots: usize,
    /// Unreferenced files younger than this stay.
    pub(crate) orphan_min_age: Duration,
    /// How long `panel-writer` holds rows before committing them
    /// (`PANEL_WRITER_FLUSH_SECONDS`).
    pub(crate) writer_flush_after: Duration,
    /// What an erasure waits beyond it, and before the oldest row the writer
    /// hasn't committed: the clocks of the collector, NATS and Postgres, and
    /// a commit's own time.
    pub(crate) erasure_margin: Duration,
}

impl Default for MaintenanceSettings {
    fn default() -> Self {
        Self {
            snapshot_age: Duration::from_hours(24),
            retain_snapshots: 10,
            orphan_min_age: ORPHAN_MIN_AGE,
            writer_flush_after: crate::consume::panel_writer::WriterSettings::default().flush_after,
            erasure_margin: Duration::from_mins(10),
        }
    }
}

/// The erasure requests a run takes: those made before this. The writer
/// has committed every row collected before it when it is older than the
/// writer's flush interval and the margin, and than the oldest row the
/// writer hasn't committed (`oldest_uncommitted`, when it is behind) less
/// the margin.
pub(crate) fn erasure_cutoff(
    now: OffsetDateTime,
    settings: &MaintenanceSettings,
    oldest_uncommitted: Option<OffsetDateTime>,
) -> OffsetDateTime {
    let flushed = now - settings.writer_flush_after - settings.erasure_margin;
    oldest_uncommitted.map_or(flushed, |oldest| {
        flushed.min(oldest - settings.erasure_margin)
    })
}

/// How far `panel-writer` is behind its feeds.
pub(crate) trait WriterLag: Send + Sync {
    /// When the oldest row on the five feeds that its table hasn't
    /// committed was published; `None` when every table holds its feed.
    fn oldest_uncommitted<'a>(
        &'a self,
        lake: &'a Lakehouse,
    ) -> BoxFuture<'a, Result<Option<OffsetDateTime>, String>>;
}

/// The writer's lag read from the install's NATS (connected per run).
pub(crate) struct NatsWriterLag {
    pub(crate) nats: weldsuite_adapters_oss::NatsOptions,
    pub(crate) streams: crate::panel_store::PanelStreams,
}

impl WriterLag for NatsWriterLag {
    fn oldest_uncommitted<'a>(
        &'a self,
        lake: &'a Lakehouse,
    ) -> BoxFuture<'a, Result<Option<OffsetDateTime>, String>> {
        Box::pin(async move {
            let bus = weldsuite_adapters_oss::JetStreamEventBus::connect(&self.nats)
                .await
                .map_err(|error| format!("NATS: {error}"))?;
            let feeds = crate::consume::panel_writer::feeds(&self.streams);
            oldest_uncommitted(bus.context(), lake, &feeds).await
        })
    }
}

/// When the oldest message of `feeds` that its table hasn't committed was
/// published: per feed, the first message on its subjects after the
/// table's committed sequence (from the stream's start when the table has
/// none, or the stream was made anew below it, as the writer reads it).
pub(crate) async fn oldest_uncommitted(
    jetstream: &async_nats::jetstream::Context,
    lake: &Lakehouse,
    feeds: &[crate::consume::panel_writer::Feed],
) -> Result<Option<OffsetDateTime>, String> {
    use crate::consume::panel_writer::{Start, start};
    use async_nats::jetstream::ErrorCode;
    use async_nats::jetstream::context::GetStreamErrorKind;
    use async_nats::jetstream::stream::RawMessageErrorKind;
    let mut oldest: Option<OffsetDateTime> = None;
    for feed in feeds {
        let table = feed.table.name();
        let committed = lake
            .last_stream_seq(feed.table)
            .await
            .map_err(|error| format!("{table}: {error}"))?;
        let mut stream = match jetstream.get_stream(&feed.stream).await {
            Ok(stream) => stream,
            // Never made: nothing on it is waiting for the table.
            Err(error)
                if matches!(
                    error.kind(),
                    GetStreamErrorKind::JetStream(error)
                        if error.error_code() == ErrorCode::STREAM_NOT_FOUND
                ) =>
            {
                continue;
            }
            Err(error) => return Err(format!("{}: {error}", feed.stream)),
        };
        let last = stream
            .info()
            .await
            .map_err(|error| format!("{}: {error}", feed.stream))?
            .state
            .last_sequence;
        let from = match start(committed, last) {
            Start::After(seq) => seq + 1,
            Start::All => 1,
        };
        match stream
            .get_first_raw_message_by_subject(&feed.subject, from)
            .await
        {
            Ok(message) => {
                oldest = Some(oldest.map_or(message.time, |at| at.min(message.time)));
            }
            Err(error) if matches!(error.kind(), RawMessageErrorKind::NoMessageFound) => {}
            Err(error) => return Err(format!("{table}'s feed {}: {error}", feed.subject)),
        }
    }
    Ok(oldest)
}

/// Releases erased ids once their rows are rewritten: the project state's
/// `clearErased` (`crate::panel_project::TenantProjectState` in the cron).
pub(crate) trait ErasedIds: Send + Sync {
    fn clear<'a>(
        &'a self,
        project: ProjectRef<'a>,
        ids: &'a [String],
    ) -> BoxFuture<'a, Result<(), PortError>>;
}

impl<T: PanelProjectState + ?Sized> ErasedIds for T {
    fn clear<'a>(
        &'a self,
        project: ProjectRef<'a>,
        ids: &'a [String],
    ) -> BoxFuture<'a, Result<(), PortError>> {
        self.clear_erased(project, ids)
    }
}

/// Lists what the object store holds under a table's location.
pub(crate) trait Lister: Send + Sync {
    /// Every file under `location` (`s3://<bucket>/lake/panel/<table>`).
    fn list<'a>(&'a self, location: &'a str) -> BoxFuture<'a, Result<Vec<ListedFile>, String>>;
}

/// The panel bucket's listing.
pub(crate) struct S3Lister {
    config: PanelStoreConfig,
    store: weldsuite_adapters_oss::S3FileStore,
}

impl S3Lister {
    pub(crate) fn new(config: PanelStoreConfig) -> Result<Self, weldsuite_ports::PortError> {
        Ok(Self {
            store: config.file_store()?,
            config,
        })
    }
}

impl Lister for S3Lister {
    fn list<'a>(&'a self, location: &'a str) -> BoxFuture<'a, Result<Vec<ListedFile>, String>> {
        Box::pin(async move {
            let Some(key) = self.config.key_of(location) else {
                return Err(format!("{location} is not in the panel bucket"));
            };
            let objects = self
                .store
                .list(&format!("{}/", key.trim_end_matches('/')))
                .await
                .map_err(|error| error.to_string())?;
            Ok(objects
                .into_iter()
                .map(|object| ListedFile {
                    path: self.config.path_of(&object.key),
                    modified_ms: object.last_modified_ms,
                })
                .collect())
        })
    }
}

/// One pending ledger row.
#[derive(Debug, sqlx::FromRow)]
#[allow(clippy::struct_field_names, reason = "the ledger's columns")]
struct Pending {
    workspace_id: String,
    project_id: String,
    erased_id: String,
}

/// What a night reaches besides the master database and the tables, each
/// one optional.
#[derive(Clone, Copy, Default)]
pub(crate) struct NightPorts<'a> {
    /// Releases the erased ids a rewrite covered (the tenant tables);
    /// `None` leaves them excluded.
    pub(crate) projects: Option<&'a dyn ErasedIds>,
    /// The replays bucket in the panel bucket (`PanelBucketReplays`);
    /// `None`: nothing expires there.
    pub(crate) replays: Option<&'a dyn DynFileStore>,
    /// How far the writer is behind (NATS); `None` (no NATS, so no
    /// writer): the erasure cutoff is the flush interval's alone.
    pub(crate) lag: Option<&'a dyn WriterLag>,
}

/// One run. Returns its report (what `weldsuite cron` prints).
#[allow(
    clippy::too_many_lines,
    reason = "the five steps, in order, each reporting on its own"
)]
pub(crate) async fn run(
    master: &PgPool,
    lake: &Lakehouse,
    lister: &dyn Lister,
    now: OffsetDateTime,
    settings: &MaintenanceSettings,
    ports: NightPorts<'_>,
) -> Value {
    let projects = ports.projects;
    let mut errors: Vec<String> = Vec::new();

    // 1. Erasure, of the ids whose rows the writer has committed.
    let mut erased = ErasureCounts::default();
    let mut applied_ids = 0_u64;
    let cutoff = match ports.lag {
        None => Ok(erasure_cutoff(now, settings, None)),
        Some(lag) => lag.oldest_uncommitted(lake).await.map(|oldest| {
            let cutoff = erasure_cutoff(now, settings, oldest);
            if let Some(oldest) = oldest
                && cutoff < erasure_cutoff(now, settings, None)
            {
                tracing::warn!(
                    oldest_uncommitted = weldsuite_events::iso_timestamp(oldest),
                    "panel-maintenance: the writer is behind; later erasure requests wait"
                );
            }
            cutoff
        }),
    };
    let pending = match cutoff {
        Ok(cutoff) => pending_erasures(master, cutoff)
            .await
            .map(|pending| (cutoff, pending))
            .map_err(|error| format!("reading the erasure ledger: {error}")),
        Err(error) => Err(format!(
            "erasure: the writer's progress is unknown, so no request is taken this run: {error}"
        )),
    };
    let mut requested_before = None;
    match pending {
        Ok((cutoff, by_workspace)) => {
            requested_before = Some(weldsuite_events::iso_timestamp(cutoff));
            for erasure in by_workspace.into_values() {
                match lake.erase_people(&erasure).await {
                    Ok(counts) => {
                        erased.events += counts.events;
                        erased.identities += counts.identities;
                        erased.people += counts.people;
                        erased.replay_chunks += counts.replay_chunks;
                        match mark_applied(master, &erasure, cutoff).await {
                            Ok(covered) => {
                                applied_ids += covered
                                    .values()
                                    .map(|ids| u64::try_from(ids.len()).unwrap_or(u64::MAX))
                                    .sum::<u64>();
                                if let Some(projects) = projects
                                    && let Err(error) =
                                        release(master, projects, &erasure.workspace_id, &covered)
                                            .await
                                {
                                    errors.push(format!(
                                        "erasure in {}: releasing the erased ids: {error}",
                                        erasure.workspace_id
                                    ));
                                }
                            }
                            Err(error) => errors.push(format!(
                                "erasure in {}: marking the ledger: {error}",
                                erasure.workspace_id
                            )),
                        }
                    }
                    Err(error) => {
                        errors.push(format!("erasure in {}: {error}", erasure.workspace_id));
                    }
                }
            }
        }
        Err(error) => errors.push(error),
    }

    // 2. Retention.
    let mut expired_rows = BTreeMap::new();
    match retention_cutoffs(master, lake, now).await {
        Ok(cutoffs) => {
            let cutoff = |workspace: &str| cutoffs.get(workspace).copied();
            for table in [PanelTable::Events, PanelTable::ReplayChunks] {
                match lake.drop_expired_days(table, &cutoff).await {
                    Ok(dropped) => {
                        expired_rows.insert(table.name(), dropped.map_or(0, |(_, rows)| rows));
                    }
                    Err(error) => errors.push(format!("retention of {}: {error}", table.name())),
                }
            }
        }
        Err(error) => errors.push(format!("reading the plans: {error}")),
    }
    // The replays bucket's objects past their prefix's age (Global's R2
    // lifecycle rules).
    let mut expired_objects = BTreeMap::new();
    if let Some(replays) = ports.replays {
        let (deleted, failed) = expire_replays(replays, ms(now)).await;
        expired_objects = deleted;
        errors.extend(failed);
    }

    // 3. Compaction.
    let mut compacted = 0_u64;
    for table in PanelTable::ALL {
        match partitions(lake, table).await {
            Ok(groups) => {
                for ((workspace, day), files) in groups {
                    let small = files
                        .iter()
                        .filter(|file| file.file_size_in_bytes() < SMALL_FILE_BYTES)
                        .count();
                    if small < 2 {
                        continue;
                    }
                    match lake.compact_partition(table, &workspace, day).await {
                        Ok(Some(_)) => compacted += 1,
                        Ok(None) => {}
                        Err(error) => errors.push(format!(
                            "compacting {} {workspace} {day:?}: {error}",
                            table.name()
                        )),
                    }
                }
            }
            Err(error) => errors.push(format!("listing {}: {error}", table.name())),
        }
    }

    // 4. Snapshot expiry.
    let older_than_ms = ms(now) - millis(settings.snapshot_age);
    let mut expired_snapshots = 0_usize;
    let mut deleted_files = 0_usize;
    for table in PanelTable::ALL {
        match lake
            .expire_snapshots(table, older_than_ms, settings.retain_snapshots)
            .await
        {
            Ok(outcome) => {
                expired_snapshots += outcome.expired_snapshots;
                deleted_files += outcome.deleted_files.len();
            }
            Err(error) => errors.push(format!("expiring {}: {error}", table.name())),
        }
    }

    // 5. Orphans.
    let orphan_before_ms = ms(now) - millis(settings.orphan_min_age);
    let mut orphans = 0_usize;
    for table in PanelTable::ALL {
        let swept = async {
            let location = lake
                .table_location(table)
                .await
                .map_err(|error| error.to_string())?;
            let files = lister.list(&location).await?;
            lake.sweep_orphans(table, &files, orphan_before_ms)
                .await
                .map_err(|error| error.to_string())
        }
        .await;
        match swept {
            Ok(sweep) => orphans += sweep.orphans.len(),
            Err(error) => errors.push(format!("orphans of {}: {error}", table.name())),
        }
    }

    for error in &errors {
        tracing::error!(error, "panel-maintenance");
    }
    json!({
        "erased": {
            "requestedBefore": requested_before,
            "ids": applied_ids,
            "events": erased.events,
            "identities": erased.identities,
            "people": erased.people,
            "replayChunks": erased.replay_chunks,
        },
        "expired": {
            "events": expired_rows.get("events_v1").copied().unwrap_or(0),
            "replayChunks": expired_rows.get("replay_chunks_v1").copied().unwrap_or(0),
            "replayObjects": expired_objects,
        },
        "compactedPartitions": compacted,
        "expiredSnapshots": expired_snapshots,
        "deletedFiles": deleted_files,
        "orphansDeleted": orphans,
        "errors": errors,
    })
}

/// The ledger's pending ids requested up to `cutoff` ([`erasure_cutoff`]),
/// by workspace.
async fn pending_erasures(
    master: &PgPool,
    cutoff: OffsetDateTime,
) -> Result<BTreeMap<String, Erasure>, sqlx::Error> {
    let rows: Vec<Pending> = sqlx::query_as(
        "select workspace_id, project_id, erased_id from panel_erasure_ledger \
         where applied_at is null and requested_at <= $1::timestamptz \
         order by workspace_id, project_id, erased_id",
    )
    .bind(weldsuite_events::iso_timestamp(cutoff))
    .fetch_all(master)
    .await?;
    let mut by_workspace: BTreeMap<String, Erasure> = BTreeMap::new();
    for row in rows {
        by_workspace
            .entry(row.workspace_id.clone())
            .or_insert_with(|| Erasure {
                workspace_id: row.workspace_id.clone(),
                ids_by_project: BTreeMap::new(),
            })
            .ids_by_project
            .entry(row.project_id)
            .or_default()
            .insert(row.erased_id);
    }
    Ok(by_workspace)
}

/// Marks the erasure's ids applied, except those requested again after
/// `cutoff` (the rewrite covers only what was committed before that).
/// Returns the ids it marked, by project.
async fn mark_applied(
    master: &PgPool,
    erasure: &Erasure,
    cutoff: OffsetDateTime,
) -> Result<BTreeMap<String, Vec<String>>, sqlx::Error> {
    let mut covered = BTreeMap::new();
    for (project, ids) in &erasure.ids_by_project {
        let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
        let mut marked: Vec<String> = sqlx::query_scalar(
            "update panel_erasure_ledger set applied_at = now() \
             where workspace_id = $1 and project_id = $2 and erased_id = any($3) \
             and applied_at is null and requested_at <= $4::timestamptz \
             returning erased_id",
        )
        .bind(&erasure.workspace_id)
        .bind(project)
        .bind(&ids)
        .bind(weldsuite_events::iso_timestamp(cutoff))
        .fetch_all(master)
        .await?;
        if !marked.is_empty() {
            marked.sort();
            covered.insert(project.clone(), marked);
        }
    }
    Ok(covered)
}

/// `clearErased` of each project's covered ids (Global's `finish` step):
/// queries stop excluding them. A project whose release fails has its ids
/// put back to pending, so the next run rewrites and releases them again.
async fn release(
    master: &PgPool,
    projects: &dyn ErasedIds,
    workspace_id: &str,
    covered: &BTreeMap<String, Vec<String>>,
) -> Result<(), String> {
    let mut failed = Vec::new();
    for (project_id, ids) in covered {
        let project = ProjectRef {
            workspace_id,
            project_id,
        };
        if let Err(error) = projects.clear(project, ids).await {
            let reverted = sqlx::query(
                "update panel_erasure_ledger set applied_at = null \
                 where workspace_id = $1 and project_id = $2 and erased_id = any($3)",
            )
            .bind(workspace_id)
            .bind(project_id)
            .bind(ids)
            .execute(master)
            .await;
            failed.push(match reverted {
                Ok(_) => format!("{project_id}: {error}"),
                Err(revert) => {
                    format!("{project_id}: {error} (and the ledger kept them applied: {revert})")
                }
            });
        }
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(failed.join("; "))
    }
}

/// Each workspace with rows in the day-partitioned tables, and the first
/// day it keeps.
async fn retention_cutoffs(
    master: &PgPool,
    lake: &Lakehouse,
    now: OffsetDateTime,
) -> Result<BTreeMap<String, i32>, String> {
    let mut workspaces: HashSet<String> = HashSet::new();
    for table in [PanelTable::Events, PanelTable::ReplayChunks] {
        workspaces.extend(
            workspaces_in(lake, table)
                .await
                .map_err(|error| error.to_string())?,
        );
    }
    if workspaces.is_empty() {
        return Ok(BTreeMap::new());
    }
    let ids: Vec<&str> = workspaces.iter().map(String::as_str).collect();
    let plans: Vec<(String, Option<String>)> = sqlx::query_as(
        "select w.id, p.slug from workspaces w left join plans p on p.id = w.plan_id \
         where w.id = any($1)",
    )
    .bind(&ids)
    .fetch_all(master)
    .await
    .map_err(|error| error.to_string())?;
    let known: BTreeMap<String, Option<String>> = plans.into_iter().collect();
    Ok(workspaces
        .into_iter()
        .map(|workspace| {
            // A workspace the master doesn't know (deleted) keeps the longest.
            let days = known
                .get(&workspace)
                .map_or(MAX_RETENTION_DAYS, |slug| retention_days(slug.as_deref()));
            (workspace, first_kept_day(now, days))
        })
        .collect())
}

fn ms(at: OffsetDateTime) -> i64 {
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

fn millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use time::{Date, Month};

    use super::*;

    fn day(number: i32) -> Date {
        OffsetDateTime::from_unix_timestamp(i64::from(number) * 86_400)
            .expect("a day")
            .date()
    }

    #[test]
    fn free_keeps_a_year_and_every_other_plan_the_most() {
        assert_eq!(retention_days(None), 366);
        assert_eq!(retention_days(Some("free")), 366);
        assert_eq!(retention_days(Some("")), 366);
        assert_eq!(retention_days(Some("business")), 762);
        assert_eq!(retention_days(Some("enterprise")), 762);
    }

    #[test]
    fn whole_days_before_the_window_go() {
        // 2026-11-18 12:00 UTC keeping 366 days: the window starts
        // 2025-11-17 12:00, so 2025-11-16 is the last whole day dropped.
        let noon = OffsetDateTime::from_unix_timestamp(1_795_003_200).expect("2026-11-18 12:00");
        assert_eq!(
            day(first_kept_day(noon, 366)),
            Date::from_calendar_date(2025, Month::November, 17).expect("a date")
        );
        // At midnight the day that just left the window goes too.
        let midnight =
            OffsetDateTime::from_unix_timestamp(1_794_960_000).expect("2026-11-18 00:00");
        assert_eq!(
            day(first_kept_day(midnight, 1)),
            Date::from_calendar_date(2026, Month::November, 17).expect("a date")
        );
    }

    /// A bucket of keys and when each was written (`None`: the store
    /// doesn't say), for the lifecycle rules.
    #[derive(Default)]
    struct DatedBucket(std::sync::Mutex<BTreeMap<String, Option<i64>>>);

    impl DatedBucket {
        fn with(objects: &[(&str, Option<i64>)]) -> Self {
            Self(std::sync::Mutex::new(
                objects
                    .iter()
                    .map(|(key, at)| ((*key).to_owned(), *at))
                    .collect(),
            ))
        }

        fn keys(&self) -> Vec<String> {
            self.0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .keys()
                .cloned()
                .collect()
        }
    }

    #[allow(clippy::unused_async_trait_impl)] // the trait's shape
    impl FileStore for DatedBucket {
        async fn put(
            &self,
            _key: &str,
            _bytes: Vec<u8>,
            _options: &weldsuite_ports::PutOptions,
        ) -> Result<Option<weldsuite_ports::Stored>, PortError> {
            Err(PortError::backend("not written here"))
        }

        async fn get(
            &self,
            _key: &str,
        ) -> Result<Option<weldsuite_ports::StoredObject>, PortError> {
            Ok(None)
        }

        async fn head(&self, _key: &str) -> Result<Option<weldsuite_ports::ObjectInfo>, PortError> {
            Ok(None)
        }

        async fn delete(&self, key: &str) -> Result<(), PortError> {
            self.delete_many(&[key.to_owned()]).await
        }

        async fn delete_many(&self, keys: &[String]) -> Result<(), PortError> {
            let mut objects = self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for key in keys {
                objects.remove(key);
            }
            Ok(())
        }

        async fn list(
            &self,
            prefix: &str,
        ) -> Result<Vec<weldsuite_ports::ListedObject>, PortError> {
            Ok(self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .iter()
                .filter(|(key, _)| key.starts_with(prefix))
                .map(|(key, at)| weldsuite_ports::ListedObject {
                    key: key.clone(),
                    size: 1,
                    last_modified_ms: *at,
                })
                .collect())
        }
    }

    /// Global's lifecycle rules on the replays bucket, in the panel bucket:
    /// each prefix's objects past its age go, counted from when each was
    /// written; nothing else in the bucket is touched.
    #[tokio::test]
    async fn the_replays_expire_by_their_prefix_lifecycle() {
        let now = 1_795_003_200_000_i64;
        let days = |n: i64| Some(now - n * DAY_MS);
        let chunk = |tier: &str, session: &str| {
            format!("replays/{tier}/ws_1/pnp_1/2026-01-01/{session}/0.json.gz")
        };
        let objects = [
            (chunk("30d", "old"), days(31)),
            (chunk("30d", "due"), days(30)),
            (chunk("30d", "young"), days(29)),
            (chunk("30d", "undated"), None),
            (chunk("90d", "old"), days(91)),
            (chunk("90d", "young"), days(60)),
            // A favourite's copy outlives its 30-day original.
            (chunk("keep", "young"), days(200)),
            (chunk("keep", "old"), days(400)),
            (
                "snapshots/ws_1/pnp_1/pnh_1/mobile.json.gz".to_owned(),
                days(100),
            ),
            (
                "snapshots/ws_1/pnp_1/pnh_1/desktop.json.gz".to_owned(),
                days(10),
            ),
            // The Iceberg tables share the bucket and have their own upkeep.
            (
                "lake/panel/events_v1/data/old.parquet".to_owned(),
                days(1000),
            ),
        ];
        let refs: Vec<(&str, Option<i64>)> = objects
            .iter()
            .map(|(key, at)| (key.as_str(), *at))
            .collect();
        let bucket = std::sync::Arc::new(DatedBucket::with(&refs));
        let replays = weldsuite_panel::PanelBucketReplays::new(
            std::sync::Arc::clone(&bucket) as std::sync::Arc<dyn DynFileStore>
        );

        let (deleted, errors) = expire_replays(&replays, now).await;

        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(
            deleted,
            BTreeMap::from([("30d/", 2), ("90d/", 1), ("keep/", 1), ("snapshots/", 1)])
        );
        let mut kept = vec![
            chunk("30d", "undated"),
            chunk("30d", "young"),
            chunk("90d", "young"),
            chunk("keep", "young"),
            "lake/panel/events_v1/data/old.parquet".to_owned(),
            "snapshots/ws_1/pnp_1/pnh_1/desktop.json.gz".to_owned(),
        ];
        kept.sort();
        assert_eq!(bucket.keys(), kept);
    }

    /// Records what `clearErased` was asked to release.
    #[derive(Default)]
    struct Released(std::sync::Mutex<Vec<(String, String, Vec<String>)>>);

    impl ErasedIds for Released {
        fn clear<'a>(
            &'a self,
            project: ProjectRef<'a>,
            ids: &'a [String],
        ) -> BoxFuture<'a, Result<(), PortError>> {
            self.0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push((
                    project.workspace_id.to_owned(),
                    project.project_id.to_owned(),
                    ids.to_vec(),
                ));
            Box::pin(std::future::ready(Ok(())))
        }
    }

    /// Lists the scratch store's files on disk, all of them old.
    struct DiskLister(std::path::PathBuf);

    impl Lister for DiskLister {
        fn list<'a>(&'a self, location: &'a str) -> BoxFuture<'a, Result<Vec<ListedFile>, String>> {
            Box::pin(async move {
                let table = location.rsplit('/').next().unwrap_or_default();
                let mut out = Vec::new();
                let mut stack = vec![self.0.join("warehouse").join("panel").join(table)];
                while let Some(at) = stack.pop() {
                    for entry in std::fs::read_dir(&at).map_err(|error| error.to_string())? {
                        let path = entry.map_err(|error| error.to_string())?.path();
                        if path.is_dir() {
                            stack.push(path);
                        } else {
                            out.push(ListedFile {
                                path: crate::panel_test_support::file_url(&path),
                                modified_ms: Some(0),
                            });
                        }
                    }
                }
                Ok(out)
            })
        }
    }

    /// The whole night on a scratch master (migrated) and store: erasure
    /// from the ledger, retention by plan, compaction, the orphan sweep.
    #[tokio::test]
    #[allow(clippy::too_many_lines)] // one night, in order
    async fn a_night_erases_expires_compacts_and_sweeps() {
        use crate::panel_test_support::{ScratchPanel, event};
        let Some(scratch) = ScratchPanel::new().await else {
            return;
        };
        let master = &scratch.master;
        for (id, slug) in [("pln_free_t", "free"), ("pln_biz_t", "business")] {
            sqlx::query(
                "insert into plans (id, name, slug) values ($1, $2, $2) on conflict (slug) do nothing",
            )
            .bind(id)
            .bind(slug)
            .execute(master)
            .await
            .expect("a plan");
        }
        for (workspace, slug) in [("ws_free", "free"), ("ws_biz", "business")] {
            sqlx::query(
                "insert into workspaces (id, name, slug, plan_id) \
                 values ($1, $1, $1, (select id from plans where slug = $2))",
            )
            .bind(workspace)
            .bind(slug)
            .execute(master)
            .await
            .expect("a workspace");
        }
        let now = OffsetDateTime::now_utc();
        let at = |days: i64| weldsuite_events::iso_timestamp(now - time::Duration::days(days));
        // Per workspace: rows 10, 400 and 800 days old, two small files of
        // the recent day; `ws_gone` isn't in the master any more.
        for workspace in ["ws_free", "ws_biz", "ws_gone"] {
            let project = format!("pnp_{workspace}");
            for (n, days) in [(1, 10), (2, 10), (3, 400), (4, 800)] {
                for person in ["u-1", "u-2"] {
                    let row = event(
                        workspace,
                        &project,
                        &format!("{workspace}-{n}-{person}"),
                        person,
                        &format!("s-{person}"),
                        &at(days),
                    );
                    scratch
                        .lake
                        .append_rows(PanelTable::Events, &[row], None)
                        .await
                        .expect("an append");
                }
            }
        }
        // u-1 is erased in ws_biz; a request the writer may not have
        // committed the rows of yet (five minutes old), and one that comes
        // after the run starts, wait for a later one.
        for (id, when) in [
            ("u-1", now - time::Duration::hours(1)),
            ("u-2", now + time::Duration::hours(1)),
            ("u-3", now - time::Duration::minutes(5)),
        ] {
            sqlx::query(
                "insert into panel_erasure_ledger (workspace_id, project_id, erased_id, requested_at) \
                 values ('ws_biz', 'pnp_ws_biz', $1, $2::timestamptz)",
            )
            .bind(id)
            .bind(weldsuite_events::iso_timestamp(when))
            .execute(master)
            .await
            .expect("a ledger row");
        }
        // A file a crashed writer left.
        let stray = scratch
            .dir()
            .join("warehouse/panel/events_v1/data/workspace_id=ws_biz/stray.parquet");
        std::fs::create_dir_all(stray.parent().expect("a folder")).expect("a folder");
        std::fs::write(&stray, "stray").expect("a stray file");

        let released = Released::default();
        let report = run(
            master,
            &scratch.lake,
            &DiskLister(scratch.dir().to_path_buf()),
            now,
            &MaintenanceSettings::default(),
            NightPorts {
                projects: Some(&released),
                ..NightPorts::default()
            },
        )
        .await;
        assert_eq!(report["errors"], json!([]), "{report}");
        // Erasure first: u-1's four rows in ws_biz.
        assert_eq!(report["erased"]["ids"], 1, "{report}");
        // Only what the rewrite covered leaves the project's erased list.
        assert_eq!(
            released.0.into_inner().expect("released"),
            [(
                "ws_biz".to_owned(),
                "pnp_ws_biz".to_owned(),
                vec!["u-1".to_owned()]
            )]
        );
        assert_eq!(report["erased"]["events"], 4, "{report}");
        // Then retention: Free loses its 400- and 800-day rows (4), business
        // its 800-day one (u-2's), the unknown workspace its 800-day ones (2).
        assert_eq!(report["expired"]["events"], 4 + 1 + 2, "{report}");
        // The 10-day partitions of all three, and ws_gone's 400-day one.
        assert_eq!(report["compactedPartitions"], 4, "{report}");
        assert_eq!(report["orphansDeleted"], 1, "{report}");
        assert!(!stray.exists());
        assert_eq!(scratch.rows(PanelTable::Events).await, 24 - 4 - 7);
        let pending: Vec<(String, bool)> = sqlx::query_as(
            "select erased_id, applied_at is not null from panel_erasure_ledger order by erased_id",
        )
        .fetch_all(master)
        .await
        .expect("the ledger");
        assert_eq!(
            pending,
            [
                ("u-1".to_owned(), true),
                ("u-2".to_owned(), false),
                ("u-3".to_owned(), false)
            ]
        );
        scratch.finish().await;
    }

    #[test]
    fn an_erasure_waits_for_the_writer_s_flush_and_its_lag() {
        use crate::consume::panel_writer::flush_after_from;
        let now = OffsetDateTime::from_unix_timestamp(1_795_003_200).expect("2026-11-18 12:00");
        let minutes = time::Duration::minutes;
        let settings = MaintenanceSettings::default();
        // The writer's flush interval (5 minutes) and the margin (10).
        assert_eq!(erasure_cutoff(now, &settings, None), now - minutes(15));
        // A row younger than that is the writer's usual buffer.
        assert_eq!(
            erasure_cutoff(now, &settings, Some(now - minutes(1))),
            now - minutes(15)
        );
        // Behind: before its oldest row not committed, less the margin.
        assert_eq!(
            erasure_cutoff(now, &settings, Some(now - minutes(120))),
            now - minutes(130)
        );
        // A longer flush interval waits longer.
        let slow = MaintenanceSettings {
            writer_flush_after: Duration::from_mins(30),
            ..MaintenanceSettings::default()
        };
        assert_eq!(erasure_cutoff(now, &slow, None), now - minutes(40));
        // The interval the cron reads, as `consume` does.
        assert_eq!(flush_after_from(&|_| None), Duration::from_mins(5));
        assert_eq!(
            flush_after_from(&|_| Some("60".to_owned())),
            Duration::from_secs(60)
        );
        for wrong in ["0", "soon", "-5"] {
            assert_eq!(
                flush_after_from(&|_| Some(wrong.to_owned())),
                Duration::from_mins(5)
            );
        }
    }

    /// A writer that is behind until a given time, caught up, or out of
    /// reach.
    struct FixedLag(Result<Option<OffsetDateTime>, String>);

    impl WriterLag for FixedLag {
        fn oldest_uncommitted<'a>(
            &'a self,
            _lake: &'a Lakehouse,
        ) -> BoxFuture<'a, Result<Option<OffsetDateTime>, String>> {
            Box::pin(std::future::ready(self.0.clone()))
        }
    }

    /// Against a scratch master: requests are taken only once the writer
    /// has committed the rows collected before them.
    #[tokio::test]
    async fn erasure_takes_only_requests_whose_rows_the_writer_has_committed() {
        use crate::panel_test_support::ScratchPanel;
        let Some(scratch) = ScratchPanel::new().await else {
            return;
        };
        let master = &scratch.master;
        let now = OffsetDateTime::now_utc();
        for (id, minutes) in [("u-old", 180), ("u-mid", 90), ("u-new", 5)] {
            sqlx::query(
                "insert into panel_erasure_ledger (workspace_id, project_id, erased_id, requested_at) \
                 values ('ws_lag', 'pnp_lag', $1, $2::timestamptz)",
            )
            .bind(id)
            .bind(weldsuite_events::iso_timestamp(
                now - time::Duration::minutes(minutes),
            ))
            .execute(master)
            .await
            .expect("a ledger row");
        }
        let lister = DiskLister(scratch.dir().to_path_buf());
        let night = |lag: FixedLag| {
            let lister = &lister;
            let lake = &scratch.lake;
            async move {
                run(
                    master,
                    lake,
                    lister,
                    now,
                    &MaintenanceSettings::default(),
                    NightPorts {
                        lag: Some(&lag),
                        ..NightPorts::default()
                    },
                )
                .await
            }
        };
        let applied = || async {
            sqlx::query_scalar::<_, String>(
                "select erased_id from panel_erasure_ledger \
                 where workspace_id = 'ws_lag' and applied_at is not null order by erased_id",
            )
            .fetch_all(master)
            .await
            .expect("the ledger")
        };

        // The writer's progress unknown (NATS out of reach): none is taken.
        let report = night(FixedLag(Err("NATS: connection refused".to_owned()))).await;
        let errors = report["errors"].to_string();
        assert!(errors.contains("progress is unknown"), "{report}");
        let none = applied().await;
        assert!(none.is_empty(), "{none:?}");

        // Two hours behind: only the request older than its oldest row
        // (less the margin).
        let report = night(FixedLag(Ok(Some(now - time::Duration::hours(2))))).await;
        assert_eq!(report["errors"], json!([]), "{report}");
        assert_eq!(applied().await, ["u-old"]);

        // Caught up: the rest older than the flush interval and the margin.
        let report = night(FixedLag(Ok(None))).await;
        assert_eq!(report["errors"], json!([]), "{report}");
        assert_eq!(applied().await, ["u-mid", "u-old"]);
        scratch.finish().await;
    }

    /// Against throwaway Postgres and NATS: the lag is the publish time of
    /// the first row on a feed after its table's committed sequence.
    #[tokio::test]
    async fn the_writer_s_lag_is_its_oldest_row_not_committed() {
        use crate::consume::panel_writer::Feed;
        use crate::panel_test_support::{ScratchPanel, event, unique};
        let Ok(nats) = std::env::var("WELDSUITE_TEST_NATS_URL") else {
            eprintln!("skipped: WELDSUITE_TEST_NATS_URL is not set");
            return;
        };
        let Some(scratch) = ScratchPanel::new().await else {
            return;
        };
        let bus = weldsuite_adapters_oss::JetStreamEventBus::connect(
            &weldsuite_adapters_oss::NatsOptions {
                url: nats,
                ..weldsuite_adapters_oss::NatsOptions::default()
            },
        )
        .await
        .expect("nats");
        let js = bus.context().clone();
        let tag = unique("t");
        let subject = format!("panel.events{tag}.v1");
        let stream = format!("TEST_PANEL_EVENTS_{tag}");
        js.get_or_create_stream(weldsuite_adapters_oss::panel_events_stream_config(
            &stream,
            &subject,
            Duration::from_hours(1),
        ))
        .await
        .expect("the stream");
        let feeds = [Feed {
            table: PanelTable::Events,
            stream: stream.clone(),
            subject: format!("{subject}.>"),
        }];
        let lag = || oldest_uncommitted(&js, &scratch.lake, &feeds);
        assert_eq!(lag().await, Ok(None), "nothing published");
        // A stream never made holds nothing to wait for.
        let unmade = [Feed {
            table: PanelTable::Identities,
            stream: format!("TEST_PANEL_UNMADE_{tag}"),
            subject: format!("panel.identities{tag}.v1.>"),
        }];
        assert_eq!(
            oldest_uncommitted(&js, &scratch.lake, &unmade).await,
            Ok(None)
        );

        let mut published = Vec::new();
        for n in 0..3 {
            let ack = js
                .publish(format!("{subject}.ws_1"), format!("{{\"n\":{n}}}").into())
                .await
                .expect("a publish")
                .await
                .expect("stored");
            let message = js
                .get_stream(&stream)
                .await
                .expect("the stream")
                .get_raw_message(ack.sequence)
                .await
                .expect("the message");
            published.push((ack.sequence, message.time));
        }
        // Nothing committed: the first row.
        assert_eq!(lag().await, Ok(Some(published[0].1)));
        // Committed through the second: the third.
        let row = event(
            "ws_1",
            "pnp_1",
            "e1",
            "a-1",
            "s-1",
            "2026-11-18T10:00:00.000Z",
        );
        scratch
            .lake
            .append_rows(
                PanelTable::Events,
                std::slice::from_ref(&row),
                Some(published[1].0),
            )
            .await
            .expect("an append");
        assert_eq!(lag().await, Ok(Some(published[2].1)));
        // Through the third: caught up.
        scratch
            .lake
            .append_rows(PanelTable::Events, &[row], Some(published[2].0))
            .await
            .expect("an append");
        assert_eq!(lag().await, Ok(None));
        let _ = js.delete_stream(&stream).await;
        scratch.finish().await;
    }
}
