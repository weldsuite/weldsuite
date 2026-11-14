//! The invitation to a workspace
//! (`packages/core/emails/src/templates/workspace/invitation.tsx`), as
//! workspace-worker sends it on Global from Clerk's invitation webhook. On
//! the Kubernetes editions the identity adapter hands it over
//! ([`SystemInvitationMailer`]) instead of letting Zitadel mail its own.

use std::collections::BTreeMap;
use std::sync::Arc;

use minijinja::Value;
use weldsuite_ports::{BoxFuture, DynSystemMail, InvitationEmail, InvitationMailer, PortError};

use crate::{
    EmailBrand, EmailError, EmailLocale, RenderedEmail, SystemEmail, render, send_system_email,
};

/// `WorkspaceInvitationEmailProps`.
#[derive(Debug, Clone, Default)]
pub struct WorkspaceInvitation {
    pub inviter_name: String,
    pub workspace_name: String,
    /// The role as the invitee reads it ("Admin").
    pub role: String,
    pub accept_url: String,
    pub recipient_email: String,
}

pub fn invitation(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &WorkspaceInvitation,
) -> Result<RenderedEmail, EmailError> {
    let mut values = BTreeMap::new();
    for (key, value) in [
        ("inviter_name", &props.inviter_name),
        ("workspace_name", &props.workspace_name),
        ("role", &props.role),
        ("accept_url", &props.accept_url),
        ("recipient_email", &props.recipient_email),
    ] {
        values.insert(key.to_owned(), Value::from(value.as_str()));
    }
    render("workspace.invitation", locale, brand, &[], values)
}

/// A provider role key as the invitee reads it (`mapClerkRoleToDisplay`).
pub fn role_display(role: &str) -> &'static str {
    match role {
        "org:admin" => "Admin",
        _ => "Member",
    }
}

/// [`InvitationMailer`] on the system mail. English, like workspace-worker's:
/// nothing says which language the invitee reads. Replies go to the inviter.
pub struct SystemInvitationMailer {
    mail: Arc<dyn DynSystemMail>,
}

impl SystemInvitationMailer {
    pub fn new(mail: Arc<dyn DynSystemMail>) -> Self {
        Self { mail }
    }
}

impl std::fmt::Debug for SystemInvitationMailer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SystemInvitationMailer")
            .finish_non_exhaustive()
    }
}

impl InvitationMailer for SystemInvitationMailer {
    fn send<'a>(&'a self, email: &'a InvitationEmail) -> BoxFuture<'a, Result<(), PortError>> {
        Box::pin(async move {
            let brand = EmailBrand::WeldSuite { module: None };
            let props = WorkspaceInvitation {
                inviter_name: email
                    .inviter_name
                    .clone()
                    .unwrap_or_else(|| "A teammate".to_owned()),
                workspace_name: email
                    .workspace_name
                    .clone()
                    .unwrap_or_else(|| "a WeldSuite workspace".to_owned()),
                role: role_display(&email.role).to_owned(),
                accept_url: email.accept_url.clone(),
                recipient_email: email.to.clone(),
            };
            let rendered = invitation(EmailLocale::En, &brand, &props)
                .map_err(|error| PortError::backend(format!("invitation email: {error}")))?;
            let message = SystemEmail::to(rendered, brand, &email.to)
                .reply_to(email.inviter_email.as_deref());
            send_system_email(self.mail.as_ref(), message).await?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_ports::RecordingSystemMail;

    #[test]
    fn renders_the_invitation() {
        let email = invitation(
            EmailLocale::En,
            &EmailBrand::WeldSuite { module: None },
            &WorkspaceInvitation {
                inviter_name: "Sanne de Vries".into(),
                workspace_name: "Acme Studio".into(),
                role: "Admin".into(),
                accept_url: "https://auth.weldsuite.eu/ui/login/user/invite?code=AB12".into(),
                recipient_email: "tom@example.com".into(),
            },
        )
        .expect("renders");
        assert_eq!(
            email.subject,
            "Sanne de Vries invited you to Acme Studio on WeldSuite"
        );
        assert!(email.html.contains("invite?code=AB12"));
        assert!(email.text.contains("tom@example.com"));
    }

    #[tokio::test]
    async fn the_mailer_sends_it_with_reply_to_the_inviter() {
        let recorder = Arc::new(RecordingSystemMail::default());
        let mailer = SystemInvitationMailer::new(recorder.clone());
        mailer
            .send(&InvitationEmail {
                to: "tom@example.com".into(),
                inviter_name: None,
                inviter_email: Some("sanne@acme.example".into()),
                workspace_name: Some("Acme Studio".into()),
                role: "org:member".into(),
                accept_url: "https://auth.weldsuite.eu/ui/login/user/invite?code=AB12".into(),
            })
            .await
            .expect("sent");
        let sent = recorder.sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].to[0].email, "tom@example.com");
        assert_eq!(
            sent[0].reply_to.as_ref().map(|m| m.email.as_str()),
            Some("sanne@acme.example")
        );
        assert_eq!(
            sent[0].subject,
            "A teammate invited you to Acme Studio on WeldSuite"
        );
        assert!(sent[0].text.contains("Member"));
    }
}
