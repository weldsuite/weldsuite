//! The check for a URL a workspace gives us to call from the server
//! (`packages/core/worker-kit/src/safe-url.ts`): HTTPS only, no credentials
//! in the URL, and a host that does not point at a private network.
//!
//! This looks at the URL text only, exactly as the TypeScript check does, so
//! both backends refuse the same URLs with the same words. It cannot see
//! where a public name resolves to: the client that makes the call adds that
//! (`crate::webhooks`' public-address resolver, on by default).

use url::Url;

use crate::js;

/// Why [`check_safe_url`] refused a URL: words fit for a form.
pub type Refusal = &'static str;

const NOT_VALID: Refusal = "The URL is not valid";
const NOT_HTTPS: Refusal = "The URL must start with https://";
const CREDENTIALS: Refusal = "The URL must not contain credentials";
/// A host on a private network, by its literal or by its resolved address.
pub(crate) const PRIVATE_ADDRESS: Refusal = "The URL points at a private or local address";

const BLOCKED_SUFFIXES: [&str; 3] = [".internal", ".local", ".localhost"];

/// `parseIpv4`: `a.b.c.d` as four numbers, or `None` when `host` is not a
/// dotted IPv4 literal (the URL parser already turned `0x7f.1` and
/// `2130706433` into this form).
fn parse_ipv4(host: &str) -> Option<[u16; 4]> {
    let mut parts = [0u16; 4];
    let mut count = 0;
    for part in host.split('.') {
        if count == 4 || part.is_empty() || part.len() > 3 {
            return None;
        }
        if !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        parts[count] = part.parse().ok()?;
        count += 1;
    }
    (count == 4 && parts.iter().all(|part| *part <= 255)).then_some(parts)
}

/// `isBlockedIpv4`: loopback, private, link-local, CGNAT, benchmarking,
/// documentation, multicast and reserved IPv4.
fn is_blocked_ipv4([a, b, c, _]: [u16; 4]) -> bool {
    matches!(a, 0 | 10 | 127)
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && (c == 0 || c == 2))
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
}

/// One to four lower-case hex digits (`[0-9a-f]{1,4}`), as a number.
fn hex_group(text: &str) -> Option<u16> {
    let lower_hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    if text.is_empty() || text.len() > 4 || !text.bytes().all(lower_hex) {
        return None;
    }
    u16::from_str_radix(text, 16).ok()
}

/// `embeddedIpv4`: the IPv4 address inside a mapped (`::ffff:`), compatible
/// (`::`) or NAT64 (`64:ff9b::`) IPv6 literal, as the URL parser prints it
/// (two hex groups).
fn embedded_ipv4(address: &str) -> Option<[u16; 4]> {
    ["::ffff:", "::", "64:ff9b::"]
        .into_iter()
        .find_map(|prefix| {
            let (high, low) = address.strip_prefix(prefix)?.split_once(':')?;
            let (high, low) = (hex_group(high)?, hex_group(low)?);
            Some([high >> 8, high & 0xff, low >> 8, low & 0xff])
        })
}

/// `isBlockedIpv6`: loopback, unspecified, unique-local, link-local,
/// multicast and IPv4-embedding IPv6 literals (brackets stripped).
fn is_blocked_ipv6(address: &str) -> bool {
    if address == "::" || address == "::1" {
        return true;
    }
    let first = address.split(':').next().unwrap_or_default();
    let hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    if let [a, b, c, d] = *first.as_bytes() {
        // fc00::/7, fe80::/10 and multicast.
        let unique_local = a == b'f' && matches!(b, b'c' | b'd') && hex(c) && hex(d);
        let link_local = a == b'f' && b == b'e' && matches!(c, b'8' | b'9' | b'a' | b'b') && hex(d);
        let multicast = a == b'f' && b == b'f' && hex(c) && hex(d);
        if unique_local || link_local || multicast {
            return true;
        }
    }
    embedded_ipv4(address).is_some_and(is_blocked_ipv4)
}

/// `isBlockedHost`: true when a hostname (as `URL.hostname` returns it)
/// names a place we refuse to call.
pub fn is_blocked_host(hostname: &str) -> bool {
    let lowered = hostname.to_lowercase();
    let host = lowered.strip_suffix('.').unwrap_or(&lowered);
    if host.is_empty() {
        return true;
    }
    if let Some(address) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return is_blocked_ipv6(address);
    }
    if let Some(ipv4) = parse_ipv4(host) {
        return is_blocked_ipv4(ipv4);
    }
    if host == "localhost" || BLOCKED_SUFFIXES.iter().any(|suffix| host.ends_with(suffix)) {
        return true;
    }
    // A name without a dot is an intranet name (`metadata`, `intranet`),
    // never a public collector.
    !host.contains('.')
}

/// `checkSafeUrl`: parse `raw` and say whether the server may call it. The
/// URL comes back as `URL.toString()` writes it.
pub fn check_safe_url(raw: &str) -> Result<Url, Refusal> {
    check_url(raw, false)
}

/// [`check_safe_url`] under the deployment's private-network switch
/// (`WEBHOOK_ALLOW_PRIVATE_NETWORKS`, a self-hosted install that collects on
/// its own network): with `allow_private` the host is not judged. The URL
/// must still be HTTPS and carry no credentials.
pub fn check_url(raw: &str, allow_private: bool) -> Result<Url, Refusal> {
    let url = Url::parse(js::trim(raw)).map_err(|_| NOT_VALID)?;
    if url.scheme() != "https" {
        return Err(NOT_HTTPS);
    }
    if !url.username().is_empty() || url.password().is_some_and(|password| !password.is_empty()) {
        return Err(CREDENTIALS);
    }
    if !allow_private && is_blocked_host(url.host_str().unwrap_or_default()) {
        return Err(PRIVATE_ADDRESS);
    }
    Ok(url)
}

/// `isSafeUrl`.
pub fn is_safe_url(raw: &str) -> bool {
    check_safe_url(raw).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The cases of `safe-url.test.ts`.

    #[test]
    fn accepts_a_public_https_url_and_keeps_path_and_query() {
        let url =
            check_safe_url("https://splunk.example.com:8088/services/collector/event?channel=abc")
                .expect("a safe URL");
        assert_eq!(url.path(), "/services/collector/event");
        assert_eq!(
            url.as_str(),
            "https://splunk.example.com:8088/services/collector/event?channel=abc"
        );
        assert!(is_safe_url("https://8.8.8.8/ingest"));
        // `URL.toString()`: the default port and the case of the host go.
        assert_eq!(
            check_safe_url("  HTTPS://Other.Example.com:443/in ").map(|url| url.to_string()),
            Ok("https://other.example.com/in".to_owned())
        );
    }

    #[test]
    fn refuses_anything_but_https() {
        for url in [
            "http://example.com/x",
            "ftp://example.com",
            "javascript:alert(1)",
            "wss://example.com",
        ] {
            assert_eq!(check_safe_url(url), Err(NOT_HTTPS), "{url}");
        }
    }

    #[test]
    fn refuses_credentials_in_the_url() {
        for url in [
            "https://user:pw@example.com/x",
            "https://user@example.com/x",
        ] {
            assert_eq!(check_safe_url(url), Err(CREDENTIALS), "{url}");
        }
    }

    #[test]
    fn refuses_text_that_is_not_a_url() {
        for url in ["", "not a url", "//example.com", "example.com/x"] {
            assert_eq!(check_safe_url(url), Err(NOT_VALID), "{url:?}");
        }
    }

    #[test]
    fn refuses_private_and_local_hosts() {
        for host in [
            "localhost",
            "LOCALHOST",
            "foo.localhost",
            "db.internal",
            "printer.local",
            "metadata",
            "intranet",
            "localhost.",
            "127.0.0.1",
            "127.1.2.3",
            "0.0.0.0",
            "10.0.0.5",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "[::1]",
            "[::]",
            "[fc00::1]",
            "[fd12:3456::1]",
            "[fe80::1]",
            "[ff02::1]",
            "[::ffff:10.0.0.1]",
            "[::ffff:127.0.0.1]",
            "[64:ff9b::a00:1]",
        ] {
            assert_eq!(
                check_safe_url(&format!("https://{host}/hook")),
                Err(PRIVATE_ADDRESS),
                "{host}"
            );
        }
    }

    #[test]
    fn refuses_numeric_ipv4_spellings_of_a_private_address() {
        for host in [
            "2130706433",
            "0x7f.0.0.1",
            "017700000001",
            "127.1",
            "0177.0.0.1",
        ] {
            assert_eq!(
                check_safe_url(&format!("https://{host}/x")),
                Err(PRIVATE_ADDRESS),
                "{host}"
            );
        }
    }

    #[test]
    fn keeps_the_neighbours_of_the_private_ranges() {
        for host in [
            "172.15.0.1",
            "172.32.0.1",
            "100.63.0.1",
            "100.128.0.1",
            "169.253.0.1",
            "11.0.0.1",
            "[2606:4700::1111]",
            "[::ffff:8.8.8.8]",
        ] {
            assert!(is_safe_url(&format!("https://{host}/x")), "{host}");
        }
    }

    #[test]
    fn the_private_network_switch_lifts_the_host_rule_only() {
        assert_eq!(
            check_url("https://10.0.0.5:8088/collector", true).map(String::from),
            Ok("https://10.0.0.5:8088/collector".to_owned())
        );
        assert!(check_url("https://splunk.internal/in", true).is_ok());
        assert_eq!(check_url("http://10.0.0.5/in", true), Err(NOT_HTTPS));
        assert_eq!(
            check_url("https://user:pw@10.0.0.5/in", true),
            Err(CREDENTIALS)
        );
        assert_eq!(check_url("not a url", true), Err(NOT_VALID));
    }

    #[test]
    fn hosts_are_judged_as_the_typescript_check_judges_them() {
        assert!(is_blocked_host(""));
        assert!(is_blocked_host("192.0.0.8"));
        assert!(is_blocked_host("192.0.2.1"));
        assert!(is_blocked_host("198.18.0.1"));
        assert!(is_blocked_host("198.51.100.7"));
        assert!(is_blocked_host("203.0.113.9"));
        assert!(is_blocked_host("240.0.0.1"));
        assert!(!is_blocked_host("192.0.1.1"));
        assert!(!is_blocked_host("198.20.0.1"));
        // Not an IPv4 literal: a name, judged by its dots and suffix.
        assert!(!is_blocked_host("1.2.3.4.example.com"));
        assert!(!is_blocked_host("999.1.1.1"));
        // IPv4-compatible and NAT64 literals carry their IPv4 address.
        assert!(is_blocked_host("[::a00:1]"));
        assert!(is_blocked_host("[64:ff9b::c0a8:101]"));
        assert!(!is_blocked_host("[64:ff9b::808:808]"));
        assert!(!is_blocked_host("[2001:db8::1]"));
        assert!(is_blocked_host("[febf::1]"));
        assert!(!is_blocked_host("[fec0::1]"));
    }
}
