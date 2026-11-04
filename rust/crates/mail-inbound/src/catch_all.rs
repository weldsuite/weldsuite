//! `catch-all.ts`: the `*@domain` registry sentinels behind an opt-in
//! catch-all on a custom domain (MAIL-002). Pure.

/// `SHARED_WELDMAIL_APEXES`: shared domains never get a catch-all.
const SHARED_WELDMAIL_APEXES: [&str; 2] = ["weldmail.com", "weldmail.org"];

/// `catchAllRegistryEmail(domain)`.
pub fn catch_all_registry_email(domain: &str) -> String {
    format!("*@{}", domain.to_lowercase())
}

/// `isSharedWeldMailDomain(domain)`.
pub fn is_shared_weldmail_domain(domain: &str) -> bool {
    let d = domain.to_lowercase();
    SHARED_WELDMAIL_APEXES
        .iter()
        .any(|apex| d == *apex || d.ends_with(&format!(".{apex}")))
}

/// `expandCatchAllCandidates(recipientEmails, matchedEmails)`: the
/// sentinel of every unmatched custom-domain recipient, once each.
pub fn expand_catch_all_candidates(recipients: &[String], matched: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for email in recipients {
        let normalized = crate::mime::js_trim(email).to_lowercase();
        if normalized.is_empty() || matched.contains(&normalized) {
            continue;
        }
        let Some(at) = normalized.rfind('@') else {
            continue;
        };
        if at == 0 || at == normalized.len() - 1 {
            continue;
        }
        let domain = &normalized[at + 1..];
        if is_shared_weldmail_domain(domain) {
            continue;
        }
        let candidate = catch_all_registry_email(domain);
        if !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}

/// `isCatchAllRegistryEmail(email)`.
pub fn is_catch_all_registry_email(email: &str) -> bool {
    email.starts_with("*@")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates() {
        let recipients = vec![
            "Hello@Acme.example".to_owned(),
            "random@acme.example".to_owned(),
            "x@team.weldmail.com".to_owned(),
            "nobody".to_owned(),
        ];
        assert_eq!(
            expand_catch_all_candidates(&recipients, &["hello@acme.example".to_owned()]),
            ["*@acme.example"]
        );
        assert!(is_catch_all_registry_email("*@acme.example"));
        assert!(is_shared_weldmail_domain("weldmail.org"));
        assert!(!is_shared_weldmail_domain("notweldmail.com"));
    }
}
