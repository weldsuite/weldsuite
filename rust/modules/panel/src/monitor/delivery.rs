//! Delivery of alert and scheduled-report messages on the channels an alert
//! or subscription names (`services/delivery.ts`): email
//! (`weldsuite-emails`, `panel.alert` / `panel.report-digest`), in-app
//! (`weldsuite-notifications`, email excluded since email has its own
//! recipient list here), a Slack incoming webhook (Block Kit, over the
//! outbound HTTP port) and a WeldChat channel (a system message from
//! "WeldPanel", `weldsuite-chat-domain`).
//!
//! Every channel is tried on its own: one that fails never stops the others,
//! and its error is in the result (stored by the caller as `lastError`).
//! Messages are written per recipient locale (en, nl), shared channels
//! (Slack, WeldChat) in the workspace's language. The Slack webhook URL is
//! opened here, used once and never logged.

use std::sync::Arc;

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::CHAT_MESSAGE_CREATED;
use weldsuite_db::{Keyring, orm};
use weldsuite_emails::panel_monitor::{self, AlertProps, DigestProps};
use weldsuite_emails::{EmailBrand, EmailLocale, SystemEmail, send_system_email};
use weldsuite_events::{EntityEventPublisher, EventContext, EventSource, publish_entity_event};
use weldsuite_notifications::{NewNotification, Notifier, create_and_deliver};
use weldsuite_panel_domain::js;
use weldsuite_ports::{BoxFuture, DynRealtimePublisher, DynSystemMail, HttpRequest, OutboundHttp};
use weldsuite_schema::tenant::{
    chat_channels, user_preferences, workspace_members, workspace_settings,
};

use super::secrets;

/// WeldChat author of WeldPanel's posts (a system message, never a teammate).
pub(crate) const WELDPANEL_CHAT_AUTHOR: &str = "app:weldpanel";
pub(crate) const WELDPANEL_CHAT_AUTHOR_NAME: &str = "WeldPanel";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/// A scheduled report in one locale, its links still paths: each block's
/// `url` holds its report's path, the props' `url` is unused.
pub(crate) type DigestDraft = DigestProps;

/// `PanelMessage`.
pub(crate) enum Message {
    Alert {
        /// The alert's id.
        entity_id: String,
        /// Platform path of the alert, without the workspace prefix.
        path: String,
        /// The email's props, `url` filled in on sending.
        alert: AlertProps,
    },
    Report {
        /// The subscription's id.
        entity_id: String,
        path: String,
        /// The digest in a locale: numbers computed once, labels per reader.
        digest: Box<dyn Fn(EmailLocale) -> DigestDraft + Send + Sync>,
    },
}

impl Message {
    pub(crate) fn entity_id(&self) -> &str {
        match self {
            Self::Alert { entity_id, .. } | Self::Report { entity_id, .. } => entity_id,
        }
    }

    pub(crate) fn path(&self) -> &str {
        match self {
            Self::Alert { path, .. } | Self::Report { path, .. } => path,
        }
    }

    fn is_alert(&self) -> bool {
        matches!(self, Self::Alert { .. })
    }
}

/// Where a message goes (`DeliveryTarget`): the object's channels (the
/// stored JSON), its sealed Slack webhook and its owner.
#[derive(Debug, Clone)]
pub(crate) struct Target {
    pub(crate) channels: Value,
    pub(crate) slack_ciphertext: Option<String>,
    pub(crate) owner_user_id: String,
}

impl Target {
    /// `deliveryTargetOf(row)` of an alert's or subscription's row.
    pub(crate) fn of(row: &Value) -> Self {
        Self {
            channels: row.get("channels").cloned().unwrap_or(Value::Null),
            slack_ciphertext: row
                .get("slackWebhookCiphertext")
                .and_then(Value::as_str)
                .map(str::to_owned),
            owner_user_id: row
                .get("ownerUserId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        }
    }
}

/// One channel's result (`PanelDeliveryResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Delivered {
    pub(crate) channel: &'static str,
    pub(crate) ok: bool,
    pub(crate) recipients: u64,
    pub(crate) error: Option<String>,
}

impl Delivered {
    pub(crate) fn to_json(&self) -> Value {
        json!({ "channel": self.channel, "ok": self.ok, "recipients": self.recipients, "error": self.error })
    }
}

/// `{ delivered }` (`PanelDeliveryReportDto`).
pub(crate) fn report_json(delivered: &[Delivered]) -> Value {
    json!({ "delivered": delivered.iter().map(Delivered::to_json).collect::<Vec<_>>() })
}

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

/// What a delivery runs with (`DeliveryContext`).
#[derive(Clone)]
pub(crate) struct Delivery {
    /// The workspace's tenant database.
    pub(crate) db: PgPool,
    /// The Clerk org id: in-app notifications, WeldChat and app links go there.
    pub(crate) clerk_org_id: String,
    /// Who the message is sent for (the owner, or the member who pressed "test").
    pub(crate) actor_user_id: String,
    /// `PLATFORM_URL`.
    pub(crate) platform_url: Option<String>,
    pub(crate) keyring: Keyring,
    /// System mail; `None` is a worker without a transport.
    pub(crate) mail: Option<Arc<dyn DynSystemMail>>,
    /// Slack's webhook (public addresses only).
    pub(crate) http: Option<OutboundHttp>,
    /// The push (Expo) of the WeldChat posts' mention notifications; `None`
    /// notifies in-app only. Conformance builds have none.
    pub(crate) push_http: Option<OutboundHttp>,
    pub(crate) realtime: Option<Arc<dyn DynRealtimePublisher>>,
    pub(crate) events: EntityEventPublisher,
    /// Tests: senders that record.
    pub(crate) senders: Option<Arc<dyn Senders>>,
}

/// `appBase(env)`.
pub(crate) fn app_base(platform_url: Option<&str>) -> String {
    let base = platform_url
        .filter(|url| !url.is_empty())
        .unwrap_or("https://app.weldsuite.org");
    base.strip_suffix('/').unwrap_or(base).to_owned()
}

/// `workspaceAppUrl(base, clerkOrgId, path)`.
pub(crate) fn workspace_app_url(base: &str, clerk_org_id: &str, path: &str) -> String {
    let mut base = base.trim();
    while let Some(rest) = base.strip_suffix('/') {
        base = rest;
    }
    let inner = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("/{path}")
    };
    if clerk_org_id.is_empty() {
        format!("{base}{inner}")
    } else {
        format!(
            "{base}/w/{}{inner}",
            weldsuite_kit::cursor::encode_uri_component(clerk_org_id)
        )
    }
}

impl Delivery {
    /// `appUrl(ctx, path)`.
    pub(crate) fn app_url(&self, path: &str) -> String {
        workspace_app_url(
            &app_base(self.platform_url.as_deref()),
            &self.clerk_org_id,
            path,
        )
    }

    fn alert_props(&self, message: &Message) -> Option<AlertProps> {
        let Message::Alert { path, alert, .. } = message else {
            return None;
        };
        let mut props = alert.clone();
        props.url = self.app_url(path);
        Some(props)
    }

    fn digest_props(&self, message: &Message, locale: EmailLocale) -> Option<DigestProps> {
        let Message::Report { path, digest, .. } = message else {
            return None;
        };
        let mut props = digest(locale);
        for block in &mut props.blocks {
            block.url = block
                .url
                .take()
                .filter(|p| !p.is_empty())
                .map(|p| self.app_url(&p));
        }
        props.url = self.app_url(path);
        Some(props)
    }
}

/// Title, body and the lines below them, in a locale (`messageText`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Text {
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) lines: Vec<String>,
    pub(crate) url: String,
}

/// `messageText(ctx, message, locale)`.
pub(crate) fn message_text(ctx: &Delivery, message: &Message, locale: EmailLocale) -> Text {
    if let Some(props) = ctx.alert_props(message) {
        let text = panel_monitor::alert_text(&props, locale);
        return Text {
            title: text.title,
            body: text.body,
            lines: Vec::new(),
            url: props.url,
        };
    }
    let props = ctx
        .digest_props(message, locale)
        .expect("a message is an alert or a report");
    let text = panel_monitor::digest_text(&props, locale);
    Text {
        title: text.title,
        body: text.body,
        lines: text.lines,
        url: props.url,
    }
}

pub(crate) fn email_strings(locale: EmailLocale) -> Value {
    static STRINGS: std::sync::LazyLock<(Value, Value)> = std::sync::LazyLock::new(|| {
        let read = |json: &str| -> Value {
            let all: Value = serde_json::from_str(json).unwrap_or(Value::Null);
            all["panel"].clone()
        };
        (
            read(include_str!("../../../../catalogs/emails/strings.en.json")),
            read(include_str!("../../../../catalogs/emails/strings.nl.json")),
        )
    });
    match locale {
        EmailLocale::En => STRINGS.0.clone(),
        EmailLocale::Nl => STRINGS.1.clone(),
    }
}

/// `openLabel(message, locale)`.
fn open_label(message: &Message, locale: EmailLocale) -> String {
    let strings = email_strings(locale);
    let label = if message.is_alert() {
        &strings["alert"]["button"]
    } else {
        &strings["reportDigest"]["button"]
    };
    label.as_str().unwrap_or_default().to_owned()
}

/// `slackEscape(text)`: `&`, `<` and `>` are control characters.
pub(crate) fn slack_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn utf16_slice(text: &str, end: usize) -> String {
    js::slice_utf16(text, 0, end)
}

/// `slackPayload(ctx, message, locale)`: Block Kit for an incoming webhook.
pub(crate) fn slack_payload(ctx: &Delivery, message: &Message, locale: EmailLocale) -> Value {
    let text = message_text(ctx, message, locale);
    let mut blocks = vec![
        json!({ "type": "header", "text": { "type": "plain_text", "text": utf16_slice(&text.title, 150), "emoji": false } }),
        json!({ "type": "section", "text": { "type": "mrkdwn", "text": utf16_slice(&slack_escape(&text.body), 3000) } }),
    ];
    let mut chunk = String::new();
    for line in &text.lines {
        let escaped = slack_escape(line);
        let next = if chunk.is_empty() {
            escaped.clone()
        } else {
            format!("{chunk}\n{escaped}")
        };
        if js::utf16_len(&next) > 2900 {
            blocks.push(json!({ "type": "section", "text": { "type": "mrkdwn", "text": chunk } }));
            chunk = utf16_slice(&escaped, 2900);
        } else {
            chunk = next;
        }
    }
    if !chunk.is_empty() {
        blocks.push(json!({ "type": "section", "text": { "type": "mrkdwn", "text": chunk } }));
    }
    blocks.push(json!({ "type": "context", "elements": [{ "type": "mrkdwn", "text": format!("<{}|{}>", text.url, slack_escape(&open_label(message, locale))) }] }));
    blocks.truncate(50);
    json!({ "text": text.title, "blocks": blocks })
}

/// `weldchatContent(ctx, message, locale)`: never a mention (`<@…>`).
pub(crate) fn weldchat_content(ctx: &Delivery, message: &Message, locale: EmailLocale) -> String {
    let text = message_text(ctx, message, locale);
    let safe = |s: &str| s.replace("<@", "<\u{200B}@");
    let mut parts = vec![format!("**{}**", safe(&text.title)), safe(&text.body)];
    if !text.lines.is_empty() {
        parts.push(
            text.lines
                .iter()
                .map(|line| safe(line))
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }
    parts.push(format!("[{}]({})", open_label(message, locale), text.url));
    utf16_slice(&parts.join("\n\n"), 8000)
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/// A member a message goes to (`Recipient`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Recipient {
    pub(crate) user_id: String,
    pub(crate) email: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) locale: EmailLocale,
}

async fn workspace_language(db: &PgPool) -> Result<Option<String>, DbErr> {
    let row: Option<Option<String>> = workspace_settings::Entity::find()
        .select_only()
        .column(workspace_settings::Column::Language)
        .filter(workspace_settings::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.flatten())
}

/// `workspaceLocale(db)`: the workspace's language, for Slack and WeldChat.
pub(crate) async fn workspace_locale(db: &PgPool) -> EmailLocale {
    let language = workspace_language(db).await.ok().flatten();
    EmailLocale::resolve([language.as_deref()])
}

/// `memberRecipients(db, userIds)`: active members among `user_ids`, with
/// their address and locale; unknown or removed ids drop out.
pub(crate) async fn member_recipients(
    db: &PgPool,
    user_ids: &[String],
) -> Result<Vec<Recipient>, DbErr> {
    let ids = js::distinct(user_ids.iter().cloned());
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let orm_db = orm(db);
    let members: Vec<(String, Option<String>, Option<String>)> = workspace_members::Entity::find()
        .select_only()
        .columns([
            workspace_members::Column::UserId,
            workspace_members::Column::Email,
            workspace_members::Column::Name,
        ])
        .filter(workspace_members::Column::UserId.is_in(ids.iter().map(String::as_str)))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .filter(workspace_members::Column::Status.eq("ACTIVE"))
        .into_tuple()
        .all(&orm_db)
        .await?;
    let prefs: Vec<(String, String)> = user_preferences::Entity::find()
        .select_only()
        .columns([
            user_preferences::Column::UserId,
            user_preferences::Column::Language,
        ])
        .filter(user_preferences::Column::UserId.is_in(ids.iter().map(String::as_str)))
        .into_tuple()
        .all(&orm_db)
        .await?;
    let workspace = workspace_language(db).await?;
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for (user_id, email, name) in members {
        if seen.contains(&user_id) {
            continue;
        }
        seen.push(user_id.clone());
        // `new Map(prefs)`: the last row of a user wins.
        let preference = prefs
            .iter()
            .rev()
            .find(|(id, _)| *id == user_id)
            .map(|(_, language)| language.clone());
        out.push(Recipient {
            locale: EmailLocale::resolve([preference.as_deref(), workspace.as_deref()]),
            user_id,
            email,
            name,
        });
    }
    Ok(out)
}

/// `unknownMembers(db, userIds)`: ids that are not active members.
pub(crate) async fn unknown_members(
    db: &PgPool,
    user_ids: &[String],
) -> Result<Vec<String>, DbErr> {
    if user_ids.is_empty() {
        return Ok(Vec::new());
    }
    let known: Vec<String> = member_recipients(db, user_ids)
        .await?
        .into_iter()
        .map(|r| r.user_id)
        .collect();
    Ok(js::distinct(user_ids.iter().cloned())
        .into_iter()
        .filter(|id| !known.contains(id))
        .collect())
}

/// `chatChannelExists(db, channelId)`: a channel that exists and is not archived.
pub(crate) async fn chat_channel_exists(db: &PgPool, channel_id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = chat_channels::Entity::find_by_id(channel_id)
        .select_only()
        .column(chat_channels::Column::Id)
        .filter(chat_channels::Column::DeletedAt.is_null())
        .filter(chat_channels::Column::IsArchived.eq(false))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

/// What one channel did with its recipients (`SendOutcome`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct SendOutcome {
    pub(crate) sent: u64,
    pub(crate) failed: u64,
    pub(crate) error: Option<String>,
}

/// `errorText(err)`: the first 300 characters.
fn error_text(error: &str) -> String {
    utf16_slice(error, 300)
}

/// `severityOf(message)`.
fn severity(message: &Message) -> &'static str {
    match message {
        Message::Alert { alert, .. } => match alert.event {
            panel_monitor::AlertEvent::Fired => "warning",
            panel_monitor::AlertEvent::Resolved => "success",
            panel_monitor::AlertEvent::Test => "info",
        },
        Message::Report { .. } => "info",
    }
}

/// The four senders (`DeliverySenders`); tests override some.
pub(crate) trait Senders: Send + Sync {
    fn email<'a>(
        &'a self,
        ctx: &'a Delivery,
        recipients: &'a [Recipient],
        message: &'a Message,
    ) -> BoxFuture<'a, SendOutcome> {
        Box::pin(send_email(ctx, recipients, message))
    }

    fn in_app<'a>(
        &'a self,
        ctx: &'a Delivery,
        recipients: &'a [Recipient],
        message: &'a Message,
    ) -> BoxFuture<'a, SendOutcome> {
        Box::pin(send_in_app(ctx, recipients, message))
    }

    fn slack<'a>(
        &'a self,
        ctx: &'a Delivery,
        webhook_url: &'a str,
        message: &'a Message,
        locale: EmailLocale,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(send_slack(ctx, webhook_url, message, locale))
    }

    fn weldchat<'a>(
        &'a self,
        ctx: &'a Delivery,
        channel_id: &'a str,
        message: &'a Message,
        locale: EmailLocale,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(send_weldchat(ctx, channel_id, message, locale))
    }
}

/// The senders that send.
pub(crate) struct RealSenders;

impl Senders for RealSenders {}

async fn send_email(ctx: &Delivery, recipients: &[Recipient], message: &Message) -> SendOutcome {
    let Some(transport) = ctx.mail.clone() else {
        return SendOutcome {
            sent: 0,
            failed: recipients.len() as u64,
            error: Some("Email is not configured here".to_owned()),
        };
    };
    let brand = EmailBrand::weldsuite("WeldPanel");
    let mut outcome = SendOutcome::default();
    let mut last_error: Option<String> = None;
    for recipient in recipients {
        let Some(email) = recipient.email.as_deref().filter(|e| !e.is_empty()) else {
            outcome.failed += 1;
            continue;
        };
        let rendered = if let Some(props) = ctx.alert_props(message) {
            panel_monitor::alert(recipient.locale, &brand, &props)
        } else {
            let props = ctx
                .digest_props(message, recipient.locale)
                .expect("a message is an alert or a report");
            panel_monitor::report_digest(recipient.locale, &brand, &props)
        };
        let sent = match rendered {
            Ok(rendered) => send_system_email(
                transport.as_ref(),
                SystemEmail::to(rendered, brand.clone(), email),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        match sent {
            Ok(()) => outcome.sent += 1,
            Err(error) => {
                outcome.failed += 1;
                last_error = Some(error_text(&error));
            }
        }
    }
    if outcome.failed > 0 {
        outcome.error =
            Some(last_error.unwrap_or_else(|| "Some members have no email address".to_owned()));
    }
    outcome
}

async fn send_in_app(ctx: &Delivery, recipients: &[Recipient], message: &Message) -> SendOutcome {
    let notifier = Notifier {
        realtime: ctx.realtime.clone(),
        ..Notifier::default()
    };
    let alert = message.is_alert();
    let mut outcome = SendOutcome::default();
    for recipient in recipients {
        let text = message_text(ctx, message, recipient.locale);
        let notification = NewNotification {
            workspace_id: ctx.clerk_org_id.clone(),
            clerk_org_id: Some(ctx.clerk_org_id.clone()),
            user_id: recipient.user_id.clone(),
            title: utf16_slice(&text.title, 255),
            body: utf16_slice(&text.body, 1000),
            category: "weldpanel".to_owned(),
            notification_type: if alert { "panel_alert" } else { "panel_report" }.to_owned(),
            entity_type: if alert {
                "panel_alert"
            } else {
                "panel_subscription"
            }
            .to_owned(),
            entity_id: message.entity_id().to_owned(),
            action_url: message.path().to_owned(),
            severity: severity(message).to_owned(),
            actor_type: Some("system".to_owned()),
            actor_id: None,
            // This channel list has its own email recipients.
            exclude_email: true,
            ..NewNotification::default()
        };
        match create_and_deliver(&ctx.db, &notifier, &notification).await {
            Ok(_) => outcome.sent += 1,
            Err(error) => {
                outcome.failed += 1;
                outcome.error = Some(error_text(&error.to_string()));
            }
        }
    }
    outcome
}

async fn send_slack(
    ctx: &Delivery,
    webhook_url: &str,
    message: &Message,
    locale: EmailLocale,
) -> Result<(), String> {
    let http = ctx.http.clone().ok_or_else(|| "fetch failed".to_owned())?;
    let request = HttpRequest::json("POST", webhook_url, &slack_payload(ctx, message, locale));
    // Never the URL in an error: a connection failure says only that.
    let response = http
        .send(request)
        .await
        .map_err(|_| "fetch failed".to_owned())?;
    if response.ok() {
        return Ok(());
    }
    // Slack answers a short code; never echo the URL.
    let answer: String = response
        .text()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | '.' | '-'))
        .collect();
    let answer = utf16_slice(&answer, 100);
    Err(if answer.is_empty() {
        format!("Slack answered {}", response.status)
    } else {
        format!("Slack answered {}: {answer}", response.status)
    })
}

async fn send_weldchat(
    ctx: &Delivery,
    channel_id: &str,
    message: &Message,
    locale: EmailLocale,
) -> Result<(), String> {
    if !chat_channel_exists(&ctx.db, channel_id)
        .await
        .map_err(|error| error.to_string())?
    {
        return Err("The WeldChat channel no longer exists".to_owned());
    }
    let content = weldchat_content(ctx, message, locale);
    let kind = if message.is_alert() {
        "alert"
    } else {
        "report"
    };
    let posted = weldsuite_chat_domain::system_message::post_system_chat_message(
        &weldsuite_chat_domain::system_message::SystemMessageContext {
            db: &ctx.db,
            realtime: ctx.realtime.clone(),
            org_id: &ctx.clerk_org_id,
            channel_id,
            author_id: WELDPANEL_CHAT_AUTHOR,
            author_name: WELDPANEL_CHAT_AUTHOR_NAME,
            invoker_user_id: &ctx.actor_user_id,
            push_http: ctx.push_http.clone(),
        },
        &weldsuite_chat_domain::system_message::SystemMessageInput {
            content: &content,
            mentions: &[],
            metadata: Some(json!({ "weldpanel": { "kind": kind, "id": message.entity_id() } })),
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    let id = posted
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    publish_entity_event(
        &ctx.events,
        &EventContext::new(
            ctx.clerk_org_id.clone(),
            ctx.actor_user_id.clone(),
            EventSource::System,
        ),
        CHAT_MESSAGE_CREATED,
        &id,
        &json!({ "id": id, "channelId": channel_id, "authorId": WELDPANEL_CHAT_AUTHOR, "authorType": "system" }),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

fn result_of(channel: &'static str, outcome: Result<SendOutcome, String>) -> Delivered {
    match outcome {
        Ok(outcome) => Delivered {
            channel,
            ok: outcome.failed == 0,
            recipients: outcome.sent,
            error: if outcome.failed == 0 {
                None
            } else {
                outcome.error
            },
        },
        Err(error) => Delivered {
            channel,
            ok: false,
            recipients: 0,
            error: Some(error_text(&error)),
        },
    }
}

fn posted(outcome: Result<(), String>) -> Result<SendOutcome, String> {
    outcome.map(|()| SendOutcome {
        sent: 1,
        failed: 0,
        error: None,
    })
}

fn ids(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// `deliver(ctx, target, message)`: one result per channel tried. Never fails.
pub(crate) async fn deliver(ctx: &Delivery, target: &Target, message: &Message) -> Vec<Delivered> {
    let real = RealSenders;
    let senders: &dyn Senders = match &ctx.senders {
        Some(senders) => senders.as_ref(),
        None => &real,
    };
    let channels = &target.channels;
    let email_ids = ids(channels.get("emailUserIds"));
    let mut results = Vec::new();
    let mut shared: Option<EmailLocale> = None;

    if !email_ids.is_empty() {
        let outcome = match member_recipients(&ctx.db, &email_ids).await {
            Ok(recipients) => Ok(senders.email(ctx, &recipients, message).await),
            Err(error) => Err(error.to_string()),
        };
        results.push(result_of("email", outcome));
    }
    if channels.get("inApp").and_then(Value::as_bool) == Some(true) {
        let mut all = email_ids.clone();
        all.push(target.owner_user_id.clone());
        let outcome = match member_recipients(&ctx.db, &all).await {
            Ok(recipients) => Ok(senders.in_app(ctx, &recipients, message).await),
            Err(error) => Err(error.to_string()),
        };
        results.push(result_of("in_app", outcome));
    }
    if channels.get("slack").and_then(Value::as_bool) == Some(true)
        && let Some(ciphertext) = &target.slack_ciphertext
    {
        let outcome = match secrets::open(&ctx.keyring, ciphertext) {
            Ok(url) => {
                let locale = match shared {
                    Some(locale) => locale,
                    None => *shared.insert(workspace_locale(&ctx.db).await),
                };
                senders.slack(ctx, &url, message, locale).await
            }
            Err(error) => Err(error.to_string()),
        };
        results.push(result_of("slack", posted(outcome)));
    }
    if let Some(channel_id) = channels
        .get("weldchatChannelId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        let locale = match shared {
            Some(locale) => locale,
            None => *shared.insert(workspace_locale(&ctx.db).await),
        };
        let outcome = senders.weldchat(ctx, channel_id, message, locale).await;
        results.push(result_of("weldchat", posted(outcome)));
    }
    results
}

/// `deliveryError(results)`: one line for `lastError`, or `None`.
pub(crate) fn delivery_error(results: &[Delivered]) -> Option<String> {
    let failed: Vec<String> = results
        .iter()
        .filter(|r| !r.ok)
        .map(|r| format!("{}: {}", r.channel, r.error.as_deref().unwrap_or("failed")))
        .collect();
    (!failed.is_empty()).then(|| utf16_slice(&failed.join("; "), 1000))
}

// ---------------------------------------------------------------------------
// Storing channels
// ---------------------------------------------------------------------------

/// Channels as stored (`StoredChannels`): the JSON, and the sealed Slack URL.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Stored {
    pub(crate) channels: Value,
    pub(crate) slack_ciphertext: Option<String>,
}

impl Stored {
    /// `storedChannelsOf(row)`.
    pub(crate) fn of(row: &Value) -> Self {
        let target = Target::of(row);
        Self {
            channels: target.channels,
            slack_ciphertext: target.slack_ciphertext,
        }
    }
}

/// `storeChannels(env, input, existing)`: `slackWebhookUrl` absent keeps the
/// stored one, `null` removes it, a URL replaces it (sealed).
pub(crate) fn store_channels(
    keyring: &Keyring,
    input: &Value,
    existing: Option<&Stored>,
) -> Result<Stored, secrets::SecretError> {
    let mut ciphertext = existing.and_then(|e| e.slack_ciphertext.clone());
    match input.get("slackWebhookUrl") {
        Some(Value::Null) => ciphertext = None,
        Some(Value::String(url)) => ciphertext = Some(secrets::seal(keyring, url)?),
        _ => {}
    }
    let weldchat = match input.get("weldchatChannelId") {
        None => existing
            .and_then(|e| e.channels.get("weldchatChannelId").cloned())
            .unwrap_or(Value::Null),
        Some(value) => value.clone(),
    };
    Ok(Stored {
        channels: json!({
            "emailUserIds": input.get("emailUserIds").cloned().unwrap_or_else(|| json!([])),
            "inApp": input.get("inApp").cloned().unwrap_or(Value::Bool(false)),
            "slack": ciphertext.is_some(),
            "weldchatChannelId": weldchat,
        }),
        slack_ciphertext: ciphertext,
    })
}

/// `channelsProblem(db, input)`: why `input` cannot be saved, or `None`.
pub(crate) async fn channels_problem(
    db: &PgPool,
    input: &Value,
) -> Result<Option<&'static str>, DbErr> {
    let unknown = unknown_members(db, &ids(input.get("emailUserIds"))).await?;
    if !unknown.is_empty() {
        return Ok(Some(
            "Every email recipient must be a member of this workspace",
        ));
    }
    if let Some(channel) = input
        .get("weldchatChannelId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        && !chat_channel_exists(db, channel).await?
    {
        return Ok(Some("That WeldChat channel does not exist"));
    }
    Ok(None)
}

/// `toChannelsDto(stored)` of a row's channels and sealed URL.
pub(crate) fn channels_dto(channels: &Value, slack_ciphertext: Option<&str>) -> Value {
    json!({
        "emailUserIds": channels.get("emailUserIds").cloned().unwrap_or_else(|| json!([])),
        "inApp": channels.get("inApp").cloned().unwrap_or(Value::Bool(false)),
        "slack": slack_ciphertext.is_some(),
        "weldchatChannelId": channels.get("weldchatChannelId").cloned().unwrap_or(Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_emails::panel_monitor::{AlertCondition, AlertEvent, AlertInterval};

    fn context() -> Delivery {
        Delivery {
            db: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://localhost/none")
                .expect("lazy pool"),
            clerk_org_id: "org_a".to_owned(),
            actor_user_id: "user_alice".to_owned(),
            platform_url: Some("https://app.weldsuite.org".to_owned()),
            keyring: Keyring::default(),
            mail: None,
            http: None,
            push_http: None,
            realtime: None,
            events: EntityEventPublisher::new(None, weldsuite_events::TaskTracker::new()),
            senders: None,
        }
    }

    pub(crate) fn alert_message() -> Message {
        Message::Alert {
            entity_id: "pnal_1".to_owned(),
            path: "/weldpanel/alerts?alert=pnal_1".to_owned(),
            alert: AlertProps {
                alert_name: "Signups <@everyone>".to_owned(),
                project_name: "Shop".to_owned(),
                event: AlertEvent::Fired,
                metric: "Signups".to_owned(),
                value: Some(150.0),
                bound: Some(100.0),
                condition: AlertCondition::Threshold {
                    operator: "above".to_owned(),
                    value: 100.0,
                },
                interval: AlertInterval::Daily,
                period: Some("2026-11-17".to_owned()),
                url: String::new(),
            },
        }
    }

    // `delivery.test.ts`: storeChannels.
    #[test]
    fn seals_the_slack_url_keeps_it_unless_replaced_or_removed_and_never_shows_it() {
        let keyring = secrets::keyring(|name| {
            (name == "DATABASE_ENCRYPTION_KEY").then(|| format!("{}1", "0".repeat(63)))
        });
        let slack = "https://hooks.slack.com/services/T000/B000/secretsecret";
        let stored = store_channels(
            &keyring,
            &json!({ "emailUserIds": ["user_alice"], "inApp": true, "slackWebhookUrl": slack, "weldchatChannelId": null }),
            None,
        )
        .expect("stored");
        assert_eq!(
            stored.channels,
            json!({ "emailUserIds": ["user_alice"], "inApp": true, "slack": true, "weldchatChannelId": null })
        );
        let sealed = stored.slack_ciphertext.clone().expect("sealed");
        assert!(!sealed.contains("hooks.slack.com"));
        assert_eq!(secrets::open(&keyring, &sealed).as_deref(), Ok(slack));
        assert!(
            !channels_dto(&stored.channels, Some(&sealed))
                .to_string()
                .contains("slack.com")
        );
        let kept = store_channels(
            &keyring,
            &json!({ "emailUserIds": [], "inApp": false }),
            Some(&stored),
        )
        .expect("kept");
        assert_eq!(kept.slack_ciphertext, stored.slack_ciphertext);
        let removed = store_channels(
            &keyring,
            &json!({ "emailUserIds": [], "inApp": false, "slackWebhookUrl": null }),
            Some(&stored),
        )
        .expect("removed");
        assert_eq!(removed.slack_ciphertext, None);
        assert_eq!(removed.channels["slack"], json!(false));
    }

    #[test]
    fn delivery_errors_name_each_failed_channel() {
        let results = [
            Delivered {
                channel: "email",
                ok: true,
                recipients: 2,
                error: None,
            },
            Delivered {
                channel: "slack",
                ok: false,
                recipients: 0,
                error: Some("Slack answered 403: invalid_token".to_owned()),
            },
        ];
        assert_eq!(
            delivery_error(&results).as_deref(),
            Some("slack: Slack answered 403: invalid_token")
        );
        assert_eq!(delivery_error(&results[..1]), None);
    }

    // message formats.
    #[tokio::test]
    async fn slack_block_kit_with_escaped_text_and_a_link() {
        let ctx = context();
        let payload = slack_payload(&ctx, &alert_message(), EmailLocale::En);
        assert_eq!(payload["text"], json!("Signups <@everyone> is firing"));
        let section = payload["blocks"]
            .as_array()
            .and_then(|b| b.iter().find(|b| b["type"] == "section"))
            .expect("section");
        assert!(
            section["text"]["text"]
                .as_str()
                .unwrap_or_default()
                .contains("Signups was 150 for November 17, 2026: above 100.")
        );
        assert!(payload.to_string().contains(
            "<https://app.weldsuite.org/w/org_a/weldpanel/alerts?alert=pnal_1|Open alert>"
        ));
    }

    #[tokio::test]
    async fn weldchat_markdown_with_the_link_mentions_neutralised() {
        let ctx = context();
        let content = weldchat_content(&ctx, &alert_message(), EmailLocale::Nl);
        assert!(content.contains("**Signups <\u{200B}@everyone> gaat af**"));
        assert!(content.contains(
            "[Open melding](https://app.weldsuite.org/w/org_a/weldpanel/alerts?alert=pnal_1)"
        ));
    }

    #[tokio::test]
    async fn a_digest_is_written_per_locale_with_every_block() {
        let ctx = context();
        let digest = Message::Report {
            entity_id: "pnsb_1".to_owned(),
            path: "/weldpanel/dashboards/pnd_1".to_owned(),
            digest: Box::new(|locale| DigestProps {
                subscription_name: "Weekly".to_owned(),
                project_name: "Shop".to_owned(),
                target_type: "dashboard".to_owned(),
                target_name: "Growth".to_owned(),
                blocks: vec![weldsuite_emails::panel_monitor::DigestBlock {
                    title: if locale == EmailLocale::Nl {
                        "Bezoekers"
                    } else {
                        "Visitors"
                    }
                    .to_owned(),
                    headline: vec![weldsuite_emails::panel_monitor::DigestFigure {
                        label: "Visitors".to_owned(),
                        value: Some(120.0),
                        previous: Some(100.0),
                        format: weldsuite_emails::panel_monitor::NumberFormat::Number,
                    }],
                    url: Some("/weldpanel?report=pnr_1".to_owned()),
                    ..Default::default()
                }],
                more_count: None,
                url: String::new(),
            }),
        };
        let payload = slack_payload(&ctx, &digest, EmailLocale::En).to_string();
        assert!(payload.contains("Weekly: Growth"));
        assert!(payload.contains("Visitors: 120 (+20%)"));
        assert!(weldchat_content(&ctx, &digest, EmailLocale::Nl).contains("Bezoekers"));
    }
}
