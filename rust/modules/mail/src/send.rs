//! What the send routes share: the send's bindings from the caller, the body
//! readers, and `sendErrorResponse` (`lib/send-errors.ts`).

use std::sync::Arc;

use axum::response::{IntoResponse, Response};
use http::{HeaderValue, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Field, Format, Issues, Presence, Text};
use weldsuite_mail_domain::outbound::{DenialCode, OutboundGuard};
use weldsuite_mail_domain::recipients::{DnsOverHttps, MxLookup};
use weldsuite_mail_domain::send::{SendAttachmentInput, SendDeps, SendError};
use weldsuite_ports::{FileStores, MailTransport};

use crate::{Caller, MailState};

/// A request's own DNS-over-HTTPS client (conformance: the test's `fetch`
/// stub, through the outbound bridge), ahead of the app's.
#[derive(Clone)]
pub struct RequestDoh(pub Arc<dyn DnsOverHttps>);

/// Everything a send borrows, owned for the length of the request.
pub(crate) struct SendContext {
    pub(crate) guard: OutboundGuard,
    pub(crate) transport: Option<Arc<dyn MailTransport>>,
    pub(crate) files: Option<FileStores>,
    pub(crate) mx: MxLookup,
    pub(crate) public_url: Option<String>,
}

impl SendContext {
    pub(crate) fn new(
        state: &MailState,
        caller: &Caller,
        doh: Option<Arc<dyn DnsOverHttps>>,
    ) -> Self {
        let bindings = &caller.bindings;
        Self {
            guard: bindings.guard(state),
            transport: bindings.outbound(state).transport,
            files: bindings.files(state),
            mx: MxLookup {
                cache: bindings.cache(state),
                doh,
            },
            public_url: bindings
                .env_value(state, "R2_PUBLIC_URL")
                .map(str::to_owned),
        }
    }

    pub(crate) fn deps<'a>(&'a self, caller: &'a Caller) -> SendDeps<'a> {
        SendDeps {
            db: &caller.db,
            guard: &self.guard,
            transport: self.transport.as_deref(),
            files: self.files.as_ref(),
            mx: &self.mx,
            public_url: self.public_url.as_deref(),
        }
    }
}

/// `z.string().email()` rules.
pub(crate) const EMAIL: Text = Text {
    trim: false,
    lowercase: false,
    format: Some(Format::Email),
    min: None,
    max: None,
};

/// `z.array(z.string().email())` with `min`.
pub(crate) fn emails(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
    min: Option<usize>,
) -> Option<Vec<String>> {
    issues
        .list(body, key, presence, min, None, |issues, item| {
            issues.item_text(item, EMAIL)
        })
        .into_option()
}

/// `z.array(attachmentSchema).optional()` (`sendAttachmentSchema`,
/// `forwardAttachmentSchema`: the same fields).
pub(crate) fn attachments(
    issues: &mut Issues,
    body: &Map<String, Value>,
) -> Vec<SendAttachmentInput> {
    issues
        .list(
            body,
            "attachments",
            Presence::Optional,
            None,
            None,
            |issues, item| {
                let object = issues.object(item)?;
                let before = issues.count();
                let filename =
                    issues.text(object, "filename", Presence::Required, Some(1), Some(500));
                let content_type =
                    issues.text(object, "contentType", Presence::Optional, None, Some(255));
                let size = issues.integer(object, "size", Presence::Required, Some(0));
                let file_key = issues.text(object, "fileKey", Presence::Required, Some(1), None);
                if issues.count() > before {
                    return None;
                }
                Some(SendAttachmentInput {
                    filename: filename.into_option().unwrap_or_default(),
                    content_type: content_type.into_option(),
                    size: size.into_option().unwrap_or_default(),
                    file_key: file_key.into_option().unwrap_or_default(),
                })
            },
        )
        .into_option()
        .unwrap_or_default()
}

/// An optional string field's value.
pub(crate) fn optional_text(field: Field<String>) -> Option<String> {
    field.into_option()
}

/// `retryAfterSeconds(details)`.
fn retry_after_seconds(details: Option<&Value>) -> Option<u32> {
    let at = details?.get("retryAfter")?.as_str()?;
    let at = weldsuite_mail_domain::outbound::clock::parse_iso(at)?;
    let ms = at - weldsuite_mail_domain::outbound::clock::now_ms();
    let seconds = (ms + 999).div_euclid(1000).max(1);
    u32::try_from(seconds).ok()
}

fn body_response(
    status: StatusCode,
    code: &str,
    message: &str,
    details: Option<&Value>,
) -> Response {
    let mut error = json!({ "code": code, "message": message });
    if let Some(details) = details {
        error["details"] = details.clone();
    }
    (status, axum::Json(json!({ "error": error }))).into_response()
}

/// `sendErrorResponse(c, err, { resource, id })`; an internal failure is a
/// 500 with the route's `message`.
pub(crate) fn send_error_response(
    error: SendError,
    resource: &str,
    id: Option<&str>,
    internal: &str,
) -> Response {
    let SendError::Mail {
        code,
        message,
        details,
    } = error
    else {
        if let SendError::Internal(error) = error {
            tracing::error!(%error, "[mail] send failed");
        }
        return ApiError::internal().with_message(internal).into_response();
    };
    let mut response = if let Some(denial) = DenialCode::parse(&code) {
        let status = StatusCode::from_u16(denial.status()).unwrap_or(StatusCode::TOO_MANY_REQUESTS);
        body_response(status, &code, &message, details.as_ref())
    } else {
        match code.as_str() {
            "ACCOUNT_NOT_FOUND" | "DRAFT_NOT_FOUND" => {
                ApiError::not_found(resource, id).into_response()
            }
            "FORBIDDEN" => ApiError::forbidden().with_message(message).into_response(),
            "INVALID_RECIPIENTS"
            | "ATTACHMENT_NOT_IN_WORKSPACE"
            | "ATTACHMENT_NOT_IN_STORAGE"
            | "EMAIL_TOO_LARGE" => {
                let mut error = ApiError::bad_request(message);
                if let Some(details) = &details {
                    error = error.with_details(details);
                }
                error.into_response()
            }
            "SENDER_DOMAIN_NOT_VERIFIED" => body_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                &code,
                &message,
                details.as_ref(),
            ),
            "DAILY_LIMIT_REACHED" | "PROVIDER_RATE_LIMITED" => body_response(
                StatusCode::TOO_MANY_REQUESTS,
                &code,
                &message,
                details.as_ref(),
            ),
            "PARTIALLY_SENT" => {
                body_response(StatusCode::BAD_GATEWAY, &code, &message, details.as_ref())
            }
            _ => body_response(
                StatusCode::SERVICE_UNAVAILABLE,
                &code,
                &message,
                details.as_ref(),
            ),
        }
    };
    if let Some(seconds) = retry_after_seconds(details.as_ref())
        && let Ok(value) = HeaderValue::from_str(&seconds.to_string())
    {
        response
            .headers_mut()
            .insert(http::header::RETRY_AFTER, value);
    }
    response
}

/// DNS over HTTPS with reqwest, three seconds per query (`DOH_TIMEOUT_MS`).
struct ReqwestDoh {
    client: reqwest::Client,
}

impl DnsOverHttps for ReqwestDoh {
    fn get<'a>(
        &'a self,
        url: &'a str,
    ) -> weldsuite_ports::BoxFuture<'a, Result<(u16, String), String>> {
        Box::pin(async move {
            let response = self
                .client
                .get(url)
                .header("accept", "application/dns-json")
                .timeout(std::time::Duration::from_secs(3))
                .send()
                .await
                .map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let text = response.text().await.map_err(|error| error.to_string())?;
            Ok((status, text))
        })
    }
}

/// The app's DNS-over-HTTPS client.
pub fn reqwest_doh() -> Arc<dyn DnsOverHttps> {
    Arc::new(ReqwestDoh {
        client: reqwest::Client::new(),
    })
}
