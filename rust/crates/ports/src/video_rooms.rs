//! Video rooms: the provider behind WeldChat calls (and WeldMeet). The
//! Global edition uses Cloudflare RealtimeKit (`@weldsuite/cloudflare-realtime`);
//! the Kubernetes editions LiveKit. A room is a RealtimeKit meeting or a
//! LiveKit room; joining one mints a participant token the client connects
//! with.
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
    /// The provider's participant id.
    pub participant_id: String,
    pub token: String,
}

/// Who joins (`addParticipant`'s params).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewParticipant {
    pub name: String,
    /// Our id for them (the WeldSuite user id); webhooks echo it back.
    pub custom_participant_id: String,
    /// RealtimeKit preset (`group_call_host`); LiveKit maps it to grants.
    pub preset_name: Option<String>,
    pub picture: Option<String>,
}

/// A participant connected to a room right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveParticipant {
    pub participant_id: String,
    pub custom_participant_id: Option<String>,
    pub name: Option<String>,
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

    /// Remove a participant (revoke their token).
    fn remove_participant<'a>(
        &'a self,
        room_id: &'a str,
        participant_id: &'a str,
    ) -> BoxFuture<'a, Result<(), VideoError>>;

    /// Who is connected now.
    fn live_participants<'a>(
        &'a self,
        room_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<LiveParticipant>, VideoError>>;

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
