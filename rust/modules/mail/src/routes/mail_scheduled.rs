//! `/api/mail-scheduled` (`routes/mail-scheduled/index.ts`,
//! `services/mail/scheduled.ts`): schedule a message, the scheduled lists,
//! cancel, reschedule and send now. Each schedule starts a run on the
//! `SEND_SCHEDULED_EMAIL` binding (delayed jobs on Kubernetes) keyed by its
//! instance id, which the row keeps in `trigger_run_id`.

use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{EMAIL_DELETED, EMAIL_EMAIL_SCHEDULED, EMAIL_EMAIL_SENT};
use weldsuite_catalogs::permission_keys::{
    MESSAGES_CREATE, MESSAGES_DELETE, MESSAGES_READ, MESSAGES_UPDATE,
};
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Format, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_mail_domain::access::{accessible_account_ids, check_account_access};
use weldsuite_mail_domain::messages::{iso, message_account_id, message_record};
use weldsuite_mail_domain::outbound::clock::{iso as iso_ms, parse_iso};
use weldsuite_mail_domain::send::{SendError, SendInput, collapse_whitespace, prepare_body};
use weldsuite_mail_domain::text::{js_trim, utf16_prefix};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::routes::mail_accounts::email_event_data;
use crate::routes::mail_labels::NO_ACCESS;
use crate::scheduled::{
    ScheduledPatch, ScheduledRuns, apply_scheduled_patch, deliver, load_scheduled, now_millis,
    run_params,
};
use crate::send::{EMAIL, RequestDoh, SendContext, attachments, emails, optional_text, send_error_response};
use crate::util::{MailError, MailResult, answer, unhandled, validate, validate_query};
use crate::{Caller, MailState};

/// `MAX_SCHEDULE_DAYS`.
const MAX_SCHEDULE_DAYS: i64 = 365;
/// `MAX_EMAIL_SIZE_BYTES` (25 MB).
const MAX_EMAIL_SIZE_BYTES: usize = 25 * 1024 * 1024;

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/mail-scheduled",
            get(list).route_layer(gate.require([MESSAGES_READ])),
        )
        .route(
            "/mail-scheduled",
            post(schedule).route_layer(gate.require([MESSAGES_CREATE])),
        )
        .route(
            "/mail-scheduled/{message_id}/cancel",
            post(cancel).route_layer(gate.require([MESSAGES_DELETE])),
        )
        .route(
            "/mail-scheduled/{message_id}/reschedule",
            post(reschedule).route_layer(gate.require([MESSAGES_UPDATE])),
        )
        .route(
            "/mail-scheduled/{message_id}/send-now",
            post(send_now).route_layer(gate.require([MESSAGES_UPDATE])),
        )
        .with_state(state)
}

/// `mapScheduledError`.
fn scheduled_error(code: &str, message: &str) -> MailError {
    match code {
        "ACCOUNT_NOT_FOUND" | "MESSAGE_NOT_FOUND" => MailError::not_found(message, None),
        "NOT_SCHEDULED" => MailError::conflict(message),
        "STORAGE_BINDING_MISSING" | "WORKFLOW_BINDING_MISSING" => MailError::Response(Box::new(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": { "code": code, "message": message } })),
            )
                .into_response(),
        )),
        _ => MailError::bad_request(message),
    }
}

fn workflow_missing() -> MailError {
    scheduled_error(
        "WORKFLOW_BINDING_MISSING",
        "Scheduled-send workflow binding is not configured for this environment.",
    )
}

/// `assertScheduleWindow(scheduledFor)`.
fn assert_window(at: i64) -> MailResult<()> {
    let now = now_millis();
    if at <= now {
        return Err(scheduled_error(
            "SCHEDULE_IN_PAST",
            "Scheduled time must be in the future",
        ));
    }
    if at > now + MAX_SCHEDULE_DAYS * 24 * 60 * 60 * 1000 {
        return Err(scheduled_error(
            "SCHEDULE_TOO_FAR",
            &format!("Scheduled time must be within {MAX_SCHEDULE_DAYS} days"),
        ));
    }
    Ok(())
}

/// `GET /` (`listScheduled`): one mailbox's, or every accessible one's.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let account = match validate_query(raw.as_deref(), |issues, q| {
        issues
            .text(q, "accountId", Presence::Optional, None, None)
            .into_option()
    }) {
        Ok(account) => account.filter(|a| !a.is_empty()),
        Err(error) => return error.respond(""),
    };
    let result = async {
        let ids = match account {
            Some(account) => {
                if !check_account_access(&caller.db, &account, &caller.user_id).await? {
                    return Err(MailError::forbidden(NO_ACCESS));
                }
                vec![account]
            }
            None => accessible_account_ids(&caller.db, &caller.user_id).await?,
        };
        if ids.is_empty() {
            return Ok(Data(json!([])).into_response());
        }
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(m) from mail_messages m
             where m.deleted_at is null and m.send_status = 'scheduled'
               and m.account_id = any($1::text[])
             order by m.scheduled_for",
        )
        .bind(&ids)
        .fetch_all(&caller.db)
        .await?;
        let rows: Vec<Value> = rows
            .into_iter()
            .map(|r| message_record(js_row(r), true))
            .collect();
        Ok(Data(rows).into_response())
    }
    .await;
    answer(result, "Failed to list scheduled emails")
}

/// `scheduleBody`.
struct ScheduleInput {
    account_id: String,
    send: SendInput,
    attachment_ids: Vec<String>,
    scheduled_for: String,
}

/// `validateScheduledAttachments`: the uploaded files with their stored
/// size and type.
async fn validate_attachments(
    state: &MailState,
    caller: &Caller,
    org: &str,
    data: &SendInput,
) -> MailResult<Vec<(String, Option<String>, i64, String)>> {
    if data.attachments.is_empty() {
        return Ok(Vec::new());
    }
    let buckets = caller.bindings.buckets(state);
    if buckets.private.is_none() && buckets.public.is_none() {
        return Err(scheduled_error(
            "STORAGE_BINDING_MISSING",
            "Storage binding not configured",
        ));
    }
    let prefix = format!("workspaces/{org}/");
    let mut total = data.body.as_ref().map_or(0, String::len)
        + data.html_body.as_ref().map_or(0, String::len);
    let mut out = Vec::new();
    for att in &data.attachments {
        if !att.file_key.starts_with(&prefix) {
            return Err(scheduled_error(
                "ATTACHMENT_NOT_IN_WORKSPACE",
                &format!("Attachment {} is not in this workspace", att.filename),
            ));
        }
        let mut found = None;
        for bucket in [&buckets.private, &buckets.public].into_iter().flatten() {
            if let Some(object) = bucket.get_boxed(&att.file_key).await.map_err(|error| {
                tracing::error!(%error, "[mail-scheduled] storage read failed");
                MailError::api(ApiError::internal().with_message("Failed to schedule email"))
            })? {
                found = Some(object);
                break;
            }
        }
        let Some(object) = found else {
            return Err(scheduled_error(
                "ATTACHMENT_NOT_IN_STORAGE",
                &format!("Attachment {} not found in storage", att.filename),
            ));
        };
        total += object.bytes.len();
        if total > MAX_EMAIL_SIZE_BYTES {
            return Err(scheduled_error(
                "EMAIL_TOO_LARGE",
                &format!(
                    "Email exceeds the {} MB limit (body + attachments).",
                    MAX_EMAIL_SIZE_BYTES / (1024 * 1024)
                ),
            ));
        }
        let content_type = att
            .content_type
            .clone()
            .filter(|t| !t.is_empty())
            .or(object.info.content_type);
        out.push((
            att.filename.clone(),
            content_type,
            i64::try_from(object.bytes.len()).unwrap_or(i64::MAX),
            att.file_key.clone(),
        ));
    }
    Ok(out)
}

/// `movableAttachmentIds`: uploaded attachments in mailboxes the caller can
/// open.
async fn movable_attachment_ids(caller: &Caller, ids: &[String]) -> MailResult<Vec<String>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if !unique.contains(id) {
            unique.push(id.clone());
        }
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "select a.id, m.account_id from mail_attachments a
         join mail_messages m on m.id = a.message_id
         where a.id = any($1::text[]) and a.deleted_at is null",
    )
    .bind(&unique)
    .fetch_all(&caller.db)
    .await?;
    let mut access: Vec<(String, bool)> = Vec::new();
    let mut movable = Vec::new();
    for (id, account) in rows {
        let allowed = match access.iter().find(|(a, _)| *a == account) {
            Some((_, allowed)) => *allowed,
            None => {
                let allowed = check_account_access(&caller.db, &account, &caller.user_id).await?;
                access.push((account, allowed));
                allowed
            }
        };
        if allowed {
            movable.push(id);
        }
    }
    Ok(movable)
}

/// `POST /` (`scheduleEmail`).
#[allow(clippy::too_many_lines)] // the TypeScript schedule flow, step by step
async fn schedule(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, object| {
        let account = issues.text(object, "accountId", Presence::Required, Some(1), None);
        let to = emails(issues, object, "to", Presence::Required, Some(1));
        let cc = emails(issues, object, "cc", Presence::Optional, None);
        let bcc = emails(issues, object, "bcc", Presence::Optional, None);
        let subject = issues.text(object, "subject", Presence::Optional, None, None);
        let text = issues.text(object, "body", Presence::Optional, None, None);
        let html = issues.text(object, "htmlBody", Presence::Optional, None, None);
        let reply_to = issues.text_with(object, "replyTo", Presence::Optional, EMAIL);
        issues.choice(object, "importance", Presence::Optional, &["low", "normal", "high"]);
        let ids = issues.list(object, "attachmentIds", Presence::Optional, None, None, |issues, item| {
            issues.item_text(item, Text::default())
        });
        let files = attachments(issues, object);
        let scheduled_for = issues.text_with(
            object,
            "scheduledFor",
            Presence::Required,
            Text {
                format: Some(Format::Datetime),
                ..Text::default()
            },
        );
        let in_reply_to = issues.text(object, "inReplyTo", Presence::Optional, None, None);
        let references = issues.list(object, "references", Presence::Optional, None, None, |issues, item| {
            issues.item_text(item, Text::default())
        });
        ScheduleInput {
            account_id: account.into_option().unwrap_or_default(),
            send: SendInput {
                to: to.unwrap_or_default(),
                cc,
                bcc,
                subject: optional_text(subject),
                body: optional_text(text),
                html_body: optional_text(html),
                reply_to: optional_text(reply_to),
                in_reply_to: optional_text(in_reply_to),
                references: references.into_option(),
                attachments: files,
                idempotency_key: None,
            },
            attachment_ids: ids.into_option().unwrap_or_default(),
            scheduled_for: scheduled_for.into_option().unwrap_or_default(),
        }
    });
    let data = match input {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.into_response(),
    };
    match check_account_access(&caller.db, &data.account_id, &caller.user_id).await {
        Ok(true) => {}
        Ok(false) => return MailError::forbidden(NO_ACCESS).respond(""),
        Err(error) => return unhandled(error.into()),
    }
    let result = async {
        let at = parse_iso(&data.scheduled_for).unwrap_or_default();
        assert_window(at)?;
        let Some(runs) = caller.bindings.scheduled_runs(&state) else {
            return Err(workflow_missing());
        };
        let account: Option<(String, Option<String>)> = sqlx::query_as(
            "select email, display_name from mail_accounts where id = $1 and deleted_at is null limit 1",
        )
        .bind(&data.account_id)
        .fetch_optional(&caller.db)
        .await?;
        let Some((email, display_name)) = account else {
            return Err(scheduled_error("ACCOUNT_NOT_FOUND", "Mail account not found"));
        };
        let validated = validate_attachments(&state, &caller, &org, &data.send).await?;
        let reparented = movable_attachment_ids(&caller, &data.attachment_ids).await?;

        let message_id = generate_id("msg");
        let smtp = format!("<{message_id}@scheduled.weldsuite.org>");
        let now = iso(OffsetDateTime::now_utc());
        let (html, text) = prepare_body(&data.send);
        let preview = utf16_prefix(
            js_trim(&collapse_whitespace(text.as_deref().unwrap_or_default())),
            200,
        )
        .to_owned();
        let mut from = json!({ "email": email });
        if let Some(name) = display_name {
            from["name"] = Value::String(name);
        }
        let list = |items: &Option<Vec<String>>| {
            items
                .as_ref()
                .map(|v| Value::Array(v.iter().map(|e| json!({ "email": e })).collect()))
        };
        let scheduled_iso = iso_ms(at);
        sqlx::query(
            "insert into mail_messages (id, account_id, message_id, thread_id, \"from\", \"to\", cc, bcc,
               subject, preview, text_body, html_body, sent_date, is_read, labels, is_spam,
               is_starred, is_important, is_trash, in_reply_to, \"references\", is_reply,
               send_status, scheduled_for, source, has_attachments, attachment_count,
               created_at, updated_at)
             values ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamp, true,
               '[\"SENT\",\"SCHEDULED\"]'::jsonb, false, false, false, false, $13, $14, $15,
               'scheduled', $16::timestamp, 'sent', $17, $18, $12::timestamp, $12::timestamp)",
        )
        .bind(&message_id)
        .bind(&data.account_id)
        .bind(&smtp)
        .bind(&from)
        .bind(list(&Some(data.send.to.clone())))
        .bind(list(&data.send.cc))
        .bind(list(&data.send.bcc))
        .bind(
            data.send
                .subject
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "(No subject)".to_owned()),
        )
        .bind(&preview)
        .bind(&text)
        .bind(&html)
        .bind(&now)
        .bind(&data.send.in_reply_to)
        .bind(data.send.references.as_ref().map(|r| json!(r)))
        .bind(data.send.in_reply_to.as_deref().is_some_and(|s| !s.is_empty()))
        .bind(&scheduled_iso)
        .bind(!validated.is_empty())
        .bind(i32::try_from(validated.len()).unwrap_or(i32::MAX))
        .execute(&caller.db)
        .await?;
        for (filename, content_type, size, key) in &validated {
            sqlx::query(
                "insert into mail_attachments (id, message_id, file_name, content_type, size,
                   storage_path, is_inline, created_at, updated_at)
                 values ($1, $2, $3, $4, $5, $6, false, $7::timestamp, $7::timestamp)",
            )
            .bind(generate_id("attach"))
            .bind(&message_id)
            .bind(filename)
            .bind(content_type.clone().unwrap_or_else(|| "application/octet-stream".to_owned()))
            .bind(size)
            .bind(key)
            .bind(&now)
            .execute(&caller.db)
            .await?;
        }
        if !reparented.is_empty() {
            sqlx::query(
                "update mail_attachments set message_id = $1, updated_at = $3::timestamp
                 where id = any($2::text[]) and deleted_at is null",
            )
            .bind(&message_id)
            .bind(&reparented)
            .bind(&now)
            .execute(&caller.db)
            .await?;
            sqlx::query(
                "update mail_messages set
                   attachment_count = coalesce((select count(*)::int from mail_attachments
                     where message_id = $1 and deleted_at is null), 0),
                   has_attachments = exists (select 1 from mail_attachments
                     where message_id = $1 and deleted_at is null),
                   updated_at = $2::timestamp
                 where id = $1",
            )
            .bind(&message_id)
            .bind(&now)
            .execute(&caller.db)
            .await?;
        }
        let params = run_params(&org, &caller.user_id, &message_id, &data.account_id, &scheduled_iso);
        let run = runs.create(&message_id, &params).await.map_err(|error| {
            tracing::error!("[mail-scheduled] could not start the run: {error}");
            MailError::api(ApiError::internal().with_message("Failed to schedule email"))
        })?;
        apply_scheduled_patch(
            &caller.db,
            &message_id,
            ScheduledPatch {
                trigger_run_id: Some(Some(run.clone())),
                ..ScheduledPatch::default()
            },
        )
        .await?;
        let event = email_event_data(
            &caller,
            &data.account_id,
            json!({
                "id": message_id,
                "accountId": data.account_id,
                "subject": data.send.subject,
                "from": null,
                "to": data.send.to,
            }),
        )
        .await;
        caller.publish(&state, EMAIL_EMAIL_SCHEDULED, &message_id, &event);
        Ok(Created(json!({
            "messageId": message_id,
            "smtpMessageId": smtp,
            "scheduledFor": scheduled_iso,
            "triggerRunId": run,
        }))
        .into_response())
    }
    .await;
    answer(result, "Failed to schedule email")
}

/// The message's mailbox and the caller's access to it; outside the route's
/// try/catch only where TypeScript has it there.
async fn reach(caller: &Caller, id: &str) -> MailResult<String> {
    let Some(account) = message_account_id(&caller.db, id).await? else {
        return Err(MailError::not_found("Scheduled message", Some(id)));
    };
    if !check_account_access(&caller.db, &account, &caller.user_id).await? {
        return Err(MailError::forbidden(NO_ACCESS));
    }
    Ok(account)
}

/// The scheduled row, or `MESSAGE_NOT_FOUND` / `NOT_SCHEDULED`.
async fn scheduled_row(caller: &Caller, id: &str) -> MailResult<crate::scheduled::ScheduledRow> {
    let Some(message) = load_scheduled(&caller.db, id).await? else {
        return Err(scheduled_error("MESSAGE_NOT_FOUND", "Message not found"));
    };
    if message.send_status.as_deref() != Some("scheduled") {
        return Err(scheduled_error(
            "NOT_SCHEDULED",
            "Message is not in scheduled state",
        ));
    }
    Ok(message)
}

/// `terminateWorkflow(env, instanceId)`.
async fn terminate(runs: Option<&Arc<dyn ScheduledRuns>>, run: Option<&str>) {
    if let (Some(runs), Some(run)) = (runs, run) {
        runs.terminate(run).await;
    }
}

/// `POST /:messageId/cancel` (`cancelScheduled`).
async fn cancel(State(state): State<MailState>, caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        reach(&caller, &id).await?;
        let message = scheduled_row(&caller, &id).await?;
        let runs = caller.bindings.scheduled_runs(&state);
        terminate(runs.as_ref(), message.trigger_run_id.as_deref()).await;
        apply_scheduled_patch(
            &caller.db,
            &id,
            ScheduledPatch {
                send_status: Some("cancelled"),
                scheduled_for: Some(None),
                trigger_run_id: Some(None),
                soft_delete: true,
                ..ScheduledPatch::default()
            },
        )
        .await?;
        caller.publish(
            &state,
            EMAIL_DELETED,
            &id,
            &json!({ "id": id, "accountId": "", "subject": null, "from": null, "to": null }),
        );
        Ok(Data(json!({ "id": id })).into_response())
    }
    .await;
    answer(result, "Failed to cancel scheduled email")
}

/// `POST /:messageId/reschedule` (`rescheduleScheduled`).
async fn reschedule(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let when = validate(&headers, &body, |issues, object| {
        issues
            .text_with(
                object,
                "scheduledFor",
                Presence::Required,
                Text {
                    format: Some(Format::Datetime),
                    ..Text::default()
                },
            )
            .into_option()
            .unwrap_or_default()
    });
    let when = match when {
        Ok(when) => when,
        Err(error) => return error.respond(""),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.into_response(),
    };
    if let Err(error) = reach(&caller, &id).await {
        return match error {
            MailError::Database(error) => unhandled(error.into()),
            other => other.respond(""),
        };
    }
    let result = async {
        let at = parse_iso(&when).unwrap_or_default();
        assert_window(at)?;
        let Some(runs) = caller.bindings.scheduled_runs(&state) else {
            return Err(workflow_missing());
        };
        let message = scheduled_row(&caller, &id).await?;
        terminate(Some(&runs), message.trigger_run_id.as_deref()).await;
        let instance = format!("{id}-r{}", now_millis());
        let scheduled_iso = iso_ms(at);
        let params = run_params(&org, &caller.user_id, &id, &message.account_id, &scheduled_iso);
        let run = runs.create(&instance, &params).await.map_err(|error| {
            tracing::error!("[mail-scheduled] could not start the run: {error}");
            MailError::api(ApiError::internal().with_message("Failed to reschedule email"))
        })?;
        apply_scheduled_patch(
            &caller.db,
            &id,
            ScheduledPatch {
                scheduled_for: Some(Some(scheduled_iso.clone())),
                send_status: Some("scheduled"),
                trigger_run_id: Some(Some(run.clone())),
                ..ScheduledPatch::default()
            },
        )
        .await?;
        Ok(Data(json!({ "scheduledFor": scheduled_iso, "triggerRunId": run })).into_response())
    }
    .await;
    answer(result, "Failed to reschedule email")
}

/// `restoreSchedule`: a fresh run at the original time, or a minute from now.
async fn restore_schedule(
    caller: &Caller,
    runs: Option<&Arc<dyn ScheduledRuns>>,
    org: &str,
    message: &crate::scheduled::ScheduledRow,
) {
    let Some(runs) = runs else { return };
    let original = message
        .scheduled_for
        .as_deref()
        .and_then(parse_iso)
        .unwrap_or(0);
    let at = iso_ms(original.max(now_millis() + 60_000));
    let instance = format!("{}-n{}", message.id, now_millis());
    let params = run_params(org, &caller.user_id, &message.id, &message.account_id, &at);
    let restored = async {
        let run = runs.create(&instance, &params).await?;
        apply_scheduled_patch(
            &caller.db,
            &message.id,
            ScheduledPatch {
                scheduled_for: Some(Some(at.clone())),
                trigger_run_id: Some(Some(run)),
                ..ScheduledPatch::default()
            },
        )
        .await
        .map_err(|error| error.to_string())?;
        Ok::<(), String>(())
    };
    if let Err(error) = restored.await {
        tracing::error!(
            "[mail-scheduled] could not restore the schedule after a failed send-now: {error}"
        );
    }
}

/// `POST /:messageId/send-now` (`sendScheduledNow`).
async fn send_now(
    State(state): State<MailState>,
    caller: Caller,
    doh: Option<Extension<RequestDoh>>,
    Path(id): Path<String>,
) -> Response {
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.into_response(),
    };
    if let Err(error) = reach(&caller, &id).await {
        return match error {
            MailError::Database(error) => unhandled(error.into()),
            other => other.respond(""),
        };
    }
    let doh = doh
        .map(|d| Arc::clone(&d.0.0))
        .or_else(|| state.doh.clone());
    let context = SendContext::new(&state, &caller, doh);
    let message = match scheduled_row(&caller, &id).await {
        Ok(message) => message,
        Err(error) => return error.respond("Failed to send email immediately"),
    };
    let runs = caller.bindings.scheduled_runs(&state);
    terminate(runs.as_ref(), message.trigger_run_id.as_deref()).await;
    match deliver(&context.deps(&caller), &org, &caller.user_id, &message).await {
        Ok(result) => {
            caller.publish(
                &state,
                EMAIL_EMAIL_SENT,
                &id,
                &json!({ "id": id, "accountId": "", "subject": null, "from": null, "to": null }),
            );
            Data(json!({ "id": id, "externalMessageId": result.external_message_id }))
                .into_response()
        }
        Err(error) => {
            let partial = matches!(&error, SendError::Mail { code, .. } if code == "PARTIALLY_SENT");
            if !partial {
                restore_schedule(&caller, runs.as_ref(), &org, &message).await;
            }
            send_error_response(
                error,
                "Scheduled message",
                Some(&id),
                "Failed to send email immediately",
            )
        }
    }
}
