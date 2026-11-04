//! `outbound.ts`: send one email from a WeldReach mailbox and record it in
//! `reach_messages`. The row is written (status `sending`) before the SMTP
//! transaction, so a crash never causes a silent double send.

use serde_json::Value;
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::Keyring;
use weldsuite_kit::generate_id;

use crate::credentials::open;
use crate::render::{email_footer, snippet_of};
use crate::schemas::email_domain;
use crate::smtp::{
    MailAddress, OutgoingMessage, SmtpConfig, SmtpEnvelope, SmtpTransport, build_mime_message,
    generate_message_id,
};
use crate::{ReachResult, iso, text};

/// `MAILBOX_NOT_FOUND`, `MAILBOX_NOT_USABLE`, `CREDENTIALS_UNAVAILABLE`.
pub const MAILBOX_NOT_FOUND: &str = "mailbox_not_found";
pub const MAILBOX_NOT_USABLE: &str = "mailbox_not_usable";
pub const CREDENTIALS_UNAVAILABLE: &str = "credentials_unavailable";

/// `SendFromMailboxInput`.
#[derive(Debug, Clone, Default)]
pub struct SendInput {
    pub mailbox_id: String,
    pub to_email: String,
    pub to_name: Option<String>,
    pub subject: String,
    pub text: String,
    pub append_footer: bool,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub thread_key: Option<String>,
    pub campaign_id: Option<String>,
    pub enrollment_id: Option<String>,
    pub step_id: Option<String>,
    pub prospect_id: Option<String>,
    pub sent_by: Option<String>,
}

/// `SendFromMailboxResult`.
#[derive(Debug, Clone)]
pub struct SendResult {
    pub ok: bool,
    /// The `reach_messages` row (Drizzle-shaped); `None` when none was written.
    pub message: Option<Value>,
    pub permanent: bool,
    pub recipient_rejected: bool,
    pub auth_failed: bool,
    pub error: String,
}

fn not_sent(error: impl Into<String>) -> SendResult {
    SendResult {
        ok: false,
        message: None,
        permanent: true,
        recipient_rejected: false,
        auth_failed: false,
        error: error.into(),
    }
}

/// What a send needs (`OutboundDeps`).
pub struct OutboundDeps<'a> {
    pub db: &'a PgPool,
    pub keyring: &'a Keyring,
    pub transport: &'a dyn SmtpTransport,
    pub now: &'a (dyn Fn() -> OffsetDateTime + Send + Sync),
}

fn mailbox_problem(status: &str, sent_by: Option<&str>) -> Option<String> {
    let allowed = if sent_by.is_some_and(|s| !s.is_empty()) {
        matches!(status, "active" | "warming" | "paused")
    } else {
        status == "active"
    };
    (!allowed).then(|| format!("{MAILBOX_NOT_USABLE}: {status}"))
}

async fn finish_message(
    deps: &OutboundDeps<'_>,
    row: Value,
    status: &str,
    sent_at: Option<OffsetDateTime>,
    smtp_response: Option<&str>,
    error: Option<&str>,
    set_response: bool,
) -> ReachResult<Value> {
    let id = text(&row, "id").unwrap_or_default().to_owned();
    let updated: Option<Value> = sqlx::query_scalar(
        "update reach_messages set status = $2,
             sent_at = case when $3::text is null then sent_at else $3::timestamptz end,
             smtp_response = case when $4 then $5 else smtp_response end,
             error = $6, updated_at = $7::timestamptz
         where id = $1 returning to_jsonb(reach_messages)",
    )
    .bind(&id)
    .bind(status)
    .bind(sent_at.map(iso))
    .bind(set_response)
    .bind(smtp_response)
    .bind(error)
    .bind(iso((deps.now)()))
    .fetch_optional(deps.db)
    .await?;
    Ok(updated.map_or(row, weldsuite_db::js_row))
}

/// `sendFromMailbox(deps, input)`.
pub async fn send_from_mailbox(
    deps: &OutboundDeps<'_>,
    input: &SendInput,
) -> ReachResult<SendResult> {
    let mailbox: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_mailboxes t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(&input.mailbox_id)
    .fetch_optional(deps.db)
    .await?;
    let Some(mailbox) = mailbox.map(weldsuite_db::js_row) else {
        return Ok(not_sent(MAILBOX_NOT_FOUND));
    };
    if let Some(problem) = mailbox_problem(
        text(&mailbox, "status").unwrap_or_default(),
        input.sent_by.as_deref(),
    ) {
        return Ok(not_sent(problem));
    }
    let Some(credentials) = open(deps.keyring, text(&mailbox, "smtpCredentials")) else {
        return Ok(not_sent(CREDENTIALS_UNAVAILABLE));
    };
    let mut body = input.text.clone();
    if input.append_footer {
        let settings = crate::campaigns::load_settings(deps.db).await?;
        body.push_str(&email_footer(settings.as_ref()));
    }
    let mailbox_email = text(&mailbox, "email").unwrap_or_default().to_owned();
    let message_id = match generate_message_id(&email_domain(&mailbox_email)) {
        Ok(id) => id,
        Err(error) => return Ok(not_sent(format!("message_build_failed: {error}"))),
    };
    let from_name = format!(
        "{} {}",
        text(&mailbox, "firstName").unwrap_or_default(),
        text(&mailbox, "lastName").unwrap_or_default()
    );
    let from_name = crate::text::js_trim(&from_name).to_owned();
    let raw = match build_mime_message(&OutgoingMessage {
        from: MailAddress {
            email: mailbox_email.clone(),
            name: (!from_name.is_empty()).then_some(from_name),
        },
        to: vec![MailAddress {
            email: input.to_email.clone(),
            name: input.to_name.clone(),
        }],
        reply_to: None,
        subject: input.subject.clone(),
        text: body.clone(),
        html: None,
        message_id: message_id.clone(),
        in_reply_to: input.in_reply_to.clone(),
        references: input.references.clone(),
        headers: vec![(
            "List-Unsubscribe".to_owned(),
            format!("<mailto:{mailbox_email}?subject=unsubscribe>"),
        )],
        date: (deps.now)(),
    }) {
        Ok(raw) => raw,
        Err(error) => return Ok(not_sent(format!("message_build_failed: {error}"))),
    };
    let references = (!input.references.is_empty()).then(|| input.references.join(" "));
    let row: Option<Value> = sqlx::query_scalar(
        "insert into reach_messages (id, direction, campaign_id, enrollment_id, step_id, mailbox_id, prospect_id,
             thread_key, message_id_header, in_reply_to, \"references\", from_email, to_email, subject, snippet,
             body_text, status, sent_by)
         values ($1, 'out', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'sending', $16)
         returning to_jsonb(reach_messages)",
    )
    .bind(generate_id("rmsg"))
    .bind(&input.campaign_id)
    .bind(&input.enrollment_id)
    .bind(&input.step_id)
    .bind(text(&mailbox, "id"))
    .bind(&input.prospect_id)
    .bind(input.thread_key.clone().unwrap_or_else(|| message_id.clone()))
    .bind(&message_id)
    .bind(&input.in_reply_to)
    .bind(&references)
    .bind(&mailbox_email)
    .bind(&input.to_email)
    .bind(&input.subject)
    .bind(snippet_of(&input.text, 500))
    .bind(&body)
    .bind(&input.sent_by)
    .fetch_optional(deps.db)
    .await?;
    let Some(row) = row.map(weldsuite_db::js_row) else {
        return Ok(not_sent("message_insert_failed"));
    };
    let config = SmtpConfig {
        host: credentials.host.clone(),
        port: credentials.port,
        secure: credentials.port == 465,
        username: credentials.username.clone(),
        password: credentials.password.clone(),
    };
    let envelope = SmtpEnvelope {
        from: mailbox_email.clone(),
        to: vec![input.to_email.clone()],
    };
    let result = match deps.transport.send(config, envelope, raw).await {
        Ok(result) => result,
        Err(error) => {
            let error = format!("send_threw: {error}");
            let message =
                finish_message(deps, row, "unknown", None, None, Some(&error), false).await?;
            return Ok(SendResult {
                ok: false,
                message: Some(message),
                permanent: true,
                recipient_rejected: false,
                auth_failed: false,
                error,
            });
        }
    };
    if result.ok {
        let sent_at = (deps.now)();
        let message = finish_message(
            deps,
            row,
            "sent",
            Some(sent_at),
            Some(&result.response),
            None,
            true,
        )
        .await?;
        sqlx::query("update reach_mailboxes set last_sent_at = $2::timestamptz, updated_at = $2::timestamptz where id = $1")
            .bind(text(&mailbox, "id"))
            .bind(iso(sent_at))
            .execute(deps.db)
            .await?;
        return Ok(SendResult {
            ok: true,
            message: Some(message),
            permanent: false,
            recipient_rejected: false,
            auth_failed: false,
            error: String::new(),
        });
    }
    let uncertain = result.delivery_uncertain;
    let error = format!("{}: {}", result.stage, result.response);
    let status = if uncertain { "unknown" } else { "failed" };
    let message = finish_message(
        deps,
        row,
        status,
        None,
        Some(&result.response),
        Some(&error),
        true,
    )
    .await?;
    Ok(SendResult {
        ok: false,
        message: Some(message),
        permanent: result.permanent || uncertain,
        recipient_rejected: result.recipient_rejected,
        auth_failed: result.auth_failed,
        error,
    })
}
