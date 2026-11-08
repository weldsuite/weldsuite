//! The return path (VERP): every recipient's copy goes out with
//! `MAIL FROM:<b+<recipient id>-<tag>@<bounce domain>>`, so a bounce that
//! arrives days later names the recipient it is about, and the tag (an HMAC)
//! keeps forged bounces out. DMARC still passes: the message is DKIM-signed
//! for the header From domain, and the bounce domain's SPF covers the mail
//! nodes.

use crate::crypto::Keys;

/// `b+<id>-<tag>@<domain>`.
pub fn address(keys: &Keys, recipient_id: &str, bounce_domain: &str) -> String {
    format!(
        "b+{recipient_id}-{}@{bounce_domain}",
        keys.verp_tag(recipient_id)
    )
}

/// What a return-path address is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReturnAddress {
    /// A bounce for this recipient id (tag checked).
    Recipient(String),
    /// `fbl@`: complaint feedback loops (ARF).
    FeedbackLoop,
    /// `postmaster@` / `abuse@`: kept for RFC 5321 / 2142, reports only.
    Role,
}

/// Classifies `address` at `bounce_domain`; `None` for anything we don't
/// accept.
pub fn parse(keys: &Keys, address: &str, bounce_domain: &str) -> Option<ReturnAddress> {
    let (local, domain) = address.rsplit_once('@')?;
    if !domain.eq_ignore_ascii_case(bounce_domain) {
        return None;
    }
    let local = local.to_ascii_lowercase();
    match local.as_str() {
        "fbl" => return Some(ReturnAddress::FeedbackLoop),
        "postmaster" | "abuse" => return Some(ReturnAddress::Role),
        _ => {}
    }
    let rest = local.strip_prefix("b+")?;
    let (id, tag) = rest.rsplit_once('-')?;
    keys.verp_tag_matches(id, tag)
        .then(|| ReturnAddress::Recipient(id.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_refuses_forgeries() {
        let keys = Keys::from_bytes(&[3u8; 32]).expect("keys");
        let addr = address(&keys, "rabc234", "bounces.eu.test");
        assert!(addr.starts_with("b+rabc234-"));
        assert_eq!(
            parse(&keys, &addr, "bounces.eu.test"),
            Some(ReturnAddress::Recipient("rabc234".into()))
        );
        assert_eq!(
            parse(&keys, &addr.to_uppercase(), "BOUNCES.EU.TEST"),
            Some(ReturnAddress::Recipient("rabc234".into()))
        );
        assert_eq!(
            parse(
                &keys,
                "b+rabc234-0000000000000000@bounces.eu.test",
                "bounces.eu.test"
            ),
            None
        );
        assert_eq!(parse(&keys, &addr, "other.test"), None);
        assert_eq!(
            parse(&keys, "FBL@bounces.eu.test", "bounces.eu.test"),
            Some(ReturnAddress::FeedbackLoop)
        );
        assert_eq!(
            parse(&keys, "abuse@bounces.eu.test", "bounces.eu.test"),
            Some(ReturnAddress::Role)
        );
        assert_eq!(
            parse(&keys, "anna@bounces.eu.test", "bounces.eu.test"),
            None
        );
    }
}
