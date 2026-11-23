//! `outbound.ts`: send one email from a WeldReach mailbox and record it in
//! `reach_messages`. The row is written (status `sending`) before the SMTP
//! transaction, so a crash never causes a silent double send.

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, Set};
use serde_json::Value;
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_db::{Keyring, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{reach_mailboxes as mailboxes, reach_messages as messages};

use crate::credentials::open;
use crate::render::{email_footer, snippet_of};
use crate::schemas::email_domain;
use crate::smtp::{
    MailAddress, OutgoingMessage, SmtpConfig, SmtpEnvelope, SmtpTransport, build_mime_message,
    generate_message_id,
};
use crate::{ReachResult, js, stamp, text};

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
    use messages::Column;
    let id = text(&row, "id").unwrap_or_default().to_owned();
    let mut update = messages::Entity::update_many().col_expr(Column::Status, Expr::value(status));
    if let Some(sent_at) = sent_at {
        update = update.col_expr(Column::SentAt, Expr::value(stamp(sent_at)));
    }
    if set_response {
        update = update.col_expr(Column::SmtpResponse, Expr::value(smtp_response));
    }
    let updated = update
        .col_expr(Column::Error, Expr::value(error))
        .col_expr(Column::UpdatedAt, Expr::value(stamp((deps.now)())))
        .filter(Column::Id.eq(id))
        .exec_with_returning(&orm(deps.db))
        .await?
        .into_iter()
        .next();
    match updated {
        Some(updated) => Ok(js(serde_json::to_value(updated))?),
        None => Ok(row),
    }
}

/// `sendFromMailbox(deps, input)`.
pub async fn send_from_mailbox(
    deps: &OutboundDeps<'_>,
    input: &SendInput,
) -> ReachResult<SendResult> {
    let mailbox = mailboxes::Entity::find_by_id(input.mailbox_id.as_str())
        .filter(mailboxes::Column::DeletedAt.is_null())
        .one(&orm(deps.db))
        .await?
        .map(serde_json::to_value)
        .map(js)
        .transpose()?;
    let Some(mailbox) = mailbox else {
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
    let row = messages::Entity::insert(messages::ActiveModel {
        id: Set(generate_id("rmsg")),
        direction: Set("out".to_owned()),
        campaign_id: Set(input.campaign_id.clone()),
        enrollment_id: Set(input.enrollment_id.clone()),
        step_id: Set(input.step_id.clone()),
        mailbox_id: Set(text(&mailbox, "id").unwrap_or_default().to_owned()),
        prospect_id: Set(input.prospect_id.clone()),
        thread_key: Set(Some(
            input
                .thread_key
                .clone()
                .unwrap_or_else(|| message_id.clone()),
        )),
        message_id_header: Set(message_id.clone()),
        in_reply_to: Set(input.in_reply_to.clone()),
        references: Set(references),
        from_email: Set(mailbox_email.clone()),
        to_email: Set(input.to_email.clone()),
        subject: Set(Some(input.subject.clone())),
        snippet: Set(Some(snippet_of(&input.text, 500))),
        body_text: Set(Some(body.clone())),
        status: Set(Some("sending".to_owned())),
        sent_by: Set(input.sent_by.clone()),
        ..Default::default()
    })
    .exec_with_returning(&orm(deps.db))
    .await?;
    let row = js(serde_json::to_value(row))?;
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
        mailboxes::Entity::update_many()
            .col_expr(mailboxes::Column::LastSentAt, Expr::value(stamp(sent_at)))
            .col_expr(mailboxes::Column::UpdatedAt, Expr::value(stamp(sent_at)))
            .filter(mailboxes::Column::Id.eq(text(&mailbox, "id")))
            .exec(&orm(deps.db))
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
