//! Storing one inbound message in one workspace mailbox (`storeEmail`), in
//! the Postgres mailbox store the Kubernetes editions run (MAIL-010):
//! duplicate and thread resolution (`resolveInbound`), spam and promotion
//! scoring, attachments to the bucket, the `ingest` op (message row,
//! attachment rows, the subscription upsert) and the raw MIME to the mail
//! bucket.

use sea_orm::sea_query::{Expr, Func, OnConflict};
use sea_orm::{
    ActiveEnum, ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_ports::PutOptions;
use weldsuite_schema::tenant::enums::MailSecurityStatus;
use weldsuite_schema::tenant::{mail_attachments, mail_messages, mail_subscriptions};

use crate::context::InboundContext;
use crate::parsed::{ParsedAttachment, ParsedEmail};
use crate::promotion::{PromotionInput, classify_promotion};
use crate::recipients::{RecipientAccount, collect_recipient_emails};
use crate::spam::{SpamInput, SpamOptions, score_inbound_spam};
use crate::thread_match::{
    bare_subject, conversation_subjects, has_reply_prefix, involves_address, message_id_variants,
    provider_message_ids,
};
use crate::threats::{AttachmentScan, MessageThreats};
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
) -> Result<Option<(String, bool)>, DbErr> {
    use mail_messages::Column as M;
    let lookup = reply_lookup_ids(email);
    if lookup.is_empty() {
        return Ok(None);
    }
    let providers = provider_message_ids(&lookup);
    let mut ids = Condition::any()
        .add(M::MessageId.is_in(lookup.clone()))
        .add(M::ExternalMessageId.is_in(lookup));
    // `mailcow_message_id = any('{}')` matches nothing.
    if !providers.is_empty() {
        ids = ids.add(M::MailcowMessageId.is_in(providers));
    }
    let row: Option<(Option<String>, Option<bool>)> = mail_messages::Entity::find()
        .select_only()
        .columns([M::ThreadId, M::IsSpam])
        .filter(M::AccountId.eq(account_id))
        .filter(ids)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.and_then(|(thread, is_spam)| {
        thread
            .filter(|t| !t.is_empty())
            .map(|t| (t, is_spam == Some(false)))
    }))
}

/// A thread candidate as read: thread, spam flag, from, to, cc.
type SubjectRow = (Option<String>, Option<bool>, Value, Value, Option<Value>);

/// `findThreadBySubject`: the sender must already take part in the thread,
/// so two strangers' `Re: Hello` stay apart and a spoofer's `Re: Invoice`
/// never joins (or inherits the spam cap of) a real conversation.
async fn find_thread_by_subject(
    db: &PgPool,
    account_id: &str,
    email: &ParsedEmail,
) -> Result<Option<(String, bool)>, DbErr> {
    use mail_messages::Column as M;
    let subjects = conversation_subjects(Some(&email.subject));
    if subjects.is_empty() {
        return Ok(None);
    }
    let rows: Vec<SubjectRow> = mail_messages::Entity::find()
        .select_only()
        .columns([M::ThreadId, M::IsSpam, M::From, M::To, M::Cc])
        .filter(M::AccountId.eq(account_id))
        .filter(sea_orm::ExprTrait::is_in(
            Expr::expr(Func::lower(M::Subject.into_expr())),
            subjects,
        ))
        .filter(M::DeletedAt.is_null())
        .order_by_desc(M::SentDate)
        .limit(20)
        .into_tuple()
        .all(&orm(db))
        .await?;
    let found = rows.into_iter().find(|(thread, _, from, to, cc)| {
        thread.as_deref().is_some_and(|t| !t.is_empty())
            && involves_address(
                from,
                to,
                cc.as_ref().unwrap_or(&Value::Null),
                Some(&email.from.email),
            )
    });
    Ok(found.and_then(|(thread, is_spam, ..)| thread.map(|t| (t, is_spam == Some(false)))))
}

/// `resolveInbound(db, accountId, query)` (`store/postgres/inbound.ts`).
pub async fn resolve_inbound(
    db: &PgPool,
    account_id: &str,
    email: &ParsedEmail,
) -> Result<ResolvedThread, DbErr> {
    use mail_messages::Column as M;
    if !email.message_id.is_empty() {
        // `external_message_id` too: a SENT copy keeps there the id of the
        // copy Cloudflare delivered back to this mailbox (`sentCopyMessageIds`).
        let existing: Option<(String, Option<String>)> = mail_messages::Entity::find()
            .select_only()
            .columns([M::Id, M::ThreadId])
            .filter(M::AccountId.eq(account_id))
            .filter(
                Condition::any()
                    .add(M::MessageId.eq(&email.message_id))
                    .add(M::ExternalMessageId.eq(&email.message_id)),
            )
            .into_tuple()
            .one(&orm(db))
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
            && let Some(hit) = find_thread_by_subject(db, account_id, email).await?
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
    if let Some(hit) = find_thread_by_subject(db, account_id, email).await? {
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
    /// Which parsed attachment it is.
    index: usize,
    id: String,
    file_name: String,
    content_type: String,
    size: usize,
    /// `None` for an infected file, which is never stored.
    storage_path: Option<String>,
    /// `None` for a file that is not served from the public bucket.
    download_url: Option<String>,
    scan: AttachmentScan,
}

/// Where a pending attachment waits for the rescan: the private mail
/// bucket, next to the message's raw MIME, never the public one.
pub fn quarantine_key(
    workspace_id: &str,
    account_id: &str,
    message_id: &str,
    index: usize,
    file_name: &str,
) -> String {
    format!(
        "mail/{workspace_id}/{account_id}/{message_id}/quarantine/{}_{}",
        index + 1,
        sanitize_file_name(file_name)
    )
}

/// A pending attachment into the mail bucket at `key`: the key when it is
/// there, `None` (logged) when it could not be put anywhere. The row is
/// written either way; the rescan marks one without a copy `error`.
async fn quarantine(
    ctx: &InboundContext,
    key: String,
    att: &ParsedAttachment,
    content_type: String,
    index: usize,
) -> Option<String> {
    let Some(bucket) = &ctx.mail_storage else {
        tracing::error!(
            index = index + 1,
            "[Store] No mail bucket to quarantine an attachment in"
        );
        return None;
    };
    match bucket
        .put_boxed(
            &key,
            att.content.clone(),
            &PutOptions::content_type(content_type),
        )
        .await
    {
        Ok(_) => Some(key),
        Err(error) => {
            tracing::error!(%error, index = index + 1, "[Store] Failed to quarantine attachment");
            None
        }
    }
}

/// `buildWorkspaceAttachmentInputs`: each attachment to `STORAGE`, its row,
/// and the `cid:` map for the HTML. An infected file goes nowhere and a
/// pending one to [`quarantine_key`] ([`crate::threats`]); neither gets a
/// `cid:` mapping.
async fn build_attachment_inputs(
    ctx: &InboundContext,
    account: &RecipientAccount,
    message_id: &str,
    attachments: &[ParsedAttachment],
    threats: &MessageThreats,
) -> (Vec<AttachmentInput>, Vec<(String, String)>) {
    let workspace_id = account.workspace_id.as_str();
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
        let scan = threats.attachment(i).clone();
        let mut input = AttachmentInput {
            index: i,
            id: weldsuite_kit::generate_id("attach"),
            file_name: att.file_name.clone(),
            content_type: content_type.clone(),
            size: att.content.len(),
            storage_path: None,
            download_url: None,
            scan: scan.clone(),
        };
        match scan {
            AttachmentScan::Infected { .. } => {
                tracing::warn!(index = i + 1, file = %att.file_name, "[Store] Infected attachment not stored");
                inputs.push(input);
                continue;
            }
            AttachmentScan::Pending => {
                let key = quarantine_key(
                    workspace_id,
                    &account.account_id,
                    message_id,
                    i,
                    &att.file_name,
                );
                input.storage_path = quarantine(ctx, key, att, content_type, i).await;
                inputs.push(input);
                continue;
            }
            _ => {}
        }
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
        input.storage_path = Some(key);
        input.download_url = Some(download_url);
        inputs.push(input);
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
    now: time::PrimitiveDateTime,
) -> Result<(), DbErr> {
    use mail_subscriptions::Column as S;
    use sea_orm::ExprTrait as _;
    let received = timestamp(values.received_at);
    // The row as it is: `mail_subscriptions.<column>`.
    let current = |column: S| Expr::col((mail_subscriptions::Entity, column));
    let row = mail_subscriptions::ActiveModel {
        id: Set(weldsuite_kit::generate_id("msub")),
        account_id: Set(account_id.to_owned()),
        sender_email: Set(values.sender_email.clone()),
        sender_name: Set(values.sender_name.clone()),
        sender_domain: Set(values.sender_domain.clone()),
        list_id: Set(values.list_id.clone()),
        unsubscribe_url: Set(values.unsubscribe_url.clone()),
        unsubscribe_mailto: Set(values.unsubscribe_mailto.clone()),
        one_click: Set(values.one_click),
        message_count: Set(1),
        last_subject: Set(values.last_subject.clone()),
        first_received_at: Set(received),
        last_received_at: Set(received),
        ..Default::default()
    };
    let merge = OnConflict::columns([S::AccountId, S::SenderEmail])
        .value(
            S::SenderName,
            Func::coalesce([
                Expr::val(values.sender_name.clone()),
                current(S::SenderName),
            ]),
        )
        .value(
            S::ListId,
            Func::coalesce([Expr::val(values.list_id.clone()), current(S::ListId)]),
        )
        .value(S::UnsubscribeUrl, Expr::val(values.unsubscribe_url.clone()))
        .value(
            S::UnsubscribeMailto,
            Expr::val(values.unsubscribe_mailto.clone()),
        )
        .value(S::OneClick, Expr::val(values.one_click))
        .value(S::MessageCount, current(S::MessageCount).add(1))
        .value(S::LastSubject, Expr::val(values.last_subject.clone()))
        .value(
            S::LastReceivedAt,
            Func::greatest([current(S::LastReceivedAt), Expr::val(received)]),
        )
        .value(S::UpdatedAt, Expr::val(now))
        .to_owned();
    mail_subscriptions::Entity::insert(row)
        .on_conflict(merge)
        .exec_without_returning(&orm(db))
        .await?;
    Ok(())
}

/// `toSecurityStatusValue`: only the enum's values reach the column.
fn security(value: Option<&String>) -> Option<MailSecurityStatus> {
    value.and_then(|v| MailSecurityStatus::try_from_value(v).ok())
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
    threats: Option<&Value>,
    subscription: Option<&SubscriptionValues>,
    received_ms: i64,
) -> Result<String, DbErr> {
    let now = timestamp(weldsuite_mail_domain::outbound::clock::now_ms());
    let received = timestamp(received_ms);
    let sent = timestamp(email.received_at);
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
    let conn = orm(db);
    let row = mail_messages::ActiveModel {
        id: Set(message_id.to_owned()),
        account_id: Set(account_id.to_owned()),
        message_id: Set(email.message_id.clone()),
        thread_id: Set(Some(thread_id.to_owned())),
        from: Set(from),
        to: Set(Value::from(to)),
        cc: Set(Some(Value::from(cc))),
        subject: Set(Some(email.subject.clone())),
        preview: Set(Some(preview(email))),
        text_body: Set(email.text_body.clone()),
        html_body: Set(html.map(str::to_owned)),
        sent_date: Set(sent),
        received_date: Set(Some(received)),
        is_read: Set(false),
        labels: Set(Some(json!(labels))),
        is_spam: Set(Some(is_spam)),
        is_starred: Set(Some(labels.iter().any(|l| l == "STARRED"))),
        is_important: Set(Some(labels.iter().any(|l| l == "IMPORTANT"))),
        is_trash: Set(Some(labels.iter().any(|l| l == "TRASH"))),
        in_reply_to: Set(email.in_reply_to.clone()),
        references: Set(Some(json!(references))),
        is_reply: Set(Some(email.is_reply())),
        spf_status: Set(security(email.spf_status.as_ref())),
        dkim_status: Set(security(email.dkim_status.as_ref())),
        dmarc_status: Set(security(email.dmarc_status.as_ref())),
        source: Set(Some("inbound".to_owned())),
        has_attachments: Set(!attachments.is_empty()),
        attachment_count: Set(Some(i32::try_from(attachments.len()).unwrap_or(i32::MAX))),
        created_at: Set(received),
        updated_at: Set(now),
        threats: Set(threats.cloned()),
        ..Default::default()
    };
    // `on conflict (id) do nothing`: a lost race on the id reports the row
    // already there.
    let inserted = mail_messages::Entity::insert(row)
        .on_conflict(
            OnConflict::column(mail_messages::Column::Id)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(&conn)
        .await?;
    if inserted == 0 {
        let existing: Option<Option<String>> = mail_messages::Entity::find()
            .select_only()
            .column(mail_messages::Column::ThreadId)
            .filter(mail_messages::Column::Id.eq(message_id))
            .into_tuple()
            .one(&conn)
            .await?;
        return Ok(existing.flatten().unwrap_or_else(|| message_id.to_owned()));
    }
    insert_attachment_rows(db, message_id, attachments, received_ms).await?;
    if let Some(values) = subscription {
        upsert_subscription(db, account_id, values, now).await?;
    }
    Ok(thread_id.to_owned())
}

/// `ms` since the epoch as the timestamp columns take it (UTC).
pub(crate) fn timestamp(ms: i64) -> time::PrimitiveDateTime {
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    time::PrimitiveDateTime::new(at.date(), at.time())
}

/// The ingest's attachment rows, with their scan.
async fn insert_attachment_rows(
    db: &PgPool,
    message_id: &str,
    attachments: &[AttachmentInput],
    at_ms: i64,
) -> Result<(), DbErr> {
    if attachments.is_empty() {
        return Ok(());
    }
    let at = timestamp(at_ms);
    let rows = attachments.iter().map(|att| mail_attachments::ActiveModel {
        id: Set(att.id.clone()),
        message_id: Set(message_id.to_owned()),
        file_name: Set(att.file_name.clone()),
        content_type: Set(Some(att.content_type.clone())),
        size: Set(i32::try_from(att.size).unwrap_or(i32::MAX)),
        is_inline: Set(Some(false)),
        storage_path: Set(att.storage_path.clone()),
        download_url: Set(att.download_url.clone()),
        scan_status: Set(att.scan.status().map(str::to_owned)),
        scan_signature: Set(att.scan.signature().map(str::to_owned)),
        scanned_at: Set((!matches!(
            att.scan,
            AttachmentScan::NotScanned | AttachmentScan::Pending
        ))
        .then_some(at)),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    });
    mail_attachments::Entity::insert_many(rows)
        .exec_without_returning(&orm(db))
        .await?;
    Ok(())
}

/// `storeEmail(env, account, email, attachmentNames, attachments, mailbox)`
/// for a workspace mailbox: the stored message, or `None` for a duplicate
/// (or a failure, which is logged, as the worker does). `threats` is what
/// [`crate::threats::inspect`] found in the message.
pub async fn store_email(
    ctx: &InboundContext,
    db: &PgPool,
    account: &RecipientAccount,
    email: &ParsedEmail,
    attachment_names: &[String],
    attachments: &[ParsedAttachment],
    threats: &MessageThreats,
) -> Option<Stored> {
    match store(
        ctx,
        db,
        account,
        email,
        attachment_names,
        attachments,
        threats,
    )
    .await
    {
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
    threats: &MessageThreats,
) -> Result<Option<Stored>, DbErr> {
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
    // An infected file or a malicious link sends the message to Spam,
    // whatever its spam score (`crate::threats`).
    let dangerous = threats.is_dangerous();
    if dangerous && !spam.is_spam {
        tracing::info!(message_id, reasons = %threats.reasons().join(", "), "[Threats] moved to Spam");
    }
    let is_spam = spam.is_spam || dangerous;
    let is_promotion = if is_spam {
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
            build_attachment_inputs(ctx, account, &message_id, attachments, threats).await;
        inputs = built;
        if let Some(rewritten) = rewrite_cid_references(email.html_body.as_deref(), &cids) {
            html = Some(rewritten);
        }
    }
    let mut ids: Vec<Option<String>> = vec![None; attachments.len()];
    for input in &inputs {
        if let Some(slot) = ids.get_mut(input.index) {
            *slot = Some(input.id.clone());
        }
    }
    let threats_json = threats.to_json(attachments, &ids);
    let labels = inbound_labels(is_spam, is_promotion);
    let subscription = if is_spam {
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
        is_spam,
        &inputs,
        threats_json.as_ref(),
        subscription.as_ref(),
        received_ms,
    )
    .await?;
    tracing::info!(message_id, thread_id, account = %account.account_id, "[Store] Saved email");
    if inputs.iter().any(|i| i.scan == AttachmentScan::Pending) {
        // The rescan picks the pending files up once the scanner is back.
        let due = time::OffsetDateTime::now_utc() + crate::rescan::FIRST_RETRY;
        weldsuite_db::due_index::mark_due(
            &ctx.master,
            crate::rescan::RESCAN_KIND,
            &account.workspace_id,
            due,
        )
        .await;
    }

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
        is_spam,
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
