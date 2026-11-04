//! Cloudflare `RealtimeKit` over its REST API, as `@weldsuite/cloudflare-realtime`
//! calls it through the `cloudflare` SDK: the same URLs, methods, bodies and
//! retries (`maxRetries: 2`), so a conformance run sends the test's `fetch`
//! stub exactly the calls the Hono app does.
//!
//! The credential is `CF_REALTIME_APP_SECRET`, sent as `Authorization: Bearer`
//! (the SDK's `apiToken`), not a general Cloudflare API token.

use std::time::Duration;

use serde_json::{Map, Value, json};
use weldsuite_ports::video_rooms::{
    DynVideoRooms, JoinToken, NewParticipant, RoomOptions, RoomParticipant, VideoError,
    WebhookRegistration, WebhookUpserted,
};
use weldsuite_ports::{BoxFuture, HttpRequest, HttpResponse, OutboundHttp};

use crate::{encode_component, encode_query_component};

/// `RTK_PRESETS.MEMBER`, the preset a participant gets when none is named.
pub const MEMBER_PRESET: &str = "group_call_participant_v2";

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

/// `RTK_PRESETS`.
pub const HOST_PRESET: &str = "group_call_host_v3";
pub const GUEST_PRESET: &str = "group_call_guest_v2";
pub const GUEST_WAITING_PRESET: &str = "group_call_guest_waiting_v2";

/// `buildAiConfig(opts)`: the `ai_config` fragment, or `None` when nothing
/// is set.
fn ai_config(options: &RoomOptions) -> Option<Value> {
    let mut config = Map::new();
    if let Some(language) = options.transcription_language.as_deref() {
        config.insert("transcription".into(), json!({ "language": language }));
    }
    if let Some(format) = options.summary_text_format.as_deref() {
        config.insert("summarization".into(), json!({ "text_format": format }));
    }
    (!config.is_empty()).then_some(Value::Object(config))
}

/// The opt-in fields of `createMeeting` / `updateMeeting`, in the SDK's order.
fn option_fields(body: &mut Map<String, Value>, options: &RoomOptions, create: bool) {
    if let Some(record) = options.record_on_start {
        body.insert("record_on_start".into(), Value::Bool(record));
    }
    if create && options.audio_export {
        body.insert(
            "recording_config".into(),
            json!({ "audio_config": { "export_file": true, "codec": "MP3" } }),
        );
    }
    if let Some(transcribe) = options.transcribe_on_end {
        body.insert("transcribe_on_end".into(), Value::Bool(transcribe));
    }
    if let Some(summarize) = options.summarize_on_end {
        body.insert("summarize_on_end".into(), Value::Bool(summarize));
    }
    if let Some(config) = ai_config(options) {
        body.insert("ai_config".into(), config);
    }
}

/// `toRecording(r)`: the recording with its optional fields left out when
/// missing (an empty `output_file_name` too).
fn to_recording(r: &Value) -> Value {
    let mut out = Map::new();
    out.insert("id".into(), r["id"].clone());
    out.insert("status".into(), r["status"].clone());
    for key in [
        "download_url",
        "audio_download_url",
        "download_url_expiry",
        "file_size",
        "started_time",
        "stopped_time",
        "recording_duration",
        "session_id",
    ] {
        if let Some(value) = r.get(key).filter(|v| !v.is_null()) {
            out.insert(key.into(), value.clone());
        }
    }
    let name = &r["output_file_name"];
    let empty = match name {
        Value::Null | Value::Bool(false) => true,
        Value::String(text) => text.is_empty(),
        Value::Number(n) => n.as_f64() == Some(0.0),
        _ => false,
    };
    if !empty {
        out.insert("output_file_name".into(), name.clone());
    }
    Value::Object(out)
}

/// `buildPresetBody(opts)`: `RealtimeKit`'s strict preset shape.
fn preset_body(
    name: &str,
    accept_waiting_requests: bool,
    waiting_room_type: &str,
    can_record: bool,
    can_livestream: bool,
) -> Value {
    let host = accept_waiting_requests;
    json!({
        "name": name,
        "permissions": {
            "can_accept_production_requests": false,
            "can_edit_display_name": true,
            "accept_waiting_requests": host,
            "disable_participant_audio": false,
            "disable_participant_screensharing": false,
            "disable_participant_video": false,
            "can_spotlight": host,
            "kick_participant": host,
            "pin_participant": host,
            "can_record": can_record,
            "can_livestream": can_livestream,
            "waiting_room_type": waiting_room_type,
            "plugins": { "can_close": true, "can_start": true, "can_edit_config": false, "config": {} },
            "polls": { "can_create": true, "can_vote": true, "can_view": true },
            "media": {
                "video": { "can_produce": "ALLOWED" },
                "audio": { "can_produce": "ALLOWED" },
                "screenshare": { "can_produce": "ALLOWED" },
            },
            "chat": {
                "public": { "can_send": true, "text": true, "files": true },
                "private": { "can_send": true, "can_receive": true, "text": true, "files": true },
            },
            "hidden_participant": false,
            "is_recorder": false,
            "recorder_type": "NONE",
            "show_participant_list": true,
            "transcription_enabled": true,
            "can_change_participant_permissions": host,
            "connected_meetings": {
                "can_alter_connected_meetings": false,
                "can_switch_connected_meetings": false,
                "can_switch_to_parent_meeting": false,
            },
            "stage_enabled": false,
            "accept_stage_requests": false,
        },
        "ui": {
            "design_tokens": {
                "border_radius": "rounded",
                "border_width": "thin",
                "spacing_base": 4,
                "theme": "dark",
                "colors": {
                    "brand": { "300": "#9FBAFF", "400": "#5C8AFF", "500": "#2160FD", "600": "#1E50D6", "700": "#1840AA" },
                    "background": { "1000": "#252525", "900": "#2F2F2F", "800": "#323232", "700": "#3E3E3E", "600": "#4A4A4A" },
                    "danger": "#FF2D2D",
                    "text": "#EEEEEE",
                    "text_on_brand": "#EEEEEE",
                    "success": "#62A504",
                    "video_bg": "#191919",
                    "warning": "#FFCD07",
                },
            },
            "config_diff": {},
        },
        "config": {
            "view_type": "GROUP_CALL",
            "media": {
                "audio": { "enable_stereo": false, "enable_high_bitrate": false },
                "video": { "quality": "vga", "frame_rate": 30, "simulcast": false },
                "screenshare": { "quality": "fhd", "frame_rate": 30 },
            },
            "max_video_streams": { "mobile": 6, "desktop": 6 },
            "max_screenshare_count": 1,
            "track_recording": { "subscriptions": [] },
        },
    })
}

impl RealtimeKit {
    /// `seedPresets` without the cache marker (the caller writes it):
    /// list the presets, create the missing ones. A host preset with live
    /// streaming that `RealtimeKit` turns down (400/422) is created without it.
    async fn seed(&self) -> Result<(), VideoError> {
        let app = self.app()?;
        let listed = self
            .call("list RTK presets", app.request("GET", "/presets", None))
            .await?
            .json();
        let existing: Vec<String> = listed["data"]
            .as_array()
            .map(|presets| {
                presets
                    .iter()
                    .filter_map(|p| p["name"].as_str().filter(|n| !n.is_empty()))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let has = |name: &str| existing.iter().any(|e| e == name);
        let create = |body: Value| {
            let request = app.request("POST", "/presets", Some(&body));
            async move { self.call("create RTK preset", request).await.map(|_| ()) }
        };
        if !has(HOST_PRESET) {
            match create(preset_body(HOST_PRESET, true, "SKIP", true, true)).await {
                Ok(()) => {}
                Err(error) if matches!(error.status, Some(400 | 422)) => {
                    tracing::error!(%error, "[RTK] host preset with live streaming was rejected, seeding without it");
                    create(preset_body(HOST_PRESET, true, "SKIP", true, false)).await?;
                }
                Err(error) => return Err(error),
            }
        }
        if !has(MEMBER_PRESET) {
            create(preset_body(MEMBER_PRESET, false, "SKIP", false, false)).await?;
        }
        if !has(GUEST_PRESET) {
            create(preset_body(
                GUEST_PRESET,
                false,
                "ON_PRIVILEGED_USER_ENTRY",
                false,
                false,
            ))
            .await?;
        }
        if !has(GUEST_WAITING_PRESET) {
            create(preset_body(
                GUEST_WAITING_PRESET,
                false,
                "SKIP_ON_ACCEPT",
                false,
                false,
            ))
            .await?;
        }
        Ok(())
    }

    /// `listWebhooks`: `(id, url)` of every webhook of the app.
    async fn webhooks(&self) -> Result<Vec<(String, String)>, VideoError> {
        let app = self.app()?;
        let body = self
            .call("list RTK webhooks", app.request("GET", "/webhooks", None))
            .await?
            .json();
        Ok(body["data"]
            .as_array()
            .map(|hooks| {
                hooks
                    .iter()
                    .map(|w| (js_text(&w["id"]), js_text(&w["url"])))
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn upsert(
        &self,
        registration: &WebhookRegistration,
    ) -> Result<WebhookUpserted, VideoError> {
        let existing: Vec<String> = self
            .webhooks()
            .await?
            .into_iter()
            .filter(|(_, url)| *url == registration.url)
            .map(|(id, _)| id)
            .collect();
        let app = self.app()?;
        let body = json!({
            "name": registration.name,
            "url": registration.url,
            "events": registration.events,
            "enabled": registration.enabled,
        });
        let Some((keep, duplicates)) = existing.split_first() else {
            let created = self
                .call(
                    "register RTK webhook",
                    app.request("POST", "/webhooks", Some(&body)),
                )
                .await?
                .json();
            return Ok(WebhookUpserted {
                id: created["data"]["id"].as_str().map(str::to_owned),
                action: "created",
                removed_duplicates: 0,
            });
        };
        let path = format!("/webhooks/{}", encode_component(keep));
        self.call(
            "replace RTK webhook",
            app.request("PUT", &path, Some(&body)),
        )
        .await?;
        for duplicate in duplicates {
            let path = format!("/webhooks/{}", encode_component(duplicate));
            self.call(
                "delete duplicate RTK webhook",
                app.request("DELETE", &path, None),
            )
            .await?;
        }
        Ok(WebhookUpserted {
            id: Some(keep.clone()),
            action: "updated",
            removed_duplicates: u32::try_from(duplicates.len()).unwrap_or(u32::MAX),
        })
    }
}

impl DynVideoRooms for RealtimeKit {
    fn create_room_with<'a>(
        &'a self,
        title: &'a str,
        options: &'a RoomOptions,
    ) -> BoxFuture<'a, Result<String, VideoError>> {
        Box::pin(async move {
            let app = self.app()?;
            let mut body = Map::new();
            body.insert("title".into(), Value::from(title));
            option_fields(&mut body, options, true);
            let request = app.request("POST", "/meetings", Some(&Value::Object(body)));
            let answer = self.call("create RTK meeting", request).await?.json();
            answer["data"]["id"]
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

    fn update_room<'a>(
        &'a self,
        room_id: &'a str,
        options: &'a RoomOptions,
    ) -> BoxFuture<'a, Result<(), VideoError>> {
        Box::pin(async move {
            let app = self.app()?;
            let mut body = Map::new();
            option_fields(&mut body, options, false);
            let request = app.request("PATCH", &meeting(room_id), Some(&Value::Object(body)));
            self.call("update RTK meeting", request).await.map(|_| ())
        })
    }

    fn list_recordings<'a>(
        &'a self,
        room_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<Value>, VideoError>> {
        Box::pin(async move {
            let app = self.app()?;
            let query = encode_query_component(room_id);
            let path = format!("/recordings?meeting_id={query}");
            let body = self
                .call("list recordings", app.request("GET", &path, None))
                .await?
                .json();
            Ok(body["data"]
                .as_array()
                .map(|items| items.iter().map(to_recording).collect())
                .unwrap_or_default())
        })
    }

    fn upsert_webhook<'a>(
        &'a self,
        registration: &'a WebhookRegistration,
    ) -> BoxFuture<'a, Result<WebhookUpserted, VideoError>> {
        Box::pin(self.upsert(registration))
    }

    fn seed_presets(&self) -> BoxFuture<'_, Result<(), VideoError>> {
        Box::pin(self.seed())
    }

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
