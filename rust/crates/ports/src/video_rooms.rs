//! Video rooms: the provider behind `WeldChat` calls (and `WeldMeet`). The
//! Global edition uses Cloudflare `RealtimeKit` (`@weldsuite/cloudflare-realtime`);
//! the Kubernetes editions `LiveKit`. A room is a `RealtimeKit` meeting or a
//! `LiveKit` room; adding a participant mints the token their client joins
//! with. Adapters: `weldsuite-video-rooms`.
//!
//! Reach it through the request's [`VideoRoomsProvider`] extension when
//! there is one (conformance), else the app's.

use std::sync::Arc;

use crate::BoxFuture;

/// Why a provider call failed. `status` is the provider's HTTP status when
/// it answered (a 400 or 422 means it refused the request's body).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoError {
    pub status: Option<u16>,
    pub message: String,
}

impl VideoError {
    pub fn new(status: Option<u16>, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for VideoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for VideoError {}

/// A participant added to a room, with the token their client joins with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinToken {
    /// The provider's participant id (`RealtimeKit`'s participant id, the
    /// `LiveKit` identity): what [`DynVideoRooms::remove_participant`] takes.
    pub participant_id: String,
    pub token: String,
}

/// Who joins (`addParticipant`'s params).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewParticipant {
    pub name: String,
    /// Our id for them (the `WeldSuite` user id); webhooks echo it back.
    pub custom_participant_id: String,
    /// `RealtimeKit` preset; `None` is the member preset.
    pub preset_name: Option<String>,
    pub picture: Option<String>,
}

/// A participant of a room: one that holds a token for it (`RealtimeKit`), or
/// one connected to it (`LiveKit`, whose tokens are not stored).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomParticipant {
    pub id: String,
    pub custom_participant_id: String,
    /// When the participant (its token) was created, ISO.
    pub created_at: String,
}

/// The video provider.
pub trait DynVideoRooms: Send + Sync {
    /// Create a room; its id.
    fn create_room<'a>(&'a self, title: &'a str) -> BoxFuture<'a, Result<String, VideoError>>;

    /// Add a participant: their id and join token.
    fn add_participant<'a>(
        &'a self,
        room_id: &'a str,
        participant: &'a NewParticipant,
    ) -> BoxFuture<'a, Result<JoinToken, VideoError>>;

    /// Remove a participant (revoke their token, drop their connection).
    fn remove_participant<'a>(
        &'a self,
        room_id: &'a str,
        participant_id: &'a str,
    ) -> BoxFuture<'a, Result<(), VideoError>>;

    /// Every participant of the room (see [`RoomParticipant`]).
    fn list_participants<'a>(
        &'a self,
        room_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<RoomParticipant>, VideoError>>;

    /// How many are connected right now; 0 when the room has no live session.
    /// An error means the provider could not tell.
    fn live_participant_count<'a>(
        &'a self,
        room_id: &'a str,
    ) -> BoxFuture<'a, Result<u32, VideoError>>;

    /// Disconnect these participants (by provider id).
    fn kick_participants<'a>(
        &'a self,
        room_id: &'a str,
        participant_ids: &'a [String],
    ) -> BoxFuture<'a, Result<(), VideoError>>;

    /// Disconnect everyone; how many were connected.
    fn kick_all<'a>(&'a self, room_id: &'a str) -> BoxFuture<'a, Result<u32, VideoError>>;

    /// Close the room for good.
    fn end_room<'a>(&'a self, room_id: &'a str) -> BoxFuture<'a, Result<(), VideoError>>;
}

/// The video provider a request uses.
#[derive(Clone)]
pub struct VideoRoomsProvider(pub Arc<dyn DynVideoRooms>);

impl std::fmt::Debug for VideoRoomsProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VideoRoomsProvider")
    }
}

/// No provider configured: every call fails, as `@weldsuite/cloudflare-realtime`
/// throws without its credentials, and callers treat it as a provider failure.
#[derive(Debug, Clone)]
pub struct UnconfiguredVideoRooms(pub String);

impl UnconfiguredVideoRooms {
    fn fail<T: Send + 'static>(&self) -> BoxFuture<'_, Result<T, VideoError>> {
        let message = self.0.clone();
        Box::pin(async move { Err(VideoError::new(None, message)) })
    }
}

impl DynVideoRooms for UnconfiguredVideoRooms {
    fn create_room<'a>(&'a self, _title: &'a str) -> BoxFuture<'a, Result<String, VideoError>> {
        self.fail()
    }

    fn add_participant<'a>(
        &'a self,
        _room_id: &'a str,
        _participant: &'a NewParticipant,
    ) -> BoxFuture<'a, Result<JoinToken, VideoError>> {
        self.fail()
    }

    fn remove_participant<'a>(
        &'a self,
        _room_id: &'a str,
        _participant_id: &'a str,
    ) -> BoxFuture<'a, Result<(), VideoError>> {
        self.fail()
    }

    fn list_participants<'a>(
        &'a self,
        _room_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<RoomParticipant>, VideoError>> {
        self.fail()
    }

    fn live_participant_count<'a>(
        &'a self,
        _room_id: &'a str,
    ) -> BoxFuture<'a, Result<u32, VideoError>> {
        self.fail()
    }

    fn kick_participants<'a>(
        &'a self,
        _room_id: &'a str,
        _participant_ids: &'a [String],
    ) -> BoxFuture<'a, Result<(), VideoError>> {
        self.fail()
    }

    fn kick_all<'a>(&'a self, _room_id: &'a str) -> BoxFuture<'a, Result<u32, VideoError>> {
        self.fail()
    }

    fn end_room<'a>(&'a self, _room_id: &'a str) -> BoxFuture<'a, Result<(), VideoError>> {
        self.fail()
    }
}
