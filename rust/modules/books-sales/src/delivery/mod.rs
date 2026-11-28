//! Sending invoices, credit notes and quotes by e-mail, and the public
//! document page the e-mail links to (Rust only, edition feature
//! `books-invoice-email`; ADR BOOKS-014).
//!
//! - `view`: what a customer sees (the pay portal's document and the PDF).
//! - `email`: `POST /api/invoices/:id/email` and `POST
//!   /api/accounting-quotes/:id/email`.
//! - `public`: `/public/weldbooks/documents/:token`.
//!
//! This file holds what they share: the delivery history in
//! `invoices.email_history`, the signed link, and the one function that
//! composes, sends and records an invoice mail (reminders use it too).

use std::collections::HashMap;
use std::fmt::Write as _;

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::document_token::{self, DocumentToken};
use weldsuite_books_domain::email_templates::{
    Template, body_html, custom_template, fill, template_for,
};
use weldsuite_books_domain::http::{BooksState, now};
use weldsuite_books_domain::js::millis_of;
use weldsuite_books_domain::simple_pdf;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_emails::{EmailBrand, RenderedEmail, SystemEmail, send_system_email};
use weldsuite_ports::{MailAttachment, Mailbox};
use weldsuite_schema::tenant::invoices;

use crate::finalize::load_items;
use crate::persist::text;

#[cfg(test)]
mod db_tests;
pub(crate) mod email;
pub(crate) mod public;
pub(crate) mod view;

pub use public::public_router;

/// An hour: how often one document's opening is recorded.
pub(crate) const VIEW_THROTTLE_MS: i64 = 3_600_000;

// ── The delivery history (`invoices.email_history`) ─────────────────────────

/// The history of an invoice row, oldest first.
pub(crate) fn history_of(invoice: &Value) -> Vec<Value> {
    invoice
        .get("emailHistory")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn entry_type(entry: &Value) -> &str {
    text(entry, "type").unwrap_or_default()
}

/// The nonce of the invoice's current public link: the last `link` entry,
/// unless a `link_revoked` came after it.
pub(crate) fn link_nonce(history: &[Value]) -> Option<String> {
    history
        .iter()
        .rev()
        .find(|e| matches!(entry_type(e), "link" | "link_revoked"))
        .filter(|e| entry_type(e) == "link")
        .and_then(|e| text(e, "nonce"))
        .map(str::to_owned)
}

/// When the last entry of `kind` was made, in milliseconds.
pub(crate) fn last_at(history: &[Value], kind: &str) -> Option<i64> {
    history
        .iter()
        .rev()
        .find(|e| entry_type(e) == kind)
        .and_then(|e| text(e, "at"))
        .and_then(millis_of)
}

/// Whether an opening at `now_ms` is to be recorded (once an hour).
pub(crate) fn should_record_view(history: &[Value], now_ms: i64) -> bool {
    last_at(history, "viewed").is_none_or(|at| now_ms - at >= VIEW_THROTTLE_MS)
}

/// A history entry: `{ type, at, ... }`.
pub(crate) fn entry(kind: &str, extra: Value) -> Value {
    let mut map = Map::new();
    map.insert("type".into(), json!(kind));
    map.insert("at".into(), json!(now()));
    if let Value::Object(extra) = extra {
        map.extend(extra);
    }
    Value::Object(map)
}

/// Append `entry` to an invoice's history in one statement (concurrent
/// appends do not lose each other), with `touch` columns set alongside.
pub(crate) async fn append_history(
    db: &PgPool,
    invoice_id: &str,
    entry: Value,
    touch: Vec<(invoices::Column, Expr)>,
) -> Result<(), DbErr> {
    let mut update = invoices::Entity::update_many().col_expr(
        invoices::Column::EmailHistory,
        Expr::cust_with_values(
            "COALESCE(\"email_history\", '[]'::jsonb) || jsonb_build_array($1::jsonb)",
            [entry],
        ),
    );
    for (column, value) in touch {
        update = update.col_expr(column, value);
    }
    update
        .col_expr(invoices::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(invoices::Column::Id.eq(invoice_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

// ── The link ────────────────────────────────────────────────────────────────

/// What a public link needs: the signing key and the portal's address.
pub(crate) struct Links {
    pub secret: Vec<u8>,
    /// `PAY_PORTAL_PUBLIC_URL` without a trailing slash.
    pub portal: String,
}

impl Links {
    /// `None` while the install has no portal address or no key.
    pub(crate) fn of(state: &BooksState) -> Option<Self> {
        let portal = state
            .env
            .get("PAY_PORTAL_PUBLIC_URL")
            .map(|u| u.trim().trim_end_matches('/').to_owned())
            .filter(|u| u.starts_with("https://") || u.starts_with("http://"))?;
        let secret = Self::secret(state)?;
        Some(Self { secret, portal })
    }

    /// The signing key alone (the public routes need no portal address).
    pub(crate) fn secret(state: &BooksState) -> Option<Vec<u8>> {
        document_token::secret(
            state
                .env
                .get("BOOKS_DOCUMENT_TOKEN_SECRET")
                .map(String::as_str),
            &state.keyring,
        )
    }

    pub(crate) fn url(&self, token: &str) -> String {
        format!("{}/d/{token}", self.portal)
    }
}

/// The public token of an invoice, making its link on first use.
pub(crate) async fn invoice_token(
    db: &PgPool,
    secret: &[u8],
    workspace_id: &str,
    invoice: &Value,
) -> Result<String, DbErr> {
    let id = text(invoice, "id").unwrap_or_default();
    let nonce = if let Some(nonce) = link_nonce(&history_of(invoice)) {
        nonce
    } else {
        let nonce = document_token::new_nonce();
        append_history(db, id, entry("link", json!({ "nonce": nonce })), Vec::new()).await?;
        nonce
    };
    Ok(document_token::sign(
        secret,
        &DocumentToken::new(workspace_id, "invoice", id, &nonce),
    ))
}

/// Put the "pay online" link on the PDF of an open invoice, when the invoice
/// has a current public link and the customer can pay it online (Mollie
/// connected with methods). `url` is the link when the caller has just made
/// it; otherwise it is built from the invoice's current link nonce. A link is
/// never created here.
pub(crate) async fn attach_pay_link(
    state: &BooksState,
    db: &PgPool,
    workspace_id: &str,
    invoice: &Value,
    url: Option<&str>,
    doc: &mut view::Document,
) -> Result<(), DbErr> {
    if doc.pdf.balance_due.is_none()
        || !crate::online_payments::pay::online_ready(state, db, invoice).await?
    {
        return Ok(());
    }
    let url = if let Some(url) = url {
        url.to_owned()
    } else {
        let Some(links) = Links::of(state) else {
            return Ok(());
        };
        let Some(nonce) = link_nonce(&history_of(invoice)) else {
            return Ok(());
        };
        let id = text(invoice, "id").unwrap_or_default();
        links.url(&document_token::sign(
            &links.secret,
            &DocumentToken::new(workspace_id, "invoice", id, &nonce),
        ))
    };
    doc.pdf.pay_link = Some(view::pay_link(doc.locale, url));
    Ok(())
}

/// The public token of a quote sent at `sent_at_millis`.
pub(crate) fn quote_token(
    secret: &[u8],
    workspace_id: &str,
    quote_id: &str,
    sent_at_millis: i64,
) -> String {
    let nonce = document_token::quote_nonce(secret, quote_id, sent_at_millis);
    document_token::sign(
        secret,
        &DocumentToken::new(workspace_id, "quote", quote_id, &nonce),
    )
}

// ── Composing and sending ───────────────────────────────────────────────────

/// Why a mail did not go out.
#[derive(Debug)]
pub(crate) enum DeliveryError {
    /// The server has no mail transport.
    NoMail,
    /// No portal address or no signing key, so the link cannot be made.
    NoLink,
    NoRecipient,
    Database(DbErr),
    /// The transport refused it (the reason is logged, never shown).
    Send,
}

impl From<DbErr> for DeliveryError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

/// An e-mail about invoices.
pub(crate) struct InvoiceMail {
    /// The rows; the first is the one the text is about, the rest are listed.
    pub invoices: Vec<Value>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: Option<String>,
    pub body: Option<String>,
    pub attach_pdf: bool,
    pub include_link: bool,
    /// The template: `invoice`, `creditNote`, `reminder1` to `reminder3`.
    pub template: String,
    /// The text to use when the entity wrote none for `template`.
    pub fallback: Option<Template>,
    /// The history entry's type: `sent` or `reminder`.
    pub history_type: &'static str,
    pub level: Option<i32>,
    /// Placeholders beyond the usual ones (the statutory claim).
    pub vars: HashMap<&'static str, String>,
    /// Added to the history entry (what a reminder claimed).
    pub history_extra: Map<String, Value>,
}

/// What went out.
#[derive(Debug, Clone)]
pub(crate) struct Sent {
    pub message_id: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub link: Option<String>,
}

fn file_name(number: &str) -> String {
    let safe: String = number
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!(
        "{}.pdf",
        if safe.is_empty() {
            "document".to_owned()
        } else {
            safe
        }
    )
}

/// The mail's text and HTML, from the template and the placeholders.
pub(crate) struct Composed {
    pub subject: String,
    pub text: String,
    pub html: String,
}

/// Fill the template (or the caller's own subject and body) for `docs`: the
/// first is what the text is about; more than one adds a list of them.
pub(crate) fn compose(
    docs: &[(&view::Document, Option<String>)],
    template: &str,
    subject: Option<&str>,
    body: Option<&str>,
    extra: &HashMap<&'static str, String>,
    fallback: Option<Template>,
) -> Composed {
    let (primary, link) = &docs[0];
    // The entity's own text, else the caller's default for this mail, else ours.
    let chosen = custom_template(Some(&primary.settings), template, primary.locale)
        .or(fallback)
        .unwrap_or_else(|| template_for(Some(&primary.settings), template, primary.locale));
    let numbers: Vec<&str> = docs.iter().map(|(d, _)| d.number.as_str()).collect();
    let mut vars: HashMap<&str, String> = HashMap::from([
        ("customerName", primary.customer_name.clone()),
        ("number", numbers.join(", ")),
        ("amount", primary.amount_text.clone()),
        ("dueDate", primary.date_text.clone()),
        ("link", link.clone().unwrap_or_default()),
        ("companyName", primary.company_name.clone()),
    ]);
    for (key, value) in extra {
        vars.insert(key, value.clone());
    }
    let subject = fill(
        subject
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&chosen.subject),
        &vars,
    );
    let mut text = fill(
        body.filter(|b| !b.trim().is_empty())
            .unwrap_or(&chosen.body),
        &vars,
    );
    if docs.len() > 1 {
        let heading = if primary.locale == "nl" {
            "Openstaande facturen:"
        } else {
            "Open invoices:"
        };
        let _ = write!(text, "\n\n{heading}");
        for (doc, link) in docs {
            let _ = write!(
                text,
                "\n- {} ({}, {})",
                doc.number, doc.amount_text, doc.date_text
            );
            if let Some(link) = link {
                let _ = write!(text, ": {link}");
            }
        }
    }
    // Without a link the template's `{link}` leaves a dangling "via ".
    let html = body_html(&text, link.as_deref());
    Composed {
        subject,
        text,
        html,
    }
}

/// Hand the composed mail to the transport: from the entity's name (the
/// system address sends it), replies to the entity's address, the PDFs of
/// `attach` attached.
pub(crate) async fn transmit(
    transport: &dyn weldsuite_ports::DynSystemMail,
    primary: &view::Document,
    composed: &Composed,
    to: &[String],
    cc: &[String],
    attach: &[&view::Document],
) -> Result<weldsuite_ports::SentMail, weldsuite_ports::PortError> {
    let rendered = RenderedEmail {
        subject: composed.subject.clone(),
        html: composed.html.clone(),
        text: composed.text.clone(),
    };
    let brand = EmailBrand::Workspace {
        name: primary.company_name.clone(),
        logo_url: None,
        accent_color: None,
    };
    let mut email = SystemEmail::to(rendered, brand, to.first().map_or("", String::as_str));
    email.from_name = Some(primary.company_name.clone());
    email.to = to.iter().map(Mailbox::new).collect();
    email.cc = cc.iter().map(Mailbox::new).collect();
    email = email.reply_to(primary.reply_to.as_deref());
    for doc in attach {
        email = email.attach(MailAttachment {
            filename: file_name(&doc.number),
            content_type: "application/pdf".to_owned(),
            content: simple_pdf::render(&doc.pdf),
        });
    }
    send_system_email(transport, email).await
}

/// Compose, send and record an invoice mail. A refusal by the transport is
/// recorded as a `bounced` entry (the synchronous failures are all the EU
/// MTA reports back), and a success as `history_type` with the message id.
#[allow(
    clippy::too_many_lines,
    reason = "prepare, compose, send, record: one flow"
)]
pub(crate) async fn mail_invoices(
    db: &PgPool,
    state: &BooksState,
    workspace_id: &str,
    request: InvoiceMail,
) -> Result<Sent, DeliveryError> {
    let Some(transport) = state.mail.clone() else {
        return Err(DeliveryError::NoMail);
    };
    let to: Vec<String> = request
        .to
        .iter()
        .map(|a| a.trim().to_owned())
        .filter(|a| !a.is_empty())
        .collect();
    if to.is_empty() {
        return Err(DeliveryError::NoRecipient);
    }
    let links = if request.include_link {
        Some(Links::of(state).ok_or(DeliveryError::NoLink)?)
    } else {
        None
    };
    let now_ms = weldsuite_books_domain::http::now_ms();
    let mut prepared: Vec<(view::Document, Option<String>)> = Vec::new();
    for invoice in &request.invoices {
        let id = text(invoice, "id").unwrap_or_default();
        let items = load_items(db, id, true).await?;
        let Some(mut doc) =
            view::invoice_document(db, &state.keyring, invoice, &items, now_ms).await?
        else {
            return Err(DeliveryError::Database(DbErr::RecordNotFound(
                "entity".into(),
            )));
        };
        let url = match &links {
            Some(links) => {
                Some(links.url(&invoice_token(db, &links.secret, workspace_id, invoice).await?))
            }
            None => None,
        };
        if request.attach_pdf {
            attach_pay_link(state, db, workspace_id, invoice, url.as_deref(), &mut doc).await?;
        }
        prepared.push((doc, url));
    }
    let refs: Vec<(&view::Document, Option<String>)> =
        prepared.iter().map(|(d, l)| (d, l.clone())).collect();
    let composed = compose(
        &refs,
        &request.template,
        request.subject.as_deref(),
        request.body.as_deref(),
        &request.vars,
        request.fallback.clone(),
    );
    let primary = &prepared[0].0;
    let attach: Vec<&view::Document> = if request.attach_pdf {
        prepared.iter().map(|(d, _)| d).collect()
    } else {
        Vec::new()
    };
    let outcome = transmit(
        transport.as_ref(),
        primary,
        &composed,
        &to,
        &request.cc,
        &attach,
    )
    .await;
    let link = prepared[0].1.clone();
    match outcome {
        Ok(sent) => {
            for invoice in &request.invoices {
                let id = text(invoice, "id").unwrap_or_default();
                let mut extra = request.history_extra.clone();
                extra.insert("to".into(), json!(to));
                extra.insert("messageId".into(), json!(sent.message_id));
                if let Some(level) = request.level {
                    extra.insert("level".into(), json!(level));
                }
                append_history(
                    db,
                    id,
                    entry(request.history_type, Value::Object(extra)),
                    Vec::new(),
                )
                .await?;
            }
            Ok(Sent {
                message_id: sent.message_id,
                to,
                cc: request.cc.clone(),
                subject: composed.subject,
                link,
            })
        }
        Err(error) => {
            tracing::warn!(%error, "[books] an invoice e-mail was refused by the mail transport");
            for invoice in &request.invoices {
                let id = text(invoice, "id").unwrap_or_default();
                let mut extra = Map::new();
                extra.insert("to".into(), json!(to));
                extra.insert("error".into(), json!("send_failed"));
                if let Some(level) = request.level {
                    extra.insert("level".into(), json!(level));
                }
                append_history(db, id, entry("bounced", Value::Object(extra)), Vec::new()).await?;
            }
            Err(DeliveryError::Send)
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    fn e(kind: &str, at: &str, extra: Value) -> Value {
        let mut v = json!({ "type": kind, "at": at });
        if let (Value::Object(v), Value::Object(extra)) = (&mut v, extra) {
            v.extend(extra);
        }
        v
    }

    #[test]
    fn the_current_link_is_the_last_one_unless_revoked() {
        assert_eq!(link_nonce(&[]), None);
        let h = vec![
            e("link", "2026-01-01T00:00:00.000Z", json!({ "nonce": "a" })),
            e("sent", "2026-01-01T00:00:01.000Z", json!({})),
        ];
        assert_eq!(link_nonce(&h).as_deref(), Some("a"));
        let revoked = [
            h.clone(),
            vec![e("link_revoked", "2026-01-02T00:00:00.000Z", json!({}))],
        ]
        .concat();
        assert_eq!(link_nonce(&revoked), None);
        let renewed = [
            revoked,
            vec![e(
                "link",
                "2026-01-03T00:00:00.000Z",
                json!({ "nonce": "b" }),
            )],
        ]
        .concat();
        assert_eq!(link_nonce(&renewed).as_deref(), Some("b"));
    }

    #[test]
    fn a_view_is_recorded_once_an_hour() {
        let at = millis_of("2026-01-01T10:00:00.000Z").unwrap();
        let h = vec![e("viewed", "2026-01-01T10:00:00.000Z", json!({}))];
        assert!(should_record_view(&[], at));
        assert!(!should_record_view(&h, at + 59 * 60_000));
        assert!(should_record_view(&h, at + 60 * 60_000));
    }
}
