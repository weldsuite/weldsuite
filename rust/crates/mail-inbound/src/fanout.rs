//! The specialised inboxes an inbound message also reaches, when the edition
//! serves their module (MAIL-010): WeldDesk email inboxes
//! (`processHelpdeskInboxEmail`, `desk-inbound.ts`) and WeldBooks
//! accounting inboxes (`processAccountingInboxEmail`). Best effort: a
//! failure is logged and never fails the delivery.

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect,
};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_desk_domain::email::{IngestEmail, find_desk_email_conversation, ingest_desk_email};
use weldsuite_desk_domain::notify::{
    EntityKind, PREVIEW_MAX, customer_reply, preview as helpdesk_preview,
};
use weldsuite_desk_domain::realtime::{conversation_publish, now_ms};
use weldsuite_events::{EntityEvent, EventContext, EventSource, EventType};
use weldsuite_notifications::{NewNotification, Notifier, create_and_deliver};
use weldsuite_ports::{PutOptions, RealtimeMessage};
use weldsuite_schema::master::{mail_account_registry as registry, workspaces};
use weldsuite_schema::tenant::enums::MailAccountStatus;
use weldsuite_schema::tenant::{
    documents, mail_accounts, settings as tenant_settings, workspace_members,
};

use crate::context::InboundContext;
use crate::deliver::upsert_contacts;
use crate::parsed::{ParsedAttachment, ParsedEmail};
use crate::recipients::collect_recipient_emails;

/// Most files kept per email.
pub const MAX_DESK_ATTACHMENTS: usize = 20;
/// Total bytes kept per email.
pub const MAX_DESK_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
const NOTIFY_BATCH: usize = 10;
const MAX_RECIPIENTS: u64 = 200;

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
pub fn select_desk_attachments<'a>(
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
pub fn stored_file_metadata(content_type: &str, file_name: &str) -> (String, String) {
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
    let lookup = find_desk_email_conversation(
        db,
        &from,
        Some(&email.subject),
        email.in_reply_to.as_deref(),
        email.references.as_deref().unwrap_or_default(),
    );
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

/// `planDeskNotification`: what to tell the team about a customer email.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    Notify,
    AssigneeReply,
    None,
}

/// `planDeskNotification({ created, assigneeId, prior })`: `prior` is the
/// conversation's state and whether it was waiting on the team.
pub fn plan(created: bool, assignee: Option<&str>, prior: Option<&(String, bool)>) -> Plan {
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
pub fn notification_content(
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

/// Active internal teammates who can work the inbox: `upper(member_type) =
/// 'INTERNAL'` and not `upper(coalesce(role, '')) = 'VIEWER'`.
async fn desk_teammates(db: &PgPool) -> Result<Vec<String>, DbErr> {
    use sea_orm::ExprTrait as _;
    use workspace_members::Column as W;
    let upper = |expr: Expr| Expr::expr(Func::upper(expr));
    workspace_members::Entity::find()
        .select_only()
        .column(W::UserId)
        .filter(W::DeletedAt.is_null())
        .filter(W::Status.eq("ACTIVE"))
        .filter(upper(W::MemberType.into_expr()).eq("INTERNAL"))
        .filter(
            upper(Expr::expr(Func::coalesce([
                W::Role.into_expr(),
                Expr::val(""),
            ])))
            .ne("VIEWER"),
        )
        .limit(MAX_RECIPIENTS)
        .into_tuple()
        .all(&orm(db))
        .await
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
            let rows: Result<Vec<String>, DbErr> = desk_teammates(db).await;
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

/// One desk entity event to the hub, as `system` (`publishEntityEventRaw`).
async fn publish_desk_event(
    ctx: &InboundContext,
    org: &str,
    entity_type: &str,
    action: &str,
    row: &Value,
) {
    match EventType::catalog(entity_type, action) {
        Ok(event) => {
            let context = EventContext::new(org, "system", EventSource::System);
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            ctx.events
                .publish_and_wait(&context, EntityEvent::new(event, id, row.clone()))
                .await;
        }
        Err(error) => tracing::error!(%error, "[HelpdeskInbox] unknown entity event"),
    }
}

/// `publishDeskInbound`: the hub (`desk_conversation created` for a new
/// conversation, `desk_message created`, for workflows), the inbox's
/// conversation and message topics, and the conversation room.
async fn publish_desk_inbound(
    ctx: &InboundContext,
    org: &str,
    conversation: &Value,
    message: &Value,
    created: bool,
    preview: &str,
    sender_name: &str,
) {
    if created {
        publish_desk_event(ctx, org, "desk_conversation", "created", conversation).await;
    }
    publish_desk_event(ctx, org, "desk_message", "created", message).await;
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

/// `markWorkspaceDue(env.SCHEDULE_INDEX, 'desk_sla', …)`: the SLA sweep
/// (desk-api) only opens workspaces the due index lists (keyed by
/// `workspaces.id`). Best effort.
async fn mark_sla_due(ctx: &InboundContext, workspace_id: &str, sla_check_at: Option<i64>) {
    if let Some(at) = sla_check_at.and_then(weldsuite_desk_domain::sla::instant) {
        weldsuite_db::due_index::mark_due(
            &ctx.master,
            weldsuite_desk_domain::sla::DUE_KIND,
            workspace_id,
            at,
        )
        .await;
    }
}

/// `autoAssignDeskEmailConversation(…, opened)`: a new conversation is
/// routed by the workspace's routing rules first; then an open, unowned
/// conversation gets an owner when the workspace has auto-assignment on
/// (its team's members when it has any, else the roster). Each change goes
/// live and to the hub (`assigned`, or `updated` for a rule's field change).
async fn auto_assign(
    ctx: &InboundContext,
    db: &PgPool,
    workspace_id: &str,
    org: &str,
    conversation: Value,
    opened: bool,
) -> Value {
    use weldsuite_desk_domain::routing::{self, Keep, Step, Trigger};
    let owned = conversation["assigneeId"]
        .as_str()
        .is_some_and(|a| !a.is_empty());
    if !opened && (owned || conversation["state"] != "open") {
        return conversation;
    }
    let id = conversation["id"].as_str().unwrap_or_default().to_owned();
    let picker = match &ctx.assignment_router {
        Some(router) => weldsuite_desk_domain::assignment::Picker::Router {
            router,
            workspace_id,
        },
        None => weldsuite_desk_domain::assignment::Picker::Local,
    };
    let done: Result<(Vec<Step>, Option<i64>), String> = if opened {
        routing::route_and_assign(db, &id, Keep::default(), Trigger::Opened, &picker)
            .await
            .map(|routed| (routed.steps, routed.sla_check_at))
            .map_err(|error| error.to_string())
    } else {
        weldsuite_desk_domain::assignment::auto_assign_with(db, &id, &picker)
            .await
            .map(|assigned| match assigned {
                Some(appended) => {
                    let at = appended.sla_check_at;
                    let (conversation, message) = appended.pair();
                    let step = Step {
                        conversation,
                        message,
                        action: "assigned",
                    };
                    (vec![step], at)
                }
                None => (Vec::new(), None),
            })
            .map_err(|error| error.to_string())
    };
    let (steps, sla_check_at) = match done {
        Ok(done) => done,
        Err(error) => {
            tracing::error!(%error, conversation = %id, "[HelpdeskInbox] Routing / auto-assignment failed");
            return conversation;
        }
    };
    let Some(last) = steps.last().map(|step| step.conversation.clone()) else {
        return conversation;
    };
    // The owner can change which SLA policy applies (desk-api's SLA sweep).
    mark_sla_due(ctx, workspace_id, sla_check_at).await;
    for step in steps {
        publish_all(
            ctx,
            vec![
                RealtimeMessage::workspace(
                    org,
                    "desk_conversation",
                    "updated",
                    step.conversation.clone(),
                    "system",
                ),
                RealtimeMessage::workspace(org, "desk_message", "created", step.message, "system"),
            ],
        )
        .await;
        publish_desk_event(
            ctx,
            org,
            "desk_conversation",
            step.action,
            &step.conversation,
        )
        .await;
    }
    last
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
    mark_sla_due(ctx, &inbox.workspace_id, ingested.sla_check_at).await;
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
        Some(org) => {
            auto_assign(
                ctx,
                &db,
                &inbox.workspace_id,
                org,
                ingested.conversation.clone(),
                ingested.created,
            )
            .await
        }
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

/// The address every WeldSuite system email comes from (`SYSTEM_FROM_ADDRESS`
/// in `@weldsuite/emails`).
pub const SYSTEM_FROM_ADDRESS: &str = "notifications@mail.weldsuite.org";

/// `isAutomatedDeskEmail(email)`: mail no person wrote, which must not open
/// or reopen a conversation. Anything marked `Auto-Submitted` (RFC 3834:
/// auto-replies, auto-generated notices) and the platform's own system emails
/// (calendar invites, notifications). WeldMail still stores it; only the
/// helpdesk skips it.
pub fn is_automated_desk_email(email: &ParsedEmail) -> bool {
    if weldsuite_kit::validation::js_trim(&email.from.email).to_lowercase() == SYSTEM_FROM_ADDRESS {
        return true;
    }
    email
        .header("auto-submitted")
        .map(|value| weldsuite_kit::validation::js_trim(value).to_lowercase())
        .is_some_and(|value| !value.is_empty() && value != "no")
}

/// `processHelpdeskInboxEmail`: the conversation ids it touched.
pub async fn process_helpdesk_inbox(
    ctx: &InboundContext,
    email: &ParsedEmail,
    attachments: &[ParsedAttachment],
) -> Result<Vec<String>, DbErr> {
    if !ctx.fan_out.desk {
        return Ok(Vec::new());
    }
    // Auto-replies and the platform's own notices never become conversations.
    if is_automated_desk_email(email) {
        return Ok(Vec::new());
    }
    let recipients = collect_recipient_emails(email);
    // `email = any('{}')` matches nothing.
    let rows: Vec<(String, String, Option<String>, Option<String>)> = if recipients.is_empty() {
        Vec::new()
    } else {
        registry::Entity::find()
            .select_only()
            .columns([
                registry::Column::Email,
                registry::Column::AccountId,
                registry::Column::WorkspaceId,
            ])
            .column(workspaces::Column::ClerkOrgId)
            .join(
                JoinType::InnerJoin,
                registry::Entity::belongs_to(workspaces::Entity)
                    .from(registry::Column::WorkspaceId)
                    .to(workspaces::Column::Id)
                    .into(),
            )
            .filter(registry::Column::Email.is_in(recipients))
            .filter(registry::Column::IsActive.eq(true))
            .into_tuple()
            .all(&orm(&ctx.master))
            .await?
    };
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
            let helpdesk_enabled = sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(
                mail_accounts::Column::Metadata.into_expr(),
                "helpdeskEnabled",
            );
            let id: Option<String> = mail_accounts::Entity::find()
                .select_only()
                .column(mail_accounts::Column::Id)
                .filter(mail_accounts::Column::Email.eq(&reg.email))
                .filter(mail_accounts::Column::Status.eq(MailAccountStatus::Active))
                .filter(mail_accounts::Column::DeletedAt.is_null())
                .filter(sea_orm::ExprTrait::eq(helpdesk_enabled, "true"))
                .into_tuple()
                .one(&orm(&db))
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

/// The legal entity a message to one of `recipients` books into: the entity
/// whose own inbox address it was sent to (`emailSettings.entityInboxes`,
/// `POST /api/accounting-entities/:id/inbox`), else the default entity (the
/// workspace's own address, which keeps working). `None` when there is no
/// default either: such a document counts for the default entity once there
/// is one.
pub async fn inbox_entity(db: &PgPool, recipients: &[String]) -> Result<Option<String>, DbErr> {
    let settings: Option<Option<Value>> = tenant_settings::Entity::find()
        .select_only()
        .column(tenant_settings::Column::EmailSettings)
        .filter(tenant_settings::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    if let Some(Value::Object(inboxes)) = settings
        .flatten()
        .as_ref()
        .and_then(|email| email.get("entityInboxes"))
    {
        let mut owners: Vec<(&String, &str)> = inboxes
            .iter()
            .filter_map(|(entity, address)| Some((entity, address.as_str()?)))
            .collect();
        owners.sort();
        for (entity, address) in owners {
            if recipients.iter().any(|r| r.eq_ignore_ascii_case(address)) {
                return Ok(Some(entity.clone()));
            }
        }
    }
    weldsuite_legal_entities::default_entity_id_for(
        db,
        Some(weldsuite_legal_entities::LegalEntityApp::Weldbooks),
    )
    .await
}

/// One WeldBooks entity event to the hub as `system`, so the OCR on arrival
/// and the rest of the event consumers see the document (the row a manual
/// upload announces).
async fn publish_document_created(ctx: &InboundContext, workspace_id: &str, row: Value) {
    match EventType::catalog("accounting_document", "created") {
        Ok(event) => {
            let context = EventContext::new(workspace_id, "system", EventSource::System);
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            ctx.events
                .publish_and_wait(&context, EntityEvent::new(event, id, row))
                .await;
        }
        Err(error) => tracing::error!(%error, "[AccountingInbox] unknown entity event"),
    }
}

/// An accounting document row's id, as the worker mints it.
fn document_id() -> String {
    format!(
        "doc_{}",
        weldsuite_kit::random_string(
            21,
            "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict",
        )
    )
}

/// `processAccountingInboxEmail`: a WeldBooks `documents` row per PDF or
/// image, booked into the legal entity the address belongs to ([`inbox_entity`]),
/// and one for an attachment-less HTML invoice, whose body is stored as the
/// file the row points at. A message whose HTML cannot be stored makes no
/// document (it would point at nothing). Each document is announced as
/// `accounting_document:created`. Runs only once the edition serves
/// WeldBooks; until then a no-op.
#[allow(clippy::too_many_lines)] // the worker's function, step by step
pub async fn process_accounting_inbox(
    ctx: &InboundContext,
    email: &ParsedEmail,
    attachments: &[ParsedAttachment],
) -> Result<Vec<String>, DbErr> {
    if !ctx.fan_out.books {
        return Ok(Vec::new());
    }
    let recipients = collect_recipient_emails(email);
    // `email = any('{}')` matches nothing.
    let rows: Vec<(String, String, Option<String>)> = if recipients.is_empty() {
        Vec::new()
    } else {
        registry::Entity::find()
            .select_only()
            .columns([
                registry::Column::Email,
                registry::Column::AccountId,
                registry::Column::WorkspaceId,
            ])
            .filter(registry::Column::Email.is_in(recipients))
            .filter(registry::Column::IsActive.eq(true))
            .into_tuple()
            .all(&orm(&ctx.master))
            .await?
    };
    let mut ids = Vec::new();
    for (address, account_id, workspace_id) in rows {
        let Some(workspace_id) = workspace_id.filter(|_| account_id.starts_with("acct_inbox_"))
        else {
            continue;
        };
        let result = async {
            let pool = ctx.tenants.tenant_db(&workspace_id).await?;
            let db = orm(&pool);
            let entity_id = inbox_entity(&pool, std::slice::from_ref(&address)).await?;
            let now = crate::store::timestamp(weldsuite_mail_domain::outbound::clock::now_ms());
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
                let id = document_id();
                let kind = if mime == "application/pdf" {
                    "purchase_invoice"
                } else {
                    "receipt"
                };
                let size = i32::try_from(att.content.len()).unwrap_or(i32::MAX);
                documents::Entity::insert(documents::ActiveModel {
                    id: Set(id.clone()),
                    entity_id: Set(entity_id.clone()),
                    type_: Set(kind.to_owned()),
                    file_name: Set(att.file_name.clone()),
                    original_file_name: Set(Some(att.file_name.clone())),
                    file_key: Set(key.clone()),
                    file_size: Set(Some(size)),
                    mime_type: Set(Some(mime.clone())),
                    source: Set("email".to_owned()),
                    status: Set("pending".to_owned()),
                    email_from: Set(Some(email.from.email.clone())),
                    email_subject: Set(Some(email.subject.clone())),
                    created_at: Set(now),
                    updated_at: Set(now),
                    ..Default::default()
                })
                .exec_without_returning(&db)
                .await?;
                publish_document_created(
                    ctx,
                    &workspace_id,
                    json!({
                        "id": id,
                        "entityId": entity_id,
                        "type": kind,
                        "fileName": att.file_name,
                        "fileKey": key,
                        "fileSize": size,
                        "mimeType": mime,
                        "source": "email",
                        "status": "pending",
                        "emailFrom": email.from.email,
                        "emailSubject": email.subject,
                    }),
                )
                .await;
                ids.push(id);
            }
            if attachments.is_empty()
                && let Some(html) = &email.html_body
            {
                let id = document_id();
                let subject = if email.subject.is_empty() {
                    "email"
                } else {
                    email.subject.as_str()
                };
                let key = format!(
                    "workspaces/{workspace_id}/accounting/inbox/{}/email.html",
                    email.email_id
                );
                // The row points at this file: no file, no row.
                let stored = if let Some(storage) = &ctx.storage {
                    storage
                        .put_boxed(
                            &key,
                            html.clone().into_bytes(),
                            &PutOptions::content_type("text/html".to_owned()),
                        )
                        .await
                        .map_err(|error| {
                            tracing::error!(%error, "[AccountingInbox] Failed to upload the e-mail body");
                        })
                        .is_ok()
                } else {
                    tracing::warn!(
                        "[AccountingInbox] No storage: an e-mail without attachments makes no document"
                    );
                    false
                };
                if stored {
                    let size = i32::try_from(html.len()).unwrap_or(i32::MAX);
                    documents::Entity::insert(documents::ActiveModel {
                        id: Set(id.clone()),
                        entity_id: Set(entity_id.clone()),
                        type_: Set("purchase_invoice".to_owned()),
                        file_name: Set(format!("email-{}.html", email.email_id)),
                        original_file_name: Set(Some(format!("{subject}.html"))),
                        file_key: Set(key.clone()),
                        file_size: Set(Some(size)),
                        mime_type: Set(Some("text/html".to_owned())),
                        source: Set("email".to_owned()),
                        status: Set("pending".to_owned()),
                        email_from: Set(Some(email.from.email.clone())),
                        email_subject: Set(Some(email.subject.clone())),
                        created_at: Set(now),
                        updated_at: Set(now),
                        ..Default::default()
                    })
                    .exec_without_returning(&db)
                    .await?;
                    publish_document_created(
                        ctx,
                        &workspace_id,
                        json!({
                            "id": id,
                            "entityId": entity_id,
                            "type": "purchase_invoice",
                            "fileName": format!("email-{}.html", email.email_id),
                            "fileKey": key,
                            "fileSize": size,
                            "mimeType": "text/html",
                            "source": "email",
                            "status": "pending",
                            "emailFrom": email.from.email,
                            "emailSubject": email.subject,
                        }),
                    )
                    .await;
                    ids.push(id);
                }
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
