//! The sign-in code email of the client portal (`services/project-portal-mail.ts`):
//! the shared `portal.sign-in` template of `weldsuite-emails` (a code, no
//! link), in the recipient's language and under the workspace's name.
//!
//! Without a transport the send is a no-op, so local and test runs still go
//! through sign-in; a failed send is logged, never raised: the answer to a code
//! request is the same either way.

use std::sync::Arc;

use weldsuite_emails::portal::{PortalSignIn, sign_in};
use weldsuite_emails::{
    EmailBrand, EmailLocale, SYSTEM_FROM_ADDRESS, SystemEmail, send_system_email,
};
use weldsuite_flow_domain::project_portal::PORTAL_CODE_TTL_SECONDS;
use weldsuite_mail_domain::outbound::mime::MailAddress;
use weldsuite_mail_domain::outbound::transmit::{SendEmailParams, send_email};
use weldsuite_ports::{DynSystemMail, MailTransport};

/// Where the portal's mail goes: the test's `SEND_EMAIL` (conformance; none
/// when it has none), else the deployment's system mail.
pub(crate) enum PortalMail {
    Transport(Arc<dyn MailTransport>),
    System(Arc<dyn DynSystemMail>),
    None,
}

/// `portalDisplayName(workspaceName, locale)`: the name of the portal as the
/// recipient knows it.
pub(crate) fn portal_display_name(workspace_name: &str, locale: EmailLocale) -> String {
    match locale {
        EmailLocale::Nl => format!("Projectportaal van {workspace_name}"),
        EmailLocale::En => format!("{workspace_name} project portal"),
    }
}

/// `sendPortalCodeEmail(env, { to, code, workspaceName, locale })`: false when
/// there is no transport or the send failed.
pub(crate) async fn send_portal_code_email(
    mail: &PortalMail,
    to: &str,
    code: &str,
    workspace_name: &str,
    locale: EmailLocale,
) -> bool {
    if matches!(mail, PortalMail::None) {
        return false;
    }
    let brand = EmailBrand::Workspace {
        name: workspace_name.to_owned(),
        logo_url: None,
        accent_color: None,
    };
    let rendered = match sign_in(
        locale,
        &brand,
        &PortalSignIn {
            portal_name: portal_display_name(workspace_name, locale),
            code: code.to_owned(),
            url: None,
            expires_in_minutes: Some(u32::try_from(PORTAL_CODE_TTL_SECONDS / 60).unwrap_or(15)),
        },
    ) {
        Ok(rendered) => rendered,
        Err(error) => {
            tracing::warn!(%error, "[flow-api/public-project-portal] sign-in code email skipped");
            return false;
        }
    };
    let sent = match mail {
        PortalMail::System(system) => {
            let mut email = SystemEmail::to(rendered, brand, to);
            email.from_name = Some(workspace_name.to_owned());
            send_system_email(system.as_ref(), email)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        PortalMail::Transport(transport) => {
            let from = MailAddress {
                email: SYSTEM_FROM_ADDRESS.to_owned(),
                name: Some(workspace_name.to_owned()),
            };
            let params = SendEmailParams {
                from: from.formatted(),
                to: vec![to.to_owned()],
                cc: Vec::new(),
                bcc: Vec::new(),
                subject: rendered.subject,
                text: Some(rendered.text),
                html: Some(rendered.html),
                reply_to: None,
                headers: Vec::new(),
                attachments: Vec::new(),
            };
            send_email(transport.as_ref(), &params)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        PortalMail::None => return false,
    };
    match sent {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!(%error, "[flow-api/public-project-portal] sign-in code email skipped");
            false
        }
    }
}
