//! `weldsuite cron panel-maintenance` (nightly): WeldPanel's table upkeep on
//! the Kubernetes editions (ADR EVT-019), what panel-maintenance's weekly
//! Workflow and `PyIceberg` container do on Global, plus the upkeep Basin's
//! catalog does there by itself. In order, each step on its own (one that
//! fails is reported and the next runs):
//!
//! 1. **Erasure.** The ids `panel_erasure_ledger` holds (master database;
//!    never a tenant database) are erased from events, identity links,
//!    profiles and the recording chunk index, a workspace at a time, and
//!    their rows marked applied. An id requested again during the run stays
//!    pending.
//! 2. **Retention.** Each workspace's day partitions past its plan's window
//!    are dropped from `events_v1` and `replay_chunks_v1`: 366 days on Free
//!    (or no plan), 762 otherwise, the window Global's queries use
//!    (`eventRetentionDays`); a workspace the master doesn't know keeps the
//!    longest. Plans come from the master database.
//! 3. **Compaction** of every partition with two or more small files.
//! 4. **Snapshot expiry** (older than a day, keeping the newest ten), and the
//!    files only expired snapshots used.
//! 5. **The orphan sweep:** files under each table that no metadata names
//!    and that are older than three days (what a crash between writing and
//!    committing leaves).

use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_lakehouse::{
    Erasure, ErasureCounts, Lakehouse, ListedFile, ORPHAN_MIN_AGE, PanelTable, SMALL_FILE_BYTES,
    partitions, workspaces_in,
};
use weldsuite_ports::{BoxFuture, FileStore};

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

/// How long snapshots and orphans are kept.
#[derive(Debug, Clone)]
pub(crate) struct MaintenanceSettings {
    /// Snapshots older than this are expired (a query reads a snapshot it
    /// loaded seconds ago; a day is plenty).
    pub(crate) snapshot_age: Duration,
    /// The newest snapshots always kept.
    pub(crate) retain_snapshots: usize,
    /// Unreferenced files younger than this stay.
    pub(crate) orphan_min_age: Duration,
}

impl Default for MaintenanceSettings {
    fn default() -> Self {
        Self {
            snapshot_age: Duration::from_hours(24),
            retain_snapshots: 10,
            orphan_min_age: ORPHAN_MIN_AGE,
        }
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
) -> Value {
    let mut errors: Vec<String> = Vec::new();

    // 1. Erasure.
    let mut erased = ErasureCounts::default();
    let mut applied_ids = 0_u64;
    match pending_erasures(master, now).await {
        Ok(by_workspace) => {
            for erasure in by_workspace.into_values() {
                match lake.erase_people(&erasure).await {
                    Ok(counts) => {
                        erased.events += counts.events;
                        erased.identities += counts.identities;
                        erased.people += counts.people;
                        erased.replay_chunks += counts.replay_chunks;
                        match mark_applied(master, &erasure, now).await {
                            Ok(rows) => applied_ids += rows,
                            Err(error) => errors.push(format!(
                                "erasure in {}: marking the ledger: {error}",
                                erasure.workspace_id
                            )),
                        }
                        // Step 4: the tenant's exclusion list (what
                        // `clearErased` does to the PanelProject object on
                        // Global) is released here, for this workspace only.
                    }
                    Err(error) => {
                        errors.push(format!("erasure in {}: {error}", erasure.workspace_id));
                    }
                }
            }
        }
        Err(error) => errors.push(format!("reading the erasure ledger: {error}")),
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
            // Step 5: the recording chunks past each workspace's recording
            // window are deleted from the bucket here (Global's R2 lifecycle
            // rules on the `replays/<tier>/` prefixes).
        }
        Err(error) => errors.push(format!("reading the plans: {error}")),
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
            "ids": applied_ids,
            "events": erased.events,
            "identities": erased.identities,
            "people": erased.people,
            "replayChunks": erased.replay_chunks,
        },
        "expired": {
            "events": expired_rows.get("events_v1").copied().unwrap_or(0),
            "replayChunks": expired_rows.get("replay_chunks_v1").copied().unwrap_or(0),
        },
        "compactedPartitions": compacted,
        "expiredSnapshots": expired_snapshots,
        "deletedFiles": deleted_files,
        "orphansDeleted": orphans,
        "errors": errors,
    })
}

/// The ledger's pending ids requested up to `now`, by workspace.
async fn pending_erasures(
    master: &PgPool,
    now: OffsetDateTime,
) -> Result<BTreeMap<String, Erasure>, sqlx::Error> {
    let rows: Vec<Pending> = sqlx::query_as(
        "select workspace_id, project_id, erased_id from panel_erasure_ledger \
         where applied_at is null and requested_at <= $1::timestamptz \
         order by workspace_id, project_id, erased_id",
    )
    .bind(weldsuite_events::iso_timestamp(now))
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
/// `started` (the rewrite didn't cover what came after it began).
async fn mark_applied(
    master: &PgPool,
    erasure: &Erasure,
    started: OffsetDateTime,
) -> Result<u64, sqlx::Error> {
    let mut applied = 0;
    for (project, ids) in &erasure.ids_by_project {
        let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
        applied += sqlx::query(
            "update panel_erasure_ledger set applied_at = now() \
             where workspace_id = $1 and project_id = $2 and erased_id = any($3) \
             and applied_at is null and requested_at <= $4::timestamptz",
        )
        .bind(&erasure.workspace_id)
        .bind(project)
        .bind(&ids)
        .bind(weldsuite_events::iso_timestamp(started))
        .execute(master)
        .await?
        .rows_affected();
    }
    Ok(applied)
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
        // u-1 is erased in ws_biz; a request that comes after the run starts
        // waits for the next one.
        for (id, when) in [
            ("u-1", now - time::Duration::hours(1)),
            ("u-2", now + time::Duration::hours(1)),
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

        let report = run(
            master,
            &scratch.lake,
            &DiskLister(scratch.dir().to_path_buf()),
            now,
            &MaintenanceSettings::default(),
        )
        .await;
        assert_eq!(report["errors"], json!([]), "{report}");
        // Erasure first: u-1's four rows in ws_biz.
        assert_eq!(report["erased"]["ids"], 1, "{report}");
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
            [("u-1".to_owned(), true), ("u-2".to_owned(), false)]
        );
        scratch.finish().await;
    }
}
