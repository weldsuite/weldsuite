//! A self-hosted `LiveKit` server: rooms through its `RoomService` Twirp API
//! (`POST {api}/twirp/livekit.RoomService/<Method>`, JSON), participants as
//! access tokens (HS256 JWTs signed with the API secret) that the client
//! connects to `LIVEKIT_URL` with.
//!
//! How the port maps onto `LiveKit`:
//! - a room is created on the server with a random name (`ws-<hex>`); a
//!   participant connecting to a room that was emptied and closed opens it
//!   again, so a DM's long-lived room id keeps working;
//! - adding a participant mints a token and calls nothing: the participant id
//!   is the token's identity, `<customParticipantId>~<nonce>`, unique per
//!   token, so one person in two tabs is two participants as in `RealtimeKit`;
//!   the custom id is also in the token's attributes and metadata;
//! - tokens cannot be revoked: removing a participant disconnects them, and a
//!   token only works for `LIVEKIT_TOKEN_TTL_SECONDS` after it was minted;
//! - listing participants lists the connected ones (`ListParticipants`),
//!   created at the moment they joined;
//! - a missing room or participant (`not_found`) is an empty room, and
//!   removing what is not there succeeds.

use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use weldsuite_ports::video_rooms::{
    DynVideoRooms, JoinToken, NewParticipant, RoomParticipant, VideoError,
};
use weldsuite_ports::{BoxFuture, HttpRequest, OutboundHttp};

use crate::random_hex;

/// The server and its API key pair.
#[derive(Debug, Clone)]
pub struct LiveKitConfig {
    /// The server API base (`https://…`).
    pub api_url: String,
    pub api_key: String,
    pub api_secret: String,
    /// How long a join token can be used to connect.
    pub token_ttl: Duration,
}

impl LiveKitConfig {
    /// `LIVEKIT_URL` (or `LIVEKIT_API_URL`), `LIVEKIT_API_KEY`,
    /// `LIVEKIT_API_SECRET`, `LIVEKIT_TOKEN_TTL_SECONDS`; `None` without the
    /// URL or the key pair.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let value = |name: &str| get(name).filter(|value| !value.is_empty());
        let api_url = value("LIVEKIT_API_URL")
            .or_else(|| value("LIVEKIT_URL"))
            .map(|url| api_base(&url))?;
        let ttl = value("LIVEKIT_TOKEN_TTL_SECONDS")
            .and_then(|seconds| seconds.parse::<u64>().ok())
            .filter(|seconds| *seconds > 0)
            .unwrap_or(600);
        Some(Self {
            api_url,
            api_key: value("LIVEKIT_API_KEY")?,
            api_secret: value("LIVEKIT_API_SECRET")?,
            token_ttl: Duration::from_secs(ttl),
        })
    }
}

/// The API base for a server URL: `wss://` becomes `https://`, `ws://` `http://`.
fn api_base(url: &str) -> String {
    let url = url.trim_end_matches('/');
    if let Some(rest) = url.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = url.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        url.to_owned()
    }
}

/// The `LiveKit` adapter.
pub struct LiveKit {
    config: LiveKitConfig,
    http: OutboundHttp,
}

/// `video` grants of a `LiveKit` access token.
#[allow(clippy::struct_excessive_bools)]
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct VideoGrant<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    room: Option<&'a str>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    room_join: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    room_create: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    room_list: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    room_admin: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_publish: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_subscribe: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_publish_data: Option<bool>,
}

#[derive(Serialize)]
struct Claims<'a> {
    iss: &'a str,
    sub: &'a str,
    nbf: i64,
    exp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    jti: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attributes: Option<Value>,
    video: VideoGrant<'a>,
}

/// A Twirp error answer.
struct TwirpError {
    status: u16,
    code: String,
    message: String,
}

impl TwirpError {
    fn not_found(&self) -> bool {
        self.code == "not_found" || self.status == 404
    }

    fn into_video(self, what: &str) -> VideoError {
        VideoError::new(
            Some(self.status),
            format!(
                "Failed to {what}: {} {}:{}",
                self.status, self.code, self.message
            ),
        )
    }
}

impl LiveKit {
    pub fn new(config: LiveKitConfig, http: OutboundHttp) -> Self {
        Self { config, http }
    }

    fn sign(&self, claims: &Claims<'_>) -> Result<String, VideoError> {
        jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
            claims,
            &jsonwebtoken::EncodingKey::from_secret(self.config.api_secret.as_bytes()),
        )
        .map_err(|error| VideoError::new(None, format!("Failed to sign a LiveKit token: {error}")))
    }

    /// A short-lived server token for one room's administration.
    fn admin_token(&self, room: Option<&str>) -> Result<String, VideoError> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        self.sign(&Claims {
            iss: &self.config.api_key,
            sub: "weldsuite",
            nbf: now,
            exp: now + 600,
            jti: None,
            name: None,
            metadata: None,
            attributes: None,
            video: VideoGrant {
                room,
                room_create: true,
                room_list: true,
                room_admin: true,
                ..VideoGrant::default()
            },
        })
    }

    /// One `RoomService` call.
    async fn twirp(
        &self,
        method: &str,
        room: Option<&str>,
        body: &Value,
    ) -> Result<Value, TwirpError> {
        let token = self.admin_token(room).map_err(|error| TwirpError {
            status: 0,
            code: "internal".to_owned(),
            message: error.message,
        })?;
        let request = HttpRequest::json(
            "POST",
            format!("{}/twirp/livekit.RoomService/{method}", self.config.api_url),
            body,
        )
        .header("authorization", format!("Bearer {token}"));
        let response = self.http.send(request).await.map_err(|error| TwirpError {
            status: 0,
            code: "unavailable".to_owned(),
            message: error.to_string(),
        })?;
        let answer = response.json();
        if response.ok() {
            return Ok(answer);
        }
        Err(TwirpError {
            status: response.status,
            code: answer["code"].as_str().unwrap_or("unknown").to_owned(),
            message: answer["msg"]
                .as_str()
                .map_or_else(|| response.text(), str::to_owned),
        })
    }

    /// The room's connected participants (`ParticipantInfo`), none when the
    /// room does not exist.
    async fn connected(&self, room: &str) -> Result<Vec<Value>, VideoError> {
        match self
            .twirp("ListParticipants", Some(room), &json!({ "room": room }))
            .await
        {
            Ok(answer) => Ok(answer["participants"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(is_connected_person)
                .collect()),
            Err(error) if error.not_found() => Ok(Vec::new()),
            Err(error) => Err(error.into_video("list LiveKit participants")),
        }
    }

    async fn remove(&self, room: &str, identity: &str) -> Result<(), VideoError> {
        match self
            .twirp(
                "RemoveParticipant",
                Some(room),
                &json!({ "room": room, "identity": identity }),
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(error) if error.not_found() => Ok(()),
            Err(error) => Err(error.into_video("remove LiveKit participant")),
        }
    }
}

/// A participant still connected (state not `DISCONNECTED`), who is a person
/// rather than a recorder (kind `EGRESS`). Protobuf JSON writes enums as
/// names or numbers.
fn is_connected_person(participant: &Value) -> bool {
    let disconnected = match &participant["state"] {
        Value::String(state) => state == "DISCONNECTED",
        Value::Number(state) => state.as_u64() == Some(3),
        _ => false,
    };
    let egress = match &participant["kind"] {
        Value::String(kind) => kind == "EGRESS",
        Value::Number(kind) => kind.as_u64() == Some(2),
        _ => false,
    };
    !disconnected && !egress
}

/// The custom id a participant was given: its attribute, else the identity
/// up to the nonce.
fn custom_id_of(participant: &Value) -> String {
    participant["attributes"]["customParticipantId"]
        .as_str()
        .map_or_else(
            || {
                let identity = participant["identity"].as_str().unwrap_or_default();
                identity
                    .rsplit_once('~')
                    .map_or(identity, |(custom, _)| custom)
                    .to_owned()
            },
            str::to_owned,
        )
}

/// `joined_at` (seconds, an int64 that protobuf JSON may quote) as ISO.
fn joined_at(participant: &Value) -> String {
    let seconds = match &participant["joined_at"] {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.parse::<i64>().ok(),
        _ => None,
    };
    seconds
        .and_then(|s| OffsetDateTime::from_unix_timestamp(s).ok())
        .and_then(|at| at.format(&Rfc3339).ok())
        .unwrap_or_default()
}

impl DynVideoRooms for LiveKit {
    fn create_room<'a>(&'a self, title: &'a str) -> BoxFuture<'a, Result<String, VideoError>> {
        Box::pin(async move {
            let name = format!("ws-{}", random_hex(12));
            let body = json!({
                "name": name,
                "empty_timeout": 300,
                "departure_timeout": 20,
                "metadata": json!({ "title": title }).to_string(),
            });
            self.twirp("CreateRoom", None, &body)
                .await
                .map_err(|error| error.into_video("create LiveKit room"))?;
            Ok(name)
        })
    }

    fn add_participant<'a>(
        &'a self,
        room_id: &'a str,
        participant: &'a NewParticipant,
    ) -> BoxFuture<'a, Result<JoinToken, VideoError>> {
        Box::pin(async move {
            let identity = format!("{}~{}", participant.custom_participant_id, random_hex(6));
            let now = OffsetDateTime::now_utc().unix_timestamp();
            let ttl = i64::try_from(self.config.token_ttl.as_secs()).unwrap_or(600);
            let mut metadata = json!({ "customParticipantId": participant.custom_participant_id });
            if let Some(picture) = participant.picture.as_deref().filter(|p| !p.is_empty()) {
                metadata["picture"] = Value::from(picture);
            }
            let token = self.sign(&Claims {
                iss: &self.config.api_key,
                sub: &identity,
                nbf: now,
                exp: now + ttl,
                jti: Some(&identity),
                name: Some(&participant.name),
                metadata: Some(metadata.to_string()),
                attributes: Some(
                    json!({ "customParticipantId": participant.custom_participant_id }),
                ),
                video: VideoGrant {
                    room: Some(room_id),
                    room_join: true,
                    can_publish: Some(true),
                    can_subscribe: Some(true),
                    can_publish_data: Some(true),
                    ..VideoGrant::default()
                },
            })?;
            Ok(JoinToken {
                participant_id: identity,
                token,
            })
        })
    }

    fn remove_participant<'a>(
        &'a self,
        room_id: &'a str,
        participant_id: &'a str,
    ) -> BoxFuture<'a, Result<(), VideoError>> {
        Box::pin(self.remove(room_id, participant_id))
    }

    fn list_participants<'a>(
        &'a self,
        room_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<RoomParticipant>, VideoError>> {
        Box::pin(async move {
            Ok(self
                .connected(room_id)
                .await?
                .iter()
                .map(|p| RoomParticipant {
                    id: p["identity"].as_str().unwrap_or_default().to_owned(),
                    custom_participant_id: custom_id_of(p),
                    created_at: joined_at(p),
                })
                .collect())
        })
    }

    fn live_participant_count<'a>(
        &'a self,
        room_id: &'a str,
    ) -> BoxFuture<'a, Result<u32, VideoError>> {
        Box::pin(async move {
            let connected = self.connected(room_id).await?;
            Ok(u32::try_from(connected.len()).unwrap_or(u32::MAX))
        })
    }

    fn kick_participants<'a>(
        &'a self,
        room_id: &'a str,
        participant_ids: &'a [String],
    ) -> BoxFuture<'a, Result<(), VideoError>> {
        Box::pin(async move {
            for id in participant_ids {
                self.remove(room_id, id).await?;
            }
            Ok(())
        })
    }

    fn kick_all<'a>(&'a self, room_id: &'a str) -> BoxFuture<'a, Result<u32, VideoError>> {
        Box::pin(async move {
            let connected = self.connected(room_id).await?;
            let mut kicked = 0_u32;
            for participant in &connected {
                if let Some(identity) = participant["identity"].as_str() {
                    self.remove(room_id, identity).await?;
                    kicked += 1;
                }
            }
            Ok(kicked)
        })
    }

    fn end_room<'a>(&'a self, room_id: &'a str) -> BoxFuture<'a, Result<(), VideoError>> {
        Box::pin(async move {
            match self
                .twirp("DeleteRoom", Some(room_id), &json!({ "room": room_id }))
                .await
            {
                Ok(_) => Ok(()),
                Err(error) if error.not_found() => Ok(()),
                Err(error) => Err(error.into_video("delete LiveKit room")),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use jsonwebtoken::{Algorithm, DecodingKey, Validation};

    use super::*;
    use crate::tests::{Fake, json as answer};

    const SECRET: &str = "a-long-enough-secret-for-hs256-signing";

    fn livekit(fake: &std::sync::Arc<Fake>) -> LiveKit {
        LiveKit::new(
            LiveKitConfig {
                api_url: api_base("wss://lk.example.com/"),
                api_key: "APIkey".to_owned(),
                api_secret: SECRET.to_owned(),
                token_ttl: Duration::from_secs(600),
            },
            OutboundHttp(fake.clone()),
        )
    }

    fn decode(token: &str) -> Value {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_required_spec_claims(&["exp", "nbf", "iss", "sub"]);
        jsonwebtoken::decode::<Value>(
            token,
            &DecodingKey::from_secret(SECRET.as_bytes()),
            &validation,
        )
        .expect("a valid token")
        .claims
    }

    #[tokio::test]
    async fn mints_a_join_token_without_calling_the_server() {
        let fake = Fake::new(|_| answer(200, &json!({})));
        let lk = livekit(&fake);
        let joined = lk
            .add_participant(
                "ws-room",
                &NewParticipant {
                    name: "Ann".to_owned(),
                    custom_participant_id: "user_1".to_owned(),
                    preset_name: None,
                    picture: Some("https://img/ann.png".to_owned()),
                },
            )
            .await
            .expect("a token");
        assert_eq!(fake.requests().len(), 0);
        let claims = decode(&joined.token);
        assert_eq!(claims["iss"], "APIkey");
        assert_eq!(claims["sub"], joined.participant_id);
        assert_eq!(claims["name"], "Ann");
        assert_eq!(claims["attributes"]["customParticipantId"], "user_1");
        assert_eq!(
            claims["video"],
            json!({ "room": "ws-room", "roomJoin": true, "canPublish": true, "canSubscribe": true, "canPublishData": true })
        );
        let metadata: Value =
            serde_json::from_str(claims["metadata"].as_str().expect("metadata")).expect("json");
        assert_eq!(metadata["picture"], "https://img/ann.png");
        let lifetime = claims["exp"].as_i64().expect("exp") - claims["nbf"].as_i64().expect("nbf");
        assert_eq!(lifetime, 600);
    }

    #[tokio::test]
    async fn creates_and_closes_rooms_through_the_room_service() {
        let fake = Fake::new(|request| {
            if request.url.ends_with("/DeleteRoom") {
                answer(
                    404,
                    &json!({ "code": "not_found", "msg": "room not found" }),
                )
            } else {
                answer(200, &json!({ "name": "x" }))
            }
        });
        let lk = livekit(&fake);
        let room = lk.create_room("Ann's voice call").await.expect("created");
        assert!(room.starts_with("ws-"));
        lk.end_room(&room).await.expect("a missing room is closed");

        let sent = fake.requests();
        assert_eq!(
            sent[0].url,
            "https://lk.example.com/twirp/livekit.RoomService/CreateRoom"
        );
        let body: Value =
            serde_json::from_slice(sent[0].body.as_deref().expect("body")).expect("json");
        assert_eq!(body["name"], room);
        assert_eq!(
            body["metadata"],
            json!({ "title": "Ann's voice call" }).to_string()
        );
        assert_eq!(
            sent[1].url,
            "https://lk.example.com/twirp/livekit.RoomService/DeleteRoom"
        );
        let bearer = sent[1]
            .headers
            .iter()
            .find(|(name, _)| name == "authorization")
            .map(|(_, value)| value.trim_start_matches("Bearer ").to_owned())
            .expect("authorization");
        let claims = decode(&bearer);
        assert_eq!(claims["video"]["roomAdmin"], true);
        assert_eq!(claims["video"]["room"], room);
    }

    #[tokio::test]
    async fn counts_and_kicks_connected_people() {
        let fake = Fake::new(|request| {
            if request.url.ends_with("/ListParticipants") {
                answer(
                    200,
                    &json!({ "participants": [
                        { "identity": "user_1~aa", "state": "ACTIVE", "joined_at": "1767225600", "attributes": { "customParticipantId": "user_1" } },
                        { "identity": "user_2~bb", "state": 2, "joined_at": 1_767_225_660 },
                        { "identity": "gone~cc", "state": "DISCONNECTED" },
                        { "identity": "recorder", "state": "ACTIVE", "kind": "EGRESS" }
                    ] }),
                )
            } else {
                answer(200, &json!({}))
            }
        });
        let lk = livekit(&fake);
        assert_eq!(lk.live_participant_count("r").await, Ok(2));
        let listed = lk.list_participants("r").await.expect("listed");
        assert_eq!(listed[0].custom_participant_id, "user_1");
        assert_eq!(listed[0].created_at, "2026-01-01T00:00:00Z");
        assert_eq!(listed[1].custom_participant_id, "user_2");
        assert_eq!(lk.kick_all("r").await, Ok(2));
        let removed: Vec<Value> = fake
            .requests()
            .iter()
            .filter(|r| r.url.ends_with("/RemoveParticipant"))
            .map(|r| serde_json::from_slice(r.body.as_deref().expect("body")).expect("json"))
            .collect();
        assert_eq!(
            removed,
            vec![
                json!({ "room": "r", "identity": "user_1~aa" }),
                json!({ "room": "r", "identity": "user_2~bb" })
            ]
        );
    }

    #[tokio::test]
    async fn a_missing_room_is_empty_and_other_failures_are_errors() {
        let fake = Fake::new(|_| {
            answer(
                404,
                &json!({ "code": "not_found", "msg": "requested room does not exist" }),
            )
        });
        assert_eq!(livekit(&fake).live_participant_count("r").await, Ok(0));
        let down = Fake::new(|_| answer(503, &json!({ "code": "unavailable", "msg": "down" })));
        let error = livekit(&down)
            .live_participant_count("r")
            .await
            .expect_err("unknown");
        assert_eq!(error.status, Some(503));
    }

    #[test]
    fn reads_its_env() {
        let env = |name: &str| match name {
            "LIVEKIT_URL" => Some("wss://lk.example.com".to_owned()),
            "LIVEKIT_API_KEY" => Some("k".to_owned()),
            "LIVEKIT_API_SECRET" => Some("s".to_owned()),
            "LIVEKIT_TOKEN_TTL_SECONDS" => Some("120".to_owned()),
            _ => None,
        };
        let config = LiveKitConfig::from_env(env).expect("configured");
        assert_eq!(config.api_url, "https://lk.example.com");
        assert_eq!(config.token_ttl, Duration::from_secs(120));
        assert!(LiveKitConfig::from_env(|_| None).is_none());
    }
}
