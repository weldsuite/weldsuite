//! WeldSign email (`packages/domains/sign/src/mail.ts`): signing requests and
//! reminders, identity codes, "everyone signed", "a signer declined", "the
//! request was voided" and "the request expired", all system mail from
//! WeldSuite's address, branded as the workspace, Reply-To the sender.
//!
//! Requests carry the sender's own title and message to any address, so a
//! batch goes through the outbound guard first (`crate::outbound`, source
//! `sign`); [`send_requests`] reports a refusal so sending can stop before
//! anything changes. The other mails are best effort.

use std::fmt::Write as _;

use serde_json::Value;
use weldsuite_emails::sign::{SignCompleted, SignRequest};
use weldsuite_emails::{EmailBrand, EmailLocale, RenderedEmail, SystemEmail, send_system_email};
use weldsuite_ports::MailAttachment;

use crate::outbound::{self, Reserve};
use crate::{SendContext, SignResult, or_else, text};

/// Signed PDFs up to this size travel as an attachment; larger ones only as
/// a link.
pub(crate) const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;

/// The platform for an `ENVIRONMENT` (`platformUrl`).
pub(crate) fn platform_url(environment: Option<&str>) -> &'static str {
    match environment.unwrap_or_default() {
        "development" => "http://localhost:3000",
        "test" => "https://app-test.weldsuite.org",
        _ => "https://app.weldsuite.org",
    }
}

/// `encodeURIComponent`.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `workspaceAppUrl(base, clerkOrgId, path)` (FE-013 workspace URL).
pub(crate) fn workspace_app_url(base: &str, clerk_org_id: &str, path: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    let inner = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("/{path}")
    };
    if clerk_org_id.is_empty() {
        format!("{base}{inner}")
    } else {
        format!("{base}/w/{}{inner}", encode_uri_component(clerk_org_id))
    }
}

/// The request in the platform, for the sender (`envelopeAppUrl`).
pub(crate) fn envelope_app_url(ctx: &SendContext, envelope_id: &str) -> String {
    workspace_app_url(
        platform_url(ctx.services.environment.as_deref()),
        &ctx.clerk_org_id,
        &format!("/weldsign/{envelope_id}"),
    )
}

/// The file name a signed PDF travels under.
pub(crate) fn pdf_file_name(title: &str) -> String {
    format!("{}.pdf", safe_title(title, "signed"))
}

/// `title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || fallback`.
pub(crate) fn safe_title(title: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut in_run = false;
    for c in title.chars() {
        if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    let trimmed = js_trim(&out);
    if trimmed.is_empty() {
        fallback.to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// `String#trim`: JavaScript's whitespace, which includes U+FEFF.
pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// The workspace's name (its WeldSign brand name when set), colour and logo
/// (`workspaceBrand`).
pub(crate) async fn workspace_brand(ctx: &SendContext) -> SignResult<(EmailBrand, String)> {
    let settings: Option<(Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as("select brand_name, brand_color, brand_logo_url from sign_settings limit 1")
            .fetch_optional(&ctx.db)
            .await?;
    let (mut name, color, logo) = settings.unwrap_or_default();
    if name.is_none() {
        let row: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
            "select name from workspaces where id = $1 or clerk_org_id = $1 limit 1",
        )
        .bind(&ctx.clerk_org_id)
        .fetch_optional(&ctx.master)
        .await;
        match row {
            Ok(found) => name = found,
            Err(error) => {
                tracing::warn!(%error, "sign mail: workspace name lookup failed");
            }
        }
    }
    let display = name
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "WeldSuite".to_owned());
    Ok((
        EmailBrand::Workspace {
            name: display.clone(),
            logo_url: logo,
            accent_color: color,
        },
        display,
    ))
}

fn locale_of(recipient: &Value) -> EmailLocale {
    EmailLocale::resolve([recipient["locale"].as_str()])
}

/// Hand one rendered email over; `false` (logged) when it failed.
async fn deliver(
    ctx: &SendContext,
    rendered: Result<RenderedEmail, weldsuite_emails::EmailError>,
    email: impl FnOnce(RenderedEmail) -> SystemEmail,
    what: &str,
    envelope_id: &str,
) -> bool {
    let Some(transport) = ctx.services.mail.as_deref() else {
        return false;
    };
    let rendered = match rendered {
        Ok(rendered) => rendered,
        Err(error) => {
            tracing::error!(%error, envelope_id, "sign mail: {what} email did not render");
            return false;
        }
    };
    match send_system_email(transport, email(rendered)).await {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, envelope_id, "sign mail: {what} email failed");
            false
        }
    }
}

/// One signing request or reminder: who gets it and their link.
pub(crate) struct RequestMail<'a> {
    pub(crate) recipient: &'a Value,
    pub(crate) url: String,
}

/// Send signing requests (or reminders of one). `None` when the outbound
/// guard said no (nothing was sent); otherwise the addresses that went out
/// (`sendRequests`).
pub(crate) async fn send_requests(
    ctx: &SendContext,
    envelope: &Value,
    mails: &[RequestMail<'_>],
    reminder: bool,
) -> SignResult<Option<Vec<String>>> {
    let list: Vec<&RequestMail<'_>> = mails
        .iter()
        .filter(|m| !text(m.recipient, "email").is_empty())
        .collect();
    if list.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let to: Vec<String> = list
        .iter()
        .map(|m| text(m.recipient, "email").to_owned())
        .collect();
    let names: Vec<String> = list
        .iter()
        .map(|m| text(m.recipient, "name").to_owned())
        .filter(|n| !n.is_empty())
        .collect();
    let reservation = match outbound::reserve(ctx, envelope, &to, &names).await {
        Reserve::Refused => return Ok(None),
        Reserve::Granted(reservation) => reservation,
    };
    if ctx.services.mail.is_none() {
        tracing::warn!("sign mail: no email transport configured; signing requests not sent");
        outbound::release(ctx, reservation).await;
        return Ok(Some(Vec::new()));
    }
    let (brand, workspace_name) = workspace_brand(ctx).await?;
    let sender = or_else(&envelope["senderName"], &Value::from(workspace_name));
    let envelope_id = text(envelope, "id");
    let mut sent = Vec::new();
    for mail in list {
        let address = text(mail.recipient, "email");
        let props = SignRequest {
            sender_name: sender.as_str().unwrap_or_default().to_owned(),
            title: text(envelope, "title").to_owned(),
            message: envelope["message"].as_str().map(str::to_owned),
            url: mail.url.clone(),
            expires_at: envelope["expiresAt"].as_str().map(str::to_owned),
            time_zone: None,
            reminder,
        };
        let rendered = weldsuite_emails::sign::request(locale_of(mail.recipient), &brand, &props);
        let delivered = deliver(
            ctx,
            rendered,
            |rendered| {
                SystemEmail::to(rendered, brand.clone(), address)
                    .reply_to(envelope["senderEmail"].as_str())
            },
            "signing request",
            envelope_id,
        )
        .await;
        if delivered {
            sent.push(address.to_owned());
        }
    }
    outbound::settle(ctx, reservation, &sent, to.len()).await;
    Ok(Some(sent))
}

/// One "everyone signed" email (`CompletedMail`).
pub(crate) struct CompletedMail {
    pub(crate) to: String,
    pub(crate) locale: Option<String>,
    /// Portal link for signers and copy recipients, the request in WeldSuite
    /// for the sender.
    pub(crate) url: Option<String>,
    pub(crate) for_sender: bool,
}

/// "Everyone signed", with the PDF attached when it is small enough. Best
/// effort (`sendCompleted`).
pub(crate) async fn send_completed(
    ctx: &SendContext,
    envelope: &Value,
    mails: &[CompletedMail],
    signers: &[String],
    pdf: &[u8],
) -> SignResult<()> {
    if ctx.services.mail.is_none() || mails.is_empty() {
        return Ok(());
    }
    let (brand, _) = workspace_brand(ctx).await?;
    let attach = pdf.len() <= MAX_ATTACHMENT_BYTES;
    let title = text(envelope, "title");
    let filename = pdf_file_name(title);
    for mail in mails {
        let mail_brand = if mail.for_sender {
            EmailBrand::weldsuite("WeldSign")
        } else {
            brand.clone()
        };
        let props = SignCompleted {
            title: title.to_owned(),
            signers: signers.to_vec(),
            attached: attach,
            url: mail.url.clone(),
            for_sender: mail.for_sender,
        };
        let locale = EmailLocale::resolve([mail.locale.as_deref()]);
        let rendered = weldsuite_emails::sign::completed(locale, &mail_brand, &props);
        deliver(
            ctx,
            rendered,
            |rendered| {
                let reply_to = if mail.for_sender {
                    None
                } else {
                    envelope["senderEmail"].as_str()
                };
                let email =
                    SystemEmail::to(rendered, mail_brand.clone(), &mail.to).reply_to(reply_to);
                if attach {
                    email.attach(MailAttachment {
                        filename: filename.clone(),
                        content_type: "application/pdf".to_owned(),
                        content: pdf.to_vec(),
                    })
                } else {
                    email
                }
            },
            "completed",
            text(envelope, "id"),
        )
        .await;
    }
    Ok(())
}

/// Tell signers who already got the request that it was voided, with the
/// sender's reason. Not counted by the guard: it only goes to people already
/// invited. Best effort (`sendVoided`).
pub(crate) async fn send_voided(
    ctx: &SendContext,
    envelope: &Value,
    recipients: &[&Value],
    reason: &str,
) -> SignResult<()> {
    if ctx.services.mail.is_none() || recipients.is_empty() {
        return Ok(());
    }
    let (brand, workspace_name) = workspace_brand(ctx).await?;
    let sender = or_else(&envelope["senderName"], &Value::from(workspace_name));
    for recipient in recipients {
        let address = text(recipient, "email");
        if address.is_empty() {
            continue;
        }
        let rendered = weldsuite_emails::sign::voided(
            locale_of(recipient),
            &brand,
            sender.as_str().unwrap_or_default(),
            text(envelope, "title"),
            reason,
        );
        deliver(
            ctx,
            rendered,
            |rendered| {
                SystemEmail::to(rendered, brand.clone(), address)
                    .reply_to(envelope["senderEmail"].as_str())
            },
            "voided",
            text(envelope, "id"),
        )
        .await;
    }
    Ok(())
}

/// Tell the sender a request expired before everyone signed. Best effort
/// (`sendExpired`).
pub(crate) async fn send_expired(ctx: &SendContext, envelope: &Value, unsigned: &[String]) {
    let sender_email = text(envelope, "senderEmail");
    if ctx.services.mail.is_none() || sender_email.is_empty() {
        return;
    }
    let brand = EmailBrand::weldsuite("WeldSign");
    let url = envelope_app_url(ctx, text(envelope, "id"));
    let rendered = weldsuite_emails::sign::expired(
        EmailLocale::En,
        &brand,
        text(envelope, "title"),
        unsigned,
        &url,
    );
    deliver(
        ctx,
        rendered,
        |rendered| SystemEmail::to(rendered, brand.clone(), sender_email),
        "expired",
        text(envelope, "id"),
    )
    .await;
}

/// The one-time code for opening a link (`sendCode`). Not counted by the
/// guard: it only goes to someone already invited.
pub(crate) async fn send_code(
    ctx: &SendContext,
    envelope: &Value,
    recipient: &Value,
    code: &str,
    minutes: u64,
) -> SignResult<()> {
    let address = text(recipient, "email");
    if ctx.services.mail.is_none() || address.is_empty() {
        return Ok(());
    }
    let (brand, _) = workspace_brand(ctx).await?;
    let rendered = weldsuite_emails::sign::code(
        locale_of(recipient),
        &brand,
        text(envelope, "title"),
        code,
        u32::try_from(minutes).ok(),
    );
    deliver(
        ctx,
        rendered,
        |rendered| SystemEmail::to(rendered, brand.clone(), address),
        "code",
        text(envelope, "id"),
    )
    .await;
    Ok(())
}

/// Tell the sender a signer declined (`sendDeclined`, the sender's locale
/// unknown: English). Best effort.
pub(crate) async fn send_declined(
    ctx: &SendContext,
    envelope: &Value,
    declined_by: &str,
    reason: &str,
) {
    let sender_email = text(envelope, "senderEmail");
    if ctx.services.mail.is_none() || sender_email.is_empty() {
        return;
    }
    let brand = EmailBrand::weldsuite("WeldSign");
    let url = envelope_app_url(ctx, text(envelope, "id"));
    let rendered = weldsuite_emails::sign::declined(
        EmailLocale::En,
        &brand,
        text(envelope, "title"),
        declined_by,
        reason,
        &url,
    );
    deliver(
        ctx,
        rendered,
        |rendered| SystemEmail::to(rendered, brand.clone(), sender_email),
        "declined",
        text(envelope, "id"),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_names_like_typescript() {
        assert_eq!(platform_url(Some("test")), "https://app-test.weldsuite.org");
        assert_eq!(platform_url(None), "https://app.weldsuite.org");
        assert_eq!(
            workspace_app_url("https://app.weldsuite.org/", "org_a b", "weldsign/sgn_1"),
            "https://app.weldsuite.org/w/org_a%20b/weldsign/sgn_1"
        );
        assert_eq!(pdf_file_name(" a/b:c "), "a b c.pdf");
        assert_eq!(pdf_file_name("??"), "signed.pdf");
        assert_eq!(safe_title("x<>|y", "z"), "x y");
    }
}
