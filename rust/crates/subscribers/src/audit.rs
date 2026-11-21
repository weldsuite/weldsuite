//! The audit log subscriber: `apps/workers/audit-log-worker`. One
//! `audit_logs` row in the event's tenant database per entity event, with a
//! readable description ("Jane Doe changed Status and Priority").
//!
//! - `batch-processor.ts`: a tenant database locked by a move (28P01 /
//!   25006) waits with a growing delay, 60 s doubling to 15 min, up to 20
//!   times, without spending the retry budget ([`Disposition::Defer`]);
//!   anything else is retried and then dead-lettered.
//! - `event-processor.ts`: an event without a workspace is skipped.
//! - `audit-log-writer.ts`: skips an event id that already has a row
//!   (EVT-002). A write error fails the message (TASK-1256): the tenant pool
//!   connects lazily, as Neon's HTTP driver does, so a locked database
//!   surfaces in the write, and it gets the same lock wait as a lookup that
//!   fails with the lock's error. Any other write error is retried and then
//!   dead-lettered. Same in both backends.
//! - `stream-flusher.ts`: after the batch, every workspace that had an audit
//!   row written gets one flush of its audit log streams (the SIEM push,
//!   [`crate::audit_streams`]). The dispositions are decided by then, and a
//!   flush that fails is logged and otherwise ignored: the streams keep their
//!   own cursor and catch up on the next flush, so it never fails or retries
//!   a message.
//!
//!   That flush is not immediate. Delivery only reads rows older than a
//!   settle window, so a workspace that has an active stream is flushed
//!   [`STREAM_FLUSH_DELAY`] after its rows were written; a workspace without
//!   one costs a single small query and no wait. The worker hands the flushes
//!   to `ctx.waitUntil`; here they run in a task of their own
//!   ([`PendingStreamFlushes`]), so the batch is answered, and its messages
//!   acked, without waiting for them, and `consume` waits for the ones still
//!   on their way before it stops.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::future::join_all;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use tokio::sync::Notify;
use weldsuite_db::{Keyring, PgPool};
use weldsuite_ports::{BatchHandler, BoxFuture, Delivery, Disposition};

use crate::audit_streams::{
    AUDIT_STREAM_SETTLE, AuditStreamSender, FlushOptions, FlushOutcome, flush_audit_log_streams,
    has_active_audit_log_streams,
};
use crate::event::{HubEvent, OrderedObject};
use crate::js;
use crate::tenants::{Tenants, is_tenant_locked};

/// First pause before a locked tenant database is tried again; doubles each
/// time (`LOCKED_RETRY_BASE_DELAY_SECONDS`).
pub const LOCKED_RETRY_BASE_DELAY_SECONDS: u64 = 60;
/// Longest pause between two tries (`LOCKED_RETRY_MAX_DELAY_SECONDS`).
pub const LOCKED_RETRY_MAX_DELAY_SECONDS: u64 = 15 * 60;
/// Lock waits before the event falls back to the normal retries
/// (`LOCKED_MAX_RETRIES`, about four hours).
pub const LOCKED_MAX_RETRIES: u32 = 20;

/// `lockedRetryDelaySeconds(retry)`: 60 s, 2 min, 4 min, 8 min, then 15 min.
pub fn locked_retry_delay(retry: u32) -> Duration {
    let doubled = LOCKED_RETRY_BASE_DELAY_SECONDS
        .saturating_mul(2u64.saturating_pow(retry.saturating_sub(1)));
    Duration::from_secs(doubled.min(LOCKED_RETRY_MAX_DELAY_SECONDS))
}

/// `ENTITY_NAME_FIELDS`: entity types whose display name sits in a field the
/// generic list would miss or reach too late.
fn entity_name_fields(entity_type: &str) -> &'static [&'static str] {
    match entity_type {
        "project_task" | "personal_task" => &["title"],
        "contact" | "person" => &["displayName", "fullName"],
        "customer" | "commerce_customer" | "lead" | "supplier" => &["name", "companyName"],
        "company" => &["displayName", "name", "tradingName"],
        "product" | "category" | "opportunity" | "bank_account" | "account" | "project"
        | "warehouse" | "pipeline" | "deal" | "tag" | "label" | "template" | "workflow" => {
            &["name"]
        }
        "order" => &["orderNumber"],
        "invoice" => &["invoiceNumber"],
        "helpdesk_conversation" | "email" => &["subject"],
        "parcel" => &["trackingNumber"],
        "journal_entry" => &["reference"],
        "vat_return" | "tax_return" => &["periodLabel", "name"],
        "bill" => &["billNumber", "number", "reference"],
        "accounting_contact" => &["displayName", "name", "companyName"],
        "meeting" => &["title", "name", "subject"],
        "meeting_session" => &["title", "name"],
        "calendar_event" => &["title", "summary"],
        "helpdesk_ticket" | "ticket" => &["subject", "title"],
        _ => &[],
    }
}

/// `GENERIC_NAME_FIELDS`, tried in order for any entity type.
const GENERIC_NAME_FIELDS: [&str; 16] = [
    "displayName",
    "name",
    "title",
    "subject",
    "fullName",
    "companyName",
    "label",
    "periodLabel",
    "invoiceNumber",
    "orderNumber",
    "billNumber",
    "number",
    "reference",
    "trackingNumber",
    "code",
    "email",
];

/// `MODULE_PREFIXES`, stripped for display.
const MODULE_PREFIXES: [&str; 8] = [
    "project_",
    "personal_",
    "commerce_",
    "helpdesk_",
    "accounting_",
    "mail_",
    "parcel_",
    "wms_",
];

/// `nonEmptyString`: a trimmed non-empty string, or a number as text.
fn non_empty_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => {
            let trimmed = js::trim(text);
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        }
        Value::Number(number) => Some(js::json_number_text(number)),
        _ => None,
    }
}

/// `getEntityDisplayName(entityType, data)`.
pub fn entity_display_name(entity_type: &str, data: &Value) -> Option<String> {
    let fields = match data {
        Value::Object(map) => Some(map),
        Value::Array(_) => None,
        _ => return None,
    };
    let get = |field: &str| fields.and_then(|map| map.get(field));
    for field in entity_name_fields(entity_type) {
        if let Some(value) = non_empty_string(get(field)) {
            return Some(value);
        }
    }
    let first = non_empty_string(get("firstName"));
    let last = non_empty_string(get("lastName"));
    if first.is_some() || last.is_some() {
        return Some(
            [first, last]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    GENERIC_NAME_FIELDS
        .iter()
        .find_map(|field| non_empty_string(get(field)))
}

/// `stripModulePrefix`: `project_task` → `task`.
fn strip_module_prefix(entity_type: &str) -> &str {
    MODULE_PREFIXES
        .iter()
        .find_map(|prefix| entity_type.strip_prefix(prefix))
        .unwrap_or(entity_type)
}

/// `actionPhrase(action)`: how an action reads after "was".
pub fn action_phrase(action: &str) -> String {
    let known = match action {
        "created" => "created",
        "updated" => "updated",
        "deleted" => "deleted",
        "archived" => "archived",
        "unarchived" | "restored" => "restored",
        "won" => "marked as won",
        "lost" => "marked as lost",
        "stage_changed" => "moved to another stage",
        "status_changed" => "given another status",
        "priority_changed" => "given another priority",
        "state_changed" => "given another state",
        "converted" => "converted",
        "qualified" => "qualified",
        "completed" => "completed",
        "assigned" => "assigned",
        "escalated" => "escalated",
        "resolved" => "resolved",
        "closed" => "closed",
        "tagged" => "tagged",
        "sent" => "sent",
        "paid" => "marked as paid",
        "moved" => "moved",
        _ => {
            // `action.replaceAll(/[_-]+/g, ' ').trim()`
            let mut out = String::with_capacity(action.len());
            let mut in_run = false;
            for c in action.chars() {
                if c == '_' || c == '-' {
                    if !in_run {
                        out.push(' ');
                    }
                    in_run = true;
                } else {
                    out.push(c);
                    in_run = false;
                }
            }
            return js::trim(&out).to_owned();
        }
    };
    known.to_owned()
}

/// `humaniseFieldName`: `camelCase` / `snake_case` → `Camel Case` / `Snake Case`.
fn humanise_field_name(field: &str) -> String {
    let spaced: Vec<char> = field.replace('_', " ").chars().collect();
    // `([a-z])([A-Z])` → `$1 $2`, left to right, without overlap.
    let mut split = Vec::with_capacity(spaced.len() + 4);
    let mut i = 0;
    while i < spaced.len() {
        if i + 1 < spaced.len()
            && spaced[i].is_ascii_lowercase()
            && spaced[i + 1].is_ascii_uppercase()
        {
            split.extend([spaced[i], ' ', spaced[i + 1]]);
            i += 2;
        } else {
            split.push(spaced[i]);
            i += 1;
        }
    }
    // `\b\w` → upper case (ASCII word characters, as without the `u` flag).
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::with_capacity(split.len());
    let mut previous: Option<char> = None;
    for c in split {
        if word(c) && !previous.is_some_and(word) {
            out.push(c.to_ascii_uppercase());
        } else {
            out.push(c);
        }
        previous = Some(c);
    }
    out
}

/// `formatFieldList`: `Status, Priority, and Assignee`.
fn format_field_list(fields: &[String]) -> String {
    let names: Vec<String> = fields.iter().map(|f| humanise_field_name(f)).collect();
    match names.as_slice() {
        [one] => one.clone(),
        [a, b] => format!("{a} and {b}"),
        [init @ .., last] => format!("{}, and {last}", init.join(", ")),
        [] => String::new(),
    }
}

/// `capitalise`: the first character upper-cased.
fn capitalise(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `buildDescription(action, entityType, entityName, userName, changedFields)`.
pub fn build_description(
    action: &str,
    entity_type: &str,
    entity_name: Option<&str>,
    user_name: Option<&str>,
    changed_fields: Option<&[String]>,
) -> String {
    let display_type = strip_module_prefix(entity_type).replace('_', " ");
    let subject = entity_name.map_or_else(|| capitalise(&display_type), |name| format!("'{name}'"));
    let actor = user_name
        .filter(|name| !name.is_empty())
        .unwrap_or("System");
    if action == "updated" {
        return match changed_fields {
            Some(fields) if !fields.is_empty() => {
                format!("{actor} changed {}", format_field_list(fields))
            }
            _ => format!("{actor} updated {subject}"),
        };
    }
    format!("{subject} was {} by {actor}", action_phrase(action))
}

/// `transformChanges`: `{ old, new }` → `{ from, to }`. `None` for a change
/// that is `null`, where `value.old` throws in TypeScript and the row is not
/// written.
fn transform_changes(changes: &OrderedObject) -> Option<Map<String, Value>> {
    let mut out = Map::new();
    for (key, value) in &changes.0 {
        let entry = match value {
            Value::Null => return None,
            Value::Object(change) => {
                let mut entry = Map::new();
                if let Some(old) = change.get("old") {
                    entry.insert("from".to_owned(), old.clone());
                }
                if let Some(new) = change.get("new") {
                    entry.insert("to".to_owned(), new.clone());
                }
                entry
            }
            _ => Map::new(),
        };
        out.insert(key.clone(), Value::Object(entry));
    }
    Some(out)
}

/// What [`write_audit_log`] did (`'written' | 'duplicate'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditOutcome {
    Written,
    Duplicate,
}

/// Why [`write_audit_log`] wrote nothing.
pub type AuditError = Box<dyn std::error::Error + Send + Sync>;

/// `getUserName`: the member's name, `None` when missing, empty or the
/// lookup fails.
async fn user_name(db: &PgPool, user_id: Option<&str>) -> Option<String> {
    let user_id = user_id?;
    let name: Option<Option<String>> =
        sqlx::query_scalar("select name from workspace_members where user_id = $1 limit 1")
            .bind(user_id)
            .fetch_optional(db)
            .await
            .ok()?;
    name.flatten().filter(|name| !name.is_empty())
}

/// `writeAuditLogFromEvent(db, event)`. Fails when the row could not be
/// written; the caller decides between a lock wait and a retry.
pub async fn write_audit_log(db: &PgPool, event: &HubEvent) -> Result<AuditOutcome, AuditError> {
    let existing: Option<String> =
        sqlx::query_scalar("select id from audit_logs where metadata->>'eventId' = $1 limit 1")
            .bind(&event.id)
            .fetch_optional(db)
            .await?;
    if existing.is_some() {
        tracing::info!(event_id = event.id, "audit: skipping duplicate event");
        return Ok(AuditOutcome::Duplicate);
    }

    let data = event.data_value();
    let entity_name = entity_display_name(&event.entity_type, &data);
    let display_type = strip_module_prefix(&event.entity_type);
    let user_id = event.metadata.user_id.as_deref();
    let user_name = user_name(db, user_id).await;
    let changes = event.changes();
    let changed_fields = changes.as_ref().map(OrderedObject::keys);
    let description = build_description(
        &event.action,
        &event.entity_type,
        entity_name.as_deref(),
        user_name.as_deref(),
        changed_fields.as_deref(),
    );
    let transformed = match &changes {
        Some(changes) => Some(transform_changes(changes).ok_or("a change is null")?),
        None => None,
    };

    let mut translation_params = Map::new();
    translation_params.insert("entityType".to_owned(), json!(display_type));
    translation_params.insert("entityName".to_owned(), json!(entity_name));
    if let Some(fields) = &changed_fields {
        translation_params.insert("changedFields".to_owned(), json!(fields));
    }
    let mut metadata = Map::new();
    if let Some(source) = &event.metadata.source {
        metadata.insert("source".to_owned(), json!(source));
    }
    metadata.insert("workspaceId".to_owned(), json!(event.metadata.workspace_id));
    metadata.insert("eventId".to_owned(), json!(event.id));
    metadata.insert(
        "translationKey".to_owned(),
        json!(format!("audit.{}", event.action)),
    );
    metadata.insert(
        "translationParams".to_owned(),
        Value::Object(translation_params),
    );

    sqlx::query(
        "insert into audit_logs (id, entity_type, entity_id, action, description, changes, data, \
         performed_by, performed_by_name, metadata) \
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb)",
    )
    .bind(weldsuite_kit::generate_id("aud"))
    .bind(&event.entity_type)
    .bind(&event.entity_id)
    .bind(&event.action)
    .bind(description)
    .bind(transformed.map(|changes| Value::Object(changes).to_string()))
    .bind(event.data.as_ref().map(|raw| raw.get().to_owned()))
    .bind(user_id)
    .bind(user_name)
    .bind(Value::Object(metadata).to_string())
    .execute(db)
    .await?;
    Ok(AuditOutcome::Written)
}

/// The audit subscriber.
#[derive(Clone)]
pub struct AuditSubscriber {
    tenants: Arc<dyn Tenants>,
    /// Where each workspace's new audit rows are pushed on; `None` writes
    /// the rows only.
    streams: Option<AuditStreams>,
}

/// How long after a batch's writes its streams are flushed: the settle
/// window and a second (`STREAM_FLUSH_DELAY_MS`). A flush only reads rows
/// older than the window, so one that ran straight after the writes would
/// leave them behind until the workspace's next audit event.
pub const STREAM_FLUSH_DELAY: Duration = AUDIT_STREAM_SETTLE.saturating_add(Duration::from_secs(1));

/// What the push to a workspace's audit log streams needs: the sender and
/// the keyring that opens the collectors' tokens.
#[derive(Clone)]
struct AuditStreams {
    sender: AuditStreamSender,
    keyring: Keyring,
    /// The pause between a batch's writes and its flush.
    delay: Duration,
    /// The flushes on their way.
    pending: PendingStreamFlushes,
}

/// The delayed stream flushes that have not finished. The subscriber gives
/// each batch's flush a task of its own, so the batch is answered at once;
/// [`PendingStreamFlushes::settled`] waits for them, which `consume` does
/// before it stops: a flush dropped there would leave the batch's rows
/// behind until the workspace's next audit event.
#[derive(Clone, Default)]
pub struct PendingStreamFlushes {
    inner: Arc<Pending>,
}

#[derive(Default)]
struct Pending {
    running: AtomicUsize,
    idle: Notify,
}

/// One flush on its way; counted out when it ends, however it ends.
struct Running(Arc<Pending>);

impl Drop for Running {
    fn drop(&mut self) {
        if self.0.running.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.idle.notify_waiters();
        }
    }
}

impl std::fmt::Debug for PendingStreamFlushes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingStreamFlushes")
            .field("running", &self.running())
            .finish()
    }
}

impl PendingStreamFlushes {
    /// How many flushes have not finished.
    pub fn running(&self) -> usize {
        self.inner.running.load(Ordering::Acquire)
    }

    /// Runs `flush` in a task of its own.
    fn spawn<F>(&self, flush: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.inner.running.fetch_add(1, Ordering::AcqRel);
        let running = Running(Arc::clone(&self.inner));
        tokio::spawn(async move {
            let _running = running;
            flush.await;
        });
    }

    /// Waits until no flush is on its way. Giving up on the wait leaves the
    /// flushes running.
    pub async fn settled(&self) {
        loop {
            let idle = self.inner.idle.notified();
            tokio::pin!(idle);
            // Listen before looking, so a flush that ends in between is not missed.
            idle.as_mut().enable();
            if self.running() == 0 {
                return;
            }
            idle.await;
        }
    }
}

impl std::fmt::Debug for AuditSubscriber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuditSubscriber").finish_non_exhaustive()
    }
}

impl AuditSubscriber {
    pub fn new(tenants: Arc<dyn Tenants>) -> Self {
        Self {
            tenants,
            streams: None,
        }
    }

    /// Also push each workspace's new audit rows to its audit log streams
    /// once a batch is written and its rows have settled
    /// (`flushStreamsForWorkspace`); `keyring` opens the collectors' tokens.
    #[must_use]
    pub fn with_streams(mut self, sender: AuditStreamSender, keyring: Keyring) -> Self {
        self.streams = Some(AuditStreams {
            sender,
            keyring,
            delay: STREAM_FLUSH_DELAY,
            pending: PendingStreamFlushes::default(),
        });
        self
    }

    /// Count the delayed flushes in `pending`, for the caller that waits for
    /// them before it stops. After [`AuditSubscriber::with_streams`].
    #[must_use]
    pub fn with_pending_stream_flushes(mut self, pending: PendingStreamFlushes) -> Self {
        if let Some(streams) = &mut self.streams {
            streams.pending = pending;
        }
        self
    }

    /// Another pause between a batch's writes and its flush than
    /// [`STREAM_FLUSH_DELAY`] (tests). After [`AuditSubscriber::with_streams`].
    #[must_use]
    pub fn with_stream_flush_delay(mut self, delay: Duration) -> Self {
        if let Some(streams) = &mut self.streams {
            streams.delay = delay;
        }
        self
    }

    /// The delayed flushes that have not finished; empty without streams.
    pub fn pending_stream_flushes(&self) -> PendingStreamFlushes {
        self.streams
            .as_ref()
            .map(|streams| streams.pending.clone())
            .unwrap_or_default()
    }

    /// `processEntityEvent` plus the batch processor's failure handling for
    /// one delivery. Writes the row only; the streams are flushed per batch
    /// ([`AuditSubscriber::flush_streams`]).
    pub async fn handle_one(&self, delivery: &Delivery) -> Disposition {
        self.process(delivery).await.0
    }

    /// One delivery: what to do with it and, when its event was written (or
    /// already had a row), the workspace it names.
    async fn process(&self, delivery: &Delivery) -> (Disposition, Option<String>) {
        let event = match HubEvent::parse(&delivery.payload) {
            Ok(event) => event,
            Err(error) => {
                tracing::error!(%error, subject = delivery.subject, "audit: not an entity event; dropped");
                return (Disposition::Ack, None);
            }
        };
        if event.metadata.workspace_id.is_empty() {
            tracing::warn!(
                event_id = event.id,
                "audit: event missing workspaceId, skipping"
            );
            return (Disposition::Ack, None);
        }
        let tenant = match self.tenants.tenant(&event.metadata.workspace_id).await {
            Ok(tenant) => tenant,
            Err(error) => {
                let retry = failed(
                    delivery,
                    &error,
                    format!("cannot resolve the workspace: {error}"),
                );
                return (retry, None);
            }
        };
        match write_audit_log(&tenant.db, &event).await {
            Ok(_) => (Disposition::Ack, Some(event.metadata.workspace_id)),
            Err(error) => {
                let retry = failed(
                    delivery,
                    error.as_ref(),
                    format!("failed to write the audit log: {error}"),
                );
                (retry, None)
            }
        }
    }

    /// `flushWorkspaceStreams`: one flush per workspace a batch wrote for,
    /// side by side; a failure of one never touches another, and none fails
    /// into the caller. `workspaces` are the events' own references, which
    /// an event whose row carries no `metadata.workspaceId` is sent with.
    ///
    /// Each flush is `flushStreamsForWorkspace`: a workspace without an
    /// active stream is done after one small query; one that has a stream
    /// waits out the delay first, so the rows the batch just wrote are older
    /// than the settle window when it reads them. The time of the flush is
    /// taken after that wait.
    ///
    /// Log lines name the workspace and the stream only: an error's text can
    /// quote a connection string or what a destination answered.
    pub async fn flush_streams(&self, workspaces: &[String]) {
        let Some(streams) = &self.streams else {
            return;
        };
        join_all(workspaces.iter().map(|workspace| async move {
            let Ok(tenant) = self.tenants.tenant(workspace).await else {
                tracing::error!(
                    workspace_id = workspace,
                    "audit: stream flush skipped, the workspace does not resolve"
                );
                return;
            };
            if !has_active_audit_log_streams(&tenant.db).await {
                return;
            }
            tokio::time::sleep(streams.delay).await;
            let options = FlushOptions {
                keyring: &streams.keyring,
                workspace_id: Some(workspace),
                now: OffsetDateTime::now_utc(),
            };
            for result in flush_audit_log_streams(&tenant.db, &streams.sender, &options).await {
                if result.outcome == FlushOutcome::Failed {
                    tracing::warn!(
                        workspace_id = workspace,
                        stream_id = result.stream_id,
                        "audit: stream delivery failed"
                    );
                }
            }
        }))
        .await;
    }
}

/// The batch processor's answer to a failed event: a tenant database locked
/// by a move waits (within its budget), anything else is retried.
fn failed(
    delivery: &Delivery,
    error: &(dyn std::error::Error + 'static),
    reason: String,
) -> Disposition {
    if is_tenant_locked(error) && delivery.deferrals < LOCKED_MAX_RETRIES {
        return Disposition::Defer {
            delay: locked_retry_delay(delivery.deferrals + 1),
            reason: "the tenant database is locked (a database move?)".to_owned(),
        };
    }
    Disposition::retry(reason)
}

impl BatchHandler for AuditSubscriber {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(batch.len());
            // The workspaces the batch wrote for, once each.
            let mut written: Vec<String> = Vec::new();
            for delivery in batch {
                let (disposition, workspace) = self.process(delivery).await;
                if let Some(workspace) = workspace
                    && !written.contains(&workspace)
                {
                    written.push(workspace);
                }
                out.push(disposition);
            }
            // Every delivery has its answer. The flushes wait for the settle
            // window, so they run behind the batch (`ctx.waitUntil`).
            if let Some(streams) = &self.streams
                && !written.is_empty()
            {
                let subscriber = self.clone();
                streams
                    .pending
                    .spawn(async move { subscriber.flush_streams(&written).await });
            }
            out
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locked_delays_double_to_fifteen_minutes() {
        let delays: Vec<u64> = (1..=6).map(|n| locked_retry_delay(n).as_secs()).collect();
        assert_eq!(delays, vec![60, 120, 240, 480, 900, 900]);
    }

    #[test]
    fn streams_are_flushed_a_second_after_the_settle_window() {
        assert_eq!(AUDIT_STREAM_SETTLE, Duration::from_secs(5));
        assert_eq!(STREAM_FLUSH_DELAY, Duration::from_secs(6));
    }

    #[tokio::test]
    async fn pending_flushes_run_behind_the_caller_and_can_be_waited_for() {
        let pending = PendingStreamFlushes::default();
        // Nothing on its way: no wait.
        pending.settled().await;

        let done = Arc::new(AtomicUsize::new(0));
        for _ in 0..3 {
            let done = Arc::clone(&done);
            pending.spawn(async move {
                tokio::time::sleep(Duration::from_millis(60)).await;
                done.fetch_add(1, Ordering::AcqRel);
            });
        }
        // Handed over, not awaited.
        assert_eq!(pending.running(), 3);
        assert_eq!(done.load(Ordering::Acquire), 0);

        // Giving up on the wait leaves them running.
        let gave_up = tokio::time::timeout(Duration::from_millis(5), pending.settled()).await;
        assert!(gave_up.is_err());
        assert_eq!(pending.running(), 3);

        pending.settled().await;
        assert_eq!(done.load(Ordering::Acquire), 3);
        assert_eq!(pending.running(), 0);
    }

    #[tokio::test]
    async fn a_subscriber_shares_the_pending_flushes_it_is_given() {
        let tenants: Arc<dyn Tenants> = Arc::new(crate::tenants::StaticTenants::default());
        let without = AuditSubscriber::new(Arc::clone(&tenants));
        assert_eq!(without.pending_stream_flushes().running(), 0);

        let pending = PendingStreamFlushes::default();
        let sender = AuditStreamSender::new(false).expect("a client");
        let with = AuditSubscriber::new(tenants)
            .with_streams(sender, Keyring { v1: None, v2: None })
            .with_pending_stream_flushes(pending.clone())
            .with_stream_flush_delay(Duration::ZERO);
        pending.spawn(std::future::pending());
        assert_eq!(with.pending_stream_flushes().running(), 1);

        // A batch that wrote nothing has nothing to flush: no task, and the
        // answer does not wait for one.
        let dispositions = with.handle(&[]).await;
        assert_eq!(dispositions.len(), 0);
        assert_eq!(pending.running(), 1);
    }

    #[test]
    fn descriptions_read_like_typescripts() {
        assert_eq!(
            build_description(
                "stage_changed",
                "opportunity",
                Some("Zeta renewal deal"),
                Some("Jane"),
                None
            ),
            "'Zeta renewal deal' was moved to another stage by Jane"
        );
        assert_eq!(
            build_description("lost", "opportunity", Some("Zeta"), None, None),
            "'Zeta' was marked as lost by System"
        );
        assert_eq!(
            build_description(
                "some_new_thing",
                "opportunity",
                Some("Zeta"),
                Some("Jane"),
                None
            ),
            "'Zeta' was some new thing by Jane"
        );
        let fields = [
            "status".to_owned(),
            "priority".to_owned(),
            "assigneeId".to_owned(),
        ];
        assert_eq!(
            build_description(
                "updated",
                "project_task",
                Some("Fix"),
                Some("Jane"),
                Some(&fields)
            ),
            "Jane changed Status, Priority, and Assignee Id"
        );
        assert_eq!(
            build_description("created", "project_task", None, None, None),
            "Task was created by System"
        );
    }

    #[test]
    fn display_names_follow_the_field_lists() {
        assert_eq!(
            entity_display_name(
                "contact",
                &json!({ "firstName": "Jane", "lastName": "Doe" })
            )
            .as_deref(),
            Some("Jane Doe")
        );
        assert_eq!(
            entity_display_name("vat_return", &json!({ "periodLabel": "Q3 2026" })).as_deref(),
            Some("Q3 2026")
        );
        assert_eq!(
            entity_display_name("invoice", &json!({ "invoiceNumber": 1001 })).as_deref(),
            Some("1001")
        );
        assert_eq!(entity_display_name("company", &Value::Null), None);
    }
}
