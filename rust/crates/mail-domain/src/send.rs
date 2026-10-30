//! Send and persist (`@weldsuite/mail-domain/send`): compose (`sendAndPersist`)
//! and reply (`replyAndPersist`), on the `postgres` mailbox store, the only
//! one the Kubernetes editions run (ADR MAIL-010).
//!
//! The steps, as TypeScript takes them: the account and the caller's access,
//! the idempotency short-circuit, the HTML sanitized once, recipient
//! validation (format, MX), the outbound guard, attachments from storage,
//! the transport (one envelope per recipient), the SENT copy (an `ingest`:
//! row and attachments), the account's `sent_today`, and the recipients
//! into contacts.

use std::sync::Arc;

use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_ports::{FileStores, MailTransport, get_stored};

use crate::access::{has_access_to_account, is_admin_or_owner};
use crate::contacts::{ContactAddress, upsert_mail_contacts};
use crate::html::sanitize_email_html;
use crate::outbound::clock::{iso, now_ms};
use crate::outbound::content_screen::ScreenAttachment;
use crate::outbound::{
    CheckOutboundInput, MimeAttachment, OutboundGuard, OutboundKind, OutboundReservation, Refusal,
    SendEmailParams, SubjectInput, TransmitError, check_outbound, commit_outbound,
    release_outbound, send_email, trip_platform_breaker,
};
use crate::recipients::{MxLookup, validate_recipients};
use crate::text::{looks_like_html, plain_text_body, utf16_prefix};

/// 5 MiB total: body and attachments.
pub const MAX_EMAIL_SIZE_BYTES: usize = 5 * 1024 * 1024;

/// `MailSendError`: a send refused with a code the routes map to a status
/// (`lib/send-errors.ts`). `Internal` is any other failure (a 500).
#[derive(Debug, Clone, PartialEq)]
pub enum SendError {
    Mail {
        code: String,
        message: String,
        details: Option<Value>,
    },
    Internal(String),
}

impl SendError {
    pub fn mail(code: &str, message: impl Into<String>) -> Self {
        Self::Mail {
            code: code.to_owned(),
            message: message.into(),
            details: None,
        }
    }

    fn with(code: &str, message: impl Into<String>, details: Value) -> Self {
        Self::Mail {
            code: code.to_owned(),
            message: message.into(),
            details: Some(details),
        }
    }
}

impl From<sqlx::Error> for SendError {
    fn from(error: sqlx::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

/// `SendAttachmentInput`: an uploaded file, by storage key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendAttachmentInput {
    pub filename: String,
    pub content_type: Option<String>,
    pub size: i64,
    pub file_key: String,
}

/// `SendComposeInput`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SendInput {
    pub to: Vec<String>,
    pub cc: Option<Vec<String>>,
    pub bcc: Option<Vec<String>>,
    pub subject: Option<String>,
    pub body: Option<String>,
    pub html_body: Option<String>,
    pub reply_to: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<Vec<String>>,
    pub attachments: Vec<SendAttachmentInput>,
    pub idempotency_key: Option<String>,
}

/// `SendResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendResult {
    pub message_id: String,
    pub smtp_message_id: String,
    pub external_message_id: String,
    pub account_id: String,
    pub subject: String,
    pub pending_verification: bool,
}

/// What a send reaches: the deployment's (or the test's) bindings.
pub struct SendDeps<'a> {
    pub db: &'a PgPool,
    pub guard: &'a OutboundGuard,
    /// `SEND_EMAIL`.
    pub transport: Option<&'a dyn MailTransport>,
    /// `PRIVATE_STORAGE` / `STORAGE`.
    pub files: Option<&'a FileStores>,
    pub mx: &'a MxLookup,
    /// `R2_PUBLIC_URL`, for contact avatars.
    pub public_url: Option<&'a str>,
}

/// `SendOptions.outbound` (and the source/kind a reply or forward sets).
#[derive(Debug, Clone, Default)]
pub struct SendOptions {
    pub source: Option<String>,
    pub kind: Option<OutboundKind>,
    /// The master `workspaces.id`, when the caller has it.
    pub workspace_id: Option<String>,
    /// `extraAttachments`: files the server supplies itself (a forward's
    /// originals, a generated `.eml`), sent after the uploaded ones and
    /// stored under the sent copy.
    pub extra_attachments: Vec<ExtraAttachment>,
}

/// `InlineAttachment`: a file with its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtraAttachment {
    pub filename: String,
    pub content_type: Option<String>,
    pub content: Vec<u8>,
}

struct Account {
    id: String,
    email: String,
    display_name: Option<String>,
    daily_send_limit: Option<i64>,
}

/// `loadSendableAccount(db, caller, accountId)`: missing and not allowed
/// look alike.
async fn load_sendable_account(
    db: &PgPool,
    user_id: &str,
    account_id: &str,
) -> Result<Account, SendError> {
    type Row = (
        String,
        String,
        Option<String>,
        Option<i32>,
        Option<bool>,
        Option<Value>,
    );
    let row: Option<Row> = sqlx::query_as(
        "select id, email, display_name, daily_send_limit, is_shared, assigned_user_ids
         from mail_accounts where id = $1 and deleted_at is null limit 1",
    )
    .bind(account_id)
    .fetch_optional(db)
    .await?;
    let not_found = || SendError::mail("ACCOUNT_NOT_FOUND", "Mail account not found");
    let Some((id, email, display_name, limit, shared, assigned)) = row else {
        return Err(not_found());
    };
    let access = crate::access::AccountAccess {
        is_shared: shared.unwrap_or(false),
        assigned_user_ids: assigned
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
    };
    if !has_access_to_account(&access, user_id, is_admin_or_owner(db, user_id).await?) {
        return Err(not_found());
    }
    Ok(Account {
        id,
        email,
        display_name,
        daily_send_limit: limit.map(i64::from),
    })
}

/// `findSentByIdempotencyKey`, through the store.
async fn find_existing_sent(
    db: &PgPool,
    account_id: &str,
    key: &str,
) -> Result<Option<SendResult>, SendError> {
    let row: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "select id, message_id, external_message_id, subject from mail_messages
         where account_id = $1 and idempotency_key = $2 limit 1",
    )
    .bind(account_id)
    .bind(key)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(id, smtp, external, subject)| SendResult {
        message_id: id,
        smtp_message_id: smtp,
        external_message_id: external.unwrap_or_default(),
        account_id: account_id.to_owned(),
        subject: subject.unwrap_or_else(|| "(No subject)".to_owned()),
        pending_verification: false,
    }))
}

/// `prepareBody(data)`: the sanitized HTML and the text/plain part.
pub fn prepare_body(data: &SendInput) -> (Option<String>, Option<String>) {
    let raw_html = data.html_body.clone().or_else(|| {
        data.body
            .as_deref()
            .filter(|b| looks_like_html(b))
            .map(str::to_owned)
    });
    let html = Some(sanitize_email_html(raw_html.as_deref())).filter(|h| !h.is_empty());
    (
        html,
        plain_text_body(data.body.as_deref(), data.html_body.as_deref()),
    )
}

/// `outboundKindOf(db, accountId, data)`.
async fn outbound_kind_of(
    db: &PgPool,
    account_id: &str,
    data: &SendInput,
) -> Result<OutboundKind, SendError> {
    let Some(in_reply_to) = data.in_reply_to.as_deref().filter(|v| !v.is_empty()) else {
        return Ok(OutboundKind::NewThread);
    };
    let parent: Option<Option<String>> = sqlx::query_scalar(
        "select source from mail_messages where account_id = $1 and message_id = $2 limit 1",
    )
    .bind(account_id)
    .bind(in_reply_to)
    .fetch_optional(db)
    .await?;
    Ok(match parent {
        Some(source) if source.as_deref() != Some("sent") => OutboundKind::Reply,
        _ => OutboundKind::NewThread,
    })
}

/// `reserveOutbound(...)`: the guard's refusals as send errors with its code.
async fn reserve_outbound(
    deps: &SendDeps<'_>,
    org: &str,
    account: &Account,
    data: &SendInput,
    body: &(Option<String>, Option<String>),
    opts: &SendOptions,
) -> Result<OutboundReservation, SendError> {
    let kind = match opts.kind {
        Some(kind) => kind,
        None => outbound_kind_of(deps.db, &account.id, data).await?,
    };
    let mut input = CheckOutboundInput::new(
        SubjectInput::Workspace {
            clerk_org_id: org.to_owned(),
            workspace_id: opts.workspace_id.clone(),
        },
        opts.source.as_deref().unwrap_or("compose"),
        kind,
        &account.email,
        data.to.clone(),
    );
    input.cc = data.cc.clone().unwrap_or_default();
    input.bcc = data.bcc.clone().unwrap_or_default();
    input.subject_line = data.subject.clone();
    input.text = body.1.clone();
    input.html = body.0.clone();
    input.attachments = data
        .attachments
        .iter()
        .map(|a| ScreenAttachment {
            filename: a.filename.clone(),
            content_type: a.content_type.clone(),
        })
        .collect();
    input.sender_daily_cap = account.daily_send_limit;
    check_outbound(deps.guard, Some(deps.db), &input)
        .await
        .map_err(|denied| SendError::Mail {
            code: denied.code().as_str().to_owned(),
            message: denied.message(),
            details: Some(denied.details.to_json()),
        })
}

struct Resolved {
    filename: String,
    content_type: Option<String>,
    content: Vec<u8>,
    file_key: String,
}

/// `storeExtraAttachments`: the server-supplied files in the public bucket
/// (`STORAGE`) under the sent copy's id, in order; a file that cannot be
/// stored is left out of the copy.
async fn store_extra_attachments(
    files: Option<&FileStores>,
    org: &str,
    message_id: &str,
    extras: &[ExtraAttachment],
) -> Vec<Resolved> {
    let Some(storage) = files.and_then(|f| f.public.as_ref()) else {
        return Vec::new();
    };
    let mut stored = Vec::new();
    for (index, att) in extras.iter().enumerate() {
        // `filename.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'attachment'`.
        let mut safe = String::new();
        let mut in_run = false;
        for ch in att.filename.chars() {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-' | ' ') {
                safe.push(ch);
                in_run = false;
            } else if !in_run {
                safe.push('_');
                in_run = true;
            }
        }
        safe.truncate(200);
        if safe.is_empty() {
            safe = "attachment".to_owned();
        }
        let key = format!(
            "workspaces/{org}/mail/attachments/{message_id}/{}_{safe}",
            index + 1
        );
        let options = weldsuite_ports::PutOptions {
            content_type: Some(
                att.content_type
                    .clone()
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| "application/octet-stream".to_owned()),
            ),
            ..weldsuite_ports::PutOptions::default()
        };
        match storage.put_boxed(&key, att.content.clone(), &options).await {
            Ok(_) => stored.push(Resolved {
                filename: att.filename.clone(),
                content_type: att.content_type.clone(),
                content: att.content.clone(),
                file_key: key,
            }),
            Err(error) => tracing::error!(
                %error,
                "[mail-send] Failed to store attachment {} for message {message_id}",
                att.filename
            ),
        }
    }
    stored
}

fn too_large() -> SendError {
    SendError::mail(
        "EMAIL_TOO_LARGE",
        format!(
            "Email exceeds the {} MB limit (body + attachments).",
            MAX_EMAIL_SIZE_BYTES / (1024 * 1024)
        ),
    )
}

/// `resolveAttachments(env, orgId, data)`.
async fn resolve_attachments(
    files: Option<&FileStores>,
    org: &str,
    data: &SendInput,
    extra_bytes: usize,
) -> Result<Vec<Resolved>, SendError> {
    let mut total = extra_bytes
        + data.body.as_ref().map_or(0, String::len)
        + data.html_body.as_ref().map_or(0, String::len);
    if extra_bytes > 0 && total > MAX_EMAIL_SIZE_BYTES {
        return Err(too_large());
    }
    if data.attachments.is_empty() {
        return Ok(Vec::new());
    }
    let Some(files) = files else {
        return Err(SendError::mail(
            "STORAGE_BINDING_MISSING",
            "Storage binding not configured",
        ));
    };
    let prefix = format!("workspaces/{org}/");
    let mut resolved = Vec::new();
    for att in &data.attachments {
        if !att.file_key.starts_with(&prefix) {
            return Err(SendError::mail(
                "ATTACHMENT_NOT_IN_WORKSPACE",
                format!("Attachment {} is not in this workspace", att.filename),
            ));
        }
        let object = get_stored(
            files.private.as_ref(),
            files.public.as_deref(),
            &att.file_key,
        )
        .await
        .map_err(|error| SendError::Internal(error.to_string()))?;
        let Some(object) = object else {
            return Err(SendError::mail(
                "ATTACHMENT_NOT_IN_STORAGE",
                format!("Attachment {} not found in storage", att.filename),
            ));
        };
        total += object.bytes.len();
        if total > MAX_EMAIL_SIZE_BYTES {
            return Err(too_large());
        }
        resolved.push(Resolved {
            filename: att.filename.clone(),
            content_type: att
                .content_type
                .clone()
                .filter(|c| !c.is_empty())
                .or_else(|| object.info.content_type.clone()),
            content: object.bytes,
            file_key: att.file_key.clone(),
        });
    }
    Ok(resolved)
}

/// `transmitFailure(env, err)`: the relay's named refusals as send errors.
async fn transmit_failure(guard: &OutboundGuard, error: TransmitError) -> SendError {
    match error {
        TransmitError::Refused {
            refusal, recipient, ..
        } => match refusal {
            Refusal::RateLimited => SendError::with(
                "PROVIDER_RATE_LIMITED",
                "Outbound mail is being rate-limited. Try again in a minute.",
                json!({ "retryAfter": iso(now_ms() + 60_000) }),
            ),
            Refusal::DailyLimit => {
                trip_platform_breaker(
                    guard,
                    "Cloudflare refused a send with E_DAILY_LIMIT_EXCEEDED.",
                )
                .await;
                SendError::mail(
                    "PROVIDER_DAILY_LIMIT",
                    "Outbound mail is unavailable for the rest of the day. Try again later.",
                )
            }
            Refusal::SenderNotAllowed => SendError::mail(
                "SENDER_DOMAIN_NOT_VERIFIED",
                "This account's domain is not set up for sending.",
            ),
            Refusal::RecipientSuppressed => SendError::with(
                "RECIPIENT_SUPPRESSED",
                "A recipient cannot be emailed: earlier mail to it bounced or was reported as spam.",
                json!({ "code": "RECIPIENT_SUPPRESSED", "recipients": [recipient] }),
            ),
        },
        other => SendError::Internal(other.to_string()),
    }
}

/// A send that reached some recipients before it failed.
struct Partial {
    sent: Vec<String>,
    failed: Vec<String>,
}

/// `toSmtpMessageId(externalMessageId)`.
fn to_smtp_message_id(external: &str) -> String {
    let raw = external.strip_prefix('<').unwrap_or(external);
    let raw = raw.strip_suffix('>').unwrap_or(raw);
    if raw.starts_with('<') {
        raw.to_owned()
    } else {
        format!("<{raw}>")
    }
}

/// `resolveThreadId(db, store, accountId, data, fallback)`.
async fn resolve_thread_id(
    db: &PgPool,
    account_id: &str,
    data: &SendInput,
    fallback: &str,
) -> Result<String, SendError> {
    let mut lookup: Vec<String> = Vec::new();
    if let Some(id) = data.in_reply_to.as_deref().filter(|v| !v.is_empty()) {
        lookup.push(id.to_owned());
    }
    lookup.extend(data.references.clone().unwrap_or_default());
    if lookup.is_empty() {
        return Ok(fallback.to_owned());
    }
    let provider: Vec<String> = lookup
        .iter()
        .map(|id| {
            let id = id.strip_prefix('<').unwrap_or(id);
            id.split('@').next().unwrap_or_default().to_owned()
        })
        .filter(|id| !id.is_empty())
        .collect();
    let thread: Option<Option<String>> = sqlx::query_scalar(
        "select thread_id from mail_messages
         where account_id = $1
           and (message_id = any($2)
                or (cardinality($3::text[]) > 0
                    and (external_message_id = any($3) or provider_message_id = any($3))))
         limit 1",
    )
    .bind(account_id)
    .bind(&lookup)
    .bind(&provider)
    .fetch_optional(db)
    .await?;
    Ok(thread
        .flatten()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| fallback.to_owned()))
}

/// `sendAndPersist(env, db, orgId, caller, accountId, data, opts)`.
#[allow(clippy::too_many_lines)] // the steps of one send, in TypeScript's order
pub async fn send_and_persist(
    deps: &SendDeps<'_>,
    org: &str,
    user_id: &str,
    account_id: &str,
    data: &SendInput,
    opts: &SendOptions,
) -> Result<SendResult, SendError> {
    let Some(transport) = deps.transport else {
        return Err(SendError::mail(
            "SEND_BINDING_MISSING",
            "Outbound mail is not configured for this environment (SEND_EMAIL binding missing).",
        ));
    };
    let account = load_sendable_account(deps.db, user_id, account_id).await?;
    if let Some(key) = data.idempotency_key.as_deref()
        && let Some(existing) = find_existing_sent(deps.db, account_id, key).await?
    {
        return Ok(existing);
    }
    let body = prepare_body(data);
    let cc = data.cc.clone().unwrap_or_default();
    let bcc = data.bcc.clone().unwrap_or_default();
    if let Err(invalid) = validate_recipients(deps.mx, &data.to, &cc, &bcc).await {
        return Err(SendError::with(
            "INVALID_RECIPIENTS",
            "One or more recipient addresses are invalid",
            json!({ "invalidFormat": invalid.invalid_format, "unreachableDomains": invalid.unreachable_domains }),
        ));
    }
    let reservation = reserve_outbound(deps, org, &account, data, &body, opts).await?;
    let extra_bytes: usize = opts.extra_attachments.iter().map(|a| a.content.len()).sum();
    let resolved = match resolve_attachments(deps.files, org, data, extra_bytes).await {
        Ok(resolved) => resolved,
        Err(error) => {
            release_outbound(deps.guard, &reservation).await;
            return Err(error);
        }
    };

    let from = match account.display_name.as_deref().filter(|n| !n.is_empty()) {
        Some(name) => format!("{name} <{}>", account.email),
        None => account.email.clone(),
    };
    let mut headers = Vec::new();
    if let Some(id) = data.in_reply_to.as_deref().filter(|v| !v.is_empty()) {
        headers.push(("In-Reply-To".to_owned(), id.to_owned()));
    }
    if let Some(references) = data.references.as_ref().filter(|r| !r.is_empty()) {
        headers.push(("References".to_owned(), references.join(" ")));
    }
    let subject = data
        .subject
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "(No subject)".to_owned());
    let params = SendEmailParams {
        from,
        to: data.to.clone(),
        cc: cc.clone(),
        bcc: bcc.clone(),
        subject: subject.clone(),
        text: body.1.clone(),
        html: body.0.clone(),
        reply_to: data.reply_to.clone(),
        headers,
        attachments: resolved
            .iter()
            .map(|a| MimeAttachment {
                filename: a.filename.clone(),
                content_type: a.content_type.clone(),
                content: a.content.clone(),
                cid: None,
            })
            .chain(opts.extra_attachments.iter().map(|a| MimeAttachment {
                filename: a.filename.clone(),
                content_type: a.content_type.clone(),
                content: a.content.clone(),
                cid: None,
            }))
            .collect(),
    };
    let (sent, partial) = match send_email(transport, &params).await {
        Ok(sent) => (sent, None),
        Err(error) => {
            let reached = match &error {
                TransmitError::Transient {
                    sent_recipients, ..
                }
                | TransmitError::Refused {
                    sent_recipients, ..
                } => sent_recipients.clone(),
                TransmitError::Config(_) => Vec::new(),
            };
            let message_id = error.message_id().map(str::to_owned);
            let (false, Some(message_id)) = (reached.is_empty(), message_id) else {
                release_outbound(deps.guard, &reservation).await;
                return Err(transmit_failure(deps.guard, error).await);
            };
            if matches!(
                error,
                TransmitError::Refused {
                    refusal: Refusal::DailyLimit,
                    ..
                }
            ) {
                trip_platform_breaker(
                    deps.guard,
                    "Cloudflare refused a send with E_DAILY_LIMIT_EXCEEDED.",
                )
                .await;
            }
            let reached_lower: Vec<String> = reached.iter().map(|r| r.to_lowercase()).collect();
            let failed: Vec<String> = data
                .to
                .iter()
                .chain(&cc)
                .chain(&bcc)
                .filter(|r| !reached_lower.contains(&r.to_lowercase()))
                .cloned()
                .collect();
            (
                crate::outbound::SendEmailResponse {
                    message_id,
                    pending_verification: false,
                    suppressed_recipients: Vec::new(),
                },
                Some(Partial {
                    sent: reached,
                    failed,
                }),
            )
        }
    };
    commit_outbound(
        deps.guard,
        Some(deps.db),
        &reservation,
        partial.as_ref().map(|p| p.sent.as_slice()),
    )
    .await;

    let external = sent.message_id.clone();
    let smtp = to_smtp_message_id(&external);
    let message_id = generate_id("msg");
    let now = iso(now_ms());
    let thread_id = resolve_thread_id(deps.db, account_id, data, &smtp).await?;
    let mut resolved = resolved;
    resolved.extend(
        store_extra_attachments(deps.files, org, &message_id, &opts.extra_attachments).await,
    );
    let delivery = match (&partial, sent.suppressed_recipients.is_empty()) {
        (Some(p), _) => Some(("failed", format!("Not sent to: {}", p.failed.join(", ")))),
        (None, false) => Some((
            "rejected",
            format!(
                "Skipped, on the suppression list: {}",
                sent.suppressed_recipients.join(", ")
            ),
        )),
        (None, true) => None,
    };
    let preview_source = body.1.clone().unwrap_or_default();
    let preview = utf16_prefix(
        crate::text::js_trim(&collapse_whitespace(&preview_source)),
        200,
    )
    .to_owned();
    let addresses =
        |list: &[String]| Value::Array(list.iter().map(|e| json!({ "email": e })).collect());
    let mut from_json = json!({ "email": account.email });
    if let Some(name) = account.display_name.as_deref().filter(|n| !n.is_empty()) {
        from_json["name"] = json!(name);
    }
    let inserted: Option<String> = sqlx::query_scalar(
        "insert into mail_messages
           (id, account_id, message_id, thread_id, external_message_id, \"from\", \"to\", cc, bcc,
            subject, preview, text_body, html_body, sent_date, is_read, labels, is_spam, is_starred,
            is_important, is_trash, in_reply_to, \"references\", is_reply, idempotency_key,
            delivery_status, delivery_detail, delivery_updated_at, source, has_attachments,
            attachment_count, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamp, true,
                 '[\"SENT\"]'::jsonb, false, false, false, false, $15, $16, $17, $18, $19, $20,
                 case when $19::text is null then null else $14::timestamp end, 'sent', $21, $22,
                 $14::timestamp, $14::timestamp)
         on conflict (id) do nothing
         returning id",
    )
    .bind(&message_id)
    .bind(account_id)
    .bind(&smtp)
    .bind(&thread_id)
    .bind(&external)
    .bind(&from_json)
    .bind(addresses(&data.to))
    .bind(data.cc.as_ref().map(|c| addresses(c)))
    .bind(data.bcc.as_ref().map(|b| addresses(b)))
    .bind(&subject)
    .bind(&preview)
    .bind(&body.1)
    .bind(&body.0)
    .bind(&now)
    .bind(data.in_reply_to.as_deref())
    .bind(data.references.as_ref().map(|r| json!(r)))
    .bind(data.in_reply_to.as_deref().is_some_and(|v| !v.is_empty()))
    .bind(data.idempotency_key.as_deref())
    .bind(delivery.as_ref().map(|d| d.0))
    .bind(
        delivery
            .as_ref()
            .map(|d| utf16_prefix(&d.1, 500).to_owned()),
    )
    .bind(!resolved.is_empty())
    .bind(i32::try_from(resolved.len()).unwrap_or(i32::MAX))
    .fetch_optional(deps.db)
    .await
    .unwrap_or_else(|error| {
        // A concurrent send with the same key won the unique index.
        tracing::warn!(%error, "[mail-send] SENT copy insert failed");
        None
    });
    if inserted.is_none() {
        if let Some(key) = data.idempotency_key.as_deref()
            && let Some(existing) = find_existing_sent(deps.db, account_id, key).await?
        {
            return Ok(existing);
        }
        return Err(SendError::Internal("SENT copy insert failed".to_owned()));
    }
    for att in &resolved {
        sqlx::query(
            "insert into mail_attachments
               (id, message_id, file_name, content_type, size, storage_path, is_inline, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, false, $7::timestamp, $7::timestamp)",
        )
        .bind(generate_id("attach"))
        .bind(&message_id)
        .bind(&att.filename)
        .bind(
            att.content_type
                .clone()
                .filter(|c| !c.is_empty())
                .unwrap_or_else(|| "application/octet-stream".to_owned()),
        )
        .bind(i64::try_from(att.content.len()).unwrap_or(i64::MAX))
        .bind(&att.file_key)
        .bind(&now)
        .execute(deps.db)
        .await?;
    }
    sqlx::query(
        "update mail_accounts set sent_today = sent_today + 1, updated_at = $2::timestamp where id = $1",
    )
    .bind(account_id)
    .bind(&now)
    .execute(deps.db)
    .await?;

    let mut contacts: Vec<ContactAddress> =
        data.to.iter().map(|e| ContactAddress::new(e)).collect();
    contacts.extend(cc.iter().map(|e| ContactAddress::new(e)));
    contacts.extend(bcc.iter().map(|e| ContactAddress::new(e)));
    let public = deps.files.and_then(|f| f.public.clone());
    upsert_mail_contacts(deps.db, org, &contacts, public.as_ref(), deps.public_url).await;

    if let Some(partial) = partial {
        let total = partial.sent.len() + partial.failed.len();
        return Err(SendError::with(
            "PARTIALLY_SENT",
            format!("Sent to {} of {total} recipients.", partial.sent.len()),
            json!({ "sent": partial.sent, "failed": partial.failed, "messageId": message_id }),
        ));
    }
    Ok(SendResult {
        message_id,
        smtp_message_id: smtp,
        external_message_id: external,
        account_id: account_id.to_owned(),
        subject,
        pending_verification: sent.pending_verification,
    })
}

/// `text.replace(/\s+/g, ' ')`.
pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if c.is_whitespace() || c == '\u{feff}' {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `ReplyInput`.
#[derive(Debug, Clone, Default)]
pub struct ReplyInput {
    pub body: Option<String>,
    pub html_body: Option<String>,
    pub reply_all: bool,
    pub attachments: Vec<SendAttachmentInput>,
    pub idempotency_key: Option<String>,
}

/// `replyAndPersist(...)`: the reply's result and the message it answers.
pub async fn reply_and_persist(
    deps: &SendDeps<'_>,
    org: &str,
    user_id: &str,
    original_id: &str,
    data: &ReplyInput,
    opts: &SendOptions,
) -> Result<(SendResult, String), SendError> {
    type Row = (
        String,
        Option<String>,
        Option<Value>,
        Option<Value>,
        Option<Value>,
        String,
        Option<Value>,
        Option<String>,
    );
    let original: Option<Row> = sqlx::query_as(
        "select account_id, subject, \"from\", \"to\", cc, message_id, \"references\", source
         from mail_messages where id = $1 and deleted_at is null limit 1",
    )
    .bind(original_id)
    .fetch_optional(deps.db)
    .await?;
    let Some((account_id, subject, from, to, cc, smtp_id, references, source)) = original else {
        return Err(SendError::mail(
            "ACCOUNT_NOT_FOUND",
            "Original message not found",
        ));
    };
    let mailbox: Option<String> = sqlx::query_scalar(
        "select email from mail_accounts where id = $1 and deleted_at is null limit 1",
    )
    .bind(&account_id)
    .fetch_optional(deps.db)
    .await?;
    let Some(mailbox) = mailbox else {
        return Err(SendError::mail(
            "ACCOUNT_NOT_FOUND",
            "Mail account not found",
        ));
    };

    // `replyRecipients(original, mailbox, replyAll)`.
    let email_of = |v: &Value| {
        v.get("email")
            .and_then(Value::as_str)
            .filter(|e| !e.is_empty())
            .map(str::to_owned)
    };
    let mut to_list: Vec<String> = from.as_ref().and_then(email_of).into_iter().collect();
    let mut cc_list: Vec<String> = Vec::new();
    if data.reply_all {
        for addr in to.as_ref().and_then(Value::as_array).into_iter().flatten() {
            if let Some(email) = email_of(addr)
                && email != mailbox
                && !to_list.contains(&email)
                && !cc_list.contains(&email)
            {
                to_list.push(email);
            }
        }
        for addr in cc.as_ref().and_then(Value::as_array).into_iter().flatten() {
            if let Some(email) = email_of(addr)
                && email != mailbox
                && !to_list.contains(&email)
                && !cc_list.contains(&email)
            {
                cc_list.push(email);
            }
        }
    }
    let mut refs: Vec<String> = references
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| r.as_str().map(str::to_owned))
        .collect();
    refs.push(smtp_id.clone());
    refs.retain(|r| !r.is_empty());
    let original_subject = subject.unwrap_or_default();
    let stripped = strip_re(&original_subject);
    let input = SendInput {
        to: to_list,
        cc: (!cc_list.is_empty()).then_some(cc_list),
        bcc: None,
        subject: Some(format!("Re: {stripped}")),
        body: data.body.clone(),
        html_body: data.html_body.clone(),
        reply_to: None,
        in_reply_to: Some(smtp_id),
        references: Some(refs),
        attachments: data.attachments.clone(),
        idempotency_key: data.idempotency_key.clone(),
    };
    let options = SendOptions {
        source: Some(opts.source.clone().unwrap_or_else(|| "reply".to_owned())),
        kind: Some(if source.as_deref() == Some("sent") {
            OutboundKind::NewThread
        } else {
            OutboundKind::Reply
        }),
        workspace_id: opts.workspace_id.clone(),
        extra_attachments: Vec::new(),
    };
    let result = send_and_persist(deps, org, user_id, &account_id, &input, &options).await?;
    Ok((result, original_id.to_owned()))
}

/// `subject.replace(/^Re:\s*/i, '')`.
fn strip_re(subject: &str) -> &str {
    let bytes = subject.as_bytes();
    if bytes.len() >= 3 && bytes[..3].eq_ignore_ascii_case(b"re:") {
        subject[3..].trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
    } else {
        subject
    }
}

/// The SEND binding check's message, for routes that test it first.
pub const SEND_BINDING_MISSING: &str =
    "Outbound mail is not configured for this environment (SEND_EMAIL binding missing).";

/// Shared handle for a transport kept in state.
pub type SharedTransport = Arc<dyn MailTransport>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(to_smtp_message_id("<abc@x>"), "<abc@x>");
        assert_eq!(to_smtp_message_id("abc@x"), "<abc@x>");
        assert_eq!(strip_re("RE:  hello"), "hello");
        assert_eq!(strip_re("Fwd: x"), "Fwd: x");
        assert_eq!(collapse_whitespace("a \n\t b"), "a b");
        let (html, text) = prepare_body(&SendInput {
            body: Some("<p>Hi <b>there</b></p>".to_owned()),
            ..SendInput::default()
        });
        assert_eq!(html.as_deref(), Some("<p>Hi <b>there</b></p>"));
        assert_eq!(text.as_deref(), Some("Hi there"));
    }
}
