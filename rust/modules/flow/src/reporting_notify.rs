//! Notifications of the status reports and the stakeholder portal
//! (`lib/report-notifications.ts`): a published report goes to its recipients
//! (members in-app, client contacts by email), the `status_report_due` sweep
//! tells the project manager a draft is ready, and a contact is invited to the
//! portal. All of it runs after the response and a failure is only logged.
//!
//! A member's email is not sent from here: `weldsuite_notifications` does not
//! send notification email yet (the `flow.status-report` override TypeScript
//! passes), so a member gets the in-app notification only. Client contacts are
//! emailed directly, as TypeScript does.

#![allow(
    clippy::too_many_lines,
    clippy::type_complexity,
    clippy::similar_names,
    clippy::single_match_else
)]

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_emails::flow::{
    FlowPortalInvitation, FlowStatusReport, Overall, period_label, portal_invitation, status_report,
};
use weldsuite_emails::{EmailBrand, EmailLocale, SystemEmail, send_system_email};
use weldsuite_flow_domain::stakeholders::project_portal_url;
use weldsuite_flow_domain::status_report::RecipientCandidate;
use weldsuite_notifications::{NewNotification, Notifier, create_and_deliver};
use weldsuite_ports::DynSystemMail;

use crate::reporting_store::{ReportProject, member_identities};
use crate::{Caller, FlowState};

/// What a background send needs.
#[derive(Clone)]
pub(crate) struct NotifyContext {
    pub(crate) db: PgPool,
    pub(crate) notifier: Notifier,
    pub(crate) master: Option<PgPool>,
    pub(crate) mail: Option<Arc<dyn DynSystemMail>>,
    /// `PROJECT_PORTAL_URL`.
    pub(crate) portal_url: Option<String>,
    /// `workspaces.id`.
    pub(crate) workspace_id: String,
    /// The Clerk org id: where in-app notifications go.
    pub(crate) org_id: String,
    pub(crate) actor_id: Option<String>,
}

impl NotifyContext {
    pub(crate) fn of(state: &FlowState, caller: &Caller) -> Self {
        Self {
            db: caller.db.clone(),
            notifier: caller.notifier(state),
            master: caller.master(state),
            mail: state.system_mail.clone(),
            portal_url: caller
                .env("PROJECT_PORTAL_URL")
                .or_else(|| state.project_portal_url.as_deref().map(str::to_owned))
                .filter(|url| !url.is_empty()),
            workspace_id: caller.workspace_id.clone(),
            org_id: caller.clerk_org_id.clone().unwrap_or_default(),
            actor_id: Some(caller.user_id.clone()),
        }
    }
}

/// `reportAppPath(projectId, reportId)`.
pub(crate) fn report_app_path(project_id: &str, report_id: &str) -> String {
    format!("/weldflow/project/{project_id}/governance?report={report_id}")
}

async fn workspace_name(ctx: &NotifyContext) -> Option<String> {
    let master = ctx.master.as_ref()?;
    sqlx::query_scalar::<_, String>(
        "select name from workspaces where id = $1 or clerk_org_id = $1 limit 1",
    )
    .bind(&ctx.workspace_id)
    .fetch_optional(master)
    .await
    .ok()
    .flatten()
}

async fn contact_language(db: &PgPool, contact_id: &str) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>("select preferred_language from people where id = $1")
        .bind(contact_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .flatten()
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `sendPublishedReport`: returns `(sent, skipped)`.
pub(crate) async fn send_published_report(
    ctx: &NotifyContext,
    report: &Value,
    project: &ReportProject,
    targets: &[RecipientCandidate],
    contact_ids: &HashMap<String, String>,
) -> (usize, usize) {
    let (mut sent, mut skipped) = (0, 0);
    let Some(overall) = text(report, "overall").and_then(Overall::parse) else {
        return (0, 0);
    };
    let overall_text = text(report, "overall").unwrap_or_default();
    let period = text(report, "period").unwrap_or_default();
    let report_id = text(report, "id").unwrap_or_default();
    let summary = text(report, "summary").unwrap_or_default().to_owned();
    let client_visible = report
        .get("clientVisible")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let publisher = match text(report, "publishedBy") {
        Some(id) => member_identities(&ctx.db, &[id.to_owned()])
            .await
            .ok()
            .and_then(|mut found| found.remove(id))
            .and_then(|(name, _)| name),
        None => None,
    };
    for target in targets {
        if let Some(user_id) = &target.user_id {
            if ctx.actor_id.as_deref() == Some(user_id.as_str()) {
                skipped += 1;
                continue;
            }
            let params = NewNotification {
                workspace_id: ctx.org_id.clone(),
                clerk_org_id: None,
                user_id: user_id.clone(),
                title: format!("Status report: {}", project.name),
                body: format!("{}: {overall_text}", period_label(EmailLocale::En, period)),
                category: "projects".to_owned(),
                notification_type: "project_updated".to_owned(),
                entity_type: "project_status_report".to_owned(),
                entity_id: report_id.to_owned(),
                action_url: report_app_path(&project.id, report_id),
                severity: "info".to_owned(),
                actor_type: Some(
                    if ctx.actor_id.is_some() {
                        "user"
                    } else {
                        "system"
                    }
                    .to_owned(),
                ),
                actor_id: ctx.actor_id.clone(),
                ..NewNotification::default()
            };
            match create_and_deliver(&ctx.db, &ctx.notifier, &params).await {
                Ok(_) => sent += 1,
                Err(error) => {
                    skipped += 1;
                    tracing::error!(%error, "[flow-api/status-reports] sending the report failed");
                }
            }
            continue;
        }
        let (Some(portal), Some(email), Some(mail)) = (&ctx.portal_url, &target.email, &ctx.mail)
        else {
            skipped += 1;
            continue;
        };
        if !client_visible || !target.portal_access {
            skipped += 1;
            continue;
        }
        let contact = target
            .stakeholder_id
            .as_ref()
            .and_then(|id| contact_ids.get(id));
        let language = match contact {
            Some(id) => contact_language(&ctx.db, id).await,
            None => None,
        };
        let locale = EmailLocale::resolve([language.as_deref()]);
        let brand = EmailBrand::Workspace {
            name: workspace_name(ctx)
                .await
                .unwrap_or_else(|| "WeldSuite".to_owned()),
            logo_url: None,
            accent_color: None,
        };
        let props = FlowStatusReport {
            recipient_name: target.name.clone(),
            project_name: project.name.clone(),
            period_label: period_label(locale, period),
            overall,
            summary: summary.clone(),
            published_by: publisher.clone(),
            url: project_portal_url(portal, &ctx.workspace_id, &project.id),
        };
        let result = match status_report(locale, &brand, &props) {
            Ok(rendered) => {
                send_system_email(mail.as_ref(), SystemEmail::to(rendered, brand, email))
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }
            Err(error) => Err(error.to_string()),
        };
        match result {
            Ok(()) => sent += 1,
            Err(error) => {
                skipped += 1;
                tracing::error!(error, "[flow-api/status-reports] sending the report failed");
            }
        }
    }
    (sent, skipped)
}

/// `notifyDraftReady`: tell the project manager a draft is ready.
pub(crate) async fn notify_draft_ready(
    ctx: &NotifyContext,
    report: &Value,
    project: &ReportProject,
) -> bool {
    let Some(manager) = &project.project_manager_id else {
        return false;
    };
    let report_id = text(report, "id").unwrap_or_default();
    let period = text(report, "period").unwrap_or_default();
    let params = NewNotification {
        workspace_id: ctx.org_id.clone(),
        user_id: manager.clone(),
        title: format!("Status report ready to review: {}", project.name),
        body: format!(
            "The draft for {} is ready.",
            period_label(EmailLocale::En, period)
        ),
        category: "projects".to_owned(),
        notification_type: "project_updated".to_owned(),
        entity_type: "project_status_report".to_owned(),
        entity_id: report_id.to_owned(),
        action_url: report_app_path(&project.id, report_id),
        severity: "info".to_owned(),
        actor_type: Some("system".to_owned()),
        actor_id: None,
        ..NewNotification::default()
    };
    match create_and_deliver(&ctx.db, &ctx.notifier, &params).await {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, "[flow-api/status-reports] notifying the project manager failed");
            false
        }
    }
}

/// `sendPortalInvitation`: returns whether the mail went out.
pub(crate) async fn send_portal_invitation(
    ctx: &NotifyContext,
    project: &ReportProject,
    contact_id: &str,
    contact_name: Option<String>,
    contact_email: &str,
    inviter: Option<String>,
) -> bool {
    let Some(portal) = &ctx.portal_url else {
        tracing::warn!(
            "[flow-api/stakeholders] PROJECT_PORTAL_URL is not set, skipping the portal invitation"
        );
        return false;
    };
    let Some(mail) = &ctx.mail else {
        tracing::warn!(
            "[flow-api/stakeholders] no email transport configured, skipping the portal invitation"
        );
        return false;
    };
    let language = contact_language(&ctx.db, contact_id).await;
    let locale = EmailLocale::resolve([language.as_deref()]);
    let name = workspace_name(ctx)
        .await
        .unwrap_or_else(|| "WeldSuite".to_owned());
    let brand = EmailBrand::Workspace {
        name: name.clone(),
        logo_url: None,
        accent_color: None,
    };
    let props = FlowPortalInvitation {
        contact_name,
        project_name: project.name.clone(),
        invited_by: inviter,
        workspace_name: name,
        url: project_portal_url(portal, &ctx.workspace_id, &project.id),
    };
    let result = match portal_invitation(locale, &brand, &props) {
        Ok(rendered) => send_system_email(
            mail.as_ref(),
            SystemEmail::to(rendered, brand, contact_email),
        )
        .await
        .map(|_| ())
        .map_err(|e| e.to_string()),
        Err(error) => Err(error.to_string()),
    };
    if let Err(error) = &result {
        tracing::error!(
            error,
            "[flow-api/stakeholders] sending the portal invitation failed"
        );
    }
    result.is_ok()
}
