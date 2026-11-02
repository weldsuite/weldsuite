//! WeldChat rules other modules share, from `@weldsuite/chat-domain`
//! (`packages/domains/chat`): who may read a channel ([`access`]), the record
//! chat providers that decide it for record chats ([`entity`]), channel
//! creation and membership ([`members`]), the multi-agent room policy
//! ([`policy`]), and the realtime payloads WeldChat publishes ([`publish`]).
//!
//! chat-api (`weldsuite-chat`) is built on all of it; meet, connect, agent
//! and app-api read the access rules and the publishers when they are ported.

pub mod access;
pub mod agents;
pub mod entity;
mod flow;
pub mod members;
pub mod policy;
pub mod publish;
pub mod text;

pub use access::{
    Can, can_access_channel, can_access_message, get_channel_role, is_channel_moderator,
    unreadable_record_chat_ids,
};
pub use publish::Realtime;
