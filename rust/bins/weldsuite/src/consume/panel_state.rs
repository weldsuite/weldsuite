//! The `panel-state` subscriber: the collector's `PanelProject` calls
//! (`panel.ops.v1.<workspace>` on `PANEL_STATE`, `crate::panel_project::ops`)
//! applied to the workspace's tenant tables with the object's rules
//! (`crate::panel_project::tenant`). Only the producing workspace's
//! database is opened (ADR DATA-008), and the `identities_v1`, `people_v1`
//! and `groups_v1` rows the object would write go to `PANEL_STATE` for
//! `panel-writer`.
//!
//! - **In order.** The object applies one call at a time per project; here
//!   one replica applies (a lease in Valkey, like `panel-writer`'s), one
//!   batch at a time, each workspace's messages in stream order (workspaces
//!   side by side). A session starts by recreating the durable consumer
//!   right after its acknowledged floor, so what a previous holder left
//!   unacknowledged comes again in order; a skipped delivery restarts the
//!   session.
//! - **Once.** Each project's `panel_project_meta` row records the last
//!   stream sequence applied (and which stream, by name and creation time),
//!   in the transaction that applies it, so a redelivery is skipped. The
//!   rows are published before that commit under ids made of the sequence:
//!   a retry after a failed commit publishes the same rows, and the stream
//!   keeps one copy (two-minute duplicate window).
//! - **Failures.** A call that can never apply is dead-lettered to
//!   `PANEL_DLQ` (`panel-dlq.ops.v1.<ws>`) at once: a message that is not
//!   an operation, or one whose data the database refuses (SQLSTATE class
//!   22 or 23: a data exception, a broken constraint; a value that doesn't
//!   encode or decode). Anything else is the infrastructure (the
//!   workspace's database, the workspace registry, NATS) and drops
//!   nothing: the call and every later call of its workspace wait,
//!   unacknowledged and in stream order, while the other workspaces go on,
//!   and the workspace is tried again after a pause that doubles from
//!   `retry_after` up to `max_retry_after`. The waiting calls count towards
//!   the consumer's `max_pending` (kept alive with progress
//!   acknowledgements): a workspace down long enough to fill it holds the
//!   others up too. A session that ends (the lease, a skipped delivery)
//!   leaves them unacknowledged, so the next one gets them again in order.
//!   A deleted workspace's calls are dropped.
//! - **The collector's lists.** After a call, the project's group types and
//!   erased ids in Valkey (`crate::panel_project::valkey`) are rewritten
//!   from the tenant tables when the types changed, when the collector asked
//!   (`warm`), or when either list is missing.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_nats::jetstream::{self, AckKind, consumer};
use futures_util::StreamExt;
use sqlx::PgPool;
use tokio::sync::watch;
use weldsuite_adapters_oss::{
    CONSUMER_MESSAGES_METRIC, ConsumerSpec, ValkeyLease, publish_dead_letter,
};
use weldsuite_panel::ProjectRef;
use weldsuite_ports::PortError;

use super::panel_writer::{AbortOnDrop, DLQ_SUBJECT, Start, fetch, keep_lease, start};
use crate::panel_project::ops::{OPS_SUBJECT, OpMessage, ProjectOp};
use crate::panel_project::rows::{Emitted, RowSink};
use crate::panel_project::{PanelValkey, TenantPools, db, tenant};

/// The durable consumer, and the lease's name.
pub(crate) const DURABLE: &str = "panel-state";

/// How the applier fetches and retries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ApplierSettings {
    /// Messages per fetch.
    pub(crate) batch: usize,
    /// How long a fetch waits for messages.
    pub(crate) fetch_wait: Duration,
    /// The lease's time to live; renewed every third of it.
    pub(crate) lease_ttl: Duration,
    /// The pause before a waiting workspace is first tried again; doubled
    /// after each failure.
    pub(crate) retry_after: Duration,
    /// The longest pause.
    pub(crate) max_retry_after: Duration,
    /// Calls held unacknowledged at most, the waiting ones included (the
    /// consumer's `max_ack_pending`).
    pub(crate) max_pending: usize,
    /// Workspaces applied at once.
    pub(crate) concurrency: usize,
}

impl Default for ApplierSettings {
    fn default() -> Self {
        Self {
            batch: 256,
            fetch_wait: Duration::from_secs(5),
            lease_ttl: Duration::from_secs(30),
            retry_after: Duration::from_secs(1),
            max_retry_after: Duration::from_secs(30),
            max_pending: 10_000,
            concurrency: 8,
        }
    }
}

/// Every workspace's operations: `panel.ops.v1.>`.
pub(crate) fn all_operations() -> String {
    format!("{OPS_SUBJECT}.>")
}

/// The consumer of `filter` (every workspace's operations,
/// [`all_operations`]) on the state stream.
pub(crate) fn spec(stream: &str, filter: &str, settings: &ApplierSettings) -> ConsumerSpec {
    ConsumerSpec {
        stream: stream.to_owned(),
        durable: DURABLE.to_owned(),
        description: format!(
            "WeldSuite panel-state: {filter} into the tenant tables (PANEL-004, EVT-019)"
        ),
        filter_subject: filter.to_owned(),
        deliver_new_only: false,
        max_retries: 0,
        max_deferrals: 0,
        retry_backoff: Vec::new(),
        // A batch applies in well under a minute; the calls of a waiting
        // workspace are kept alive by progress acknowledgements.
        ack_wait: Duration::from_mins(5),
        batch_size: settings.batch,
        batch_wait: settings.fetch_wait,
        workers: 1,
        dead_letter_subject: DLQ_SUBJECT.to_owned(),
        dedupe_capacity: 0,
    }
}

/// The consumer a session recreates: from `start`, never giving a message
/// up on the server's count, with room for `max_pending` unacknowledged.
pub(crate) fn consumer_config(
    spec: &ConsumerSpec,
    settings: &ApplierSettings,
    start: Start,
) -> consumer::pull::Config {
    let mut config = spec.config();
    config.deliver_policy = match start {
        Start::All => consumer::DeliverPolicy::All,
        Start::After(seq) => consumer::DeliverPolicy::ByStartSequence {
            start_sequence: seq + 1,
        },
    };
    config.max_deliver = -1;
    config.max_ack_pending =
        i64::try_from(settings.max_pending.max(settings.batch.max(1))).unwrap_or(i64::MAX);
    config
}

/// What became of one call.
#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    /// Applied, or applied before, or its workspace is gone.
    Done,
    /// Never to apply (not an operation, data the database refuses): a
    /// dead letter.
    Bad(String),
    /// Not now (the infrastructure failed): it and the workspace's later
    /// calls wait.
    Wait(String),
}

/// Why one try failed.
#[derive(Debug, PartialEq, Eq)]
enum Failure {
    /// The workspace is gone: nothing to apply to.
    Gone,
    /// The call's data can't be stored, however often it is tried.
    Refused(String),
    /// The workspace's database, the registry or NATS failed: later, in
    /// order.
    Unavailable(String),
}

/// Whether a database error is about the data a call stores, so trying the
/// call again can't help: SQLSTATE class 22 (a data exception) or 23 (an
/// integrity constraint violation), or a value that doesn't encode or
/// decode. Everything else (the connection, the pool, a lock or
/// serialization conflict, the server shutting down, a schema not migrated
/// yet) is the database being unavailable.
pub(crate) fn refuses_the_data(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(error) => error
            .code()
            .is_some_and(|code| code.starts_with("22") || code.starts_with("23")),
        sqlx::Error::Encode(_) | sqlx::Error::Decode(_) | sqlx::Error::ColumnDecode { .. } => true,
        _ => false,
    }
}

/// A database error: refused when it is about the call's data
/// ([`refuses_the_data`]), else the database is unavailable.
impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        if refuses_the_data(&error) {
            Self::Refused(error.to_string())
        } else {
            Self::Unavailable(error.to_string())
        }
    }
}

/// The rows' publish: rows that can't be serialized are refused; NATS
/// failing is unavailable.
fn publish_failure(error: PortError) -> Failure {
    match error {
        PortError::Json(error) => Failure::Refused(error.to_string()),
        PortError::Backend(error) => Failure::Unavailable(error.to_string()),
    }
}

/// The messages by workspace (the subject's last token), each workspace's
/// by stream sequence (a message delivered twice in one fetch once, its
/// newer delivery).
fn by_workspace<M>(messages: Vec<(String, u64, M)>) -> Vec<(String, BTreeMap<u64, M>)> {
    let mut groups: Vec<(String, BTreeMap<u64, M>)> = Vec::new();
    for (subject, seq, message) in messages {
        let workspace = subject.rsplit('.').next().unwrap_or_default().to_owned();
        match groups.iter_mut().find(|(known, _)| *known == workspace) {
            Some((_, group)) => {
                group.insert(seq, message);
            }
            None => groups.push((workspace, BTreeMap::from([(seq, message)]))),
        }
    }
    groups
}

/// What became of a workspace's calls.
#[derive(Debug)]
enum GroupEnd<M> {
    /// Each applied, dropped or dead-lettered.
    Done,
    /// The infrastructure failed: these (from the one that failed on) wait.
    Waiting {
        calls: BTreeMap<u64, M>,
        reason: String,
    },
}

/// The workspaces whose calls wait for their database, the registry or
/// NATS to answer again: each one's calls not applied yet, by stream
/// sequence, and when to try again.
#[derive(Debug)]
pub(crate) struct Waiting<M> {
    workspaces: HashMap<String, Held<M>>,
}

#[derive(Debug)]
struct Held<M> {
    calls: BTreeMap<u64, M>,
    retry_at: Instant,
    /// The pause last waited.
    pause: Duration,
}

impl<M> Default for Waiting<M> {
    fn default() -> Self {
        Self {
            workspaces: HashMap::new(),
        }
    }
}

impl<M> Waiting<M> {
    /// Calls of `workspace` just fetched: queued behind its waiting ones (a
    /// call delivered again replaces its earlier delivery), or handed back
    /// when it isn't waiting.
    pub(crate) fn queue(
        &mut self,
        workspace: &str,
        calls: BTreeMap<u64, M>,
    ) -> Option<BTreeMap<u64, M>> {
        match self.workspaces.get_mut(workspace) {
            Some(held) => {
                held.calls.extend(calls);
                None
            }
            None => Some(calls),
        }
    }

    /// The calls of the workspaces due at `now`, taken out to be tried (each
    /// keeps its pause until [`Self::hold`] or [`Self::release`]).
    pub(crate) fn take_due(&mut self, now: Instant) -> Vec<(String, BTreeMap<u64, M>)> {
        self.workspaces
            .iter_mut()
            .filter(|(_, held)| held.retry_at <= now && !held.calls.is_empty())
            .map(|(workspace, held)| (workspace.clone(), std::mem::take(&mut held.calls)))
            .collect()
    }

    /// The workspace's calls (from the one that failed on) wait: tried again
    /// after `first`, then after twice the pause before each time, at most
    /// `max`. Returns the pause.
    pub(crate) fn hold(
        &mut self,
        workspace: String,
        calls: BTreeMap<u64, M>,
        now: Instant,
        first: Duration,
        max: Duration,
    ) -> Duration {
        let pause = self
            .workspaces
            .get(&workspace)
            .map_or(first, |held| held.pause.saturating_mul(2))
            .min(max);
        let held = self.workspaces.entry(workspace).or_insert_with(|| Held {
            calls: BTreeMap::new(),
            retry_at: now,
            pause,
        });
        held.calls.extend(calls);
        held.pause = pause;
        held.retry_at = now + pause;
        pause
    }

    /// The workspace's calls all went through: it waits no more.
    pub(crate) fn release(&mut self, workspace: &str) {
        self.workspaces.remove(workspace);
    }

    /// When the next workspace is due.
    pub(crate) fn next_due(&self) -> Option<Instant> {
        self.workspaces.values().map(|held| held.retry_at).min()
    }

    /// Every waiting call.
    pub(crate) fn calls(&self) -> impl Iterator<Item = &M> {
        self.workspaces
            .values()
            .flat_map(|held| held.calls.values())
    }

    /// How many calls wait.
    pub(crate) fn len(&self) -> usize {
        self.workspaces.values().map(|held| held.calls.len()).sum()
    }
}

/// The applier.
pub(crate) struct StateApplier {
    pub(crate) jetstream: jetstream::Context,
    /// `PANEL_STATE`.
    pub(crate) stream: String,
    /// The subjects applied: [`all_operations`].
    pub(crate) filter: String,
    pub(crate) pools: Arc<dyn TenantPools>,
    pub(crate) rows: RowSink,
    pub(crate) valkey: Option<PanelValkey>,
    pub(crate) settings: ApplierSettings,
}

impl StateApplier {
    /// Applies while it holds the lease, standing by otherwise, until `stop`.
    pub(crate) fn spawn(
        self: &Arc<Self>,
        lease: ValkeyLease,
        stop: &watch::Receiver<bool>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(Arc::clone(self).run(lease, stop.clone()))
    }

    async fn run(self: Arc<Self>, lease: ValkeyLease, mut stop: watch::Receiver<bool>) {
        let standby = (self.settings.lease_ttl / 3).max(Duration::from_secs(1));
        loop {
            if *stop.borrow() {
                return;
            }
            match lease.try_acquire().await {
                Ok(true) => {
                    tracing::info!(lease = lease.key(), "panel-state: applying");
                    if let Err(reason) = self.session(&lease, &stop).await {
                        tracing::warn!(reason, "panel-state: starting over");
                    }
                    if let Err(error) = lease.release().await {
                        tracing::warn!(%error, "panel-state: could not give the lease back");
                    }
                }
                Ok(false) => {}
                Err(error) => tracing::warn!(%error, "panel-state: the lease is out of reach"),
            }
            tokio::select! {
                () = tokio::time::sleep(standby) => {}
                _ = stop.wait_for(|stopping| *stopping) => return,
            }
        }
    }

    /// Recreates the consumer right after its acknowledged floor. Returns it
    /// and the stream's epoch (name and creation time).
    async fn reset_consumer(
        &self,
        spec: &ConsumerSpec,
    ) -> Result<(consumer::PullConsumer, String), String> {
        let mut stream = self
            .jetstream
            .get_stream(&spec.stream)
            .await
            .map_err(|error| error.to_string())?;
        let info = stream.info().await.map_err(|error| error.to_string())?;
        let epoch = format!("{}@{}", spec.stream, info.created.unix_timestamp_nanos());
        let last = info.state.last_sequence;
        let floor = match stream.consumer_info(&spec.durable).await {
            Ok(info) => Some(info.ack_floor.stream_sequence),
            Err(_) => None,
        };
        if let Err(error) = stream.delete_consumer(&spec.durable).await {
            tracing::debug!(%error, "panel-state: no consumer to delete");
        }
        let consumer = stream
            .create_consumer(consumer_config(spec, &self.settings, start(floor, last)))
            .await
            .map_err(|error| error.to_string())?;
        Ok((consumer, epoch))
    }

    async fn session(
        &self,
        lease: &ValkeyLease,
        stop: &watch::Receiver<bool>,
    ) -> Result<(), String> {
        let (lost_tx, lost) = watch::channel(false);
        let _renewer = AbortOnDrop(tokio::spawn(keep_lease(
            lease.clone(),
            self.settings.lease_ttl / 3,
            lost_tx,
        )));
        let spec = spec(&self.stream, &self.filter, &self.settings);
        let (consumer, epoch) = self.reset_consumer(&spec).await?;
        let progress_every = (spec.ack_wait / 3).max(Duration::from_secs(1));
        let mut last_progress = Instant::now();
        let mut waiting: Waiting<jetstream::Message> = Waiting::default();
        let mut expected_delivery = 1_u64;
        loop {
            if *lost.borrow() {
                return Err("the lease was lost".to_owned());
            }
            if *stop.borrow() {
                // The waiting calls stay unacknowledged: the next session
                // gets them again, in order.
                return Ok(());
            }
            if last_progress.elapsed() >= progress_every {
                // Held, not redelivered meanwhile.
                for message in waiting.calls() {
                    let _ = message.ack_with(AckKind::Progress).await;
                }
                last_progress = Instant::now();
            }
            // No longer than until the next waiting workspace is due.
            let wait = waiting.next_due().map_or(self.settings.fetch_wait, |at| {
                at.saturating_duration_since(Instant::now())
                    .clamp(Duration::from_millis(100), self.settings.fetch_wait)
            });
            let messages = fetch(&consumer, self.settings.batch, wait)
                .await
                .map_err(|error| format!("fetch failed: {error}"))?;
            let mut ordered = Vec::with_capacity(messages.len());
            let mut gap = false;
            for message in messages {
                let Ok(info) = message.info() else {
                    gap = true;
                    break;
                };
                let (stream_seq, delivery) = (info.stream_sequence, info.consumer_sequence);
                if delivery > expected_delivery {
                    gap = true;
                    break;
                }
                if delivery == expected_delivery {
                    expected_delivery += 1;
                }
                ordered.push((message.subject.to_string(), stream_seq, message));
            }
            // The new calls of a waiting workspace queue behind its others;
            // the rest apply now, with the waiting workspaces that are due.
            let mut run: Vec<(String, BTreeMap<u64, jetstream::Message>)> = Vec::new();
            for (workspace, calls) in by_workspace(ordered) {
                if let Some(calls) = waiting.queue(&workspace, calls) {
                    run.push((workspace, calls));
                }
            }
            run.extend(waiting.take_due(Instant::now()));
            let ends: Vec<(String, Result<GroupEnd<jetstream::Message>, String>)> =
                futures_util::stream::iter(run)
                    .map(|(workspace, calls)| self.apply_group(&spec, &epoch, workspace, calls))
                    .buffer_unordered(self.settings.concurrency.max(1))
                    .collect()
                    .await;
            for (workspace, end) in ends {
                match end? {
                    GroupEnd::Done => waiting.release(&workspace),
                    GroupEnd::Waiting { calls, reason } => {
                        let pause = waiting.hold(
                            workspace.clone(),
                            calls,
                            Instant::now(),
                            self.settings.retry_after,
                            self.settings.max_retry_after,
                        );
                        tracing::warn!(
                            workspace,
                            reason,
                            retry_in_ms = u64::try_from(pause.as_millis()).unwrap_or(u64::MAX),
                            waiting = waiting.len(),
                            "panel-state: the workspace's calls wait, in order"
                        );
                    }
                }
            }
            if gap {
                // Applied so far in order; the missing delivery comes again
                // after the floor.
                return Err("a delivery was skipped".to_owned());
            }
        }
    }

    /// One workspace's calls, in order, until one has to wait: then it and
    /// the rest wait, unacknowledged. Fails (the session restarts) only when
    /// a dead letter can't be stored; what follows it in this workspace
    /// stays unacknowledged.
    async fn apply_group(
        &self,
        spec: &ConsumerSpec,
        epoch: &str,
        workspace: String,
        mut calls: BTreeMap<u64, jetstream::Message>,
    ) -> (String, Result<GroupEnd<jetstream::Message>, String>) {
        while let Some((seq, message)) = calls.pop_first() {
            match self.apply_message(&message, seq, epoch).await {
                Outcome::Done => {
                    let _ = message.ack().await;
                    metrics::counter!(CONSUMER_MESSAGES_METRIC, "consumer" => DURABLE, "outcome" => "ok")
                        .increment(1);
                }
                Outcome::Bad(reason) => {
                    if let Err(error) =
                        publish_dead_letter(&self.jetstream, spec, &message, &reason).await
                    {
                        return (
                            workspace,
                            Err(format!("a dead letter could not be stored: {error}")),
                        );
                    }
                    tracing::warn!(reason, subject = %message.subject, "panel-state: dead-lettered a call");
                    let _ = message.ack_with(AckKind::Term).await;
                    metrics::counter!(CONSUMER_MESSAGES_METRIC, "consumer" => DURABLE, "outcome" => "error")
                        .increment(1);
                }
                Outcome::Wait(reason) => {
                    calls.insert(seq, message);
                    metrics::counter!(CONSUMER_MESSAGES_METRIC, "consumer" => DURABLE, "outcome" => "retry")
                        .increment(1);
                    return (workspace, Ok(GroupEnd::Waiting { calls, reason }));
                }
            }
        }
        (workspace, Ok(GroupEnd::Done))
    }

    async fn apply_message(&self, message: &jetstream::Message, seq: u64, epoch: &str) -> Outcome {
        let call: OpMessage = match serde_json::from_slice(&message.payload) {
            Ok(call) => call,
            Err(error) => return Outcome::Bad(format!("not a PanelProject call: {error}")),
        };
        if let Some(problem) = call.problem(message.subject.as_str()) {
            return Outcome::Bad(problem);
        }
        match self.apply(&call, seq, epoch).await {
            Ok(()) => Outcome::Done,
            Err(Failure::Gone) => {
                tracing::info!(
                    workspace = call.workspace_id,
                    "panel-state: the workspace is gone; its call is dropped"
                );
                Outcome::Done
            }
            Err(Failure::Refused(reason)) => Outcome::Bad(reason),
            Err(Failure::Unavailable(reason)) => Outcome::Wait(reason),
        }
    }

    /// One try: the call and its sequence in one transaction under the
    /// project's lock, the rows published before the commit.
    async fn apply(&self, call: &OpMessage, seq: u64, epoch: &str) -> Result<(), Failure> {
        let project = ProjectRef {
            workspace_id: &call.workspace_id,
            project_id: &call.project_id,
        };
        let pool = match self.pools.pool(project.workspace_id).await {
            Ok(Some(pool)) => pool,
            Ok(None) => return Err(Failure::Gone),
            Err(error) => return Err(Failure::Unavailable(error.to_string())),
        };
        let seq = i64::try_from(seq).unwrap_or(i64::MAX);
        let mut tx = pool.begin().await?;
        tenant::lock(&mut tx, project).await?;
        if let Some((stream, applied)) = tenant::applied(&mut tx, project).await?
            && stream.as_deref() == Some(epoch)
            && seq <= applied
        {
            // Applied before; its acknowledgement got lost.
            return Ok(());
        }
        let now = &call.at;
        let mut types_changed = false;
        let rows = match &call.op {
            ProjectOp::Identify {
                anon_id,
                user_id,
                ts,
            } => {
                tenant::identify(&mut tx, project, anon_id, user_id, ts, now)
                    .await?
                    .1
            }
            ProjectOp::PeopleOps { ops } => {
                tenant::apply_people_ops(&mut tx, project, ops, now).await?
            }
            ProjectOp::GroupOps { ops } => {
                let (_, rows, changed) =
                    tenant::apply_group_ops(&mut tx, project, ops, now).await?;
                types_changed = changed;
                rows
            }
            ProjectOp::EnsureGroupTypes { types } => {
                types_changed = tenant::take_group_types(&mut tx, project, types, now)
                    .await?
                    .1;
                Emitted::default()
            }
            ProjectOp::Warm => Emitted::default(),
        };
        tenant::mark_applied(&mut tx, project, epoch, seq).await?;
        self.rows
            .publish(project.workspace_id, &rows, |n| {
                format!("{}:{seq}:{n}", project.project_id)
            })
            .await
            .map_err(publish_failure)?;
        tx.commit().await?;
        self.sync_lists(
            &pool,
            project,
            types_changed,
            matches!(call.op, ProjectOp::Warm),
        )
        .await;
        Ok(())
    }

    /// Rewrites the collector's lists in Valkey from the tenant tables where
    /// they changed, were asked for or are missing. A failure is logged: the
    /// next call tries again.
    async fn sync_lists(
        &self,
        pool: &PgPool,
        project: ProjectRef<'_>,
        types_changed: bool,
        warm: bool,
    ) {
        let Some(valkey) = &self.valkey else {
            return;
        };
        let synced = async {
            let (erased_missing, types_missing) = if warm {
                (true, true)
            } else {
                valkey.missing(project.project_id).await?
            };
            if !(types_changed || types_missing || erased_missing) {
                return Ok(());
            }
            let mut conn = pool.acquire().await.map_err(db)?;
            if types_changed || types_missing {
                let types = tenant::group_types(&mut conn, project).await.map_err(db)?;
                valkey.set_group_types(project.project_id, &types).await?;
            }
            if erased_missing {
                let ids = tenant::erased_ids(&mut conn, project).await.map_err(db)?;
                valkey.set_erased(project.project_id, &ids).await?;
            }
            Ok::<(), PortError>(())
        }
        .await;
        if let Err(error) = synced {
            tracing::warn!(project = project.project_id, %error, "panel-state: the collector's lists were not refreshed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_consumer_reads_every_workspace_s_calls_and_dead_letters_beside_the_rows() {
        let settings = ApplierSettings::default();
        let spec = spec("PANEL_STATE", &all_operations(), &settings);
        assert_eq!(spec.durable, "panel-state");
        assert_eq!(spec.filter_subject, "panel.ops.v1.>");
        assert_eq!(
            weldsuite_adapters_oss::dead_letter_subject(&spec, "panel.ops.v1.ws_1"),
            "panel-dlq.ops.v1.ws_1"
        );
        let config = consumer_config(&spec, &settings, Start::After(41));
        assert_eq!(
            config.deliver_policy,
            consumer::DeliverPolicy::ByStartSequence { start_sequence: 42 }
        );
        assert_eq!(config.max_deliver, -1);
        // Room for a workspace's calls to wait while the others go on.
        assert_eq!(config.max_ack_pending, 10_000);
        assert_eq!(
            consumer_config(&spec, &settings, Start::All).deliver_policy,
            consumer::DeliverPolicy::All
        );
    }

    #[test]
    fn a_batch_splits_by_workspace_keeping_each_one_s_order() {
        let batch = vec![
            ("panel.ops.v1.ws_a".to_owned(), 1, "a1"),
            ("panel.ops.v1.ws_b".to_owned(), 2, "b1"),
            ("panel.ops.v1.ws_a".to_owned(), 3, "a2"),
            ("panel.ops.v1.ws_c".to_owned(), 4, "c1"),
            ("panel.ops.v1.ws_b".to_owned(), 5, "b2"),
        ];
        assert_eq!(
            by_workspace(batch),
            [
                ("ws_a".to_owned(), BTreeMap::from([(1, "a1"), (3, "a2")])),
                ("ws_b".to_owned(), BTreeMap::from([(2, "b1"), (5, "b2")])),
                ("ws_c".to_owned(), BTreeMap::from([(4, "c1")])),
            ]
        );
    }

    #[test]
    fn only_data_the_database_refuses_is_final() {
        let io = || std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset");
        for passing in [
            sqlx::Error::Io(io()),
            sqlx::Error::PoolTimedOut,
            sqlx::Error::PoolClosed,
            sqlx::Error::WorkerCrashed,
            sqlx::Error::Protocol("unexpected message".to_owned()),
            sqlx::Error::Tls(Box::new(io())),
        ] {
            assert!(!refuses_the_data(&passing), "{passing}");
            assert!(
                matches!(Failure::from(passing), Failure::Unavailable(_)),
                "unavailable"
            );
        }
        for refused in [
            sqlx::Error::Decode("not an integer".into()),
            sqlx::Error::Encode("too long".into()),
        ] {
            assert!(refuses_the_data(&refused), "{refused}");
        }
        assert!(matches!(
            publish_failure(PortError::backend(io())),
            Failure::Unavailable(_)
        ));
        let not_json = serde_json::from_str::<serde_json::Value>("{").expect_err("not json");
        assert!(matches!(
            publish_failure(PortError::Json(not_json)),
            Failure::Refused(_)
        ));
    }

    /// The database's own errors, against a throwaway Postgres
    /// (`WELDSUITE_TEST_DATABASE_URL`): what the data breaks is final, the
    /// rest passes.
    #[tokio::test]
    async fn the_database_s_errors_are_sorted_by_their_class() {
        let Ok(url) = std::env::var("WELDSUITE_TEST_DATABASE_URL") else {
            eprintln!("skipped: WELDSUITE_TEST_DATABASE_URL is not set");
            return;
        };
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("the database");
        let failing = |sql: &'static str| {
            let pool = pool.clone();
            async move {
                let mut tx = pool.begin().await.expect("a transaction");
                sqlx::raw_sql(sql)
                    .execute(&mut *tx)
                    .await
                    .expect_err("an error")
            }
        };
        // 22012 division by zero, 23514 a check, 23505 a duplicate key.
        for sql in [
            "select 1 / 0",
            "create temporary table t (n int check (n > 0)); insert into t values (0)",
            "create temporary table u (n int primary key); insert into u values (1), (1)",
        ] {
            let error = failing(sql).await;
            assert!(refuses_the_data(&error), "{sql}: {error}");
        }
        // 57014 a statement cut off, 42P01 a table not there yet (a tenant
        // not migrated), 40001 a serialization conflict, 08006 a lost
        // connection: the database, not the data.
        for sql in [
            "set local statement_timeout = '10ms'; select pg_sleep(1)",
            "select * from weldsuite_no_such_table",
            "do $$ begin raise exception 'conflict' using errcode = '40001'; end $$",
            "do $$ begin raise exception 'gone' using errcode = '08006'; end $$",
        ] {
            let error = failing(sql).await;
            assert!(!refuses_the_data(&error), "{sql}: {error}");
        }
        pool.close().await;
    }

    #[test]
    fn a_waiting_workspace_keeps_its_calls_in_order_and_backs_off() {
        let t0 = Instant::now();
        let second = Duration::from_secs(1);
        let mut waiting: Waiting<&str> = Waiting::default();
        assert!(waiting.next_due().is_none());
        // ws_a's call 5 failed: it and its later call 7 wait; ws_b goes on.
        let pause = waiting.hold(
            "ws_a".to_owned(),
            BTreeMap::from([(5, "a5"), (7, "a7")]),
            t0,
            second,
            second * 4,
        );
        assert_eq!(pause, second);
        assert_eq!(waiting.next_due(), Some(t0 + second));
        assert!(
            waiting
                .queue("ws_a", BTreeMap::from([(9, "a9"), (7, "a7 again")]))
                .is_none()
        );
        assert_eq!(
            waiting.queue("ws_b", BTreeMap::from([(8, "b8")])),
            Some(BTreeMap::from([(8, "b8")]))
        );
        assert_eq!(waiting.len(), 3);
        let mut held: Vec<&str> = waiting.calls().copied().collect();
        held.sort_unstable();
        assert_eq!(held, ["a5", "a7 again", "a9"]);
        // Not due yet; then due, in stream order.
        let early = waiting.take_due(t0);
        assert!(early.is_empty(), "{early:?}");
        let due = waiting.take_due(t0 + second);
        assert_eq!(
            due,
            [(
                "ws_a".to_owned(),
                BTreeMap::from([(5, "a5"), (7, "a7 again"), (9, "a9")])
            )]
        );
        // Still failing: the pause doubles, up to the cap.
        let mut pauses = Vec::new();
        for _ in 0..4 {
            let calls = waiting.take_due(Instant::now() + second * 10);
            let calls = calls
                .into_iter()
                .next()
                .map_or_else(|| BTreeMap::from([(5, "a5")]), |(_, calls)| calls);
            pauses.push(waiting.hold("ws_a".to_owned(), calls, t0, second, second * 4));
        }
        assert_eq!(pauses, [second * 2, second * 4, second * 4, second * 4]);
        // Through at last.
        waiting.release("ws_a");
        assert_eq!(waiting.len(), 0);
        assert!(waiting.next_due().is_none());
        assert_eq!(
            waiting.queue("ws_a", BTreeMap::from([(11, "a11")])),
            Some(BTreeMap::from([(11, "a11")]))
        );
    }

    /// The tenant pool, out of reach for one workspace while `down` is set.
    struct Flaky {
        pool: sqlx::PgPool,
        workspace: String,
        down: std::sync::atomic::AtomicBool,
        refused: std::sync::atomic::AtomicUsize,
    }

    impl TenantPools for Flaky {
        fn pool<'a>(
            &'a self,
            workspace_id: &'a str,
        ) -> weldsuite_ports::BoxFuture<'a, Result<Option<sqlx::PgPool>, PortError>> {
            use std::sync::atomic::Ordering;
            let answer = if workspace_id == self.workspace && self.down.load(Ordering::SeqCst) {
                self.refused.fetch_add(1, Ordering::SeqCst);
                Err(PortError::backend(std::io::Error::new(
                    std::io::ErrorKind::ConnectionRefused,
                    "the tenant database is down",
                )))
            } else {
                Ok(Some(self.pool.clone()))
            };
            Box::pin(std::future::ready(answer))
        }
    }

    /// Against throwaway Postgres, NATS and Valkey: one workspace's
    /// database is down for a while. Its calls wait in order and none is
    /// dead-lettered; the other workspace's go on meanwhile, and a call whose
    /// data breaks a constraint is dead-lettered at once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[allow(clippy::too_many_lines)] // one scenario, in order
    async fn a_workspace_whose_database_is_down_waits_and_the_others_go_on() {
        use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};

        use async_nats::jetstream::stream;
        use serde_json::{Map, json};
        use weldsuite_panel::PanelProjectState;
        use weldsuite_panel::project_state::PeopleOp;

        use crate::panel_project::TenantProjectState;
        use crate::panel_project::rules::{iso, iso_millis};
        use crate::panel_project::tests::{OnePool, clock};
        use crate::panel_test_support::{ScratchTenant, unique};

        let (Ok(nats), Ok(valkey_url)) = (
            std::env::var("WELDSUITE_TEST_NATS_URL"),
            std::env::var("WELDSUITE_TEST_VALKEY_URL"),
        ) else {
            eprintln!("skipped: WELDSUITE_TEST_NATS_URL and WELDSUITE_TEST_VALKEY_URL are not set");
            return;
        };
        let Some(tenant) = ScratchTenant::new().await else {
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
        let (ws_a, ws_b) = (format!("ws_a{tag}"), format!("ws_b{tag}"));
        let stream_name = format!("TEST_PANEL_STATE_{tag}");
        js.get_or_create_stream(stream::Config {
            name: stream_name.clone(),
            subjects: [&ws_a, &ws_b]
                .iter()
                .flat_map(|ws| {
                    ["ops", "identities", "people", "groups"]
                        .iter()
                        .map(move |table| format!("panel.{table}.v1.{ws}"))
                })
                .collect(),
            duplicate_window: Duration::from_secs(120),
            ..stream::Config::default()
        })
        .await
        .expect("the stream");
        js.get_or_create_stream(weldsuite_adapters_oss::dead_letter_stream_config(
            super::super::panel_writer::DLQ_STREAM,
            DLQ_SUBJECT,
            1,
        ))
        .await
        .expect("the dead letters");
        // A person the database refuses: a broken constraint.
        let refused_user = format!("refused-{tag}");
        let constraint = format!("test_refused_{tag}");
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "alter table panel_people add constraint {constraint} check (user_id <> '{refused_user}')"
        )))
        .execute(&tenant.pool)
        .await
        .expect("a constraint");

        let t0 = iso_millis("2026-11-18T10:00:00.000Z").expect("a time");
        let call = |ws: &str, project: &str, op: PeopleOp| OpMessage {
            workspace_id: ws.to_owned(),
            project_id: project.to_owned(),
            at: iso(t0),
            op: ProjectOp::PeopleOps { ops: vec![op] },
        };
        let set = |user: &str, plan: &str| PeopleOp::Set {
            user_id: user.to_owned(),
            ts: iso(t0),
            props: Map::from_iter([("plan".to_owned(), json!(plan))]),
        };
        let login = |user: &str| PeopleOp::Increment {
            user_id: user.to_owned(),
            ts: iso(t0),
            props: Map::from_iter([("logins".to_owned(), json!(1))]),
        };
        // Interleaved, as the collector publishes them.
        let calls = [
            call(&ws_a, "pnp_a", set("u-1", "free")),
            call(&ws_b, "pnp_b", set("u-1", "free")),
            call(&ws_a, "pnp_a", set("u-1", "pro")),
            call(&ws_b, "pnp_b", set(&refused_user, "free")),
            call(&ws_a, "pnp_a", login("u-1")),
            call(&ws_b, "pnp_b", login("u-1")),
        ];
        for (n, call) in calls.iter().enumerate() {
            js.send_publish(
                call.subject(),
                async_nats::jetstream::message::PublishMessage::build()
                    .payload(serde_json::to_vec(call).expect("json").into())
                    .message_id(format!("{tag}-{n}")),
            )
            .await
            .expect("a publish")
            .await
            .expect("stored");
        }

        let pools = Arc::new(Flaky {
            pool: tenant.pool.clone(),
            workspace: ws_a.clone(),
            down: AtomicBool::new(true),
            refused: AtomicUsize::new(0),
        });
        let applier = Arc::new(StateApplier {
            jetstream: js.clone(),
            stream: stream_name.clone(),
            filter: all_operations(),
            pools: Arc::clone(&pools) as Arc<dyn TenantPools>,
            rows: RowSink::new(Some(
                Arc::new(bus.clone()) as Arc<dyn weldsuite_ports::DynEventBus>
            )),
            valkey: None,
            settings: ApplierSettings {
                batch: 10,
                fetch_wait: Duration::from_millis(300),
                lease_ttl: Duration::from_secs(3),
                retry_after: Duration::from_millis(100),
                max_retry_after: Duration::from_millis(400),
                max_pending: 100,
                concurrency: 4,
            },
        });
        let lease = ValkeyLease::new(
            weldsuite_adapters_oss::connect_valkey(&valkey_url)
                .await
                .expect("valkey"),
            format!("test:lease:panel-state:{tag}"),
            "pod-a",
            Duration::from_secs(3),
        );
        let (stop, stopping) = watch::channel(false);
        let task = applier.spawn(lease, &stopping);

        let reader = TenantProjectState {
            pools: Arc::new(OnePool(tenant.pool.clone())),
            rows: RowSink::new(None),
            valkey: None,
            clock: clock(&Arc::new(AtomicI64::new(t0))),
        };
        let a = ProjectRef {
            workspace_id: &ws_a,
            project_id: "pnp_a",
        };
        let b = ProjectRef {
            workspace_id: &ws_b,
            project_id: "pnp_b",
        };
        let logins = |person: Option<weldsuite_panel::project_state::Person>| {
            person.and_then(|person| person.properties["logins"].as_i64())
        };
        let dead_letters = |ws: String| {
            let js = js.clone();
            async move {
                js.get_stream(super::super::panel_writer::DLQ_STREAM)
                    .await
                    .expect("the dead letters")
                    .info_with_subjects(format!("{DLQ_SUBJECT}.ops.v1.{ws}"))
                    .await
                    .expect("their subjects")
                    .filter_map(|subject| std::future::ready(subject.ok()))
                    .map(|(_, count)| count)
                    .collect::<Vec<usize>>()
                    .await
                    .iter()
                    .sum::<usize>()
            }
        };

        // ws_b goes on past the refused call while ws_a's database is down.
        let mut b_logins = None;
        for _ in 0..120 {
            b_logins = logins(reader.get_person(b, "u-1").await.expect("a person"));
            if b_logins.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(b_logins, Some(1));
        assert_eq!(dead_letters(ws_b.clone()).await, 1, "the refused call");
        // ws_a was tried again and again, and nothing of it was applied or
        // dead-lettered.
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert!(pools.refused.load(Ordering::SeqCst) >= 3);
        assert!(
            reader
                .get_person(a, "u-1")
                .await
                .expect("a person")
                .is_none()
        );
        assert_eq!(dead_letters(ws_a.clone()).await, 0);

        // Its database is back: its calls apply, in order, each once.
        pools.down.store(false, Ordering::SeqCst);
        let mut person = None;
        for _ in 0..120 {
            person = reader.get_person(a, "u-1").await.expect("a person");
            if logins(person.clone()).is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let person = person.expect("ws_a's person");
        assert_eq!(person.properties["plan"], "pro", "the later set wins");
        assert_eq!(person.properties["logins"], 1);
        assert_eq!(dead_letters(ws_a.clone()).await, 0);

        stop.send(true).expect("stop");
        task.await.expect("the applier");
        let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "alter table panel_people drop constraint if exists {constraint}"
        )))
        .execute(&tenant.pool)
        .await;
        let _ = js.delete_stream(&stream_name).await;
        tenant.finish().await;
    }

    /// Against throwaway Postgres, NATS and Valkey: the collector's calls,
    /// a cold cache filled, a warm one answering at once, a call applied
    /// once however often it comes, and a bad message dead-lettered.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[allow(clippy::too_many_lines)] // one scenario, in order
    async fn applies_the_collector_s_calls_in_order_and_once() {
        use std::sync::atomic::AtomicI64;

        use async_nats::jetstream::stream;
        use serde_json::{Map, json};
        use weldsuite_panel::PanelProjectState;
        use weldsuite_panel::project_state::{
            GroupOp, GroupOpsInput, IdentifyInput, LiveTouch, PeopleOp, PeopleOpsInput,
        };

        use crate::panel_project::rules::{iso, iso_millis};
        use crate::panel_project::tests::{OnePool, clock, scratch_valkey};
        use crate::panel_project::{CollectorProjectState, TenantProjectState};
        use crate::panel_test_support::{ScratchTenant, unique};

        let (Ok(nats), Ok(valkey_url)) = (
            std::env::var("WELDSUITE_TEST_NATS_URL"),
            std::env::var("WELDSUITE_TEST_VALKEY_URL"),
        ) else {
            eprintln!("skipped: WELDSUITE_TEST_NATS_URL and WELDSUITE_TEST_VALKEY_URL are not set");
            return;
        };
        let Some(valkey) = scratch_valkey().await else {
            return;
        };
        let Some(tenant) = ScratchTenant::new().await else {
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
        let ws = format!("ws_{tag}");
        let stream_name = format!("TEST_PANEL_STATE_{tag}");
        js.get_or_create_stream(stream::Config {
            name: stream_name.clone(),
            subjects: ["ops", "identities", "people", "groups"]
                .iter()
                .map(|table| format!("panel.{table}.v1.{ws}"))
                .collect(),
            duplicate_window: Duration::from_secs(120),
            ..stream::Config::default()
        })
        .await
        .expect("the stream");
        js.get_or_create_stream(weldsuite_adapters_oss::dead_letter_stream_config(
            super::super::panel_writer::DLQ_STREAM,
            DLQ_SUBJECT,
            1,
        ))
        .await
        .expect("the dead letters");

        let t0 = iso_millis("2026-11-18T10:00:00.000Z").expect("a time");
        let now = Arc::new(AtomicI64::new(t0));
        let shared_bus: Arc<dyn weldsuite_ports::DynEventBus> = Arc::new(bus.clone());
        let collector = CollectorProjectState {
            bus: Arc::clone(&shared_bus),
            valkey: valkey.clone(),
            clock: clock(&now),
        };
        let reader = TenantProjectState {
            pools: Arc::new(OnePool(tenant.pool.clone())),
            rows: RowSink::new(None),
            valkey: Some(valkey.clone()),
            clock: clock(&now),
        };
        let p = ProjectRef {
            workspace_id: &ws,
            project_id: "pnp_1",
        };

        // The calls, before anything applies them.
        let identify = IdentifyInput {
            workspace_id: ws.clone(),
            project_id: "pnp_1".into(),
            anon_id: "a-1".into(),
            user_id: "u-1".into(),
            ts: iso(t0),
        };
        assert!(
            collector
                .identify(p, &identify)
                .await
                .expect("queued")
                .linked
        );
        let people = PeopleOpsInput {
            workspace_id: ws.clone(),
            project_id: "pnp_1".into(),
            ops: vec![PeopleOp::Set {
                user_id: "u-1".into(),
                ts: iso(t0),
                props: Map::from_iter([("$email".to_owned(), json!("Ann@Example.com"))]),
            }],
        };
        collector
            .apply_people_ops(p, &people)
            .await
            .expect("queued");
        let groups = GroupOpsInput {
            workspace_id: ws.clone(),
            project_id: "pnp_1".into(),
            ops: vec![GroupOp::Set {
                group_type: "company".into(),
                group_key: "acme".into(),
                props: Map::from_iter([("plan".to_owned(), json!("pro"))]),
            }],
        };
        // Nothing cached yet: the types can't be known; the operation is queued.
        assert!(collector.apply_group_ops(p, &groups).await.is_err());
        let touch = LiveTouch {
            session_id: "s-1".into(),
            distinct_id: "a-1".into(),
            path: "/".into(),
            title: None,
            country: None,
            device_type: None,
            ts: iso(t0),
        };
        collector.touch_live(p, &[touch]).await.expect("touched");
        // A message that is no call, with an id of its own as the collector's
        // have: the dead letters are deduplicated on it.
        js.send_publish(
            format!("panel.ops.v1.{ws}"),
            async_nats::jetstream::message::PublishMessage::build()
                .payload("not json".into())
                .message_id(format!("{tag}-not-json")),
        )
        .await
        .expect("a publish")
        .await
        .expect("stored");

        let applier = Arc::new(StateApplier {
            jetstream: js.clone(),
            stream: stream_name.clone(),
            filter: format!("panel.ops.v1.{ws}"),
            pools: Arc::new(OnePool(tenant.pool.clone())),
            rows: RowSink::new(Some(Arc::clone(&shared_bus))),
            valkey: Some(valkey.clone()),
            settings: ApplierSettings {
                batch: 10,
                fetch_wait: Duration::from_millis(300),
                lease_ttl: Duration::from_secs(3),
                retry_after: Duration::from_millis(50),
                max_retry_after: Duration::from_millis(200),
                max_pending: 100,
                concurrency: 4,
            },
        });
        let connection = weldsuite_adapters_oss::connect_valkey(&valkey_url)
            .await
            .expect("valkey");
        let lease = ValkeyLease::new(
            connection,
            format!("test:lease:panel-state:{tag}"),
            "pod-a",
            Duration::from_secs(3),
        );
        let (stop, stopping) = watch::channel(false);
        let task = applier.spawn(lease, &stopping);

        let mut filled = None;
        for _ in 0..120 {
            filled = valkey.group_types("pnp_1").await.expect("valkey");
            if filled.is_some()
                && reader
                    .get_person(p, "a-1")
                    .await
                    .expect("a person")
                    .is_some()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        assert_eq!(filled.as_deref(), Some(&["company".to_owned()][..]));
        let person = reader
            .get_person(p, "a-1")
            .await
            .expect("a person")
            .expect("found");
        assert_eq!(person.email.as_deref(), Some("ann@example.com"));
        let acme = reader
            .get_group(p, "company", "acme")
            .await
            .expect("a group")
            .expect("found");
        assert_eq!(acme.properties["plan"], "pro");

        // Warm now: a new type takes its slot at once, and the tenant follows.
        let types = collector
            .ensure_group_types(p, &["team".to_owned(), "Bad".to_owned()])
            .await
            .expect("the types");
        assert_eq!(types, ["company", "team"]);
        let mut taken = Vec::new();
        for _ in 0..120 {
            taken = reader.group_types(p).await.expect("types");
            if taken.len() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        assert_eq!(taken, ["company", "team"]);
        stop.send(true).expect("stop");
        task.await.expect("the applier");

        // The rows the object would have written, on their tables' subjects.
        let counts: std::collections::BTreeMap<String, usize> = js
            .get_stream(&stream_name)
            .await
            .expect("the stream")
            .info_with_subjects(format!("panel.*.v1.{ws}"))
            .await
            .expect("its subjects")
            .filter_map(|subject| std::future::ready(subject.ok()))
            .collect()
            .await;
        let count = |table: &str| {
            counts
                .get(&format!("panel.{table}.v1.{ws}"))
                .copied()
                .unwrap_or(0)
        };
        assert_eq!(count("identities"), 1, "{counts:?}");
        assert_eq!(
            count("people"),
            2,
            "the new person, then the email: {counts:?}"
        );
        assert_eq!(count("groups"), 1, "{counts:?}");
        let dead: usize = js
            .get_stream(super::super::panel_writer::DLQ_STREAM)
            .await
            .expect("the dead letters")
            .info_with_subjects(format!("{DLQ_SUBJECT}.ops.v1.{ws}"))
            .await
            .expect("their subjects")
            .filter_map(|subject| std::future::ready(subject.ok()))
            .map(|(_, count)| count)
            .collect::<Vec<usize>>()
            .await
            .iter()
            .sum();
        assert_eq!(dead, 1);

        // A call delivered twice applies once; after the stream is made anew
        // (another epoch) the same sequence is a new call.
        let increment = OpMessage {
            workspace_id: ws.clone(),
            project_id: "pnp_1".into(),
            at: iso(t0 + 1_000),
            op: ProjectOp::PeopleOps {
                ops: vec![PeopleOp::Increment {
                    user_id: "u-1".into(),
                    ts: iso(t0),
                    props: Map::from_iter([("logins".to_owned(), json!(1))]),
                }],
            },
        };
        for epoch in ["epoch-a", "epoch-a", "epoch-b"] {
            assert!(applier.apply(&increment, 1_000_000, epoch).await.is_ok());
        }
        let person = reader
            .get_person(p, "u-1")
            .await
            .expect("a person")
            .expect("found");
        assert_eq!(person.properties["logins"], 2);
        assert_eq!(person.last_seen, iso(t0 + 1_000), "the collector's time");
        let _ = js.delete_stream(&stream_name).await;
        tenant.finish().await;
    }
}
