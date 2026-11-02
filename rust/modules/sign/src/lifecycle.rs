//! A sent request's lifecycle (`packages/domains/sign/src/lifecycle.ts`) and
//! its routes (`apps/workers/sign-api/src/routes/envelopes/lifecycle.ts`,
//! and resend and correct from `recipients.ts`):
//!
//! - `POST /:id/send`: send a draft (`{ expiresAt? }`); 400 when it is not
//!   complete or the workspace's email limits refuse it
//! - `GET /:id/download`: the signed PDF with its certificate
//! - `POST /:id/void`: stop an open request (`{ reason }`); its links stop
//! - `POST /:id/remind`: remind every signer whose turn it is; 409 when all
//!   were emailed in the last hour
//! - `POST /:id/signing-link`: a fresh link for the caller's own turn
//! - `POST /:id/recipients/:recipientId/resend` and `/correct`
//!
//! Void, remind, resend and correct are for the request's owner; anyone else
//! gets a 404. A request that no longer collects signatures answers 409.
//! Everything that mails a link goes through `mail_new_links`, so the
//! outbound guard counts it and a refusal changes nothing. Voiding and expiry
//! revoke every link of the request at once. The scheduled parts (expiry,
//! automatic reminders) run in the lifecycle sweep (`crate::sweep`).

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS};
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{SIGN_ENVELOPE_SENT, SIGN_ENVELOPE_VOIDED};
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Format, Presence, Text};
use weldsuite_kit::{ApiError, Data};

use crate::envelopes::{
    detail_for, event_data, is_open_request, is_open_request_at, list_recipients, load_draft,
    load_envelope, load_own_envelope, member_profile, publish_updated, recipient_dto,
    touch_envelope, viewer_of,
};
use crate::links::{
    LinkTarget, create_link, revoke_envelope_links, revoke_recipient_links, signing_link,
};
use crate::mail::{pdf_file_name, send_expired, send_voided};
use crate::recipients::{EMAIL, NAME};
use crate::schedule::{
    all_signed, is_current_signer, next_reminder_at, open_requests, schedule_lifecycle, timestamp,
};
use crate::sending::{
    Actor, EMAIL_LIMIT_MESSAGE, Mailed, SignEvent, delivery, mail_new_links, record_sign_event,
    send_envelope,
};
use crate::{Caller, SendContext, SignError, SignResult, SignState, answer, text, validate};

/// Someone emailed (a link or a reminder) this recently is not reminded
/// again by hand.
const MANUAL_REMIND_GAP: time::Duration = time::Duration::hours(1);

fn closed() -> SignError {
    SignError::Conflict("This request is no longer open".to_owned())
}

fn conflict(message: &str) -> SignError {
    SignError::Conflict(message.to_owned())
}

/// The member acting (`actorOf(c)`).
pub(crate) async fn actor_of(caller: &Caller) -> SignResult<Actor> {
    if caller.user_id.is_empty() {
        return Ok(Actor::default());
    }
    let (name, email) = member_profile(&caller.db, &caller.user_id).await?;
    Ok(Actor {
        user_id: Some(caller.user_id.clone()),
        name,
        email,
    })
}

/// The request's recipients, or a conflict when it no longer collects
/// signatures (`openRecipients`).
async fn open_recipients(ctx: &SendContext, envelope: &Value) -> SignResult<Vec<Value>> {
    if !is_open_request(envelope) {
        return Err(closed());
    }
    let recipients = list_recipients(&ctx.db, text(envelope, "id")).await?;
    let signers: Vec<&Value> = recipients
        .iter()
        .filter(|r| r["role"] == "signer")
        .collect();
    if all_signed(&signers) {
        return Err(conflict(
            "Everyone has signed; the signed document is being prepared",
        ));
    }
    Ok(recipients)
}

// ── Void ───────────────────────────────────────────────────────────────────

/// Stop an open request: its links stop at once, and signers who got it hear
/// why (`voidRequest`).
async fn void_request(
    ctx: &SendContext,
    envelope: &Value,
    actor: &Actor,
    reason: &str,
) -> SignResult<Value> {
    let recipients = open_recipients(ctx, envelope).await?;
    let id = text(envelope, "id");
    let now = crate::now();
    let voided: Option<Value> = sqlx::query_scalar(
        "update sign_envelopes
         set status = 'voided', voided_at = $2::timestamptz, voided_reason = $3, updated_at = $2::timestamptz
         where id = $1 and status in ('sent', 'in_progress')
         returning to_jsonb(sign_envelopes)",
    )
    .bind(id)
    .bind(&now)
    .bind(reason)
    .fetch_optional(&ctx.db)
    .await?;
    let voided = js_row(voided.ok_or_else(closed)?);
    revoke_envelope_links(&ctx.master, &ctx.workspace_id, id).await?;
    record_sign_event(
        &ctx.db,
        SignEvent {
            envelope_id: id,
            kind: "voided",
            actor: Some(actor),
            details: Some(json!({ "reason": reason })),
            ..SignEvent::default()
        },
    )
    .await?;
    // Signers still waiting for their turn never heard of the request.
    let told: Vec<&Value> = recipients
        .iter()
        .filter(|r| r["role"] == "signer" && r["status"] != "pending")
        .collect();
    send_voided(ctx, &voided, &told, reason).await?;
    Ok(voided)
}

// ── Reminders and new links ────────────────────────────────────────────────

async fn mark_reminded(
    ctx: &SendContext,
    ids: &[String],
    at: &str,
    automatic: bool,
) -> SignResult<()> {
    sqlx::query(
        "update sign_recipients
         set last_reminded_at = $2::timestamptz, updated_at = $2::timestamptz,
             reminders_sent = case when $3 then reminders_sent + 1 else reminders_sent end
         where id = any($1)",
    )
    .bind(ids)
    .bind(at)
    .bind(automatic)
    .execute(&ctx.db)
    .await?;
    Ok(())
}

fn ids_of(recipients: &[Value]) -> Vec<String> {
    recipients
        .iter()
        .map(|r| text(r, "id").to_owned())
        .collect()
}

/// Remind every signer whose turn it is and who was not emailed in the last
/// hour; how many (`remindNow`).
async fn remind_now(ctx: &SendContext, envelope: &Value, actor: &Actor) -> SignResult<usize> {
    let recipients = open_recipients(ctx, envelope).await?;
    let cutoff = OffsetDateTime::now_utc() - MANUAL_REMIND_GAP;
    let due: Vec<Value> = recipients
        .into_iter()
        .filter(|r| {
            let last = timestamp(&r["lastRemindedAt"])
                .or_else(|| timestamp(&r["sentAt"]))
                .unwrap_or(OffsetDateTime::UNIX_EPOCH);
            is_current_signer(r) && last <= cutoff
        })
        .collect();
    if due.is_empty() {
        return Err(conflict(
            "Everyone whose turn it is was emailed less than an hour ago",
        ));
    }
    let Mailed::Sent { sent, .. } = mail_new_links(ctx, envelope, &due, true).await? else {
        return Err(SignError::invalid(EMAIL_LIMIT_MESSAGE));
    };
    mark_reminded(ctx, &ids_of(&due), &crate::now(), false).await?;
    for recipient in &due {
        let (email, delivered) = delivery(recipient, &sent);
        record_sign_event(
            &ctx.db,
            SignEvent {
                envelope_id: text(envelope, "id"),
                recipient_id: Some(text(recipient, "id")),
                kind: "reminded",
                actor: Some(actor),
                details: Some(
                    json!({ "email": email, "automatic": false, "delivered": delivered }),
                ),
            },
        )
        .await?;
    }
    Ok(due.len())
}

/// Email one signer whose turn it is a new link; their earlier links keep
/// working (`resendLink`).
async fn resend_link(
    ctx: &SendContext,
    envelope: &Value,
    recipient_id: &str,
    actor: &Actor,
) -> SignResult<Value> {
    let recipients = open_recipients(ctx, envelope).await?;
    let recipient = recipients
        .into_iter()
        .find(|r| r["id"] == recipient_id)
        .ok_or(SignError::NotFound("Recipient"))?;
    if !is_current_signer(&recipient) {
        return Err(conflict(
            "Only a signer whose turn it is can get a new link",
        ));
    }
    let Mailed::Sent { sent, .. } =
        mail_new_links(ctx, envelope, std::slice::from_ref(&recipient), false).await?
    else {
        return Err(SignError::invalid(EMAIL_LIMIT_MESSAGE));
    };
    let row: Value = sqlx::query_scalar(
        "update sign_recipients set last_reminded_at = $2::timestamptz, updated_at = $2::timestamptz
         where id = $1 returning to_jsonb(sign_recipients)",
    )
    .bind(text(&recipient, "id"))
    .bind(crate::now())
    .fetch_one(&ctx.db)
    .await?;
    let (email, delivered) = delivery(&recipient, &sent);
    record_sign_event(
        &ctx.db,
        SignEvent {
            envelope_id: text(envelope, "id"),
            recipient_id: Some(text(&recipient, "id")),
            kind: "resent",
            actor: Some(actor),
            details: Some(json!({ "email": email, "delivered": delivered })),
        },
    )
    .await?;
    Ok(js_row(row))
}

/// `correctRecipientSchema`, read.
struct Correction {
    name: Option<String>,
    email: String,
}

/// Fix a recipient's name or email (`correctRecipient`). A new email revokes
/// their old links; a signer whose turn it is gets a new link at the new
/// address first (so a refusal by the outbound guard changes nothing) and
/// starts over: not opened, no reminders yet, and consent asked again.
async fn correct_recipient(
    ctx: &SendContext,
    envelope: &Value,
    recipient_id: &str,
    input: &Correction,
    actor: &Actor,
) -> SignResult<Value> {
    let recipients = open_recipients(ctx, envelope).await?;
    let recipient = recipients
        .iter()
        .find(|r| r["id"] == recipient_id)
        .cloned()
        .ok_or(SignError::NotFound("Recipient"))?;
    if matches!(text(&recipient, "status"), "signed" | "declined") {
        return Err(conflict(
            "A recipient who has signed or declined cannot be changed",
        ));
    }
    let name = input
        .name
        .clone()
        .map_or_else(|| recipient["name"].clone(), Value::from);
    let email = input.email.as_str();
    let email_changed = recipient["email"].as_str() != Some(email);
    if !email_changed && name == recipient["name"] {
        return Err(SignError::invalid("Nothing changed"));
    }
    if email_changed
        && recipients
            .iter()
            .any(|r| r["id"] != recipient["id"] && r["email"].as_str() == Some(email))
    {
        return Err(SignError::invalid(format!(
            "{email} is already a recipient of this envelope"
        )));
    }

    let restart = email_changed && is_current_signer(&recipient);
    let mut keep = None;
    if restart {
        let mut renamed = recipient.clone();
        renamed["name"] = name.clone();
        renamed["email"] = Value::from(email);
        let Mailed::Sent { tokens, .. } = mail_new_links(ctx, envelope, &[renamed], false).await?
        else {
            return Err(SignError::invalid(EMAIL_LIMIT_MESSAGE));
        };
        keep = tokens.get(recipient_id).cloned();
    }
    if email_changed {
        revoke_recipient_links(
            &ctx.master,
            &ctx.workspace_id,
            text(envelope, "id"),
            recipient_id,
            keep.as_deref(),
        )
        .await?;
    }
    let row: Value = sqlx::query_scalar(
        "update sign_recipients
         set name = $2, email = $3, updated_at = $5::timestamptz,
             status = case when $4 then 'sent' else status end,
             sent_at = case when $4 then $5::timestamptz else sent_at end,
             opened_at = case when $4 then null else opened_at end,
             last_reminded_at = case when $4 then null else last_reminded_at end,
             reminders_sent = case when $4 then 0 else reminders_sent end
         where id = $1 returning to_jsonb(sign_recipients)",
    )
    .bind(recipient_id)
    .bind(name.as_str())
    .bind(email)
    .bind(restart)
    .bind(crate::now())
    .fetch_one(&ctx.db)
    .await?;
    record_sign_event(
        &ctx.db,
        SignEvent {
            envelope_id: text(envelope, "id"),
            recipient_id: Some(recipient_id),
            kind: "recipient_corrected",
            actor: Some(actor),
            details: Some(json!({
                "from": recipient["email"],
                "to": email,
                "fromName": recipient["name"],
                "toName": name,
                "newLink": restart,
            })),
        },
    )
    .await?;
    if restart {
        schedule_lifecycle(ctx).await;
    }
    Ok(js_row(row))
}

/// A fresh link for a member whose turn it is to sign, by their email, for
/// "Sign now" (`memberSigningLink`).
async fn member_signing_link(
    ctx: &SendContext,
    envelope: &Value,
    email: Option<&str>,
) -> SignResult<String> {
    let not_your_turn = || conflict("It is not your turn to sign this request");
    let Some(email) = email.filter(|e| !e.is_empty()) else {
        return Err(not_your_turn());
    };
    if !is_open_request(envelope) {
        return Err(not_your_turn());
    }
    let recipient: Option<String> = sqlx::query_scalar(
        "select id from sign_recipients
         where envelope_id = $1 and email = $2 and role = 'signer' and status in ('sent', 'opened')
         limit 1",
    )
    .bind(text(envelope, "id"))
    .bind(email)
    .fetch_optional(&ctx.db)
    .await?;
    let recipient = recipient.ok_or_else(not_your_turn)?;
    let token = create_link(
        &ctx.master,
        &LinkTarget {
            workspace_id: &ctx.workspace_id,
            clerk_org_id: &ctx.clerk_org_id,
            envelope_id: text(envelope, "id"),
            recipient_id: &recipient,
            expires_at: envelope["expiresAt"].as_str(),
        },
    )
    .await?;
    Ok(signing_link(ctx.services.portal_url.as_deref(), &token))
}

// ── Scheduled: expiry and automatic reminders ──────────────────────────────

/// Close open requests whose expiry has passed: status `expired`, every link
/// revoked, the sender told who had not signed. A request where everyone
/// signed is left to finalizing (`expireDue`).
pub(crate) async fn expire_due(ctx: &SendContext, now: OffsetDateTime) -> SignResult<Vec<Value>> {
    let at = weldsuite_events::iso_timestamp(now);
    let due: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(e) from sign_envelopes e
         where kind = 'envelope' and status in ('sent', 'in_progress') and deleted_at is null
           and expires_at <= $1::timestamptz",
    )
    .bind(&at)
    .fetch_all(&ctx.db)
    .await?;
    let mut expired = Vec::new();
    for envelope in due.into_iter().map(js_row) {
        let id = text(&envelope, "id");
        let recipients = list_recipients(&ctx.db, id).await?;
        let signers: Vec<&Value> = recipients
            .iter()
            .filter(|r| r["role"] == "signer")
            .collect();
        if all_signed(&signers) {
            continue;
        }
        let row: Option<Value> = sqlx::query_scalar(
            "update sign_envelopes set status = 'expired', updated_at = $2::timestamptz
             where id = $1 and status in ('sent', 'in_progress')
             returning to_jsonb(sign_envelopes)",
        )
        .bind(id)
        .bind(&at)
        .fetch_optional(&ctx.db)
        .await?;
        let Some(row) = row.map(js_row) else {
            continue;
        };
        revoke_envelope_links(&ctx.master, &ctx.workspace_id, id).await?;
        record_sign_event(
            &ctx.db,
            SignEvent {
                envelope_id: id,
                kind: "expired",
                details: Some(json!({ "expiresAt": envelope["expiresAt"] })),
                ..SignEvent::default()
            },
        )
        .await?;
        let unsigned: Vec<String> = signers
            .iter()
            .filter(|s| s["status"] != "signed")
            .map(|s| {
                crate::or_else(&s["name"], &s["email"])
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()
            })
            .filter(|n| !n.is_empty())
            .collect();
        send_expired(ctx, &row, &unsigned).await;
        expired.push(row);
    }
    Ok(expired)
}

/// Send the automatic reminders that are due; how many signers were
/// reminded (`sendDueReminders`).
pub(crate) async fn send_due_reminders(
    ctx: &SendContext,
    now: OffsetDateTime,
) -> SignResult<usize> {
    let mut reminded = 0;
    let at = weldsuite_events::iso_timestamp(now);
    for (envelope, signers) in open_requests(&ctx.db).await? {
        let refs: Vec<&Value> = signers.iter().collect();
        if !is_open_request_at(&envelope, now) || all_signed(&refs) {
            continue;
        }
        let due: Vec<Value> = signers
            .iter()
            .filter(|s| next_reminder_at(&envelope, s).is_some_and(|due| due <= now))
            .cloned()
            .collect();
        if due.is_empty() {
            continue;
        }
        let Mailed::Sent { sent, .. } = mail_new_links(ctx, &envelope, &due, true).await? else {
            // Try again a full interval later rather than on every tick; it
            // does not count.
            tracing::warn!(
                envelope_id = text(&envelope, "id"),
                "sign: reminders refused by the outbound guard"
            );
            mark_reminded(ctx, &ids_of(&due), &at, false).await?;
            continue;
        };
        mark_reminded(ctx, &ids_of(&due), &at, true).await?;
        for signer in &due {
            let (email, delivered) = delivery(signer, &sent);
            record_sign_event(
                &ctx.db,
                SignEvent {
                    envelope_id: text(&envelope, "id"),
                    recipient_id: Some(text(signer, "id")),
                    kind: "reminded",
                    details: Some(
                        json!({ "email": email, "automatic": true, "delivered": delivered }),
                    ),
                    ..SignEvent::default()
                },
            )
            .await?;
        }
        reminded += due.len();
    }
    Ok(reminded)
}

// ── Routes ─────────────────────────────────────────────────────────────────

/// `POST /:id/send` (`sendEnvelopeSchema`).
pub(crate) async fn send(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let expires_at = validate(&headers, &body, |issues, fields| {
                issues.text_with(
                    fields,
                    "expiresAt",
                    Presence::Nullish,
                    Text {
                        format: Some(Format::DatetimeOffset),
                        ..Text::default()
                    },
                )
            })?;
            let viewer = viewer_of(&caller).await?;
            let draft = load_draft(&caller.db, &id, &viewer).await?;
            let ctx = caller.send_context(&state)?;
            let actor = actor_of(&caller).await?;
            let sent = send_envelope(
                &ctx,
                &draft,
                &actor,
                expires_at.as_set().map(String::as_str),
            )
            .await?;
            caller.publish(
                &state,
                SIGN_ENVELOPE_SENT,
                text(&sent, "id"),
                &event_data(&sent),
            );
            Ok(Data(detail_for(&caller, &sent, Some(viewer)).await?).into_response())
        }
        .await,
    )
}

/// `GET /:id/download`: the signed PDF.
pub(crate) async fn download(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let viewer = viewer_of(&caller).await?;
            let envelope = load_envelope(&caller.db, &id, &viewer).await?;
            let key = text(&envelope, "finalStorageKey");
            if text(&envelope, "status") != "completed" || key.is_empty() {
                return Err(conflict("The request has not been signed by everyone yet"));
            }
            let files = caller
                .files(&state)
                .ok_or_else(|| SignError::Internal("sign: no file storage".to_owned()))?;
            let object = files
                .private
                .get_boxed(key)
                .await
                .map_err(|error| SignError::Internal(error.to_string()))?;
            let Some(object) = object else {
                return Ok(
                    ApiError::not_found("Signed document", Some(text(&envelope, "id")))
                        .into_response(),
                );
            };
            let filename = pdf_file_name(text(&envelope, "title")).replace('"', "");
            let disposition =
                HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
                    .unwrap_or_else(|_| HeaderValue::from_static("attachment"));
            let mut response = (StatusCode::OK, object.bytes).into_response();
            let headers = response.headers_mut();
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/pdf"));
            headers.insert(CONTENT_DISPOSITION, disposition);
            headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
            headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
            Ok(response)
        }
        .await,
    )
}

/// `POST /:id/void` (`voidEnvelopeSchema`).
pub(crate) async fn void(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let reason = validate(&headers, &body, |issues, fields| {
                issues.text_with(
                    fields,
                    "reason",
                    Presence::Required,
                    Text::trimmed(Some(1), Some(1000)),
                )
            })?
            .into_option()
            .unwrap_or_default();
            let viewer = viewer_of(&caller).await?;
            let envelope = load_own_envelope(&caller.db, &id, &viewer).await?;
            let ctx = caller.send_context(&state)?;
            let actor = actor_of(&caller).await?;
            let voided = void_request(&ctx, &envelope, &actor, &reason).await?;
            caller.publish(
                &state,
                SIGN_ENVELOPE_VOIDED,
                text(&voided, "id"),
                &event_data(&voided),
            );
            Ok(Data(detail_for(&caller, &voided, Some(viewer)).await?).into_response())
        }
        .await,
    )
}

/// `POST /:id/remind`.
pub(crate) async fn remind(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let viewer = viewer_of(&caller).await?;
            let envelope = load_own_envelope(&caller.db, &id, &viewer).await?;
            let ctx = caller.send_context(&state)?;
            let actor = actor_of(&caller).await?;
            let reminded = remind_now(&ctx, &envelope, &actor).await?;
            publish_updated(&caller, &state, &envelope);
            Ok(Data(json!({ "reminded": reminded })).into_response())
        }
        .await,
    )
}

/// `POST /:id/signing-link`.
pub(crate) async fn signing_link_route(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let viewer = viewer_of(&caller).await?;
            let envelope = load_envelope(&caller.db, &id, &viewer).await?;
            let ctx = caller.send_context(&state)?;
            let url = member_signing_link(&ctx, &envelope, viewer.email.as_deref()).await?;
            Ok(Data(json!({ "url": url })).into_response())
        }
        .await,
    )
}

/// `POST /:id/recipients/:recipientId/resend`.
pub(crate) async fn resend(
    State(state): State<SignState>,
    caller: Caller,
    Path((id, recipient_id)): Path<(String, String)>,
) -> Response {
    answer(
        async {
            let viewer = viewer_of(&caller).await?;
            let envelope = load_own_envelope(&caller.db, &id, &viewer).await?;
            let ctx = caller.send_context(&state)?;
            let actor = actor_of(&caller).await?;
            let recipient = resend_link(&ctx, &envelope, &recipient_id, &actor).await?;
            publish_updated(&caller, &state, &envelope);
            Ok(Data(recipient_dto(&recipient)).into_response())
        }
        .await,
    )
}

/// `POST /:id/recipients/:recipientId/correct` (`correctRecipientSchema`).
pub(crate) async fn correct(
    State(state): State<SignState>,
    caller: Caller,
    Path((id, recipient_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = validate(&headers, &body, |issues, fields| {
                let name = issues.text_with(fields, "name", Presence::Optional, NAME);
                let email = issues.text_with(fields, "email", Presence::Required, EMAIL);
                Correction {
                    name: name.into_option(),
                    email: email.into_option().unwrap_or_default(),
                }
            })?;
            let viewer = viewer_of(&caller).await?;
            let envelope = load_own_envelope(&caller.db, &id, &viewer).await?;
            let ctx = caller.send_context(&state)?;
            let actor = actor_of(&caller).await?;
            let recipient =
                correct_recipient(&ctx, &envelope, &recipient_id, &input, &actor).await?;
            touch_envelope(&caller.db, text(&envelope, "id")).await?;
            publish_updated(&caller, &state, &envelope);
            Ok(Data(recipient_dto(&recipient)).into_response())
        }
        .await,
    )
}
