//! WeldSign's emails (`packages/core/emails/src/templates/sign/`): each
//! function takes the template's props, picks the variant its React
//! component would render and fills it in.

use std::collections::BTreeMap;

use minijinja::Value;

use crate::{EmailBrand, EmailError, EmailLocale, RenderedEmail, format_date, render};

fn vars<const N: usize>(pairs: [(&str, Value); N]) -> BTreeMap<String, Value> {
    pairs
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}

/// `SignRequestEmailProps`: a request to sign, or a reminder of one.
#[derive(Debug, Clone, Default)]
pub struct SignRequest {
    /// Who sent the request (a person, or the workspace when unknown).
    pub sender_name: String,
    pub title: String,
    pub message: Option<String>,
    /// The signer's personal link.
    pub url: String,
    /// ISO time the request expires.
    pub expires_at: Option<String>,
    pub time_zone: Option<String>,
    pub reminder: bool,
}

pub fn request(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &SignRequest,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = vars([
        ("sender_name", Value::from(props.sender_name.as_str())),
        ("title", Value::from(props.title.as_str())),
        ("url", Value::from(props.url.as_str())),
    ]);
    // `props.message?.trim() ? <Quote>… : null`
    if let Some(message) = props.message.as_deref().filter(|m| !m.trim().is_empty()) {
        flags.push("message");
        values.insert("message".to_owned(), Value::from(message));
    }
    if let Some(expires_at) = props.expires_at.as_deref().filter(|e| !e.is_empty()) {
        flags.push("expires");
        let zone = props
            .time_zone
            .as_deref()
            .filter(|z| !z.is_empty())
            .unwrap_or("UTC");
        values.insert(
            "expires_date".to_owned(),
            Value::from(format_date(expires_at, locale, zone)?),
        );
    }
    if props.reminder {
        flags.push("reminder");
    }
    render("sign.request", locale, brand, &flags, values)
}

/// `SignCodeEmailProps`: the one-time code for opening a link.
pub fn code(
    locale: EmailLocale,
    brand: &EmailBrand,
    title: &str,
    code: &str,
    expires_in_minutes: Option<u32>,
) -> Result<RenderedEmail, EmailError> {
    let values = vars([
        ("title", Value::from(title)),
        ("code", Value::from(code)),
        ("minutes", Value::from(expires_in_minutes.unwrap_or(10))),
    ]);
    render("sign.code", locale, brand, &[], values)
}

/// `SignCompletedEmailProps`: everyone has signed.
#[derive(Debug, Clone, Default)]
pub struct SignCompleted {
    pub title: String,
    /// Names (or emails) of everyone who signed, in signing order.
    pub signers: Vec<String>,
    /// Whether the signed PDF is attached.
    pub attached: bool,
    /// The signer's portal link, or the request in WeldSuite for the sender.
    pub url: Option<String>,
    /// The sender gets "Open the request" instead of "Download signed PDF".
    pub for_sender: bool,
}

pub fn completed(
    locale: EmailLocale,
    brand: &EmailBrand,
    props: &SignCompleted,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = vars([
        ("title", Value::from(props.title.as_str())),
        ("signers", Value::from(props.signers.join(", "))),
    ]);
    if props.attached {
        flags.push("attached");
    }
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
    if props.for_sender {
        flags.push("for_sender");
    }
    render("sign.completed", locale, brand, &flags, values)
}

/// `SignDeclinedEmailProps`: a signer declined.
pub fn declined(
    locale: EmailLocale,
    brand: &EmailBrand,
    title: &str,
    declined_by: &str,
    reason: &str,
    url: &str,
) -> Result<RenderedEmail, EmailError> {
    let values = vars([
        ("title", Value::from(title)),
        ("declined_by", Value::from(declined_by)),
        ("reason", Value::from(reason)),
        ("url", Value::from(url)),
    ]);
    render("sign.declined", locale, brand, &[], values)
}

/// `SignVoidedEmailProps`: the sender cancelled the request.
pub fn voided(
    locale: EmailLocale,
    brand: &EmailBrand,
    sender_name: &str,
    title: &str,
    reason: &str,
) -> Result<RenderedEmail, EmailError> {
    let values = vars([
        ("sender_name", Value::from(sender_name)),
        ("title", Value::from(title)),
        ("reason", Value::from(reason)),
    ]);
    render("sign.voided", locale, brand, &[], values)
}

/// `SignExpiredEmailProps`: the request expired before everyone signed.
pub fn expired(
    locale: EmailLocale,
    brand: &EmailBrand,
    title: &str,
    unsigned: &[String],
    url: &str,
) -> Result<RenderedEmail, EmailError> {
    let mut flags = Vec::new();
    let mut values = vars([("title", Value::from(title)), ("url", Value::from(url))]);
    if !unsigned.is_empty() {
        flags.push("unsigned");
        values.insert("unsigned".to_owned(), Value::from(unsigned.join(", ")));
    }
    render("sign.expired", locale, brand, &flags, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> EmailBrand {
        EmailBrand::Workspace {
            name: "Acme Staffing".to_owned(),
            logo_url: None,
            accent_color: Some("#4f46e5".to_owned()),
        }
    }

    #[test]
    fn requests_escape_values_and_pick_their_variant() {
        let props = SignRequest {
            sender_name: "Gert <van> den Berg".to_owned(),
            title: "Service agreement 2027".to_owned(),
            message: Some("Hi Ann,\nHere it is.".to_owned()),
            url: "https://sign.weldsuite.org/r/abc123".to_owned(),
            expires_at: Some("2026-11-23T12:00:00.000Z".to_owned()),
            time_zone: Some("Europe/Amsterdam".to_owned()),
            reminder: false,
        };
        let email = request(EmailLocale::En, &workspace(), &props).expect("rendered");
        assert_eq!(
            email.subject,
            "Gert <van> den Berg sent you \"Service agreement 2027\" to sign"
        );
        assert!(
            email
                .html
                .contains("Gert &lt;van&gt; den Berg sent you a document to sign")
        );
        assert!(
            email
                .html
                .contains("<span>Hi Ann,<br/></span><span>Here it is.</span>")
        );
        assert!(email.html.contains("background-color:#4f46e5"));
        assert!(
            email
                .html
                .contains("Sign before Monday, November 23, 2026.")
        );
        assert!(email.text.contains("Hi Ann,\nHere it is."));
        assert!(email.text.starts_with("Acme Staffing\n\n"));

        let plain = SignRequest {
            message: Some("   ".to_owned()),
            expires_at: None,
            reminder: true,
            ..props
        };
        let email = request(EmailLocale::Nl, &workspace(), &plain).expect("rendered");
        assert!(!email.html.contains("Hi Ann"));
        assert_eq!(
            email.subject,
            "Herinnering: Gert <van> den Berg wacht nog op je handtekening voor \"Service agreement 2027\""
        );
    }

    #[test]
    fn every_sign_template_renders() {
        let brand = EmailBrand::weldsuite("WeldSign");
        for locale in [EmailLocale::En, EmailLocale::Nl] {
            code(locale, &workspace(), "NDA", "123456", None).expect("code");
            let done = SignCompleted {
                title: "NDA".to_owned(),
                signers: vec!["Ann".to_owned(), "Bob".to_owned()],
                attached: true,
                url: Some("https://app.weldsuite.org/w/acme/weldsign/sgn_1".to_owned()),
                for_sender: true,
            };
            let email = completed(locale, &brand, &done).expect("completed");
            assert!(email.text.contains("Ann, Bob"));
            declined(
                locale,
                &brand,
                "NDA",
                "Ann",
                "Not now",
                "https://app.weldsuite.org/x",
            )
            .expect("declined");
            voided(locale, &workspace(), "Gert", "NDA", "Wrong file").expect("voided");
            expired(locale, &brand, "NDA", &[], "https://app.weldsuite.org/x").expect("expired");
            expired(
                locale,
                &brand,
                "NDA",
                &["Ann".to_owned()],
                "https://app.weldsuite.org/x",
            )
            .expect("expired");
        }
    }
}
