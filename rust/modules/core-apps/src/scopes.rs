//! Pure helpers of `services/user-apps.ts` and the shared schemas: scope
//! algebra, bundle file names and content types, reserved codes, tokens and
//! the URL allowlists.

use std::sync::LazyLock;

use aws_lc_rs::digest;
use regex::Regex;

/// First-party modules share the sidenav / app-store namespace.
pub(crate) const RESERVED_APP_CODES: [&str; 16] = [
    "weldcrm",
    "weldcommerce",
    "welddesk",
    "weldmail",
    "weldflow",
    "weldconnect",
    "weldstash",
    "weldhost",
    "weldbooks",
    "weldmeet",
    "weldchat",
    "weldagent",
    "weldapps",
    "appstore",
    "settings",
    "apps",
];

/// Platform modules again after shipping as hosted apps for a while: never
/// adopted onto a hosted app.
pub(crate) const NATIVE_ONLY_APP_CODES: [&str; 1] = ["weldcommerce"];

pub(crate) fn is_reserved(code: &str) -> bool {
    RESERVED_APP_CODES.contains(&code)
}

pub(crate) fn is_native_only(code: &str) -> bool {
    NATIVE_ONLY_APP_CODES.contains(&code)
}

// ── crypto ───────────────────────────────────────────────────────────────────

/// `randomHex(bytes)`: lowercase hex of `bytes` random bytes.
pub(crate) fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    aws_lc_rs::rand::fill(&mut buffer).expect("the system random source works");
    hex::encode(buffer)
}

/// `sha256Hex(input)`.
pub(crate) fn sha256_hex(input: &str) -> String {
    hex::encode(digest::digest(&digest::SHA256, input.as_bytes()))
}

// ── scope algebra ('*' covers all, 'resource:*' covers 'resource:action') ────

fn scope_covers(granted: &[String], scope: &str) -> bool {
    if granted.iter().any(|g| g == scope || g == "*") {
        return true;
    }
    match scope.find(':') {
        Some(idx) if idx > 0 => {
            let wildcard = format!("{}:*", &scope[..idx]);
            granted.contains(&wildcard)
        }
        _ => false,
    }
}

/// Every requested scope is covered by the granted set.
pub(crate) fn is_scope_superset(granted: &[String], requested: &[String]) -> bool {
    requested.iter().all(|s| scope_covers(granted, s))
}

/// Requested scopes the granted set does not cover (order kept, deduped).
pub(crate) fn diff_scopes(requested: &[String], granted: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for scope in requested {
        if !scope_covers(granted, scope) && !out.contains(scope) {
            out.push(scope.clone());
        }
    }
    out
}

/// The union of two scope lists (deduped, order kept).
pub(crate) fn union_scopes(a: &[String], b: &[String]) -> Vec<String> {
    let mut out = a.to_vec();
    for scope in b {
        if !out.contains(scope) {
            out.push(scope.clone());
        }
    }
    out
}

/// `scopeSchema`'s pattern.
pub(crate) fn is_scope(text: &str) -> bool {
    static SCOPE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[a-z][a-z0-9_-]*:(\*|[a-z][a-z0-9_:-]*)$|^\*$")
            .expect("the scope pattern compiles")
    });
    SCOPE.is_match(text)
}

// ── bundle files ─────────────────────────────────────────────────────────────

/// The content type a bundle file is stored and served with.
pub(crate) fn content_type_for(path: &str) -> Option<&'static str> {
    let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match extension.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => return None,
    })
}

fn last_segment(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or_default()
}

/// The final path segment has a file extension.
pub(crate) fn has_file_extension(path: &str) -> bool {
    last_segment(path).contains('.')
}

/// A Vite-style content-hashed file name (`index-abc12345.js`).
pub(crate) fn is_hashed_asset(path: &str) -> bool {
    static HASHED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"-[A-Za-z0-9_]{8,}\.").expect("the hash pattern compiles"));
    HASHED.is_match(last_segment(path))
}

/// No traversal, absolute, backslash or empty-segment paths in a bundle.
pub(crate) fn is_safe_bundle_path(path: &str) -> bool {
    if path.is_empty() || path.encode_utf16().count() > 255 {
        return false;
    }
    if path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return false;
    }
    !path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
}

// ── URLs ─────────────────────────────────────────────────────────────────────

/// `URL.hostname`: lower case, IPv6 in brackets.
fn hostname(url: &url::Url) -> String {
    url.host_str().unwrap_or_default().to_ascii_lowercase()
}

/// Hosts a lifecycle webhook may never reach.
const BLOCKED_WEBHOOK_HOSTS: [&str; 7] = [
    "localhost",
    "metadata",
    "metadata.google.internal",
    "metadata.goog",
    "kubernetes.default",
    "kubernetes.default.svc",
    "kubernetes.default.svc.cluster.local",
];

/// A lifecycle webhook may only go to a public https host with a DNS name
/// (`isSafeAppLifecycleWebhookUrl`).
pub(crate) fn is_safe_lifecycle_webhook_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let full = hostname(&url);
    let host = full.strip_suffix('.').unwrap_or(&full);
    if host.is_empty() {
        return false;
    }
    // `.localhost`, `.local` and `.internal` names: the last label.
    let top_label = host.rsplit_once('.').map(|(_, label)| label);
    if BLOCKED_WEBHOOK_HOSTS.contains(&host)
        || matches!(top_label, Some("localhost" | "local" | "internal"))
    {
        return false;
    }
    let ipv4 = host.split('.').count() == 4
        && host
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
    !ipv4 && !host.contains(':')
}

const LOOPBACK_HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "::1", "[::1]"];

/// A preview URL that may be registered (`isAllowedDevSessionUrl`).
pub(crate) fn is_allowed_dev_session_url(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let host = hostname(&url);
    let loopback = LOOPBACK_HOSTS.contains(&host.as_str());
    match url.scheme() {
        "http" => loopback,
        "https" => {
            loopback
                || [
                    ".trycloudflare.com",
                    ".ngrok-free.app",
                    ".ngrok.app",
                    ".ngrok.io",
                    ".pages.dev",
                ]
                .iter()
                .any(|suffix| host.ends_with(suffix))
        }
        _ => false,
    }
}

/// `new URL(raw).origin`, when it parses.
pub(crate) fn origin_of(raw: &str) -> Option<String> {
    url::Url::parse(raw)
        .ok()
        .map(|url| url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn scopes_cover_by_wildcard() {
        assert!(is_scope_superset(
            &list(&["crm:*"]),
            &list(&["crm:read", "crm:write"])
        ));
        assert!(is_scope_superset(&list(&["*"]), &list(&["tickets:read"])));
        assert!(!is_scope_superset(
            &list(&["crm:read"]),
            &list(&["crm:write"])
        ));
        assert_eq!(
            diff_scopes(
                &list(&["crm:read", "tickets:read", "tickets:read"]),
                &list(&["crm:read"])
            ),
            list(&["tickets:read"])
        );
        assert_eq!(
            union_scopes(&list(&["crm:read"]), &list(&["crm:write", "crm:read"])),
            list(&["crm:read", "crm:write"])
        );
        assert!(is_scope("crm:read") && is_scope("*") && is_scope("crm:*"));
        assert!(!is_scope("BAD") && !is_scope("Not A Scope"));
    }

    #[test]
    fn bundle_files() {
        assert_eq!(
            content_type_for("assets/index-abcdef12.JS"),
            Some("text/javascript; charset=utf-8")
        );
        assert_eq!(content_type_for("README"), None);
        assert!(is_hashed_asset("assets/index-abcdef12.js"));
        assert!(!is_hashed_asset("index.html"));
        assert!(has_file_extension("a/b.c") && !has_file_extension("orders/42"));
        assert!(is_safe_bundle_path("assets/x.js"));
        for bad in ["", "/x", "a//b", "../x", "a\\b", "./x"] {
            assert!(!is_safe_bundle_path(bad), "{bad}");
        }
    }

    #[test]
    fn url_allowlists() {
        assert!(is_safe_lifecycle_webhook_url(
            "https://hooks.example.com/weld"
        ));
        for bad in [
            "http://hooks.example.com",
            "https://localhost/x",
            "https://10.0.0.1/x",
            "https://[::1]/x",
            "https://a.internal/x",
            "https://user:pw@hooks.example.com",
            "not a url",
        ] {
            assert!(!is_safe_lifecycle_webhook_url(bad), "{bad}");
        }
        assert!(is_allowed_dev_session_url("http://localhost:5173/"));
        assert!(is_allowed_dev_session_url(
            "https://abc.trycloudflare.com/app/"
        ));
        assert!(!is_allowed_dev_session_url("https://evil.example.com/"));
        assert!(!is_allowed_dev_session_url(
            "https://user:pass@abc.ngrok.io/"
        ));
        assert!(!is_allowed_dev_session_url("http://abc.ngrok.io/"));
        assert_eq!(
            origin_of("https://abc.trycloudflare.com/app/").as_deref(),
            Some("https://abc.trycloudflare.com")
        );
    }

    #[test]
    fn hashes_and_hex() {
        assert_eq!(random_hex(20).len(), 40);
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
