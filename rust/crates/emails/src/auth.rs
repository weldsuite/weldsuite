//! The sign-in emails of WeldSuite's own sign-in screens (ADR SEC-016),
//! sent in place of the identity provider's
//! (`packages/core/emails/src/templates/auth/`). Global signs in on Clerk and
//! sends none of them.

use std::collections::BTreeMap;

use minijinja::Value;

use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, render};

/// Every sign-in email: WeldSuite's logo, sent as "WeldSuite".
pub fn brand() -> EmailBrand {
    EmailBrand::WeldSuite { module: None }
}

/// `auth.verify-email`: the button that verifies the address, and the code
/// for the sign-in screen.
pub fn verify_email(
    locale: EmailLocale,
    code: &str,
    url: &str,
    expires_in_minutes: u32,
) -> Result<RenderedEmail, EmailError> {
    let mut values = BTreeMap::new();
    values.insert("code".to_owned(), Value::from(code));
    values.insert("url".to_owned(), Value::from(url));
    values.insert("minutes".to_owned(), Value::from(expires_in_minutes));
    render("auth.verify-email", locale, &brand(), &[], values)
}

/// `auth.sign-in-code`: the second factor by email.
pub fn sign_in_code(
    locale: EmailLocale,
    code: &str,
    expires_in_minutes: u32,
) -> Result<RenderedEmail, EmailError> {
    let mut values = BTreeMap::new();
    values.insert("code".to_owned(), Value::from(code));
    values.insert("minutes".to_owned(), Value::from(expires_in_minutes));
    render("auth.sign-in-code", locale, &brand(), &[], values)
}

/// `auth.password-reset`: the button to the reset page, and the code for the
/// reset screen.
pub fn password_reset(
    locale: EmailLocale,
    email: &str,
    code: &str,
    url: &str,
    expires_in_minutes: u32,
) -> Result<RenderedEmail, EmailError> {
    let mut values = BTreeMap::new();
    values.insert("email".to_owned(), Value::from(email));
    values.insert("code".to_owned(), Value::from(code));
    values.insert("url".to_owned(), Value::from(url));
    values.insert("minutes".to_owned(), Value::from(expires_in_minutes));
    render("auth.password-reset", locale, &brand(), &[], values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_verification_email_carries_the_link_and_the_code() {
        let url = "https://app.weldsuite.eu/auth/login?verifyUser=1&verifyCode=K7Q2XR";
        let email = verify_email(EmailLocale::En, "K7Q2XR", url, 60).expect("renders");
        assert_eq!(email.subject, "Confirm your email address for WeldSuite");
        assert!(email.html.contains("K7Q2XR"));
        assert!(email.html.contains("verifyUser=1&amp;verifyCode=K7Q2XR"));
        assert!(email.text.contains(url));
        assert!(email.text.contains("60 minutes"));
        let dutch = verify_email(EmailLocale::Nl, "K7Q2XR", url, 60).expect("renders");
        assert_eq!(dutch.subject, "Bevestig je e-mailadres voor WeldSuite");
    }

    #[test]
    fn the_sign_in_code_is_in_the_subject() {
        let email = sign_in_code(EmailLocale::En, "48291374", 5).expect("renders");
        assert_eq!(email.subject, "Your WeldSuite sign-in code: 48291374");
        assert!(email.text.contains("5 minutes"));
    }

    #[test]
    fn the_reset_email_names_the_account() {
        let url = "https://app.weldsuite.eu/auth/reset-password?userId=1&code=K7Q2XR";
        let email =
            password_reset(EmailLocale::En, "tom@example.com", "K7Q2XR", url, 60).expect("renders");
        assert_eq!(email.subject, "Reset your WeldSuite password");
        assert!(email.html.contains("tom@example.com"));
        assert!(email.text.contains(url));
        assert!(email.text.contains("K7Q2XR"));
    }
}
