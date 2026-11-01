//! `processInboundEmail` and `finishWorkspaceDelivery`: find the
//! recipients, store per mailbox, then per stored message the mail rules,
//! the contact upsert, the hub `email:created` and each member's realtime
//! `mail:new`, bell row and push.

use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEvent, EventContext, EventSource, EventType};
use weldsuite_mail_domain::contacts::{ContactAddress, upsert_mail_contacts};
use weldsuite_notifications::{NewNotification, Notifier, channel_preferences, create_and_deliver};
use weldsuite_ports::RealtimeMessage;

use crate::context::InboundContext;
use crate::parsed::{ParsedAttachment, ParsedEmail};
use crate::push::send_new_email_push;
use crate::recipients::{
    Member, RecipientAccount, collect_recipient_emails, find_recipient_accounts,
};
use crate::rules::{RuleState, apply_mail_rules, finalize_inbound};
use crate::store::{Stored, inbound_labels, preview, store_email};

/// What `processInboundEmail` returns.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Processed {
    pub stored: usize,
    pub notified: usize,
    pub recipients: usize,
}

/// `processInboundEmail(env, email, attachments, ctx)`. A failure to read
/// the registry is an error (the delivery is retried); everything per
/// mailbox is logged and skipped, as in the worker.
pub async fn process_inbound_email(
    ctx: &InboundContext,
    email: &ParsedEmail,
    attachments: &[ParsedAttachment],
) -> Result<Processed, sqlx::Error> {
    let recipient_emails = collect_recipient_emails(email);
    let accounts = find_recipient_accounts(ctx, &recipient_emails).await?;
    if accounts.is_empty() {
        tracing::info!(recipients = %recipient_emails.join(", "), "[Mail] No matching accounts");
        return Ok(Processed::default());
    }
    let names: Vec<String> = attachments
        .iter()
        .map(|a| a.file_name.clone())
        .filter(|n| !n.is_empty())
        .collect();
    let mut out = Processed {
        recipients: accounts.len(),
        ..Processed::default()
    };
    for account in &accounts {
        let db = match ctx.tenants.tenant_db(&account.workspace_id).await {
            Ok(db) => db,
            Err(error) => {
                tracing::error!(%error, account = %account.account_id, "[Store] Could not resolve the mailbox");
                continue;
            }
        };
        let Some(stored) = store_email(ctx, &db, account, email, &names, attachments).await else {
            continue;
        };
        out.stored += 1;
        out.notified += finish_workspace_delivery(ctx, account, email, stored).await;
    }
    Ok(out)
}

/// `classifyAndRunRules`: Jev labels (none on the Kubernetes editions:
/// there is no Workers AI, and mail AI is an unavailable feature, so it
/// does what the worker does without the binding), then the account's
/// rules, folded into one `inbound.finalize`. True when a rule marked the
/// message as spam.
async fn classify_and_run_rules(
    ctx: &InboundContext,
    account: &RecipientAccount,
    message_id: &str,
    email: &ParsedEmail,
    initial: &RuleState,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let db = ctx.tenants.tenant_db(&account.workspace_id).await?;
    run_rules(&db, &account.account_id, message_id, email, initial).await
}

/// [`classify_and_run_rules`] on the mailbox's database.
pub async fn run_rules(
    db: &PgPool,
    account_id: &str,
    message_id: &str,
    email: &ParsedEmail,
    initial: &RuleState,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let db = db.clone();
    let ai_labels: Vec<(String, Option<String>)> = sqlx::query_as(
        "select name, ai_description from mail_labels
         where account_id = $1 and ai_enabled = true and deleted_at is null",
    )
    .bind(account_id)
    .fetch_all(&db)
    .await?;
    let candidates = ai_labels
        .iter()
        .filter(|(name, description)| {
            description.as_deref().is_some_and(|d| !d.is_empty()) && !initial.labels.contains(name)
        })
        .count();
    if candidates > 0 {
        tracing::warn!(
            message_id,
            "[Store] Workers AI not configured — skipping Jev auto-label"
        );
    }
    let mut state = initial.clone();
    let mut marked_spam = false;
    let rules = async {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(r) from mail_rules r
             where r.account_id = $1 and r.is_active = true and r.deleted_at is null
             order by r.priority desc",
        )
        .bind(account_id)
        .fetch_all(&db)
        .await?;
        let rules: Vec<Value> = rows.into_iter().map(weldsuite_db::js_row).collect();
        apply_mail_rules(&db, &rules, email, message_id, &state).await
    };
    match rules.await {
        Ok(Ok(outcome)) => {
            state = outcome.state;
            marked_spam = outcome.marked_spam;
        }
        Ok(Err(_)) => tracing::error!(
            message_id,
            "[Rules] Rule execution failed: a condition value is not text"
        ),
        Err(error) => tracing::error!(%error, message_id, "[Rules] Rule execution failed"),
    }
    finalize_inbound(&db, account_id, message_id, initial, &state).await?;
    Ok(marked_spam)
}

/// `buildInboundPayload(account, email, result, preview)`.
fn inbound_payload(
    account: &RecipientAccount,
    email: &ParsedEmail,
    stored: &Stored,
    preview: &str,
) -> Value {
    json!({
        "accountId": account.account_id,
        "messageId": stored.message_id,
        "smtpMessageId": email.message_id,
        "threadId": stored.thread_id,
        "from": email.from.to_json(),
        "subject": email.subject,
        "preview": preview,
        "receivedAt": crate::mime::to_iso(email.received_at),
        "isRead": false,
        "hasAttachments": email.has_attachments,
    })
}

/// `publishInboundEmailCreated`: content only for a shared mailbox.
async fn publish_email_created(ctx: &InboundContext, account: &RecipientAccount, payload: &Value) {
    let data = if account.is_shared {
        json!({
            "id": payload["messageId"],
            "accountId": payload["accountId"],
            "threadId": payload["threadId"],
            "subject": payload["subject"],
            "from": payload["from"]["email"],
            "preview": payload["preview"],
            "receivedAt": payload["receivedAt"],
            "hasAttachments": payload["hasAttachments"],
            "smtpMessageId": payload["smtpMessageId"],
        })
    } else {
        json!({
            "id": payload["messageId"],
            "accountId": payload["accountId"],
            "subject": null,
            "from": null,
            "receivedAt": payload["receivedAt"],
        })
    };
    let entity_id = payload["messageId"].as_str().unwrap_or_default().to_owned();
    match EventType::catalog("email", "created") {
        Ok(event) => {
            let context = EventContext::new(&account.clerk_org_id, "system", EventSource::System);
            ctx.events
                .publish_and_wait(&context, EntityEvent::new(event, entity_id, data))
                .await;
        }
        Err(error) => tracing::error!(%error, "[Mail] email:created is not in the catalog"),
    }
}

/// `notifyWorkspaceMember`: realtime `mail:new` always; for ham also the
/// bell row and the push, as the member's `mail` preferences allow. True
/// when the realtime publish went out.
#[allow(clippy::too_many_arguments)]
async fn notify_member(
    ctx: &InboundContext,
    member: &Member,
    account: &RecipientAccount,
    db: Option<&PgPool>,
    email: &ParsedEmail,
    stored: &Stored,
    preview: &str,
    payload: &Value,
) -> bool {
    if member.email.as_deref().map(str::to_lowercase) == Some(email.from.email.to_lowercase()) {
        return false;
    }
    let mut published = false;
    if let Some(realtime) = &ctx.realtime {
        {
            let message = RealtimeMessage::personal(
                &account.clerk_org_id,
                &format!("mail.{}", member.user_id),
                "mail:new",
                payload.clone(),
                &member.user_id,
            );
            match realtime.publish_boxed(&message).await {
                Ok(()) => published = true,
                Err(error) => {
                    tracing::error!(%error, user = %member.user_id, "[Mail] Failed to notify user");
                }
            }
        }
    } else {
        tracing::error!(
            user = %member.user_id,
            "[Mail] Failed to notify user: REALTIME service binding is not configured"
        );
    }
    if stored.is_spam || stored.is_promotion {
        return published;
    }
    let mut push_allowed = true;
    if let Some(db) = db {
        let sender = email
            .from
            .name
            .as_deref()
            .map(crate::mime::js_trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(&email.from.email);
        let body = [
            crate::mime::js_trim(&email.subject),
            crate::mime::js_trim(preview),
        ]
        .into_iter()
        .find(|t| !t.is_empty())
        .unwrap_or("New email received");
        let notifier = Notifier {
            realtime: ctx.realtime.clone(),
            presence: None,
            mail: None,
            http: ctx.http.clone(),
            apns: None,
        };
        let params = NewNotification {
            workspace_id: account.clerk_org_id.clone(),
            user_id: member.user_id.clone(),
            title: crate::store::utf16_prefix(&format!("New email from {sender}"), 255),
            body: crate::store::utf16_prefix(body, 255),
            category: "mail".to_owned(),
            notification_type: "email_received".to_owned(),
            entity_type: "email".to_owned(),
            entity_id: stored.message_id.clone(),
            action_url: format!(
                "/weldmail/{}/inbox/{}",
                account.account_id, stored.message_id
            ),
            severity: "info".to_owned(),
            actor_type: Some("system".to_owned()),
            actor_id: None,
            exclude_email: true,
            exclude_push: true,
            data: vec![
                ("emailId".to_owned(), stored.message_id.clone()),
                ("emailAccountId".to_owned(), account.account_id.clone()),
            ],
            ..NewNotification::default()
        };
        if let Err(error) = create_and_deliver(db, &notifier, &params).await {
            tracing::error!(%error, user = %member.user_id, "[Mail] Failed to create bell notification");
        }
        match channel_preferences(db, &member.user_id, "mail").await {
            Ok(channels) => push_allowed = channels.push,
            Err(error) => {
                tracing::error!(%error, user = %member.user_id, "[Mail] Failed to read notification preferences");
            }
        }
    }
    if !push_allowed {
        return published;
    }
    send_new_email_push(ctx, account, &member.user_id, email, stored, preview).await;
    published
}

/// `finishWorkspaceDelivery`: how many members were told in-app.
pub async fn finish_workspace_delivery(
    ctx: &InboundContext,
    account: &RecipientAccount,
    email: &ParsedEmail,
    stored: Stored,
) -> usize {
    let mut stored = stored;
    let initial = RuleState {
        labels: inbound_labels(stored.is_spam, stored.is_promotion),
        is_read: false,
        is_flagged: false,
        is_spam: stored.is_spam,
        deleted: false,
    };
    match classify_and_run_rules(ctx, account, &stored.message_id, email, &initial).await {
        Ok(true) => {
            stored.is_spam = true;
            stored.is_promotion = false;
        }
        Ok(false) => {}
        Err(error) => {
            tracing::error!(%error, message_id = %stored.message_id, "[Store] AI classify/rules failed");
        }
    }

    upsert_contacts(
        ctx,
        &account.workspace_id,
        Some(&account.clerk_org_id),
        email,
    )
    .await;

    let preview = preview(email);
    let payload = inbound_payload(account, email, &stored, &preview);
    publish_email_created(ctx, account, &payload).await;

    let db = match ctx.tenants.tenant_db(&account.workspace_id).await {
        Ok(db) => Some(db),
        Err(error) => {
            tracing::error!(%error, workspace = %account.workspace_id, "[Mail] Failed to open tenant DB for notifications");
            None
        }
    };
    let mut notified = 0;
    for member in &account.members {
        if notify_member(
            ctx,
            member,
            account,
            db.as_ref(),
            email,
            &stored,
            &preview,
            &payload,
        )
        .await
        {
            notified += 1;
        }
    }
    notified
}

/// `upsertContactsFromMailMessage(env, workspaceId, clerkOrgId, { from, to, cc })`:
/// avatars only with an organization id (their path) and the bucket.
pub async fn upsert_contacts(
    ctx: &InboundContext,
    workspace_id: &str,
    clerk_org_id: Option<&str>,
    email: &ParsedEmail,
) {
    let db = match ctx.tenants.tenant_db(workspace_id).await {
        Ok(db) => db,
        Err(error) => {
            tracing::error!(%error, workspace_id, "[mail-contacts] upsertContactsFromMailMessage failed");
            return;
        }
    };
    let mut addresses: Vec<ContactAddress> = Vec::new();
    if !email.from.email.is_empty() {
        addresses.push(ContactAddress {
            email: email.from.email.clone(),
            name: email.from.name.clone(),
        });
    }
    for list in [&email.to, &email.cc] {
        for address in list {
            if !address.email.is_empty() {
                addresses.push(ContactAddress {
                    email: address.email.clone(),
                    name: address.name.clone(),
                });
            }
        }
    }
    if addresses.is_empty() {
        return;
    }
    let (storage, public_url) = match clerk_org_id {
        Some(_) => (ctx.storage.as_ref(), ctx.public_url.as_deref()),
        None => (None, None),
    };
    upsert_mail_contacts(
        &db,
        clerk_org_id.unwrap_or(workspace_id),
        &addresses,
        storage,
        public_url,
    )
    .await;
}
