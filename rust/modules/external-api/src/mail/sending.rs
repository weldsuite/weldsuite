//! Sending mail through the public API (`routes/v1/mail-sending/index.ts`):
//!
//! - `POST /v1/mail-attachments`: upload a file for a new message;
//! - `POST /v1/mail-accounts/:id/send`: compose and send;
//! - `POST /v1/mail-messages/:id/reply` and `…/forward`;
//! - `POST /v1/mail-drafts/:id/send`: send a saved draft, then delete it.
//!
//! Every send runs the platform's send path (`weldsuite_mail_domain::send`)
//! under the API's policies: the sending address on a verified WeldMail
//! domain, and the account's `dailySendLimit` from UTC midnight. The
//! outbound guard runs with source `api`, so a send can be refused with a
//! guard code; [`send_error`] maps those, and the transport's refusals, to
//! 403 / 422 / 429 / 502 / 503 with `Retry-After` where a retry can succeed.
//! Sending needs `mail_messages:send`, which neither `*` nor
//! `mail_messages:*` grants. An `Idempotency-Key` header makes a send safe
//! to retry: a repeat with the same key answers the first result
//! (`replayed: true`) without sending again.

use std::sync::Arc;

use axum::extract::{FromRequest, Path, Request, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, HeaderValue, StatusCode, header};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{EMAIL_EMAIL_SENT, EMAIL_REPLY_SENT, MAIL_DRAFT_DELETED};
use weldsuite_mail_domain::access::{MailPrincipal, can_open_account, email_event_data};
use weldsuite_mail_domain::drafts::draft_account;
use weldsuite_mail_domain::forward::{ForwardInput, forward_and_persist};
use weldsuite_mail_domain::messages::message_account_id;
use weldsuite_mail_domain::outbound::clock::{now_ms, parse_iso};
use weldsuite_mail_domain::outbound::{DenialCode, OutboundGuard};
use weldsuite_mail_domain::recipients::MxLookup;
use weldsuite_mail_domain::send::{
    ReplyInput, SendAttachmentInput, SendDeps, SendError, SendInput, SendOptions, SendResult,
    find_sent_by_idempotency_key, reply_and_persist, send_and_persist, send_draft_and_persist,
};
use weldsuite_mail_domain::text::{js_trim, utf16_len};
use weldsuite_mail_domain::uploads::{
    MAX_UPLOAD_BYTES, MailUploadError, resolve_mail_uploads, store_mail_upload,
};
use weldsuite_ports::{FileStores, MailTransport};

use super::schemas::{DRAFT_SEND, FORWARD, REPLY, SEND};
use super::{MailCaller, opt_strings, opt_text, strings};
use crate::ExternalApiState;
use crate::crud::{Answer, Fail, created, ok};
use crate::session::{bad_request, internal, internal_with, not_found};
use crate::zod::{self, Parsed};

type S = State<ExternalApiState>;

/// Seconds a client should wait after the transport's own rate limit.
const PROVIDER_RATE_LIMIT_RETRY_SECONDS: u32 = 60;

/// Everything one send borrows, owned for the length of the request.
struct Sender {
    guard: OutboundGuard,
    transport: Option<Arc<dyn MailTransport>>,
    files: Option<FileStores>,
    mx: MxLookup,
    public_url: Option<String>,
}

impl Sender {
    fn new(state: &ExternalApiState, mail: &MailCaller) -> Self {
        let bindings = &mail.bindings;
        Self {
            guard: bindings.guard(state),
            transport: bindings.outbound(state).transport,
            files: bindings.files(state),
            mx: bindings.mx(state),
            public_url: env_value(state, mail, "R2_PUBLIC_URL"),
        }
    }

    /// The send's bindings. No WeldCRM auto-add: an API send adds no one, as
    /// on Global.
    fn deps<'a>(&'a self, mail: &'a MailCaller) -> SendDeps<'a> {
        SendDeps {
            db: mail.db(),
            guard: &self.guard,
            transport: self.transport.as_deref(),
            files: self.files.as_ref(),
            mx: &self.mx,
            public_url: self.public_url.as_deref(),
            after_send: None,
        }
    }
}

/// An env value: the request's (conformance), else the app's.
fn env_value(state: &ExternalApiState, mail: &MailCaller, name: &str) -> Option<String> {
    match &mail.bindings.env {
        Some(env) => env.get(name).map(str::to_owned),
        None => state.env.get(name).cloned(),
    }
}

/// The send options of a public-API request: the API's policies, and how
/// the outbound guard labels it (source `api`; the key's workspace saves
/// the guard a lookup).
fn api_options(mail: &MailCaller) -> SendOptions {
    SendOptions {
        source: Some("api".to_owned()),
        workspace_id: Some(mail.caller.session.workspace_id.clone()),
        as_workspace: mail.principal == MailPrincipal::Workspace,
        enforce_daily_limit: true,
        require_verified_domain: true,
        ..SendOptions::default()
    }
}

/// The member the send acts for: the key's owner (a workspace key sends as
/// the workspace, [`SendOptions::as_workspace`]).
fn actor(mail: &MailCaller) -> &str {
    mail.caller.session.actor()
}

/// `idempotencyKeyOf(c)`: the trimmed `Idempotency-Key`, at most 64
/// characters.
fn idempotency_key(headers: &HeaderMap) -> Result<Option<String>, Fail> {
    let key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .map(|value| js_trim(value).to_owned())
        .filter(|value| !value.is_empty());
    match key {
        Some(key) if utf16_len(&key) > 64 => {
            Err(bad_request("Idempotency-Key is limited to 64 characters").into())
        }
        key => Ok(key),
    }
}

/// `replayOf(c, accountId, key)`: the earlier send a key made.
async fn replay_of(
    mail: &MailCaller,
    account: &str,
    key: Option<&str>,
) -> Result<Option<SendResult>, Fail> {
    let Some(key) = key else { return Ok(None) };
    find_sent_by_idempotency_key(mail.db(), account, key)
        .await
        .map_err(|error| send_error(error, "MailAccount", account))
}

/// `sentResponse(c, result, replayed, extra)`.
fn sent_response(result: &SendResult, replayed: bool, extra: Option<(&str, &str)>) -> Answer {
    let mut data = json!({
        "messageId": result.message_id,
        "accountId": result.account_id,
        "subject": result.subject,
        "smtpMessageId": result.smtp_message_id,
        "pendingVerification": result.pending_verification,
        "replayed": replayed,
    });
    if let Some((key, value)) = extra {
        data[key] = json!(value);
    }
    ok(data)
}

/// `publishSent(c, result, action, fields)`: an `email` event, its content
/// cleared unless the mailbox is shared.
async fn publish_sent(
    state: &ExternalApiState,
    mail: &MailCaller,
    result: &SendResult,
    reply: bool,
    to: Value,
    conversation: Option<&str>,
) {
    let mut data = json!({
        "id": result.message_id,
        "accountId": result.account_id,
        "subject": result.subject,
        "from": null,
        "to": to,
    });
    if let Some(conversation) = conversation {
        data["conversationId"] = json!(conversation);
    }
    let data = email_event_data(mail.db(), data).await;
    let event = if reply {
        EMAIL_REPLY_SENT
    } else {
        EMAIL_EMAIL_SENT
    };
    mail.caller
        .publish(&state.events, event, &result.message_id, data);
}

/// `orgIdOf(c)`, or 503 `WORKSPACE_NOT_CONFIGURED`.
async fn org_or_503(state: &ExternalApiState, mail: &MailCaller) -> Result<String, Fail> {
    match mail.org(state).await? {
        Some(org) => Ok(org),
        None => Err(error_body(
            StatusCode::SERVICE_UNAVAILABLE,
            "WORKSPACE_NOT_CONFIGURED",
            "This workspace has no organisation",
            None,
        )
        .into()),
    }
}

/// `resolveMailUploads(env, orgId, ids)` on the public bucket (`STORAGE`).
async fn uploads(
    state: &ExternalApiState,
    mail: &MailCaller,
    org: &str,
    ids: &[String],
) -> Result<Vec<SendAttachmentInput>, SendError> {
    let public = mail.bindings.buckets(state).public;
    resolve_mail_uploads(public.as_deref(), org, ids).await
}

/// `{ error: { code, message, details? } }` with `status`.
fn error_body(status: StatusCode, code: &str, message: &str, details: Option<&Value>) -> Response {
    let mut error = Map::new();
    error.insert("code".to_owned(), json!(code));
    error.insert("message".to_owned(), json!(message));
    if let Some(details) = details {
        error.insert("details".to_owned(), details.clone());
    }
    (status, axum::Json(json!({ "error": error }))).into_response()
}

fn with_retry_after(mut response: Response, seconds: i64) -> Response {
    if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

/// Whole seconds until an ISO time, at least 1 (`secondsUntil`).
fn seconds_until(at: Option<&Value>) -> Option<i64> {
    let ms = parse_iso(at?.as_str()?)? - now_ms();
    Some((ms + 999).div_euclid(1000).max(1))
}

/// `sendErrorResponse(c, err, resource, id)`.
#[allow(clippy::needless_pass_by_value)] // the error is the answer's last use
fn send_error(error: SendError, resource: &str, id: &str) -> Fail {
    let SendError::Mail {
        code,
        message,
        details,
    } = error
    else {
        if let SendError::Internal(error) = error {
            tracing::error!(%error, "external-api: a mail send failed");
        }
        return Fail(internal().into_response());
    };
    let body = |status: StatusCode| error_body(status, &code, &message, details.as_ref());
    let response = match code.as_str() {
        "ACCOUNT_NOT_FOUND" | "FORBIDDEN" => not_found(resource, id).into_response(),
        "DRAFT_NOT_FOUND" => not_found("MailDraft", id).into_response(),
        "INVALID_RECIPIENTS"
        | "ATTACHMENT_NOT_IN_WORKSPACE"
        | "ATTACHMENT_NOT_IN_STORAGE"
        | "SENDER_DOMAIN_NOT_VERIFIED" => body(StatusCode::UNPROCESSABLE_ENTITY),
        "EMAIL_TOO_LARGE" => body(StatusCode::PAYLOAD_TOO_LARGE),
        "DAILY_LIMIT_REACHED" => {
            let retry = seconds_until(details.as_ref().and_then(|d| d.get("resetsAt")));
            with_retry_after(
                error_body(
                    StatusCode::TOO_MANY_REQUESTS,
                    &code,
                    &message,
                    Some(details.as_ref().unwrap_or(&Value::Null)),
                ),
                retry.unwrap_or(3600),
            )
        }
        "PROVIDER_RATE_LIMITED" => with_retry_after(
            body(StatusCode::TOO_MANY_REQUESTS),
            i64::from(PROVIDER_RATE_LIMIT_RETRY_SECONDS),
        ),
        "PROVIDER_DAILY_LIMIT" | "SEND_BINDING_MISSING" | "STORAGE_BINDING_MISSING" => {
            body(StatusCode::SERVICE_UNAVAILABLE)
        }
        "PARTIALLY_SENT" => body(StatusCode::BAD_GATEWAY),
        _ => match DenialCode::parse(&code) {
            // The guard refused: the shared denial table's status, and
            // `Retry-After` when a retry can succeed. Which workspace owns
            // a refused sender is not the caller's to learn.
            Some(denial) => {
                let status =
                    StatusCode::from_u16(denial.status()).unwrap_or(StatusCode::TOO_MANY_REQUESTS);
                let shown = details.as_ref().filter(|_| code != "SENDER_NOT_OWNED");
                let response = error_body(status, &code, &message, shown);
                match seconds_until(details.as_ref().and_then(|d| d.get("retryAfter"))) {
                    Some(seconds) => with_retry_after(response, seconds),
                    None => response,
                }
            }
            None => internal_with(message.clone()).into_response(),
        },
    };
    Fail(response)
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/// The upload's answer for a refused file.
fn upload_error(error: &MailUploadError) -> Fail {
    match error {
        MailUploadError::FileTooLarge => error_body(
            StatusCode::PAYLOAD_TOO_LARGE,
            error.code(),
            &error.message(),
            None,
        )
        .into(),
        MailUploadError::EmptyFile => bad_request(error.message()).into(),
        MailUploadError::StorageBindingMissing => error_body(
            StatusCode::SERVICE_UNAVAILABLE,
            error.code(),
            &error.message(),
            None,
        )
        .into(),
        MailUploadError::Store(message) => {
            tracing::error!(%message, "external-api: a mail upload failed");
            Fail(internal().into_response())
        }
    }
}

/// `POST /v1/mail-attachments`: a file for a new message, as
/// `multipart/form-data` (field `file`) or as the raw body named with
/// `?filename=`.
pub(super) async fn upload(State(state): S, mail: MailCaller, request: Request) -> Answer {
    let declared = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    if declared > u64::try_from(MAX_UPLOAD_BYTES + 64 * 1024).unwrap_or(u64::MAX) {
        return Err(error_body(
            StatusCode::PAYLOAD_TOO_LARGE,
            "FILE_TOO_LARGE",
            "Files are limited to 5 MB",
            None,
        )
        .into());
    }
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let (filename, file_type, content) = if content_type.starts_with("multipart/form-data") {
        let mut form = axum::extract::Multipart::from_request(request, &state)
            .await
            .map_err(|_| Fail(internal().into_response()))?;
        // Hono's `parseBody`: the last `file` field wins; a part without a
        // file name is a string, not a file.
        let mut file: Option<(Option<String>, String, Vec<u8>)> = None;
        while let Some(field) = form
            .next_field()
            .await
            .map_err(|_| Fail(internal().into_response()))?
        {
            if field.name() != Some("file") {
                continue;
            }
            let name = field.file_name().map(str::to_owned);
            let part_type = field.content_type().unwrap_or_default().to_owned();
            let bytes = field
                .bytes()
                .await
                .map_err(|_| Fail(internal().into_response()))?;
            file = Some((name, part_type, bytes.to_vec()));
        }
        let Some((Some(name), part_type, bytes)) = file else {
            return Err(bad_request("Send the file in a form field named \"file\"").into());
        };
        (name, (!part_type.is_empty()).then_some(part_type), bytes)
    } else {
        let filename = weldsuite_kit::validation::query_values(request.uri().query())
            .get("filename")
            .and_then(|value| match value {
                Value::Array(items) => items.first().and_then(Value::as_str).map(str::to_owned),
                other => other.as_str().map(str::to_owned),
            })
            .map(|name| js_trim(&name).to_owned())
            .filter(|name| !name.is_empty());
        let Some(filename) = filename else {
            return Err(bad_request(
                "Name the file with ?filename=, or upload it as multipart/form-data",
            )
            .into());
        };
        let bytes = axum::body::to_bytes(request.into_body(), MAX_UPLOAD_BYTES + 64 * 1024 + 1)
            .await
            .map_err(|_| upload_error(&MailUploadError::FileTooLarge))?;
        (
            filename,
            (!content_type.is_empty()).then_some(content_type),
            bytes.to_vec(),
        )
    };
    let org = org_or_503(&state, &mail).await?;
    let public = mail.bindings.buckets(&state).public;
    let stored = store_mail_upload(
        public.as_deref(),
        &org,
        &filename,
        file_type.as_deref(),
        content,
    )
    .await
    .map_err(|error| upload_error(&error))?;
    created(stored)
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/// `POST /v1/mail-accounts/:id/send`.
pub(super) async fn send(
    State(state): S,
    mail: MailCaller,
    Path(account): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Answer {
    let parsed = zod::json(&SEND, &headers, &body)?;
    let key = idempotency_key(&headers)?;
    if !can_open_account(mail.db(), &account, &mail.principal).await? {
        return Err(not_found("MailAccount", &account).into());
    }
    if let Some(replay) = replay_of(&mail, &account, key.as_deref()).await? {
        return sent_response(&replay, true, None);
    }
    let org = org_or_503(&state, &mail).await?;
    let to = strings(&parsed, "to");
    let sender = Sender::new(&state, &mail);
    let result = async {
        let attachments = uploads(&state, &mail, &org, &strings(&parsed, "attachmentIds")).await?;
        let input = SendInput {
            to: to.clone(),
            cc: opt_strings(&parsed, "cc"),
            bcc: opt_strings(&parsed, "bcc"),
            reply_to: opt_text(&parsed, "replyTo"),
            subject: opt_text(&parsed, "subject"),
            body: opt_text(&parsed, "body"),
            html_body: opt_text(&parsed, "htmlBody"),
            attachments,
            idempotency_key: key.clone(),
            ..SendInput::default()
        };
        send_and_persist(
            &sender.deps(&mail),
            &org,
            actor(&mail),
            &account,
            &input,
            &api_options(&mail),
        )
        .await
    }
    .await
    .map_err(|error| send_error(error, "MailAccount", &account))?;
    publish_sent(&state, &mail, &result, false, json!(to), None).await;
    sent_response(&result, false, None)
}

/// The live message's mailbox when the caller may open it, else 404.
async fn message_account_or_404(mail: &MailCaller, id: &str) -> Result<String, Fail> {
    if let Some(account) = message_account_id(mail.db(), id).await?
        && can_open_account(mail.db(), &account, &mail.principal).await?
    {
        return Ok(account);
    }
    Err(not_found("Message", id).into())
}

/// `POST /v1/mail-messages/:id/reply` (`replyAll` for everyone on it).
pub(super) async fn reply(
    State(state): S,
    mail: MailCaller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Answer {
    let parsed = zod::json(&REPLY, &headers, &body)?;
    let key = idempotency_key(&headers)?;
    let account = message_account_or_404(&mail, &id).await?;
    if let Some(replay) = replay_of(&mail, &account, key.as_deref()).await? {
        return sent_response(&replay, true, Some(("repliedTo", &id)));
    }
    let org = org_or_503(&state, &mail).await?;
    let sender = Sender::new(&state, &mail);
    let (result, replied_to) = async {
        let attachments = uploads(&state, &mail, &org, &strings(&parsed, "attachmentIds")).await?;
        let input = ReplyInput {
            body: opt_text(&parsed, "body"),
            html_body: opt_text(&parsed, "htmlBody"),
            reply_all: parsed
                .get("replyAll")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            attachments,
            idempotency_key: key.clone(),
        };
        reply_and_persist(
            &sender.deps(&mail),
            &org,
            actor(&mail),
            &id,
            &input,
            &api_options(&mail),
        )
        .await
    }
    .await
    .map_err(|error| send_error(error, "Message", &id))?;
    publish_sent(&state, &mail, &result, true, Value::Null, Some(&replied_to)).await;
    sent_response(&result, false, Some(("repliedTo", &replied_to)))
}

/// `POST /v1/mail-messages/:id/forward`.
pub(super) async fn forward(
    State(state): S,
    mail: MailCaller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Answer {
    let parsed = zod::json(&FORWARD, &headers, &body)?;
    let key = idempotency_key(&headers)?;
    let account = message_account_or_404(&mail, &id).await?;
    if let Some(replay) = replay_of(&mail, &account, key.as_deref()).await? {
        return sent_response(&replay, true, Some(("forwardedFrom", &id)));
    }
    let org = org_or_503(&state, &mail).await?;
    let to = strings(&parsed, "to");
    let sender = Sender::new(&state, &mail);
    let result = async {
        let attachments = uploads(&state, &mail, &org, &strings(&parsed, "attachmentIds")).await?;
        let input = ForwardInput {
            to: to.clone(),
            body: opt_text(&parsed, "body"),
            html_body: opt_text(&parsed, "htmlBody"),
            attachments,
            exclude: strings(&parsed, "excludeAttachmentIds"),
            as_attachment: parsed
                .get("asAttachment")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            time_zone: None,
            idempotency_key: key.clone(),
        };
        forward_and_persist(
            &sender.deps(&mail),
            sender.files.as_ref(),
            &org,
            actor(&mail),
            &account,
            &id,
            &input,
            &api_options(&mail),
        )
        .await
    }
    .await
    .map_err(|error| send_error(error, "Message", &id))?;
    publish_sent(&state, &mail, &result, false, json!(to), Some(&id)).await;
    sent_response(&result, false, Some(("forwardedFrom", &id)))
}

/// `hasContent`: a body or an HTML body with more than whitespace.
fn has_content(draft: &Value) -> bool {
    ["body", "htmlBody"].iter().any(|key| {
        draft[*key]
            .as_str()
            .is_some_and(|text| !js_trim(text).is_empty())
    })
}

/// `POST /v1/mail-drafts/:id/send`: the draft sent, then deleted. A retry
/// with the same `Idempotency-Key` after the draft is gone still answers
/// the first result, while the caller may open that mailbox.
pub(super) async fn send_draft(
    State(state): S,
    mail: MailCaller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Answer {
    let parsed: Parsed = zod::json(&DRAFT_SEND, &headers, &body)?;
    let key = idempotency_key(&headers)?;
    let Some(draft) = weldsuite_mail_domain::drafts::get_draft(mail.db(), &id).await? else {
        if key.is_some()
            && let Some(account) = draft_account(mail.db(), &id).await?
            && can_open_account(mail.db(), &account, &mail.principal).await?
            && let Some(replay) = replay_of(&mail, &account, key.as_deref()).await?
        {
            return sent_response(&replay, true, Some(("draftId", &id)));
        }
        return Err(not_found("MailDraft", &id).into());
    };
    let account = draft["accountId"].as_str().unwrap_or_default().to_owned();
    if !can_open_account(mail.db(), &account, &mail.principal).await? {
        return Err(not_found("MailDraft", &id).into());
    }
    if let Some(replay) = replay_of(&mail, &account, key.as_deref()).await? {
        return sent_response(&replay, true, Some(("draftId", &id)));
    }
    if !has_content(&draft) {
        return Err(error_body(
            StatusCode::UNPROCESSABLE_ENTITY,
            "EMPTY_BODY",
            "The draft has no body to send",
            None,
        )
        .into());
    }
    let org = org_or_503(&state, &mail).await?;
    let upload_ids = match opt_strings(&parsed, "attachmentIds") {
        Some(ids) => ids,
        None => draft["attachmentIds"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
    };
    let sender = Sender::new(&state, &mail);
    let result = async {
        let attachments = uploads(&state, &mail, &org, &upload_ids).await?;
        send_draft_and_persist(
            &sender.deps(&mail),
            &org,
            actor(&mail),
            &id,
            attachments,
            key.clone(),
            &api_options(&mail),
        )
        .await
    }
    .await
    .map_err(|error| send_error(error, "MailDraft", &id))?;
    publish_sent(&state, &mail, &result, false, draft["to"].clone(), None).await;
    mail.caller.publish(
        &state.events,
        MAIL_DRAFT_DELETED,
        &id,
        json!({ "id": id, "accountId": account, "subject": null }),
    );
    sent_response(&result, false, Some(("draftId", &id)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idempotency_keys_are_trimmed_and_capped() {
        let mut headers = HeaderMap::new();
        assert!(matches!(idempotency_key(&headers), Ok(None)));
        headers.insert("idempotency-key", HeaderValue::from_static("  idem-1 "));
        assert_eq!(
            idempotency_key(&headers).ok().flatten().as_deref(),
            Some("idem-1")
        );
        headers.insert(
            "idempotency-key",
            HeaderValue::from_str(&"k".repeat(65)).expect("header"),
        );
        assert!(idempotency_key(&headers).is_err());
    }

    #[test]
    fn retries_wait_whole_seconds() {
        let soon = weldsuite_mail_domain::outbound::clock::iso(now_ms() + 1_500);
        assert_eq!(seconds_until(Some(&json!(soon))), Some(2));
        let past = weldsuite_mail_domain::outbound::clock::iso(now_ms() - 5_000);
        assert_eq!(seconds_until(Some(&json!(past))), Some(1));
        assert_eq!(seconds_until(None), None);
    }
}
