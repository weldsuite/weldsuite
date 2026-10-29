//! The webchat inbox (`@weldsuite/db/lib/desk`, `packages/core/db/src/lib/desk.ts`):
//! `desk_conversations`, `desk_messages` and `desk_visitors`.
//!
//! `appendDeskMessage` is the only writer of a conversation's state, its
//! waiting time and its last message; the desk API, the widget API and the
//! phone transcript writer all go through it.
