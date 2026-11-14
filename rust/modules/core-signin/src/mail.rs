//! Who emails the sign-in codes. With the system mail and the platform's
//! address, WeldSuite does, in its own templates (`auth.*` in
//! `@weldsuite/emails`): the provider hands each code back
//! ([`CodeDelivery::Return`]). Without either, the provider mails its own,
//! its links pointing at the platform's pages when it has their address.
//!
//! Like the provider's own email, ours is best effort: a failure is logged
//! and the step goes on, as the screen has "Resend".

use std::time::Duration;

use http::HeaderMap;
use http::header::ACCEPT_LANGUAGE;
use tracing::Instrument;
use weldsuite_emails::{EmailLocale, SystemEmail, auth, send_system_email};
use weldsuite_ports::{CodeDelivery, CodeKind};

use crate::SignInState;

/// The language of the emails a request sends: the browser's first language
/// WeldSuite has (`Accept-Language`), else English.
pub(crate) fn locale(headers: &HeaderMap) -> EmailLocale {
    let header = headers
        .get(ACCEPT_LANGUAGE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    EmailLocale::resolve(
        header
            .split(',')
            .map(|part| part.split(';').next().map(str::trim)),
    )
}

/// A code the provider handed back, and what it is for.
#[derive(Debug, Clone, Copy)]
pub(crate) enum CodeMail<'a> {
    /// Verifies the address of `user_id`.
    Verification {
        user_id: &'a str,
        code: &'a str,
    },
    SecondFactor {
        code: &'a str,
    },
    PasswordReset {
        user_id: &'a str,
        code: &'a str,
    },
}

impl CodeMail<'_> {
    fn kind(self) -> CodeKind {
        match self {
            Self::Verification { .. } => CodeKind::EmailVerification,
            Self::SecondFactor { .. } => CodeKind::EmailSecondFactor,
            Self::PasswordReset { .. } => CodeKind::PasswordReset,
        }
    }

    /// Zitadel's own lifetimes, when the provider names none.
    fn default_lifetime(self) -> Duration {
        match self {
            Self::SecondFactor { .. } => Duration::from_mins(5),
            Self::Verification { .. } | Self::PasswordReset { .. } => Duration::from_hours(1),
        }
    }
}

impl SignInState {
    /// What the provider is asked for a code whose email links to `link`:
    /// the code itself when WeldSuite sends the email, else the provider's
    /// own email.
    pub(crate) fn delivery<'a>(&self, link: Option<&'a str>) -> CodeDelivery<'a> {
        if self.mail.is_some() && link.is_some() {
            CodeDelivery::Return
        } else {
            CodeDelivery::Provider(link)
        }
    }

    /// Email a password reset code off the request path. `POST
    /// /password-reset` answers alike whether or not an account has the
    /// address; waiting for the template and the SMTP round trip, which only
    /// an existing account takes, would tell the two apart by how long the
    /// answer takes.
    pub(crate) fn email_password_reset(
        &self,
        code: String,
        user_id: String,
        to: Option<String>,
        locale: EmailLocale,
    ) {
        let state = self.clone();
        tokio::spawn(
            async move {
                let mail = CodeMail::PasswordReset {
                    user_id: &user_id,
                    code: &code,
                };
                state
                    .email_code(Some(mail), &user_id, to.as_deref(), locale)
                    .await;
            }
            .in_current_span(),
        );
    }

    /// Email a code the provider handed back (`None`: it sent its own) to
    /// `to`, or to `user_id`'s address when `to` is `None`.
    pub(crate) async fn email_code(
        &self,
        code: Option<CodeMail<'_>>,
        user_id: &str,
        to: Option<&str>,
        locale: EmailLocale,
    ) {
        let (Some(code), Some(transport)) = (code, &self.mail) else {
            return;
        };
        let to = match to {
            Some(to) => Some(to.to_owned()),
            None => match self.provider.user(user_id).await {
                Ok(user) => user.and_then(|user| user.email),
                Err(error) => {
                    tracing::warn!(%error, "sign-in: address for the code not read");
                    None
                }
            },
        };
        let Some(to) = to.filter(|to| !to.trim().is_empty()) else {
            tracing::warn!("sign-in: the account has no address, code not emailed");
            return;
        };
        let lifetime = self
            .provider
            .code_format(code.kind())
            .await
            .expires_in
            .unwrap_or_else(|| code.default_lifetime());
        let minutes = u32::try_from(lifetime.as_secs().div_ceil(60))
            .unwrap_or(u32::MAX)
            .max(1);
        let rendered = match code {
            CodeMail::Verification { user_id, code } => self
                .links
                .verification_for(user_id, code)
                .map(|url| auth::verify_email(locale, code, &url, minutes)),
            CodeMail::SecondFactor { code } => Some(auth::sign_in_code(locale, code, minutes)),
            CodeMail::PasswordReset { user_id, code } => self
                .links
                .password_reset_for(user_id, code)
                .map(|url| auth::password_reset(locale, &to, code, &url, minutes)),
        };
        let rendered = match rendered {
            Some(Ok(rendered)) => rendered,
            Some(Err(error)) => {
                tracing::error!(%error, "sign-in: code email not rendered");
                return;
            }
            None => {
                tracing::error!("sign-in: no platform address for the code's link");
                return;
            }
        };
        let message = SystemEmail::to(rendered, auth::brand(), &to);
        if let Err(error) = send_system_email(transport.as_ref(), message).await {
            tracing::error!(%error, "sign-in: code email not sent");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn with_language(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT_LANGUAGE,
            HeaderValue::from_str(value).expect("header"),
        );
        headers
    }

    #[test]
    fn the_browser_language_picks_the_email_language() {
        assert_eq!(
            locale(&with_language("nl-NL,nl;q=0.9,en;q=0.8")),
            EmailLocale::Nl
        );
        assert_eq!(locale(&with_language("de-DE,nl;q=0.8")), EmailLocale::Nl);
        assert_eq!(locale(&with_language("en-GB,nl;q=0.5")), EmailLocale::En);
        assert_eq!(locale(&with_language("fr-FR")), EmailLocale::En);
        assert_eq!(locale(&HeaderMap::new()), EmailLocale::En);
    }
}
