//! `POST /api/invoices/:id/email` and `POST /api/accounting-quotes/:id/email`
//! (Rust only, edition feature `books-invoice-email`): send the document to
//! the customer with the public link and the PDF.
//!
//! A draft invoice is finalized first through the code `PATCH /:id/send`
//! uses, so e-mailing and "mark as sent" post the same entry. The mail goes
//! out through the system mail transport from the entity's name, with the
//! entity's address as reply-to; each send is recorded in `email_history`.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, json_of, ok, reply};
use weldsuite_books_domain::js::millis_of;
use weldsuite_catalogs::entity_events::{INVOICE_EMAILED, QUOTE_EMAILED};
use weldsuite_db::{orm, utc_now};
use weldsuite_legal_entities::{LegalEntityApp, default_entity_id_for};
use weldsuite_schema::tenant::crm_quotes;

use super::public::load_quote;
use super::{DeliveryError, InvoiceMail, Links, compose, quote_token, transmit, view};
use crate::finalize::load_invoice;
use crate::invoices::actions::mark_sent;
use crate::persist::{owned, text};

/// The body of both e-mail routes.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct EmailBody {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: Option<String>,
    pub body: Option<String>,
    pub attach_pdf: bool,
    pub include_link: bool,
}

fn looks_like_address(address: &str) -> bool {
    let Some(at) = address.find('@') else {
        return false;
    };
    address.len() <= 320
        && !address.contains(char::is_whitespace)
        && at > 0
        && address[at + 1..].contains('.')
        && !address.ends_with('.')
}

fn addresses(body: &Value, key: &str, required: bool) -> Result<Vec<String>, Refusal> {
    let Some(value) = body.get(key).filter(|v| !v.is_null()) else {
        return if required {
            Err(Refusal::bad_request(format!("{key} is required")))
        } else {
            Ok(Vec::new())
        };
    };
    let list = value
        .as_array()
        .ok_or_else(|| Refusal::bad_request(format!("{key} must be a list of addresses")))?;
    if list.len() > 10 || (required && list.is_empty()) {
        return Err(Refusal::bad_request(format!(
            "{key} must hold 1 to 10 addresses"
        )));
    }
    list.iter()
        .map(|a| {
            a.as_str()
                .map(str::trim)
                .filter(|a| looks_like_address(a))
                .map(str::to_owned)
                .ok_or_else(|| Refusal::bad_request(format!("{key} must hold e-mail addresses")))
        })
        .collect()
}

/// The checked body.
pub(crate) fn read_body(body: &Value) -> Result<EmailBody, Refusal> {
    if !body.is_object() {
        return Err(Refusal::bad_request("The body must be an object"));
    }
    let text_field = |key: &str, max: usize| -> Result<Option<String>, Refusal> {
        match body.get(key).filter(|v| !v.is_null()) {
            None => Ok(None),
            Some(Value::String(s)) if s.chars().count() <= max => Ok(Some(s.clone())),
            Some(_) => Err(Refusal::bad_request(format!(
                "{key} must be text of at most {max} characters"
            ))),
        }
    };
    let flag = |key: &str| -> Result<bool, Refusal> {
        match body.get(key).filter(|v| !v.is_null()) {
            None => Ok(true),
            Some(Value::Bool(b)) => Ok(*b),
            Some(_) => Err(Refusal::bad_request(format!("{key} must be true or false"))),
        }
    };
    Ok(EmailBody {
        to: addresses(body, "to", true)?,
        cc: addresses(body, "cc", false)?,
        subject: text_field("subject", 300)?,
        body: text_field("body", 10_000)?,
        attach_pdf: flag("attachPdf")?,
        include_link: flag("includeLink")?,
    })
}

fn refusal(error: DeliveryError) -> Refusal {
    match error {
        DeliveryError::NoMail => Refusal::unavailable("E-mail is not set up on this server"),
        DeliveryError::NoLink => Refusal::unavailable(
            "The public document link is not set up (PAY_PORTAL_PUBLIC_URL and a signing key)",
        ),
        DeliveryError::NoRecipient => Refusal::bad_request("to is required"),
        DeliveryError::Database(error) => Refusal::Database(error),
        DeliveryError::Send => Refusal::unavailable("The e-mail could not be sent"),
    }
}

/// What a mail needs before anything is changed for it.
fn check_ready(state: &BooksState, include_link: bool) -> Result<(), Refusal> {
    if state.mail.is_none() {
        return Err(refusal(DeliveryError::NoMail));
    }
    if include_link && Links::of(state).is_none() {
        return Err(refusal(DeliveryError::NoLink));
    }
    Ok(())
}

// ── POST /api/invoices/:id/email ────────────────────────────────────────────

pub(crate) async fn invoice(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let body = read_body(&json_of(&headers, &body)?)?;
        email_invoice(&caller, &state, &id, body).await
    }
    .await;
    reply(result, "Failed to e-mail the invoice")
}

pub(crate) async fn email_invoice(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    body: EmailBody,
) -> Reply {
    let db = &caller.db;
    let Some(row) = load_invoice(db, id).await? else {
        return Err(Refusal::not_found("Invoice", id));
    };
    let status = text(&row, "status").unwrap_or_default().to_owned();
    if status == "cancelled" {
        return Err(Refusal::bad_request(
            "A cancelled invoice cannot be e-mailed",
        ));
    }
    check_ready(state, body.include_link)?;
    // A draft is finalized, a finalized invoice becomes sent: as `PATCH /:id/send` does.
    let row = if status == "draft" || status == "finalized" {
        mark_sent(caller, state, id).await.map_err(Refusal::from)?;
        load_invoice(db, id)
            .await?
            .ok_or_else(|| Refusal::not_found("Invoice", id))?
    } else {
        row
    };
    let credit = text(&row, "type") == Some("credit_note");
    let sent = super::mail_invoices(
        db,
        state,
        &caller.workspace_id,
        InvoiceMail {
            invoices: vec![row.clone()],
            to: body.to,
            cc: body.cc,
            subject: body.subject,
            body: body.body,
            attach_pdf: body.attach_pdf,
            include_link: body.include_link,
            template: if credit { "creditNote" } else { "invoice" }.to_owned(),
            fallback: None,
            history_type: "sent",
            level: None,
            vars: HashMap::new(),
            history_extra: Map::new(),
        },
    )
    .await
    .map_err(refusal)?;
    let current = load_invoice(db, id)
        .await?
        .ok_or_else(|| Refusal::not_found("Invoice", id))?;
    let mut changes = Map::new();
    changes.insert("emailed".into(), change(Value::Null, json!(sent.to.len())));
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: text(&current, "entityId"),
            entity_type: "invoice",
            entity_id: id,
            action: "emailed",
            changes: Some(changes),
        },
    )
    .await;
    let mut data = crate::invoices::event_data(&current, &current["status"]);
    data["recipients"] = json!(sent.to.len());
    caller.publish(state, INVOICE_EMAILED, id, data);
    let mut out = current.as_object().cloned().unwrap_or_default();
    out.insert(
        "delivery".into(),
        json!({ "messageId": sent.message_id, "to": sent.to, "cc": sent.cc, "subject": sent.subject, "link": sent.link }),
    );
    Ok(ok(Value::Object(out)))
}

// ── POST /api/accounting-quotes/:id/email ───────────────────────────────────

pub(crate) async fn quote(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let body = read_body(&json_of(&headers, &body)?)?;
        email_quote(&caller, &state, &id, body).await
    }
    .await;
    reply(result, "Failed to e-mail the quote")
}

#[allow(
    clippy::too_many_lines,
    reason = "claim the send time, build, send, undo on failure"
)]
/// The quote's link is made from the time it was first e-mailed, so sending
/// it again keeps the link the customer already has.
pub(crate) async fn email_quote(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    body: EmailBody,
) -> Reply {
    let db = &caller.db;
    let Some(row) = load_quote(db, id).await? else {
        return Err(Refusal::not_found("Quote", id));
    };
    let (status, can_accept) = view::quote_status(&row, caller.now_ms());
    if matches!(status, "cancelled" | "declined") {
        return Err(Refusal::bad_request("This quote can no longer be sent"));
    }
    let _ = can_accept;
    // The link is always made: a quote is sent to be accepted.
    check_ready(state, true)?;
    let secret = Links::secret(state).ok_or_else(|| refusal(DeliveryError::NoLink))?;
    let links = Links::of(state).ok_or_else(|| refusal(DeliveryError::NoLink))?;
    let Some(entity_id) = default_entity_id_for(db, Some(LegalEntityApp::Weldbooks)).await? else {
        return Err(Refusal::bad_request(
            "No accounting entity to send the quote from",
        ));
    };
    let first_send = row.get("sentAt").is_none_or(Value::is_null);
    let sent_at_row = text(&row, "sentAt").and_then(millis_of);
    let sent_millis = if let Some(millis) = sent_at_row {
        millis
    } else {
        {
            let stamp = utc_now();
            let mut update = crm_quotes::Entity::update_many()
                .col_expr(crm_quotes::Column::SentAt, Expr::value(stamp))
                .col_expr(crm_quotes::Column::UpdatedAt, Expr::value(stamp));
            if text(&row, "status") == Some("draft") {
                update = update.col_expr(crm_quotes::Column::Status, Expr::value("sent"));
            }
            update
                .filter(crm_quotes::Column::Id.eq(id))
                .exec(&orm(db))
                .await?;
            let fresh = load_quote(db, id)
                .await?
                .ok_or_else(|| Refusal::not_found("Quote", id))?;
            text(&fresh, "sentAt")
                .and_then(millis_of)
                .unwrap_or_default()
        }
    };
    let current = load_quote(db, id)
        .await?
        .ok_or_else(|| Refusal::not_found("Quote", id))?;
    let undo = |first: bool| async move {
        if first {
            let _ = crm_quotes::Entity::update_many()
                .col_expr(
                    crm_quotes::Column::SentAt,
                    Expr::value(Option::<time::PrimitiveDateTime>::None),
                )
                .col_expr(
                    crm_quotes::Column::Status,
                    Expr::value(owned(&row, "status").unwrap_or_else(|| "draft".to_owned())),
                )
                .filter(crm_quotes::Column::Id.eq(id))
                .exec(&orm(db))
                .await;
        }
    };
    let Some(doc) =
        view::quote_document(db, &state.keyring, &current, &entity_id, caller.now_ms()).await?
    else {
        undo(first_send).await;
        return Err(Refusal::bad_request(
            "No accounting entity to send the quote from",
        ));
    };
    let url = links.url(&quote_token(&secret, &caller.workspace_id, id, sent_millis));
    let composed = compose(
        &[(&doc, Some(url.clone()))],
        "quote",
        body.subject.as_deref(),
        body.body.as_deref(),
        &HashMap::new(),
        None,
    );
    let Some(transport) = state.mail.clone() else {
        undo(first_send).await;
        return Err(refusal(DeliveryError::NoMail));
    };
    let attach: Vec<&view::Document> = if body.attach_pdf {
        vec![&doc]
    } else {
        Vec::new()
    };
    let to = body.to.clone();
    match transmit(transport.as_ref(), &doc, &composed, &to, &body.cc, &attach).await {
        Ok(sent) => {
            let mut changes = Map::new();
            changes.insert("emailed".into(), change(Value::Null, json!(to.len())));
            weldsuite_books_domain::guards::write_audit(
                db,
                AuditInput {
                    accounting_entity_id: None,
                    entity_type: "quote",
                    entity_id: id,
                    action: "emailed",
                    changes: Some(changes),
                },
                Some(&caller.user_id),
                caller.ip_address().as_deref(),
            )
            .await;
            caller.publish(
                state,
                QUOTE_EMAILED,
                id,
                json!({ "id": id, "quoteNumber": current["quoteNumber"], "status": current["status"], "total": current["total"], "currency": current["currency"], "recipients": to.len() }),
            );
            Ok(ok(json!({
                "id": id,
                "status": current["status"],
                "sentAt": current["sentAt"],
                "delivery": { "messageId": sent.message_id, "to": to, "cc": body.cc, "subject": composed.subject, "link": url },
            })))
        }
        Err(error) => {
            tracing::warn!(%error, "[books] a quote e-mail was refused by the mail transport");
            undo(first_send).await;
            Err(refusal(DeliveryError::Send))
        }
    }
}

// ── Reading a link ──────────────────────────────────────────────────────────

/// `GET /api/invoices/:id/public-link`: `{ url }`, the link as it is now, or
/// `null` when there is none (never e-mailed, revoked, or the install has no
/// portal address or key). Reading never makes a link.
pub(crate) async fn invoice_link(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(row) = load_invoice(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Invoice", &id));
        };
        let url = match (
            Links::of(&state),
            super::link_nonce(&super::history_of(&row)),
        ) {
            (Some(links), Some(nonce)) => {
                Some(links.url(&weldsuite_books_domain::document_token::sign(
                    &links.secret,
                    &weldsuite_books_domain::document_token::DocumentToken::new(
                        &caller.workspace_id,
                        "invoice",
                        &id,
                        &nonce,
                    ),
                )))
            }
            _ => None,
        };
        Ok(ok(json!({ "url": url })))
    }
    .await;
    reply(result, "Failed to read the invoice link")
}

/// `GET /api/accounting-quotes/:id/public-link`: `{ url }` for a quote that
/// was sent (revoking clears `sent_at`), else `null`. Never makes a link.
pub(crate) async fn quote_link(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(row) = load_quote(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Quote", &id));
        };
        let sent = text(&row, "sentAt").and_then(millis_of);
        let url = match (Links::of(&state), sent) {
            (Some(links), Some(sent)) => {
                Some(links.url(&quote_token(&links.secret, &caller.workspace_id, &id, sent)))
            }
            _ => None,
        };
        Ok(ok(json!({ "url": url })))
    }
    .await;
    reply(result, "Failed to read the quote link")
}

// ── Revoking a link ─────────────────────────────────────────────────────────

pub(crate) async fn revoke_invoice_link(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(row) = load_invoice(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Invoice", &id));
        };
        super::append_history(
            &caller.db,
            &id,
            super::entry("link_revoked", json!({})),
            Vec::new(),
        )
        .await?;
        let _ = row;
        Ok(ok(json!({ "id": id, "linkRevoked": true })))
    }
    .await;
    reply(result, "Failed to revoke the invoice link")
}

pub(crate) async fn revoke_quote_link(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        if load_quote(&caller.db, &id).await?.is_none() {
            return Err(Refusal::not_found("Quote", &id));
        }
        crm_quotes::Entity::update_many()
            .col_expr(
                crm_quotes::Column::SentAt,
                Expr::value(Option::<time::PrimitiveDateTime>::None),
            )
            .col_expr(crm_quotes::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(crm_quotes::Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        Ok(ok(json!({ "id": id, "linkRevoked": true })))
    }
    .await;
    reply(result, "Failed to revoke the quote link")
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    fn body(v: &Value) -> Result<EmailBody, Refusal> {
        read_body(v)
    }

    #[test]
    fn the_body_defaults_to_the_link_and_the_pdf() {
        let read = body(&json!({ "to": ["a@example.com"] })).unwrap();
        assert_eq!(read.to, vec!["a@example.com"]);
        assert!(read.attach_pdf && read.include_link);
        assert!(read.cc.is_empty() && read.subject.is_none());
        let read = body(&json!({ "to": [" a@example.com "], "cc": ["b@example.com"], "subject": "S", "body": "B", "attachPdf": false, "includeLink": false })).unwrap();
        assert_eq!(read.to, vec!["a@example.com"]);
        assert_eq!(read.cc, vec!["b@example.com"]);
        assert!(!read.attach_pdf && !read.include_link);
        assert_eq!(read.subject.as_deref(), Some("S"));
    }

    #[test]
    fn a_bad_body_is_refused() {
        for bad in [
            json!({}),
            json!({ "to": [] }),
            json!({ "to": "a@example.com" }),
            json!({ "to": ["nope"] }),
            json!({ "to": ["a@example.com"], "cc": [1] }),
            json!({ "to": ["a@example.com"], "attachPdf": "yes" }),
            json!({ "to": ["a@example.com"], "subject": 5 }),
            json!([]),
            json!({ "to": (0..11).map(|i| format!("a{i}@example.com")).collect::<Vec<_>>() }),
        ] {
            assert!(body(&bad).is_err(), "{bad}");
        }
    }
}
