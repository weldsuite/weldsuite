//! WeldDesk's shared rules: what the desk API (`weldsuite-desk`), the
//! helpdesk widget API and the helpdesk workflow engine all need. One Rust
//! module per TypeScript source it mirrors, named in each module's docs:
//!
//! - [`webchat`] (`@weldsuite/db/lib/desk`): the webchat inbox, i.e.
//!   `desk_conversations`, `desk_messages` and `desk_visitors`. The only
//!   writer of a conversation's state, waiting time and last message.
//! - [`assignment`] (`@weldsuite/db/lib/desk-assignment`): handing an open,
//!   unowned conversation to a teammate when the workspace has it on.
//! - [`assignment_router`] (`helpdesk-workflow-worker`'s `AssignmentRouter`
//!   Durable Object): the per-workspace rotation and recent picks behind
//!   that, on a `LedgerStore` (Valkey).
//! - [`email`] (`@weldsuite/db/lib/desk`, the email channel): a customer
//!   email starts a conversation or continues the one it threads into.
//! - [`phone`] (`@weldsuite/db/lib/desk`, the phone channel): an inbound
//!   call starts a conversation or continues the caller's open one.
//! - [`table`]: writing a JSON object into a table the way Drizzle does,
//!   through the table's entity, for the webchat tables here and the desk
//!   crate's generated ones.
//! - [`realtime`] (`desk-api/src/services/realtime/helpdesk-publisher.ts`
//!   and the `RealtimePublisher` conversation calls): the helpdesk
//!   conversation room payloads.
//! - [`http`]: the third-party HTTP calls (Discord, Slack) as a port.
//! - [`notify`] (`@weldsuite/notifications` `helpers/helpdesk.ts`): whether
//!   and what to notify on an assignment or a customer reply.
//! - [`attributes`] (`updateDeskConversationAttributes` of
//!   `@weldsuite/db/lib/desk`): a conversation's ticket fields, as any author.
//! - [`links`] (`@weldsuite/db/lib/desk-links`): parent/child links, major
//!   incidents and merging duplicates; [`webchat::append`] follows a merge.
//! - [`problems`] (`@weldsuite/db/lib/desk-problems`): problem management,
//!   i.e. the cause behind one or more incidents, its status and known-error
//!   rules, and linking incidents to it.
//! - [`catalog`] (`@weldsuite/db/lib/desk-catalog`): the service catalogue,
//!   i.e. request items with their form, approval steps and fulfilment
//!   tasks, making a conversation a request and deciding its approvals.
//! - [`fulfilment`] (`@weldsuite/desk-domain/catalog`): what a service
//!   request does after the rows change, i.e. its WeldFlow tasks and the
//!   approver's notification.
//! - [`priority_matrix`] (`@weldsuite/db/lib/desk-priority-matrix`): ITIL
//!   impact × urgency → priority, which [`attributes`] applies.
//! - [`inbox`] (`@weldsuite/desk-domain/inbox`): the inbox for writers
//!   outside it (workflows, the public API): `ingestDeskApi`, assignment,
//!   notifications and the inbox events.
//! - [`routing`] (`@weldsuite/db/lib/desk-routing`): the workspace's routing
//!   rules, applied when a conversation opens or its type or tags change.
//! - [`escalation`] (`@weldsuite/db/lib/desk-escalation*`): a team's
//!   escalation rules, when they come due and what firing one does.
//! - [`report_schedule`] (`desk-api/src/services/desk-report-schedules.ts`,
//!   `nextReportRun`): when a scheduled report email runs next, in its own
//!   time zone.
//! - [`sla`] (`@weldsuite/db/lib/desk-sla`): the SLA engine. Clocks per
//!   conversation, derived from the timeline and the matching policy on
//!   [`sla_calendar`]'s business time (`desk-sla-calendar`); every write
//!   that can move one re-derives it (`append`).
//! - [`workflow`]: the helpdesk workflow engine (`helpdesk-workflow-worker`):
//!   the port the desk API reaches it through (the `HELPDESK_WORKFLOW`
//!   service binding), its in-process implementation, the step handlers and
//!   the `ConversationWorkflow` as the `desk.conversation-workflow` job.
//!
//! - [`articles`] (`@weldsuite/db/lib/desk-articles`): who may read a
//!   help-center article or announcement, article search, language versions
//!   and help-center links.
//!
//! Small on purpose: add what a ported route uses, with the TypeScript
//! function it mirrors named in its doc comment. Queries go through the
//! SeaORM entities of `weldsuite-schema` (ADR DATA-019); the few statements
//! that stay SQL say why on their function.

pub mod articles;
pub mod assignment;
pub mod assignment_router;
pub mod attributes;
pub mod catalog;
pub mod email;
pub mod escalation;
pub mod fulfilment;
pub mod http;
pub mod inbox;
pub mod links;
pub mod list;
pub mod notify;
pub mod phone;
pub mod priority_matrix;
pub mod problems;
pub mod realtime;
pub mod report_schedule;
pub mod routing;
pub mod sla;
pub mod sla_calendar;
pub mod table;
pub mod webchat;
pub mod workflow;

/// `upper(column) = value`. (`ExprTrait` stays unimported in this crate: it
/// would shadow `serde_json::Value::is_null` and `str::eq`.)
pub(crate) fn upper_is(
    column: impl sea_orm::sea_query::IntoColumnRef,
    value: &str,
) -> sea_orm::sea_query::Expr {
    use sea_orm::sea_query::{Expr, Func};
    sea_orm::ExprTrait::eq(Expr::from(Func::upper(Expr::col(column))), value)
}

/// An entity's model as Drizzle returned the row (its serde shape).
pub(crate) fn row<T: serde::Serialize>(model: T) -> serde_json::Value {
    serde_json::to_value(model).unwrap_or(serde_json::Value::Null)
}

/// A time value as a `timestamp` column holds it (`new Date(ms)` written by
/// Drizzle): UTC, to the millisecond.
pub(crate) fn at_ms(ms: i64) -> time::PrimitiveDateTime {
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    weldsuite_db::utc_timestamp(at)
}

/// `column->>'key'` of a `jsonb` value read whole: a string as itself, null
/// or a missing key as `None`, anything else as its JSON text.
pub(crate) fn json_text(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

/// A `timestamp` column as a time value, as `new Date(value).getTime()`
/// reads Drizzle's: milliseconds since the epoch in UTC, the microseconds
/// dropped.
pub(crate) fn epoch_ms(at: time::PrimitiveDateTime) -> i64 {
    let nanos = at.assume_utc().unix_timestamp_nanos();
    i64::try_from(nanos.div_euclid(1_000_000)).unwrap_or(i64::MAX)
}
