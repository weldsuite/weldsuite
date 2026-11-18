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
//! - **Failures.** A call is tried `attempts` times with a doubling pause,
//!   then dead-lettered to `PANEL_DLQ` (`panel-dlq.ops.v1.<ws>`), as is a
//!   message that is not an operation. A deleted workspace's calls are
//!   dropped.
//! - **The collector's lists.** After a call, the project's group types and
//!   erased ids in Valkey (`crate::panel_project::valkey`) are rewritten
//!   from the tenant tables when the types changed, when the collector asked
//!   (`warm`), or when either list is missing.

use std::sync::Arc;
use std::time::Duration;

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
    /// Tries per call before it is dead-lettered.
    pub(crate) attempts: u32,
    /// The pause before the first retry; doubled after each.
    pub(crate) retry_after: Duration,
    /// Workspaces applied at once.
    pub(crate) concurrency: usize,
}

impl Default for ApplierSettings {
    fn default() -> Self {
        Self {
            batch: 256,
            fetch_wait: Duration::from_secs(5),
            lease_ttl: Duration::from_secs(30),
            attempts: 5,
            retry_after: Duration::from_secs(1),
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
        // A batch's retries take well under a minute; kept alive by
        // progress acknowledgements besides.
        ack_wait: Duration::from_mins(5),
        batch_size: settings.batch,
        batch_wait: settings.fetch_wait,
        workers: 1,
        dead_letter_subject: DLQ_SUBJECT.to_owned(),
        dedupe_capacity: 0,
    }
}

/// The consumer a session recreates: from `start`, never giving a message
/// up on the server's count.
pub(crate) fn consumer_config(spec: &ConsumerSpec, start: Start) -> consumer::pull::Config {
    let mut config = spec.config();
    config.deliver_policy = match start {
        Start::All => consumer::DeliverPolicy::All,
        Start::After(seq) => consumer::DeliverPolicy::ByStartSequence {
            start_sequence: seq + 1,
        },
    };
    config.max_deliver = -1;
    config
}

/// What became of one call.
#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    /// Applied, or applied before, or its workspace is gone.
    Done,
    /// Never to apply (not an operation): a dead letter.
    Bad(String),
    /// Failed every try: a dead letter.
    GaveUp(String),
}

/// Why one try failed.
enum Failure {
    /// The workspace is gone: nothing to apply to.
    Gone,
    Retry(String),
}

fn retry(error: impl std::fmt::Display) -> Failure {
    Failure::Retry(error.to_string())
}

/// The messages by workspace (the subject's last token), each workspace's
/// in stream order.
fn by_workspace<M>(messages: Vec<(String, u64, M)>) -> Vec<Vec<(u64, M)>> {
    let mut groups: Vec<(String, Vec<(u64, M)>)> = Vec::new();
    for (subject, seq, message) in messages {
        let workspace = subject.rsplit('.').next().unwrap_or_default().to_owned();
        match groups.iter_mut().find(|(known, _)| *known == workspace) {
            Some((_, group)) => group.push((seq, message)),
            None => groups.push((workspace, vec![(seq, message)])),
        }
    }
    groups.into_iter().map(|(_, group)| group).collect()
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
            .create_consumer(consumer_config(spec, start(floor, last)))
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
        let mut expected_delivery = 1_u64;
        loop {
            if *lost.borrow() {
                return Err("the lease was lost".to_owned());
            }
            if *stop.borrow() {
                return Ok(());
            }
            let messages = fetch(&consumer, self.settings.batch, self.settings.fetch_wait)
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
            let outcomes: Vec<Result<(), String>> =
                futures_util::stream::iter(by_workspace(ordered))
                    .map(|group| self.apply_group(&spec, &epoch, group))
                    .buffer_unordered(self.settings.concurrency.max(1))
                    .collect()
                    .await;
            if let Some(Err(reason)) = outcomes.into_iter().find(Result::is_err) {
                return Err(reason);
            }
            if gap {
                // Applied so far in order; the missing delivery comes again
                // after the floor.
                return Err("a delivery was skipped".to_owned());
            }
        }
    }

    /// One workspace's messages, in order. Fails (the session restarts)
    /// only when a dead letter can't be stored; what follows it in this
    /// workspace stays unacknowledged.
    async fn apply_group(
        &self,
        spec: &ConsumerSpec,
        epoch: &str,
        group: Vec<(u64, jetstream::Message)>,
    ) -> Result<(), String> {
        for (seq, message) in group {
            match self.apply_message(&message, seq, epoch).await {
                Outcome::Done => {
                    let _ = message.ack().await;
                    metrics::counter!(CONSUMER_MESSAGES_METRIC, "consumer" => DURABLE, "outcome" => "ok")
                        .increment(1);
                }
                Outcome::Bad(reason) | Outcome::GaveUp(reason) => {
                    publish_dead_letter(&self.jetstream, spec, &message, &reason)
                        .await
                        .map_err(|error| format!("a dead letter could not be stored: {error}"))?;
                    tracing::warn!(reason, subject = %message.subject, "panel-state: dead-lettered a call");
                    let _ = message.ack_with(AckKind::Term).await;
                    metrics::counter!(CONSUMER_MESSAGES_METRIC, "consumer" => DURABLE, "outcome" => "error")
                        .increment(1);
                }
            }
        }
        Ok(())
    }

    async fn apply_message(&self, message: &jetstream::Message, seq: u64, epoch: &str) -> Outcome {
        let call: OpMessage = match serde_json::from_slice(&message.payload) {
            Ok(call) => call,
            Err(error) => return Outcome::Bad(format!("not a PanelProject call: {error}")),
        };
        if let Some(problem) = call.problem(message.subject.as_str()) {
            return Outcome::Bad(problem);
        }
        let attempts = self.settings.attempts.max(1);
        let mut wait = self.settings.retry_after;
        for attempt in 1..=attempts {
            match self.apply(&call, seq, epoch).await {
                Ok(()) => return Outcome::Done,
                Err(Failure::Gone) => {
                    tracing::info!(
                        workspace = call.workspace_id,
                        "panel-state: the workspace is gone; its call is dropped"
                    );
                    return Outcome::Done;
                }
                Err(Failure::Retry(reason)) if attempt == attempts => {
                    return Outcome::GaveUp(reason);
                }
                Err(Failure::Retry(reason)) => {
                    tracing::warn!(
                        workspace = call.workspace_id,
                        attempt,
                        reason,
                        "panel-state: a call failed; trying again"
                    );
                    let _ = message.ack_with(AckKind::Progress).await;
                    tokio::time::sleep(wait).await;
                    wait *= 2;
                }
            }
        }
        Outcome::GaveUp("no attempt".to_owned())
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
            Err(error) => return Err(retry(error)),
        };
        let seq = i64::try_from(seq).unwrap_or(i64::MAX);
        let mut tx = pool.begin().await.map_err(retry)?;
        tenant::lock(&mut tx, project).await.map_err(retry)?;
        if let Some((stream, applied)) = tenant::applied(&mut tx, project).await.map_err(retry)?
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
                    .await
                    .map_err(retry)?
                    .1
            }
            ProjectOp::PeopleOps { ops } => tenant::apply_people_ops(&mut tx, project, ops, now)
                .await
                .map_err(retry)?,
            ProjectOp::GroupOps { ops } => {
                let (_, rows, changed) = tenant::apply_group_ops(&mut tx, project, ops, now)
                    .await
                    .map_err(retry)?;
                types_changed = changed;
                rows
            }
            ProjectOp::EnsureGroupTypes { types } => {
                types_changed = tenant::take_group_types(&mut tx, project, types, now)
                    .await
                    .map_err(retry)?
                    .1;
                Emitted::default()
            }
            ProjectOp::Warm => Emitted::default(),
        };
        tenant::mark_applied(&mut tx, project, epoch, seq)
            .await
            .map_err(retry)?;
        self.rows
            .publish(project.workspace_id, &rows, |n| {
                format!("{}:{seq}:{n}", project.project_id)
            })
            .await
            .map_err(retry)?;
        tx.commit().await.map_err(retry)?;
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
        let config = consumer_config(&spec, Start::After(41));
        assert_eq!(
            config.deliver_policy,
            consumer::DeliverPolicy::ByStartSequence { start_sequence: 42 }
        );
        assert_eq!(config.max_deliver, -1);
        assert_eq!(
            consumer_config(&spec, Start::All).deliver_policy,
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
                vec![(1, "a1"), (3, "a2")],
                vec![(2, "b1"), (5, "b2")],
                vec![(4, "c1")],
            ]
        );
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
                attempts: 2,
                retry_after: Duration::from_millis(50),
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
