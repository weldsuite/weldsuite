//! Email codes for verified-email forms (`services/codes.ts`): a 6-digit
//! code, valid 10 minutes, five wrong tries then the address is locked for
//! 15 minutes.
//!
//! ```text
//! forms:code:<formId>:<emailHash>   the emailed code's keyed hash, 10 minutes
//! forms:sent:<formId>:<emailHash>   last time a code went out (resend throttle), 1 minute
//! ```
//!
//! Wrong answers are counted by the form's counters (atomic), not by a
//! read-and-write of the cache. The stored form of a code is an HMAC bound
//! to the form and address, the worker's own, so either backend checks a
//! code the other sent.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use weldsuite_emails::{EmailBrand, EmailLocale, SystemEmail, send_system_email};
use weldsuite_mail_domain::outbound::{
    CheckOutboundInput, OutboundKind, SubjectInput, check_outbound, commit_outbound,
    release_outbound,
};

/// WeldSuite's own address, which the guard counts against the workspace.
const SYSTEM_SENDER: &str = "notifications@mail.weldsuite.org";

use crate::common::{FormsResult, Svc, forms_error, forms_error_with};
use crate::counters::{CodeCheck, Counters};
use crate::crypto::{hmac_hex, random_u32, safe_equal};
use crate::public_cache::PublicCacheEntry;
use crate::sessions::{CODE_LOCK_SECONDS, CODE_MAX_ATTEMPTS, CODE_TTL_SECONDS, session_secret};

pub(crate) const RESEND_AFTER_SECONDS: i64 = 60;

fn normalise(email: &str) -> String {
    weldsuite_kit::validation::js_trim(email).to_lowercase()
}

fn email_hash(secret: &str, form_id: &str, email: &str) -> String {
    hmac_hex(
        secret,
        &format!("forms-email:{form_id}:{}", normalise(email)),
    )
}

fn code_key(form_id: &str, hash: &str) -> String {
    format!("forms:code:{form_id}:{hash}")
}

fn sent_key(form_id: &str, hash: &str) -> String {
    format!("forms:sent:{form_id}:{hash}")
}

fn stored_code(secret: &str, form_id: &str, email: &str, code: &str) -> String {
    hmac_hex(
        secret,
        &format!("forms-code:{form_id}:{}:{code}", normalise(email)),
    )
}

/// `newEmailCode()`.
fn new_email_code() -> String {
    format!("{:06}", random_u32() % 1_000_000)
}

fn locked() -> crate::common::Fail {
    forms_error_with(
        429,
        "LOCKED",
        "Too many wrong codes. Try again later.",
        json!({ "retryAfterSeconds": CODE_LOCK_SECONDS }),
    )
}

/// `sendCode(env, counters, entry, email, clerkOrgId)`: stores a fresh code
/// and emails it. Anyone can ask for a code to any address, so it counts
/// against the workspace like other outbound mail (the guard, source `forms`):
/// 503 `EMAIL_UNAVAILABLE` when the guard refuses.
#[allow(clippy::too_many_lines, reason = "the worker's steps, in its order")]
pub(crate) async fn send_code(
    svc: &Svc,
    master: Option<sqlx::PgPool>,
    counters: &Counters,
    entry: &PublicCacheEntry,
    email: &str,
    clerk_org_id: &str,
) -> FormsResult<i64> {
    let secret = session_secret(&svc.env)?;
    let hash = email_hash(&secret, &entry.form_id, email);
    if counters.tries(&format!("code:{hash}")).await? >= CODE_MAX_ATTEMPTS {
        return Err(locked());
    }
    if svc
        .cache
        .get_boxed(&sent_key(&entry.form_id, &hash))
        .await?
        .is_some()
    {
        return Err(forms_error_with(
            429,
            "RATE_LIMITED",
            "A code was just sent. Wait a minute before asking for another.",
            json!({ "retryAfterSeconds": RESEND_AFTER_SECONDS }),
        ));
    }
    let to = weldsuite_kit::validation::js_trim(email).to_owned();
    let guard = svc.outbound.guard(master, Some(Arc::clone(&svc.cache)));
    let mut input = CheckOutboundInput::new(
        SubjectInput::Workspace {
            clerk_org_id: clerk_org_id.to_owned(),
            workspace_id: None,
        },
        "forms",
        OutboundKind::NewThread,
        SYSTEM_SENDER,
        vec![to.clone()],
    );
    input.system_sender = true;
    input.subject_line = Some(entry.title.clone());
    let reservation = match check_outbound(&guard, None, &input).await {
        Ok(reservation) => reservation,
        Err(denied) => {
            tracing::warn!(
                "forms codes: mail refused by the outbound guard ({:?})",
                denied.code()
            );
            return Err(forms_error(
                503,
                "EMAIL_UNAVAILABLE",
                "This form cannot send emails right now. Try again later.",
            ));
        }
    };
    let code = new_email_code();
    let ttl = |seconds: i64| Some(Duration::from_secs(u64::try_from(seconds).unwrap_or(60)));
    svc.cache
        .put_boxed(
            &code_key(&entry.form_id, &hash),
            &stored_code(&secret, &entry.form_id, email, &code),
            ttl(CODE_TTL_SECONDS),
        )
        .await?;
    svc.cache
        .put_boxed(
            &sent_key(&entry.form_id, &hash),
            "1",
            ttl(RESEND_AFTER_SECONDS),
        )
        .await?;
    let Some(transport) = svc.mail.as_deref() else {
        tracing::warn!("forms codes: no email transport configured; code not sent");
        release_outbound(&guard, &reservation).await;
        return Ok(CODE_TTL_SECONDS);
    };
    let brand = EmailBrand::Workspace {
        name: entry.branding.workspace_name.clone(),
        logo_url: entry.branding.logo_url.clone(),
        accent_color: None,
    };
    let language = entry
        .definition
        .as_ref()
        .and_then(|def| def["presentation"]["language"].as_str());
    let rendered = weldsuite_emails::forms::code(
        EmailLocale::resolve([language]),
        &brand,
        &entry.title,
        &code,
        u32::try_from(CODE_TTL_SECONDS / 60).ok(),
    );
    let sent = match rendered {
        Ok(rendered) => send_system_email(transport, SystemEmail::to(rendered, brand, &to))
            .await
            .map(|_| ())
            .map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    if let Err(error) = sent {
        tracing::error!(error, "forms codes: sending the code failed");
        release_outbound(&guard, &reservation).await;
        return Err(forms_error(
            502,
            "EMAIL_FAILED",
            "The code could not be sent. Try again.",
        ));
    }
    commit_outbound(&guard, None, &reservation, None).await;
    Ok(CODE_TTL_SECONDS)
}

/// `checkCode(env, counters, formId, email, code)`: 400 `INVALID_CODE` with
/// `details.attemptsLeft`, 429 `LOCKED` once five are wrong. Only the
/// counter decides, so a right code sent while locked is refused too.
pub(crate) async fn check_code(
    svc: &Svc,
    counters: &Counters,
    form_id: &str,
    email: &str,
    code: &str,
) -> FormsResult<()> {
    let secret = session_secret(&svc.env)?;
    let hash = email_hash(&secret, form_id, email);
    let expected = svc.cache.get_boxed(&code_key(form_id, &hash)).await?;
    let matched = expected
        .is_some_and(|expected| safe_equal(&stored_code(&secret, form_id, email, code), &expected));
    match counters.attempt(&format!("code:{hash}"), matched).await? {
        CodeCheck::Ok => {
            svc.cache.delete_boxed(&code_key(form_id, &hash)).await?;
            Ok(())
        }
        CodeCheck::Wrong { locked: true, .. } => Err(locked()),
        CodeCheck::Wrong { attempts_left, .. } => Err(forms_error_with(
            400,
            "INVALID_CODE",
            "That code is not right.",
            json!({ "attemptsLeft": attempts_left }),
        )),
    }
}
