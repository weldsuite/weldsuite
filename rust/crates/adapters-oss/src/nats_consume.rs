//! Consuming the entity-event hub on NATS `JetStream`: what the Cloudflare
//! Queues consumers do for the TypeScript subscribers (EVT-001), as durable
//! pull consumers on the hub stream.
//!
//! - **Fan-out.** The hub stream keeps every event (limits retention, seven
//!   days); each subscriber is one durable consumer on it with its own ack
//!   floor. No re-enqueue hop as in `entity-events-worker`: the stream is the
//!   fan-out, and one slow subscriber never holds back another.
//! - **Routing.** A consumer filters on the subjects its topic patterns map to
//!   (`entity-events.>` for `*`, `entity-events.customer.*` for
//!   `customer:*`); the subscriber checks `topicMatches` again in process.
//! - **Retries.** A failed delivery is redelivered after a backoff (a NAK with
//!   a delay), up to the queue's `max_retries`; the delivery after that goes
//!   to the dead-letter stream and is terminated on the hub consumer.
//!   [`Disposition::Defer`] retries without spending that budget, for up to
//!   `max_deferrals` waits (the audit log's locked-database wait).
//! - **Dedupe (EVT-002).** The publisher sets `Nats-Msg-Id` to the event id,
//!   so a retried publish inside the stream's duplicate window is stored once;
//!   each consumer also skips an event id it already completed recently; and
//!   every subscriber stays idempotent on the id, as in TypeScript.
//! - **Shutdown.** [`run_consumer`] stops fetching when `stop` turns true,
//!   finishes the batch in hand (acks, NAKs, dead letters) and returns.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_nats::HeaderMap;
use async_nats::jetstream::{self, AckKind, consumer, stream};
use bytes::Bytes;
use futures_util::StreamExt;
use tokio::sync::watch;
use weldsuite_ports::{BatchHandler, Delivery, Disposition, PortError};

/// How one subscriber consumes the hub.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumerSpec {
    /// The hub stream, `ENTITY_EVENTS`.
    pub stream: String,
    /// The durable consumer's name: the subscriber id (`audit`).
    pub durable: String,
    pub description: String,
    /// The one subject the consumer receives, `entity-events.>`.
    pub filter_subject: String,
    /// Start a new consumer at the next event instead of the stream's
    /// oldest: for realtime, where a week-old frame is noise.
    pub deliver_new_only: bool,
    /// Retries after the first delivery before a message is dead-lettered:
    /// the queue's `max_retries`.
    pub max_retries: u32,
    /// [`Disposition::Defer`] waits a message may take besides.
    pub max_deferrals: u32,
    /// Pause before retry 1, 2, …; the last entry repeats.
    pub retry_backoff: Vec<Duration>,
    /// How long a delivery may stay unanswered before the server sends it
    /// again; longer than the slowest batch.
    pub ack_wait: Duration,
    /// Messages per batch (`max_batch_size`).
    pub batch_size: usize,
    /// How long a fetch waits to fill a batch (`max_batch_timeout`).
    pub batch_wait: Duration,
    /// Batches handled at once (`max_concurrency`).
    pub workers: usize,
    /// Where dead letters go: `entity-events-dlq.audit`, followed by the
    /// event's own `<entityType>.<action>`.
    pub dead_letter_subject: String,
    /// Event ids remembered as completed, per consumer.
    pub dedupe_capacity: usize,
}

impl ConsumerSpec {
    /// Deliveries the server allows in all: the first, the retries and the
    /// deferrals.
    pub fn max_deliver(&self) -> i64 {
        i64::from(self.max_retries) + i64::from(self.max_deferrals) + 1
    }

    /// The `JetStream` consumer configuration.
    pub fn config(&self) -> consumer::pull::Config {
        let in_flight = self.batch_size.max(1) * self.workers.max(1);
        consumer::pull::Config {
            durable_name: Some(self.durable.clone()),
            description: Some(self.description.clone()),
            deliver_policy: if self.deliver_new_only {
                consumer::DeliverPolicy::New
            } else {
                consumer::DeliverPolicy::All
            },
            ack_policy: consumer::AckPolicy::Explicit,
            ack_wait: self.ack_wait,
            max_deliver: self.max_deliver(),
            filter_subject: self.filter_subject.clone(),
            max_ack_pending: i64::try_from(in_flight * 4).unwrap_or(i64::MAX),
            ..consumer::pull::Config::default()
        }
    }
}

/// The dead-letter stream: every subject under `subject_prefix` (one per
/// subscriber below it), kept on disk for fourteen days so an operator can
/// inspect and replay them.
pub fn dead_letter_stream_config(
    name: &str,
    subject_prefix: &str,
    replicas: usize,
) -> stream::Config {
    stream::Config {
        name: name.to_owned(),
        description: Some(
            "Entity events a subscriber gave up on (EVT-001 dead letters)".to_owned(),
        ),
        subjects: vec![format!("{subject_prefix}.>")],
        storage: stream::StorageType::File,
        max_age: Duration::from_hours(14 * 24),
        duplicate_window: Duration::from_secs(120),
        num_replicas: replicas.max(1),
        ..stream::Config::default()
    }
}

/// Creates the durable consumer, or updates it to `spec` when it exists
/// (`CreateOrUpdate`): a deploy that changes a subscriber's settings applies
/// them. The deliver policy of an existing consumer cannot change.
pub async fn ensure_consumer(
    context: &jetstream::Context,
    spec: &ConsumerSpec,
) -> Result<consumer::PullConsumer, PortError> {
    let stream = context
        .get_stream(&spec.stream)
        .await
        .map_err(PortError::backend)?;
    stream
        .create_consumer(spec.config())
        .await
        .map_err(PortError::backend)
}

/// What happens to one delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Ack,
    /// Redeliver after the delay.
    Nak(Duration),
    /// Give up: copy to the dead-letter stream, terminate on the hub.
    DeadLetter(String),
}

/// The action for a delivery the handler answered with `disposition`.
/// `attempt` is the delivery count (from 1), `deferred` the deferrals this
/// message already took in this process.
pub fn decide(
    spec: &ConsumerSpec,
    disposition: &Disposition,
    attempt: u64,
    deferred: u32,
) -> Action {
    let reason = match disposition {
        Disposition::Ack => return Action::Ack,
        Disposition::Defer { delay, reason } => {
            if deferred < spec.max_deferrals
                && i64::try_from(attempt).unwrap_or(i64::MAX) < spec.max_deliver()
            {
                return Action::Nak(*delay);
            }
            reason
        }
        Disposition::Retry { reason } => reason,
    };
    // Deliveries before this one that were not deferrals were failures.
    let failures = attempt
        .saturating_sub(1)
        .saturating_sub(u64::from(deferred))
        + 1;
    if failures > u64::from(spec.max_retries)
        || i64::try_from(attempt).unwrap_or(i64::MAX) >= spec.max_deliver()
    {
        return Action::DeadLetter(reason.clone());
    }
    let index = usize::try_from(failures - 1).unwrap_or(usize::MAX);
    let delay = spec
        .retry_backoff
        .get(index)
        .or_else(|| spec.retry_backoff.last())
        .copied()
        .unwrap_or_default();
    Action::Nak(delay)
}

/// Recently completed event ids and the deferrals of messages in flight,
/// shared by a consumer's workers.
#[derive(Debug, Default)]
struct Memory {
    completed: HashSet<String>,
    order: VecDeque<String>,
    deferred: HashMap<u64, u32>,
}

#[derive(Debug, Default)]
struct SharedMemory(Mutex<Memory>);

impl SharedMemory {
    fn lock(&self) -> MutexGuard<'_, Memory> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn is_completed(&self, id: &str) -> bool {
        self.lock().completed.contains(id)
    }

    fn complete(&self, id: String, capacity: usize) {
        if capacity == 0 {
            return;
        }
        let mut memory = self.lock();
        if memory.completed.insert(id.clone()) {
            memory.order.push_back(id);
        }
        while memory.order.len() > capacity {
            if let Some(oldest) = memory.order.pop_front() {
                memory.completed.remove(&oldest);
            }
        }
    }

    fn deferred(&self, sequence: u64) -> u32 {
        self.lock().deferred.get(&sequence).copied().unwrap_or(0)
    }

    fn set_deferred(&self, sequence: u64, count: Option<u32>) {
        let mut memory = self.lock();
        match count {
            Some(count) => {
                // Bounded: a restart forgets anyway; an entry left behind by a
                // message another pod finished is harmless.
                if memory.deferred.len() >= 100_000 {
                    memory.deferred.clear();
                }
                memory.deferred.insert(sequence, count);
            }
            None => {
                memory.deferred.remove(&sequence);
            }
        }
    }
}

/// Consumes `spec.durable` with `spec.workers` concurrent batch loops until
/// `stop` turns true, then waits for the batches in hand to finish.
pub async fn run_consumer(
    context: jetstream::Context,
    consumer: consumer::PullConsumer,
    spec: Arc<ConsumerSpec>,
    handler: Arc<dyn BatchHandler>,
    stop: watch::Receiver<bool>,
) {
    let memory = Arc::new(SharedMemory::default());
    let mut workers = Vec::with_capacity(spec.workers.max(1));
    for worker in 0..spec.workers.max(1) {
        workers.push(tokio::spawn(worker_loop(
            context.clone(),
            consumer.clone(),
            Arc::clone(&spec),
            Arc::clone(&handler),
            Arc::clone(&memory),
            stop.clone(),
            worker,
        )));
    }
    for worker in workers {
        if let Err(error) = worker.await {
            tracing::error!(consumer = spec.durable, %error, "consume: a worker panicked");
        }
    }
    tracing::info!(consumer = spec.durable, "consume: stopped");
}

async fn worker_loop(
    context: jetstream::Context,
    consumer: consumer::PullConsumer,
    spec: Arc<ConsumerSpec>,
    handler: Arc<dyn BatchHandler>,
    memory: Arc<SharedMemory>,
    mut stop: watch::Receiver<bool>,
    worker: usize,
) {
    loop {
        if *stop.borrow() {
            return;
        }
        let fetched = tokio::select! {
            fetched = fetch_batch(&consumer, &spec) => fetched,
            _ = stop.wait_for(|stopping| *stopping) => return,
        };
        match fetched {
            Ok(messages) if messages.is_empty() => {}
            Ok(messages) => handle_batch(&context, &spec, &*handler, &memory, messages).await,
            Err(error) => {
                tracing::warn!(consumer = spec.durable, worker, %error, "consume: fetch failed; retrying");
                tokio::select! {
                    () = tokio::time::sleep(Duration::from_secs(1)) => {},
                    _ = stop.wait_for(|stopping| *stopping) => return,
                }
            }
        }
    }
}

/// One batch: up to `batch_size` messages, or what arrived within
/// `batch_wait`.
async fn fetch_batch(
    consumer: &consumer::PullConsumer,
    spec: &ConsumerSpec,
) -> Result<Vec<jetstream::Message>, PortError> {
    let mut batch = consumer
        .fetch()
        .max_messages(spec.batch_size.max(1))
        .expires(spec.batch_wait)
        .messages()
        .await
        .map_err(PortError::backend)?;
    let mut messages = Vec::new();
    while let Some(message) = batch.next().await {
        match message {
            Ok(message) => messages.push(message),
            Err(error) => {
                tracing::warn!(consumer = spec.durable, %error, "consume: a batch ended early");
                break;
            }
        }
    }
    Ok(messages)
}

/// The event id a message carries in `Nats-Msg-Id`.
fn message_id(message: &jetstream::Message) -> Option<String> {
    message
        .message
        .headers
        .as_ref()
        .and_then(|headers| headers.get("Nats-Msg-Id"))
        .map(|value| value.as_str().to_owned())
}

struct Pending {
    message: jetstream::Message,
    id: Option<String>,
    attempt: u64,
    sequence: u64,
}

async fn handle_batch(
    context: &jetstream::Context,
    spec: &ConsumerSpec,
    handler: &dyn BatchHandler,
    memory: &SharedMemory,
    messages: Vec<jetstream::Message>,
) {
    let mut pending = Vec::with_capacity(messages.len());
    for message in messages {
        let id = message_id(&message);
        if id.as_deref().is_some_and(|id| memory.is_completed(id)) {
            tracing::debug!(
                consumer = spec.durable,
                event_id = id,
                "consume: duplicate skipped"
            );
            acknowledge(spec, &message, AckKind::Ack).await;
            continue;
        }
        let (attempt, sequence) = message.info().map_or((1, 0), |info| {
            (
                u64::try_from(info.delivered).unwrap_or(1).max(1),
                info.stream_sequence,
            )
        });
        pending.push(Pending {
            message,
            id,
            attempt,
            sequence,
        });
    }
    if pending.is_empty() {
        return;
    }

    let deliveries: Vec<Delivery> = pending
        .iter()
        .map(|p| Delivery {
            subject: p.message.message.subject.to_string(),
            payload: p.message.message.payload.to_vec(),
            attempt: p.attempt,
            deferrals: memory.deferred(p.sequence),
        })
        .collect();
    // Tell the server the batch is still being worked on, so a slow sink (a
    // webhook endpoint taking its ten seconds, an embedding call) never makes
    // it hand the same messages to another worker.
    let period = (spec.ack_wait / 3).max(Duration::from_secs(1));
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    let mut handling = std::pin::pin!(handler.handle(&deliveries));
    let dispositions = loop {
        tokio::select! {
            dispositions = &mut handling => break dispositions,
            _ = ticker.tick() => {
                for item in &pending {
                    acknowledge(spec, &item.message, AckKind::Progress).await;
                }
            }
        }
    };

    for (index, item) in pending.into_iter().enumerate() {
        let disposition = dispositions
            .get(index)
            .cloned()
            .unwrap_or_else(|| Disposition::retry("the handler gave no answer"));
        let deferred = memory.deferred(item.sequence);
        match decide(spec, &disposition, item.attempt, deferred) {
            Action::Ack => {
                memory.set_deferred(item.sequence, None);
                if let Some(id) = item.id {
                    memory.complete(id, spec.dedupe_capacity);
                }
                acknowledge(spec, &item.message, AckKind::Ack).await;
            }
            Action::Nak(delay) => {
                if let Disposition::Defer { reason, .. } = &disposition {
                    memory.set_deferred(item.sequence, Some(deferred + 1));
                    tracing::warn!(
                        consumer = spec.durable,
                        event_id = item.id,
                        attempt = item.attempt,
                        delay_seconds = delay.as_secs(),
                        reason,
                        "consume: deferred"
                    );
                } else if let Disposition::Retry { reason } = &disposition {
                    tracing::warn!(
                        consumer = spec.durable,
                        event_id = item.id,
                        attempt = item.attempt,
                        delay_seconds = delay.as_secs(),
                        reason,
                        "consume: failed; will retry"
                    );
                }
                acknowledge(spec, &item.message, AckKind::Nak(Some(delay))).await;
            }
            Action::DeadLetter(reason) => {
                memory.set_deferred(item.sequence, None);
                dead_letter(context, spec, &item, &reason).await;
            }
        }
    }
}

async fn acknowledge(spec: &ConsumerSpec, message: &jetstream::Message, kind: AckKind) {
    if let Err(error) = message.ack_with(kind).await {
        // The server redelivers after `ack_wait`; the subscribers are
        // idempotent on the event id.
        tracing::warn!(consumer = spec.durable, %error, "consume: ack failed");
    }
}

/// The dead-letter subject for a message: the spec's subject followed by the
/// hub subject's tokens after the prefix (`<entityType>.<action>`).
pub fn dead_letter_subject(spec: &ConsumerSpec, subject: &str) -> String {
    let tail = subject.split_once('.').map_or(subject, |(_, tail)| tail);
    format!("{}.{tail}", spec.dead_letter_subject)
}

async fn dead_letter(
    context: &jetstream::Context,
    spec: &ConsumerSpec,
    item: &Pending,
    reason: &str,
) {
    let subject = dead_letter_subject(spec, &item.message.message.subject);
    let mut headers = HeaderMap::new();
    let key = item
        .id
        .clone()
        .unwrap_or_else(|| format!("seq-{}", item.sequence));
    headers.insert("Nats-Msg-Id", format!("{}:{key}", spec.durable));
    headers.insert("Weldsuite-Subscriber", spec.durable.as_str());
    headers.insert("Weldsuite-Subject", item.message.message.subject.as_str());
    headers.insert("Weldsuite-Stream", spec.stream.as_str());
    headers.insert("Weldsuite-Stream-Sequence", item.sequence.to_string());
    headers.insert("Weldsuite-Deliveries", item.attempt.to_string());
    headers.insert("Weldsuite-Error", truncate(&single_line(reason), 500));
    let payload = Bytes::copy_from_slice(&item.message.message.payload);
    let stored = match context
        .publish_with_headers(subject.clone(), headers, payload)
        .await
    {
        Ok(ack) => ack.await.map(|_| ()).map_err(PortError::backend),
        Err(error) => Err(PortError::backend(error)),
    };
    match stored {
        Ok(()) => {
            tracing::error!(
                consumer = spec.durable,
                event_id = item.id,
                attempts = item.attempt,
                dead_letter = subject,
                reason,
                "consume: gave up; dead-lettered"
            );
            acknowledge(spec, &item.message, AckKind::Term).await;
        }
        Err(error) => {
            // Leave it to the server: it redelivers until `max_deliver`, and
            // the hub keeps the event for its retention either way.
            tracing::error!(
                consumer = spec.durable,
                event_id = item.id,
                %error,
                "consume: dead-letter publish failed"
            );
            acknowledge(
                spec,
                &item.message,
                AckKind::Nak(Some(Duration::from_secs(30))),
            )
            .await;
        }
    }
}

fn single_line(text: &str) -> String {
    text.replace(['\r', '\n'], " ")
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(max_retries: u32, max_deferrals: u32) -> ConsumerSpec {
        ConsumerSpec {
            stream: "ENTITY_EVENTS".to_owned(),
            durable: "audit".to_owned(),
            description: String::new(),
            filter_subject: "entity-events.>".to_owned(),
            deliver_new_only: false,
            max_retries,
            max_deferrals,
            retry_backoff: vec![Duration::from_secs(5), Duration::from_secs(20)],
            ack_wait: Duration::from_secs(30),
            batch_size: 10,
            batch_wait: Duration::from_secs(1),
            workers: 1,
            dead_letter_subject: "entity-events-dlq.audit".to_owned(),
            dedupe_capacity: 10,
        }
    }

    #[test]
    fn three_retries_then_the_dead_letter_stream() {
        let spec = spec(3, 0);
        let failed = Disposition::retry("boom");
        assert_eq!(
            decide(&spec, &failed, 1, 0),
            Action::Nak(Duration::from_secs(5))
        );
        assert_eq!(
            decide(&spec, &failed, 2, 0),
            Action::Nak(Duration::from_secs(20))
        );
        assert_eq!(
            decide(&spec, &failed, 3, 0),
            Action::Nak(Duration::from_secs(20))
        );
        assert_eq!(
            decide(&spec, &failed, 4, 0),
            Action::DeadLetter("boom".to_owned())
        );
        assert_eq!(decide(&spec, &Disposition::Ack, 4, 0), Action::Ack);
        assert_eq!(spec.max_deliver(), 4);
    }

    #[test]
    fn deferrals_do_not_spend_the_retry_budget() {
        let spec = spec(3, 20);
        let locked = Disposition::Defer {
            delay: Duration::from_mins(15),
            reason: "locked".to_owned(),
        };
        assert_eq!(
            decide(&spec, &locked, 1, 0),
            Action::Nak(Duration::from_mins(15))
        );
        // Ten waits, then an ordinary failure: still the first retry.
        let failed = Disposition::retry("boom");
        assert_eq!(
            decide(&spec, &failed, 11, 10),
            Action::Nak(Duration::from_secs(5))
        );
        // Waits spent: a lock counts as a failure, as `requeueLocked`
        // returning false falls back to `message.retry()`.
        assert_eq!(
            decide(&spec, &locked, 21, 20),
            Action::Nak(Duration::from_secs(5))
        );
        assert_eq!(
            decide(&spec, &locked, 24, 20),
            Action::DeadLetter("locked".to_owned())
        );
        assert_eq!(spec.max_deliver(), 24);
    }

    #[test]
    fn dead_letters_keep_the_event_subject() {
        let spec = spec(3, 0);
        assert_eq!(
            dead_letter_subject(&spec, "entity-events.customer.created"),
            "entity-events-dlq.audit.customer.created"
        );
    }

    #[test]
    fn completed_ids_are_bounded() {
        let memory = SharedMemory::default();
        memory.complete("a".to_owned(), 2);
        memory.complete("b".to_owned(), 2);
        memory.complete("c".to_owned(), 2);
        assert!(!memory.is_completed("a"));
        assert!(memory.is_completed("b") && memory.is_completed("c"));
    }

    #[test]
    fn consumer_config_matches_the_spec() {
        let config = spec(3, 0).config();
        assert_eq!(config.durable_name.as_deref(), Some("audit"));
        assert_eq!(config.max_deliver, 4);
        assert_eq!(config.filter_subject, "entity-events.>");
        assert_eq!(config.ack_policy, consumer::AckPolicy::Explicit);
        assert_eq!(config.deliver_policy, consumer::DeliverPolicy::All);
    }
}
