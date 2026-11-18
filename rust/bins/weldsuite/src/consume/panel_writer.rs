//! The `panel-writer` subscriber (ADR EVT-019): WeldPanel's rows from NATS
//! into the five Iceberg tables.
//!
//! - **Feeds.** `PANEL_EVENTS` (`panel.events.v1.<ws>`, the collector's
//!   `events_v1` rows) feeds `events_v1`; `PANEL_STATE` feeds the other four
//!   tables, one subject each (`panel.identities.v1`, `panel.people.v1`,
//!   `panel.groups.v1`, `panel.replays.v1` → `replay_chunks_v1`). Each table
//!   has its own durable consumer (`panel-writer-<table>`), lease and stream
//!   sequence.
//! - **Batching.** Rows are buffered as Arrow batches and committed at
//!   `PANEL_WRITER_FLUSH_BYTES` of messages (64 MB) or when the oldest is
//!   `PANEL_WRITER_FLUSH_SECONDS` old (5 minutes), whichever comes first:
//!   every buffered partition in one fast append. Messages are acknowledged
//!   only after the commit.
//! - **Exactly once per table.** Each commit records the last stream
//!   sequence it holds (`weldsuite.stream-seq`). A session starts by
//!   reading it and recreating the table's consumer to start right after it,
//!   so whatever a previous writer buffered and didn't commit comes again,
//!   in stream order, and nothing committed comes twice. The commit is
//!   fenced on that sequence ([`Lakehouse::append_after`]).
//! - **One writer per table.** A lease in Valkey (`ValkeyLease`); the other
//!   replicas stand by and try again every third of its time to live.
//! - **Bad rows** (not JSON, not an object, a column of the wrong type) go
//!   to `PANEL_DLQ` (`panel-dlq.<table>.v1.<ws>`) and are terminated.
//!
//! Why not `run_consumer`: it acknowledges a batch when its handler returns
//! and runs batches side by side, while the sequence high-water mark needs
//! the messages in stream order and held across batches until a commit. So
//! this loop fetches one batch at a time, never gives up a delivery it
//! fetched (a cancelled fetch would come back later, out of order), and
//! restarts the session (consumer recreated from the table's sequence) on
//! anything that breaks the order: a skipped delivery, a dead letter that
//! couldn't be stored, a commit another writer fenced off.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_nats::jetstream::{self, AckKind, consumer};
use futures_util::StreamExt;
use serde_json::Value;
use tokio::sync::watch;
use weldsuite_adapters_oss::{
    CONSUMER_MESSAGES_METRIC, ConsumerSpec, ValkeyLease, publish_dead_letter,
};
use weldsuite_lakehouse::{
    Lakehouse, LakehouseError, PanelTable, RecordBatch, check_row, rows_to_batch,
};
use weldsuite_ports::BoxFuture;

use crate::panel_store::PanelStreams;

/// Where bad rows go: `PANEL_DLQ`, subjects `panel-dlq.<table>.v1.<ws>`.
pub(crate) const DLQ_STREAM: &str = "PANEL_DLQ";
pub(crate) const DLQ_SUBJECT: &str = "panel-dlq";

/// Rows committed, by table.
const ROWS_METRIC: &str = "weldsuite_panel_writer_rows_total";
/// Commits by table and outcome (`ok`, `failed`, `fenced`).
const COMMITS_METRIC: &str = "weldsuite_panel_writer_commits_total";

/// How the writer batches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WriterSettings {
    /// Flush at this many bytes of buffered messages.
    pub(crate) flush_bytes: usize,
    /// Flush when the oldest buffered message is this old.
    pub(crate) flush_after: Duration,
    /// Messages held unacknowledged at most (the consumer's
    /// `max_ack_pending`); a buffer this full is flushed.
    pub(crate) max_pending: usize,
    /// Messages per fetch.
    pub(crate) fetch_batch: usize,
    /// How long a fetch waits for messages.
    pub(crate) fetch_wait: Duration,
    /// The lease's time to live; renewed every third of it.
    pub(crate) lease_ttl: Duration,
}

impl Default for WriterSettings {
    fn default() -> Self {
        Self {
            flush_bytes: 64 * 1024 * 1024,
            flush_after: Duration::from_mins(5),
            max_pending: 200_000,
            fetch_batch: 1_000,
            fetch_wait: Duration::from_secs(5),
            lease_ttl: Duration::from_secs(30),
        }
    }
}

/// One table's feed: the stream and the subjects its rows come on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Feed {
    pub(crate) table: PanelTable,
    pub(crate) stream: String,
    pub(crate) subject: String,
}

/// The five feeds.
pub(crate) fn feeds(streams: &PanelStreams) -> Vec<Feed> {
    let state = |table, prefix: &str| Feed {
        table,
        stream: streams.state.clone(),
        subject: format!("{prefix}.>"),
    };
    vec![
        Feed {
            table: PanelTable::Events,
            stream: streams.events.clone(),
            subject: format!("{}.>", streams.events_subject),
        },
        state(PanelTable::Identities, "panel.identities.v1"),
        state(PanelTable::People, "panel.people.v1"),
        state(PanelTable::Groups, "panel.groups.v1"),
        // The collector's `POST /r` publishes here (`BusSink::replay_chunks`).
        state(
            PanelTable::ReplayChunks,
            weldsuite_adapters_oss::PANEL_REPLAYS_SUBJECT,
        ),
    ]
}

/// The feed's consumer: `panel-writer-<table>` (`events`, `identities`, …).
pub(crate) fn spec(feed: &Feed, settings: &WriterSettings) -> ConsumerSpec {
    let short = feed.table.name().trim_end_matches("_v1");
    ConsumerSpec {
        stream: feed.stream.clone(),
        durable: format!("panel-writer-{short}"),
        description: format!(
            "WeldSuite panel-writer: {} into panel.{} (EVT-019)",
            feed.subject,
            feed.table.name()
        ),
        filter_subject: feed.subject.clone(),
        deliver_new_only: false,
        max_retries: 0,
        max_deferrals: 0,
        retry_backoff: Vec::new(),
        // Held until the commit: well past a flush, kept alive by progress
        // acknowledgements besides.
        ack_wait: settings.flush_after * 2 + Duration::from_secs(60),
        batch_size: settings.fetch_batch,
        batch_wait: settings.fetch_wait,
        workers: 1,
        dead_letter_subject: DLQ_SUBJECT.to_owned(),
        dedupe_capacity: 0,
    }
}

/// Where a session's consumer starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Start {
    /// The stream's oldest message: nothing committed yet, or the stream
    /// was made anew (its sequences are below the table's).
    All,
    /// Right after this sequence, the table's last.
    After(u64),
}

/// Where to start for a table at `committed`, on a stream whose last
/// sequence is `last_in_stream`.
pub(crate) fn start(committed: Option<u64>, last_in_stream: u64) -> Start {
    match committed {
        Some(seq) if seq <= last_in_stream => Start::After(seq),
        _ => Start::All,
    }
}

/// The consumer a session recreates: the spec's, from `start`, with no
/// delivery limit (nothing is ever given up on the server's count) and room
/// for a whole buffer unacknowledged.
pub(crate) fn consumer_config(
    spec: &ConsumerSpec,
    settings: &WriterSettings,
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
    config.max_ack_pending = i64::try_from(settings.max_pending).unwrap_or(i64::MAX);
    config
}

/// What a delivery is to the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Arrival {
    /// At or below the table's sequence: committed already.
    Committed,
    /// Already in the buffer (its acknowledgement was lost and it came
    /// again).
    Buffered,
    /// A row to buffer.
    New,
    /// A delivery was skipped (consumer sequence `expected`, got a later
    /// one): the order is broken, restart.
    Gap,
}

/// Sorts a delivery (`stream_seq`, `delivery_seq`) given the table's
/// sequence (`floor`), the last buffered sequence and the delivery sequence
/// expected next. A delivery sequence below the expected one is a
/// redelivery; above it, a delivery that never arrived.
pub(crate) fn arrival(
    stream_seq: u64,
    delivery_seq: u64,
    floor: Option<u64>,
    last_buffered: Option<u64>,
    expected_delivery: u64,
) -> Arrival {
    if delivery_seq > expected_delivery {
        return Arrival::Gap;
    }
    if floor.is_some_and(|floor| stream_seq <= floor) {
        return Arrival::Committed;
    }
    if last_buffered.is_some_and(|last| stream_seq <= last) {
        return Arrival::Buffered;
    }
    Arrival::New
}

/// A hook on the rows a commit wrote, run after the table's commit and
/// before the acknowledgement. It must be idempotent, must not hold the
/// table up for one workspace's failure, and must cope with a missed call:
/// a crash between the commit and the call leaves the rows committed, and
/// the next session skips them.
///
/// The tenant state (what the `PanelProject` Durable Object holds on
/// Global) is not kept here: the `identities_v1`, `people_v1` and
/// `groups_v1` rows are what applying the collector's calls writes, so the
/// calls are applied first, by the `panel-state` subscriber
/// (`super::panel_state`), and these tables only receive its rows.
pub(crate) trait TenantState: Send + Sync {
    /// Whether rows of `table` go to it (the writer then keeps them as JSON
    /// beside the Arrow batch).
    fn wants(&self, table: PanelTable) -> bool;
    /// The rows of one commit.
    fn committed<'a>(&'a self, table: PanelTable, rows: &'a [Value]) -> BoxFuture<'a, ()>;
}

/// The tables only.
pub(crate) struct NoTenantState;

impl TenantState for NoTenantState {
    fn wants(&self, _table: PanelTable) -> bool {
        false
    }

    fn committed<'a>(&'a self, _table: PanelTable, _rows: &'a [Value]) -> BoxFuture<'a, ()> {
        Box::pin(std::future::ready(()))
    }
}

/// What a table's writer holds until a commit.
#[derive(Default)]
struct Buffer {
    /// By stream sequence: acknowledged after the commit.
    messages: BTreeMap<u64, jetstream::Message>,
    batches: Vec<RecordBatch>,
    /// The rows as JSON, for [`TenantState`] (only when it wants them).
    rows: Vec<Value>,
    bytes: usize,
    since: Option<Instant>,
}

impl Buffer {
    fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    fn last_seq(&self) -> Option<u64> {
        self.messages.keys().next_back().copied()
    }

    /// Whether to commit now.
    fn due(&self, settings: &WriterSettings, now: Instant) -> bool {
        flush_due(self.messages.len(), self.bytes, self.since, settings, now)
    }

    fn clear(&mut self) {
        *self = Self::default();
    }
}

/// Whether a buffer of `messages` (`bytes` of them, the oldest from
/// `since`) is due: at its size, at its age, or when another fetch would
/// pass the unacknowledged limit.
pub(crate) fn flush_due(
    messages: usize,
    bytes: usize,
    since: Option<Instant>,
    settings: &WriterSettings,
    now: Instant,
) -> bool {
    messages > 0
        && (bytes >= settings.flush_bytes
            || since.is_some_and(|since| now.duration_since(since) >= settings.flush_after)
            || messages + settings.fetch_batch > settings.max_pending)
}

/// Why a session ended early.
#[derive(Debug)]
enum SessionEnd {
    /// Start over (the lease, the order, another writer); the reason.
    Restart(String),
    /// The store or NATS failed.
    Failed(String),
}

impl std::fmt::Display for SessionEnd {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Restart(reason) => write!(f, "restarting: {reason}"),
            Self::Failed(reason) => write!(f, "failed: {reason}"),
        }
    }
}

impl From<LakehouseError> for SessionEnd {
    fn from(error: LakehouseError) -> Self {
        match error {
            LakehouseError::Conflict(reason) => Self::Restart(reason),
            other => Self::Failed(other.to_string()),
        }
    }
}

/// The writer of all five tables in this process.
pub(crate) struct PanelWriter {
    pub(crate) lake: Lakehouse,
    pub(crate) jetstream: jetstream::Context,
    pub(crate) settings: WriterSettings,
    pub(crate) tenant_state: Arc<dyn TenantState>,
}

impl PanelWriter {
    /// One task per feed, each holding its lease while it writes, until
    /// `stop`.
    pub(crate) fn spawn(
        self: &Arc<Self>,
        feeds: Vec<(Feed, ValkeyLease)>,
        stop: &watch::Receiver<bool>,
    ) -> Vec<tokio::task::JoinHandle<()>> {
        feeds
            .into_iter()
            .map(|(feed, lease)| {
                tokio::spawn(Arc::clone(self).run_table(feed, lease, stop.clone()))
            })
            .collect()
    }

    async fn run_table(
        self: Arc<Self>,
        feed: Feed,
        lease: ValkeyLease,
        mut stop: watch::Receiver<bool>,
    ) {
        let table = feed.table.name();
        let standby = (self.settings.lease_ttl / 3).max(Duration::from_secs(1));
        loop {
            if *stop.borrow() {
                return;
            }
            match lease.try_acquire().await {
                Ok(true) => {
                    tracing::info!(table, lease = lease.key(), "panel-writer: writing");
                    match self.session(&feed, &lease, &stop).await {
                        Ok(()) => {}
                        Err(SessionEnd::Restart(reason)) => {
                            tracing::warn!(table, reason, "panel-writer: starting over");
                        }
                        Err(SessionEnd::Failed(reason)) => {
                            tracing::error!(table, reason, "panel-writer: session failed");
                        }
                    }
                    if let Err(error) = lease.release().await {
                        tracing::warn!(table, %error, "panel-writer: could not give the lease back");
                    }
                }
                Ok(false) => {}
                Err(error) => {
                    tracing::warn!(table, %error, "panel-writer: the lease is out of reach");
                }
            }
            tokio::select! {
                () = tokio::time::sleep(standby) => {}
                _ = stop.wait_for(|stopping| *stopping) => return,
            }
        }
    }

    /// Recreates the feed's consumer to start right after the table's
    /// sequence. Returns it and the sequence below which deliveries are
    /// committed already.
    async fn reset_consumer(
        &self,
        spec: &ConsumerSpec,
        committed: Option<u64>,
    ) -> Result<(consumer::PullConsumer, Option<u64>), SessionEnd> {
        let failed = |error: &dyn std::fmt::Display| SessionEnd::Failed(error.to_string());
        let mut stream = self
            .jetstream
            .get_stream(&spec.stream)
            .await
            .map_err(|error| failed(&error))?;
        let last = stream
            .info()
            .await
            .map_err(|error| failed(&error))?
            .state
            .last_sequence;
        let start = start(committed, last);
        if committed.is_some() && start == Start::All {
            tracing::warn!(
                stream = spec.stream,
                committed,
                last,
                "panel-writer: the stream is behind the table (made anew?); reading it from the start"
            );
        }
        // Gone already is fine: the first session, or another pod's reset.
        if let Err(error) = stream.delete_consumer(&spec.durable).await {
            tracing::debug!(consumer = spec.durable, %error, "panel-writer: no consumer to delete");
        }
        let consumer = stream
            .create_consumer(consumer_config(spec, &self.settings, start))
            .await
            .map_err(|error| failed(&error))?;
        let floor = match start {
            Start::After(seq) => Some(seq),
            Start::All => None,
        };
        Ok((consumer, floor))
    }

    #[allow(
        clippy::too_many_lines,
        reason = "one session's loop: fetch, sort, flush, keep alive"
    )]
    async fn session(
        &self,
        feed: &Feed,
        lease: &ValkeyLease,
        stop: &watch::Receiver<bool>,
    ) -> Result<(), SessionEnd> {
        let table = feed.table;
        let (lost_tx, lost) = watch::channel(false);
        let renewer = tokio::spawn(keep_lease(
            lease.clone(),
            self.settings.lease_ttl / 3,
            lost_tx,
        ));
        let _renewer = AbortOnDrop(renewer);

        let mut committed = self.lake.last_stream_seq(table).await?;
        let schema = self.lake.arrow_schema(table).await?;
        let spec = spec(feed, &self.settings);
        let (consumer, mut floor) = self.reset_consumer(&spec, committed).await?;
        let progress_every = (spec.ack_wait / 3).max(Duration::from_secs(1));
        let mut last_progress = Instant::now();
        let mut buffer = Buffer::default();
        let mut expected_delivery = 1_u64;
        let mut failures = 0_u32;
        let mut retry_at: Option<Instant> = None;
        loop {
            if *lost.borrow() {
                return Err(SessionEnd::Restart("the lease was lost".to_owned()));
            }
            if *stop.borrow() {
                if !buffer.is_empty() {
                    self.flush(table, lease, &mut buffer, &mut committed)
                        .await?;
                }
                return Ok(());
            }
            let now = Instant::now();
            if buffer.due(&self.settings, now) && retry_at.is_none_or(|at| at <= now) {
                match self.flush(table, lease, &mut buffer, &mut committed).await {
                    Ok(()) => {
                        floor = committed;
                        failures = 0;
                        retry_at = None;
                    }
                    Err(SessionEnd::Restart(reason)) => return Err(SessionEnd::Restart(reason)),
                    Err(SessionEnd::Failed(reason)) => {
                        failures += 1;
                        let wait = Duration::from_secs(1 << failures.min(6));
                        tracing::warn!(
                            table = table.name(),
                            reason,
                            retry_in_seconds = wait.as_secs(),
                            "panel-writer: commit failed; keeping the rows"
                        );
                        retry_at = Some(now + wait);
                    }
                }
            }
            if last_progress.elapsed() >= progress_every {
                for message in buffer.messages.values() {
                    let _ = message.ack_with(AckKind::Progress).await;
                }
                last_progress = Instant::now();
            }
            if let Some(at) = retry_at {
                // No fetching while a commit is failing: the buffer stays
                // as it is until the store answers again.
                tokio::time::sleep(
                    at.saturating_duration_since(Instant::now())
                        .min(Duration::from_secs(1)),
                )
                .await;
                continue;
            }
            let room = self
                .settings
                .max_pending
                .saturating_sub(buffer.messages.len())
                .clamp(1, self.settings.fetch_batch);
            let wait = buffer.since.map_or(self.settings.fetch_wait, |since| {
                self.settings
                    .flush_after
                    .saturating_sub(since.elapsed())
                    .max(Duration::from_millis(100))
                    .min(self.settings.fetch_wait)
            });
            // Never cancelled: a fetch given up on would leave its messages
            // to come back later, out of order.
            let fetched = fetch(&consumer, room, wait).await;
            let messages = match fetched {
                Ok(messages) => messages,
                Err(error) => {
                    // Whatever it delivered is redelivered after a restart.
                    if !buffer.is_empty() {
                        self.flush(table, lease, &mut buffer, &mut committed)
                            .await?;
                    }
                    return Err(SessionEnd::Restart(format!("fetch failed: {error}")));
                }
            };
            let mut fresh: Vec<(u64, jetstream::Message, Value)> = Vec::new();
            let mut bad: Vec<(jetstream::Message, String)> = Vec::new();
            let mut gap = false;
            for message in messages {
                let Ok(info) = message.info() else {
                    gap = true;
                    break;
                };
                let (stream_seq, delivery_seq) = (info.stream_sequence, info.consumer_sequence);
                let newest = fresh.last().map(|(seq, _, _)| *seq).or(buffer.last_seq());
                match arrival(stream_seq, delivery_seq, floor, newest, expected_delivery) {
                    Arrival::Gap => {
                        gap = true;
                        break;
                    }
                    Arrival::Committed => {
                        let _ = message.ack().await;
                    }
                    Arrival::Buffered => {
                        if let Some(held) = buffer.messages.get_mut(&stream_seq) {
                            *held = message;
                        } else if let Some(entry) =
                            fresh.iter_mut().find(|(seq, _, _)| *seq == stream_seq)
                        {
                            entry.1 = message;
                        } else {
                            // A dead letter whose termination got lost.
                            let _ = message.ack_with(AckKind::Term).await;
                        }
                    }
                    Arrival::New => match row_of(&message) {
                        Ok(row) => fresh.push((stream_seq, message, row)),
                        Err(reason) => bad.push((message, reason)),
                    },
                }
                if delivery_seq == expected_delivery {
                    expected_delivery += 1;
                }
            }
            // Rows of the wrong shape for the table go with the bad ones.
            let batch = if fresh.is_empty() {
                None
            } else {
                let rows: Vec<Value> = fresh.iter().map(|(_, _, row)| row.clone()).collect();
                if let Ok(batch) = rows_to_batch(&schema, &rows) {
                    Some(batch)
                } else {
                    let (good, wrong): (Vec<_>, Vec<_>) = fresh
                        .into_iter()
                        .partition(|(_, _, row)| check_row(&schema, row).is_ok());
                    for (_, message, row) in wrong {
                        let reason = check_row(&schema, &row)
                            .err()
                            .map_or_else(String::new, |error| error.to_string());
                        bad.push((message, reason));
                    }
                    fresh = good;
                    let rows: Vec<Value> = fresh.iter().map(|(_, _, row)| row.clone()).collect();
                    if rows.is_empty() {
                        None
                    } else {
                        Some(rows_to_batch(&schema, &rows)?)
                    }
                }
            };
            for (message, reason) in &bad {
                if let Err(error) =
                    publish_dead_letter(&self.jetstream, &spec, message, reason).await
                {
                    // Not stored: start over from the table's sequence
                    // without committing past it.
                    return Err(SessionEnd::Restart(format!(
                        "a dead letter could not be stored: {error}"
                    )));
                }
                tracing::warn!(
                    table = table.name(),
                    reason,
                    "panel-writer: dead-lettered a row"
                );
                let _ = message.ack_with(AckKind::Term).await;
                metrics::counter!(CONSUMER_MESSAGES_METRIC, "consumer" => spec.durable.clone(), "outcome" => "error")
                    .increment(1);
            }
            if let Some(batch) = batch {
                buffer.since.get_or_insert_with(Instant::now);
                buffer.batches.push(batch);
                let keep_rows = self.tenant_state.wants(table);
                for (seq, message, row) in fresh {
                    buffer.bytes += message.payload.len();
                    if keep_rows {
                        buffer.rows.push(row);
                    }
                    buffer.messages.insert(seq, message);
                }
            }
            if gap {
                // What is buffered came in order; commit it, then restart so
                // the missing delivery comes again in its place.
                if !buffer.is_empty() {
                    self.flush(table, lease, &mut buffer, &mut committed)
                        .await?;
                }
                return Err(SessionEnd::Restart("a delivery was skipped".to_owned()));
            }
        }
    }

    /// Commits the buffer (fenced on `committed`), runs the tenant hook,
    /// acknowledges the messages and empties the buffer.
    async fn flush(
        &self,
        table: PanelTable,
        lease: &ValkeyLease,
        buffer: &mut Buffer,
        committed: &mut Option<u64>,
    ) -> Result<(), SessionEnd> {
        let Some(seq) = buffer.last_seq() else {
            return Ok(());
        };
        // A lease that ran out must not commit (the fence would catch a
        // commit that raced it anyway).
        match lease.renew().await {
            Ok(true) => {}
            Ok(false) => return Err(SessionEnd::Restart("the lease was lost".to_owned())),
            Err(error) => return Err(SessionEnd::Failed(error.to_string())),
        }
        let rows: usize = buffer.batches.iter().map(RecordBatch::num_rows).sum();
        let outcome = self
            .lake
            .append_after(table, &buffer.batches, seq, *committed)
            .await;
        let label = match &outcome {
            Ok(_) => "ok",
            Err(LakehouseError::Conflict(_)) => "fenced",
            Err(_) => "failed",
        };
        metrics::counter!(COMMITS_METRIC, "table" => table.name(), "outcome" => label).increment(1);
        outcome?;
        *committed = Some(seq);
        if self.tenant_state.wants(table) {
            self.tenant_state.committed(table, &buffer.rows).await;
        }
        let consumer = format!("panel-writer-{}", table.name().trim_end_matches("_v1"));
        for message in buffer.messages.values() {
            // A lost acknowledgement comes back below the table's sequence
            // and is acknowledged then.
            let _ = message.ack().await;
        }
        metrics::counter!(CONSUMER_MESSAGES_METRIC, "consumer" => consumer, "outcome" => "ok")
            .increment(u64::try_from(buffer.messages.len()).unwrap_or(u64::MAX));
        metrics::counter!(ROWS_METRIC, "table" => table.name())
            .increment(u64::try_from(rows).unwrap_or(u64::MAX));
        tracing::info!(
            table = table.name(),
            rows,
            stream_seq = seq,
            "panel-writer: committed"
        );
        buffer.clear();
        Ok(())
    }
}

/// A message's row: a JSON object.
fn row_of(message: &jetstream::Message) -> Result<Value, String> {
    match serde_json::from_slice::<Value>(&message.payload) {
        Ok(row @ Value::Object(_)) => Ok(row),
        Ok(_) => Err("the row is not a JSON object".to_owned()),
        Err(error) => Err(format!("the row is not JSON: {error}")),
    }
}

/// One fetch of up to `max` messages within `wait`, read to its end.
pub(super) async fn fetch(
    consumer: &consumer::PullConsumer,
    max: usize,
    wait: Duration,
) -> Result<Vec<jetstream::Message>, String> {
    let mut batch = consumer
        .fetch()
        .max_messages(max)
        .expires(wait)
        .messages()
        .await
        .map_err(|error| error.to_string())?;
    let mut messages = Vec::new();
    while let Some(message) = batch.next().await {
        match message {
            Ok(message) => messages.push(message),
            // What arrived is in order; the gap check finds what didn't.
            Err(error) => {
                tracing::warn!(%error, "panel-writer: a fetch ended early");
                break;
            }
        }
    }
    Ok(messages)
}

/// Renews the lease every `every`; `lost` turns true when it can't.
pub(super) async fn keep_lease(lease: ValkeyLease, every: Duration, lost: watch::Sender<bool>) {
    let mut ticker = tokio::time::interval(every.max(Duration::from_millis(100)));
    ticker.tick().await;
    let mut misses = 0;
    loop {
        ticker.tick().await;
        match lease.renew().await {
            Ok(true) => misses = 0,
            Ok(false) => {
                let _ = lost.send(true);
                return;
            }
            // Valkey out of reach: the lease runs out at the third miss,
            // so give up at the second, before another pod can take it.
            Err(error) => {
                misses += 1;
                tracing::warn!(%error, misses, "panel-writer: could not renew the lease");
                if misses >= 2 {
                    let _ = lost.send(true);
                    return;
                }
            }
        }
    }
}

/// Stops a task when dropped.
pub(super) struct AbortOnDrop(pub(super) tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn streams() -> PanelStreams {
        PanelStreams {
            events: "PANEL_EVENTS".to_owned(),
            events_subject: "panel.events.v1".to_owned(),
            state: "PANEL_STATE".to_owned(),
            max_age: Duration::from_hours(7 * 24),
        }
    }

    #[test]
    fn every_table_has_a_feed_and_a_consumer_of_its_own() {
        let settings = WriterSettings::default();
        let feeds = feeds(&streams());
        let specs: Vec<(String, String, String)> = feeds
            .iter()
            .map(|feed| {
                let spec = spec(feed, &settings);
                (spec.durable, spec.stream, spec.filter_subject)
            })
            .collect();
        assert_eq!(
            specs,
            [
                ("panel-writer-events", "PANEL_EVENTS", "panel.events.v1.>"),
                (
                    "panel-writer-identities",
                    "PANEL_STATE",
                    "panel.identities.v1.>"
                ),
                ("panel-writer-people", "PANEL_STATE", "panel.people.v1.>"),
                ("panel-writer-groups", "PANEL_STATE", "panel.groups.v1.>"),
                (
                    "panel-writer-replay_chunks",
                    "PANEL_STATE",
                    "panel.replays.v1.>"
                ),
            ]
            .map(|(a, b, c)| (a.to_owned(), b.to_owned(), c.to_owned()))
        );
        let spec = spec(&feeds[0], &settings);
        assert!(spec.ack_wait > settings.flush_after);
        assert_eq!(
            weldsuite_adapters_oss::dead_letter_subject(&spec, "panel.events.v1.ws_1"),
            "panel-dlq.events.v1.ws_1"
        );
    }

    #[test]
    fn a_session_starts_right_after_the_table_s_sequence() {
        assert_eq!(start(None, 0), Start::All);
        assert_eq!(start(None, 40), Start::All);
        assert_eq!(start(Some(40), 40), Start::After(40));
        assert_eq!(start(Some(12), 40), Start::After(12));
        // The stream was made anew: its sequences are below the table's.
        assert_eq!(start(Some(90), 40), Start::All);
        let settings = WriterSettings::default();
        let spec = spec(&feeds(&streams())[0], &settings);
        let config = consumer_config(&spec, &settings, Start::After(12));
        assert_eq!(
            config.deliver_policy,
            consumer::DeliverPolicy::ByStartSequence { start_sequence: 13 }
        );
        assert_eq!(config.max_deliver, -1);
        assert_eq!(config.max_ack_pending, 200_000);
        assert_eq!(config.ack_policy, consumer::AckPolicy::Explicit);
        assert_eq!(
            consumer_config(&spec, &settings, Start::All).deliver_policy,
            consumer::DeliverPolicy::All
        );
    }

    #[test]
    fn deliveries_are_sorted_by_the_table_s_sequence_and_the_buffer() {
        // In order, nothing committed or buffered.
        assert_eq!(arrival(5, 1, None, None, 1), Arrival::New);
        // Committed already (an acknowledgement got lost).
        assert_eq!(arrival(5, 3, Some(9), None, 3), Arrival::Committed);
        // Buffered already, delivered again (new or reused delivery number).
        assert_eq!(arrival(12, 7, Some(9), Some(14), 7), Arrival::Buffered);
        assert_eq!(arrival(12, 2, Some(9), Some(14), 7), Arrival::Buffered);
        // Past the buffer.
        assert_eq!(arrival(15, 7, Some(9), Some(14), 7), Arrival::New);
        // A delivery never arrived.
        assert_eq!(arrival(16, 9, Some(9), Some(14), 7), Arrival::Gap);
    }

    #[test]
    fn the_buffer_flushes_at_its_size_its_age_or_its_room() {
        let settings = WriterSettings {
            flush_bytes: 100,
            flush_after: Duration::from_secs(60),
            max_pending: 10,
            fetch_batch: 4,
            ..WriterSettings::default()
        };
        let now = Instant::now();
        let young = Some(now);
        let old = now.checked_sub(Duration::from_secs(61));
        assert!(!flush_due(0, 500, old, &settings, now));
        assert!(!flush_due(3, 99, young, &settings, now));
        assert!(flush_due(3, 100, young, &settings, now));
        assert!(flush_due(1, 1, old, &settings, now));
        // Another fetch of 4 would pass the 10 unacknowledged.
        assert!(!flush_due(6, 1, young, &settings, now));
        assert!(flush_due(7, 1, young, &settings, now));
        assert!(Buffer::default().last_seq().is_none());
    }

    /// Against throwaway Postgres, NATS and Valkey (see
    /// `panel_test_support`): two rival writers on one feed, bad rows in the
    /// middle, then a restart, and every good row is in the table once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[allow(clippy::too_many_lines)] // one scenario, in order
    async fn writes_every_row_once_across_rivals_and_restarts() {
        use crate::panel_test_support::{ScratchPanel, event, unique};
        let (Ok(nats), Ok(valkey)) = (
            std::env::var("WELDSUITE_TEST_NATS_URL"),
            std::env::var("WELDSUITE_TEST_VALKEY_URL"),
        ) else {
            eprintln!("skipped: WELDSUITE_TEST_NATS_URL and WELDSUITE_TEST_VALKEY_URL are not set");
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
        js.get_or_create_stream(weldsuite_adapters_oss::dead_letter_stream_config(
            DLQ_STREAM,
            DLQ_SUBJECT,
            1,
        ))
        .await
        .expect("the dead letters");
        let feed = Feed {
            table: PanelTable::Events,
            stream: stream.clone(),
            subject: format!("{subject}.>"),
        };
        // Each with a message id of its own, as the collector's: the dead
        // letters are deduplicated on it.
        let published = std::sync::atomic::AtomicUsize::new(0);
        let publish = |rows: Vec<Vec<u8>>| {
            let js = js.clone();
            let subject = format!("{subject}.ws_1");
            let first = published.fetch_add(rows.len(), std::sync::atomic::Ordering::Relaxed);
            let tag = tag.clone();
            async move {
                for (n, payload) in rows.into_iter().enumerate() {
                    let message = async_nats::jetstream::message::PublishMessage::build()
                        .payload(payload.into())
                        .message_id(format!("{tag}-{}", first + n));
                    js.send_publish(subject.clone(), message)
                        .await
                        .expect("a publish")
                        .await
                        .expect("stored");
                }
            }
        };
        let row = |n: usize| {
            let ts = format!("2026-11-18T10:{:02}:00.000Z", n % 60);
            serde_json::to_vec(&event("ws_1", "pnp_1", &format!("e{n}"), "a-1", "s-1", &ts))
                .expect("json")
        };
        let mut first: Vec<Vec<u8>> = (0..15).map(row).collect();
        first.push(b"not json".to_vec());
        let mut wrong: serde_json::Value = serde_json::from_slice(&row(99)).expect("a row");
        wrong["ts"] = Value::from(5);
        first.push(serde_json::to_vec(&wrong).expect("json"));
        first.extend((15..30).map(row));
        publish(first).await;

        let settings = WriterSettings {
            flush_after: Duration::from_secs(1),
            fetch_batch: 10,
            fetch_wait: Duration::from_millis(300),
            max_pending: 1_000,
            lease_ttl: Duration::from_secs(3),
            ..WriterSettings::default()
        };
        let connection = weldsuite_adapters_oss::connect_valkey(&valkey)
            .await
            .expect("valkey");
        let key = format!("test:lease:panel-writer:{tag}");
        let writer = || {
            Arc::new(PanelWriter {
                lake: scratch.lake.clone(),
                jetstream: js.clone(),
                settings: settings.clone(),
                tenant_state: Arc::new(NoTenantState),
            })
        };
        let lease =
            |holder: &str| ValkeyLease::new(connection.clone(), &key, holder, settings.lease_ttl);
        let wait_for = |seq: u64| {
            let lake = scratch.lake.clone();
            async move {
                for _ in 0..120 {
                    if lake
                        .last_stream_seq(PanelTable::Events)
                        .await
                        .expect("seq")
                        .is_some_and(|at| at >= seq)
                    {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                panic!("the writer never reached sequence {seq}");
            }
        };

        // Two rivals: one writes, the other stands by.
        let (stop, stopping) = watch::channel(false);
        let mut tasks = writer().spawn(vec![(feed.clone(), lease("pod-a"))], &stopping);
        tasks.extend(writer().spawn(vec![(feed.clone(), lease("pod-b"))], &stopping));
        wait_for(32).await;
        assert_eq!(scratch.rows(PanelTable::Events).await, 30);
        let dead = js.get_stream(DLQ_STREAM).await.expect("the dead letters");
        let subjects: Vec<(String, usize)> = dead
            .info_with_subjects(format!("{DLQ_SUBJECT}.events{tag}.v1.ws_1"))
            .await
            .expect("their subjects")
            .filter_map(|subject| std::future::ready(subject.ok()))
            .collect()
            .await;
        assert_eq!(subjects.iter().map(|(_, count)| count).sum::<usize>(), 2);
        stop.send(true).expect("stop");
        for task in tasks {
            task.await.expect("a writer");
        }

        // A restart reads on from the table's sequence.
        publish((30..35).map(row).collect()).await;
        let (stop, stopping) = watch::channel(false);
        let tasks = writer().spawn(vec![(feed, lease("pod-c"))], &stopping);
        wait_for(37).await;
        assert_eq!(scratch.rows(PanelTable::Events).await, 35);
        stop.send(true).expect("stop");
        for task in tasks {
            task.await.expect("a writer");
        }
        let _ = js.delete_stream(&stream).await;
        scratch.finish().await;
    }
}
