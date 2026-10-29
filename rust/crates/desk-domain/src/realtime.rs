//! Helpdesk realtime payloads: what `RealtimePublisher.conversationMessage`,
//! `conversationSystem` and `conversationPublish` POST to the realtime
//! worker's `/publish/conversation/:id` (`packages/core/realtime/src/server/publisher.ts`),
//! built as [`weldsuite_ports::RealtimeMessage`]s for the realtime port.
