//! WeldChat rules other modules share, from `@weldsuite/chat-domain`
//! (`packages/domains/chat`): who may read a channel ([`access`]), the record
//! chat providers that decide it for record chats ([`entity`]), channel
//! creation and membership ([`members`]), the multi-agent room policy
//! ([`policy`]), the realtime payloads WeldChat publishes ([`publish`]), and
//! the call lifecycle chat-api's call routes and meet's video webhooks share
//! ([`calls`]).
//!
//! chat-api (`weldsuite-chat`) is built on all of it; meet, connect, agent
//! and app-api read the access rules and the publishers when they are ported.

pub mod access;
pub mod agents;
pub mod books_records;
pub mod calls;
pub mod entity;
mod flow;
pub mod members;
pub mod policy;
pub mod publish;
pub mod questions;
pub mod system_message;
pub mod text;

pub use access::{
    Can, can_access_channel, can_access_message, get_channel_role, is_channel_moderator,
    unreadable_record_chat_ids,
};
pub use publish::Realtime;

use sea_orm::DbErr;
use time::PrimitiveDateTime;

/// A row the entity serialized (Drizzle's JSON) that would not serialize.
#[allow(
    clippy::needless_pass_by_value,
    reason = "the `map_err` callback of `serde_json::to_value`"
)]
pub(crate) fn json_error(error: serde_json::Error) -> DbErr {
    DbErr::Json(error.to_string())
}

/// `$n::timestamp` of a `toISOString()` the caller wrote: Postgres reads its
/// date and time and ignores the zone. A text Postgres can't read is the
/// failed cast.
pub(crate) fn timestamp_of(iso: &str) -> Result<PrimitiveDateTime, DbErr> {
    let at = time::OffsetDateTime::parse(iso, &time::format_description::well_known::Rfc3339)
        .map_err(|_| {
            DbErr::Type(format!(
                "invalid input syntax for type timestamp: \"{iso}\""
            ))
        })?;
    Ok(PrimitiveDateTime::new(at.date(), at.time()))
}
