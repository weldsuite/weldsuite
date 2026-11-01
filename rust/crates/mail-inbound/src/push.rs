//! `push-notifications.ts` and `expo-push.ts`: the WeldMail app's "new
//! email" push to a member's devices through the Expo Push API, with the
//! inbox badge, and invalid tokens switched off.

use std::time::Duration;

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_ports::{HttpRequest, OutboundHttp};

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

/// `workspaceInboxUnread(db, userId)`: the unread inbox count across the
/// mailboxes the member may open.
async fn inbox_unread(db: &PgPool, user_id: &str) -> Result<i64, sqlx::Error> {
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
        let tokens: Vec<String> = sqlx::query_scalar(
            "select token from device_tokens
             where user_id = $1 and app_code = 'weldmail' and is_active is null",
        )
        .bind(user_id)
        .fetch_all(&db)
        .await?;
        if tokens.is_empty() {
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
        let messages: Vec<Value> = tokens
            .iter()
            .map(|token| {
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
                message.insert("data".to_owned(), Value::Object(data));
                Value::Object(message)
            })
            .collect();
        let (tickets, invalid) = send_expo_push(ctx.http.as_ref(), &messages).await;
        let ok = tickets.iter().filter(|t| t["status"] == "ok").count();
        tracing::info!(
            user_id,
            ok,
            failed = tickets.len() - ok,
            "[PushNotify] Sent"
        );
        if !invalid.is_empty() {
            let now = weldsuite_mail_domain::outbound::clock::iso(
                weldsuite_mail_domain::outbound::clock::now_ms(),
            );
            for token in invalid {
                if let Err(error) = sqlx::query(
                    "update device_tokens set is_active = $2::timestamp where token = $1",
                )
                .bind(&token)
                .bind(&now)
                .execute(&db)
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
