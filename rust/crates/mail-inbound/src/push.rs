//! `push-notifications.ts` and `expo-push.ts`: the WeldMail app's "new
//! email" push to a member's devices through the Expo Push API, with the
//! inbox badge, and invalid tokens switched off. Its data names the install
//! it comes from (`server`, `weldsuite_notifications::set_push_server`).
//!
//! Tokens are routed as the notifications' push routes them: `expo` (and a
//! type this server doesn't know) through Expo as before, the native app's
//! `apns` and `fcm` tokens straight to Apple and Google
//! (`weldsuite_notifications::send_native_alert`), call tokens not at all.
//! A native sender without its key leaves its tokens active.

use std::time::Duration;

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_notifications::{
    NativeAlert, NativeOutcome, is_call_token_type, is_native_token_type, send_native_alert,
};
use weldsuite_ports::{HttpRequest, OutboundHttp};
use weldsuite_schema::tenant::device_tokens;

use crate::context::InboundContext;
use crate::parsed::ParsedEmail;
use crate::recipients::RecipientAccount;
use crate::store::{Stored, utf16_prefix};

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";
/// `EXPO_PROJECT_IDS.weldmail`: the WeldMail app's EAS project.
const WELDMAIL_PROJECT_ID: &str = "07f1af16-fb8b-4a5d-95c1-0b8554016309";
const MAX_PER_REQUEST: usize = 100;
const MAX_RETRY_ATTEMPTS: u32 = 3;
const BASE_RETRY_DELAY_MS: u64 = 500;

/// Ticket errors that mean the token is gone for good.
const PERMANENT_TOKEN_ERROR_CODES: [&str; 3] = [
    "DeviceNotRegistered",
    "MismatchSenderId",
    "InvalidCredentials",
];

/// `sendChunkWithRetry`: one chunk, retried on 429 and 5xx; a full-length
/// list of tickets either way.
async fn send_chunk(http: Option<&OutboundHttp>, chunk: &[Value]) -> Vec<Value> {
    let failed = |message: String| -> Vec<Value> {
        chunk
            .iter()
            .map(|_| json!({ "status": "error", "message": message }))
            .collect()
    };
    let Some(http) = http else {
        return failed("no outbound HTTP".to_owned());
    };
    for attempt in 0..MAX_RETRY_ATTEMPTS {
        let request = HttpRequest {
            method: "POST".to_owned(),
            url: EXPO_PUSH_URL.to_owned(),
            headers: vec![
                ("Content-Type".to_owned(), "application/json".to_owned()),
                ("Accept".to_owned(), "application/json".to_owned()),
                ("expo-project-id".to_owned(), WELDMAIL_PROJECT_ID.to_owned()),
            ],
            body: Some(Value::Array(chunk.to_vec()).to_string().into_bytes()),
        };
        match http.send(request).await {
            Ok(response) if response.ok() => {
                return response.json()["data"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
            }
            Ok(response) => {
                let retryable = response.status == 429 || response.status >= 500;
                if !retryable || attempt == MAX_RETRY_ATTEMPTS - 1 {
                    tracing::error!(
                        status = response.status,
                        attempt = attempt + 1,
                        "[ExpoPush] API error"
                    );
                    return failed(format!("HTTP {}", response.status));
                }
                tokio::time::sleep(Duration::from_millis(BASE_RETRY_DELAY_MS << attempt)).await;
            }
            Err(error) => {
                tracing::error!(%error, "[ExpoPush] request failed");
                return failed(error.to_string());
            }
        }
    }
    failed("Max retries exceeded".to_owned())
}

/// `sendExpoPush(messages, { projectId: weldmail })`: the tickets, and the
/// tokens to switch off.
async fn send_expo_push(
    http: Option<&OutboundHttp>,
    messages: &[Value],
) -> (Vec<Value>, Vec<String>) {
    let mut tickets = Vec::new();
    let mut invalid: Vec<String> = Vec::new();
    for chunk in messages.chunks(MAX_PER_REQUEST) {
        let answered = send_chunk(http, chunk).await;
        for (index, ticket) in answered.iter().enumerate() {
            if ticket["status"] != "error" {
                continue;
            }
            let code = ticket["details"]["error"].as_str().unwrap_or_default();
            if PERMANENT_TOKEN_ERROR_CODES.contains(&code)
                && let Some(token) = chunk.get(index).and_then(|m| m["to"].as_str())
                && !invalid.iter().any(|t| t == token)
            {
                invalid.push(token.to_owned());
            }
        }
        tickets.extend(answered);
    }
    (tickets, invalid)
}

/// A member's WeldMail tokens by where they go: Expo's (in the order read),
/// and the native app's as (token, type). Call tokens get no mail push.
#[derive(Debug, Default, PartialEq, Eq)]
struct Routed {
    expo: Vec<String>,
    native: Vec<(String, String)>,
}

fn route_tokens(rows: Vec<(String, String)>) -> Routed {
    let mut routed = Routed::default();
    for (token, token_type) in rows {
        if is_call_token_type(&token_type) {
            continue;
        }
        if is_native_token_type(&token_type) {
            if !token.is_empty() {
                routed.native.push((token, token_type));
            }
            continue;
        }
        // `expo`, and a type this server doesn't know: Expo, as before.
        routed.expo.push(token);
    }
    routed
}

/// The new-email alert as the native app gets it: the Expo message's title,
/// body and data, in the `weldmail` thread on Android's `email` channel.
fn native_alert<'a>(
    title: &'a str,
    body: &'a str,
    data: &'a Map<String, Value>,
) -> NativeAlert<'a> {
    NativeAlert {
        title,
        body,
        thread_id: "weldmail",
        high_priority: true,
        android_channel: Some("email"),
        data,
    }
}

/// How the native pushes went: how many were sent or failed, and the tokens
/// Apple or Google call dead (never those of a sender without its key).
#[derive(Debug, Default, PartialEq, Eq)]
struct NativeSent {
    sent: usize,
    failed: usize,
    invalid: Vec<String>,
}

async fn send_native_pushes(
    http: Option<&OutboundHttp>,
    native: &[(String, String)],
    alert: &NativeAlert<'_>,
) -> NativeSent {
    let mut result = NativeSent::default();
    for (token, token_type) in native {
        match send_native_alert(http, token_type, token, "weldmail", alert).await {
            NativeOutcome::Sent => result.sent += 1,
            NativeOutcome::InvalidToken => {
                result.failed += 1;
                if !result.invalid.contains(token) {
                    result.invalid.push(token.clone());
                }
            }
            NativeOutcome::NotConfigured(_) => result.failed += 1,
            NativeOutcome::Failed(reason) => {
                result.failed += 1;
                tracing::error!(kind = %token_type, %reason, "[PushNotify] Native push failed");
            }
        }
    }
    result
}

/// `workspaceInboxUnread(db, userId)`: the unread inbox count across the
/// mailboxes the member may open.
async fn inbox_unread(db: &PgPool, user_id: &str) -> Result<i64, sea_orm::DbErr> {
    let accounts = weldsuite_mail_domain::access::accessible_account_ids(db, user_id).await?;
    let stats = weldsuite_mail_domain::messages::message_stats(db, &accounts).await?;
    Ok(stats["inboxUnread"].as_i64().unwrap_or(0))
}

/// `sendNewEmailPushNotification(env, params)`. Failures are logged.
#[allow(clippy::too_many_lines)] // the worker's function, step by step
pub async fn send_new_email_push(
    ctx: &InboundContext,
    account: &RecipientAccount,
    user_id: &str,
    email: &ParsedEmail,
    stored: &Stored,
    preview: &str,
) {
    let result = async {
        let db = ctx.tenants.tenant_db(&account.workspace_id).await?;
        let conn = orm(&db);
        let rows: Vec<(String, String)> = device_tokens::Entity::find()
            .select_only()
            .columns([
                device_tokens::Column::Token,
                device_tokens::Column::TokenType,
            ])
            .filter(device_tokens::Column::UserId.eq(user_id))
            .filter(device_tokens::Column::AppCode.eq("weldmail"))
            .filter(device_tokens::Column::IsActive.is_null())
            .into_tuple()
            .all(&conn)
            .await?;
        let Routed {
            expo: tokens,
            native,
        } = route_tokens(rows);
        if tokens.is_empty() && native.is_empty() {
            return Ok::<(), Box<dyn std::error::Error + Send + Sync>>(());
        }
        let sender = email
            .from
            .name
            .as_deref()
            .filter(|n| !n.is_empty())
            .unwrap_or(&email.from.email)
            .to_owned();
        let title = format!("New email from {sender}");
        let body = [email.subject.as_str(), preview]
            .into_iter()
            .find(|t| !t.is_empty())
            .unwrap_or("New email received")
            .to_owned();
        let badge = match inbox_unread(&db, user_id).await {
            Ok(count) => Some(count),
            Err(error) => {
                tracing::error!(%error, "[PushNotify] Failed to count unread inbox messages");
                None
            }
        };
        let mut data = Map::new();
        data.insert("type".to_owned(), json!("new_email"));
        data.insert("emailId".to_owned(), json!(stored.message_id));
        data.insert("emailAccountId".to_owned(), json!(account.account_id));
        data.insert("tenantKind".to_owned(), json!("workspace"));
        if let Some(badge) = badge {
            data.insert("inboxUnread".to_owned(), json!(badge.to_string()));
        }
        if !account.clerk_org_id.is_empty() {
            data.insert("clerkOrgId".to_owned(), json!(account.clerk_org_id));
        }
        data.insert("fromName".to_owned(), json!(utf16_prefix(&sender, 80)));
        data.insert(
            "fromEmail".to_owned(),
            json!(utf16_prefix(&email.from.email, 120)),
        );
        data.insert(
            "subject".to_owned(),
            json!(utf16_prefix(&email.subject, 120)),
        );
        data.insert("preview".to_owned(), json!(utf16_prefix(preview, 160)));
        // The install the push comes from, which the app checks before
        // acting on a tap (none on Global).
        if let Some(server) = weldsuite_notifications::push_server() {
            data.insert("server".to_owned(), json!(server));
        }
        let messages: Vec<Value> = tokens
            .iter()
            .map(|token| {
                let mut message = Map::new();
                message.insert("to".to_owned(), json!(token));
                message.insert("title".to_owned(), json!(title));
                message.insert("body".to_owned(), json!(body));
                message.insert("sound".to_owned(), json!("default"));
                message.insert("priority".to_owned(), json!("high"));
                message.insert("channelId".to_owned(), json!("email"));
                if let Some(badge) = badge {
                    message.insert("badge".to_owned(), json!(badge));
                }
                message.insert("data".to_owned(), Value::Object(data.clone()));
                Value::Object(message)
            })
            .collect();
        let (tickets, mut invalid) = send_expo_push(ctx.http.as_ref(), &messages).await;
        let alert = native_alert(&title, &body, &data);
        let native_sent = send_native_pushes(ctx.http.as_ref(), &native, &alert).await;
        let ok = tickets.iter().filter(|t| t["status"] == "ok").count() + native_sent.sent;
        tracing::info!(
            user_id,
            ok,
            failed = tickets.len() + native_sent.sent + native_sent.failed - ok,
            "[PushNotify] Sent"
        );
        for token in native_sent.invalid {
            if !invalid.contains(&token) {
                invalid.push(token);
            }
        }
        if !invalid.is_empty() {
            let now = crate::store::timestamp(weldsuite_mail_domain::outbound::clock::now_ms());
            for token in invalid {
                if let Err(error) = device_tokens::Entity::update_many()
                    .col_expr(device_tokens::Column::IsActive, Expr::value(now))
                    .filter(device_tokens::Column::Token.eq(&token))
                    .exec(&conn)
                    .await
                {
                    tracing::error!(%error, "[PushNotify] Failed to deactivate token");
                }
            }
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        tracing::error!(%error, user_id, "[PushNotify] Failed to send push");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex, PoisonError};

    use weldsuite_ports::{BoxFuture, DynOutboundHttp, HttpResponse, PortError};

    use super::*;

    fn rows(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(token, kind)| ((*token).to_owned(), (*kind).to_owned()))
            .collect()
    }

    #[test]
    fn tokens_route_like_the_notifications_push() {
        let apns = "ab".repeat(32);
        let routed = route_tokens(rows(&[
            ("ExponentPushToken[phone]", "expo"),
            (&apns, "apns"),
            ("fcm-token", "fcm"),
            ("voip-token", "voip"),
            ("ExponentPushToken[call]", "expo_call"),
            ("fcm-call-token", "fcm_call"),
            ("legacy-token", "legacy"),
            ("", "fcm"),
        ]));
        assert_eq!(
            routed,
            Routed {
                // Unknown types go to Expo, as every token did before.
                expo: vec![
                    "ExponentPushToken[phone]".to_owned(),
                    "legacy-token".to_owned()
                ],
                native: vec![
                    (apns.clone(), "apns".to_owned()),
                    ("fcm-token".to_owned(), "fcm".to_owned()),
                ],
            }
        );
        assert_eq!(route_tokens(Vec::new()), Routed::default());
    }

    #[test]
    fn the_native_alert_is_the_expo_message_in_the_mail_thread() {
        let mut data = Map::new();
        data.insert("type".to_owned(), json!("new_email"));
        data.insert("inboxUnread".to_owned(), json!("4"));
        let alert = native_alert("New email from Ann", "Lunch?", &data);
        assert_eq!(alert.title, "New email from Ann");
        assert_eq!(alert.body, "Lunch?");
        assert_eq!(alert.thread_id, "weldmail");
        assert!(alert.high_priority);
        assert_eq!(alert.android_channel, Some("email"));
        assert_eq!(alert.data, &data);
    }

    /// Counts the requests; every one answers 200.
    struct Counter(Mutex<usize>);

    impl DynOutboundHttp for Counter {
        fn send(&self, _request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            *self.0.lock().unwrap_or_else(PoisonError::into_inner) += 1;
            Box::pin(std::future::ready(Ok(HttpResponse::new(
                200,
                b"{}".to_vec(),
            ))))
        }
    }

    #[tokio::test]
    async fn a_native_sender_without_its_key_never_deactivates() {
        // No `set_native_push` in tests: neither APNs nor FCM has a key.
        let counter = Arc::new(Counter(Mutex::new(0)));
        let http = OutboundHttp(counter.clone());
        let data = Map::new();
        let alert = native_alert("New email from Ann", "Lunch?", &data);
        let native = vec![
            ("ab".repeat(32), "apns".to_owned()),
            ("fcm-token".to_owned(), "fcm".to_owned()),
        ];
        let sent = send_native_pushes(Some(&http), &native, &alert).await;
        assert_eq!(
            sent,
            NativeSent {
                sent: 0,
                failed: 2,
                invalid: Vec::new(),
            }
        );
        assert_eq!(*counter.0.lock().unwrap_or_else(PoisonError::into_inner), 0);
    }
}
