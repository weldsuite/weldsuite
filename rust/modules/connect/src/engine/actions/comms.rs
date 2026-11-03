//! `send_email` (`communication.ts`) and `send_sms` (`sms.ts`).
//!
//! On Global `send_email` posts to app-api's `/api/internal/send-email`,
//! which sends from one of the workspace's mailboxes through the outbound
//! guard (`sendWorkflowEmail`). Here the engine does the same in the
//! process: the mailbox check, `guarded_send` (source `workflow`, a new
//! thread) and the customer-mail transport, and a refusal fails the step as
//! `internalApiFailure` reads the route's answer.

use serde_json::{Map, Value, json};
use weldsuite_mail_domain::outbound::{
    CheckOutboundInput, DenialCode, DenialDetails, GuardedSendError, OutboundDenied, OutboundKind,
    SendEmailParams, SubjectInput, TransmitError, bare_address, guarded_send,
    send_email as transmit,
};

use super::providers::validated;
use super::records::internal_api_failure;
use super::{ActionCtx, ActionError, ActionResult};
use crate::js::{as_text, js_string, truthy};

/// `asText(a || b || '')`.
fn first_text(values: &[Option<&Value>]) -> String {
    values
        .iter()
        .flatten()
        .find(|v| truthy(v))
        .map_or_else(String::new, |v| as_text(Some(v)))
}

/// `splitRecipients(value)`: an array, or a `,`/`;` list.
fn split_recipients(value: Option<&Value>) -> Vec<String> {
    let items: Vec<String> = match value {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect(),
        Some(Value::String(text)) => text.split([',', ';']).map(str::to_owned).collect(),
        _ => Vec::new(),
    };
    items
        .into_iter()
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
        .collect()
}

/// `text.replaceAll(/<[^<>]*>/g, '')`.
fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        let after = &rest[open + 1..];
        match after.find(['<', '>']) {
            Some(close) if after.as_bytes()[close] == b'>' => {
                out.push_str(&rest[..open]);
                rest = &after[close + 1..];
            }
            _ => {
                out.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `{ error: { code, message, details } }`, as app-api answers a guard
/// refusal (keys in the route's order).
fn denial_text(code: &str, message: &str, details: &Value) -> String {
    format!(
        "{{\"error\":{{\"code\":{},\"message\":{},\"details\":{}}}}}",
        Value::String(code.to_owned()),
        Value::String(message.to_owned()),
        crate::js::json_text(details)
    )
}

/// The addresses of `Name <address>` recipients: the transport takes bare
/// addresses (the Workers binding took the whole value as the envelope).
fn addresses(recipients: Vec<String>) -> Vec<String> {
    recipients
        .into_iter()
        .map(|recipient| {
            recipient
                .trim_end()
                .strip_suffix('>')
                .and_then(|rest| rest.rsplit_once('<'))
                .map_or_else(
                    || recipient.trim().to_owned(),
                    |(_, inner)| inner.trim().to_owned(),
                )
        })
        .collect()
}

/// `{ success: false, error }`.
fn failure_text(message: &str) -> String {
    format!(
        "{{\"success\":false,\"error\":{}}}",
        Value::String(message.to_owned())
    )
}

pub(super) async fn send_email(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let to = validated(split_recipients(inputs.get("to")), "To", true)?;
    let cc = validated(split_recipients(inputs.get("cc")), "Cc", false)?;
    let bcc = validated(split_recipients(inputs.get("bcc")), "Bcc", false)?;
    let subject = match inputs.get("subject") {
        None | Some(Value::Null) => String::new(),
        some => as_text(some),
    }
    .trim()
    .to_owned();
    if subject.is_empty() {
        return Err(ActionError::fatal("Email subject is required"));
    }

    let accounts: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from mail_accounts a
         where a.status = 'active' and a.deleted_at is null limit 5",
    )
    .fetch_all(ctx.db)
    .await
    .map_err(|e| ActionError::plain(&e.to_string()))?;
    let account = match inputs.get("from") {
        Some(Value::String(from)) if !from.is_empty() => accounts.iter().find(|a| {
            a.get("email").and_then(Value::as_str) == Some(from)
                || a.get("id").and_then(Value::as_str) == Some(from)
        }),
        _ => accounts
            .iter()
            .find(|a| a.get("is_default") == Some(&Value::Bool(true)))
            .or_else(|| accounts.first()),
    };
    let Some(account) = account else {
        return Err(ActionError::fatal("No email account configured"));
    };
    let email = js_string(account.get("email"));
    let from = match account.get("display_name") {
        Some(name) if truthy(name) => format!("{} <{email}>", as_text(Some(name))),
        _ => email.clone(),
    };
    let raw_body = first_text(&[inputs.get("body"), inputs.get("html")]);
    let plain = inputs.get("isHtml") == Some(&Value::Bool(false));
    let html = if plain {
        crate::engine::template::escape_html(&raw_body)
            .replace("\r\n", "<br>")
            .replace('\n', "<br>")
    } else {
        raw_body.clone()
    };
    let text = if plain {
        raw_body
    } else {
        strip_tags(&raw_body)
    };

    // app-api's `internalSendEmailSchema`: one line for from, subject and
    // every address.
    let line_issue = |path: Vec<Value>| json!({ "code": "custom", "message": "must not contain line breaks", "path": path });
    let mut issues = Vec::new();
    if from.contains(['\r', '\n']) {
        issues.push(line_issue(vec![json!("from")]));
    }
    for (index, address) in to.iter().enumerate() {
        if address.contains(['\r', '\n']) {
            issues.push(line_issue(vec![json!("to"), json!(index)]));
        }
    }
    if subject.contains(['\r', '\n']) {
        issues.push(line_issue(vec![json!("subject")]));
    }
    for (key, list) in [("cc", &cc), ("bcc", &bcc)] {
        for (index, address) in list.iter().enumerate() {
            if address.contains(['\r', '\n']) {
                issues.push(line_issue(vec![json!(key), json!(index)]));
            }
        }
    }
    if !issues.is_empty() {
        let body = format!(
            "{{\"success\":false,\"error\":{{\"issues\":{},\"name\":\"ZodError\"}}}}",
            crate::js::json_text(&Value::Array(issues))
        );
        return Err(internal_api_failure("Email send", 400, &body));
    }

    // `sendWorkflowEmail`: the sender must be one of the workspace's mailboxes.
    let sender = bare_address(&from);
    let owned: Option<String> = sqlx::query_scalar(
        "select id from mail_accounts where lower(email) = $1 and status = 'active'
           and deleted_at is null limit 1",
    )
    .bind(&sender)
    .fetch_optional(ctx.db)
    .await
    .map_err(|e| ActionError::plain(&e.to_string()))?;
    let bindings = &ctx.deps.outbound;
    let guard = bindings.guard(ctx.deps.master.clone(), None);
    let mut input = CheckOutboundInput::new(
        SubjectInput::Workspace {
            clerk_org_id: ctx.info.workspace_id.clone(),
            workspace_id: None,
        },
        "workflow",
        OutboundKind::NewThread,
        &from,
        to.clone(),
    );
    input.cc.clone_from(&cc);
    input.bcc.clone_from(&bcc);
    input.subject_line = Some(subject.clone());
    input.text = Some(text.clone());
    input.html = Some(html.clone());
    let sent = if owned.is_none() {
        // `new OutboundDeniedError({ code: 'SENDER_NOT_OWNED', reason: 'sender_not_workspace_mailbox' })`.
        Err(GuardedSendError::Denied(OutboundDenied::new(
            DenialDetails::new(DenialCode::SenderNotOwned).reason("sender_not_workspace_mailbox"),
        )))
    } else {
        let params = SendEmailParams {
            from: from.clone(),
            to: addresses(to),
            cc: addresses(cc),
            bcc: addresses(bcc),
            subject,
            text: Some(text),
            html: Some(html),
            reply_to: None,
            headers: Vec::new(),
            attachments: Vec::new(),
        };
        let transport = bindings.transport.clone();
        guarded_send(&guard, Some(ctx.db), &input, || async {
            match &transport {
                Some(transport) => transmit(transport.as_ref(), &params).await,
                None => Err(TransmitError::Config(
                    "SEND_EMAIL binding missing — wrangler [[send_email]] not configured"
                        .to_owned(),
                )),
            }
        })
        .await
    };
    match sent {
        Ok(sent) => Ok(json!({ "success": true, "messageId": sent.message_id, "from": email })),
        Err(GuardedSendError::Denied(denied)) => {
            tracing::warn!(
                "[Internal] Send email blocked by the outbound guard ({})",
                denied.code().as_str()
            );
            let details = serde_json::to_value(&*denied.details).unwrap_or(Value::Null);
            Err(internal_api_failure(
                "Email send",
                denied.status(),
                &denial_text(denied.code().as_str(), &denied.message(), &details),
            ))
        }
        Err(GuardedSendError::Send(error)) => {
            tracing::error!(%error, "[Internal] Send email failed");
            Err(internal_api_failure(
                "Email send",
                500,
                &failure_text(&error.to_string()),
            ))
        }
    }
}

pub(super) async fn send_sms(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let to = first_text(&[inputs.get("to"), inputs.get("phoneNumber")]);
    let body = first_text(&[inputs.get("body"), inputs.get("message")]);
    if to.is_empty() {
        return Err(ActionError::plain("Phone number is required"));
    }
    if body.is_empty() {
        return Err(ActionError::plain("Message body is required"));
    }
    let Some(key) = ctx.deps.env.get("TELNYX_API_KEY").filter(|k| !k.is_empty()) else {
        return Err(ActionError::plain("TELNYX_API_KEY not configured"));
    };
    let mut payload = json!({ "to": to, "text": body });
    if let Some(from) = inputs.get("from").filter(|v| truthy(v)) {
        payload["from"] = json!(as_text(Some(from)));
    }
    if let Some(profile) = inputs.get("messagingProfileId").filter(|v| truthy(v)) {
        payload["messaging_profile_id"] = json!(as_text(Some(profile)));
    }
    let http =
        ctx.deps.http.clone().unwrap_or_else(|| {
            weldsuite_ports::OutboundHttp(std::sync::Arc::new(crate::Unreachable))
        });
    let request = weldsuite_ports::HttpRequest {
        method: "POST".into(),
        url: "https://api.telnyx.com/v2/messages".into(),
        headers: vec![
            ("Authorization".into(), format!("Bearer {key}")),
            ("Content-Type".into(), "application/json".into()),
        ],
        body: Some(crate::js::json_text(&payload).into_bytes()),
    };
    let response = http
        .0
        .send(request)
        .await
        .map_err(|_| ActionError::named("TypeError", "fetch failed"))?;
    let data: Value = serde_json::from_slice(&response.body).unwrap_or_else(|_| json!({}));
    if !response.ok() {
        return Err(ActionError::plain(&format!(
            "SMS send failed: {}",
            response.status
        )));
    }
    let mut out = json!({ "sent": true, "status": "queued" });
    if let Some(id) = data.pointer("/data/id") {
        out["id"] = id.clone();
    }
    Ok(out)
}
