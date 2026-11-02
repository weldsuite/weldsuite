//! Cloudflare `RealtimeKit` over its REST API, as `@weldsuite/cloudflare-realtime`
//! calls it through the `cloudflare` SDK: the same URLs, methods, bodies and
//! retries (`maxRetries: 2`), so a conformance run sends the test's `fetch`
//! stub exactly the calls the Hono app does.
//!
//! The credential is `CF_REALTIME_APP_SECRET`, sent as `Authorization: Bearer`
//! (the SDK's `apiToken`), not a general Cloudflare API token.

use std::time::Duration;

use serde_json::{Value, json};
use weldsuite_ports::video_rooms::{
    DynVideoRooms, JoinToken, NewParticipant, RoomParticipant, VideoError,
};
use weldsuite_ports::{BoxFuture, HttpRequest, HttpResponse, OutboundHttp};

use crate::encode_component;

/// `RTK_PRESETS.MEMBER`, the preset a participant gets when none is named.
pub(crate) const MEMBER_PRESET: &str = "group_call_participant_v2";

/// The SDK's default API base.
const API_BASE: &str = "https://api.cloudflare.com/client/v4";

/// The SDK's `maxRetries` as `@weldsuite/cloudflare-realtime` sets it.
const MAX_RETRIES: u32 = 2;

/// Where the account and app come from (`CloudflareRealtimeEnv`). Each is
/// checked when a call is made, as the TypeScript client does.
#[derive(Debug, Clone, Default)]
pub struct RealtimeKitConfig {
    pub account_id: Option<String>,
    pub app_id: Option<String>,
    pub app_secret: Option<String>,
    /// `CLOUDFLARE_BASE_URL`, else the public API.
    pub base_url: Option<String>,
}

impl RealtimeKitConfig {
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Self {
        let value = |name: &str| get(name).filter(|value| !value.is_empty());
        Self {
            account_id: value("CF_ACCOUNT_ID"),
            app_id: value("CF_REALTIME_APP_ID"),
            app_secret: value("CF_REALTIME_APP_SECRET"),
            base_url: value("CLOUDFLARE_BASE_URL"),
        }
    }
}

/// The `RealtimeKit` adapter.
pub struct RealtimeKit {
    config: RealtimeKitConfig,
    http: OutboundHttp,
    /// The first retry's wait; the SDK doubles it per retry.
    retry_delay: Duration,
}

impl RealtimeKit {
    pub fn new(config: RealtimeKitConfig, http: OutboundHttp) -> Self {
        Self {
            config,
            http,
            retry_delay: Duration::from_millis(500),
        }
    }

    #[cfg(test)]
    fn without_retry_wait(mut self) -> Self {
        self.retry_delay = Duration::ZERO;
        self
    }

    /// `realtime(env)`: the three values every call needs.
    fn app(&self) -> Result<App<'_>, VideoError> {
        let missing = |name: &str| VideoError::new(None, format!("{name} is not configured"));
        let account = self
            .config
            .account_id
            .as_deref()
            .ok_or_else(|| missing("CF_ACCOUNT_ID"))?;
        let app = self
            .config
            .app_id
            .as_deref()
            .ok_or_else(|| missing("CF_REALTIME_APP_ID"))?;
        let secret = self
            .config
            .app_secret
            .as_deref()
            .ok_or_else(|| missing("CF_REALTIME_APP_SECRET"))?;
        let base = self
            .config
            .base_url
            .as_deref()
            .unwrap_or(API_BASE)
            .trim_end_matches('/');
        Ok(App {
            prefix: format!(
                "{base}/accounts/{}/realtime/kit/{}",
                encode_component(account),
                encode_component(app)
            ),
            secret,
        })
    }

    /// One SDK call: retried on a connection failure, 408, 409, 429 and 5xx,
    /// twice at most, after 0.5s then 1s. Any other non-2xx is an error
    /// carrying the status.
    async fn call(&self, what: &str, request: HttpRequest) -> Result<HttpResponse, VideoError> {
        let mut attempt = 0;
        loop {
            let last = attempt >= MAX_RETRIES;
            match self.http.send(request.clone()).await {
                Ok(response) if response.ok() => return Ok(response),
                Ok(response) => {
                    let retry =
                        matches!(response.status, 408 | 409 | 429) || response.status >= 500;
                    if !retry || last {
                        return Err(api_error(what, &response));
                    }
                }
                Err(error) => {
                    if last {
                        return Err(VideoError::new(None, format!("Failed to {what}: {error}")));
                    }
                }
            }
            let wait = self.retry_delay * 2_u32.pow(attempt);
            if !wait.is_zero() {
                tokio::time::sleep(wait.min(Duration::from_secs(8))).await;
            }
            attempt += 1;
        }
    }
}

struct App<'a> {
    prefix: String,
    secret: &'a str,
}

impl App<'_> {
    fn request(&self, method: &str, path: &str, body: Option<&Value>) -> HttpRequest {
        let url = format!("{}{path}", self.prefix);
        let request = match body {
            Some(body) => HttpRequest::json(method, url, body),
            None => HttpRequest::empty(method, url),
        };
        request
            .header("accept", "application/json")
            .header("authorization", format!("Bearer {}", self.secret))
    }
}

/// `Failed to <what>: <status> <code>:<message>; …`, as `call()` words it.
fn api_error(what: &str, response: &HttpResponse) -> VideoError {
    let body = response.json();
    let detail = body["errors"]
        .as_array()
        .map(|errors| {
            errors
                .iter()
                .map(|e| {
                    format!(
                        "{}:{}",
                        js_text(&e["code"]),
                        e["message"].as_str().unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join("; ")
        })
        .filter(|detail| !detail.is_empty())
        .unwrap_or_else(|| response.text());
    VideoError::new(
        Some(response.status),
        format!("Failed to {what}: {} {detail}", response.status),
    )
}

fn js_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "undefined".to_owned(),
        other => other.to_string(),
    }
}

fn meeting(id: &str) -> String {
    format!("/meetings/{}", encode_component(id))
}

impl DynVideoRooms for RealtimeKit {
    fn create_room<'a>(&'a self, title: &'a str) -> BoxFuture<'a, Result<String, VideoError>> {
        Box::pin(async move {
            let app = self.app()?;
            let request = app.request("POST", "/meetings", Some(&json!({ "title": title })));
            let body = self.call("create RTK meeting", request).await?.json();
            body["data"]["id"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| {
                    VideoError::new(
                        None,
                        "Failed to create RTK meeting: response carried no meeting",
                    )
                })
        })
    }

    fn add_participant<'a>(
        &'a self,
        room_id: &'a str,
        participant: &'a NewParticipant,
    ) -> BoxFuture<'a, Result<JoinToken, VideoError>> {
        Box::pin(async move {
            let app = self.app()?;
            let mut body = json!({
                "name": participant.name,
                "preset_name": participant.preset_name.as_deref().unwrap_or(MEMBER_PRESET),
                "custom_participant_id": participant.custom_participant_id,
            });
            if let Some(picture) = participant.picture.as_deref().filter(|p| !p.is_empty()) {
                body["picture"] = Value::from(picture);
            }
            let path = format!("{}/participants", meeting(room_id));
            let request = app.request("POST", &path, Some(&body));
            let answer = self.call("add RTK participant", request).await?.json();
            let data = &answer["data"];
            match (data["id"].as_str(), data["token"].as_str()) {
                (Some(id), Some(token)) => Ok(JoinToken {
                    participant_id: id.to_owned(),
                    token: token.to_owned(),
                }),
                _ => Err(VideoError::new(
                    None,
                    "Failed to add RTK participant: response carried no participant",
                )),
            }
        })
    }

    fn remove_participant<'a>(
        &'a self,
        room_id: &'a str,
        participant_id: &'a str,
    ) -> BoxFuture<'a, Result<(), VideoError>> {
        Box::pin(async move {
            let app = self.app()?;
            let path = format!(
                "{}/participants/{}",
                meeting(room_id),
                encode_component(participant_id)
            );
            self.call("remove RTK participant", app.request("DELETE", &path, None))
                .await?;
            Ok(())
        })
    }

    fn list_participants<'a>(
        &'a self,
        room_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<RoomParticipant>, VideoError>> {
        Box::pin(async move {
            let app = self.app()?;
            let per_page = 100;
            let mut all = Vec::new();
            let mut page = 1;
            loop {
                let path = format!(
                    "{}/participants?page_no={page}&per_page={per_page}",
                    meeting(room_id)
                );
                let body = self
                    .call("list RTK participants", app.request("GET", &path, None))
                    .await?
                    .json();
                let data = body["data"].as_array().cloned().unwrap_or_default();
                for p in &data {
                    all.push(RoomParticipant {
                        id: js_text(&p["id"]),
                        custom_participant_id: js_text(&p["custom_participant_id"]),
                        created_at: p["created_at"].as_str().unwrap_or_default().to_owned(),
                    });
                }
                let total = body["paging"]["total_count"]
                    .as_u64()
                    .and_then(|t| usize::try_from(t).ok())
                    .unwrap_or(all.len());
                if data.len() < per_page || all.len() >= total {
                    return Ok(all);
                }
                page += 1;
            }
        })
    }

    fn live_participant_count<'a>(
        &'a self,
        room_id: &'a str,
    ) -> BoxFuture<'a, Result<u32, VideoError>> {
        Box::pin(async move {
            let app = self.app()?;
            let path = format!("{}/active-session", meeting(room_id));
            let body = match self
                .call("get RTK active session", app.request("GET", &path, None))
                .await
            {
                Ok(response) => response.json(),
                // No live session: nobody joined yet, or everyone left.
                Err(error) if error.status == Some(404) => return Ok(0),
                Err(error) => return Err(error),
            };
            let session = &body["data"];
            if session["status"].as_str() != Some("LIVE") {
                return Ok(0);
            }
            Ok(session["live_participants"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(0))
        })
    }

    fn kick_participants<'a>(
        &'a self,
        room_id: &'a str,
        participant_ids: &'a [String],
    ) -> BoxFuture<'a, Result<(), VideoError>> {
        Box::pin(async move {
            if participant_ids.is_empty() {
                return Err(VideoError::new(
                    None,
                    "kickParticipants requires at least one participant id",
                ));
            }
            let app = self.app()?;
            let path = format!("{}/active-session/kick", meeting(room_id));
            let body = json!({ "participant_ids": participant_ids, "custom_participant_ids": [] });
            self.call(
                "kick RTK participants",
                app.request("POST", &path, Some(&body)),
            )
            .await?;
            Ok(())
        })
    }

    fn kick_all<'a>(&'a self, room_id: &'a str) -> BoxFuture<'a, Result<u32, VideoError>> {
        Box::pin(async move {
            let app = self.app()?;
            let path = format!("{}/active-session/kick-all", meeting(room_id));
            let body = self
                .call(
                    "kick all RTK participants",
                    app.request("POST", &path, None),
                )
                .await?
                .json();
            Ok(body["data"]["kicked_participants_count"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(0))
        })
    }

    fn end_room<'a>(&'a self, room_id: &'a str) -> BoxFuture<'a, Result<(), VideoError>> {
        Box::pin(async move {
            let app = self.app()?;
            let body = json!({ "status": "INACTIVE" });
            self.call(
                "end RTK meeting",
                app.request("PATCH", &meeting(room_id), Some(&body)),
            )
            .await?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;
    use crate::tests::{Fake, json as answer};

    fn config() -> RealtimeKitConfig {
        RealtimeKitConfig {
            account_id: Some("acc".to_owned()),
            app_id: Some("app".to_owned()),
            app_secret: Some("secret".to_owned()),
            base_url: None,
        }
    }

    const PREFIX: &str = "https://api.cloudflare.com/client/v4/accounts/acc/realtime/kit/app";

    #[tokio::test]
    async fn sends_what_the_sdk_sends() {
        let fake = Fake::new(
            |request| match (request.method.as_str(), request.url.as_str()) {
                ("POST", url) if url.ends_with("/meetings") => {
                    answer(201, &json!({ "data": { "id": "m1" } }))
                }
                ("POST", url) if url.ends_with("/participants") => {
                    answer(201, &json!({ "data": { "id": "p1", "token": "tok" } }))
                }
                ("POST", url) if url.ends_with("/kick-all") => {
                    answer(200, &json!({ "data": { "kicked_participants_count": 2 } }))
                }
                ("GET", url) if url.ends_with("/active-session") => answer(
                    200,
                    &json!({ "data": { "status": "LIVE", "live_participants": 3 } }),
                ),
                _ => answer(200, &json!({ "success": true })),
            },
        );
        let rtk = RealtimeKit::new(config(), OutboundHttp(fake.clone()));

        assert_eq!(
            rtk.create_room("Ann's voice call").await.as_deref(),
            Ok("m1")
        );
        let token = rtk
            .add_participant(
                "m1",
                &NewParticipant {
                    name: "Ann".to_owned(),
                    custom_participant_id: "user_1".to_owned(),
                    preset_name: None,
                    picture: Some("https://img/ann.png".to_owned()),
                },
            )
            .await
            .expect("added");
        assert_eq!(token.participant_id, "p1");
        assert_eq!(token.token, "tok");
        assert_eq!(rtk.kick_all("m1").await, Ok(2));
        assert_eq!(rtk.live_participant_count("m1").await, Ok(3));
        rtk.end_room("m1").await.expect("ended");
        rtk.remove_participant("m1", "p 1").await.expect("removed");

        let sent = fake.requests();
        let lines: Vec<(String, String, Option<Value>)> = sent
            .iter()
            .map(|r| {
                (
                    r.method.clone(),
                    r.url.clone(),
                    r.body
                        .as_ref()
                        .map(|b| serde_json::from_slice(b).expect("json")),
                )
            })
            .collect();
        assert_eq!(
            lines,
            vec![
                (
                    "POST".to_owned(),
                    format!("{PREFIX}/meetings"),
                    Some(json!({ "title": "Ann's voice call" }))
                ),
                (
                    "POST".to_owned(),
                    format!("{PREFIX}/meetings/m1/participants"),
                    Some(json!({
                        "name": "Ann",
                        "preset_name": MEMBER_PRESET,
                        "custom_participant_id": "user_1",
                        "picture": "https://img/ann.png"
                    }))
                ),
                (
                    "POST".to_owned(),
                    format!("{PREFIX}/meetings/m1/active-session/kick-all"),
                    None
                ),
                (
                    "GET".to_owned(),
                    format!("{PREFIX}/meetings/m1/active-session"),
                    None
                ),
                (
                    "PATCH".to_owned(),
                    format!("{PREFIX}/meetings/m1"),
                    Some(json!({ "status": "INACTIVE" }))
                ),
                (
                    "DELETE".to_owned(),
                    format!("{PREFIX}/meetings/m1/participants/p%201"),
                    None
                ),
            ]
        );
        assert!(
            sent[0]
                .headers
                .contains(&("authorization".to_owned(), "Bearer secret".to_owned()))
        );
    }

    #[tokio::test]
    async fn no_live_session_is_an_empty_room() {
        let fake = Fake::new(|_| {
            answer(
                404,
                &json!({ "errors": [{ "code": 404, "message": "no session" }] }),
            )
        });
        let rtk = RealtimeKit::new(config(), OutboundHttp(fake.clone()));
        assert_eq!(rtk.live_participant_count("m1").await, Ok(0));
        assert_eq!(fake.requests().len(), 1);
    }

    #[tokio::test]
    async fn retries_server_errors_twice() {
        let fake = Fake::new(|_| {
            answer(
                503,
                &json!({ "errors": [{ "code": 7, "message": "down" }] }),
            )
        });
        let rtk = RealtimeKit::new(config(), OutboundHttp(fake.clone())).without_retry_wait();
        let error = rtk.kick_all("m1").await.expect_err("fails");
        assert_eq!(error.status, Some(503));
        assert_eq!(
            error.message,
            "Failed to kick all RTK participants: 503 7:down"
        );
        assert_eq!(fake.requests().len(), 3);
    }

    #[tokio::test]
    async fn pages_through_participants() {
        let calls = Arc::new(AtomicU32::new(0));
        let counter = Arc::clone(&calls);
        let fake = Fake::new(move |_| {
            let page = counter.fetch_add(1, Ordering::SeqCst);
            let count = if page == 0 { 100 } else { 1 };
            let data: Vec<Value> = (0..count)
                .map(|i| json!({ "id": format!("p{page}_{i}"), "custom_participant_id": "u", "created_at": "2026-01-01T00:00:00.000Z" }))
                .collect();
            answer(
                200,
                &json!({ "data": data, "paging": { "total_count": 101 } }),
            )
        });
        let rtk = RealtimeKit::new(config(), OutboundHttp(fake.clone()));
        let all = rtk.list_participants("m1").await.expect("listed");
        assert_eq!(all.len(), 101);
        let urls: Vec<String> = fake.requests().into_iter().map(|r| r.url).collect();
        assert_eq!(
            urls,
            vec![
                format!("{PREFIX}/meetings/m1/participants?page_no=1&per_page=100"),
                format!("{PREFIX}/meetings/m1/participants?page_no=2&per_page=100"),
            ]
        );
    }

    #[tokio::test]
    async fn needs_its_credentials_before_any_call() {
        let fake = Fake::new(|_| answer(200, &json!({})));
        let rtk = RealtimeKit::new(RealtimeKitConfig::default(), OutboundHttp(fake.clone()));
        let error = rtk.create_room("t").await.expect_err("unconfigured");
        assert_eq!(error.message, "CF_ACCOUNT_ID is not configured");
        assert_eq!(fake.requests().len(), 0);
    }
}
