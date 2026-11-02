//! The shared constants and pure helpers of `@weldsuite/app-api-client/schemas/reach`:
//! limits, sending defaults, the consumer and role address lists, and
//! template rendering.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

/// `WELDREACH_APP_CODE`.
pub const WELDREACH_APP_CODE: &str = "weldreach";

/// `WELDREACH_SENDING_DEFAULTS`.
pub mod sending {
    pub const WARMUP_DAYS: i64 = 14;
    pub const MAILBOX_DAILY_CAP: i64 = 30;
    pub const MAILBOX_DAILY_CAP_MAX: i64 = 50;
    pub const RAMP_START: i64 = 10;
    pub const RAMP_STEP: i64 = 5;
    pub const MIN_GAP_MINUTES: i64 = 8;
    pub const MAILBOX_HARD_BOUNCES_PER_DAY: i64 = 5;
    pub const CAMPAIGN_BOUNCE_RATE: f64 = 0.03;
    pub const CAMPAIGN_BOUNCE_WINDOW: i64 = 50;
}

/// `WeldReachLimits`, resolved.
#[derive(Debug, Clone, PartialEq)]
pub struct Limits {
    pub max_domains: i64,
    pub max_mailboxes: i64,
    pub max_daily_sends: i64,
    pub allow_consumer_recipients: bool,
    pub force_allow_domains: Vec<String>,
}

impl Default for Limits {
    /// `WELDREACH_DEFAULT_LIMITS`.
    fn default() -> Self {
        Self {
            max_domains: 3,
            max_mailboxes: 10,
            max_daily_sends: 300,
            allow_consumer_recipients: false,
            force_allow_domains: Vec::new(),
        }
    }
}

impl Limits {
    pub fn to_json(&self) -> Value {
        json!({
            "maxDomains": self.max_domains,
            "maxMailboxes": self.max_mailboxes,
            "maxDailySends": self.max_daily_sends,
            "allowConsumerRecipients": self.allow_consumer_recipients,
            "forceAllowDomains": self.force_allow_domains,
        })
    }
}

/// A whole number in `[0, max]`, as `z.number().int().min(0).max(max)` accepts it.
fn bounded_int(value: &Value, max: f64) -> Option<i64> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && (0.0..=max).contains(&number)).then_some(number as i64)
}

/// `resolveWeldReachLimits(stored)`: the stored keys over the defaults, or
/// the defaults alone when any stored key fails the schema.
pub fn resolve_limits(stored: Option<&Value>) -> Limits {
    let mut limits = Limits::default();
    let Some(Value::Object(stored)) = stored else {
        return limits;
    };
    let mut parsed = Limits::default();
    let mut ok = true;
    for (key, value) in stored {
        match key.as_str() {
            "maxDomains" => match bounded_int(value, 1000.0) {
                Some(n) => parsed.max_domains = n,
                None => ok = false,
            },
            "maxMailboxes" => match bounded_int(value, 10_000.0) {
                Some(n) => parsed.max_mailboxes = n,
                None => ok = false,
            },
            "maxDailySends" => match bounded_int(value, 1_000_000.0) {
                Some(n) => parsed.max_daily_sends = n,
                None => ok = false,
            },
            "allowConsumerRecipients" => match value.as_bool() {
                Some(b) => parsed.allow_consumer_recipients = b,
                None => ok = false,
            },
            "forceAllowDomains" => match value.as_array() {
                Some(items) if items.len() <= 1000 && items.iter().all(Value::is_string) => {
                    parsed.force_allow_domains = items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|d| d.trim().to_lowercase())
                        .collect();
                }
                _ => ok = false,
            },
            _ => {}
        }
    }
    if ok {
        let has = |key: &str| stored.get(key).is_some_and(|v| !v.is_null());
        if has("maxDomains") {
            limits.max_domains = parsed.max_domains;
        }
        if has("maxMailboxes") {
            limits.max_mailboxes = parsed.max_mailboxes;
        }
        if has("maxDailySends") {
            limits.max_daily_sends = parsed.max_daily_sends;
        }
        if has("allowConsumerRecipients") {
            limits.allow_consumer_recipients = parsed.allow_consumer_recipients;
        }
        if has("forceAllowDomains") {
            limits.force_allow_domains = parsed.force_allow_domains;
        }
    }
    limits
}

/// `CONSUMER_EMAIL_DOMAINS`.
pub const CONSUMER_EMAIL_DOMAINS: &[&str] = &[
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "hotmail.nl",
    "hotmail.co.uk",
    "live.com",
    "live.nl",
    "msn.com",
    "yahoo.com",
    "yahoo.co.uk",
    "yahoo.fr",
    "yahoo.de",
    "ymail.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "aol.com",
    "gmx.com",
    "gmx.de",
    "gmx.net",
    "web.de",
    "proton.me",
    "protonmail.com",
    "zoho.com",
    "mail.com",
    "yandex.com",
    "yandex.ru",
    "ziggo.nl",
    "kpnmail.nl",
    "planet.nl",
    "home.nl",
    "telenet.be",
    "skynet.be",
    "orange.fr",
    "free.fr",
    "laposte.net",
    "t-online.de",
    "freenet.de",
    "libero.it",
    "qq.com",
    "163.com",
    "naver.com",
];

/// `ROLE_EMAIL_LOCAL_PARTS`.
pub const ROLE_EMAIL_LOCAL_PARTS: &[&str] = &[
    "info",
    "sales",
    "support",
    "admin",
    "office",
    "contact",
    "hello",
    "help",
    "billing",
    "accounts",
    "accounting",
    "finance",
    "hr",
    "jobs",
    "careers",
    "marketing",
    "noreply",
    "no-reply",
    "postmaster",
    "abuse",
    "webmaster",
    "team",
    "service",
    "enquiries",
    "inquiries",
    "press",
    "privacy",
    "legal",
];

/// `emailDomain(email)`.
pub fn email_domain(email: &str) -> String {
    match email.rfind('@') {
        Some(at) => email[at + 1..].trim().to_lowercase(),
        None => String::new(),
    }
}

/// `isConsumerEmail(email)`.
pub fn is_consumer_email(email: &str) -> bool {
    CONSUMER_EMAIL_DOMAINS.contains(&email_domain(email).as_str())
}

/// `isRoleEmail(email)`.
pub fn is_role_email(email: &str) -> bool {
    match email.find('@') {
        Some(at) if at > 0 => ROLE_EMAIL_LOCAL_PARTS.contains(&email[..at].to_lowercase().as_str()),
        _ => false,
    }
}

static VARIABLE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\{\{\s*([a-zA-Z0-9_.-]+)\s*(?:\|([^}]*))?\}\}").expect("variable pattern")
});

/// `renderReachTemplate(template, values)`: `{{name}}` / `{{name|fallback}}`;
/// a variable with no value and no fallback stays and is reported.
pub fn render_template(
    template: &str,
    values: &[(String, Option<String>)],
) -> (String, Vec<String>) {
    let mut missing: Vec<String> = Vec::new();
    let text = VARIABLE_RE.replace_all(template, |caps: &regex::Captures<'_>| {
        let name = &caps[1];
        // Later entries win, as in an object spread.
        let value = values
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .and_then(|(_, value)| value.clone());
        if let Some(value) = value
            && !crate::text::js_trim(&value).is_empty()
        {
            return value;
        }
        if let Some(fallback) = caps.get(2) {
            return crate::text::js_trim(fallback.as_str()).to_owned();
        }
        if !missing.iter().any(|m| m == name) {
            missing.push(name.to_owned());
        }
        caps[0].to_owned()
    });
    (text.into_owned(), missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_fall_back_per_schema() {
        assert_eq!(resolve_limits(None), Limits::default());
        let limits = resolve_limits(Some(
            &json!({ "maxDomains": 5, "forceAllowDomains": [" A.com "] }),
        ));
        assert_eq!(limits.max_domains, 5);
        assert_eq!(limits.force_allow_domains, vec!["a.com".to_owned()]);
        // One bad key: the defaults, every one of them.
        assert_eq!(
            resolve_limits(Some(&json!({ "maxDomains": 5, "maxMailboxes": -1 }))),
            Limits::default()
        );
    }

    #[test]
    fn templates_render_like_the_client() {
        let values = vec![
            ("firstName".to_owned(), Some("Ann".to_owned())),
            ("lastName".to_owned(), None),
        ];
        let (text, missing) =
            render_template("Hi {{ firstName }} {{lastName}} {{title|there}}", &values);
        assert_eq!(text, "Hi Ann {{lastName}} there");
        assert_eq!(missing, vec!["lastName".to_owned()]);
    }
}
