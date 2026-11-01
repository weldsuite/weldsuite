//! The customer portals' sign-in mail
//! (`packages/core/emails/src/templates/portal/sign-in.tsx`): a code, and
//! for the `WeldCommerce` order portal a magic link above it.

use std::collections::BTreeMap;

use minijinja::Value;

use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, render};

/// `PortalSignInEmailProps`.
#[derive(Debug, Clone, Default)]
pub struct PortalSignIn {
    /// The portal as the recipient knows it ("Acme order portal").
    pub portal_name: String,
    pub code: String,
    /// The magic link; with one the email leads with a sign-in button.
    pub url: Option<String>,
    /// Minutes until the code expires (default 15).
    pub expires_in_minutes: Option<u32>,
}

pub fn sign_in(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &PortalSignIn,
) -> Result<RenderedEmail, EmailError> {
    let mut values = BTreeMap::new();
    values.insert(
        "portal_name".to_owned(),
        Value::from(props.portal_name.as_str()),
    );
    values.insert("code".to_owned(), Value::from(props.code.as_str()));
    values.insert(
        "minutes".to_owned(),
        Value::from(props.expires_in_minutes.unwrap_or(15)),
    );
    let mut flags = Vec::new();
    // `props.url?.trim() || undefined`
    if let Some(url) = props
        .url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        flags.push("url");
        values.insert("url".to_owned(), Value::from(url));
    }
    render("portal.sign-in", locale, brand, &flags, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_a_link_and_a_code() {
        let brand = EmailBrand::weldsuite("WeldCommerce");
        let props = PortalSignIn {
            portal_name: "Acme order portal".into(),
            code: "123456".into(),
            url: Some("https://orders.example/acme/auth/callback?token=abc".into()),
            expires_in_minutes: Some(15),
        };
        let email = sign_in(EmailLocale::En, &brand, &props).expect("renders");
        assert!(
            email
                .html
                .contains("https://orders.example/acme/auth/callback?token=abc")
        );
        assert!(email.text.contains("123456"));
        let code_only = sign_in(
            EmailLocale::En,
            &brand,
            &PortalSignIn { url: None, ..props },
        )
        .expect("renders");
        assert!(code_only.subject.contains("123456"));
    }
}
