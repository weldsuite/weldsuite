//! `validation.ts`: a prospect's email verdict (invalid, suppressed,
//! consumer, role, `no_mx`, valid), the MX check over DNS-over-HTTPS.

use std::collections::HashMap;
use std::sync::LazyLock;

use futures_util::StreamExt;
use regex::Regex;
use weldsuite_ports::OutboundHttp;

use crate::schemas::{email_domain, is_consumer_email, is_role_email};
use crate::suppressions::SuppressionIndex;

/// `MAX_MX_LOOKUPS_PER_RUN`.
pub const MAX_MX_LOOKUPS_PER_RUN: usize = 800;
const MX_CONCURRENCY: usize = 8;

static EMAIL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$",
    )
    .expect("email pattern")
});
static TLD_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[A-Za-z]{2,}$").expect("tld"));

/// `isValidEmailSyntax(email)`.
pub fn is_valid_email_syntax(email: &str) -> bool {
    if crate::js_len(email) > 320 || !EMAIL_RE.is_match(email) {
        return false;
    }
    let local = email.split('@').next().unwrap_or_default();
    if local.len() > 64 || local.starts_with('.') || local.ends_with('.') || local.contains("..") {
        return false;
    }
    TLD_RE.is_match(&email_domain(email))
}

/// `classifyLocally(email, ctx)`: the verdict that needs no network.
pub fn classify_locally(
    email: &str,
    allow_consumer: bool,
    suppressed: &SuppressionIndex,
) -> Option<&'static str> {
    if !is_valid_email_syntax(email) {
        return Some("invalid");
    }
    if suppressed.check(email).is_some() {
        return Some("suppressed");
    }
    if !allow_consumer && is_consumer_email(email) {
        return Some("consumer");
    }
    if is_role_email(email) {
        return Some("role");
    }
    None
}

/// `dnsMxLookup(domain)`: has MX records, has none, or unknown (`None`).
pub async fn mx_lookup(http: &OutboundHttp, domain: &str) -> Option<bool> {
    crate::dns::lookup_record(http, domain, "MX")
        .await
        .ok()
        .map(|records| !records.is_empty())
}

/// `validateEmails(emails, ctx)`: verdicts for lower-cased emails. `http`
/// `None` skips the MX check (`skipMx`).
pub async fn validate_emails(
    emails: &[String],
    allow_consumer: bool,
    suppressed: &SuppressionIndex,
    http: Option<&OutboundHttp>,
) -> HashMap<String, &'static str> {
    let mut verdicts = HashMap::new();
    let mut need_mx: Vec<&String> = Vec::new();
    for email in emails {
        match classify_locally(email, allow_consumer, suppressed) {
            Some(verdict) => {
                verdicts.insert(email.clone(), verdict);
            }
            None => need_mx.push(email),
        }
    }
    let mut mx_by_domain: HashMap<String, Option<bool>> = HashMap::new();
    if let Some(http) = http {
        let domains: Vec<String> =
            crate::unique(&need_mx.iter().map(|e| email_domain(e)).collect::<Vec<_>>())
                .into_iter()
                .take(MAX_MX_LOOKUPS_PER_RUN)
                .collect();
        let results: Vec<(String, Option<bool>)> = futures_util::stream::iter(domains)
            .map(|domain| async move {
                let found = mx_lookup(http, &domain).await;
                (domain, found)
            })
            .buffer_unordered(MX_CONCURRENCY)
            .collect()
            .await;
        mx_by_domain.extend(results);
    }
    for email in need_mx {
        let verdict = if mx_by_domain.get(&email_domain(email)) == Some(&Some(false)) {
            "no_mx"
        } else {
            "valid"
        };
        verdicts.insert(email.clone(), verdict);
    }
    verdicts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn syntax() {
        assert!(is_valid_email_syntax("ann@acme.com"));
        assert!(!is_valid_email_syntax("ann@acme"));
        assert!(!is_valid_email_syntax("ann..b@acme.com"));
        assert!(!is_valid_email_syntax("ann@acme.c0"));
    }
}
