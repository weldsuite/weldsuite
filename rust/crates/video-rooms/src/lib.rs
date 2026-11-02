//! Adapters for the [`DynVideoRooms`] port.
//!
//! - [`RealtimeKit`]: Cloudflare `RealtimeKit`'s REST API, request for request
//!   what `@weldsuite/cloudflare-realtime` (the official `cloudflare` SDK)
//!   sends: the Global edition's provider, and the one conformance builds
//!   use, so the calls reach the test's `fetch` stub through the outbound
//!   bridge and are compared with the Hono app's.
//! - [`LiveKit`]: a self-hosted `LiveKit` server (Kubernetes editions): its
//!   `RoomService` Twirp API, and participant access tokens signed with the
//!   API secret.
//!
//! [`from_env`] picks one from the environment:
//!
//! | Variable | |
//! |---|---|
//! | `VIDEO_PROVIDER` | `livekit` or `realtimekit`; default `livekit` when `LIVEKIT_URL` is set, else `realtimekit` |
//! | `LIVEKIT_URL` | the server clients connect to (`wss://…`) |
//! | `LIVEKIT_API_URL` | the server API, when it is not `LIVEKIT_URL` with `https://` |
//! | `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | the API key pair |
//! | `LIVEKIT_TOKEN_TTL_SECONDS` | how long a join token can be used to connect (default 600) |
//! | `CF_ACCOUNT_ID`, `CF_REALTIME_APP_ID`, `CF_REALTIME_APP_SECRET` | `RealtimeKit` |

mod livekit;
mod livekit_webhook;
mod realtimekit;

use std::fmt::Write as _;
use std::sync::Arc;

pub use livekit::{LiveKit, LiveKitConfig};
pub use livekit_webhook::{WebhookRejected, verify_livekit_webhook};
pub use realtimekit::{
    GUEST_PRESET, GUEST_WAITING_PRESET, HOST_PRESET, MEMBER_PRESET, RealtimeKit, RealtimeKitConfig,
};
use weldsuite_ports::OutboundHttp;
pub use weldsuite_ports::video_rooms::{
    DynVideoRooms, JoinToken, NewParticipant, RoomOptions, RoomParticipant, UnconfiguredVideoRooms,
    VideoError, VideoRoomsProvider, WebhookRegistration, WebhookUpserted,
};

/// The provider the environment configures, sending through `http`.
/// `LiveKit` without its key pair is unconfigured: every call fails.
pub fn from_env(
    get: impl Fn(&str) -> Option<String>,
    http: OutboundHttp,
) -> Arc<dyn DynVideoRooms> {
    let value = |name: &str| get(name).filter(|value| !value.is_empty());
    let provider = value("VIDEO_PROVIDER").map(|p| p.to_ascii_lowercase());
    let livekit = match provider.as_deref() {
        Some("livekit") => true,
        Some(_) => false,
        None => value("LIVEKIT_URL").is_some(),
    };
    if !livekit {
        return Arc::new(RealtimeKit::new(RealtimeKitConfig::from_env(&get), http));
    }
    match LiveKitConfig::from_env(&get) {
        Some(config) => Arc::new(LiveKit::new(config, http)),
        None => Arc::new(UnconfiguredVideoRooms(
            "LiveKit is not configured (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)"
                .to_owned(),
        )),
    }
}

/// Random lowercase hex, `bytes` bytes of it.
fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0_u8; bytes];
    getrandom::fill(&mut buffer).expect("the operating system has a random source");
    buffer.iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

/// A query value as the SDK writes it (`encodeURIComponent`).
fn encode_query_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// A path segment as the SDK's `encodeURIPath` writes it: RFC 3986 `pchar`s
/// kept, everything else percent-encoded.
fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'.'
                    | b'_'
                    | b'~'
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b'('
                    | b')'
                    | b'*'
                    | b'+'
                    | b','
                    | b';'
                    | b'='
                    | b':'
                    | b'@'
            );
        if keep {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use weldsuite_ports::{BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, PortError};

    use super::*;

    /// Answers every request from a closure and keeps what was sent.
    pub(crate) struct Fake {
        pub(crate) sent: Mutex<Vec<HttpRequest>>,
        answer: Box<dyn Fn(&HttpRequest) -> HttpResponse + Send + Sync>,
    }

    impl Fake {
        pub(crate) fn new(
            answer: impl Fn(&HttpRequest) -> HttpResponse + Send + Sync + 'static,
        ) -> Arc<Self> {
            Arc::new(Self {
                sent: Mutex::new(Vec::new()),
                answer: Box::new(answer),
            })
        }

        pub(crate) fn requests(&self) -> Vec<HttpRequest> {
            self.sent
                .lock()
                .map(|sent| sent.clone())
                .unwrap_or_default()
        }
    }

    impl DynOutboundHttp for Fake {
        fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            let answer = (self.answer)(&request);
            if let Ok(mut sent) = self.sent.lock() {
                sent.push(request);
            }
            Box::pin(async move { Ok(answer) })
        }
    }

    pub(crate) fn json(status: u16, body: &serde_json::Value) -> HttpResponse {
        HttpResponse {
            status,
            body: body.to_string().into_bytes(),
            ..HttpResponse::default()
        }
    }

    #[test]
    fn encodes_like_encode_uri_path() {
        assert_eq!(
            encode_component("abc-_.!~*'()$&+,;=:@"),
            "abc-_.!~*'()$&+,;=:@"
        );
        assert_eq!(encode_component("a b/c?d"), "a%20b%2Fc%3Fd");
        assert_eq!(encode_component("é"), "%C3%A9");
    }

    #[tokio::test]
    async fn picks_the_provider_from_the_env() {
        let fake = Fake::new(|_| json(200, &serde_json::json!({ "data": { "id": "m1" } })));
        let http = OutboundHttp(fake.clone());
        let env = |pairs: &[(&str, &str)]| {
            let map: HashMap<String, String> = pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect();
            move |name: &str| map.get(name).cloned()
        };

        // RealtimeKit by default.
        let rooms = from_env(
            env(&[
                ("CF_ACCOUNT_ID", "acc"),
                ("CF_REALTIME_APP_ID", "app"),
                ("CF_REALTIME_APP_SECRET", "secret"),
            ]),
            http.clone(),
        );
        assert_eq!(rooms.create_room("t").await.as_deref(), Ok("m1"));
        assert!(
            fake.requests()[0]
                .url
                .contains("/realtime/kit/app/meetings")
        );

        // LiveKit once its URL is set; without the key pair, unconfigured.
        let rooms = from_env(
            env(&[("LIVEKIT_URL", "wss://lk.example.com")]),
            http.clone(),
        );
        assert!(rooms.create_room("t").await.is_err());
        let rooms = from_env(
            env(&[
                ("LIVEKIT_URL", "wss://lk.example.com"),
                ("LIVEKIT_API_KEY", "key"),
                (
                    "LIVEKIT_API_SECRET",
                    "a-long-enough-secret-for-hs256-signing",
                ),
            ]),
            http,
        );
        let token = rooms
            .add_participant(
                "room",
                &NewParticipant {
                    name: "Ann".to_owned(),
                    custom_participant_id: "user_1".to_owned(),
                    preset_name: None,
                    picture: None,
                },
            )
            .await
            .expect("a token");
        assert!(token.participant_id.starts_with("user_1~"));
    }
}
