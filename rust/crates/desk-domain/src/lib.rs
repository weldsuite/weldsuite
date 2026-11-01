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
//!   for the webchat tables here and the desk crate's generated ones.
//! - [`realtime`] (`desk-api/src/services/realtime/helpdesk-publisher.ts`
//!   and the `RealtimePublisher` conversation calls): the helpdesk
//!   conversation room payloads.
//! - [`http`]: the third-party HTTP calls (Discord, Slack) as a port.
//! - [`notify`] (`@weldsuite/notifications` `helpers/helpdesk.ts`): whether
//!   and what to notify on an assignment or a customer reply.
//! - [`workflow`]: the helpdesk workflow engine (`helpdesk-workflow-worker`):
//!   the port the desk API reaches it through (the `HELPDESK_WORKFLOW`
//!   service binding), its in-process implementation, the step handlers and
//!   the `ConversationWorkflow` as the `desk.conversation-workflow` job.
//!
//! Small on purpose: add what a ported route uses, with the TypeScript
//! function it mirrors named in its doc comment.

pub mod assignment;
pub mod assignment_router;
pub mod email;
pub mod http;
pub mod notify;
pub mod phone;
pub mod realtime;
pub mod table;
pub mod webchat;
pub mod workflow;
