//! Push: Expo for the mobile apps (`channels/push.ts`), and for an incoming
//! call the native ring (`channels/call-push.ts`): Apple's `VoIP` push on
//! `voip` tokens (`channels/apns.ts`), an Expo data message on `expo_call`
//! tokens. Dead tokens are deactivated.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex, PoisonError};

use regex::Regex;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_events::iso_timestamp;
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::{NewNotification, Notifier, channel_preferences, push_data};

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";
const MAX_PER_REQUEST: usize = 100;
const CALL_DEVICE_SUFFIX: &str = ":call";
const CALL_RING_TTL_MS: i64 = 60_000;
const APNS_HOSTS: [&str; 2] = [
    "https://api.push.apple.com",
    "https://api.sandbox.push.apple.com",
];

static EXPO_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(Exponent|Expo)PushToken\[.+\]$").expect("the Expo token pattern compiles")
});
static HEX_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9a-fA-F]{64,200}$").expect("the hex pattern compiles"));

/// The APNs auth key (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`).
#[derive(Clone, PartialEq, Eq)]
pub struct ApnsConfig {
    pub key_id: String,
    pub team_id: String,
    /// The `.p8` PEM.
    pub private_key: String,
}

impl std::fmt::Debug for ApnsConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApnsConfig")
            .field("key_id", &self.key_id)
            .field("team_id", &self.team_id)
            .finish_non_exhaustive()
    }
}

impl ApnsConfig {
    /// `apnsConfigFromEnv`: all three set, else `None`.
    pub fn from_values(
        key_id: Option<&str>,
        team_id: Option<&str>,
        key: Option<&str>,
    ) -> Option<Self> {
        let pick = |v: Option<&str>| {
            v.map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        Some(Self {
            key_id: pick(key_id)?,
            team_id: pick(team_id)?,
            private_key: pick(key)?.replace("\\n", "\n"),
        })
    }
}

/// `Date.now()`.
fn now_ms() -> i64 {
    i64::try_from(OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

/// The apps a category pushes to (`appCodesForCategory`).
fn app_codes_for_category(category: &str) -> Vec<&'static str> {
    let module = match category {
        "weldchat" => "weldchat",
        "welddesk" | "helpdesk" => "welddesk",
        "weldmail" | "mail" => "weldmail",
        "weldcrm" | "crm" => "weldcrm",
        "weldflow" | "projects" | "task" => "weldflow",
        "weldmeet" => "weldmeet",
        "weldbooks" => "weldbooks",
        "weldagent" => "weldagent",
        "weldcalendar" => "weldcalendar",
        "weldhr" => "weldhr",
        _ => return vec!["weldsuite"],
    };
    vec![module, "weldsuite"]
}

/// `androidDelivery`: the Android channel and priority.
fn android_delivery(category: &str, kind: &str) -> (Option<&'static str>, &'static str) {
    if kind == "chat_incoming_call" || kind == "chat_missed_call" {
        return (Some("incoming_call"), "high");
    }
    match category {
        "weldchat" => (Some("chat"), "high"),
        "weldmail" | "mail" => (Some("email"), "high"),
        "weldflow" | "projects" | "task" => (Some("weldflow"), "default"),
        "weldagent" => (Some("weldagent"), "default"),
        "weldcalendar" => (Some("weldcalendar"), "default"),
        _ => (None, "default"),
    }
}

struct TokenRow {
    token: Option<String>,
    app_code: String,
    device_id: String,
    token_type: String,
}

fn is_call_token(row: &TokenRow) -> bool {
    row.token_type == "voip" || row.token_type == "expo_call"
}

fn call_token_device_id(device_id: &str) -> String {
    device_id
        .strip_suffix(CALL_DEVICE_SUFFIX)
        .unwrap_or(device_id)
        .to_owned()
}

/// `deliverPush`: the active tokens of the category's apps; never fails.
pub(crate) async fn deliver_push(db: &PgPool, notifier: &Notifier, params: &NewNotification) {
    if let Err(error) = try_deliver_push(db, notifier, params).await {
        tracing::error!(%error, "[Notifications] Push send failed");
    }
}

async fn try_deliver_push(
    db: &PgPool,
    notifier: &Notifier,
    params: &NewNotification,
) -> Result<(), sqlx::Error> {
    let app_codes: Vec<String> = app_codes_for_category(&params.category)
        .into_iter()
        .map(str::to_owned)
        .collect();
    let rows: Vec<(Option<String>, String, String, String)> = sqlx::query_as(
        "select token, app_code, device_id, token_type from device_tokens
         where user_id = $1 and is_active is null and app_code = any($2)",
    )
    .bind(&params.user_id)
    .bind(&app_codes)
    .fetch_all(db)
    .await?;
    let tokens: Vec<TokenRow> = rows
        .into_iter()
        .map(|(token, app_code, device_id, token_type)| TokenRow {
            token,
            app_code,
            device_id,
            token_type,
        })
        .collect();

    let mut invalid: Vec<String> = Vec::new();
    let mut rung_devices: HashSet<String> = HashSet::new();
    if params.notification_type == "chat_incoming_call" {
        let mut data = push_data(params);
        let call_id = data
            .get("entityId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        data.insert("notificationType".to_owned(), Value::from("chat_call_ring"));
        data.insert("callId".to_owned(), Value::from(call_id));
        data.insert(
            "expiresAt".to_owned(),
            Value::from((now_ms() + CALL_RING_TTL_MS).to_string()),
        );
        let call_rows: Vec<&TokenRow> = tokens.iter().filter(|t| is_call_token(t)).collect();
        let ring = send_to_call_tokens(notifier, &call_rows, &data).await;
        invalid.extend(ring.invalid_tokens);
        rung_devices = ring.delivered;
    }
    let push_tokens: Vec<&TokenRow> = tokens
        .iter()
        .filter(|t| !is_call_token(t) && !rung_devices.contains(&t.device_id))
        .collect();

    // By app code, in first-seen order.
    let mut by_app: Vec<(String, Vec<String>)> = Vec::new();
    for row in push_tokens {
        let Some(token) = row.token.clone() else {
            continue;
        };
        match by_app.iter_mut().find(|(code, _)| *code == row.app_code) {
            Some((_, list)) => list.push(token),
            None => by_app.push((row.app_code.clone(), vec![token])),
        }
    }
    if by_app.is_empty() && rung_devices.is_empty() {
        tracing::warn!(
            user = %params.user_id,
            category = %params.category,
            "[Notifications] No active push tokens"
        );
    }
    if !by_app.is_empty() {
        let (channel_id, priority) = android_delivery(&params.category, &params.notification_type);
        let data = Value::Object(push_data(params));
        for (_, app_tokens) in by_app {
            let messages: Vec<Value> = app_tokens
                .iter()
                .map(|token| {
                    let mut message = json!({
                        "to": token,
                        "title": params.title,
                        "body": params.body,
                        "sound": "default",
                        "badge": 1,
                        "priority": priority,
                        "data": data,
                    });
                    if let Some(channel) = channel_id {
                        message["channelId"] = Value::from(channel);
                    }
                    message
                })
                .collect();
            let sent = send_expo_push(notifier.http.as_ref(), messages).await;
            invalid.extend(sent.invalid_tokens.into_iter().filter(|t| !t.is_empty()));
        }
    }
    deactivate_device_tokens(db, &invalid).await
}

/// `deactivateDeviceTokens`.
async fn deactivate_device_tokens(db: &PgPool, tokens: &[String]) -> Result<(), sqlx::Error> {
    if tokens.is_empty() {
        return Ok(());
    }
    let now = iso_timestamp(OffsetDateTime::now_utc());
    sqlx::query(
        "update device_tokens set is_active = $2::timestamp, updated_at = $2::timestamp
         where token = any($1)",
    )
    .bind(tokens)
    .bind(&now)
    .execute(db)
    .await?;
    Ok(())
}

#[derive(Default)]
struct ExpoResult {
    tickets: Vec<Value>,
    invalid_tokens: Vec<String>,
}

/// `sendExpoPush(messages)`.
async fn send_expo_push(http: Option<&OutboundHttp>, messages: Vec<Value>) -> ExpoResult {
    let mut result = ExpoResult::default();
    let mut eligible = Vec::new();
    for message in messages {
        let to = message["to"].as_str().unwrap_or_default().to_owned();
        if to.is_empty() || !EXPO_TOKEN.is_match(&to) {
            tracing::warn!("[ExpoPush] Skipping non-Expo push token");
            result.tickets.push(json!({
                "status": "error",
                "message": "Not an Expo push token (ExponentPushToken[…]). Re-open the app to re-register.",
                "details": { "error": "InvalidCredentials" },
            }));
            if !to.is_empty() {
                result.invalid_tokens.push(to);
            }
            continue;
        }
        eligible.push(message);
    }
    if eligible.is_empty() {
        return result;
    }
    for chunk in eligible.chunks(MAX_PER_REQUEST) {
        let tickets = post_expo_chunk(http, chunk).await;
        for (index, ticket) in tickets.iter().enumerate() {
            if ticket["status"] == "error" && ticket["details"]["error"] == "DeviceNotRegistered" {
                let to = chunk
                    .get(index)
                    .and_then(|m| m["to"].as_str())
                    .unwrap_or_default();
                result.invalid_tokens.push(to.to_owned());
            }
        }
        result.tickets.extend(tickets);
    }
    result
}

/// `formatExpoHttpError(status, body)`.
fn format_expo_error(status: u16, body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return format!("HTTP {status}");
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        let from_errors: Vec<String> = parsed["errors"]
            .as_array()
            .map(|errors| {
                errors
                    .iter()
                    .map(|e| {
                        [e["code"].as_str(), e["message"].as_str()]
                            .into_iter()
                            .flatten()
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join(": ")
                    })
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        if !from_errors.is_empty() {
            return format!("HTTP {status}: {}", from_errors.join("; "));
        }
        if let Some(error) = parsed["error"].as_str().filter(|e| !e.is_empty()) {
            return format!("HTTP {status}: {error}");
        }
        if let Some(message) = parsed["error"]["message"]
            .as_str()
            .filter(|e| !e.is_empty())
        {
            return format!("HTTP {status}: {message}");
        }
        if let Some(message) = parsed["message"].as_str().filter(|e| !e.is_empty()) {
            return format!("HTTP {status}: {message}");
        }
    }
    let cut: String = trimmed.chars().take(300).collect();
    format!("HTTP {status}: {cut}")
}

/// `postExpoChunk`: one request; a rejected batch is retried one by one.
fn post_expo_chunk<'a>(
    http: Option<&'a OutboundHttp>,
    chunk: &'a [Value],
) -> std::pin::Pin<Box<dyn Future<Output = Vec<Value>> + Send + 'a>> {
    Box::pin(async move {
        let Some(http) = http else {
            let message = "no outbound HTTP client";
            return chunk
                .iter()
                .map(|_| json!({ "status": "error", "message": message }))
                .collect();
        };
        let request = HttpRequest::json("POST", EXPO_PUSH_URL, &Value::Array(chunk.to_vec()))
            .header("accept", "application/json");
        let (status, body) = match http.send(request).await {
            Ok(response) if response.ok() => {
                let parsed = response.json();
                return parsed["data"].as_array().cloned().unwrap_or_default();
            }
            Ok(response) => (response.status, response.text()),
            Err(error) => {
                let message = error.to_string();
                tracing::error!(%message, "[ExpoPush] request failed");
                return chunk
                    .iter()
                    .map(|_| json!({ "status": "error", "message": message }))
                    .collect();
            }
        };
        let message = format_expo_error(status, &body);
        tracing::error!(%message, "[ExpoPush] API error");
        if chunk.len() > 1 && (status == 400 || status == 403) {
            let mut tickets = Vec::new();
            for item in chunk {
                tickets.extend(post_expo_chunk(Some(http), std::slice::from_ref(item)).await);
            }
            return tickets;
        }
        chunk
            .iter()
            .map(|_| json!({ "status": "error", "message": message }))
            .collect()
    })
}

struct CallPush {
    delivered: HashSet<String>,
    invalid_tokens: Vec<String>,
}

/// `sendToCallTokens`: `VoIP` to `voip` tokens, Expo data to `expo_call` ones.
async fn send_to_call_tokens(
    notifier: &Notifier,
    rows: &[&TokenRow],
    data: &Map<String, Value>,
) -> CallPush {
    let mut result = CallPush {
        delivered: HashSet::new(),
        invalid_tokens: Vec::new(),
    };
    let expiration = (now_ms() + CALL_RING_TTL_MS) / 1000;
    // `VoIP`.
    for row in rows.iter().filter(|r| r.token_type == "voip") {
        let topic = (row.app_code == "weldchat").then_some("com.weldsuite.weldchat.voip");
        let (Some(config), Some(topic), Some(token), Some(http)) = (
            notifier.apns.as_ref(),
            topic,
            row.token.as_deref(),
            notifier.http.as_ref(),
        ) else {
            continue;
        };
        let payload = json!({ "aps": {}, "weldchat": data });
        match send_apns_voip(http, config, token, topic, &payload, expiration).await {
            ApnsResult::Ok => {
                result
                    .delivered
                    .insert(call_token_device_id(&row.device_id));
            }
            ApnsResult::InvalidToken => result.invalid_tokens.push(token.to_owned()),
            ApnsResult::Error(reason) => {
                tracing::error!(device = %row.device_id, %reason, "[CallPush] VoIP push failed");
            }
        }
    }
    // Expo data messages, by app code.
    let mut by_app: Vec<(String, Vec<&TokenRow>)> = Vec::new();
    for row in rows.iter().filter(|r| r.token_type == "expo_call") {
        let Some(token) = row.token.as_deref() else {
            continue;
        };
        if !EXPO_TOKEN.is_match(token) {
            result.invalid_tokens.push(token.to_owned());
            continue;
        }
        match by_app.iter_mut().find(|(code, _)| *code == row.app_code) {
            Some((_, list)) => list.push(row),
            None => by_app.push((row.app_code.clone(), vec![*row])),
        }
    }
    let ttl = (CALL_RING_TTL_MS + 999) / 1000;
    for (_, app_rows) in by_app {
        let messages: Vec<Value> = app_rows
            .iter()
            .map(|row| json!({ "to": row.token, "data": data, "priority": "high", "ttl": ttl }))
            .collect();
        let sent = send_expo_push(notifier.http.as_ref(), messages).await;
        result
            .invalid_tokens
            .extend(sent.invalid_tokens.into_iter().filter(|t| !t.is_empty()));
        for (index, ticket) in sent.tickets.iter().enumerate() {
            if ticket["status"] == "ok"
                && let Some(row) = app_rows.get(index)
            {
                result
                    .delivered
                    .insert(call_token_device_id(&row.device_id));
            }
        }
    }
    result
}

enum ApnsResult {
    Ok,
    InvalidToken,
    Error(String),
}

/// The provider token, reused for 50 minutes per key (`apnsProviderToken`).
static PROVIDER_TOKEN: Mutex<Option<(String, String, i64)>> = Mutex::new(None);

fn apns_provider_token(config: &ApnsConfig) -> Result<String, String> {
    let now = now_ms();
    let mut cached = PROVIDER_TOKEN
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if let Some((key_id, token, issued)) = cached.as_ref()
        && *key_id == config.key_id
        && now - issued < 50 * 60_000
    {
        return Ok(token.clone());
    }
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256);
    header.kid = Some(config.key_id.clone());
    header.typ = None;
    let claims = json!({ "iss": config.team_id, "iat": now / 1000 });
    let key = jsonwebtoken::EncodingKey::from_ec_pem(config.private_key.as_bytes())
        .map_err(|e| e.to_string())?;
    let token = jsonwebtoken::encode(&header, &claims, &key).map_err(|e| e.to_string())?;
    *cached = Some((config.key_id.clone(), token.clone(), now));
    Ok(token)
}

/// `sendApnsVoipPush`: production first, the sandbox when production says
/// the token is not one of its own.
async fn send_apns_voip(
    http: &OutboundHttp,
    config: &ApnsConfig,
    device_token: &str,
    topic: &str,
    payload: &Value,
    expiration: i64,
) -> ApnsResult {
    if !HEX_TOKEN.is_match(device_token) {
        return ApnsResult::InvalidToken;
    }
    let jwt = match apns_provider_token(config) {
        Ok(jwt) => jwt,
        Err(reason) => return ApnsResult::Error(reason),
    };
    let mut last = (0u16, String::new());
    for host in APNS_HOSTS {
        let request = HttpRequest {
            method: "POST".to_owned(),
            url: format!("{host}/3/device/{device_token}"),
            headers: vec![
                ("authorization".to_owned(), format!("bearer {jwt}")),
                ("apns-topic".to_owned(), topic.to_owned()),
                ("apns-push-type".to_owned(), "voip".to_owned()),
                ("apns-priority".to_owned(), "10".to_owned()),
                ("apns-expiration".to_owned(), expiration.to_string()),
                ("content-type".to_owned(), "application/json".to_owned()),
            ],
            body: Some(payload.to_string().into_bytes()),
        };
        last = match http.send(request).await {
            Ok(response) if response.ok() => (response.status, String::new()),
            Ok(response) => {
                let reason = response.json()["reason"]
                    .as_str()
                    .map_or_else(|| format!("HTTP {}", response.status), str::to_owned);
                (response.status, reason)
            }
            Err(error) => return ApnsResult::Error(error.to_string()),
        };
        if last.0 == 200 {
            return ApnsResult::Ok;
        }
        if last.1 != "BadDeviceToken" {
            break;
        }
    }
    if last.0 == 410 || last.1 == "BadDeviceToken" || last.1 == "Unregistered" {
        return ApnsResult::InvalidToken;
    }
    ApnsResult::Error(last.1)
}

/// Why a ring is withdrawn (`CallCancelReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallCancelReason {
    Answered,
    Declined,
    Ended,
}

impl CallCancelReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Answered => "answered",
            Self::Declined => "declined",
            Self::Ended => "ended",
        }
    }
}

/// `cancelIncomingCallPush`: stop the native ring on the user's call
/// tokens. Never fails.
pub async fn cancel_incoming_call_push(
    db: &PgPool,
    notifier: &Notifier,
    user_id: &str,
    call_id: &str,
    reason: CallCancelReason,
) {
    let run = async {
        let prefs = channel_preferences(db, user_id, "weldchat").await?;
        if !prefs.push {
            return Ok::<(), sqlx::Error>(());
        }
        let rows: Vec<(Option<String>, String, String, String)> = sqlx::query_as(
            "select token, app_code, device_id, token_type from device_tokens
             where user_id = $1 and is_active is null and (token_type = 'voip' or token_type = 'expo_call')",
        )
        .bind(user_id)
        .fetch_all(db)
        .await?;
        if rows.is_empty() {
            return Ok(());
        }
        let tokens: Vec<TokenRow> = rows
            .into_iter()
            .map(|(token, app_code, device_id, token_type)| TokenRow {
                token,
                app_code,
                device_id,
                token_type,
            })
            .collect();
        let refs: Vec<&TokenRow> = tokens.iter().collect();
        let mut data = Map::new();
        data.insert(
            "notificationType".to_owned(),
            Value::from("chat_call_cancel"),
        );
        data.insert("callId".to_owned(), Value::from(call_id));
        data.insert("reason".to_owned(), Value::from(reason.as_str()));
        let sent = send_to_call_tokens(notifier, &refs, &data).await;
        deactivate_device_tokens(db, &sent.invalid_tokens).await
    };
    if let Err(error) = run.await {
        tracing::error!(%error, "[CallPush] Cancel failed");
    }
}
