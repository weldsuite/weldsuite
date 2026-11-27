//! Push: Expo for the React Native apps (`channels/push.ts`), and straight
//! to Apple and Google for the native apps: an APNs alert on `apns` tokens,
//! an FCM HTTP v1 message on `fcm` tokens. For an incoming call, the native
//! ring (`channels/call-push.ts`): Apple's `VoIP` push on `voip` tokens
//! (`channels/apns.ts`), an Expo data message on `expo_call` tokens, a
//! data-only FCM message on `fcm_call` tokens. Dead tokens are deactivated.
//! Each one's data names the install it comes from (`server`,
//! [`crate::set_push_server`]).
//!
//! APNs and FCM take their keys from [`set_native_push`] (APNs also from a
//! [`Notifier`]'s own key). A sender without its key is skipped, with one
//! warning per process, and its tokens stay active.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock, PoisonError};

use regex::Regex;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_ports::{HttpRequest, OutboundHttp};
use weldsuite_schema::tenant::device_tokens;

use crate::{
    NewNotification, Notifier, channel_preferences, orm, push_data, push_server, tag_server,
    to_millis, utc_wall_clock,
};

/// A device token as delivery reads it: token, app code, device id, type.
type TokenTuple = (Option<String>, String, String, String);

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";
const MAX_PER_REQUEST: usize = 100;
const CALL_DEVICE_SUFFIX: &str = ":call";
const CALL_RING_TTL_MS: i64 = 60_000;
const APNS_HOSTS: [&str; 2] = [
    "https://api.push.apple.com",
    "https://api.sandbox.push.apple.com",
];
/// The native apps' bundle ids (and Android package names):
/// `com.weldsuite.<app code>`.
const BUNDLE_PREFIX: &str = "com.weldsuite.";
const FCM_PROJECTS_URL: &str = "https://fcm.googleapis.com/v1/projects";
const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT: &str = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/// An FCM access token is used until this long before it expires.
const FCM_TOKEN_MARGIN_MS: i64 = 5 * 60_000;
const APNS_SETTINGS: &str = "APNs is not configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY)";
const FCM_SETTINGS: &str = "FCM is not configured (FCM_SERVICE_ACCOUNT)";

/// The token types that ring a phone for a call (`deviceId` `<id>:call`):
/// never for ordinary pushes.
pub const CALL_TOKEN_TYPES: [&str; 3] = ["voip", "expo_call", "fcm_call"];

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

/// The Firebase service account FCM HTTP v1 is sent with
/// (`FCM_SERVICE_ACCOUNT`, its JSON key file): one Firebase project for
/// every app.
#[derive(Clone, PartialEq, Eq)]
pub struct FcmConfig {
    pub project_id: String,
    pub client_email: String,
    /// The account's RSA key, PEM.
    pub private_key: String,
    /// Where the signed assertion is exchanged for an access token.
    pub token_uri: String,
}

impl std::fmt::Debug for FcmConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FcmConfig")
            .field("project_id", &self.project_id)
            .field("client_email", &self.client_email)
            .field("token_uri", &self.token_uri)
            .finish_non_exhaustive()
    }
}

impl FcmConfig {
    /// The service account's JSON key file: `project_id`, `client_email`,
    /// `private_key` (`\n` escapes accepted) and `token_uri` (Google's when
    /// absent). Otherwise why it isn't one, never quoting its values.
    pub fn from_json(text: &str) -> Result<Self, String> {
        let value: Value = serde_json::from_str(text.trim()).map_err(|error| {
            format!(
                "not JSON (line {}, column {})",
                error.line(),
                error.column()
            )
        })?;
        let field = |name: &str| {
            value
                .get(name)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
        };
        let required = |name: &str| field(name).ok_or_else(|| format!("no `{name}`"));
        Ok(Self {
            project_id: required("project_id")?,
            client_email: required("client_email")?,
            private_key: required("private_key")?.replace("\\n", "\n"),
            token_uri: field("token_uri").unwrap_or_else(|| GOOGLE_TOKEN_URI.to_owned()),
        })
    }
}

/// What the native apps' pushes go out with ([`set_native_push`]).
#[derive(Clone, Default)]
pub struct NativePush {
    /// The APNs auth key: alert pushes, and the call ring when a
    /// [`Notifier`] brings no key of its own.
    pub apns: Option<ApnsConfig>,
    pub fcm: Option<FcmConfig>,
    /// Why `FCM_SERVICE_ACCOUNT`, though set, isn't usable (warned when the
    /// first FCM token is skipped).
    pub fcm_problem: Option<String>,
    /// The client they are sent with when the notifier brings none.
    pub http: Option<OutboundHttp>,
}

impl std::fmt::Debug for NativePush {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativePush")
            .field("apns", &self.apns)
            .field("fcm", &self.fcm)
            .field("fcm_problem", &self.fcm_problem)
            .field("http", &self.http.is_some())
            .finish()
    }
}

impl NativePush {
    /// From the server's settings: `APNS_KEY_ID`, `APNS_TEAM_ID` and
    /// `APNS_PRIVATE_KEY` (all three, else no APNs) and
    /// `FCM_SERVICE_ACCOUNT`. Without an HTTP client.
    pub fn from_env(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let apns = ApnsConfig::from_values(
            lookup("APNS_KEY_ID").as_deref(),
            lookup("APNS_TEAM_ID").as_deref(),
            lookup("APNS_PRIVATE_KEY").as_deref(),
        );
        let (fcm, fcm_problem) = match lookup("FCM_SERVICE_ACCOUNT")
            .filter(|value| !value.trim().is_empty())
            .map(|json| FcmConfig::from_json(&json))
        {
            None => (None, None),
            Some(Ok(config)) => (Some(config), None),
            Some(Err(problem)) => (None, Some(problem)),
        };
        Self {
            apns,
            fcm,
            fcm_problem,
            http: None,
        }
    }

    /// Whether either sender has its key.
    pub fn is_configured(&self) -> bool {
        self.apns.is_some() || self.fcm.is_some()
    }

    #[must_use]
    pub fn with_http(mut self, http: Option<OutboundHttp>) -> Self {
        self.http = http;
        self
    }
}

static NATIVE_PUSH: OnceLock<NativePush> = OnceLock::new();

/// Send the native apps' pushes (`apns` and `fcm` tokens, the `fcm_call`
/// ring) with `native` from now on. Once per process, at start; later calls
/// are ignored. A process that never calls it (conformance builds, which
/// compare with Global's workers, and tests) skips those tokens and leaves
/// them active.
pub fn set_native_push(native: NativePush) {
    let _ = NATIVE_PUSH.set(native);
}

/// What [`set_native_push`] set, if anything.
pub fn native_push() -> Option<&'static NativePush> {
    NATIVE_PUSH.get()
}

static APNS_SKIP_WARNED: AtomicBool = AtomicBool::new(false);
static FCM_SKIP_WARNED: AtomicBool = AtomicBool::new(false);

/// A sender without its key: one warning per process, never per push.
fn warn_unconfigured(flag: &AtomicBool, message: &str, problem: Option<&str>) {
    if !flag.swap(true, Ordering::Relaxed) {
        let problem = problem.unwrap_or("unset");
        tracing::warn!(
            %message,
            %problem,
            "[NativePush] Skipping native push tokens; they stay active"
        );
    }
}

fn warn_apns_unconfigured() {
    warn_unconfigured(&APNS_SKIP_WARNED, APNS_SETTINGS, None);
}

fn warn_fcm_unconfigured() {
    let problem = native_push().and_then(|native| native.fcm_problem.as_deref());
    warn_unconfigured(&FCM_SKIP_WARNED, FCM_SETTINGS, problem);
}

/// The APNs key: the notifier's, else [`set_native_push`]'s.
fn apns_config(notifier: &Notifier) -> Option<&ApnsConfig> {
    notifier
        .apns
        .as_ref()
        .or_else(|| native_push().and_then(|native| native.apns.as_ref()))
}

fn fcm_config() -> Option<&'static FcmConfig> {
    native_push().and_then(|native| native.fcm.as_ref())
}

/// The client native pushes go out on: the caller's (the notifier's, a
/// conformance request's), else [`set_native_push`]'s.
fn native_http(http: Option<&OutboundHttp>) -> Option<&OutboundHttp> {
    http.or_else(|| native_push().and_then(|native| native.http.as_ref()))
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

/// Whether a token type rings a phone for a call (`isCallToken`).
pub fn is_call_token_type(token_type: &str) -> bool {
    CALL_TOKEN_TYPES.contains(&token_type)
}

/// Whether a token type is a native app's push token (`apns`, `fcm`), sent
/// straight to Apple or Google rather than through Expo.
pub fn is_native_token_type(token_type: &str) -> bool {
    matches!(push_route(token_type), PushRoute::Apns | PushRoute::Fcm)
}

/// Where an ordinary push to a token goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PushRoute {
    Expo,
    Apns,
    Fcm,
    /// A call token: rung for a call, never sent an ordinary push.
    Call,
}

fn push_route(token_type: &str) -> PushRoute {
    match token_type {
        "apns" => PushRoute::Apns,
        "fcm" => PushRoute::Fcm,
        kind if is_call_token_type(kind) => PushRoute::Call,
        // `expo`, and a type this server doesn't know: Expo, where every
        // push went before the native senders.
        _ => PushRoute::Expo,
    }
}

struct TokenRow {
    token: Option<String>,
    app_code: String,
    device_id: String,
    token_type: String,
}

fn token_rows(rows: Vec<TokenTuple>) -> Vec<TokenRow> {
    rows.into_iter()
        .map(|(token, app_code, device_id, token_type)| TokenRow {
            token,
            app_code,
            device_id,
            token_type,
        })
        .collect()
}

fn is_call_token(row: &TokenRow) -> bool {
    is_call_token_type(&row.token_type)
}

fn call_token_device_id(device_id: &str) -> String {
    device_id
        .strip_suffix(CALL_DEVICE_SUFFIX)
        .unwrap_or(device_id)
        .to_owned()
}

/// Where a notification's ordinary pushes go: Expo tokens by app code (in
/// first-seen order, one Expo request each), native tokens one by one.
/// Call tokens, and devices the call ring already reached, get none.
#[derive(Default)]
struct PushPlan<'a> {
    expo_by_app: Vec<(String, Vec<String>)>,
    native: Vec<&'a TokenRow>,
}

fn plan_push<'a>(tokens: &'a [TokenRow], rung_devices: &HashSet<String>) -> PushPlan<'a> {
    let mut plan = PushPlan::default();
    for row in tokens {
        if rung_devices.contains(&row.device_id) {
            continue;
        }
        let Some(token) = row.token.as_deref().filter(|t| !t.is_empty()) else {
            continue;
        };
        match push_route(&row.token_type) {
            PushRoute::Call => {}
            PushRoute::Apns | PushRoute::Fcm => plan.native.push(row),
            PushRoute::Expo => match plan
                .expo_by_app
                .iter_mut()
                .find(|(code, _)| *code == row.app_code)
            {
                Some((_, list)) => list.push(token.to_owned()),
                None => plan
                    .expo_by_app
                    .push((row.app_code.clone(), vec![token.to_owned()])),
            },
        }
    }
    plan
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
) -> Result<(), DbErr> {
    use device_tokens::Column;
    let app_codes: Vec<String> = app_codes_for_category(&params.category)
        .into_iter()
        .map(str::to_owned)
        .collect();
    // `app_code = any($codes)`: an empty list matches nothing (`1 = 2`).
    let rows: Vec<TokenTuple> = device_tokens::Entity::find()
        .select_only()
        .columns([
            Column::Token,
            Column::AppCode,
            Column::DeviceId,
            Column::TokenType,
        ])
        .filter(Column::UserId.eq(&params.user_id))
        .filter(Column::IsActive.is_null())
        .filter(Column::AppCode.is_in(app_codes))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let tokens = token_rows(rows);

    let mut invalid: Vec<String> = Vec::new();
    let mut rung_devices: HashSet<String> = HashSet::new();
    if params.notification_type == "chat_incoming_call" {
        let mut data = push_data(params, push_server());
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
    let plan = plan_push(&tokens, &rung_devices);
    if plan.expo_by_app.is_empty() && plan.native.is_empty() && rung_devices.is_empty() {
        tracing::warn!(
            user = %params.user_id,
            category = %params.category,
            "[Notifications] No active push tokens"
        );
    }
    let (channel_id, priority) = android_delivery(&params.category, &params.notification_type);
    let data = push_data(params, push_server());
    if !plan.expo_by_app.is_empty() {
        let data = Value::Object(data.clone());
        for (_, app_tokens) in plan.expo_by_app {
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
    if !plan.native.is_empty() {
        let alert = NativeAlert {
            title: &params.title,
            body: &params.body,
            thread_id: &params.category,
            high_priority: priority == "high",
            android_channel: channel_id,
            data: &data,
        };
        invalid.extend(send_native_alerts(notifier, &plan.native, &alert).await);
    }
    deactivate_device_tokens(db, &invalid).await
}

/// A notification's alert to each native token; the tokens Apple or Google
/// call dead.
async fn send_native_alerts(
    notifier: &Notifier,
    rows: &[&TokenRow],
    alert: &NativeAlert<'_>,
) -> Vec<String> {
    let http = native_http(notifier.http.as_ref());
    let apns = apns_config(notifier);
    let mut invalid = Vec::new();
    for row in rows {
        let Some(token) = row.token.as_deref() else {
            continue;
        };
        match send_native(http, apns, &row.token_type, token, &row.app_code, alert).await {
            NativeOutcome::Sent | NativeOutcome::NotConfigured(_) => {}
            NativeOutcome::InvalidToken => invalid.push(token.to_owned()),
            NativeOutcome::Failed(reason) => tracing::error!(
                device = %row.device_id,
                kind = %row.token_type,
                %reason,
                "[NativePush] Push failed"
            ),
        }
    }
    invalid
}

/// `deactivateDeviceTokens`.
async fn deactivate_device_tokens(db: &PgPool, tokens: &[String]) -> Result<(), DbErr> {
    use device_tokens::Column;
    if tokens.is_empty() {
        return Ok(());
    }
    let now = utc_wall_clock(to_millis(OffsetDateTime::now_utc()));
    device_tokens::Entity::update_many()
        .col_expr(Column::IsActive, Expr::value(now))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Token.is_in(tokens))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// What `sendExpoPush` answers: the tickets, and the tokens Expo refused as
/// not registered (to deactivate).
#[derive(Debug, Default)]
pub struct ExpoResult {
    pub tickets: Vec<Value>,
    pub invalid_tokens: Vec<String>,
}

/// `sendExpoPush(messages)` (`@weldsuite/notifications/push`).
pub async fn send_expo_push(http: Option<&OutboundHttp>, messages: Vec<Value>) -> ExpoResult {
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

// ── Native alerts: APNs and FCM ─────────────────────────────────────────────

/// An alert as the native senders send it.
#[derive(Debug, Clone, Copy)]
pub struct NativeAlert<'a> {
    pub title: &'a str,
    pub body: &'a str,
    /// APNs' `thread-id`: one category's notifications group together.
    pub thread_id: &'a str,
    /// APNs priority 10 (else 5), FCM `HIGH` (else `NORMAL`).
    pub high_priority: bool,
    /// The Android notification channel (`androidDelivery`).
    pub android_channel: Option<&'a str>,
    /// The data the Expo message carries; FCM gets it as strings.
    pub data: &'a Map<String, Value>,
}

/// How one native push went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeOutcome {
    Sent,
    /// Apple or Google say the token is dead: deactivate it.
    InvalidToken,
    /// The sender has no key on this server (what it needs): skipped, and
    /// the token stays active.
    NotConfigured(&'static str),
    Failed(String),
}

/// How one APNs or FCM request went.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Delivery {
    Sent,
    InvalidToken,
    Failed(String),
}

impl From<Delivery> for NativeOutcome {
    fn from(delivery: Delivery) -> Self {
        match delivery {
            Delivery::Sent => Self::Sent,
            Delivery::InvalidToken => Self::InvalidToken,
            Delivery::Failed(reason) => Self::Failed(reason),
        }
    }
}

/// One alert to one native token (`apns`, `fcm`) as notifications send
/// them, with [`set_native_push`]'s keys; `http` is the request's client
/// when it brings one (conformance), else the configured one.
pub async fn send_native_alert(
    http: Option<&OutboundHttp>,
    token_type: &str,
    token: &str,
    app_code: &str,
    alert: &NativeAlert<'_>,
) -> NativeOutcome {
    let apns = native_push().and_then(|native| native.apns.as_ref());
    send_native(native_http(http), apns, token_type, token, app_code, alert).await
}

async fn send_native(
    http: Option<&OutboundHttp>,
    apns: Option<&ApnsConfig>,
    token_type: &str,
    token: &str,
    app_code: &str,
    alert: &NativeAlert<'_>,
) -> NativeOutcome {
    match push_route(token_type) {
        PushRoute::Apns => {
            let Some(config) = apns else {
                warn_apns_unconfigured();
                return NativeOutcome::NotConfigured(APNS_SETTINGS);
            };
            let Some(http) = http else {
                return NativeOutcome::Failed("no outbound HTTP client".to_owned());
            };
            let Some(topic) = bundle_id(app_code) else {
                return NativeOutcome::Failed(format!("no app has the code {app_code:?}"));
            };
            let payload = apns_alert_payload(alert);
            let push = ApnsPush {
                topic: &topic,
                push_type: "alert",
                priority: if alert.high_priority { 10 } else { 5 },
                expiration: None,
                payload: &payload,
            };
            send_apns(http, config, token, &push).await.into()
        }
        PushRoute::Fcm => {
            let Some(config) = fcm_config() else {
                warn_fcm_unconfigured();
                return NativeOutcome::NotConfigured(FCM_SETTINGS);
            };
            let Some(http) = http else {
                return NativeOutcome::Failed("no outbound HTTP client".to_owned());
            };
            send_fcm(http, config, &fcm_alert_message(token, alert))
                .await
                .into()
        }
        PushRoute::Expo | PushRoute::Call => {
            NativeOutcome::Failed(format!("{token_type:?} is no native push token"))
        }
    }
}

/// An app's bundle id (the APNs topic): `com.weldsuite.<app code>`.
fn bundle_id(app_code: &str) -> Option<String> {
    let valid = !app_code.is_empty()
        && app_code
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    valid.then(|| format!("{BUNDLE_PREFIX}{app_code}"))
}

/// An APNs alert: the title and body, the sound and badge, the category as
/// its thread, and the push's data next to `aps`.
fn apns_alert_payload(alert: &NativeAlert<'_>) -> Value {
    json!({
        "aps": {
            "alert": { "title": alert.title, "body": alert.body },
            "sound": "default",
            "badge": 1,
            "thread-id": alert.thread_id,
        },
        "data": alert.data,
    })
}

/// FCM's `data`: strings only. Strings stay, numbers and booleans are
/// written out, objects and arrays JSON-encoded; nulls are dropped, as are
/// the keys FCM reserves (`from`, `message_type`, `notification`,
/// `collapse_key`, `google…`, `gcm…`), which would fail the whole message.
fn fcm_data(data: &Map<String, Value>) -> Map<String, Value> {
    data.iter()
        .filter(|(key, _)| !is_reserved_fcm_key(key))
        .filter_map(|(key, value)| {
            let text = match value {
                Value::Null => return None,
                Value::String(text) => text.clone(),
                Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_) => {
                    value.to_string()
                }
            };
            Some((key.clone(), Value::String(text)))
        })
        .collect()
}

fn is_reserved_fcm_key(key: &str) -> bool {
    matches!(
        key,
        "from" | "message_type" | "notification" | "collapse_key"
    ) || key.starts_with("google")
        || key.starts_with("gcm")
}

/// An FCM HTTP v1 notification message.
fn fcm_alert_message(token: &str, alert: &NativeAlert<'_>) -> Value {
    let mut notification = json!({ "sound": "default" });
    if let Some(channel) = alert.android_channel {
        notification["channel_id"] = Value::from(channel);
    }
    json!({
        "message": {
            "token": token,
            "notification": { "title": alert.title, "body": alert.body },
            "data": fcm_data(alert.data),
            "android": {
                "priority": if alert.high_priority { "HIGH" } else { "NORMAL" },
                "notification": notification,
            },
        },
    })
}

/// The Android call ring (and its cancel): a data-only, high-priority FCM
/// message that lives as long as the ring, so the app wakes to ring
/// itself.
fn fcm_call_message(token: &str, data: &Map<String, Value>) -> Value {
    json!({
        "message": {
            "token": token,
            "data": fcm_data(data),
            "android": {
                "priority": "HIGH",
                "ttl": format!("{}s", CALL_RING_TTL_MS / 1000),
            },
        },
    })
}

/// The claims of the assertion a service account trades for an access
/// token (Google's OAuth 2.0 for service accounts).
fn fcm_jwt_claims(config: &FcmConfig, now_secs: i64) -> Value {
    json!({
        "iss": config.client_email,
        "sub": config.client_email,
        "scope": FCM_SCOPE,
        "aud": config.token_uri,
        "iat": now_secs,
        "exp": now_secs + 3600,
    })
}

/// The signed assertion (RS256).
fn fcm_assertion(config: &FcmConfig, now_secs: i64) -> Result<String, String> {
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(config.private_key.as_bytes())
        .map_err(|error| format!("FCM_SERVICE_ACCOUNT's private key: {error}"))?;
    let header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    jsonwebtoken::encode(&header, &fcm_jwt_claims(config, now_secs), &key)
        .map_err(|error| format!("signing the FCM assertion: {error}"))
}

/// `application/x-www-form-urlencoded`.
fn form_encode(pairs: &[(&str, &str)]) -> String {
    let encode = |text: &str| {
        let mut out = String::with_capacity(text.len());
        for byte in text.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                out.push(char::from(byte));
            } else {
                let _ = write!(out, "%{byte:02X}");
            }
        }
        out
    };
    pairs
        .iter()
        .map(|(name, value)| format!("{}={}", encode(name), encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// An access token, until it nearly expires.
struct FcmAccessToken {
    client_email: String,
    token_uri: String,
    token: String,
    expires_at_ms: i64,
}

/// The access tokens, by service account (one in practice).
static FCM_ACCESS_TOKENS: Mutex<Vec<FcmAccessToken>> = Mutex::new(Vec::new());

fn is_account(entry: &FcmAccessToken, config: &FcmConfig) -> bool {
    entry.client_email == config.client_email && entry.token_uri == config.token_uri
}

fn cached_fcm_token(config: &FcmConfig, now: i64) -> Option<String> {
    FCM_ACCESS_TOKENS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .find(|entry| is_account(entry, config) && now < entry.expires_at_ms - FCM_TOKEN_MARGIN_MS)
        .map(|entry| entry.token.clone())
}

fn store_fcm_token(config: &FcmConfig, token: &str, expires_at_ms: i64) {
    let mut cached = FCM_ACCESS_TOKENS
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    cached.retain(|entry| !is_account(entry, config));
    cached.push(FcmAccessToken {
        client_email: config.client_email.clone(),
        token_uri: config.token_uri.clone(),
        token: token.to_owned(),
        expires_at_ms,
    });
}

fn forget_fcm_token(config: &FcmConfig) {
    FCM_ACCESS_TOKENS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .retain(|entry| !is_account(entry, config));
}

/// An access token for FCM: the cached one until five minutes before it
/// expires, else a new one for a freshly signed assertion.
async fn fcm_access_token(http: &OutboundHttp, config: &FcmConfig) -> Result<String, String> {
    let now = now_ms();
    if let Some(token) = cached_fcm_token(config, now) {
        return Ok(token);
    }
    let assertion = fcm_assertion(config, now / 1000)?;
    let request = HttpRequest {
        method: "POST".to_owned(),
        url: config.token_uri.clone(),
        headers: vec![
            (
                "content-type".to_owned(),
                "application/x-www-form-urlencoded".to_owned(),
            ),
            ("accept".to_owned(), "application/json".to_owned()),
        ],
        body: Some(
            form_encode(&[("grant_type", JWT_BEARER_GRANT), ("assertion", &assertion)])
                .into_bytes(),
        ),
    };
    let response = http
        .send(request)
        .await
        .map_err(|error| format!("FCM token exchange failed: {error}"))?;
    let parsed = response.json();
    if !response.ok() {
        let reason = [
            parsed["error"].as_str(),
            parsed["error_description"].as_str(),
        ]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(": ");
        return Err(format!(
            "FCM token exchange: HTTP {}{}{reason}",
            response.status,
            if reason.is_empty() { "" } else { ": " }
        ));
    }
    let token = parsed["access_token"]
        .as_str()
        .filter(|token| !token.is_empty())
        .ok_or("FCM token exchange: no access_token")?
        .to_owned();
    let lifetime_ms = parsed["expires_in"]
        .as_i64()
        .unwrap_or(3600)
        .clamp(0, 86_400)
        * 1000;
    store_fcm_token(config, &token, now + lifetime_ms);
    Ok(token)
}

/// Whether FCM's answer says the token is dead: 404, `UNREGISTERED`, or an
/// `INVALID_ARGUMENT` about the registration token (not about the message).
fn fcm_token_is_dead(status: u16, body: &Value) -> bool {
    if status == 404 {
        return true;
    }
    let error = &body["error"];
    let details = || error["details"].as_array().into_iter().flatten();
    let codes: Vec<&str> = std::iter::once(error["status"].as_str())
        .chain(details().map(|detail| detail["errorCode"].as_str()))
        .flatten()
        .collect();
    if codes.contains(&"UNREGISTERED") {
        return true;
    }
    if codes.contains(&"INVALID_ARGUMENT") {
        let in_message = error["message"]
            .as_str()
            .is_some_and(|message| message.to_ascii_lowercase().contains("registration token"));
        let in_field = details()
            .filter_map(|detail| detail["fieldViolations"].as_array())
            .flatten()
            .any(|violation| violation["field"] == "message.token");
        return in_message || in_field;
    }
    false
}

/// A readable reason from FCM's error body.
fn fcm_error_reason(status: u16, body: &Value) -> String {
    let error = &body["error"];
    let code = error["details"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|detail| detail["errorCode"].as_str())
        .or_else(|| error["status"].as_str());
    let message = error["message"].as_str().filter(|m| !m.is_empty());
    match (code, message) {
        (Some(code), Some(message)) => format!("FCM HTTP {status}: {code}: {message}"),
        (Some(text), None) | (None, Some(text)) => format!("FCM HTTP {status}: {text}"),
        (None, None) => format!("FCM HTTP {status}"),
    }
}

/// One FCM HTTP v1 message. A refused access token is renewed once.
async fn send_fcm(http: &OutboundHttp, config: &FcmConfig, message: &Value) -> Delivery {
    let url = format!("{FCM_PROJECTS_URL}/{}/messages:send", config.project_id);
    for attempt in 0..2 {
        let token = match fcm_access_token(http, config).await {
            Ok(token) => token,
            Err(reason) => return Delivery::Failed(reason),
        };
        let request = HttpRequest::json("POST", url.clone(), message)
            .header("authorization", format!("Bearer {token}"));
        let response = match http.send(request).await {
            Ok(response) => response,
            Err(error) => return Delivery::Failed(format!("FCM request failed: {error}")),
        };
        if response.ok() {
            return Delivery::Sent;
        }
        if response.status == 401 && attempt == 0 {
            forget_fcm_token(config);
            continue;
        }
        let body = response.json();
        if fcm_token_is_dead(response.status, &body) {
            return Delivery::InvalidToken;
        }
        return Delivery::Failed(fcm_error_reason(response.status, &body));
    }
    Delivery::Failed("FCM refused a fresh access token".to_owned())
}

// ── The call ring ───────────────────────────────────────────────────────────

struct CallPush {
    delivered: HashSet<String>,
    invalid_tokens: Vec<String>,
}

/// `sendToCallTokens`: `VoIP` to `voip` tokens, a data-only FCM message to
/// `fcm_call` ones, Expo data to `expo_call` ones.
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
    let http = native_http(notifier.http.as_ref());
    // `VoIP`.
    for row in rows.iter().filter(|r| r.token_type == "voip") {
        let topic = (row.app_code == "weldchat").then_some("com.weldsuite.weldchat.voip");
        let (Some(config), Some(topic), Some(token), Some(http)) =
            (apns_config(notifier), topic, row.token.as_deref(), http)
        else {
            continue;
        };
        let payload = json!({ "aps": {}, "weldchat": data });
        let push = ApnsPush {
            topic,
            push_type: "voip",
            priority: 10,
            expiration: Some(expiration),
            payload: &payload,
        };
        match send_apns(http, config, token, &push).await {
            Delivery::Sent => {
                result
                    .delivered
                    .insert(call_token_device_id(&row.device_id));
            }
            Delivery::InvalidToken => result.invalid_tokens.push(token.to_owned()),
            Delivery::Failed(reason) => {
                tracing::error!(device = %row.device_id, %reason, "[CallPush] VoIP push failed");
            }
        }
    }
    // Android's ring over FCM.
    let fcm_rows: Vec<&TokenRow> = rows
        .iter()
        .copied()
        .filter(|r| r.token_type == "fcm_call")
        .collect();
    if !fcm_rows.is_empty() {
        match (fcm_config(), http) {
            (Some(config), Some(http)) => {
                for row in fcm_rows {
                    let Some(token) = row.token.as_deref().filter(|t| !t.is_empty()) else {
                        continue;
                    };
                    match send_fcm(http, config, &fcm_call_message(token, data)).await {
                        Delivery::Sent => {
                            result
                                .delivered
                                .insert(call_token_device_id(&row.device_id));
                        }
                        Delivery::InvalidToken => result.invalid_tokens.push(token.to_owned()),
                        Delivery::Failed(reason) => {
                            tracing::error!(device = %row.device_id, %reason, "[CallPush] FCM ring failed");
                        }
                    }
                }
            }
            (None, _) => warn_fcm_unconfigured(),
            (Some(_), None) => {}
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

// ── APNs ────────────────────────────────────────────────────────────────────

/// One APNs push: its topic, type, priority, expiry and payload.
struct ApnsPush<'a> {
    topic: &'a str,
    push_type: &'static str,
    priority: u8,
    /// `apns-expiration`, seconds since the epoch; none for an alert.
    expiration: Option<i64>,
    payload: &'a Value,
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

/// The request for one APNs host.
fn apns_request(host: &str, device_token: &str, jwt: &str, push: &ApnsPush<'_>) -> HttpRequest {
    let mut headers = vec![
        ("authorization".to_owned(), format!("bearer {jwt}")),
        ("apns-topic".to_owned(), push.topic.to_owned()),
        ("apns-push-type".to_owned(), push.push_type.to_owned()),
        ("apns-priority".to_owned(), push.priority.to_string()),
    ];
    if let Some(expiration) = push.expiration {
        headers.push(("apns-expiration".to_owned(), expiration.to_string()));
    }
    headers.push(("content-type".to_owned(), "application/json".to_owned()));
    HttpRequest {
        method: "POST".to_owned(),
        url: format!("{host}/3/device/{device_token}"),
        headers,
        body: Some(push.payload.to_string().into_bytes()),
    }
}

/// `sendApnsVoipPush`, for every push type: production first, the sandbox
/// when production says the token is not one of its own (a debug build's).
async fn send_apns(
    http: &OutboundHttp,
    config: &ApnsConfig,
    device_token: &str,
    push: &ApnsPush<'_>,
) -> Delivery {
    if !HEX_TOKEN.is_match(device_token) {
        return Delivery::InvalidToken;
    }
    let jwt = match apns_provider_token(config) {
        Ok(jwt) => jwt,
        Err(reason) => return Delivery::Failed(reason),
    };
    let mut last = (0u16, String::new());
    for host in APNS_HOSTS {
        let request = apns_request(host, device_token, &jwt, push);
        last = match http.send(request).await {
            Ok(response) if response.ok() => (response.status, String::new()),
            Ok(response) => {
                let reason = response.json()["reason"]
                    .as_str()
                    .map_or_else(|| format!("HTTP {}", response.status), str::to_owned);
                (response.status, reason)
            }
            Err(error) => return Delivery::Failed(error.to_string()),
        };
        if last.0 == 200 {
            return Delivery::Sent;
        }
        if last.1 != "BadDeviceToken" {
            break;
        }
    }
    if last.0 == 410 || last.1 == "BadDeviceToken" || last.1 == "Unregistered" {
        return Delivery::InvalidToken;
    }
    Delivery::Failed(last.1)
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
            return Ok::<(), DbErr>(());
        }
        let rows: Vec<TokenTuple> = {
            use device_tokens::Column;
            device_tokens::Entity::find()
                .select_only()
                .columns([
                    Column::Token,
                    Column::AppCode,
                    Column::DeviceId,
                    Column::TokenType,
                ])
                .filter(Column::UserId.eq(user_id))
                .filter(Column::IsActive.is_null())
                .filter(Column::TokenType.is_in(CALL_TOKEN_TYPES))
                .into_tuple()
                .all(&orm(db))
                .await?
        };
        if rows.is_empty() {
            return Ok(());
        }
        let tokens = token_rows(rows);
        let refs: Vec<&TokenRow> = tokens.iter().collect();
        let mut data = Map::new();
        data.insert(
            "notificationType".to_owned(),
            Value::from("chat_call_cancel"),
        );
        data.insert("callId".to_owned(), Value::from(call_id));
        data.insert("reason".to_owned(), Value::from(reason.as_str()));
        tag_server(&mut data, push_server());
        let sent = send_to_call_tokens(notifier, &refs, &data).await;
        deactivate_device_tokens(db, &sent.invalid_tokens).await
    };
    if let Err(error) = run.await {
        tracing::error!(%error, "[CallPush] Cancel failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_ports::{BoxFuture, DynOutboundHttp, HttpResponse, PortError};

    /// Records every request and answers each with `answer`.
    struct Recorder {
        requests: Mutex<Vec<HttpRequest>>,
        answer: Box<dyn Fn(&HttpRequest) -> HttpResponse + Send + Sync>,
    }

    impl DynOutboundHttp for Recorder {
        fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            let response = (self.answer)(&request);
            self.requests
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(request);
            Box::pin(std::future::ready(Ok(response)))
        }
    }

    fn recorder(
        answer: impl Fn(&HttpRequest) -> HttpResponse + Send + Sync + 'static,
    ) -> (std::sync::Arc<Recorder>, OutboundHttp) {
        let recorder = std::sync::Arc::new(Recorder {
            requests: Mutex::new(Vec::new()),
            answer: Box::new(answer),
        });
        let http = OutboundHttp(recorder.clone());
        (recorder, http)
    }

    fn answer(status: u16, body: &Value) -> HttpResponse {
        HttpResponse::new(status, body.to_string().into_bytes())
    }

    fn header<'a>(request: &'a HttpRequest, name: &str) -> Option<&'a str> {
        request
            .headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    fn body(request: &HttpRequest) -> Value {
        serde_json::from_slice(request.body.as_deref().unwrap_or_default()).unwrap_or(Value::Null)
    }

    fn row(token: &str, app_code: &str, device_id: &str, token_type: &str) -> TokenRow {
        TokenRow {
            token: Some(token.to_owned()),
            app_code: app_code.to_owned(),
            device_id: device_id.to_owned(),
            token_type: token_type.to_owned(),
        }
    }

    fn data() -> Map<String, Value> {
        let mut data = Map::new();
        data.insert("actionUrl".to_owned(), json!("/weldchat/dm/ch_1"));
        data.insert("notificationType".to_owned(), json!("chat_dm"));
        data.insert("server".to_owned(), json!("https://app.test.weldsuite.eu"));
        data
    }

    fn alert(data: &Map<String, Value>, high_priority: bool) -> NativeAlert<'_> {
        NativeAlert {
            title: "New message from Ann",
            body: "hi",
            thread_id: "weldchat",
            high_priority,
            android_channel: Some("chat"),
            data,
        }
    }

    fn fcm(client_email: &str) -> FcmConfig {
        FcmConfig {
            project_id: "weldsuite-push".to_owned(),
            client_email: client_email.to_owned(),
            private_key: "not a key".to_owned(),
            token_uri: GOOGLE_TOKEN_URI.to_owned(),
        }
    }

    #[test]
    fn call_tokens_are_voip_expo_call_and_fcm_call() {
        for kind in ["voip", "expo_call", "fcm_call"] {
            assert!(is_call_token_type(kind), "{kind}");
            assert_eq!(push_route(kind), PushRoute::Call, "{kind}");
            assert!(!is_native_token_type(kind), "{kind}");
        }
        for kind in ["expo", "apns", "fcm", ""] {
            assert!(!is_call_token_type(kind), "{kind}");
        }
    }

    #[test]
    fn tokens_route_by_type() {
        assert_eq!(push_route("expo"), PushRoute::Expo);
        assert_eq!(push_route("apns"), PushRoute::Apns);
        assert_eq!(push_route("fcm"), PushRoute::Fcm);
        // A type this server doesn't know goes to Expo, as before.
        assert_eq!(push_route("legacy"), PushRoute::Expo);
        assert!(is_native_token_type("apns") && is_native_token_type("fcm"));
        assert!(!is_native_token_type("expo"));

        let tokens = [
            row("ExponentPushToken[a]", "weldchat", "phone-a", "expo"),
            row("ExponentPushToken[b]", "weldsuite", "phone-b", "expo"),
            row("ExponentPushToken[c]", "weldchat", "phone-c", "expo"),
            row(&"ab".repeat(32), "weldchat", "iphone", "apns"),
            row("fcm-token", "weldchat", "pixel", "fcm"),
            row(&"cd".repeat(32), "weldchat", "iphone:call", "voip"),
            row("fcm-call-token", "weldchat", "pixel:call", "fcm_call"),
            row(
                "ExponentPushToken[call]",
                "weldchat",
                "phone-a:call",
                "expo_call",
            ),
            row("", "weldchat", "empty", "fcm"),
        ];
        let plan = plan_push(&tokens, &HashSet::new());
        assert_eq!(
            plan.expo_by_app,
            vec![
                (
                    "weldchat".to_owned(),
                    vec![
                        "ExponentPushToken[a]".to_owned(),
                        "ExponentPushToken[c]".to_owned()
                    ]
                ),
                (
                    "weldsuite".to_owned(),
                    vec!["ExponentPushToken[b]".to_owned()]
                ),
            ]
        );
        let native: Vec<&str> = plan.native.iter().map(|r| r.device_id.as_str()).collect();
        assert_eq!(native, ["iphone", "pixel"]);

        // A device the call ring reached gets no ordinary push.
        let rung = HashSet::from(["pixel".to_owned(), "phone-a".to_owned()]);
        let plan = plan_push(&tokens, &rung);
        let native: Vec<&str> = plan.native.iter().map(|r| r.device_id.as_str()).collect();
        assert_eq!(native, ["iphone"]);
        assert_eq!(
            plan.expo_by_app,
            vec![
                (
                    "weldsuite".to_owned(),
                    vec!["ExponentPushToken[b]".to_owned()]
                ),
                (
                    "weldchat".to_owned(),
                    vec!["ExponentPushToken[c]".to_owned()]
                ),
            ]
        );
    }

    #[test]
    fn fcm_data_is_strings_only() {
        let mut data = Map::new();
        data.insert("text".to_owned(), json!("hello"));
        data.insert("count".to_owned(), json!(3));
        data.insert("ratio".to_owned(), json!(1.5));
        data.insert("flag".to_owned(), json!(true));
        data.insert("list".to_owned(), json!(["a", 1]));
        data.insert("object".to_owned(), json!({ "a": 1 }));
        data.insert("gone".to_owned(), Value::Null);
        data.insert("empty".to_owned(), json!(""));
        data.insert("from".to_owned(), json!("someone"));
        data.insert("google.c.a.e".to_owned(), json!("1"));
        data.insert("gcm.n.e".to_owned(), json!("1"));
        let strings = fcm_data(&data);
        assert_eq!(
            Value::Object(strings),
            json!({
                "text": "hello",
                "count": "3",
                "ratio": "1.5",
                "flag": "true",
                "list": "[\"a\",1]",
                "object": "{\"a\":1}",
                "empty": "",
            })
        );
    }

    #[test]
    fn the_apns_alert_carries_the_push_data() {
        let data = data();
        assert_eq!(
            apns_alert_payload(&alert(&data, true)),
            json!({
                "aps": {
                    "alert": { "title": "New message from Ann", "body": "hi" },
                    "sound": "default",
                    "badge": 1,
                    "thread-id": "weldchat",
                },
                "data": {
                    "actionUrl": "/weldchat/dm/ch_1",
                    "notificationType": "chat_dm",
                    "server": "https://app.test.weldsuite.eu",
                },
            })
        );
        assert_eq!(
            bundle_id("weldchat").as_deref(),
            Some("com.weldsuite.weldchat")
        );
        assert_eq!(bundle_id(""), None);
        assert_eq!(bundle_id("weld chat"), None);

        let payload = apns_alert_payload(&alert(&data, false));
        let push = ApnsPush {
            topic: "com.weldsuite.weldchat",
            push_type: "alert",
            priority: 5,
            expiration: None,
            payload: &payload,
        };
        let token = "ab".repeat(32);
        let request = apns_request(APNS_HOSTS[0], &token, "jwt", &push);
        assert_eq!(request.method, "POST");
        assert_eq!(
            request.url,
            format!("https://api.push.apple.com/3/device/{token}")
        );
        assert_eq!(
            request.headers,
            [
                ("authorization", "bearer jwt"),
                ("apns-topic", "com.weldsuite.weldchat"),
                ("apns-push-type", "alert"),
                ("apns-priority", "5"),
                ("content-type", "application/json"),
            ]
            .map(|(n, v)| (n.to_owned(), v.to_owned()))
        );
        assert_eq!(body(&request), payload);
    }

    #[test]
    fn the_fcm_message_is_a_notification_with_string_data() {
        let mut data = data();
        data.insert("badge".to_owned(), json!(2));
        assert_eq!(
            fcm_alert_message("fcm-token", &alert(&data, true)),
            json!({
                "message": {
                    "token": "fcm-token",
                    "notification": { "title": "New message from Ann", "body": "hi" },
                    "data": {
                        "actionUrl": "/weldchat/dm/ch_1",
                        "notificationType": "chat_dm",
                        "server": "https://app.test.weldsuite.eu",
                        "badge": "2",
                    },
                    "android": {
                        "priority": "HIGH",
                        "notification": { "sound": "default", "channel_id": "chat" },
                    },
                },
            })
        );
        let quiet = NativeAlert {
            android_channel: None,
            ..alert(&data, false)
        };
        let message = fcm_alert_message("fcm-token", &quiet);
        assert_eq!(message["message"]["android"]["priority"], "NORMAL");
        assert_eq!(
            message["message"]["android"]["notification"],
            json!({ "sound": "default" })
        );
    }

    #[test]
    fn the_android_ring_is_a_data_only_high_priority_message() {
        let mut data = Map::new();
        data.insert("notificationType".to_owned(), json!("chat_call_ring"));
        data.insert("callId".to_owned(), json!("call_1"));
        data.insert("expiresAt".to_owned(), json!("1767261600000"));
        assert_eq!(
            fcm_call_message("fcm-call-token", &data),
            json!({
                "message": {
                    "token": "fcm-call-token",
                    "data": {
                        "notificationType": "chat_call_ring",
                        "callId": "call_1",
                        "expiresAt": "1767261600000",
                    },
                    "android": { "priority": "HIGH", "ttl": "60s" },
                },
            })
        );
    }

    #[test]
    fn the_fcm_assertion_claims_name_the_service_account() {
        let config = fcm("push@weldsuite-push.iam.gserviceaccount.com");
        assert_eq!(
            fcm_jwt_claims(&config, 1_767_261_600),
            json!({
                "iss": "push@weldsuite-push.iam.gserviceaccount.com",
                "sub": "push@weldsuite-push.iam.gserviceaccount.com",
                "scope": "https://www.googleapis.com/auth/firebase.messaging",
                "aud": "https://oauth2.googleapis.com/token",
                "iat": 1_767_261_600,
                "exp": 1_767_265_200,
            })
        );
        // A broken key is a reason, never a panic, and never the key.
        let error = fcm_assertion(&config, 1_767_261_600).expect_err("no RSA key");
        assert!(
            error.starts_with("FCM_SERVICE_ACCOUNT's private key"),
            "{error}"
        );
        assert!(!error.contains("not a key"), "{error}");
        assert_eq!(
            form_encode(&[("grant_type", JWT_BEARER_GRANT), ("assertion", "a.b-c_d")]),
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=a.b-c_d"
        );
    }

    #[test]
    fn the_service_account_json_reads_like_googles_key_file() {
        let config = FcmConfig::from_json(
            r#"{"type":"service_account","project_id":"weldsuite-push",
               "private_key":"-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n",
               "client_email":"push@weldsuite-push.iam.gserviceaccount.com",
               "token_uri":"https://oauth2.googleapis.com/token"}"#,
        )
        .expect("a key file");
        assert_eq!(config.project_id, "weldsuite-push");
        assert_eq!(
            config.private_key,
            "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n"
        );
        assert!(!format!("{config:?}").contains("PRIVATE KEY"));
        let without_uri =
            FcmConfig::from_json(r#"{"project_id":"p","client_email":"e","private_key":"k"}"#)
                .expect("a key file");
        assert_eq!(without_uri.token_uri, GOOGLE_TOKEN_URI);
        assert_eq!(
            FcmConfig::from_json(r#"{"project_id":"p","private_key":"secret"}"#),
            Err("no `client_email`".to_owned())
        );
        let error = FcmConfig::from_json("{ secret").expect_err("not JSON");
        assert!(!error.contains("secret"), "{error}");

        let env = |name: &str| match name {
            "APNS_KEY_ID" => Some("KEY1".to_owned()),
            "APNS_TEAM_ID" => Some("TEAM1".to_owned()),
            "APNS_PRIVATE_KEY" => Some("pem".to_owned()),
            "FCM_SERVICE_ACCOUNT" => Some("[]".to_owned()),
            _ => None,
        };
        let native = NativePush::from_env(env);
        assert_eq!(
            native.apns.as_ref().map(|a| a.key_id.as_str()),
            Some("KEY1")
        );
        assert!(native.fcm.is_none());
        assert_eq!(native.fcm_problem.as_deref(), Some("no `project_id`"));
        assert!(native.is_configured());
        assert!(!NativePush::from_env(|_| None).is_configured());
    }

    #[test]
    fn fcm_errors_that_name_the_token_deactivate_it() {
        let fcm_error = |status: &str, code: &str, message: &str| {
            json!({ "error": {
                "status": status,
                "message": message,
                "details": [{
                    "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                    "errorCode": code,
                }],
            }})
        };
        assert!(fcm_token_is_dead(404, &Value::Null));
        assert!(fcm_token_is_dead(
            404,
            &fcm_error(
                "NOT_FOUND",
                "UNREGISTERED",
                "Requested entity was not found."
            )
        ));
        assert!(fcm_token_is_dead(
            400,
            &json!({ "error": { "status": "UNREGISTERED" } })
        ));
        assert!(fcm_token_is_dead(
            400,
            &fcm_error(
                "INVALID_ARGUMENT",
                "INVALID_ARGUMENT",
                "The registration token is not a valid FCM registration token"
            )
        ));
        assert!(fcm_token_is_dead(
            400,
            &json!({ "error": {
                "status": "INVALID_ARGUMENT",
                "message": "Request contains an invalid argument.",
                "details": [{
                    "@type": "type.googleapis.com/google.rpc.BadRequest",
                    "fieldViolations": [{ "field": "message.token", "description": "Invalid registration token" }],
                }],
            }})
        ));
        // An invalid message, a wrong sender, a quota: the token stays.
        assert!(!fcm_token_is_dead(
            400,
            &fcm_error(
                "INVALID_ARGUMENT",
                "INVALID_ARGUMENT",
                "Invalid value at 'message.data[0].value'"
            )
        ));
        assert!(!fcm_token_is_dead(
            403,
            &fcm_error(
                "PERMISSION_DENIED",
                "SENDER_ID_MISMATCH",
                "SenderId mismatch"
            )
        ));
        assert!(!fcm_token_is_dead(
            429,
            &fcm_error("RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED", "Quota exceeded")
        ));
        assert!(!fcm_token_is_dead(500, &Value::Null));
        assert_eq!(
            fcm_error_reason(
                403,
                &fcm_error(
                    "PERMISSION_DENIED",
                    "SENDER_ID_MISMATCH",
                    "SenderId mismatch"
                )
            ),
            "FCM HTTP 403: SENDER_ID_MISMATCH: SenderId mismatch"
        );
        assert_eq!(fcm_error_reason(503, &Value::Null), "FCM HTTP 503");
    }

    #[tokio::test]
    async fn fcm_sends_with_the_cached_access_token_and_reports_dead_tokens() {
        let config = fcm("send@weldsuite-push.iam.gserviceaccount.com");
        store_fcm_token(&config, "access-1", now_ms() + 3_600_000);
        let (recorder, http) = recorder(|request| {
            let token = body(request)["message"]["token"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            if token == "dead" {
                answer(
                    404,
                    &json!({ "error": { "status": "NOT_FOUND", "details": [{ "errorCode": "UNREGISTERED" }] } }),
                )
            } else {
                answer(
                    200,
                    &json!({ "name": "projects/weldsuite-push/messages/1" }),
                )
            }
        });
        let data = data();
        let sent = send_fcm(
            &http,
            &config,
            &fcm_alert_message("good", &alert(&data, true)),
        )
        .await;
        assert_eq!(sent, Delivery::Sent);
        let dead = send_fcm(
            &http,
            &config,
            &fcm_alert_message("dead", &alert(&data, true)),
        )
        .await;
        assert_eq!(dead, Delivery::InvalidToken);
        let requests = recorder
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        assert_eq!(
            requests.len(),
            2,
            "no token exchange while the cached one lasts"
        );
        assert_eq!(
            requests[0].url,
            "https://fcm.googleapis.com/v1/projects/weldsuite-push/messages:send"
        );
        assert_eq!(
            header(&requests[0], "authorization"),
            Some("Bearer access-1")
        );
        assert_eq!(
            header(&requests[0], "content-type"),
            Some("application/json")
        );
        assert_eq!(body(&requests[0])["message"]["token"], "good");
        forget_fcm_token(&config);
    }

    #[tokio::test]
    async fn an_access_token_close_to_expiry_is_renewed() {
        let config = fcm("renew@weldsuite-push.iam.gserviceaccount.com");
        // Four minutes left: within the five-minute margin.
        store_fcm_token(&config, "old", now_ms() + 4 * 60_000);
        assert_eq!(cached_fcm_token(&config, now_ms()), None);
        let (recorder, http) = recorder(|_| answer(200, &json!({})));
        // Renewing signs a new assertion, which this key can't: a reason,
        // and nothing sent.
        let sent = send_fcm(&http, &config, &json!({ "message": {} })).await;
        assert!(
            matches!(&sent, Delivery::Failed(reason) if reason.contains("private key")),
            "{sent:?}"
        );
        assert!(
            recorder
                .requests
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .is_empty()
        );
        store_fcm_token(&config, "fresh", now_ms() + 3_600_000);
        assert_eq!(
            cached_fcm_token(&config, now_ms()).as_deref(),
            Some("fresh")
        );
        forget_fcm_token(&config);
    }

    #[tokio::test]
    async fn apns_tries_the_sandbox_for_a_debug_builds_token() {
        let config = ApnsConfig {
            key_id: "SANDBOXKEY".to_owned(),
            team_id: "TEAM".to_owned(),
            private_key: "not a key".to_owned(),
        };
        *PROVIDER_TOKEN
            .lock()
            .unwrap_or_else(PoisonError::into_inner) =
            Some(("SANDBOXKEY".to_owned(), "provider-jwt".to_owned(), now_ms()));
        let (recorder, http) = recorder(|request| {
            if request.url.starts_with("https://api.push.apple.com/") {
                answer(400, &json!({ "reason": "BadDeviceToken" }))
            } else {
                answer(200, &json!({}))
            }
        });
        let data = data();
        let payload = apns_alert_payload(&alert(&data, true));
        let push = ApnsPush {
            topic: "com.weldsuite.weldchat",
            push_type: "alert",
            priority: 10,
            expiration: None,
            payload: &payload,
        };
        let token = "ef".repeat(32);
        assert_eq!(
            send_apns(&http, &config, &token, &push).await,
            Delivery::Sent
        );
        let hosts: Vec<String> = recorder
            .requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(|r| r.url.clone())
            .collect();
        assert_eq!(
            hosts,
            [
                format!("https://api.push.apple.com/3/device/{token}"),
                format!("https://api.sandbox.push.apple.com/3/device/{token}"),
            ]
        );
        // Not a hex token: dead without a request.
        assert_eq!(
            send_apns(&http, &config, "fcm-token", &push).await,
            Delivery::InvalidToken
        );
    }

    #[tokio::test]
    async fn a_sender_without_its_key_skips_and_keeps_the_token() {
        let data = data();
        let (_, http) = recorder(|_| answer(200, &json!({})));
        assert_eq!(
            send_native(
                Some(&http),
                None,
                "apns",
                &"ab".repeat(32),
                "weldchat",
                &alert(&data, true)
            )
            .await,
            NativeOutcome::NotConfigured(APNS_SETTINGS)
        );
        // No `set_native_push` in tests: FCM has no key.
        assert_eq!(
            send_native(
                Some(&http),
                None,
                "fcm",
                "fcm-token",
                "weldchat",
                &alert(&data, true)
            )
            .await,
            NativeOutcome::NotConfigured(FCM_SETTINGS)
        );
        assert!(matches!(
            send_native(
                Some(&http),
                None,
                "expo",
                "ExponentPushToken[a]",
                "weldchat",
                &alert(&data, true)
            )
            .await,
            NativeOutcome::Failed(_)
        ));
    }
}
