//! WeldForms email (`services/mail.ts`): invitations and reminders, the
//! receipt, the daily digest, the quota notices. All system mail through
//! `weldsuite-emails` from WeldSuite's address, branded as the workspace.
//!
//! Mail that carries the sender's own words to any address (invitations,
//! reminders) goes through the outbound mail guard first (source `forms`,
//! ADR MAIL-006): a refusal stops sending before anything changes. The other
//! mails are best effort. (The code email is in [`crate::codes`].)

use std::sync::Arc;

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_emails::forms::{DigestItem, InviteProps, QuestionAnswer};
use weldsuite_emails::{EmailBrand, EmailLocale, RenderedEmail, SystemEmail, send_system_email};
use weldsuite_mail_domain::outbound::{
    CheckOutboundInput, OutboundGuard, OutboundKind, OutboundReservation, SubjectInput,
    check_outbound, commit_outbound, release_outbound,
};
use weldsuite_ports::{DynSystemMail, Mailbox};

use crate::common::{Ctx, Env, FormsResult, text, workspace_app_url};
use crate::engine::FormThemeTokens;

/// WeldSuite's own address, which the guard counts against the workspace.
pub(crate) const SYSTEM_SENDER: &str = "notifications@mail.weldsuite.org";

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

/// `FormsBrand`.
pub(crate) struct FormsBrand {
    pub(crate) brand: EmailBrand,
    /// Shown as the sender of invitations: the workspace's forms sender name, else its name.
    pub(crate) sender_name: String,
    pub(crate) workspace_name: String,
}

/// `workspaces.name` from the master database; `None` when it has none.
pub(crate) async fn workspace_name(ctx: &Ctx) -> FormsResult<Option<String>> {
    let Some(master) = ctx.master.as_ref() else {
        return Ok(None);
    };
    Ok(
        sqlx::query_scalar::<_, Option<String>>(
            "select name from workspaces where id = $1 limit 1",
        )
        .bind(&ctx.workspace_id)
        .fetch_optional(master)
        .await?
        .flatten(),
    )
}

/// `formsBrand(ctx, form)`: the workspace's name and, when the form has one,
/// its logo and button colour.
pub(crate) async fn forms_brand(ctx: &Ctx, form: Option<&Value>) -> FormsResult<FormsBrand> {
    let name = workspace_name(ctx).await?;
    let sender: Option<Option<String>> =
        sqlx::query_scalar("select sender_name from form_settings limit 1")
            .fetch_optional(&ctx.db)
            .await?;
    let mut tokens: Option<Value> = None;
    if let Some(form) = form {
        if let Some(version) = form["publishedVersionId"].as_str() {
            tokens = sqlx::query_scalar::<_, Option<Value>>(
                "select theme from form_versions where id = $1 limit 1",
            )
            .bind(version)
            .fetch_optional(&ctx.db)
            .await?
            .flatten();
        } else if let Some(theme) = form["themeId"].as_str() {
            tokens = sqlx::query_scalar::<_, Option<Value>>(
                "select tokens from form_themes where id = $1 limit 1",
            )
            .bind(theme)
            .fetch_optional(&ctx.db)
            .await?
            .flatten();
        }
    }
    let theme = tokens.and_then(|tokens| FormThemeTokens::parse(&tokens).ok());
    let workspace_name = name
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "WeldSuite".to_owned());
    let sender_name = sender
        .flatten()
        .map(|s| weldsuite_kit::validation::js_trim(&s).to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| workspace_name.clone());
    Ok(FormsBrand {
        brand: EmailBrand::Workspace {
            name: sender_name.clone(),
            logo_url: theme.as_ref().and_then(|t| t.logo_url.clone()),
            accent_color: theme.map(|t| t.colors.button),
        },
        sender_name,
        workspace_name,
    })
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

fn origin(env: &Env, key: &str, fallback: &str) -> String {
    let value = env.non_empty(key).unwrap_or_else(|| fallback.to_owned());
    value.strip_suffix('/').map_or(value.clone(), str::to_owned)
}

/// `invitationUrl(env, publicId, token)`: `<portal>/i/<publicId>.<token>`.
pub(crate) fn invitation_url(env: &Env, public_id: &str, token: &str) -> String {
    format!(
        "{}/i/{public_id}.{token}",
        origin(env, "FORMS_PORTAL_URL", "https://forms.weldsuite.org")
    )
}

/// `resultsUrl(env, clerkOrgId, formId, query)`.
pub(crate) fn results_url(env: &Env, clerk_org_id: &str, form_id: &str, query: &str) -> String {
    workspace_app_url(
        &origin(env, "PLATFORM_URL", "https://app.weldsuite.org"),
        clerk_org_id,
        &format!("/weldforms/{form_id}/results?{query}"),
    )
}

/// `plansUrl(env, clerkOrgId)`.
pub(crate) fn plans_url(env: &Env, clerk_org_id: &str) -> String {
    workspace_app_url(
        &origin(env, "PLATFORM_URL", "https://app.weldsuite.org"),
        clerk_org_id,
        "/settings/billing",
    )
}

// ---------------------------------------------------------------------------
// Outbound guard
// ---------------------------------------------------------------------------

/// What `reserveOutboundMail` answered.
pub(crate) enum Reserved {
    /// The guard said no: send nothing.
    Refused,
    /// Go ahead; settle the reservation after sending.
    Go(Box<OutboundReservation>),
}

/// The guard for this workspace's sends.
pub(crate) fn guard_of(ctx: &Ctx) -> OutboundGuard {
    ctx.svc
        .outbound
        .guard(ctx.master.clone(), Some(Arc::clone(&ctx.svc.cache)))
}

/// `reserveOutboundMail(env, db, clerkOrgId, input)`.
pub(crate) async fn reserve_outbound_mail(
    ctx: &Ctx,
    guard: &OutboundGuard,
    to: Vec<String>,
    names: Vec<String>,
    subject_line: &str,
    body_text: Option<&str>,
) -> Reserved {
    let mut input = CheckOutboundInput::new(
        SubjectInput::Workspace {
            clerk_org_id: ctx.clerk_org_id.clone(),
            workspace_id: None,
        },
        "forms",
        OutboundKind::NewThread,
        SYSTEM_SENDER,
        to,
    );
    input.system_sender = true;
    input.subject_line = Some(subject_line.to_owned());
    input.text = body_text.map(str::to_owned);
    input.recipient_names = names;
    match check_outbound(guard, Some(&ctx.db), &input).await {
        Ok(reservation) => Reserved::Go(Box::new(reservation)),
        Err(denied) => {
            tracing::warn!(
                "[forms-api/mail] mail refused by the outbound guard ({:?})",
                denied.code()
            );
            Reserved::Refused
        }
    }
}

/// `settleOutboundMail(env, db, reservation, sent, total)`.
pub(crate) async fn settle_outbound_mail(
    ctx: &Ctx,
    guard: &OutboundGuard,
    reservation: &OutboundReservation,
    sent: &[String],
    total: usize,
) {
    if sent.is_empty() {
        release_outbound(guard, reservation).await;
    } else {
        let partial = (sent.len() < total).then_some(sent);
        commit_outbound(guard, Some(&ctx.db), reservation, partial).await;
    }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/// The mail transport; `None` (with a warning) when there is none.
fn transport(ctx: &Ctx) -> Option<&dyn DynSystemMail> {
    ctx.svc.mail.as_deref()
}

async fn deliver(
    transport: &dyn DynSystemMail,
    rendered: RenderedEmail,
    brand: EmailBrand,
    to: &str,
    name: Option<&str>,
    reply_to: Option<&str>,
) -> Result<(), String> {
    let mut email = SystemEmail::to(rendered, brand, to).reply_to(reply_to);
    if let Some(name) = name.filter(|n| !n.is_empty()) {
        email.to = vec![Mailbox::new(to).named(name)];
    }
    send_system_email(transport, email)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// `InviteMail`.
pub(crate) struct InviteMail {
    pub(crate) email: String,
    pub(crate) name: Option<String>,
    pub(crate) locale: String,
    pub(crate) url: String,
    pub(crate) subject: Option<String>,
    pub(crate) message: Option<String>,
}

/// `sendInvitationMails(ctx, mails, { reminder, reservation })` with the
/// reservation already made (or `None`: the caller reserved the batch and
/// settles it itself). The addresses that went out.
#[allow(
    clippy::too_many_arguments,
    reason = "the worker's context and options"
)]
pub(crate) async fn send_invitation_mails(
    ctx: &Ctx,
    guard: &OutboundGuard,
    form: &Value,
    sender_email: Option<&str>,
    closes_at: Option<&str>,
    mails: &[InviteMail],
    reminder: bool,
    reservation: Option<&OutboundReservation>,
) -> FormsResult<Vec<String>> {
    if mails.is_empty() {
        return Ok(Vec::new());
    }
    let Some(transport) = transport(ctx) else {
        tracing::warn!("[forms-api/mail] no email transport configured; invitations not sent");
        if let Some(reservation) = reservation {
            release_outbound(guard, reservation).await;
        }
        return Ok(Vec::new());
    };
    let brand = forms_brand(ctx, Some(form)).await?;
    let title = text(form, "title");
    let mut sent = Vec::new();
    for mail in mails {
        let props = InviteProps {
            sender_name: &brand.sender_name,
            title,
            subject: mail.subject.as_deref(),
            message: mail.message.as_deref(),
            url: &mail.url,
            closes_at,
            time_zone: None,
            reminder,
        };
        let locale = EmailLocale::resolve([Some(mail.locale.as_str())]);
        let outcome = match weldsuite_emails::forms::invite(locale, &brand.brand, &props) {
            Ok(rendered) => {
                deliver(
                    transport,
                    rendered,
                    brand.brand.clone(),
                    &mail.email,
                    mail.name.as_deref(),
                    sender_email,
                )
                .await
            }
            Err(error) => Err(error.to_string()),
        };
        match outcome {
            Ok(()) => sent.push(mail.email.clone()),
            Err(error) => tracing::error!(
                error,
                form = text(form, "id"),
                "[forms-api/mail] invitation failed"
            ),
        }
    }
    if let Some(reservation) = reservation {
        settle_outbound_mail(ctx, guard, reservation, &sent, mails.len()).await;
    }
    Ok(sent)
}

/// `sendReceiptMail(ctx, form, definition, to, number, answers)`.
pub(crate) async fn send_receipt_mail(
    ctx: &Ctx,
    form: &Value,
    language: Option<&str>,
    to: &str,
    number: Option<i64>,
    answers: &[QuestionAnswer],
) -> FormsResult<bool> {
    let Some(transport) = transport(ctx) else {
        return Ok(false);
    };
    if answers.is_empty() {
        return Ok(false);
    }
    let brand = forms_brand(ctx, Some(form)).await?;
    let rendered = weldsuite_emails::forms::receipt(
        EmailLocale::resolve([language]),
        &brand.brand,
        text(form, "title"),
        number,
        answers,
    );
    let outcome = match rendered {
        Ok(rendered) => deliver(transport, rendered, brand.brand, to, None, None).await,
        Err(error) => Err(error.to_string()),
    };
    Ok(match outcome {
        Ok(()) => true,
        Err(error) => {
            tracing::error!(
                error,
                form = text(form, "id"),
                "[forms-api/mail] receipt failed"
            );
            false
        }
    })
}

/// A member a mail goes to (`MemberRecipient`).
#[derive(Debug, Clone)]
pub(crate) struct MemberRecipient {
    pub(crate) user_id: String,
    pub(crate) email: String,
}

/// `sendDigestMail(ctx, form, to, { count, responses })`.
pub(crate) async fn send_digest_mail(
    ctx: &Ctx,
    form: &Value,
    to: &MemberRecipient,
    count: i64,
    responses: &[DigestItem],
) -> FormsResult<bool> {
    let Some(transport) = transport(ctx) else {
        return Ok(false);
    };
    let brand = forms_brand(ctx, Some(form)).await?;
    let weldforms = EmailBrand::weldsuite("WeldForms");
    let rendered = weldsuite_emails::forms::digest(
        EmailLocale::resolve([None]),
        &weldforms,
        text(form, "title"),
        &brand.workspace_name,
        count,
        responses,
        &results_url(
            ctx.env(),
            &ctx.clerk_org_id,
            text(form, "id"),
            "tab=responses",
        ),
    );
    let outcome = match rendered {
        Ok(rendered) => deliver(transport, rendered, weldforms, &to.email, None, None).await,
        Err(error) => Err(error.to_string()),
    };
    Ok(match outcome {
        Ok(()) => true,
        Err(error) => {
            tracing::error!(
                error,
                form = text(form, "id"),
                "[forms-api/mail] digest failed"
            );
            false
        }
    })
}

/// `sendQuotaMail(ctx, to, props)`.
pub(crate) async fn send_quota_mail(
    ctx: &Ctx,
    to: &MemberRecipient,
    workspace_name: &str,
    percent: u8,
    used: i64,
    limit: i64,
    resets_at: &str,
) -> bool {
    let Some(transport) = transport(ctx) else {
        return false;
    };
    let weldforms = EmailBrand::weldsuite("WeldForms");
    let rendered = weldsuite_emails::forms::quota(
        EmailLocale::resolve([None]),
        &weldforms,
        workspace_name,
        percent,
        used,
        limit,
        resets_at,
        &plans_url(ctx.env(), &ctx.clerk_org_id),
    );
    let outcome = match rendered {
        Ok(rendered) => deliver(transport, rendered, weldforms, &to.email, None, None).await,
        Err(error) => Err(error.to_string()),
    };
    match outcome {
        Ok(()) => true,
        Err(error) => {
            tracing::error!(error, "[forms-api/mail] quota mail failed");
            false
        }
    }
}

/// The response notification's email (`forms.response`) as the
/// notifications orchestrator sends it: to the member's address, in their
/// language (else the workspace's), branded WeldForms.
#[allow(clippy::too_many_arguments, reason = "the notification's parts")]
pub(crate) async fn send_response_notification_mail(
    ctx: &Ctx,
    db: &PgPool,
    user_id: &str,
    form: &Value,
    number: Option<i64>,
    respondent: Option<&str>,
    answers: Option<&[QuestionAnswer]>,
    url: &str,
) {
    let Some(transport) = transport(ctx) else {
        return;
    };
    let lookup = async {
        let email: Option<Option<String>> =
            sqlx::query_scalar("select email from workspace_members where user_id = $1 limit 1")
                .bind(user_id)
                .fetch_optional(db)
                .await?;
        let language: Option<Option<String>> =
            sqlx::query_scalar("select language from user_preferences where user_id = $1 limit 1")
                .bind(user_id)
                .fetch_optional(db)
                .await?;
        let workspace: Option<Option<String>> = sqlx::query_scalar(
            "select language from workspace_settings where deleted_at is null limit 1",
        )
        .fetch_optional(db)
        .await?;
        Ok::<_, sqlx::Error>((email.flatten(), language.flatten(), workspace.flatten()))
    };
    let (email, language, workspace) = match lookup.await {
        Ok(found) => found,
        Err(error) => {
            tracing::error!(%error, "[Notifications] Email send failed");
            return;
        }
    };
    let Some(email) = email.filter(|e| !e.is_empty()) else {
        return;
    };
    let locale = EmailLocale::resolve([language.as_deref(), workspace.as_deref()]);
    let weldforms = EmailBrand::weldsuite("WeldForms");
    let rendered = weldsuite_emails::forms::response(
        locale,
        &weldforms,
        text(form, "title"),
        number,
        respondent,
        answers,
        url,
    );
    let outcome = match rendered {
        Ok(rendered) => deliver(transport, rendered, weldforms, &email, None, None).await,
        Err(error) => Err(error.to_string()),
    };
    if let Err(error) = outcome {
        tracing::error!(error, "[Notifications] Email send failed");
    }
}
