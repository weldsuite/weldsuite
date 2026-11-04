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

/// A room's recorder and post-meeting AI settings (`RtkMeetingOptions` of
/// `@weldsuite/cloudflare-realtime`): `RealtimeKit`'s own recorder, transcript
/// and summary. Every field is opt-in; `None`/`false` leaves it out of the
/// request. Providers without them (`LiveKit`) ignore them on create.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RoomOptions {
    /// Start recording as soon as someone joins.
    pub record_on_start: Option<bool>,
    /// Also export an audio-only MP3 next to the video (create only).
    pub audio_export: bool,
    pub transcribe_on_end: Option<bool>,
    pub summarize_on_end: Option<bool>,
    /// A `RealtimeKit` transcription language (`en-US`, `nl`, …); `None`
    /// auto-detects.
    pub transcription_language: Option<String>,
    /// `plain_text` or `markdown`.
    pub summary_text_format: Option<String>,
}

/// A webhook registration (`upsertWebhook`'s params).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookRegistration {
    pub name: String,
    pub url: String,
    pub events: Vec<String>,
    pub enabled: bool,
}

/// What `upsertWebhook` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookUpserted {
    pub id: Option<String>,
    /// `created` or `updated`.
    pub action: &'static str,
    pub removed_duplicates: u32,
}

/// The video provider.
pub trait DynVideoRooms: Send + Sync {
    /// Create a room; its id.
    fn create_room<'a>(&'a self, title: &'a str) -> BoxFuture<'a, Result<String, VideoError>>;

    /// Create a room with recorder / AI settings ([`RoomOptions`]); its id.
    /// Providers without those settings create a plain room.
    fn create_room_with<'a>(
        &'a self,
        title: &'a str,
        options: &'a RoomOptions,
    ) -> BoxFuture<'a, Result<String, VideoError>> {
        let _ = options;
        self.create_room(title)
    }

    /// Change a room's recorder / AI settings (`updateMeeting`). Providers
    /// without them refuse.
    fn update_room<'a>(
        &'a self,
        room_id: &'a str,
        options: &'a RoomOptions,
    ) -> BoxFuture<'a, Result<(), VideoError>> {
        let _ = (room_id, options);
        Box::pin(std::future::ready(Err(VideoError::new(
            None,
            "This video provider has no recorder or meeting AI settings",
        ))))
    }

    /// The provider's recordings of a room (`getRecordings`), each the
    /// object `@weldsuite/cloudflare-realtime`'s `toRecording` builds
    /// (`id`, `status`, `download_url`, `file_size`, …). Providers without a
    /// recorder report none.
    fn list_recordings<'a>(
        &'a self,
        room_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<serde_json::Value>, VideoError>> {
        let _ = room_id;
        Box::pin(std::future::ready(Ok(Vec::new())))
    }

    /// Register the webhook receiver (`upsertWebhook`): overwrite the one
    /// with this URL, else create one. Providers whose webhooks are server
    /// configuration refuse.
    fn upsert_webhook<'a>(
        &'a self,
        registration: &'a WebhookRegistration,
    ) -> BoxFuture<'a, Result<WebhookUpserted, VideoError>> {
        let _ = registration;
        Box::pin(std::future::ready(Err(VideoError::new(
            None,
            "This video provider's webhooks are configured on its server",
        ))))
    }

    /// Create the participant presets the join preset names refer to
    /// (`seedPresets`). Providers without presets have nothing to do.
    fn seed_presets(&self) -> BoxFuture<'_, Result<(), VideoError>> {
        Box::pin(std::future::ready(Ok(())))
    }

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
