//! Notifications (`@weldsuite/notifications`): a `notifications` row, then
//! delivery on every channel the recipient's preferences allow: in-app over
//! the realtime port (`notification.<userId>`), push through Expo (and the
//! native call ring for an incoming call: Apple's `VoIP` push, Expo data
//! messages). Each channel's failure is logged and never reaches the caller.
//!
//! Email follows the TypeScript gate: only for a recipient who is away
//! ([`resolve_email_presence`]: their chosen status, and their live
//! presence through the [`PresenceReader`] port), recorded on the row as
//! `delivered_email`. Sending it is not ported yet: the `notification` and
//! `task.assigned` templates are not exported to `weldsuite_emails`
//! (`pnpm rust:emails`), and the deferred-email job
//! (`DeferredNotificationEmailWorkflow`) is app-api's. Until then
//! [`create_and_deliver`] logs a warning where it would hand the mail over;
//! the WeldChat helpers exclude email anyway, as in TypeScript.

mod push;

use std::sync::Arc;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_events::iso_timestamp;
use weldsuite_ports::{
    DynRealtimePublisher, DynSystemMail, OutboundHttp, PresenceReader, RealtimeMessage,
    RealtimePublisher,
};

pub use push::{ApnsConfig, CallCancelReason, cancel_incoming_call_push};

/// Where notifications go out (`NotificationEnv`): the realtime port (in-app;
/// `REALTIME`), live presence for the email gate, system mail
/// (`SEND_EMAIL`), outbound HTTP (Expo, APNs) and the APNs key, each
/// optional as the bindings are in a worker.
#[derive(Clone, Default)]
pub struct Notifier {
    pub realtime: Option<Arc<dyn DynRealtimePublisher>>,
    /// Live presence (`RealtimePublisher#getPresence`); `None` reads as
    /// nobody connected, as a worker without `REALTIME`.
    pub presence: Option<PresenceReader>,
    /// System mail; `None` skips the send, as `workerTransport(env)` does.
    pub mail: Option<Arc<dyn DynSystemMail>>,
    pub http: Option<OutboundHttp>,
    pub apns: Option<ApnsConfig>,
}

impl std::fmt::Debug for Notifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Notifier")
            .field("realtime", &self.realtime.is_some())
            .field("presence", &self.presence.is_some())
            .field("mail", &self.mail.is_some())
            .field("http", &self.http.is_some())
            .field("apns", &self.apns.is_some())
            .finish()
    }
}

/// `CreateNotificationParams`.
#[derive(Debug, Clone, Default)]
pub struct NewNotification {
    /// The realtime hub to publish in (the workers pass the org id).
    pub workspace_id: String,
    /// `clerkOrgId`, when the caller passes one (push data, links).
    pub clerk_org_id: Option<String>,
    pub user_id: String,
    pub title: String,
    pub body: String,
    pub category: String,
    pub notification_type: String,
    pub entity_type: String,
    pub entity_id: String,
    pub action_url: String,
    pub severity: String,
    pub actor_type: Option<String>,
    pub actor_id: Option<String>,
    /// `excludeChannels: ['email']`.
    pub exclude_email: bool,
    pub exclude_push: bool,
    pub exclude_in_app: bool,
    /// Extra push data, string values, in order.
    pub data: Vec<(String, String)>,
    /// The email's template and props (`email`), when not the generic
    /// `notification` one built from title, body and link.
    pub email: Option<EmailOverride>,
}

/// `NotificationEmailOverride`: a `@weldsuite/emails` template and its props.
#[derive(Debug, Clone, PartialEq)]
pub struct EmailOverride {
    pub template: String,
    pub props: Value,
}

/// `EmailPresence`: whether to email someone about a notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailPresence {
    /// Connected and not away: what they would be mailed about is on screen.
    Present,
    /// Away or not connected: email them.
    Absent,
    /// Do not disturb: never email.
    Suppress,
}

/// `emailPresenceFor(chosen, live)`.
pub fn email_presence_for(chosen: &str, live: Option<&str>) -> EmailPresence {
    if chosen == "dnd" {
        return EmailPresence::Suppress;
    }
    if live.is_none() || live == Some("away") || chosen == "away" {
        return EmailPresence::Absent;
    }
    EmailPresence::Present
}

/// `chosenStatusFromStored(stored, expiresAt)`: the status the member chose,
/// `online` once it expired.
fn chosen_status(stored: Option<&str>, expired: bool) -> &'static str {
    if expired {
        return "online";
    }
    match stored {
        Some("busy") => "busy",
        Some("dnd") => "dnd",
        Some("away_manual") => "away",
        Some("invisible") => "offline",
        _ => "online",
    }
}

/// `resolveEmailPresence(db, userId, source)`: the member's chosen status
/// (`chat_user_status`), then their live presence in `workspace_id`'s hub.
/// A failed lookup reads as away.
pub async fn resolve_email_presence(
    db: &PgPool,
    user_id: &str,
    presence: Option<&PresenceReader>,
    workspace_id: &str,
) -> EmailPresence {
    let row: Result<Option<(String, bool)>, sqlx::Error> = sqlx::query_as(
        "select status, coalesce(status_expires_at <= now() at time zone 'utc', false)
         from chat_user_status where user_id = $1 limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await;
    let (stored, expired) = match row {
        Ok(Some((status, expired))) => (Some(status), expired),
        Ok(None) => (None, false),
        Err(error) => {
            tracing::error!(%error, "[Notifications] Presence lookup failed, treating as absent");
            return EmailPresence::Absent;
        }
    };
    let chosen = chosen_status(stored.as_deref(), expired);
    let Some(presence) = presence.filter(|_| chosen != "dnd") else {
        return email_presence_for(chosen, None);
    };
    match presence
        .0
        .presence(workspace_id, &[user_id.to_owned()])
        .await
    {
        Ok(users) => {
            let live = users
                .iter()
                .find(|(id, _)| id == user_id)
                .map(|(_, live)| live.as_str());
            email_presence_for(chosen, live)
        }
        Err(error) => {
            tracing::error!(%error, "[Notifications] Presence lookup failed, treating as absent");
            EmailPresence::Absent
        }
    }
}

/// `ChannelPreferences`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Channels {
    pub in_app: bool,
    pub email: bool,
    pub push: bool,
}

/// `getChannelPreferences(db, userId, category)`.
pub async fn channel_preferences(
    db: &PgPool,
    user_id: &str,
    category: &str,
) -> Result<Channels, sqlx::Error> {
    let row: Option<(bool, Option<Value>, bool, bool, bool)> = sqlx::query_as(
        "select do_not_disturb, module_preferences, default_in_app, default_email, default_push
         from notification_preferences where user_id = $1 limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let Some((dnd, modules, in_app, email, push)) = row else {
        return Ok(Channels {
            in_app: true,
            email: true,
            push: true,
        });
    };
    let off = Channels {
        in_app: false,
        email: false,
        push: false,
    };
    if dnd {
        return Ok(off);
    }
    if let Some(module) = modules
        .as_ref()
        .and_then(|m| m.get(category))
        .filter(|m| truthy(m))
    {
        if !truthy(&module["enabled"]) {
            return Ok(off);
        }
        return Ok(Channels {
            in_app: truthy(&module["inApp"]),
            email: truthy(&module["email"]),
            push: truthy(&module["push"]),
        });
    }
    Ok(Channels {
        in_app,
        email,
        push,
    })
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `notif_<base36 time><8 random base36>`: `generateNotificationId`.
fn notification_id() -> String {
    let millis = OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    let mut time = u128::try_from(millis).unwrap_or_default();
    let mut digits = Vec::new();
    while time > 0 {
        let digit = u32::try_from(time % 36).unwrap_or_default();
        digits.push(char::from_digit(digit, 36).unwrap_or('0'));
        time /= 36;
    }
    digits.reverse();
    let random = weldsuite_kit::random_string(8, "0123456789abcdefghijklmnopqrstuvwxyz");
    format!("notif_{}{random}", digits.into_iter().collect::<String>())
}

/// `createAndDeliverNotification`: the new notification's id, or `None`
/// when every channel is off.
pub async fn create_and_deliver(
    db: &PgPool,
    notifier: &Notifier,
    params: &NewNotification,
) -> Result<Option<String>, sqlx::Error> {
    let mut channels = channel_preferences(db, &params.user_id, &params.category).await?;
    if params.exclude_email {
        channels.email = false;
    }
    if params.exclude_push {
        channels.push = false;
    }
    if params.exclude_in_app {
        channels.in_app = false;
    }
    // Presence gate, email only, before the insert: `delivered_email` says
    // what happens.
    let email_presence = if channels.email {
        resolve_email_presence(
            db,
            &params.user_id,
            notifier.presence.as_ref(),
            &params.workspace_id,
        )
        .await
    } else {
        EmailPresence::Suppress
    };
    let will_email = channels.email && email_presence == EmailPresence::Absent;
    if !channels.in_app && !will_email && !channels.push {
        tracing::warn!(
            user = %params.user_id,
            category = %params.category,
            kind = %params.notification_type,
            "[Notifications] Skipped all channels (DND or prefs off)"
        );
        return Ok(None);
    }

    let id = notification_id();
    let now = iso_timestamp(OffsetDateTime::now_utc());
    sqlx::query(
        "insert into notifications
            (id, user_id, title, body, category, notification_type, entity_type, entity_id,
             action_url, severity, actor_type, actor_id, delivered_in_app, delivered_email,
             delivered_push, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz)",
    )
    .bind(&id)
    .bind(&params.user_id)
    .bind(&params.title)
    .bind(&params.body)
    .bind(&params.category)
    .bind(&params.notification_type)
    .bind(&params.entity_type)
    .bind(&params.entity_id)
    .bind(&params.action_url)
    .bind(&params.severity)
    .bind(&params.actor_type)
    .bind(&params.actor_id)
    .bind(channels.in_app)
    .bind(will_email)
    .bind(channels.push)
    .bind(&now)
    .execute(db)
    .await?;

    if channels.in_app {
        deliver_in_app(notifier, params, &id, &now).await;
    }
    if will_email && notifier.mail.is_some() {
        // `deliverEmail` (immediate, or deferred by EMAIL_DEFER_MINUTES):
        // not ported yet, see the crate docs.
        tracing::warn!(
            user = %params.user_id,
            category = %params.category,
            "[Notifications] notification email is not sent: its templates are not ported yet"
        );
    }
    if channels.push {
        push::deliver_push(db, notifier, params).await;
    }
    Ok(Some(id))
}

/// The in-app publish (`publishInAppNotification`).
async fn deliver_in_app(notifier: &Notifier, params: &NewNotification, id: &str, now: &str) {
    let Some(realtime) = &notifier.realtime else {
        return;
    };
    let notification = json!({
        "id": id,
        "title": params.title,
        "body": params.body,
        "category": params.category,
        "notificationType": params.notification_type,
        "actionUrl": params.action_url,
        "entityType": params.entity_type,
        "entityId": params.entity_id,
        "createdAt": now,
        "isRead": false,
        "severity": params.severity,
        "actorType": params.actor_type,
        "actorId": params.actor_id,
    });
    let message = RealtimeMessage::personal(
        &params.workspace_id,
        &format!("notification.{}", params.user_id),
        "created",
        notification,
        &params.user_id,
    );
    if let Err(error) = realtime.publish(&message).await {
        tracing::error!(%error, "[Notifications] In-app publish failed");
    }
}

/// `buildPushData`: string values only; `channelId` is renamed
/// `chatChannelId` (Android reads `channelId` as its notification channel).
pub(crate) fn push_data(params: &NewNotification) -> Map<String, Value> {
    let mut data = Map::new();
    data.insert(
        "actionUrl".to_owned(),
        Value::from(params.action_url.as_str()),
    );
    data.insert(
        "entityType".to_owned(),
        Value::from(params.entity_type.as_str()),
    );
    data.insert(
        "entityId".to_owned(),
        Value::from(params.entity_id.as_str()),
    );
    data.insert(
        "notificationType".to_owned(),
        Value::from(params.notification_type.as_str()),
    );
    if let Some(org) = params.clerk_org_id.as_deref().filter(|o| !o.is_empty()) {
        data.insert("clerkOrgId".to_owned(), Value::from(org));
    }
    for (key, value) in &params.data {
        if key == "channelId" {
            data.entry("chatChannelId".to_owned())
                .or_insert_with(|| Value::from(value.as_str()));
            continue;
        }
        data.insert(key.clone(), Value::from(value.as_str()));
    }
    data
}

/// The WeldChat helpers (`helpers/chat.ts`).
pub mod chat {
    use super::NewNotification;

    #[allow(clippy::too_many_arguments)]
    fn weldchat(
        workspace_id: &str,
        user_id: &str,
        title: String,
        body: String,
        kind: &str,
        entity: (&str, &str),
        action_url: String,
        actor_id: &str,
        data: Vec<(String, String)>,
    ) -> NewNotification {
        NewNotification {
            workspace_id: workspace_id.to_owned(),
            clerk_org_id: None,
            user_id: user_id.to_owned(),
            title,
            body,
            category: "weldchat".to_owned(),
            notification_type: kind.to_owned(),
            entity_type: entity.0.to_owned(),
            entity_id: entity.1.to_owned(),
            action_url,
            severity: "info".to_owned(),
            actor_type: Some("user".to_owned()),
            actor_id: Some(actor_id.to_owned()),
            exclude_email: true,
            exclude_push: false,
            exclude_in_app: false,
            data,
            email: None,
        }
    }

    fn channel_data(channel_id: &str) -> Vec<(String, String)> {
        vec![("chatChannelId".to_owned(), channel_id.to_owned())]
    }

    /// `sendChatMentionNotification`.
    pub fn mention(
        workspace_id: &str,
        mentioned_user_id: &str,
        author_user_id: &str,
        author_name: &str,
        channel_id: &str,
        message_id: &str,
        preview: &str,
    ) -> NewNotification {
        weldchat(
            workspace_id,
            mentioned_user_id,
            format!("{author_name} mentioned you"),
            preview.to_owned(),
            "chat_mention",
            ("chat_message", message_id),
            format!("/weldchat/{channel_id}?messageId={message_id}"),
            author_user_id,
            channel_data(channel_id),
        )
    }

    /// `sendChatThreadReplyNotification`.
    #[allow(clippy::too_many_arguments)]
    pub fn thread_reply(
        workspace_id: &str,
        recipient_user_id: &str,
        author_user_id: &str,
        author_name: &str,
        channel_id: &str,
        parent_message_id: &str,
        reply_message_id: &str,
        preview: &str,
    ) -> NewNotification {
        weldchat(
            workspace_id,
            recipient_user_id,
            format!("{author_name} replied to a thread"),
            preview.to_owned(),
            "chat_thread_reply",
            ("chat_message", reply_message_id),
            format!("/weldchat/{channel_id}?messageId={parent_message_id}"),
            author_user_id,
            channel_data(channel_id),
        )
    }

    /// `sendChatDmNotification`.
    pub fn dm(
        workspace_id: &str,
        recipient_user_id: &str,
        sender_user_id: &str,
        sender_name: &str,
        channel_id: &str,
        preview: &str,
    ) -> NewNotification {
        let body = if preview.is_empty() {
            "Sent you a direct message".to_owned()
        } else {
            preview.to_owned()
        };
        weldchat(
            workspace_id,
            recipient_user_id,
            format!("New message from {sender_name}"),
            body,
            "chat_dm",
            ("chat_channel", channel_id),
            format!("/weldchat/dm/{channel_id}"),
            sender_user_id,
            channel_data(channel_id),
        )
    }

    /// `sendMissedCallNotification`.
    #[allow(clippy::too_many_arguments)]
    pub fn missed_call(
        workspace_id: &str,
        recipient_user_id: &str,
        caller_user_id: &str,
        caller_name: &str,
        channel_id: &str,
        call_id: &str,
        call_type: &str,
    ) -> NewNotification {
        weldchat(
            workspace_id,
            recipient_user_id,
            format!("Missed {call_type} call from {caller_name}"),
            "Tap to call back".to_owned(),
            "chat_missed_call",
            ("chat_call", call_id),
            format!("/weldchat/dm/{channel_id}"),
            caller_user_id,
            channel_data(channel_id),
        )
    }

    /// `sendIncomingCallNotification`.
    #[allow(clippy::too_many_arguments)]
    pub fn incoming_call(
        workspace_id: &str,
        recipient_user_id: &str,
        caller_user_id: &str,
        caller_name: &str,
        caller_avatar: Option<&str>,
        channel_id: &str,
        call_id: &str,
        call_type: &str,
        decline_token: Option<&str>,
    ) -> NewNotification {
        let mut data = vec![
            ("chatChannelId".to_owned(), channel_id.to_owned()),
            ("callType".to_owned(), call_type.to_owned()),
            ("callerName".to_owned(), caller_name.to_owned()),
        ];
        if let Some(avatar) = caller_avatar.filter(|a| !a.is_empty()) {
            data.push(("callerAvatar".to_owned(), avatar.to_owned()));
        }
        if let Some(token) = decline_token.filter(|t| !t.is_empty()) {
            data.push(("declineToken".to_owned(), token.to_owned()));
        }
        weldchat(
            workspace_id,
            recipient_user_id,
            format!("Incoming {call_type} call from {caller_name}"),
            "Tap to answer".to_owned(),
            "chat_incoming_call",
            ("chat_call", call_id),
            format!("/weldchat/dm/{channel_id}"),
            caller_user_id,
            data,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_goes_to_the_away_and_never_to_dnd() {
        assert_eq!(email_presence_for("dnd", None), EmailPresence::Suppress);
        assert_eq!(email_presence_for("online", None), EmailPresence::Absent);
        assert_eq!(
            email_presence_for("online", Some("away")),
            EmailPresence::Absent
        );
        assert_eq!(
            email_presence_for("away", Some("online")),
            EmailPresence::Absent
        );
        assert_eq!(
            email_presence_for("busy", Some("busy")),
            EmailPresence::Present
        );
        assert_eq!(chosen_status(Some("away_manual"), false), "away");
        assert_eq!(chosen_status(Some("dnd"), true), "online");
    }

    #[test]
    fn push_data_renames_channel_id_and_keeps_strings() {
        let mut params = chat::dm("org_1", "u2", "u1", "Ann", "ch_1", "");
        params
            .data
            .push(("channelId".to_owned(), "ignored".to_owned()));
        params.clerk_org_id = Some("org_1".to_owned());
        let data = push_data(&params);
        assert_eq!(data["chatChannelId"], "ch_1");
        assert!(!data.contains_key("channelId"));
        assert_eq!(data["clerkOrgId"], "org_1");
        assert_eq!(data["notificationType"], "chat_dm");
        assert_eq!(params.body, "Sent you a direct message");
    }

    #[test]
    fn ids_look_like_generated_ids() {
        let id = notification_id();
        assert!(id.starts_with("notif_"));
        assert!(id.len() >= 6 + 12);
        assert!(
            id[6..]
                .chars()
                .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
        );
    }
}
