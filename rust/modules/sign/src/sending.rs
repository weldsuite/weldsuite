//! Sending a request and moving it from one signing group to the next
//! (`packages/domains/sign/src/sending.ts`).
//!
//! Without a signing order every signer is emailed at once. With one,
//! signers with the lowest `routing_order` still pending go first; when the
//! last of a group signs, the next group is emailed (`advance_after_signing`).
//! Copy recipients get nothing until everyone has signed.

use std::collections::HashMap;

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use weldsuite_db::{PgPool, orm};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    sign_documents, sign_envelopes, sign_events, sign_fields, sign_recipients,
};

use crate::envelopes::{json_rows, list_recipients, load_sign_settings, row_json};
use crate::links::{LinkTarget, create_link, revoke_tokens, signing_link};
use crate::mail::{RequestMail, send_requests};
use crate::schedule::{schedule_lifecycle, timestamp};
use crate::{SendContext, SignError, SignResult, millis, text};

/// Why a request, reminder or new link did not go out.
pub(crate) const EMAIL_LIMIT_MESSAGE: &str = "The workspace's email limits do not allow sending this right now. Try again later or contact WeldSuite support.";

/// The member acting, as recorded on the evidence trail (`Actor`).
#[derive(Debug, Clone, Default)]
pub(crate) struct Actor {
    pub(crate) user_id: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) email: Option<String>,
}

/// One row of the evidence trail (`SignEventInput`).
#[derive(Debug, Default)]
pub(crate) struct SignEvent<'a> {
    pub(crate) envelope_id: &'a str,
    pub(crate) recipient_id: Option<&'a str>,
    pub(crate) kind: &'a str,
    pub(crate) actor: Option<&'a Actor>,
    pub(crate) details: Option<Value>,
}

/// Add to the evidence trail (`recordSignEvent`).
pub(crate) async fn record_sign_event(db: &PgPool, event: SignEvent<'_>) -> SignResult<()> {
    let actor = event.actor.cloned().unwrap_or_default();
    sign_events::Entity::insert(sign_events::ActiveModel {
        id: Set(generate_id("sge")),
        envelope_id: Set(event.envelope_id.to_owned()),
        recipient_id: Set(event.recipient_id.map(str::to_owned)),
        type_: Set(event.kind.to_owned()),
        actor_user_id: Set(actor.user_id),
        actor_name: Set(actor.name),
        actor_email: Set(actor.email),
        ip: Set(None),
        user_agent: Set(None),
        details: Set(event.details),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(())
}

/// Everything a request needs before it can go out; the first problem
/// found, or `None` (`sendProblem`).
pub(crate) async fn send_problem(db: &PgPool, envelope_id: &str) -> SignResult<Option<String>> {
    let documents = sign_documents::Entity::find()
        .filter(sign_documents::Column::EnvelopeId.eq(envelope_id))
        .count(&orm(db))
        .await?;
    let recipients = list_recipients(db, envelope_id).await?;
    let fields: Vec<(Option<String>, String)> = sign_fields::Entity::find()
        .select_only()
        .columns([sign_fields::Column::RecipientId, sign_fields::Column::Type])
        .filter(sign_fields::Column::EnvelopeId.eq(envelope_id))
        .into_tuple()
        .all(&orm(db))
        .await?;
    if documents == 0 {
        return Ok(Some("Add at least one document".to_owned()));
    }
    let signers: Vec<&Value> = recipients
        .iter()
        .filter(|r| r["role"] == "signer")
        .collect();
    if signers.is_empty() {
        return Ok(Some("Add at least one signer".to_owned()));
    }
    if recipients.iter().any(|r| text(r, "email").is_empty()) {
        return Ok(Some("Every recipient needs an email address".to_owned()));
    }
    for signer in signers {
        let id = text(signer, "id");
        let has = fields
            .iter()
            .any(|(recipient, kind)| recipient.as_deref() == Some(id) && kind == "signature");
        if !has {
            let who = crate::or_else(&signer["name"], &signer["email"]);
            return Ok(Some(format!(
                "{} has no signature field",
                who.as_str().unwrap_or_default()
            )));
        }
    }
    Ok(None)
}

/// Signers to email now: the lowest pending routing group, or every pending
/// signer without an order (`nextGroup`).
pub(crate) fn next_group(signing_order: bool, recipients: &[Value]) -> Vec<Value> {
    let pending: Vec<&Value> = recipients
        .iter()
        .filter(|r| r["role"] == "signer" && r["status"] == "pending")
        .collect();
    if !signing_order || pending.is_empty() {
        return pending.into_iter().cloned().collect();
    }
    let first = pending
        .iter()
        .filter_map(|r| r["routingOrder"].as_i64())
        .min()
        .unwrap_or(0);
    pending
        .into_iter()
        .filter(|r| r["routingOrder"].as_i64() == Some(first))
        .cloned()
        .collect()
}

/// What [`mail_new_links`] did.
pub(crate) enum Mailed {
    /// The outbound guard said no; the new links were taken back.
    Refused,
    Sent {
        /// Addresses the mail went out to.
        sent: Vec<String>,
        /// The new link token per recipient id.
        tokens: HashMap<String, String>,
    },
}

/// Create a fresh link for each recipient and email it: a signing request,
/// or a reminder. A refusal takes the new links back, so nothing changed
/// (`mailNewLinks`).
pub(crate) async fn mail_new_links(
    ctx: &SendContext,
    envelope: &Value,
    recipients: &[Value],
    reminder: bool,
) -> SignResult<Mailed> {
    let mut tokens = HashMap::new();
    let mut ordered = Vec::with_capacity(recipients.len());
    for recipient in recipients {
        let token = create_link(
            &ctx.master,
            &LinkTarget {
                workspace_id: &ctx.workspace_id,
                clerk_org_id: &ctx.clerk_org_id,
                envelope_id: text(envelope, "id"),
                recipient_id: text(recipient, "id"),
                expires_at: timestamp(&envelope["expiresAt"]),
            },
        )
        .await?;
        ordered.push(token.clone());
        tokens.insert(text(recipient, "id").to_owned(), token);
    }
    let portal = ctx.services.portal_url.as_deref();
    let mails: Vec<RequestMail<'_>> = recipients
        .iter()
        .zip(&ordered)
        .map(|(recipient, token)| RequestMail {
            recipient,
            url: signing_link(portal, token),
        })
        .collect();
    match send_requests(ctx, envelope, &mails, reminder).await? {
        None => {
            revoke_tokens(&ctx.master, &ordered).await?;
            Ok(Mailed::Refused)
        }
        Some(sent) => Ok(Mailed::Sent { sent, tokens }),
    }
}

/// `{ email, delivered }` for an evidence row about one recipient.
pub(crate) fn delivery(recipient: &Value, sent: &[String]) -> (Value, bool) {
    let email = recipient["email"].clone();
    let delivered = sent.iter().any(|s| s == text(recipient, "email"));
    (email, delivered)
}

/// Create links for `group`, email them, and mark them sent; `false` when
/// the outbound guard said no (`emailGroup`).
async fn email_group(
    ctx: &SendContext,
    envelope: &Value,
    group: &[Value],
    actor: Option<&Actor>,
) -> SignResult<bool> {
    if group.is_empty() {
        return Ok(true);
    }
    let Mailed::Sent { sent, .. } = mail_new_links(ctx, envelope, group, false).await? else {
        return Ok(false);
    };
    let now = crate::now();
    // Not over a signer who already opened the link (or signed) while the
    // mail went out.
    sign_recipients::Entity::update_many()
        .col_expr(sign_recipients::Column::Status, Expr::value("sent"))
        .col_expr(sign_recipients::Column::SentAt, Expr::value(now))
        .col_expr(sign_recipients::Column::UpdatedAt, Expr::value(now))
        .filter(sign_recipients::Column::Id.is_in(group.iter().map(|r| text(r, "id"))))
        .filter(sign_recipients::Column::Status.is_in(["pending", "sent"]))
        .exec(&orm(&ctx.db))
        .await?;
    for recipient in group {
        let (email, delivered) = delivery(recipient, &sent);
        record_sign_event(
            &ctx.db,
            SignEvent {
                envelope_id: text(envelope, "id"),
                recipient_id: Some(text(recipient, "id")),
                kind: "sent",
                actor,
                details: Some(json!({ "email": email, "delivered": delivered })),
            },
        )
        .await?;
    }
    Ok(true)
}

/// Send a draft (`sendEnvelope`). Checks it is complete, sets its expiry,
/// and emails the first signing group; a refusal by the outbound guard
/// changes nothing.
///
/// Global also counts the request against the plan's monthly allowance
/// (`meterUsage`, the `USAGE_METER` Durable Object). The Kubernetes editions
/// have no billing yet, so this behaves as the workers do without that
/// binding: allowed, uncounted.
#[allow(
    clippy::too_many_lines,
    reason = "one send, in order: checks, the eIDAS charge and its give-backs, mail, the status flip"
)]
pub(crate) async fn send_envelope(
    ctx: &SendContext,
    draft: &Value,
    actor: &Actor,
    expires_at: Option<&str>,
) -> SignResult<Value> {
    if text(draft, "status") != "draft" {
        return Err(SignError::not_a_draft());
    }
    let id = text(draft, "id");
    if let Some(problem) = send_problem(&ctx.db, id).await? {
        return Err(SignError::invalid(problem));
    }
    let now = OffsetDateTime::now_utc();
    let expiry = match expires_at.filter(|e| !e.is_empty()) {
        Some(picked) => Some(
            OffsetDateTime::parse(picked, &Rfc3339)
                .map_err(|_| SignError::invalid("The expiry date must be in the future"))?,
        ),
        None => load_sign_settings(&ctx.db)
            .await?
            .expiry_days
            .filter(|d| *d != 0)
            .map(|d| now + time::Duration::days(i64::from(d))),
    };
    if let Some(expiry) = expiry
        && expiry <= now
    {
        return Err(SignError::invalid("The expiry date must be in the future"));
    }
    let expiry = expiry.map(millis);
    let expiry_text = expiry.map(iso_timestamp);
    let recipients = list_recipients(&ctx.db, id).await?;
    let mut envelope = draft.clone();
    envelope["expiresAt"] = expiry_text.clone().map_or(Value::Null, Value::from);
    let signing_order = draft["signingOrderEnabled"].as_bool().unwrap_or(false);

    // AES/QES signers (plan weldsign-eidas): the prepared PDF and the credits,
    // before anyone is emailed; given back if the emails don't go out.
    let prepared = crate::eidas::prepare_for_send(ctx, draft, &recipients).await?;
    let give_back = || async {
        if let Some(prepared) = &prepared {
            crate::eidas::give_back(ctx, id, prepared.credits, prepared.ledger_key.as_deref())
                .await;
        }
    };

    let group = next_group(signing_order, &recipients);
    match email_group(ctx, &envelope, &group, Some(actor)).await {
        Ok(true) => {}
        Ok(false) => {
            give_back().await;
            return Err(SignError::invalid(EMAIL_LIMIT_MESSAGE));
        }
        Err(error) => {
            give_back().await;
            return Err(error);
        }
    }

    let now = crate::now();
    // Only a draft is sent, once. A prepared request's PDF and credits are
    // set in the same statement, so of two racing sends only the winner's
    // stand; the loser gives its charge back.
    let mut update = sign_envelopes::Entity::update_many()
        .col_expr(sign_envelopes::Column::Status, Expr::value("sent"))
        .col_expr(sign_envelopes::Column::SentAt, Expr::value(now))
        .col_expr(sign_envelopes::Column::ExpiresAt, Expr::value(expiry))
        .col_expr(sign_envelopes::Column::UpdatedAt, Expr::value(now));
    if let Some(prepared) = &prepared {
        update = crate::eidas::with_prepared(update, prepared);
    }
    let sent = match update
        .filter(sign_envelopes::Column::Id.eq(id))
        .filter(sign_envelopes::Column::Status.eq("draft"))
        .exec_with_returning(&orm(&ctx.db))
        .await
    {
        Ok(rows) => rows.into_iter().next(),
        Err(error) => {
            give_back().await;
            return Err(error.into());
        }
    };
    if sent.is_none() {
        give_back().await;
    }
    let recorded = record_sign_event(
        &ctx.db,
        SignEvent {
            envelope_id: id,
            kind: "sent",
            actor: Some(actor),
            details: Some(
                json!({ "expiresAt": expiry_text, "signingOrder": draft["signingOrderEnabled"] }),
            ),
            ..SignEvent::default()
        },
    )
    .await;
    if let Err(error) = recorded {
        if sent.is_some() {
            give_back().await;
        }
        return Err(error);
    }
    // Only the send that won: the charge per signer on the trail, which the
    // refunds read. Without it they could not be worked out, so a failed
    // write gives the whole charge back.
    if let (Some(prepared), Some(_)) = (&prepared, &sent)
        && let Err(error) = crate::eidas::record_prepared(ctx, id, prepared).await
    {
        tracing::error!(
            ?error,
            envelope_id = id,
            "sign: the prepared event was not written; credits given back"
        );
        give_back().await;
    }
    schedule_lifecycle(ctx).await;
    match sent {
        Some(sent) => Ok(row_json(sent)?),
        None => Err(SignError::Internal(format!(
            "sign: draft {id} changed while it was sent"
        ))),
    }
}

/// Mark `group` sent, only where it is still pending; the rows this call
/// flipped are its to mail (`claimGroup`).
async fn claim_group(db: &PgPool, group: &[Value]) -> SignResult<Vec<Value>> {
    if group.is_empty() {
        return Ok(Vec::new());
    }
    let now = crate::now();
    // Only where still pending: the rows flipped here are this call's.
    let rows = sign_recipients::Entity::update_many()
        .col_expr(sign_recipients::Column::Status, Expr::value("sent"))
        .col_expr(sign_recipients::Column::SentAt, Expr::value(now))
        .col_expr(sign_recipients::Column::UpdatedAt, Expr::value(now))
        .filter(sign_recipients::Column::Id.is_in(group.iter().map(|r| text(r, "id"))))
        .filter(sign_recipients::Column::Status.eq("pending"))
        .exec_with_returning(&orm(db))
        .await?;
    json_rows(rows)
}

/// Undo [`claim_group`] when the group could not be mailed (`releaseGroup`).
async fn release_group(db: &PgPool, group: &[Value]) -> SignResult<()> {
    if group.is_empty() {
        return Ok(());
    }
    sign_recipients::Entity::update_many()
        .col_expr(sign_recipients::Column::Status, Expr::value("pending"))
        .col_expr(
            sign_recipients::Column::SentAt,
            Expr::value(Option::<OffsetDateTime>::None),
        )
        .col_expr(
            sign_recipients::Column::UpdatedAt,
            Expr::value(crate::now()),
        )
        .filter(sign_recipients::Column::Id.is_in(group.iter().map(|r| text(r, "id"))))
        .filter(sign_recipients::Column::Status.eq("sent"))
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// Where a request stands after a signature (`advanceAfterSigning`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Advance {
    Waiting,
    NextGroup,
    AllSigned,
}

/// After a signature: email the next signing group, or report that every
/// signer is done (the caller then finalizes the request).
pub(crate) async fn advance_after_signing(
    ctx: &SendContext,
    envelope: &Value,
) -> SignResult<Advance> {
    let recipients = list_recipients(&ctx.db, text(envelope, "id")).await?;
    let signers: Vec<&Value> = recipients
        .iter()
        .filter(|r| r["role"] == "signer")
        .collect();
    if signers.iter().all(|r| r["status"] == "signed") {
        return Ok(Advance::AllSigned);
    }
    if signers
        .iter()
        .any(|r| r["status"] == "sent" || r["status"] == "opened")
    {
        return Ok(Advance::Waiting);
    }
    let signing_order = envelope["signingOrderEnabled"].as_bool().unwrap_or(false);
    let next = next_group(signing_order, &recipients);
    let group = claim_group(&ctx.db, &next).await?;
    if group.len() < next.len() {
        release_group(&ctx.db, &group).await?;
        return Ok(Advance::Waiting);
    }
    match email_group(ctx, envelope, &group, None).await {
        Ok(true) => {}
        Ok(false) => {
            release_group(&ctx.db, &group).await?;
            tracing::warn!(
                envelope_id = text(envelope, "id"),
                "sign: next signing group refused by the outbound guard"
            );
            return Ok(Advance::Waiting);
        }
        Err(error) => {
            release_group(&ctx.db, &group).await?;
            return Err(error);
        }
    }
    schedule_lifecycle(ctx).await;
    Ok(Advance::NextGroup)
}

/// Every signer has signed but the request is not completed: finalizing
/// has not finished, or never started (the caller may start it again; the
/// job's steps are idempotent) (`awaitingFinalize`).
pub(crate) async fn awaiting_finalize(db: &PgPool, envelope: &Value) -> SignResult<bool> {
    if envelope["status"] != "sent" && envelope["status"] != "in_progress" {
        return Ok(false);
    }
    let statuses: Vec<String> = sign_recipients::Entity::find()
        .select_only()
        .column(sign_recipients::Column::Status)
        .filter(sign_recipients::Column::EnvelopeId.eq(text(envelope, "id")))
        .filter(sign_recipients::Column::Role.eq("signer"))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(!statuses.is_empty() && statuses.iter().all(|status| status == "signed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_group_takes_the_lowest_pending_order() {
        let r = |id: &str, order: i64, status: &str| json!({ "id": id, "role": "signer", "routingOrder": order, "status": status });
        let cc = json!({ "id": "c", "role": "cc", "routingOrder": 1, "status": "pending" });
        let all = vec![
            r("a", 2, "pending"),
            r("b", 1, "signed"),
            r("d", 3, "pending"),
            cc,
        ];
        let ids = |group: Vec<Value>| -> Vec<String> {
            group.iter().map(|v| text(v, "id").to_owned()).collect()
        };
        assert_eq!(ids(next_group(true, &all)), vec!["a"]);
        assert_eq!(ids(next_group(false, &all)), vec!["a", "d"]);
    }
}
