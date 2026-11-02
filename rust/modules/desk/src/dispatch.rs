//! `services/helpdesk/channel-dispatch.ts`: send an agent's reply out on
//! the conversation's channel (Discord, email, Slack; chat needs nothing),
//! in the background. Every failure is logged and the reply stands.
//!
//! Email goes through the outbound guard (`weldsuite_mail_domain::outbound`,
//! `guardedSend`); a refused send is logged and the agent is not told
//! (MAIL-006), as in TypeScript.

use std::sync::Arc;

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_desk_domain::http::{DeskHttp, HttpRequest};
use weldsuite_mail_domain::outbound::{
    CheckOutboundInput, GuardedSendError, OutboundGuard, OutboundKind, SendEmailParams,
    SubjectInput, TransmitError, guarded_send, send_email,
};
use weldsuite_ports::MailTransport;

use crate::js::text;
use crate::{Caller, DeskState};

/// `DispatchMessage`.
pub(crate) struct Outgoing {
    pub(crate) id: String,
    pub(crate) content: String,
    pub(crate) content_html: Option<String>,
    pub(crate) author_name: Option<String>,
    pub(crate) internal: bool,
}

/// What the email path sends through: the guard and the transport.
pub(crate) struct Outbound {
    pub(crate) guard: OutboundGuard,
    pub(crate) transport: Option<Arc<dyn MailTransport>>,
}

/// `dispatchOutbound(env, db, conversation, message, outbound)`, in the
/// background (`waitUntil`).
pub(crate) fn dispatch_outbound(
    state: &DeskState,
    caller: &Caller,
    conversation: &Value,
    message: Outgoing,
) {
    if message.internal {
        return;
    }
    let channel = text(conversation, "channel")
        .filter(|c| !c.is_empty())
        .unwrap_or("chat")
        .to_owned();
    let conversation = conversation.clone();
    let id = conversation["id"].as_str().unwrap_or_default().to_owned();
    match channel.as_str() {
        "chat" => {}
        "discord" => {
            let token = caller.env("DISCORD_BOT_TOKEN").filter(|t| !t.is_empty());
            let target = text(&conversation["metadata"], "discordChannelId")
                .filter(|t| !t.is_empty())
                .map(str::to_owned);
            let (Some(token), Some(target)) = (token, target) else {
                tracing::warn!(
                    "[ChannelDispatch:Discord] Missing channelId or bot token for conversation {id}"
                );
                return;
            };
            let http = caller.http(state);
            state.events.tracker().spawn(async move {
                let sent =
                    crate::discord::send_message(http.as_ref(), &token, &target, &message.content)
                        .await;
                if let Err(error) = sent {
                    tracing::error!(%error, "[ChannelDispatch:Discord] Failed to send message");
                }
            });
        }
        "email" => {
            let db = caller.db.clone();
            let outbound = caller.outbound(state);
            let org = caller.clerk_org_id.clone();
            state.events.tracker().spawn(async move {
                dispatch_email(&db, outbound, &org, &conversation, &message).await;
            });
        }
        "slack" => {
            let db = caller.db.clone();
            let http = caller.http(state);
            state.events.tracker().spawn(async move {
                dispatch_slack(&db, http.as_ref(), &conversation, &message).await;
            });
        }
        other => {
            tracing::warn!("[ChannelDispatch] Unknown channel \"{other}\" for conversation {id}");
        }
    }
}

/// `dispatchEmail`: the reply as `Re: <subject>` from the helpdesk address,
/// threaded on the conversation's last email, then the ids stored back.
#[allow(clippy::too_many_lines)] // one long function in TypeScript too
async fn dispatch_email(
    db: &PgPool,
    outbound: Outbound,
    org: &str,
    conversation: &Value,
    message: &Outgoing,
) {
    let id = conversation["id"].as_str().unwrap_or_default();
    let metadata = &conversation["metadata"];
    let helpdesk_address = text(metadata, "helpdeskEmailAddress").filter(|a| !a.is_empty());
    let customer = text(conversation, "customerEmail").filter(|a| !a.is_empty());
    let (Some(helpdesk_address), Some(customer)) = (helpdesk_address, customer) else {
        tracing::warn!("[ChannelDispatch:Email] Missing email addresses for conversation {id}");
        return;
    };
    let agent = message
        .author_name
        .as_deref()
        .filter(|n| !n.is_empty())
        .unwrap_or("Support");
    let from = format!("\"{agent}\" <{helpdesk_address}>");
    let references: Vec<Value> = metadata["emailReferences"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut headers = Vec::new();
    if let Some(last_id) = text(metadata, "lastEmailMessageId").filter(|m| !m.is_empty()) {
        headers.push(("In-Reply-To".to_owned(), last_id.to_owned()));
    }
    if !references.is_empty() {
        let joined = references
            .iter()
            .map(|r| r.as_str().unwrap_or_default())
            .collect::<Vec<_>>()
            .join(" ");
        headers.push(("References".to_owned(), joined));
    }
    let subject_text = conversation["subject"].as_str().unwrap_or_default();
    let subject = if subject_text.starts_with("Re:") {
        subject_text.to_owned()
    } else {
        format!("Re: {subject_text}")
    };
    let mut input = CheckOutboundInput::new(
        SubjectInput::Workspace {
            clerk_org_id: org.to_owned(),
            workspace_id: None,
        },
        "desk",
        OutboundKind::Reply,
        &from,
        vec![customer.to_owned()],
    );
    input.subject_line = Some(subject.clone());
    input.text = Some(message.content.clone());
    input.html.clone_from(&message.content_html);
    let params = SendEmailParams {
        from: from.clone(),
        to: vec![customer.to_owned()],
        cc: Vec::new(),
        bcc: Vec::new(),
        subject: subject.clone(),
        text: Some(message.content.clone()),
        html: message.content_html.clone().filter(|h| !h.is_empty()),
        reply_to: None,
        headers,
        attachments: Vec::new(),
    };
    let transport = outbound.transport.clone();
    let sent = guarded_send(&outbound.guard, Some(db), &input, || async {
        match &transport {
            Some(transport) => send_email(transport.as_ref(), &params).await,
            None => Err(TransmitError::Config(
                "SEND_EMAIL binding missing".to_owned(),
            )),
        }
    })
    .await;
    let message_id = match sent {
        Ok(sent) => sent.message_id,
        Err(GuardedSendError::Denied(denied)) => {
            tracing::warn!(
                "[ChannelDispatch:Email] Reply for conversation {id} blocked by the outbound guard ({}): {}",
                denied.code().as_str(),
                denied.message()
            );
            return;
        }
        Err(GuardedSendError::Send(error)) => {
            tracing::error!(%error, "[ChannelDispatch:Email] Failed to send");
            return;
        }
    };
    let stored =
        sqlx::query("update helpdesk_conversation_messages set metadata = $2 where id = $1")
            .bind(&message.id)
            .bind(json!({
                "emailMessageId": message_id,
                "emailFrom": helpdesk_address,
                "emailTo": [customer],
                "emailSubject": subject,
            }))
            .execute(db)
            .await;
    if let Err(error) = stored {
        tracing::error!(%error, "[ChannelDispatch:Email] Failed to send");
        return;
    }
    // `[...emailReferences, sentMessageId].slice(-50)`.
    let mut updated = references;
    updated.push(json!(message_id));
    let keep = updated.len().saturating_sub(50);
    let updated: Vec<Value> = updated.into_iter().skip(keep).collect();
    let mut next = metadata.as_object().cloned().unwrap_or_default();
    next.insert("lastEmailMessageId".to_owned(), json!(message_id));
    next.insert("emailReferences".to_owned(), Value::Array(updated));
    let stored = sqlx::query("update helpdesk_conversations set metadata = $2 where id = $1")
        .bind(id)
        .bind(Value::Object(next))
        .execute(db)
        .await;
    if let Err(error) = stored {
        tracing::error!(%error, "[ChannelDispatch:Email] Failed to send");
    }
}

/// An integration's status and config.
type StatusAndConfig = (Option<String>, Option<Value>);

/// `dispatchSlack`: `chat.postMessage` with the connected integration's bot
/// token, in the conversation's thread.
async fn dispatch_slack(
    db: &PgPool,
    http: Option<&Arc<dyn DeskHttp>>,
    conversation: &Value,
    message: &Outgoing,
) {
    let id = conversation["id"].as_str().unwrap_or_default();
    let metadata = &conversation["metadata"];
    let Some(channel) = text(metadata, "slackChannelId").filter(|c| !c.is_empty()) else {
        tracing::warn!("[ChannelDispatch:Slack] Missing slackChannelId for conversation {id}");
        return;
    };
    let integration: Result<Option<StatusAndConfig>, sqlx::Error> = sqlx::query_as(
        "select status, config from helpdesk_channel_integrations
         where provider = 'slack' and deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await;
    let integration = match integration {
        Ok(row) => row,
        Err(error) => {
            tracing::error!(%error, "[app-api/conversations] channel dispatch failed");
            return;
        }
    };
    let Some((Some(status), config)) =
        integration.filter(|(s, _)| s.as_deref() == Some("connected"))
    else {
        tracing::warn!("[ChannelDispatch:Slack] No active Slack integration for conversation {id}");
        return;
    };
    debug_assert_eq!(status, "connected");
    let config = config.unwrap_or(Value::Null);
    let Some(token) = text(&config, "botToken").filter(|t| !t.is_empty()) else {
        tracing::warn!("[ChannelDispatch:Slack] No bot token in Slack integration config");
        return;
    };
    let mut body = Map::new();
    body.insert("channel".to_owned(), json!(channel));
    body.insert("text".to_owned(), json!(message.content));
    if let Some(thread) = text(metadata, "slackThreadTs").filter(|t| !t.is_empty()) {
        body.insert("thread_ts".to_owned(), json!(thread));
    }
    let Some(http) = http else {
        tracing::error!("[ChannelDispatch:Slack] Failed to send message: no HTTP client");
        return;
    };
    let response = http
        .send(HttpRequest {
            method: "POST",
            url: "https://slack.com/api/chat.postMessage".to_owned(),
            headers: vec![
                ("Authorization".to_owned(), format!("Bearer {token}")),
                ("Content-Type".to_owned(), "application/json".to_owned()),
            ],
            body: Some(Value::Object(body).to_string()),
        })
        .await;
    match response.map(|r| serde_json::from_str::<Value>(&r.body)) {
        Ok(Ok(result)) if result["ok"] == Value::Bool(true) => {}
        Ok(Ok(result)) => {
            tracing::error!("[ChannelDispatch:Slack] API error: {}", result["error"]);
        }
        Ok(Err(error)) => tracing::error!(%error, "[ChannelDispatch:Slack] Failed to send message"),
        Err(error) => tracing::error!(%error, "[ChannelDispatch:Slack] Failed to send message"),
    }
}
