//! Personal WeldMail's send path (`services/mail-send.ts`) and its error
//! mapping (`lib/send-errors.ts`): the plan's daily limit, idempotency, the
//! sanitised HTML, the outbound guard (ledger key `personal:<accountId>`, no
//! correspondents table, so no tenant database), the transport, and the
//! SENT copy stitched into its thread. Compose, reply, forward and the
//! unsubscribe mail all go through [`send_and_persist`].

use std::sync::Arc;

use axum::response::{IntoResponse, Response};
use http::{HeaderValue, StatusCode};
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::ApiError;
use weldsuite_mail_domain::outbound::{
    CheckOutboundInput, DenialCode, GuardedSendError, OutboundGuard, OutboundKind, Refusal,
    SendEmailParams, SentRecipients, SubjectInput, TransmitError, guarded_send,
    trip_platform_breaker,
};
use weldsuite_ports::MailTransport;

use crate::caller::{Caller, error_response, plan_limit};
use crate::js::{iso, js_trim, now_iso, now_ms, utf16_prefix};
use crate::session::Entitlements;

/// `PersonalMailSendError`, or a failure the routes' catch answers 500.
#[derive(Debug)]
pub(crate) enum SendError {
    Mail {
        code: String,
        message: String,
        details: Option<Value>,
        /// The recipients that had it when the send failed (a partial send).
        sent: Vec<String>,
    },
    Internal(String),
}

impl SendError {
    fn mail(code: &str, message: impl Into<String>, details: Option<Value>) -> Self {
        Self::Mail {
            code: code.to_owned(),
            message: message.into(),
            details,
            sent: Vec::new(),
        }
    }

    /// The error's message, as `err.message` reads it.
    pub(crate) fn message(&self) -> &str {
        match self {
            Self::Mail { message, .. } | Self::Internal(message) => message,
        }
    }
}

impl From<sqlx::Error> for SendError {
    fn from(error: sqlx::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

impl SentRecipients for SendError {
    fn sent_recipients(&self) -> &[String] {
        match self {
            Self::Mail { sent, .. } => sent,
            Self::Internal(_) => &[],
        }
    }
}

/// What a send reaches: the personal database, the guard over the master
/// registry and the ledgers, the transport, and whose send it is.
pub(crate) struct SendContext<'a> {
    pub(crate) db: &'a PgPool,
    pub(crate) guard: OutboundGuard,
    pub(crate) transport: Option<Arc<dyn MailTransport>>,
    pub(crate) personal_account_id: &'a str,
    pub(crate) entitlements: &'a Entitlements,
}

impl<'a> SendContext<'a> {
    pub(crate) fn new(caller: &'a Caller, db: &'a PgPool, personal_account_id: &'a str) -> Self {
        Self {
            db,
            guard: caller.outbound.guard(caller.master.clone(), None),
            transport: caller.outbound.transport.clone(),
            personal_account_id,
            entitlements: &caller.entitlements,
        }
    }
}

/// `SendComposeInput`.
#[derive(Debug, Clone, Default)]
pub(crate) struct Compose {
    pub(crate) account_id: String,
    pub(crate) to: Vec<String>,
    pub(crate) cc: Vec<String>,
    pub(crate) bcc: Vec<String>,
    pub(crate) subject: String,
    pub(crate) text_body: Option<String>,
    pub(crate) html_body: Option<String>,
    pub(crate) in_reply_to: Option<String>,
    pub(crate) references: Option<Vec<String>>,
    pub(crate) thread_id: Option<String>,
    pub(crate) idempotency_key: Option<String>,
    /// `outbound.source` (default `personal`) and `outbound.kind`.
    pub(crate) source: Option<&'static str>,
    pub(crate) kind: Option<OutboundKind>,
}

/// `bracket(messageId)`: one leading `<` and one trailing `>` dropped, then
/// both put back.
pub(crate) fn bracket(message_id: &str) -> String {
    let bare = message_id.strip_prefix('<').unwrap_or(message_id);
    let bare = bare.strip_suffix('>').unwrap_or(bare);
    format!("<{bare}>")
}

/// `tagsToSpaces(html)`: every `<…>` tag a space; a bare `<>` stays.
fn tags_to_spaces(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut pos = 0;
    let mut from = 0;
    while let Some(lt) = html[from..].find('<').map(|i| from + i) {
        let Some(gt) = html[lt + 1..].find('>').map(|i| lt + 1 + i) else {
            break;
        };
        from = gt + 1;
        if gt == lt + 1 {
            continue;
        }
        out.push_str(&html[pos..lt]);
        out.push(' ');
        pos = gt + 1;
    }
    out.push_str(&html[pos..]);
    out
}

/// `plainTextOf(htmlBody)`: the visible text, white space collapsed.
fn plain_text_of(html: Option<&str>) -> Option<String> {
    let html = html.filter(|h| !h.is_empty())?;
    let spaced = tags_to_spaces(html);
    let mut out = String::with_capacity(spaced.len());
    let mut in_space = false;
    for c in spaced.chars() {
        if crate::js::is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    Some(js_trim(&out).to_owned())
}

/// `previewFrom(textBody, htmlBody)`: the first 500 characters.
fn preview_from(text: Option<&str>, html: Option<&str>) -> Option<String> {
    let trimmed = text.map(js_trim).filter(|t| !t.is_empty());
    let raw = match trimmed {
        Some(text) => text.to_owned(),
        None => plain_text_of(html)
            .filter(|t| !t.is_empty())
            .unwrap_or_default(),
    };
    (!raw.is_empty()).then(|| utf16_prefix(&raw, 500))
}

/// `requireAccount(db, personalAccountId, accountId)`.
pub(crate) async fn require_account(
    db: &PgPool,
    personal_account_id: &str,
    account_id: &str,
) -> Result<Value, SendError> {
    let found: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from personal_mail_accounts a
         where a.id = $1 and a.personal_account_id = $2 and a.deleted_at is null limit 1",
    )
    .bind(account_id)
    .bind(personal_account_id)
    .fetch_optional(db)
    .await?;
    found.map(weldsuite_db::js_row).ok_or_else(|| {
        SendError::mail(
            "ACCOUNT_NOT_FOUND",
            format!("Mail account '{account_id}' not found"),
            None,
        )
    })
}

/// `requireMessage(db, personalAccountId, messageId)`.
pub(crate) async fn require_message(
    db: &PgPool,
    personal_account_id: &str,
    message_id: &str,
) -> Result<Value, SendError> {
    let found: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from personal_mail_messages m
         where m.id = $1 and m.personal_account_id = $2 and m.deleted_at is null limit 1",
    )
    .bind(message_id)
    .bind(personal_account_id)
    .fetch_optional(db)
    .await?;
    found.map(weldsuite_db::js_row).ok_or_else(|| {
        SendError::mail(
            "MESSAGE_NOT_FOUND",
            format!("Message '{message_id}' not found"),
            None,
        )
    })
}

async fn find_by_idempotency_key(
    db: &PgPool,
    account_id: &str,
    key: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let found: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from personal_mail_messages m
         where m.account_id = $1 and m.idempotency_key = $2 limit 1",
    )
    .bind(account_id)
    .bind(key)
    .fetch_optional(db)
    .await?;
    Ok(found.map(weldsuite_db::js_row))
}

/// `countSentToday(db, accountId)`: composed sends since UTC midnight.
async fn count_sent_today(db: &PgPool, account_id: &str) -> Result<i64, sqlx::Error> {
    let day_ms = 24 * 60 * 60 * 1000;
    let day_start = iso(now_ms().div_euclid(day_ms) * day_ms);
    sqlx::query_scalar(
        "select count(*)::int8 from personal_mail_messages
         where account_id = $1 and source = 'composed' and sent_date >= $2::timestamp
           and deleted_at is null",
    )
    .bind(account_id)
    .bind(day_start)
    .fetch_one(db)
    .await
}

/// `resolveThreadId(db, accountId, input, fallback)`.
async fn resolve_thread_id(
    db: &PgPool,
    account_id: &str,
    input: &Compose,
    fallback: &str,
) -> Result<String, sqlx::Error> {
    if let Some(thread) = input.thread_id.as_deref().filter(|t| !t.is_empty()) {
        return Ok(thread.to_owned());
    }
    let mut lookup: Vec<String> = Vec::new();
    if let Some(parent) = input.in_reply_to.as_deref().filter(|p| !p.is_empty()) {
        lookup.push(bracket(parent));
    }
    lookup.extend(input.references.iter().flatten().map(|r| bracket(r)));
    if lookup.is_empty() {
        return Ok(fallback.to_owned());
    }
    let parent: Option<Option<String>> = sqlx::query_scalar(
        "select thread_id from personal_mail_messages
         where account_id = $1 and (message_id = any($2::text[]) or thread_id = any($2::text[]))
         limit 1",
    )
    .bind(account_id)
    .bind(&lookup)
    .fetch_optional(db)
    .await?;
    Ok(parent
        .flatten()
        .filter(|t| !t.is_empty())
        .or_else(|| lookup.first().cloned().filter(|l| !l.is_empty()))
        .unwrap_or_else(|| fallback.to_owned()))
}

/// `outboundKindOf(db, accountId, input)`: `reply` only for a message
/// someone sent to this mailbox.
async fn outbound_kind_of(
    db: &PgPool,
    account_id: &str,
    input: &Compose,
) -> Result<OutboundKind, sqlx::Error> {
    let Some(parent) = input.in_reply_to.as_deref().filter(|p| !p.is_empty()) else {
        return Ok(OutboundKind::NewThread);
    };
    let found: Option<Option<String>> = sqlx::query_scalar(
        "select source from personal_mail_messages
         where account_id = $1 and message_id = $2 and deleted_at is null limit 1",
    )
    .bind(account_id)
    .bind(bracket(parent))
    .fetch_optional(db)
    .await?;
    Ok(match found {
        Some(source) if source.as_deref() != Some("composed") => OutboundKind::Reply,
        _ => OutboundKind::NewThread,
    })
}

/// What `deliver` hands back: the provider's message id and whether a
/// recipient must verify first.
struct Delivered {
    message_id: String,
    pending_verification: bool,
}

/// `deliveryFailure(env, input, err)`.
async fn delivery_failure(
    guard: &OutboundGuard,
    input: &Compose,
    error: TransmitError,
) -> SendError {
    let sent = error.sent_recipients().to_vec();
    let refusal = match &error {
        TransmitError::Refused { refusal, .. } => Some(*refusal),
        _ => None,
    };
    if refusal == Some(Refusal::DailyLimit) {
        trip_platform_breaker(
            guard,
            "Cloudflare refused a send with E_DAILY_LIMIT_EXCEEDED.",
        )
        .await;
    }
    if !sent.is_empty() {
        let everyone: Vec<&String> = input.to.iter().chain(&input.cc).chain(&input.bcc).collect();
        let lower: Vec<String> = sent.iter().map(|r| r.to_lowercase()).collect();
        let failed: Vec<&String> = everyone
            .iter()
            .copied()
            .filter(|r| !lower.contains(&r.to_lowercase()))
            .collect();
        return SendError::Mail {
            code: "PARTIALLY_SENT".to_owned(),
            message: format!("Sent to {} of {} recipients.", sent.len(), everyone.len()),
            details: Some(json!({ "sent": sent, "failed": failed })),
            sent,
        };
    }
    match refusal {
        Some(Refusal::RateLimited) => SendError::mail(
            "PROVIDER_RATE_LIMITED",
            "Outbound mail is being rate-limited. Try again in a minute.",
            None,
        ),
        Some(Refusal::DailyLimit) => SendError::mail(
            "PROVIDER_DAILY_LIMIT",
            "Outbound mail is unavailable for the rest of the day. Try again later.",
            None,
        ),
        _ => SendError::mail("DELIVERY_FAILED", error.to_string(), None),
    }
}

/// `deliver(env, fromHeader, input, htmlBody)`: the personal worker's
/// `sendEmail` over the transport.
async fn deliver(
    ctx: &SendContext<'_>,
    from_header: &str,
    input: &Compose,
    html: Option<&str>,
) -> Result<Delivered, SendError> {
    let Some(transport) = ctx.transport.as_ref() else {
        return Err(SendError::mail(
            "DELIVERY_FAILED",
            "SEND_EMAIL binding missing — wrangler [[send_email]] not configured",
            None,
        ));
    };
    if input.to.len() + input.cc.len() + input.bcc.len() == 0 {
        return Err(SendError::mail(
            "DELIVERY_FAILED",
            "sendEmail: no recipients",
            None,
        ));
    }
    let mut headers = Vec::new();
    if let Some(parent) = input.in_reply_to.as_deref().filter(|p| !p.is_empty()) {
        headers.push(("In-Reply-To".to_owned(), parent.to_owned()));
    }
    if let Some(references) = input.references.as_ref().filter(|r| !r.is_empty()) {
        headers.push(("References".to_owned(), references.join(" ")));
    }
    let params = SendEmailParams {
        from: from_header.to_owned(),
        to: input.to.clone(),
        cc: input.cc.clone(),
        bcc: input.bcc.clone(),
        subject: input.subject.clone(),
        text: input.text_body.clone(),
        html: html.map(str::to_owned),
        headers,
        ..SendEmailParams::default()
    };
    match weldsuite_mail_domain::outbound::send_email(transport.as_ref(), &params).await {
        Ok(sent) => Ok(Delivered {
            message_id: sent.message_id,
            pending_verification: sent.pending_verification,
        }),
        Err(error) => Err(delivery_failure(&ctx.guard, input, error).await),
    }
}

/// `sendAndPersist(env, db, personalAccountId, entitlements, input)`: the
/// SENT copy, and whether a recipient must verify first.
pub(crate) async fn send_and_persist(
    ctx: &SendContext<'_>,
    input: &Compose,
) -> Result<(Value, bool), SendError> {
    let db = ctx.db;
    let account = require_account(db, ctx.personal_account_id, &input.account_id).await?;
    let account_id = account["id"].as_str().unwrap_or_default().to_owned();
    if input.to.len() + input.cc.len() + input.bcc.len() == 0 {
        return Err(SendError::mail(
            "NO_RECIPIENTS",
            "At least one recipient is required",
            None,
        ));
    }
    if let Some(key) = input.idempotency_key.as_deref().filter(|k| !k.is_empty())
        && let Some(prior) = find_by_idempotency_key(db, &account_id, key).await?
    {
        return Ok((prior, false));
    }
    let limit = ctx.entitlements.daily_send_limit();
    if count_sent_today(db, &account_id).await? >= limit {
        return Err(SendError::mail(
            "DAILY_LIMIT_REACHED",
            format!("Daily send limit of {limit} reached. Upgrade to Pro for a higher limit."),
            Some(json!({ "plan": ctx.entitlements.plan(), "dailySendLimit": limit })),
        ));
    }
    let html = Some(weldsuite_mail_domain::html::sanitize_email_html(
        input.html_body.as_deref(),
    ))
    .filter(|h| !h.is_empty());

    // `guardedDeliver`: the From header, the guard's input, the transmit.
    let email = account["email"].as_str().unwrap_or_default().to_owned();
    let display_name = account["displayName"].as_str().filter(|n| !n.is_empty());
    let from_header = match display_name {
        Some(name) => format!("\"{name}\" <{email}>"),
        None => email.clone(),
    };
    let kind = match input.kind {
        Some(kind) => kind,
        None => outbound_kind_of(db, &account_id, input).await?,
    };
    let mut check = CheckOutboundInput::new(
        SubjectInput::Personal {
            personal_account_id: ctx.personal_account_id.to_owned(),
            plan: ctx.entitlements.plan().to_owned(),
        },
        input.source.unwrap_or("personal"),
        kind,
        &email,
        input.to.clone(),
    );
    check.cc = input.cc.clone();
    check.bcc = input.bcc.clone();
    check.subject_line = Some(input.subject.clone());
    check.text = input
        .text_body
        .clone()
        .or_else(|| plain_text_of(html.as_deref()));
    check.html = html.clone();
    let delivered = match guarded_send(&ctx.guard, None, &check, || {
        deliver(ctx, &from_header, input, html.as_deref())
    })
    .await
    {
        Ok(delivered) => delivered,
        Err(GuardedSendError::Denied(denied)) => {
            return Err(SendError::mail(
                denied.code().as_str(),
                denied.message(),
                Some(denied.details.to_json()),
            ));
        }
        Err(GuardedSendError::Send(error)) => return Err(error),
    };

    let message_id = if delivered.message_id.contains('@') {
        bracket(&delivered.message_id)
    } else {
        format!("<{}@weldmail.com>", delivered.message_id)
    };
    let thread_id = resolve_thread_id(db, &account_id, input, &message_id).await?;
    let addresses = |list: &[String]| -> Option<Value> {
        (!list.is_empty())
            .then(|| Value::Array(list.iter().map(|e| json!({ "email": e })).collect()))
    };
    let name = account["displayName"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| account["name"].as_str().map(str::to_owned));
    let now = now_iso();
    let inserted: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "insert into personal_mail_messages
           (id, personal_account_id, account_id, message_id, thread_id, \"from\", \"to\", cc, bcc,
            subject, preview, text_body, html_body, sent_date, received_date, is_read, is_starred,
            is_draft, is_spam, is_trash, has_attachments, in_reply_to, \"references\", is_reply,
            labels, send_status, send_provider, provider_message_id, source, idempotency_key,
            created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13,
                 $14::timestamp, $14::timestamp, true, false, false, false, false, false, $15,
                 $16::jsonb, $17, '[\"SENT\"]'::jsonb, $18, 'cloudflare', $19, 'composed', $20,
                 $14::timestamp, $14::timestamp)
         returning to_jsonb(personal_mail_messages)",
    )
    .bind(weldsuite_kit::generate_id("msg"))
    .bind(ctx.personal_account_id)
    .bind(&account_id)
    .bind(&message_id)
    .bind(&thread_id)
    .bind(json!({ "email": email, "name": name }))
    .bind(addresses(&input.to).unwrap_or_else(|| json!([])))
    .bind(addresses(&input.cc))
    .bind(addresses(&input.bcc))
    .bind(&input.subject)
    .bind(preview_from(input.text_body.as_deref(), html.as_deref()))
    .bind(&input.text_body)
    .bind(&html)
    .bind(&now)
    .bind(
        input
            .in_reply_to
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(bracket),
    )
    .bind(
        input
            .references
            .as_ref()
            .map(|r| Value::Array(r.iter().map(|id| Value::String(bracket(id))).collect())),
    )
    .bind(input.in_reply_to.as_deref().is_some_and(|p| !p.is_empty()))
    .bind(if delivered.pending_verification {
        "pending_verification"
    } else {
        "sent"
    })
    .bind(&delivered.message_id)
    .bind(&input.idempotency_key)
    .fetch_one(db)
    .await;
    let message = match inserted {
        Ok(row) => weldsuite_db::js_row(row),
        Err(error) => {
            // A concurrent send with the same key won the unique-index race.
            if let Some(key) = input.idempotency_key.as_deref().filter(|k| !k.is_empty())
                && let Some(prior) = find_by_idempotency_key(db, &account_id, key).await?
            {
                return Ok((prior, delivered.pending_verification));
            }
            return Err(error.into());
        }
    };
    // `bumpSentToday`: a best-effort display counter.
    let sent_today = account["sentToday"].as_i64().unwrap_or(0) + 1;
    if let Err(error) = sqlx::query(
        "update personal_mail_accounts set sent_today = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(&account_id)
    .bind(i32::try_from(sent_today).unwrap_or(i32::MAX))
    .bind(&now)
    .execute(db)
    .await
    {
        tracing::error!(%error, "[personal-api/mail-send] sentToday bump failed");
    }
    Ok((message, delivered.pending_verification))
}

/// `{ email }` addresses of a stored message field.
fn emails(value: &Value) -> Vec<Option<String>> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| item["email"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// `deriveReplyRecipients(selfEmail, original, replyAll)`.
fn derive_reply_recipients(
    self_email: &str,
    original: &Value,
    reply_all: bool,
) -> (Vec<String>, Vec<String>) {
    let me = self_email.to_lowercase();
    let mut to: Vec<String> = Vec::new();
    let mut cc: Vec<String> = Vec::new();
    let reply_to = original["replyTo"]["email"]
        .as_str()
        .filter(|e| !e.is_empty());
    let target = reply_to.or_else(|| original["from"]["email"].as_str().filter(|e| !e.is_empty()));
    if let Some(target) = target
        && target.to_lowercase() != me
    {
        to.push(target.to_owned());
    }
    let has = |list: &[String], email: &str| {
        list.iter()
            .any(|e| e.to_lowercase() == email.to_lowercase())
    };
    if reply_all {
        for email in emails(&original["to"]).into_iter().flatten() {
            if !email.is_empty()
                && email.to_lowercase() != me
                && !has(&to, &email)
                && !has(&cc, &email)
            {
                to.push(email);
            }
        }
        for email in emails(&original["cc"]).into_iter().flatten() {
            if !email.is_empty()
                && email.to_lowercase() != me
                && !has(&to, &email)
                && !has(&cc, &email)
            {
                cc.push(email);
            }
        }
    }
    if to.is_empty() && cc.is_empty() {
        to.extend(
            emails(&original["to"])
                .into_iter()
                .flatten()
                .filter(|e| !e.is_empty()),
        );
    }
    (to, cc)
}

/// Whether `text` starts with `prefix` (ASCII, any case) then `:`.
fn starts_with_tag(text: &str, tags: &[&str]) -> bool {
    tags.iter().any(|tag| {
        text.get(..tag.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(tag))
            && text.as_bytes().get(tag.len()) == Some(&b':')
    })
}

/// `deriveReplySubject(subject)`.
fn derive_reply_subject(subject: Option<&str>) -> String {
    let base = js_trim(subject.unwrap_or_default());
    if starts_with_tag(base, &["re"]) {
        return base.to_owned();
    }
    js_trim(&format!("Re: {base}")).to_owned()
}

/// `deriveForwardSubject(subject)`.
fn derive_forward_subject(subject: Option<&str>) -> String {
    let base = js_trim(subject.unwrap_or_default());
    if starts_with_tag(base, &["fwd", "fw"]) {
        return base.to_owned();
    }
    js_trim(&format!("Fwd: {base}")).to_owned()
}

/// `deriveReplyReferences(original)`.
fn derive_reply_references(original: &Value) -> Vec<String> {
    let mut chain: Vec<String> = Vec::new();
    let references = original["references"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for id in references
        .iter()
        .chain(std::iter::once(&original["messageId"]))
    {
        let Some(id) = id.as_str().filter(|id| !id.is_empty()) else {
            continue;
        };
        let id = bracket(id);
        if !chain.contains(&id) {
            chain.push(id);
        }
    }
    chain
}

/// The reply body fields.
pub(crate) struct ReplyBody {
    pub(crate) text_body: Option<String>,
    pub(crate) html_body: Option<String>,
    pub(crate) reply_all: bool,
    pub(crate) idempotency_key: Option<String>,
}

/// `replyAndPersist(...)`.
pub(crate) async fn reply_and_persist(
    ctx: &SendContext<'_>,
    original_id: &str,
    body: ReplyBody,
) -> Result<(Value, bool), SendError> {
    let original = require_message(ctx.db, ctx.personal_account_id, original_id).await?;
    let mailbox = original["accountId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let account = require_account(ctx.db, ctx.personal_account_id, &mailbox).await?;
    let (to, cc) = derive_reply_recipients(
        account["email"].as_str().unwrap_or_default(),
        &original,
        body.reply_all,
    );
    if to.is_empty() && cc.is_empty() {
        return Err(SendError::mail(
            "NO_RECIPIENTS",
            "The original message has no address to reply to",
            None,
        ));
    }
    let input = Compose {
        account_id: mailbox,
        to,
        cc,
        subject: derive_reply_subject(original["subject"].as_str()),
        text_body: body.text_body,
        html_body: body.html_body,
        in_reply_to: original["messageId"].as_str().map(str::to_owned),
        references: Some(derive_reply_references(&original)),
        thread_id: original["threadId"].as_str().map(str::to_owned),
        idempotency_key: body.idempotency_key,
        ..Compose::default()
    };
    send_and_persist(ctx, &input).await
}

/// `Date#toUTCString()`.
fn utc_string(millis: i64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let stamp = iso(millis);
    // `YYYY-MM-DDTHH:mm:ss.sssZ`.
    let day_index = usize::try_from(millis.div_euclid(86_400_000).rem_euclid(7)).unwrap_or(0);
    let month = stamp
        .get(5..7)
        .and_then(|m| m.parse::<usize>().ok())
        .and_then(|m| MONTHS.get(m.wrapping_sub(1)))
        .copied()
        .unwrap_or("Jan");
    format!(
        "{}, {} {} {} {} GMT",
        DAYS[day_index],
        stamp.get(8..10).unwrap_or("01"),
        month,
        stamp.get(0..4).unwrap_or("1970"),
        stamp.get(11..19).unwrap_or("00:00:00"),
    )
}

/// The forward body fields.
pub(crate) struct ForwardBody {
    pub(crate) to: Vec<String>,
    pub(crate) cc: Vec<String>,
    pub(crate) text_body: Option<String>,
    pub(crate) html_body: Option<String>,
    pub(crate) idempotency_key: Option<String>,
}

/// `forwardAndPersist(...)`: the original quoted below the user's text.
pub(crate) async fn forward_and_persist(
    ctx: &SendContext<'_>,
    original_id: &str,
    body: ForwardBody,
) -> Result<(Value, bool), SendError> {
    let original = require_message(ctx.db, ctx.personal_account_id, original_id).await?;
    let subject = derive_forward_subject(original["subject"].as_str());
    let from_email = original["from"]["email"].as_str().unwrap_or_default();
    let sender = match original["from"]["name"].as_str().filter(|n| !n.is_empty()) {
        Some(name) => format!(
            "{name} <{}>",
            original["from"]["email"].as_str().unwrap_or("undefined")
        ),
        None if !from_email.is_empty() => from_email.to_owned(),
        None => "Unknown".to_owned(),
    };
    let date = crate::js::stamp_ms(&original["sentDate"])
        .or_else(|| crate::js::stamp_ms(&original["createdAt"]))
        .map(utc_string)
        .unwrap_or_default();
    let recipients = emails(&original["to"])
        .into_iter()
        .map(Option::unwrap_or_default)
        .collect::<Vec<_>>()
        .join(", ");
    let original_subject = original["subject"].as_str().unwrap_or_default();
    let text_body = match original["textBody"].as_str().filter(|t| !t.is_empty()) {
        Some(text) => Some(format!(
            "{}\n\n---------- Forwarded message ----------\nFrom: {sender}\nDate: {date}\nSubject: {original_subject}\nTo: {recipients}\n\n{text}",
            body.text_body.as_deref().unwrap_or_default()
        )),
        None => body.text_body,
    };
    let html_body = match original["htmlBody"].as_str().filter(|h| !h.is_empty()) {
        Some(html) => Some(format!(
            "{}<br><br><div style=\"border-left:2px solid #ccc;padding-left:1em;color:#555\"><p>---------- Forwarded message ----------</p><p><b>From:</b> {sender}<br><b>Date:</b> {date}<br><b>Subject:</b> {original_subject}<br><b>To:</b> {recipients}</p>{html}</div>",
            body.html_body.as_deref().unwrap_or_default()
        )),
        None => body.html_body,
    };
    let input = Compose {
        account_id: original["accountId"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        to: body.to,
        cc: body.cc,
        subject,
        text_body,
        html_body,
        idempotency_key: body.idempotency_key,
        kind: Some(OutboundKind::Forward),
        ..Compose::default()
    };
    send_and_persist(ctx, &input).await
}

/// `secondsUntil(iso)`: whole seconds, at least 1.
fn seconds_until(at: Option<&Value>) -> Option<u32> {
    let at = crate::js::parse_date(at?.as_str()?)?;
    let seconds = (at - now_ms() + 999).div_euclid(1000).max(1);
    u32::try_from(seconds).ok()
}

fn with_retry_after(mut response: Response, seconds: Option<u32>) -> Response {
    if let Some(seconds) = seconds
        && let Ok(value) = HeaderValue::from_str(&seconds.to_string())
    {
        response
            .headers_mut()
            .insert(http::header::RETRY_AFTER, value);
    }
    response
}

/// `mapSendError(c, err)`; anything else is the route's 500.
pub(crate) fn send_error_response(error: SendError, internal: &str) -> Response {
    let SendError::Mail {
        code,
        message,
        details,
        ..
    } = error
    else {
        let SendError::Internal(error) = error else {
            return ApiError::internal().with_message(internal).into_response();
        };
        tracing::error!(%error, "[personal-api/mail-messages] {internal}");
        return ApiError::internal().with_message(internal).into_response();
    };
    match code.as_str() {
        "ACCOUNT_NOT_FOUND" => ApiError::not_found("Mail account", None).into_response(),
        "MESSAGE_NOT_FOUND" => ApiError::not_found("Message", None).into_response(),
        "DAILY_LIMIT_REACHED" => plan_limit(&message, details.unwrap_or(Value::Null)),
        "NO_RECIPIENTS" => ApiError::bad_request(message).into_response(),
        "DELIVERY_FAILED" => ApiError::unavailable(message).into_response(),
        "PROVIDER_RATE_LIMITED" => with_retry_after(
            error_response(StatusCode::TOO_MANY_REQUESTS, &code, &message, None),
            Some(60),
        ),
        "PROVIDER_DAILY_LIMIT" => {
            error_response(StatusCode::SERVICE_UNAVAILABLE, &code, &message, None)
        }
        "PARTIALLY_SENT" => error_response(StatusCode::BAD_GATEWAY, &code, &message, details),
        _ => match DenialCode::parse(&code) {
            // `denied()`: a refused sender address carries no details.
            Some(denial) => {
                let retry = seconds_until(details.as_ref().and_then(|d| d.get("retryAfter")));
                let status =
                    StatusCode::from_u16(denial.status()).unwrap_or(StatusCode::TOO_MANY_REQUESTS);
                let details = details.filter(|_| denial != DenialCode::SenderNotOwned);
                with_retry_after(error_response(status, &code, &message, details), retry)
            }
            None => ApiError::internal().with_message(message).into_response(),
        },
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reply_rules() {
        let original = json!({
            "from": { "email": "sam@example.com" },
            "replyTo": null,
            "to": [{ "email": "PAT@weldmail.com" }, { "email": "kim@example.com" }],
            "cc": [{ "email": "lee@example.com" }, { "email": "Kim@example.com" }],
            "messageId": "q@example.com",
            "references": ["<root@example.com>", "q@example.com"],
        });
        assert_eq!(
            derive_reply_recipients("pat@weldmail.com", &original, true),
            (
                vec!["sam@example.com".to_owned(), "kim@example.com".to_owned()],
                vec!["lee@example.com".to_owned()]
            )
        );
        assert_eq!(derive_reply_subject(Some(" RE: x ")), "RE: x");
        assert_eq!(derive_reply_subject(None), "Re:");
        assert_eq!(derive_forward_subject(Some("Fw: y")), "Fw: y");
        assert_eq!(derive_forward_subject(Some("y")), "Fwd: y");
        assert_eq!(
            derive_reply_references(&original),
            vec![
                "<root@example.com>".to_owned(),
                "<q@example.com>".to_owned()
            ]
        );
        assert_eq!(bracket("<<a>>"), "<<a>>");
        assert_eq!(bracket("a"), "<a>");
    }

    #[test]
    fn text_helpers() {
        assert_eq!(
            plain_text_of(Some("<p>Hi <b>there</b></p>\n<>")).as_deref(),
            Some("Hi there <>")
        );
        assert_eq!(
            preview_from(Some("  "), Some("<p>Yes</p>")).as_deref(),
            Some("Yes")
        );
        assert_eq!(preview_from(None, None), None);
        assert_eq!(
            utc_string(1_790_848_800_000),
            "Thu, 01 Oct 2026 10:00:00 GMT"
        );
    }
}
