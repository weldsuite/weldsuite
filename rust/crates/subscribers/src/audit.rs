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
//!   (EVT-002), and never fails the message: a write error is logged and the
//!   event acked, as in TypeScript. Because the tenant pool connects lazily,
//!   as Neon's HTTP driver does, a locked database surfaces in the write and
//!   is therefore acked too; the lock wait above only covers a lookup that
//!   fails with the lock's error. Same in both backends.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_ports::{BatchHandler, BoxFuture, Delivery, Disposition};

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

/// What [`write_audit_log`] did (`'written' | 'duplicate' | 'error'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditOutcome {
    Written,
    Duplicate,
    Error,
}

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

/// `writeAuditLogFromEvent(db, event)`. Never fails: errors are logged and
/// reported as [`AuditOutcome::Error`].
pub async fn write_audit_log(db: &PgPool, event: &HubEvent) -> AuditOutcome {
    match try_write(db, event).await {
        Ok(outcome) => outcome,
        Err(error) => {
            tracing::error!(event_id = event.id, %error, "audit: failed to write audit log");
            AuditOutcome::Error
        }
    }
}

async fn try_write(
    db: &PgPool,
    event: &HubEvent,
) -> Result<AuditOutcome, Box<dyn std::error::Error + Send + Sync>> {
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
}

impl std::fmt::Debug for AuditSubscriber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuditSubscriber").finish_non_exhaustive()
    }
}

impl AuditSubscriber {
    pub fn new(tenants: Arc<dyn Tenants>) -> Self {
        Self { tenants }
    }

    /// `processEntityEvent` plus the batch processor's failure handling for
    /// one delivery.
    pub async fn handle_one(&self, delivery: &Delivery) -> Disposition {
        let event = match HubEvent::parse(&delivery.payload) {
            Ok(event) => event,
            Err(error) => {
                tracing::error!(%error, subject = delivery.subject, "audit: not an entity event; dropped");
                return Disposition::Ack;
            }
        };
        if event.metadata.workspace_id.is_empty() {
            tracing::warn!(
                event_id = event.id,
                "audit: event missing workspaceId, skipping"
            );
            return Disposition::Ack;
        }
        let tenant = match self.tenants.tenant(&event.metadata.workspace_id).await {
            Ok(tenant) => tenant,
            Err(error) => {
                if is_tenant_locked(&error) && delivery.deferrals < LOCKED_MAX_RETRIES {
                    let delay = locked_retry_delay(delivery.deferrals + 1);
                    return Disposition::Defer {
                        delay,
                        reason: "the tenant database is locked (a database move?)".to_owned(),
                    };
                }
                return Disposition::retry(format!("cannot resolve the workspace: {error}"));
            }
        };
        write_audit_log(&tenant.db, &event).await;
        Disposition::Ack
    }
}

impl BatchHandler for AuditSubscriber {
    fn handle<'a>(&'a self, batch: &'a [Delivery]) -> BoxFuture<'a, Vec<Disposition>> {
        Box::pin(async move {
            let mut out = Vec::with_capacity(batch.len());
            for delivery in batch {
                out.push(self.handle_one(delivery).await);
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
