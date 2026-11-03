//! `spam-filter.ts`: the heuristic inbound spam scorer. Pure.

use crate::mime::{is_js_space, js_trim};
use crate::parsed::{EmailAddress, header_value};

/// Score at or above this value is treated as spam.
pub const SPAM_SCORE_THRESHOLD: i64 = 5;

const EXECUTABLE_EXTENSIONS: [&str; 8] = ["exe", "scr", "bat", "cmd", "js", "vbs", "ps1", "msi"];

const URL_SHORTENER_HOSTS: [&str; 9] = [
    "bit.ly",
    "tinyurl.com",
    "t.co",
    "goo.gl",
    "ow.ly",
    "is.gd",
    "buff.ly",
    "cutt.ly",
    "rebrand.ly",
];

const SPAM_LEXICON: [&str; 22] = [
    "viagra",
    "cialis",
    "pharmacy",
    "lottery",
    "winner",
    "jackpot",
    "nigerian prince",
    "wire transfer",
    "urgent wire",
    "million dollars",
    "crypto giveaway",
    "claim your prize",
    "act now",
    "limited time offer",
    "weight loss",
    "free money",
    "casino",
    "klik hier nu",
    "gratis geld",
    "gewonnen",
    "loterij",
    "urgent overschrijving",
];

const FREE_MAIL_DOMAINS: [&str; 46] = [
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "hotmail.nl",
    "live.com",
    "live.nl",
    "msn.com",
    "yahoo.com",
    "yahoo.co.uk",
    "ymail.com",
    "aol.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "gmx.com",
    "gmx.de",
    "gmx.net",
    "web.de",
    "mail.com",
    "mail.ru",
    "inbox.ru",
    "list.ru",
    "bk.ru",
    "yandex.ru",
    "yandex.com",
    "inbox.lv",
    "proton.me",
    "protonmail.com",
    "zoho.com",
    "tutanota.com",
    "tuta.io",
    "orange.fr",
    "wanadoo.fr",
    "free.fr",
    "laposte.net",
    "libero.it",
    "seznam.cz",
    "wp.pl",
    "o2.pl",
    "onet.pl",
    "interia.pl",
    "qq.com",
    "163.com",
    "126.com",
    "rediffmail.com",
];

const IMPERSONATED_BRANDS: &[&str] = &[
    "american express",
    "amex",
    "paypal",
    "apple id",
    "apple support",
    "icloud",
    "microsoft",
    "office 365",
    "microsoft 365",
    "netflix",
    "amazon",
    "docusign",
    "dhl",
    "fedex",
    "postnl",
    "mastercard",
    "ing bank",
    "rabobank",
    "abn amro",
    "bunq",
    "belastingdienst",
    "digid",
    "coinbase",
    "binance",
    "metamask",
    "wells fargo",
    "bank of america",
    "chase bank",
    "facebook",
    "instagram",
    "whatsapp",
    "linkedin",
    "dropbox",
    "adobe",
    "norton",
    "mcafee",
    "ebay",
    "booking com",
];

/// `SpamScoreEmail`.
#[derive(Debug, Clone, Default)]
pub struct SpamInput<'a> {
    pub from: Option<&'a EmailAddress>,
    pub to: &'a [EmailAddress],
    pub subject: Option<&'a str>,
    pub text_body: Option<&'a str>,
    pub html_body: Option<&'a str>,
    pub headers: &'a [(String, String)],
    pub spf_status: Option<&'a str>,
    pub dkim_status: Option<&'a str>,
    pub dmarc_status: Option<&'a str>,
}

/// `SpamScoreOptions`.
#[derive(Debug, Clone, Default)]
pub struct SpamOptions {
    pub attachment_names: Vec<String>,
    pub is_existing_ham_thread: bool,
    /// `recipientEmails`; `None` falls back to the `To` addresses.
    pub recipient_emails: Option<Vec<String>>,
}

/// `SpamScoreResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpamScore {
    pub score: i64,
    pub reasons: Vec<String>,
    pub is_spam: bool,
}

/// `domainOf(email)`.
fn domain_of(email: &str) -> Option<String> {
    let at = email.rfind('@')?;
    let domain = email[at + 1..].to_lowercase();
    (!domain.is_empty()).then_some(domain)
}

fn is_auth_fail(status: Option<&str>) -> bool {
    matches!(status, Some("fail" | "softfail"))
}

fn is_auth_absent(status: Option<&str>) -> bool {
    matches!(status, None | Some("" | "none"))
}

/// `parseReplyToEmail(raw)`.
fn parse_reply_to(raw: Option<&str>) -> Option<String> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let angle = first_bracketed(raw);
    let candidate = js_trim(angle.unwrap_or(raw)).to_lowercase();
    candidate.contains('@').then_some(candidate)
}

/// The first `<x>` with `x` free of `<` and `>`.
fn first_bracketed(raw: &str) -> Option<&str> {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let rest = &raw[i + 1..];
            if let Some(end) = rest.find(['<', '>'])
                && rest.as_bytes()[end] == b'>'
                && end > 0
            {
                return Some(&rest[..end]);
            }
        }
        i += 1;
    }
    None
}

/// The first `max` UTF-16 units of `text`.
fn utf16_prefix(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}

fn subject_signals(subject: &str) -> Vec<(i64, &'static str)> {
    if subject.is_empty() {
        return Vec::new();
    }
    let lower = subject.to_lowercase();
    let lexicon = SPAM_LEXICON.iter().any(|term| lower.contains(term));
    let letters = subject.chars().filter(char::is_ascii_alphabetic).count();
    let upper = subject.chars().filter(char::is_ascii_uppercase).count();
    #[allow(clippy::cast_precision_loss)] // counts of characters
    let shouting =
        (letters >= 8 && upper as f64 / letters as f64 >= 0.6) || subject.matches('!').count() >= 3;
    let mut signals = Vec::new();
    if lexicon {
        signals.push((2, "subject_spam_lexicon"));
    }
    if shouting {
        signals.push((1, "subject_shouting"));
    }
    signals
}

/// `bodyLinkSignals(text)`: the URLs in the first 2,000 characters.
fn body_link_signals(text: &str) -> (bool, bool) {
    let slice = utf16_prefix(text, 2000);
    let lower = slice.to_ascii_lowercase();
    let mut urls = Vec::new();
    let mut at = 0;
    while at < lower.len() {
        let rest = &lower[at..];
        let scheme = if rest.starts_with("https://") {
            8
        } else if rest.starts_with("http://") {
            7
        } else {
            at += rest.chars().next().map_or(1, char::len_utf8);
            continue;
        };
        let body_start = at + scheme;
        let body_len: usize = slice[body_start..]
            .chars()
            .take_while(|c| !is_js_space(*c) && !matches!(c, '"' | '\'' | '<' | '>'))
            .map(char::len_utf8)
            .sum();
        if body_len == 0 {
            at += 1;
            continue;
        }
        urls.push(slice[at..body_start + body_len].to_owned());
        at = body_start + body_len;
    }
    let many = urls.len() >= 5;
    let shortener = urls.iter().any(|u| {
        url::Url::parse(u).ok().and_then(|parsed| {
            parsed.host_str().map(|host| {
                let host = host.to_lowercase();
                let host = host.strip_prefix("www.").unwrap_or(&host);
                URL_SHORTENER_HOSTS.contains(&host)
            })
        }) == Some(true)
    });
    (many, shortener)
}

fn has_executable_attachment(names: &[String]) -> bool {
    names.iter().any(|name| {
        let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
        let ext = base
            .rfind('.')
            .map(|dot| base[dot + 1..].to_lowercase())
            .unwrap_or_default();
        EXECUTABLE_EXTENSIONS.contains(&ext.as_str())
    })
}

/// `[a-z0-9._%+-]` (case-insensitive).
fn is_local_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-')
}

/// `/(?<![a-z0-9._%+-])([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i.exec(name)?.[1]`.
fn embedded_email(name: &str) -> Option<String> {
    let chars: Vec<char> = name.chars().collect();
    let mut start = 0;
    while start < chars.len() {
        if !is_local_char(chars[start]) || (start > 0 && is_local_char(chars[start - 1])) {
            start += 1;
            continue;
        }
        let mut at = start;
        while at < chars.len() && is_local_char(chars[at]) {
            at += 1;
        }
        if chars.get(at) != Some(&'@') {
            start = at.max(start + 1);
            continue;
        }
        let domain_start = at + 1;
        let mut run_end = domain_start;
        while run_end < chars.len()
            && (chars[run_end].is_ascii_alphanumeric() || matches!(chars[run_end], '.' | '-'))
        {
            run_end += 1;
        }
        // The greedy domain backs off to the last `.` followed by two
        // letters or more.
        let mut found = None;
        let mut dot = run_end;
        while dot > domain_start + 1 {
            dot -= 1;
            if chars[dot] == '.'
                && chars.get(dot + 1).is_some_and(char::is_ascii_alphabetic)
                && chars.get(dot + 2).is_some_and(char::is_ascii_alphabetic)
            {
                let mut end = dot + 1;
                while end < chars.len() && chars[end].is_ascii_alphabetic() {
                    end += 1;
                }
                found = Some(end);
                break;
            }
        }
        if let Some(end) = found {
            return Some(chars[start..end].iter().collect());
        }
        start = at.max(start + 1);
    }
    None
}

/// `isDisplayNameSpoof(from, recipientEmails)`.
fn is_display_name_spoof(from: &EmailAddress, recipients: &[String]) -> bool {
    let name = js_trim(from.name.as_deref().unwrap_or_default());
    if name.is_empty() {
        return false;
    }
    let from_email = from.email.to_lowercase();
    let from_domain = domain_of(&from_email);
    let name_lower = name.to_lowercase();
    let starts_word = |prefix: &str| {
        name_lower.starts_with(prefix)
            && !name_lower[prefix.len()..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
    };
    let looks_like_email = name.contains('@') || starts_word("support") || starts_word("noreply");
    if !looks_like_email && recipients.is_empty() {
        return false;
    }
    for recipient in recipients {
        let Some(domain) = domain_of(recipient) else {
            continue;
        };
        if name_lower.contains(&domain) && from_domain.as_deref() != Some(domain.as_str()) {
            return true;
        }
    }
    if let Some(embedded) = embedded_email(name) {
        let embedded = embedded.to_lowercase();
        if embedded != from_email && domain_of(&embedded) != from_domain {
            return true;
        }
    }
    false
}

/// `isBrandOnFreeMail(from)`.
fn is_brand_on_free_mail(from: &EmailAddress) -> bool {
    let Some(domain) = domain_of(&from.email) else {
        return false;
    };
    if !FREE_MAIL_DOMAINS.contains(&domain.as_str()) {
        return false;
    }
    let lower = from.name.as_deref().unwrap_or_default().to_lowercase();
    let mut words = String::new();
    let mut in_gap = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            words.push(c);
            in_gap = false;
        } else if !in_gap {
            words.push(' ');
            in_gap = true;
        }
    }
    let words = js_trim(&words);
    if words.is_empty() {
        return false;
    }
    let padded = format!(" {words} ");
    IMPERSONATED_BRANDS
        .iter()
        .any(|brand| padded.contains(&format!(" {brand} ")))
}

/// `scoreInboundSpam(email, options)`.
pub fn score_inbound_spam(email: &SpamInput<'_>, options: &SpamOptions) -> SpamScore {
    let recipients: Vec<String> = options.recipient_emails.clone().unwrap_or_else(|| {
        email
            .to
            .iter()
            .map(|t| t.email.clone())
            .filter(|e| !e.is_empty())
            .collect()
    });
    let mut signals: Vec<(i64, &str)> = Vec::new();

    let (spf, dkim, dmarc) = (email.spf_status, email.dkim_status, email.dmarc_status);
    if dmarc == Some("fail") {
        signals.push((3, "dmarc_fail"));
    }
    if is_auth_fail(spf) {
        signals.push((
            2,
            if spf == Some("softfail") {
                "spf_softfail"
            } else {
                "spf_fail"
            },
        ));
    }
    if dkim == Some("fail") {
        signals.push((2, "dkim_fail"));
    }
    if is_auth_fail(spf) && dkim == Some("fail") && dmarc == Some("fail") {
        signals.push((2, "auth_all_fail"));
    } else if is_auth_absent(spf) && is_auth_absent(dkim) && is_auth_absent(dmarc) {
        signals.push((1, "auth_all_missing"));
    }

    if !options.attachment_names.is_empty() && has_executable_attachment(&options.attachment_names)
    {
        signals.push((4, "executable_attachment"));
    }

    signals.extend(subject_signals(email.subject.unwrap_or_default()));

    let body = format!(
        "{}\n{}",
        email.text_body.unwrap_or_default(),
        email.html_body.unwrap_or_default()
    );
    if !js_trim(&body).is_empty() {
        let (many, shortener) = body_link_signals(&body);
        if many || shortener {
            signals.push((
                2,
                if many {
                    "body_many_links"
                } else {
                    "body_url_shortener"
                },
            ));
        }
    }

    let unknown = EmailAddress::new("", None);
    let from = email.from.unwrap_or(&unknown);
    if is_display_name_spoof(from, &recipients) {
        signals.push((3, "from_display_spoof"));
    }
    if is_brand_on_free_mail(from) {
        signals.push((SPAM_SCORE_THRESHOLD, "from_brand_free_mail"));
    }
    let reply_to = parse_reply_to(header_value(email.headers, "reply-to"));
    let from_domain = domain_of(&from.email);
    let reply_domain = reply_to.as_deref().and_then(domain_of);
    if let (Some(reply), Some(from)) = (&reply_domain, &from_domain)
        && reply != from
    {
        signals.push((1, "reply_to_domain_mismatch"));
    }

    let mut score: i64 = signals.iter().map(|(points, _)| points).sum();
    let mut reasons: Vec<String> = signals.iter().map(|(_, r)| (*r).to_owned()).collect();
    if options.is_existing_ham_thread && score >= SPAM_SCORE_THRESHOLD {
        reasons.push("capped_existing_ham_thread".to_owned());
        score = SPAM_SCORE_THRESHOLD - 1;
    }
    SpamScore {
        score,
        reasons,
        is_spam: score >= SPAM_SCORE_THRESHOLD,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_addresses() {
        assert_eq!(
            embedded_email("Support <help@paypal.com>").as_deref(),
            Some("help@paypal.com")
        );
        assert_eq!(embedded_email("no address here"), None);
        assert_eq!(
            embedded_email("x support@weldmail.com").as_deref(),
            Some("support@weldmail.com")
        );
    }

    #[test]
    fn reply_to_addresses() {
        assert_eq!(
            parse_reply_to(Some("Collector <Collector@Evil.example>")).as_deref(),
            Some("collector@evil.example")
        );
        assert_eq!(parse_reply_to(Some("no address")), None);
    }
}
