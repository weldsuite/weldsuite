//! Sending sources: the rows of a domain's reports grouped by who sent them.
//!
//! - WeldSuite's own addresses, by pool: `weldsuite:<pool>`.
//! - Another sender with a reverse DNS name, by the registrable part of that
//!   name (`mail-ed1-x52d.google.com` → `name:google.com`), so a provider's
//!   many addresses are one source.
//! - Anything else by its address: `ip:<address>`.
//!
//! A customer marks a source as theirs or not by this key
//! (`mail_dmarc_sources`).

/// Public suffixes of two labels common enough to matter here; anything
/// else takes the last two labels.
const TWO_LABEL_SUFFIXES: &[&str] = &[
    "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp",
    "com.br", "com.cn", "com.mx", "co.za", "co.in", "com.tr", "com.sg", "co.kr",
];

/// The registrable domain of a host name (`a.b.example.co.uk` →
/// `example.co.uk`), lower-cased.
pub fn registrable(host: &str) -> String {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() <= 2 {
        return labels.join(".");
    }
    let last_two = labels[labels.len() - 2..].join(".");
    let keep = if TWO_LABEL_SUFFIXES.contains(&last_two.as_str()) {
        3
    } else {
        2
    };
    labels[labels.len().saturating_sub(keep)..].join(".")
}

/// The key of a row's source.
pub fn key(weldsuite_pool: Option<&str>, reverse_name: Option<&str>, ip: &str) -> String {
    if let Some(pool) = weldsuite_pool.filter(|p| !p.is_empty()) {
        return format!("weldsuite:{pool}");
    }
    match reverse_name
        .map(registrable)
        .filter(|name| name.contains('.'))
    {
        Some(name) => format!("name:{name}"),
        None => format!("ip:{}", ip.trim()),
    }
}

/// What a key names, for display: the pool, the domain or the address.
pub fn label(key: &str) -> &str {
    key.split_once(':').map_or(key, |(_, rest)| rest)
}

/// Whether a key is WeldSuite's own.
pub fn is_weldsuite(key: &str) -> bool {
    key.starts_with("weldsuite:")
}

/// Whether `domain` is `parent` or one of its subdomains.
pub fn within(domain: &str, parent: &str) -> bool {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();
    let parent = parent.trim_end_matches('.').to_ascii_lowercase();
    !parent.is_empty() && (domain == parent || domain.ends_with(&format!(".{parent}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_by_pool_name_or_address() {
        assert_eq!(
            key(Some("customer"), Some("x.google.com"), "1.2.3.4"),
            "weldsuite:customer"
        );
        assert_eq!(
            key(None, Some("mail-ed1-x52d.google.com."), "1.2.3.4"),
            "name:google.com"
        );
        assert_eq!(
            key(None, Some("mx.example.co.uk"), "1.2.3.4"),
            "name:example.co.uk"
        );
        assert_eq!(key(None, Some("localhost"), "1.2.3.4"), "ip:1.2.3.4");
        assert_eq!(key(None, None, " 2001:db8::1 "), "ip:2001:db8::1");
        assert_eq!(label("name:google.com"), "google.com");
        assert!(is_weldsuite("weldsuite:system"));
    }

    #[test]
    fn subdomains_are_within_their_parent() {
        assert!(within("acme.test", "acme.test"));
        assert!(within("News.Acme.test", "acme.test"));
        assert!(!within("notacme.test", "acme.test"));
        assert!(!within("acme.test", "news.acme.test"));
    }
}
