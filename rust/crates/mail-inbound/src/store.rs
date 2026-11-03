//! Storing one inbound message in one workspace mailbox (`storeEmail`), in
//! the Postgres mailbox store the Kubernetes editions run (MAIL-010):
//! duplicate and thread resolution (`resolveInbound`), spam and promotion
//! scoring, attachments to the bucket, the `ingest` op (message row,
//! attachment rows, the subscription upsert) and the raw MIME to the mail
//! bucket.

use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_ports::PutOptions;

use crate::context::InboundContext;
use crate::parsed::{ParsedAttachment, ParsedEmail};
use crate::promotion::{PromotionInput, classify_promotion};
use crate::recipients::{RecipientAccount, collect_recipient_emails};
use crate::spam::{SpamInput, SpamOptions, score_inbound_spam};
use crate::thread_match::{
    bare_subject, conversation_subjects, has_reply_prefix, involves_address, message_id_variants,
    provider_message_ids,
};
use crate::unsubscribe::{SubscriptionValues, subscription_values};

/// `StoreEmailResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    pub message_id: String,
    pub thread_id: String,
    pub is_spam: bool,
    pub is_promotion: bool,
}

/// `ResolveInboundResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedThread {
    pub duplicate: bool,
    pub thread_id: String,
    pub is_existing_ham_thread: bool,
}

/// The reply's Message-IDs in both spellings (`replyLookupIds`).
fn reply_lookup_ids(email: &ParsedEmail) -> Vec<String> {
    let mut ids: Vec<String> = email.in_reply_to.iter().cloned().collect();
    ids.extend(email.references.iter().flatten().cloned());
    message_id_variants(&ids)
}

/// `findThreadByReplyIds`.
async fn find_thread_by_reply_ids(
    db: &PgPool,
    account_id: &str,
    email: &ParsedEmail,
) -> Result<Option<(String, bool)>, sqlx::Error> {
    let lookup = reply_lookup_ids(email);
    if lookup.is_empty() {
        return Ok(None);
    }
    let providers = provider_message_ids(&lookup);
    let row: Option<(Option<String>, Option<bool>)> = sqlx::query_as(
        "select thread_id, is_spam from mail_messages
         where account_id = $1
           and (message_id = any($2) or external_message_id = any($2) or mailcow_message_id = any($3))
         limit 1",
    )
    .bind(account_id)
    .bind(&lookup)
    .bind(&providers)
    .fetch_optional(db)
    .await?;
    Ok(row.and_then(|(thread, is_spam)| {
        thread
            .filter(|t| !t.is_empty())
            .map(|t| (t, is_spam == Some(false)))
    }))
}

/// A thread candidate as read: thread, spam flag, from, to, cc.
type SubjectRow = (Option<String>, Option<bool>, Value, Value, Option<Value>);

/// `findThreadBySubject`; `require_participant` keeps two strangers'
/// `Re: Hello` apart.
async fn find_thread_by_subject(
    db: &PgPool,
    account_id: &str,
    email: &ParsedEmail,
    require_participant: bool,
) -> Result<Option<(String, bool)>, sqlx::Error> {
    let subjects = conversation_subjects(Some(&email.subject));
    if subjects.is_empty() {
        return Ok(None);
    }
    let rows: Vec<SubjectRow> = sqlx::query_as(
        "select thread_id, is_spam, \"from\", \"to\", cc from mail_messages
         where account_id = $1 and lower(subject) = any($2) and deleted_at is null
         order by sent_date desc limit 20",
    )
    .bind(account_id)
    .bind(&subjects)
    .fetch_all(db)
    .await?;
    let found = rows.into_iter().find(|(thread, _, from, to, cc)| {
        thread.as_deref().is_some_and(|t| !t.is_empty())
            && (!require_participant
                || involves_address(
                    from,
                    to,
                    cc.as_ref().unwrap_or(&Value::Null),
                    Some(&email.from.email),
                ))
    });
    Ok(found.and_then(|(thread, is_spam, ..)| thread.map(|t| (t, is_spam == Some(false)))))
}

/// `resolveInbound(db, accountId, query)` (`store/postgres/inbound.ts`).
pub async fn resolve_inbound(
    db: &PgPool,
    account_id: &str,
    email: &ParsedEmail,
) -> Result<ResolvedThread, sqlx::Error> {
    if !email.message_id.is_empty() {
        let existing: Option<(String, Option<String>)> = sqlx::query_as(
            "select id, thread_id from mail_messages where account_id = $1 and message_id = $2 limit 1",
        )
        .bind(account_id)
        .bind(&email.message_id)
        .fetch_optional(db)
        .await?;
        if let Some((id, thread)) = existing {
            return Ok(ResolvedThread {
                duplicate: true,
                thread_id: thread.unwrap_or(id),
                is_existing_ham_thread: false,
            });
        }
    }
    let found = |(thread_id, ham): (String, bool)| ResolvedThread {
        duplicate: false,
        thread_id,
        is_existing_ham_thread: ham,
    };
    if !email.is_reply() {
        if has_reply_prefix(Some(&email.subject))
            && !bare_subject(Some(&email.subject)).is_empty()
            && let Some(hit) = find_thread_by_subject(db, account_id, email, true).await?
        {
            return Ok(found(hit));
        }
        return Ok(ResolvedThread {
            duplicate: false,
            thread_id: email.message_id.clone(),
            is_existing_ham_thread: false,
        });
    }
    if let Some(hit) = find_thread_by_reply_ids(db, account_id, email).await? {
        return Ok(found(hit));
    }
    if let Some(hit) = find_thread_by_subject(db, account_id, email, false).await? {
        return Ok(found(hit));
    }
    // `computeThreadId`: the root reference, else `inReplyTo`, else itself.
    let thread_id = email
        .references
        .as_ref()
        .and_then(|r| r.first())
        .filter(|r| !r.is_empty())
        .or(email.in_reply_to.as_ref().filter(|r| !r.is_empty()))
        .cloned()
        .unwrap_or_else(|| email.message_id.clone());
    Ok(ResolvedThread {
        duplicate: false,
        thread_id,
        is_existing_ham_thread: false,
    })
}

/// `inboundLabels(isSpam, isPromotion)`.
pub fn inbound_labels(is_spam: bool, is_promotion: bool) -> Vec<String> {
    vec![
        if is_spam {
            "SPAM"
        } else if is_promotion {
            "PROMOTIONS"
        } else {
            "INBOX"
        }
        .to_owned(),
    ]
}

/// The first `max` UTF-16 units of `text` (`substring(0, max)`).
pub(crate) fn utf16_prefix(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}

/// `email.textBody?.substring(0, 200) || email.subject`.
pub fn preview(email: &ParsedEmail) -> String {
    email
        .text_body
        .as_deref()
        .map(|t| utf16_prefix(t, 200))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| email.subject.clone())
}

/// `msg_${nanoid()}`.
fn nanoid() -> String {
    weldsuite_kit::random_string(
        21,
        "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict",
    )
}

/// `fileName.replaceAll(/[^a-zA-Z0-9._-]/g, '_')`, per UTF-16 unit.
pub(crate) fn sanitize_file_name(name: &str) -> String {
    name.encode_utf16()
        .map(|u| match char::from_u32(u32::from(u)) {
            Some(c) if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') => c,
            _ => '_',
        })
        .collect()
}

/// One attachment row of the ingest.
struct AttachmentInput {
    id: String,
    file_name: String,
    content_type: String,
    size: usize,
    storage_path: String,
    download_url: String,
}

/// `buildWorkspaceAttachmentInputs`: each attachment to `STORAGE`, its row,
/// and the `cid:` map for the HTML.
async fn build_attachment_inputs(
    ctx: &InboundContext,
    workspace_id: &str,
    message_id: &str,
    attachments: &[ParsedAttachment],
) -> (Vec<AttachmentInput>, Vec<(String, String)>) {
    let mut inputs = Vec::new();
    let mut cids: Vec<(String, String)> = Vec::new();
    let Some(storage) = &ctx.storage else {
        return (inputs, cids);
    };
    let public_url = ctx.public_url.clone().unwrap_or_default();
    for (i, att) in attachments.iter().enumerate() {
        let content_type = if att.content_type.is_empty() {
            "application/octet-stream".to_owned()
        } else {
            att.content_type.clone()
        };
        let key = format!(
            "workspaces/{workspace_id}/mail/attachments/{message_id}/{}_{}",
            i + 1,
            sanitize_file_name(&att.file_name)
        );
        if let Err(error) = storage
            .put_boxed(
                &key,
                att.content.clone(),
                &PutOptions::content_type(content_type.clone()),
            )
            .await
        {
            tracing::error!(%error, index = i + 1, file = %att.file_name, "[Store] Failed to store attachment");
            continue;
        }
        let download_url = if public_url.is_empty() {
            String::new()
        } else {
            format!("{public_url}/{key}")
        };
        if let Some(cid) = att.content_id.as_deref().filter(|c| !c.is_empty())
            && !download_url.is_empty()
        {
            let cid = cid.strip_prefix('<').unwrap_or(cid);
            let cid = cid.strip_suffix('>').unwrap_or(cid).to_owned();
            if let Some(slot) = cids.iter_mut().find(|(c, _)| *c == cid) {
                slot.1.clone_from(&download_url);
            } else {
                cids.push((cid, download_url.clone()));
            }
        }
        inputs.push(AttachmentInput {
            id: weldsuite_kit::generate_id("attach"),
            file_name: att.file_name.clone(),
            content_type,
            size: att.content.len(),
            storage_path: key,
            download_url,
        });
    }
    (inputs, cids)
}

/// `rewriteCidReferences(htmlBody, cidMap)`: `None` when nothing changed.
pub(crate) fn rewrite_cid_references(
    html: Option<&str>,
    cids: &[(String, String)],
) -> Option<String> {
    let html = html.filter(|h| !h.is_empty())?;
    if cids.is_empty() {
        return None;
    }
    let mut rewritten = html.to_owned();
    for (cid, url) in cids {
        rewritten = rewritten.replace(&format!("cid:{cid}"), url);
    }
    (rewritten != html).then_some(rewritten)
}

/// The ingest's subscription upsert (`upsertSubscriptionOnMessage`).
async fn upsert_subscription(
    db: &PgPool,
    account_id: &str,
    values: &SubscriptionValues,
    now: &str,
) -> Result<(), sqlx::Error> {
    let received = crate::mime::to_iso(values.received_at);
    sqlx::query(
        "insert into mail_subscriptions
            (id, account_id, sender_email, sender_name, sender_domain, list_id,
             unsubscribe_url, unsubscribe_mailto, one_click, message_count, last_subject,
             first_received_at, last_received_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11::timestamp, $11::timestamp)
         on conflict (account_id, sender_email) do update set
            sender_name = coalesce($4, mail_subscriptions.sender_name),
            list_id = coalesce($6, mail_subscriptions.list_id),
            unsubscribe_url = $7,
            unsubscribe_mailto = $8,
            one_click = $9,
            message_count = mail_subscriptions.message_count + 1,
            last_subject = $10,
            last_received_at = greatest(mail_subscriptions.last_received_at, $11::timestamp),
            updated_at = $12::timestamp",
    )
    .bind(weldsuite_kit::generate_id("msub"))
    .bind(account_id)
    .bind(&values.sender_email)
    .bind(&values.sender_name)
    .bind(&values.sender_domain)
    .bind(&values.list_id)
    .bind(&values.unsubscribe_url)
    .bind(&values.unsubscribe_mailto)
    .bind(values.one_click)
    .bind(&values.last_subject)
    .bind(&received)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

/// `toSecurityStatusValue`: only the enum's values reach the column.
fn security(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|v| {
        matches!(
            *v,
            "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror"
        )
    })
}

/// The `ingest` op (`applyIngest`): the message row (a lost race on the id
/// reports the existing row), its attachment rows and the subscription.
#[allow(clippy::too_many_arguments)]
async fn ingest(
    db: &PgPool,
    account_id: &str,
    message_id: &str,
    thread_id: &str,
    email: &ParsedEmail,
    html: Option<&str>,
    labels: &[String],
    is_spam: bool,
    attachments: &[AttachmentInput],
    subscription: Option<&SubscriptionValues>,
    received_ms: i64,
) -> Result<String, sqlx::Error> {
    let now = weldsuite_mail_domain::outbound::clock::iso(
        weldsuite_mail_domain::outbound::clock::now_ms(),
    );
    let received = crate::mime::to_iso(received_ms);
    let sent = crate::mime::to_iso(email.received_at);
    let from = email.from.to_json();
    let to: Vec<Value> = email
        .to
        .iter()
        .map(crate::parsed::EmailAddress::to_json)
        .collect();
    let cc: Vec<Value> = email
        .cc
        .iter()
        .map(crate::parsed::EmailAddress::to_json)
        .collect();
    let references: Vec<String> = email.references.clone().unwrap_or_default();
    let inserted: Option<(String, Option<String>)> = sqlx::query_as(
        "insert into mail_messages
            (id, account_id, message_id, thread_id, \"from\", \"to\", cc, subject, preview,
             text_body, html_body, sent_date, received_date, is_read, labels, is_spam,
             is_starred, is_important, is_trash, in_reply_to, \"references\", is_reply,
             spf_status, dkim_status, dmarc_status, source, has_attachments, attachment_count,
             created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamp, $13::timestamp,
                 false, $14, $15, $16, $17, $18, $19, $20, $21,
                 $22::mail_security_status, $23::mail_security_status, $24::mail_security_status,
                 'inbound', $25, $26, $13::timestamp, $27::timestamp)
         on conflict (id) do nothing
         returning id, thread_id",
    )
    .bind(message_id)
    .bind(account_id)
    .bind(&email.message_id)
    .bind(thread_id)
    .bind(&from)
    .bind(Value::from(to))
    .bind(Value::from(cc))
    .bind(&email.subject)
    .bind(preview(email))
    .bind(email.text_body.as_deref())
    .bind(html)
    .bind(&sent)
    .bind(&received)
    .bind(json!(labels))
    .bind(is_spam)
    .bind(labels.iter().any(|l| l == "STARRED"))
    .bind(labels.iter().any(|l| l == "IMPORTANT"))
    .bind(labels.iter().any(|l| l == "TRASH"))
    .bind(email.in_reply_to.as_deref())
    .bind(json!(references))
    .bind(email.is_reply())
    .bind(security(email.spf_status.as_ref()))
    .bind(security(email.dkim_status.as_ref()))
    .bind(security(email.dmarc_status.as_ref()))
    .bind(!attachments.is_empty())
    .bind(i32::try_from(attachments.len()).unwrap_or(i32::MAX))
    .bind(&now)
    .fetch_optional(db)
    .await?;
    let Some((id, thread)) = inserted else {
        let existing: Option<Option<String>> =
            sqlx::query_scalar("select thread_id from mail_messages where id = $1 limit 1")
                .bind(message_id)
                .fetch_optional(db)
                .await?;
        return Ok(existing.flatten().unwrap_or_else(|| message_id.to_owned()));
    };
    for att in attachments {
        sqlx::query(
            "insert into mail_attachments
                (id, message_id, file_name, content_type, size, storage_path, download_url,
                 is_inline, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, false, $8::timestamp, $8::timestamp)",
        )
        .bind(&att.id)
        .bind(&id)
        .bind(&att.file_name)
        .bind(&att.content_type)
        .bind(i32::try_from(att.size).unwrap_or(i32::MAX))
        .bind(&att.storage_path)
        .bind(&att.download_url)
        .bind(&now)
        .execute(db)
        .await?;
    }
    if let Some(values) = subscription {
        upsert_subscription(db, account_id, values, &now).await?;
    }
    Ok(thread.unwrap_or(id))
}

/// `storeEmail(env, account, email, attachmentNames, attachments, mailbox)`
/// for a workspace mailbox: the stored message, or `None` for a duplicate
/// (or a failure, which is logged, as the worker does).
pub async fn store_email(
    ctx: &InboundContext,
    db: &PgPool,
    account: &RecipientAccount,
    email: &ParsedEmail,
    attachment_names: &[String],
    attachments: &[ParsedAttachment],
) -> Option<Stored> {
    match store(ctx, db, account, email, attachment_names, attachments).await {
        Ok(stored) => stored,
        Err(error) => {
            tracing::error!(%error, account = %account.account_id, "[Store] Failed to store email");
            None
        }
    }
}

#[allow(clippy::too_many_lines)] // `storeEmail`, step by step
async fn store(
    ctx: &InboundContext,
    db: &PgPool,
    account: &RecipientAccount,
    email: &ParsedEmail,
    attachment_names: &[String],
    attachments: &[ParsedAttachment],
) -> Result<Option<Stored>, sqlx::Error> {
    let resolved = resolve_inbound(db, &account.account_id, email).await?;
    if resolved.duplicate {
        tracing::info!(
            message_id = %email.message_id,
            account = %account.account_id,
            "[Store] Duplicate skipped"
        );
        return Ok(None);
    }
    let message_id = format!("msg_{}", nanoid());
    let mut recipients = vec![account.account_email.clone()];
    recipients.extend(collect_recipient_emails(email));
    let spam = score_inbound_spam(
        &SpamInput {
            from: Some(&email.from),
            to: &email.to,
            subject: Some(&email.subject),
            text_body: email.text_body.as_deref(),
            html_body: email.html_body.as_deref(),
            headers: &email.headers,
            spf_status: email.spf_status.as_deref(),
            dkim_status: email.dkim_status.as_deref(),
            dmarc_status: email.dmarc_status.as_deref(),
        },
        &SpamOptions {
            attachment_names: attachment_names.to_vec(),
            is_existing_ham_thread: resolved.is_existing_ham_thread,
            recipient_emails: Some(recipients),
        },
    );
    tracing::info!(
        message_id,
        score = spam.score,
        is_spam = spam.is_spam,
        reasons = %spam.reasons.join(", "),
        "[Spam] scored"
    );
    let is_promotion = if spam.is_spam {
        false
    } else {
        let promotion = classify_promotion(
            &PromotionInput {
                subject: Some(&email.subject),
                text_body: email.text_body.as_deref(),
                html_body: email.html_body.as_deref(),
                headers: &email.headers,
            },
            email.is_reply(),
        );
        tracing::info!(
            message_id,
            score = promotion.score,
            is_promotion = promotion.is_promotion,
            reasons = %promotion.reasons.join(", "),
            "[Promotion] classified"
        );
        promotion.is_promotion
    };

    let mut html = email.html_body.clone();
    let mut inputs = Vec::new();
    if email.has_attachments && !attachments.is_empty() && ctx.storage.is_some() {
        let (built, cids) =
            build_attachment_inputs(ctx, &account.workspace_id, &message_id, attachments).await;
        inputs = built;
        if let Some(rewritten) = rewrite_cid_references(email.html_body.as_deref(), &cids) {
            html = Some(rewritten);
        }
    }
    let labels = inbound_labels(spam.is_spam, is_promotion);
    let subscription = if spam.is_spam {
        None
    } else {
        subscription_values(email)
    };
    let received_ms = weldsuite_mail_domain::outbound::clock::now_ms();
    let thread_id = ingest(
        db,
        &account.account_id,
        &message_id,
        &resolved.thread_id,
        email,
        html.as_deref(),
        &labels,
        spam.is_spam,
        &inputs,
        subscription.as_ref(),
        received_ms,
    )
    .await?;
    tracing::info!(message_id, thread_id, account = %account.account_id, "[Store] Saved email");

    if let Some(bucket) = &ctx.mail_storage
        && !email.raw.is_empty()
    {
        let key = format!(
            "mail/{}/{}/{message_id}/raw.eml",
            account.workspace_id, account.account_id
        );
        if let Err(error) = bucket
            .put_boxed(
                &key,
                email.raw.clone(),
                &PutOptions::content_type("message/rfc822"),
            )
            .await
        {
            tracing::warn!(%error, message_id, "[Store] Failed to write raw MIME");
        }
    }
    Ok(Some(Stored {
        message_id,
        thread_id,
        is_spam: spam.is_spam,
        is_promotion,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_and_cids() {
        assert_eq!(sanitize_file_name("a b/ü.pdf"), "a_b__.pdf");
        assert_eq!(
            rewrite_cid_references(
                Some("<img src=\"cid:logo@x\">"),
                &[("logo@x".to_owned(), "https://s/x".to_owned())]
            )
            .as_deref(),
            Some("<img src=\"https://s/x\">")
        );
        assert_eq!(
            rewrite_cid_references(Some("<p>x</p>"), &[("a".to_owned(), "b".to_owned())]),
            None
        );
        assert_eq!(inbound_labels(true, true), ["SPAM"]);
    }
}
