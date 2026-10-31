//! The specialised inboxes an inbound message also reaches, when the edition
//! serves their module (MAIL-010): WeldDesk email inboxes
//! (`processHelpdeskInboxEmail`, `desk-inbound.ts`) and WeldBooks
//! accounting inboxes (`processAccountingInboxEmail`). Best effort: a
//! failure is logged and never fails the delivery.

use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_desk_domain::email::{
    IngestEmail, find_by_rfc_message_ids, find_open_by_email, find_recent, ingest_desk_email,
    normalize_email_subject,
};
use weldsuite_desk_domain::notify::{
    EntityKind, PREVIEW_MAX, customer_reply, preview as helpdesk_preview,
};
use weldsuite_desk_domain::realtime::{conversation_publish, now_ms};
use weldsuite_events::{EntityEvent, EventContext, EventSource, EventType};
use weldsuite_notifications::{NewNotification, Notifier, create_and_deliver};
use weldsuite_ports::{PutOptions, RealtimeMessage};

use crate::context::InboundContext;
use crate::deliver::upsert_contacts;
use crate::parsed::{ParsedAttachment, ParsedEmail};
use crate::recipients::collect_recipient_emails;

/// Most files kept per email.
pub const MAX_DESK_ATTACHMENTS: usize = 20;
/// Total bytes kept per email.
pub const MAX_DESK_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
const NOTIFY_BATCH: usize = 10;
const MAX_RECIPIENTS: i64 = 200;

/// A helpdesk inbox the message is for.
#[derive(Debug, Clone, PartialEq, Eq)]
struct HelpdeskInbox {
    email: String,
    account_id: String,
    workspace_id: String,
    clerk_org_id: Option<String>,
}

/// The `cid:` targets the HTML embeds, lower-cased (`inlineContentIds`).
fn inline_content_ids(html: Option<&str>) -> Vec<String> {
    let Some(html) = html else {
        return Vec::new();
    };
    let lower = html.to_ascii_lowercase();
    let mut ids = Vec::new();
    let mut from = 0;
    while let Some(found) = lower[from..].find("cid:") {
        let start = from + found + 4;
        let end = html[start..]
            .find(|c: char| matches!(c, '"' | '\'' | '>' | ')') || c.is_whitespace())
            .map_or(html.len(), |e| start + e);
        if end > start {
            let raw = &html[start..end];
            let decoded = percent_decode_lossy(raw);
            ids.push(decoded.to_lowercase());
        }
        from = end.max(start);
    }
    ids
}

/// `decodeURIComponent`, keeping the input when it is malformed (the TS
/// would throw; a malformed id never matches a part anyway).
fn percent_decode_lossy(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = raw.get(i + 1..i + 3)
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| raw.to_owned())
}

/// `selectDeskAttachments(attachments, htmlBody)`: real files, not the
/// images the body embeds, within the count and size caps.
fn select_desk_attachments<'a>(
    attachments: &'a [ParsedAttachment],
    html: Option<&str>,
) -> Vec<&'a ParsedAttachment> {
    let embedded = inline_content_ids(html);
    let mut kept = Vec::new();
    let mut total = 0;
    for att in attachments {
        if kept.len() >= MAX_DESK_ATTACHMENTS {
            break;
        }
        if att.content.is_empty() {
            continue;
        }
        let cid = att.content_id.as_deref().map(|c| {
            let c = c.strip_prefix('<').unwrap_or(c);
            c.strip_suffix('>').unwrap_or(c).to_lowercase()
        });
        if cid.is_some_and(|c| !c.is_empty() && embedded.contains(&c)) {
            continue;
        }
        if total + att.content.len() > MAX_DESK_ATTACHMENT_BYTES {
            continue;
        }
        total += att.content.len();
        kept.push(att);
    }
    kept
}

/// `PASSIVE_TYPES`: served as-is; anything else is stored as a download.
const PASSIVE_TYPES: [&str; 12] = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    "text/plain",
    "text/csv",
    "application/zip",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

/// `storedFileMetadata(contentType, fileName)`.
fn stored_file_metadata(content_type: &str, file_name: &str) -> (String, String) {
    let kind =
        crate::mime::js_trim(content_type.split(';').next().unwrap_or_default()).to_lowercase();
    if PASSIVE_TYPES.contains(&kind.as_str()) {
        (kind, format!("inline; filename=\"{file_name}\""))
    } else {
        (
            "application/octet-stream".to_owned(),
            format!("attachment; filename=\"{file_name}\""),
        )
    }
}

/// `safeFileName(name)`.
fn safe_file_name(name: &str) -> String {
    let cleaned = crate::store::sanitize_file_name(name);
    let cleaned = cleaned.trim_start_matches('.');
    let units: Vec<u16> = cleaned.encode_utf16().collect();
    let tail = if units.len() > 120 {
        String::from_utf16_lossy(&units[units.len() - 120..])
    } else {
        cleaned.to_owned()
    };
    if tail.is_empty() {
        "attachment".to_owned()
    } else {
        tail
    }
}

/// `storeDeskAttachments(env, workspaceId, emailId, attachments, htmlBody)`.
async fn store_desk_attachments(
    ctx: &InboundContext,
    workspace_id: &str,
    email: &ParsedEmail,
    attachments: &[ParsedAttachment],
) -> Vec<Value> {
    let mut public_url = ctx.public_url.clone().unwrap_or_default();
    while public_url.ends_with('/') {
        public_url.pop();
    }
    let Some(storage) = ctx.storage.as_ref().filter(|_| !public_url.is_empty()) else {
        return Vec::new();
    };
    let mut stored = Vec::new();
    for (i, att) in select_desk_attachments(attachments, email.html_body.as_deref())
        .into_iter()
        .enumerate()
    {
        let file_name = safe_file_name(&att.file_name);
        let (content_type, disposition) = stored_file_metadata(&att.content_type, &file_name);
        let key = format!(
            "desk/{workspace_id}/inbound/{}/{}_{file_name}",
            email.email_id,
            i + 1
        );
        let options = PutOptions {
            content_type: Some(content_type.clone()),
            content_disposition: Some(disposition),
            ..PutOptions::default()
        };
        match storage.put_boxed(&key, att.content.clone(), &options).await {
            Ok(_) => stored.push(json!({
                "name": if att.file_name.is_empty() { "attachment" } else { att.file_name.as_str() },
                "url": format!("{public_url}/{key}"),
                "contentType": content_type,
                "filesize": att.content.len(),
            })),
            Err(error) => {
                tracing::error!(%error, file = %att.file_name, "[HelpdeskInbox] Failed to store attachment");
            }
        }
    }
    stored
}

/// `findPriorDeskState`: the conversation's state and waiting time before
/// this email, when there is one.
async fn find_prior_state(db: &PgPool, email: &ParsedEmail) -> Option<(String, bool)> {
    let from = email.from.email.to_lowercase();
    let normalized = normalize_email_subject(Some(&email.subject));
    let title = if normalized.is_empty() {
        email.subject.clone()
    } else {
        normalized
    };
    let lookup = async {
        let mut ids: Vec<Option<&str>> = vec![email.in_reply_to.as_deref()];
        ids.extend(email.references.iter().flatten().map(|r| Some(r.as_str())));
        if let Some(found) = find_by_rfc_message_ids(db, &ids).await? {
            return Ok::<_, sqlx::Error>(Some(found));
        }
        if let Some(found) = find_open_by_email(db, &from).await? {
            return Ok(Some(found));
        }
        find_recent(db, &from, &title).await
    };
    match lookup.await {
        Ok(found) => found.map(|c| {
            (
                c["state"].as_str().unwrap_or_default().to_owned(),
                !c["waitingSince"].is_null(),
            )
        }),
        Err(error) => {
            tracing::error!(%error, "[HelpdeskInbox] Prior conversation lookup failed");
            None
        }
    }
}

/// `planDeskNotification`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Plan {
    Notify,
    AssigneeReply,
    None,
}

fn plan(created: bool, assignee: Option<&str>, prior: Option<&(String, bool)>) -> Plan {
    if created {
        return Plan::Notify;
    }
    if assignee.is_some_and(|a| !a.is_empty()) {
        return Plan::AssigneeReply;
    }
    let waiting = prior.is_some_and(|(state, waiting)| state == "open" && *waiting);
    if waiting { Plan::None } else { Plan::Notify }
}

/// `deskNotificationContent`.
fn notification_content(
    is_new: bool,
    customer_name: &str,
    body: Option<&str>,
    subject: Option<&str>,
    files: &[String],
) -> (String, String) {
    let who = crate::mime::js_trim(customer_name);
    let who = if who.is_empty() { "A customer" } else { who };
    let files: Vec<&str> = files
        .iter()
        .map(String::as_str)
        .filter(|f| !f.is_empty())
        .collect();
    let body = [
        helpdesk_preview(body, PREVIEW_MAX),
        helpdesk_preview(subject, PREVIEW_MAX),
    ]
    .into_iter()
    .find(|p| !p.is_empty())
    .unwrap_or_else(|| {
        if files.is_empty() {
            "New email".to_owned()
        } else {
            helpdesk_preview(Some(&format!("Sent {}", files.join(", "))), PREVIEW_MAX)
        }
    });
    let title = if is_new {
        format!("New conversation from {who}")
    } else {
        format!("{who} replied")
    };
    (title, body)
}

fn notifier(ctx: &InboundContext) -> Notifier {
    Notifier {
        realtime: ctx.realtime.clone(),
        presence: None,
        mail: None,
        http: ctx.http.clone(),
        apns: None,
    }
}

/// `notifyDeskOfEmail`: the assignee, else every active internal teammate
/// who can work the inbox, in batches.
async fn notify_desk(
    ctx: &InboundContext,
    db: &PgPool,
    org: &str,
    conversation: &Value,
    title: &str,
    body: &str,
) {
    let id = conversation["id"].as_str().unwrap_or_default();
    let recipients = if let Some(assignee) = conversation["assigneeId"]
        .as_str()
        .filter(|a| !a.is_empty())
    {
        vec![assignee.to_owned()]
    } else {
        {
            let rows: Result<Vec<String>, sqlx::Error> = sqlx::query_scalar(
                "select user_id from workspace_members
                 where deleted_at is null and status = 'ACTIVE'
                   and upper(member_type) = 'INTERNAL' and upper(coalesce(role, '')) <> 'VIEWER'
                 limit $1",
            )
            .bind(MAX_RECIPIENTS)
            .fetch_all(db)
            .await;
            match rows {
                Ok(rows) => {
                    let mut out: Vec<String> = Vec::new();
                    for user in rows {
                        if !out.contains(&user) {
                            out.push(user);
                        }
                    }
                    out
                }
                Err(error) => {
                    tracing::error!(%error, conversation = id, "[HelpdeskInbox] Team notification failed");
                    return;
                }
            }
        }
    };
    let notifier = notifier(ctx);
    for batch in recipients.chunks(NOTIFY_BATCH) {
        for user_id in batch {
            let params = NewNotification {
                workspace_id: org.to_owned(),
                user_id: user_id.clone(),
                title: title.to_owned(),
                body: body.to_owned(),
                category: "helpdesk".to_owned(),
                notification_type: "message_received".to_owned(),
                entity_type: "desk_conversation".to_owned(),
                entity_id: id.to_owned(),
                action_url: format!("/welddesk/inbox/{id}"),
                severity: "info".to_owned(),
                actor_type: Some("system".to_owned()),
                actor_id: None,
                data: vec![("conversationId".to_owned(), id.to_owned())],
                ..NewNotification::default()
            };
            if let Err(error) = create_and_deliver(db, &notifier, &params).await {
                tracing::error!(%error, conversation = id, "[HelpdeskInbox] notification failed");
            }
        }
    }
}

async fn publish_all(ctx: &InboundContext, messages: Vec<RealtimeMessage>) {
    let Some(realtime) = &ctx.realtime else {
        tracing::error!(
            "[HelpdeskInbox] Failed to publish desk realtime: REALTIME service binding is not configured"
        );
        return;
    };
    for message in messages {
        if let Err(error) = realtime.publish_boxed(&message).await {
            tracing::error!(%error, channel = %message.channel, "[HelpdeskInbox] realtime publish failed");
            return;
        }
    }
}

/// `publishDeskInbound`: the inbox's conversation and message topics, and
/// the conversation room.
async fn publish_desk_inbound(
    ctx: &InboundContext,
    org: &str,
    conversation: &Value,
    message: &Value,
    created: bool,
    preview: &str,
    sender_name: &str,
) {
    let room = json!({
        "type": "message",
        "id": message["id"],
        "content": if message["body"].is_null() { json!(preview) } else { message["body"].clone() },
        "senderId": message["authorId"],
        "senderType": "visitor",
        "senderName": sender_name,
        "kind": if message["kind"].is_null() { json!("message") } else { message["kind"].clone() },
        "ts": now_ms(),
    });
    publish_all(
        ctx,
        vec![
            RealtimeMessage::workspace(
                org,
                "desk_conversation",
                if created { "created" } else { "updated" },
                conversation.clone(),
                "system",
            ),
            RealtimeMessage::workspace(org, "desk_message", "created", message.clone(), "system"),
            conversation_publish(conversation["id"].as_str().unwrap_or_default(), room),
        ],
    )
    .await;
}

/// `autoAssignDeskEmailConversation`: an open, unowned conversation gets an
/// owner when the workspace has auto-assignment on; the change goes live
/// and to the hub as `assigned`.
async fn auto_assign(ctx: &InboundContext, db: &PgPool, org: &str, conversation: Value) -> Value {
    let owned = conversation["assigneeId"]
        .as_str()
        .is_some_and(|a| !a.is_empty());
    if owned || conversation["state"] != "open" {
        return conversation;
    }
    let id = conversation["id"].as_str().unwrap_or_default().to_owned();
    match weldsuite_desk_domain::assignment::auto_assign(db, &id).await {
        Ok(Some((assigned, message))) => {
            publish_all(
                ctx,
                vec![
                    RealtimeMessage::workspace(
                        org,
                        "desk_conversation",
                        "updated",
                        assigned.clone(),
                        "system",
                    ),
                    RealtimeMessage::workspace(org, "desk_message", "created", message, "system"),
                ],
            )
            .await;
            match EventType::catalog("desk_conversation", "assigned") {
                Ok(event) => {
                    let context = EventContext::new(org, "system", EventSource::System);
                    ctx.events
                        .publish_and_wait(&context, EntityEvent::new(event, id, assigned.clone()))
                        .await;
                }
                Err(error) => tracing::error!(%error, "[HelpdeskInbox] unknown entity event"),
            }
            assigned
        }
        Ok(None) => conversation,
        Err(error) => {
            tracing::error!(%error, conversation = %id, "[HelpdeskInbox] Auto-assignment failed");
            conversation
        }
    }
}

/// `ingestHelpdeskInboxEmail`: one email into one helpdesk inbox; the
/// conversation id, or `None` on a failure (logged).
#[allow(clippy::too_many_lines)] // the worker's function, step by step
async fn ingest_helpdesk(
    ctx: &InboundContext,
    email: &ParsedEmail,
    inbox: &HelpdeskInbox,
    attachments: &[ParsedAttachment],
) -> Option<String> {
    let db = match ctx.tenants.tenant_db(&inbox.workspace_id).await {
        Ok(db) => db,
        Err(error) => {
            tracing::error!(%error, workspace = %inbox.workspace_id, "[HelpdeskInbox] Failed to process");
            return None;
        }
    };
    let body = [
        email.text_body.as_deref(),
        email.html_body.as_deref(),
        Some(email.subject.as_str()),
    ]
    .into_iter()
    .flatten()
    .find(|t| !t.is_empty())
    .unwrap_or_default()
    .to_owned();
    let stored = store_desk_attachments(ctx, &inbox.workspace_id, email, attachments).await;
    let prior = find_prior_state(&db, email).await;
    let to_emails: Vec<String> = email.to.iter().map(|t| t.email.clone()).collect();
    let cc_emails: Vec<String> = email.cc.iter().map(|t| t.email.clone()).collect();
    let from_name = email.from.name.as_deref().filter(|n| !n.is_empty());
    let ingested = match ingest_desk_email(
        &db,
        IngestEmail {
            from_name,
            from_email: &email.from.email,
            to_address: &inbox.email,
            subject: &email.subject,
            body: &body,
            attachments: (!stored.is_empty()).then(|| stored.clone()),
            rfc_message_id: &email.message_id,
            in_reply_to: email.in_reply_to.as_deref(),
            references: email.references.as_deref().unwrap_or_default(),
            to_emails: Some(to_emails),
            cc_emails: Some(cc_emails),
        },
    )
    .await
    {
        Ok(ingested) => ingested,
        Err(error) => {
            tracing::error!(%error, workspace = %inbox.workspace_id, "[HelpdeskInbox] Failed to process");
            return None;
        }
    };
    tracing::info!(
        conversation = ingested.conversation["id"].as_str().unwrap_or_default(),
        created = ingested.created,
        "[HelpdeskInbox] desk conversation from email"
    );
    let sender = from_name.unwrap_or(&email.from.email).to_owned();
    if let Some(org) = &inbox.clerk_org_id {
        publish_desk_inbound(
            ctx,
            org,
            &ingested.conversation,
            &ingested.message,
            ingested.created,
            &crate::store::utf16_prefix(&body, 200),
            &sender,
        )
        .await;
    } else {
        tracing::warn!(
            workspace = %inbox.workspace_id,
            "[HelpdeskInbox] Workspace has no clerkOrgId — skipping realtime publish"
        );
    }
    let conversation = match &inbox.clerk_org_id {
        Some(org) => auto_assign(ctx, &db, org, ingested.conversation.clone()).await,
        None => ingested.conversation.clone(),
    };
    let assignee = conversation["assigneeId"].as_str();
    let id = conversation["id"].as_str().unwrap_or_default().to_owned();
    match (
        plan(ingested.created, assignee, prior.as_ref()),
        &inbox.clerk_org_id,
    ) {
        (Plan::Notify, Some(org)) => {
            let files: Vec<String> = stored
                .iter()
                .map(|a| a["name"].as_str().unwrap_or_default().to_owned())
                .collect();
            let (title, text) = notification_content(
                ingested.created,
                &sender,
                email.text_body.as_deref(),
                conversation["title"].as_str(),
                &files,
            );
            notify_desk(ctx, &db, org, &conversation, &title, &text).await;
        }
        (Plan::AssigneeReply, Some(org)) => {
            let reply = customer_reply(
                &db,
                assignee,
                EntityKind::Conversation,
                &id,
                &sender,
                conversation["contactId"].as_str(),
                Some(&body),
                conversation["title"].as_str(),
            )
            .await;
            match reply {
                Ok(Some(n)) => {
                    let params = NewNotification {
                        workspace_id: org.clone(),
                        user_id: n.user_id,
                        title: n.title,
                        body: n.body,
                        category: n.category.to_owned(),
                        notification_type: n.notification_type.to_owned(),
                        entity_type: n.entity_type.to_owned(),
                        entity_id: n.entity_id,
                        action_url: n.action_url,
                        severity: n.severity.to_owned(),
                        actor_type: Some(n.actor_type.to_owned()),
                        actor_id: n.actor_id,
                        data: n
                            .data
                            .as_object()
                            .map(|m| {
                                m.iter()
                                    .map(|(k, v)| {
                                        (k.clone(), v.as_str().unwrap_or_default().to_owned())
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                        ..NewNotification::default()
                    };
                    if let Err(error) = create_and_deliver(&db, &notifier(ctx), &params).await {
                        tracing::error!(%error, conversation = %id, "[HelpdeskInbox] Reply notification failed");
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::error!(%error, conversation = %id, "[HelpdeskInbox] Reply notification failed");
                }
            }
        }
        _ => {}
    }
    upsert_contacts(
        ctx,
        &inbox.workspace_id,
        inbox.clerk_org_id.as_deref(),
        email,
    )
    .await;
    Some(id)
}

/// `processHelpdeskInboxEmail`: the conversation ids it touched.
pub async fn process_helpdesk_inbox(
    ctx: &InboundContext,
    email: &ParsedEmail,
    attachments: &[ParsedAttachment],
) -> Result<Vec<String>, sqlx::Error> {
    if !ctx.fan_out.desk {
        return Ok(Vec::new());
    }
    let recipients = collect_recipient_emails(email);
    let rows: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "select r.email, r.account_id, r.workspace_id, w.clerk_org_id
         from mail_account_registry r
         inner join workspaces w on w.id = r.workspace_id
         where r.email = any($1) and r.is_active = true",
    )
    .bind(&recipients)
    .fetch_all(&ctx.master)
    .await?;
    let inboxes: Vec<HelpdeskInbox> = rows
        .into_iter()
        .filter_map(|(email, account_id, workspace_id, clerk_org_id)| {
            workspace_id.map(|workspace_id| HelpdeskInbox {
                email,
                account_id,
                workspace_id,
                clerk_org_id,
            })
        })
        .collect();
    let mut helpdesk: Vec<HelpdeskInbox> = inboxes
        .iter()
        .filter(|i| i.account_id.starts_with("helpdesk_"))
        .cloned()
        .collect();
    for reg in inboxes.iter().filter(|i| {
        !i.account_id.starts_with("helpdesk_") && !i.account_id.starts_with("acct_inbox_")
    }) {
        if helpdesk.iter().any(|h| h.email == reg.email) {
            continue;
        }
        let flagged = async {
            let db = ctx.tenants.tenant_db(&reg.workspace_id).await?;
            let id: Option<String> = sqlx::query_scalar(
                "select id from mail_accounts
                 where email = $1 and status = 'active' and deleted_at is null
                   and metadata->>'helpdeskEnabled' = 'true'
                 limit 1",
            )
            .bind(&reg.email)
            .fetch_optional(&db)
            .await?;
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(id)
        };
        match flagged.await {
            Ok(Some(id)) => helpdesk.push(HelpdeskInbox {
                email: reg.email.clone(),
                account_id: format!("helpdesk_mail_{id}"),
                workspace_id: reg.workspace_id.clone(),
                clerk_org_id: reg.clerk_org_id.clone(),
            }),
            Ok(None) => {}
            Err(error) => {
                tracing::error!(%error, email = %reg.email, "[HelpdeskInbox] Failed to check helpdeskEnabled");
            }
        }
    }
    let mut ids = Vec::new();
    for inbox in &helpdesk {
        if let Some(id) = ingest_helpdesk(ctx, email, inbox, attachments).await {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// `accountingAttachmentType(att)`: PDFs and images only (a `.pdf` sent as
/// `application/octet-stream` counts).
pub fn accounting_attachment_type(content_type: &str, file_name: &str) -> Option<String> {
    let base = if content_type.is_empty() {
        "application/octet-stream"
    } else {
        content_type
    };
    let mime = crate::mime::js_trim(base.split(';').next().unwrap_or_default()).to_lowercase();
    if mime == "application/pdf" || mime.starts_with("image/") {
        return Some(mime);
    }
    if mime == "application/octet-stream" && file_name.to_lowercase().ends_with(".pdf") {
        return Some("application/pdf".to_owned());
    }
    None
}

/// `processAccountingInboxEmail`: a WeldBooks `documents` row per PDF or
/// image (or one for an attachment-less HTML invoice). Runs only once the
/// edition serves WeldBooks; until then a no-op.
#[allow(clippy::too_many_lines)] // the worker's function, step by step
pub async fn process_accounting_inbox(
    ctx: &InboundContext,
    email: &ParsedEmail,
    attachments: &[ParsedAttachment],
) -> Result<Vec<String>, sqlx::Error> {
    if !ctx.fan_out.books {
        return Ok(Vec::new());
    }
    let recipients = collect_recipient_emails(email);
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "select account_id, workspace_id from mail_account_registry
         where email = any($1) and is_active = true",
    )
    .bind(&recipients)
    .fetch_all(&ctx.master)
    .await?;
    let mut ids = Vec::new();
    for (account_id, workspace_id) in rows {
        let Some(workspace_id) = workspace_id.filter(|_| account_id.starts_with("acct_inbox_"))
        else {
            continue;
        };
        let result = async {
            let db = ctx.tenants.tenant_db(&workspace_id).await?;
            let now = weldsuite_mail_domain::outbound::clock::iso(
                weldsuite_mail_domain::outbound::clock::now_ms(),
            );
            for att in attachments {
                let Some(mime) = accounting_attachment_type(&att.content_type, &att.file_name)
                else {
                    continue;
                };
                let key = format!(
                    "workspaces/{workspace_id}/accounting/inbox/{}/{}",
                    email.email_id, att.file_name
                );
                if let Some(storage) = &ctx.storage
                    && let Err(error) = storage
                        .put_boxed(
                            &key,
                            att.content.clone(),
                            &PutOptions::content_type(mime.clone()),
                        )
                        .await
                {
                    tracing::error!(%error, file = %att.file_name, "[AccountingInbox] Failed to upload attachment");
                    continue;
                }
                let id = format!(
                    "doc_{}",
                    weldsuite_kit::random_string(
                        21,
                        "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict",
                    )
                );
                sqlx::query(
                    "insert into documents
                        (id, type, file_name, original_file_name, file_key, file_size, mime_type,
                         source, status, email_from, email_subject, created_at, updated_at)
                     values ($1, $2, $3, $3, $4, $5, $6, 'email', 'pending', $7, $8, $9::timestamp, $9::timestamp)",
                )
                .bind(&id)
                .bind(if mime == "application/pdf" { "purchase_invoice" } else { "receipt" })
                .bind(&att.file_name)
                .bind(&key)
                .bind(i32::try_from(att.content.len()).unwrap_or(i32::MAX))
                .bind(&mime)
                .bind(&email.from.email)
                .bind(&email.subject)
                .bind(&now)
                .execute(&db)
                .await?;
                ids.push(id);
            }
            if attachments.is_empty() && email.html_body.is_some() {
                let id = format!(
                    "doc_{}",
                    weldsuite_kit::random_string(
                        21,
                        "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict",
                    )
                );
                let subject = if email.subject.is_empty() {
                    "email"
                } else {
                    email.subject.as_str()
                };
                sqlx::query(
                    "insert into documents
                        (id, type, file_name, original_file_name, file_key, mime_type,
                         source, status, email_from, email_subject, created_at, updated_at)
                     values ($1, 'purchase_invoice', $2, $3, $4, 'text/html', 'email', 'pending', $5, $6, $7::timestamp, $7::timestamp)",
                )
                .bind(&id)
                .bind(format!("email-{}.html", email.email_id))
                .bind(format!("{subject}.html"))
                .bind(format!("workspaces/{workspace_id}/accounting/inbox/{}/email.html", email.email_id))
                .bind(&email.from.email)
                .bind(&email.subject)
                .bind(&now)
                .execute(&db)
                .await?;
                ids.push(id);
            }
            Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
        };
        if let Err(error) = result.await {
            tracing::error!(%error, workspace = %workspace_id, "[AccountingInbox] Failed to process");
        }
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(name: &str, cid: Option<&str>, size: usize) -> ParsedAttachment {
        ParsedAttachment {
            file_name: name.to_owned(),
            content_type: "image/png".to_owned(),
            content: vec![1; size],
            content_id: cid.map(str::to_owned),
        }
    }

    #[test]
    fn desk_attachments_skip_embedded_and_empty() {
        let files = [
            att("logo.png", Some("<logo@x>"), 3),
            att("a.pdf", None, 2),
            att("empty", None, 0),
        ];
        let kept = select_desk_attachments(&files, Some("<img src=\"cid:LOGO@x\">"));
        let names: Vec<&str> = kept.iter().map(|a| a.file_name.as_str()).collect();
        assert_eq!(names, ["a.pdf"]);
        assert_eq!(
            stored_file_metadata("text/html; charset=utf-8", "x.html"),
            (
                "application/octet-stream".to_owned(),
                "attachment; filename=\"x.html\"".to_owned()
            )
        );
        assert_eq!(safe_file_name("..hidden"), "hidden");
        assert_eq!(safe_file_name(""), "attachment");
    }

    #[test]
    fn plans() {
        assert_eq!(plan(true, None, None), Plan::Notify);
        assert_eq!(plan(false, Some("u1"), None), Plan::AssigneeReply);
        assert_eq!(
            plan(false, None, Some(&("open".to_owned(), true))),
            Plan::None
        );
        assert_eq!(
            plan(false, None, Some(&("closed".to_owned(), true))),
            Plan::Notify
        );
        assert_eq!(
            notification_content(false, " ", None, None, &["a.pdf".to_owned()]),
            ("A customer replied".to_owned(), "Sent a.pdf".to_owned())
        );
    }

    #[test]
    fn accounting_types() {
        assert_eq!(
            accounting_attachment_type("application/octet-stream", "Inv.PDF").as_deref(),
            Some("application/pdf")
        );
        assert_eq!(
            accounting_attachment_type("IMAGE/PNG; x=y", "a").as_deref(),
            Some("image/png")
        );
        assert_eq!(accounting_attachment_type("text/plain", "a.pdf"), None);
    }
}
