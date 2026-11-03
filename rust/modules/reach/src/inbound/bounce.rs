//! `lib/inbound/bounce.ts` and `inbound/strings.ts`: delivery failure
//! notices, RFC 3464 delivery status notifications and the plain-text
//! "Mail Delivery Subsystem" kind, in linear scans as the TypeScript does.
//! Positions are UTF-16 units, as JavaScript counts them.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use weldsuite_reach_domain::js_slice;
use weldsuite_reach_domain::text::{is_js_space, is_quote_separator, js_trim};

use super::parse::{ParsedInbound, extract_address, js_lower, normalize_message_id};
use super::rules::split_lines;

/// `BounceInfo`: what a delivery failure notice says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BounceInfo {
    pub recipients: Vec<String>,
    pub original_message_id: Option<String>,
    pub status: Option<String>,
    pub action: Option<String>,
    pub diagnostic: Option<String>,
    pub permanent: bool,
    pub address_rejected: bool,
    /// `dsn` or `text`.
    pub source: &'static str,
}

const SYSTEM_LOCAL_PARTS: [&str; 10] = [
    "mailer-daemon",
    "mailerdaemon",
    "postmaster",
    "mail-delivery-subsystem",
    "mail.delivery.subsystem",
    "mail-delivery-system",
    "delivery",
    "bounce",
    "bounces",
    "no-reply-bounce",
];

const SYSTEM_DISPLAY_NAMES: [&str; 7] = [
    "mail delivery subsystem",
    "mail delivery system",
    "mailer-daemon",
    "mailer daemon",
    "postmaster",
    "mail delivery failed",
    "undeliverable",
];

const BOUNCE_SUBJECT_PREFIXES: [&str; 24] = [
    "undeliverable",
    "undelivered mail",
    "delivery status notification",
    "returned mail",
    "mail delivery failed",
    "mail delivery failure",
    "delivery failure",
    "delivery failed",
    "delivery has failed",
    "failure notice",
    "non-delivery",
    "non delivery",
    "message not delivered",
    "message undeliverable",
    "bericht niet bezorgd",
    "niet bezorgd",
    "onbestelbaar",
    "kon niet worden bezorgd",
    "unzustellbar",
    "zustellung fehlgeschlagen",
    "nicht zustellbar",
    "échec de la distribution",
    "échec de distribution",
    "echec de distribution",
];

const DELAY_HINTS: [&str; 9] = [
    "delay",
    "will keep trying",
    "will continue to try",
    "still trying",
    "temporar",
    "deferred",
    "retry for",
    "vertraagd",
    "verzögert",
];

const ADDRESS_HINTS: [&str; 24] = [
    "couldn't be found",
    "could not be found",
    "does not exist",
    "doesn't exist",
    "user unknown",
    "unknown user",
    "no such user",
    "no such recipient",
    "no such mailbox",
    "recipient not found",
    "recipient address rejected",
    "recipient rejected",
    "address not found",
    "address rejected",
    "mailbox unavailable",
    "mailbox not found",
    "mailbox disabled",
    "invalid recipient",
    "invalid address",
    "unrouteable",
    "bestaat niet",
    "niet gevonden",
    "existiert nicht",
    "unbekannt",
];

const POLICY_HINTS: [&str; 16] = [
    "spam",
    "blocked",
    "block list",
    "blocklist",
    "blacklist",
    "reputation",
    "spamhaus",
    "policy",
    "denied",
    "not authorized",
    "not authorised",
    "unauthenticated",
    "dmarc",
    "spf",
    "rate limit",
    "too many",
];

const FAILED_TO_MARKERS: [&str; 6] = [
    "wasn't delivered to",
    "was not delivered to",
    "couldn't be delivered to",
    "could not be delivered to",
    "delivery has failed to these recipients",
    "delivery to the following recipient",
];

// ---------------------------------------------------------------------------
// strings.ts
// ---------------------------------------------------------------------------

/// `stripParenthesized(value)`: every `( … )` comment removed.
pub fn strip_parenthesized(value: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for c in value.chars() {
        if c == '(' {
            depth += 1;
        } else if c == ')' && depth > 0 {
            depth -= 1;
        } else if depth == 0 {
            out.push(c);
        }
    }
    out
}

fn is_local_unit(u: u16) -> bool {
    u8::try_from(u)
        .is_ok_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._%+'-".contains(&b))
}

fn is_domain_unit(u: u16) -> bool {
    u8::try_from(u)
        .is_ok_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

/// `validDomain(domain)` (ASCII by construction).
fn valid_domain(domain: &str) -> bool {
    let Some(last_dot) = domain.rfind('.').filter(|d| *d > 0) else {
        return false;
    };
    if domain.starts_with('.') || domain.ends_with('.') || domain.contains("..") {
        return false;
    }
    let tld = &domain[last_dot + 1..];
    tld.len() >= 2 && tld.bytes().all(|b| b.is_ascii_lowercase())
}

/// `FoundEmail`: positions in UTF-16 units of the lower-cased text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundEmail {
    pub email: String,
    pub start: usize,
    pub end: usize,
}

fn ascii(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `findEmails` over already lower-cased UTF-16 units.
fn find_emails_units(lower: &[u16]) -> Vec<FoundEmail> {
    let mut found = Vec::new();
    let mut from = 0usize;
    while let Some(at) = lower
        .get(from..)
        .and_then(|rest| rest.iter().position(|u| *u == u16::from(b'@')))
        .map(|p| p + from)
    {
        from = at + 1;
        let mut start = at;
        while start > 0 && is_local_unit(lower[start - 1]) {
            start -= 1;
        }
        let mut end = at + 1;
        while end < lower.len() && is_domain_unit(lower[end]) {
            end += 1;
        }
        let raw_domain = ascii(&lower[at + 1..end]);
        let domain = raw_domain.trim_end_matches(['.', '-']);
        if start == at || !valid_domain(domain) {
            continue;
        }
        found.push(FoundEmail {
            email: format!("{}@{domain}", ascii(&lower[start..at])),
            start,
            end: at + 1 + domain.len(),
        });
        from = from.max(at + 1 + domain.len());
    }
    found
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `findEmails(text)`: every address, in order.
pub fn find_emails(text: &str) -> Vec<FoundEmail> {
    find_emails_units(&units(&js_lower(text)))
}

/// `emailAfter(text, index, 300)` on lower-cased units.
fn email_after(lower: &[u16], index: usize) -> Option<String> {
    let start = index.min(lower.len());
    let end = (index + 300).min(lower.len());
    // `findEmails` lower-cases its slice again; that is idempotent here.
    let slice = js_lower(&String::from_utf16_lossy(&lower[start..end]));
    find_emails_units(&units(&slice))
        .into_iter()
        .next()
        .map(|f| f.email)
}

// ---------------------------------------------------------------------------
// bounce.ts
// ---------------------------------------------------------------------------

/// `mentionsAny(text, phrases)`.
fn mentions_any(text: &str, phrases: &[&str]) -> bool {
    let lower = js_lower(text).replace('\u{2019}', "'");
    phrases.iter().any(|p| lower.contains(p))
}

/// `/^[A-Za-z][A-Za-z0-9-]*$/`.
fn is_field_name(key: &str) -> bool {
    let b = key.as_bytes();
    !b.is_empty()
        && b[0].is_ascii_alphabetic()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

/// `parseFieldGroup(group)`.
fn parse_field_group(group: &str) -> HashMap<String, String> {
    let mut fields: HashMap<String, String> = HashMap::new();
    let mut last_key: Option<String> = None;
    for line in split_lines(group) {
        let continuation =
            (line.starts_with(' ') || line.starts_with('\t')) && !js_trim(line).is_empty();
        if continuation && let Some(key) = &last_key {
            let joined = format!(
                "{} {}",
                fields.get(key).map_or("", String::as_str),
                js_trim(line)
            );
            fields.insert(key.clone(), joined);
            continue;
        }
        let Some(colon) = line.find(':').filter(|c| *c > 0) else {
            continue;
        };
        if !is_field_name(&line[..colon]) {
            continue;
        }
        let key = js_lower(&line[..colon]);
        fields
            .entry(key.clone())
            .or_insert_with(|| js_trim(&line[colon + 1..]).to_owned());
        last_key = Some(key);
    }
    fields
}

/// `parseRecipientField(value)`.
fn parse_recipient_field(value: Option<&String>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    let after_type = match value.find(';') {
        Some(at) => &value[at + 1..],
        None => value.as_str(),
    };
    let address = extract_address(&strip_parenthesized(after_type));
    address.contains('@').then(|| {
        address
            .strip_prefix("mailto:")
            .unwrap_or(&address)
            .to_owned()
    })
}

/// `block.split(/\r?\n\r?\n/, 1)[0]`, folded lines joined
/// (`replace(/\r?\n[ \t]+/g, ' ')`).
fn header_block(block: &str) -> String {
    let head = match block
        .find("\n\r\n")
        .into_iter()
        .chain(block.find("\n\n"))
        .min()
    {
        Some(at) => {
            let end = if at > 0 && block.as_bytes()[at - 1] == b'\r' {
                at - 1
            } else {
                at
            };
            &block[..end]
        }
        None => block,
    };
    let chars: Vec<char> = head.chars().collect();
    let mut out = String::with_capacity(head.len());
    let mut i = 0;
    while i < chars.len() {
        let newline = if chars[i] == '\r' && chars.get(i + 1) == Some(&'\n') {
            Some(i + 2)
        } else if chars[i] == '\n' {
            Some(i + 1)
        } else {
            None
        };
        if let Some(after) = newline
            && matches!(chars.get(after), Some(' ' | '\t'))
        {
            let mut j = after;
            while matches!(chars.get(j), Some(' ' | '\t')) {
                j += 1;
            }
            out.push(' ');
            i = j;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Line starts in the `/m` sense: 0 and after every line terminator.
fn line_starts(chars: &[char]) -> impl Iterator<Item = usize> + '_ {
    std::iter::once(0).chain(
        chars
            .iter()
            .enumerate()
            .filter(|(_, c)| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
            .map(|(i, _)| i + 1),
    )
}

fn starts_with_ci(chars: &[char], at: usize, prefix: &str) -> bool {
    let p: Vec<char> = prefix.chars().collect();
    chars.len() >= at + p.len()
        && chars[at..at + p.len()]
            .iter()
            .zip(&p)
            .all(|(a, b)| a.to_ascii_lowercase() == *b)
}

/// `/^message-id:\s*(<[^>]+>|\S+)/im` (`spaces_in_brackets`) or
/// `/^message-id:\s*(<[^>\s]+>|\S+)/im`: the captured value.
fn message_id_header(text: &str, spaces_in_brackets: bool) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    for start in line_starts(&chars) {
        if !starts_with_ci(&chars, start, "message-id:") {
            continue;
        }
        let mut i = start + "message-id:".len();
        while i < chars.len() && is_js_space(chars[i]) {
            i += 1;
        }
        if i >= chars.len() {
            continue;
        }
        if chars[i] == '<' {
            let mut j = i + 1;
            while j < chars.len()
                && chars[j] != '>'
                && (spaces_in_brackets || !is_js_space(chars[j]))
            {
                j += 1;
            }
            if j > i + 1 && j < chars.len() && chars[j] == '>' {
                return Some(chars[i..=j].iter().collect());
            }
        }
        let mut j = i;
        while j < chars.len() && !is_js_space(chars[j]) {
            j += 1;
        }
        return Some(chars[i..j].iter().collect());
    }
    None
}

/// `messageIdFromHeaders(block)`.
fn message_id_from_headers(block: &str) -> Option<String> {
    normalize_message_id(message_id_header(&header_block(block), true).as_deref())
}

/// `headerAddresses(block, name)`: `new RegExp('^' + name + ':(.+)$', 'im')`.
fn header_addresses(block: &str, name: &str) -> Vec<String> {
    let head = header_block(block);
    let chars: Vec<char> = head.chars().collect();
    let prefix = format!("{name}:");
    let terminator = |c: &char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    for start in line_starts(&chars) {
        if !starts_with_ci(&chars, start, &prefix) {
            continue;
        }
        let from = start + prefix.chars().count();
        let end = chars[from..]
            .iter()
            .position(terminator)
            .map_or(chars.len(), |p| p + from);
        if end > from {
            let value: String = chars[from..end].iter().collect();
            return find_emails(&value).into_iter().map(|f| f.email).collect();
        }
    }
    Vec::new()
}

fn is_permanent_status(status: Option<&str>, action: Option<&str>) -> bool {
    match action.map(js_lower).as_deref() {
        Some("failed") => true,
        Some("delayed") => false,
        _ => status.is_some_and(|s| s.starts_with('5')),
    }
}

/// `isAddressFailure(permanent, status, evidence)`.
fn is_address_failure(permanent: bool, status: Option<&str>, evidence: &str) -> bool {
    if !permanent {
        return false;
    }
    if status.is_some_and(|s| s.starts_with("5.7")) {
        return false;
    }
    !(status.is_none()
        && mentions_any(evidence, &POLICY_HINTS)
        && !mentions_any(evidence, &ADDRESS_HINTS))
}

struct DsnFields {
    per_message: HashMap<String, String>,
    per_recipient: Vec<HashMap<String, String>>,
}

/// `text.split(/\r?\n[ \t]*\r?\n/)`.
fn split_blank_lines(text: &str) -> Vec<&str> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut piece = 0;
    let mut p = 0;
    while p < b.len() {
        let after_newline = match (b[p], b.get(p + 1)) {
            (b'\r', Some(b'\n')) => Some(p + 2),
            (b'\n', _) => Some(p + 1),
            _ => None,
        };
        if let Some(mut q) = after_newline {
            while q < b.len() && (b[q] == b' ' || b[q] == b'\t') {
                q += 1;
            }
            if b.get(q) == Some(&b'\r') && b.get(q + 1) == Some(&b'\n') {
                q += 2;
            } else if b.get(q) == Some(&b'\n') {
                q += 1;
            } else {
                p += 1;
                continue;
            }
            out.push(&text[piece..p]);
            piece = q;
            p = q;
            continue;
        }
        p += 1;
    }
    out.push(&text[piece..]);
    out
}

fn parse_delivery_status(text: &str) -> DsnFields {
    let groups: Vec<&str> = split_blank_lines(text)
        .into_iter()
        .filter(|g| !js_trim(g).is_empty())
        .collect();
    let per_message = groups
        .first()
        .map(|g| parse_field_group(g))
        .unwrap_or_default();
    let per_recipient: Vec<HashMap<String, String>> = groups
        .iter()
        .skip(1)
        .map(|g| parse_field_group(g))
        .filter(|g| g.contains_key("final-recipient") || g.contains_key("original-recipient"))
        .collect();
    if per_recipient.is_empty()
        && (per_message.contains_key("final-recipient")
            || per_message.contains_key("original-recipient"))
    {
        return DsnFields {
            per_message: HashMap::new(),
            per_recipient: vec![per_message],
        };
    }
    DsnFields {
        per_message,
        per_recipient,
    }
}

#[derive(Default)]
struct RecipientVerdict {
    recipients: Vec<String>,
    status: Option<String>,
    action: Option<String>,
    diagnostic: Option<String>,
}

/// `summarizeRecipients(groups)`: the first failing recipient decides.
fn summarize_recipients(groups: &[HashMap<String, String>]) -> RecipientVerdict {
    let mut verdict = RecipientVerdict::default();
    for group in groups {
        let address = parse_recipient_field(group.get("final-recipient"))
            .or_else(|| parse_recipient_field(group.get("original-recipient")));
        if let Some(address) = address
            && !verdict.recipients.contains(&address)
        {
            verdict.recipients.push(address);
        }
        // `status.split(/\s/)[0]`.
        let group_status = group
            .get("status")
            .map(|s| s.split(is_js_space).next().unwrap_or_default().to_owned());
        let group_action = group.get("action").map(|a| js_lower(a));
        let decides = verdict.status.is_none()
            || (group_action.as_deref() == Some("failed")
                && verdict.action.as_deref() != Some("failed"));
        if !decides {
            continue;
        }
        if group_status.is_some() {
            verdict.status = group_status;
        }
        if group_action.is_some() {
            verdict.action = group_action;
        }
        if let Some(diagnostic) = group.get("diagnostic-code") {
            verdict.diagnostic = Some(diagnostic.clone());
        }
    }
    verdict
}

fn bounce_from_dsn(parsed: &ParsedInbound) -> Option<BounceInfo> {
    let report = parsed
        .report_parts
        .iter()
        .find(|p| p.mime_type == "message/delivery-status");
    let content_type = parsed.content_type.to_ascii_lowercase();
    let is_report =
        content_type.contains("multipart/report") && content_type.contains("delivery-status");
    if report.is_none() && !is_report {
        return None;
    }
    let dsn = report.map_or_else(
        || DsnFields {
            per_message: HashMap::new(),
            per_recipient: Vec::new(),
        },
        |r| parse_delivery_status(&r.text),
    );
    let original = parsed
        .report_parts
        .iter()
        .find(|p| p.mime_type == "message/rfc822" || p.mime_type == "text/rfc822-headers");
    let mut verdict = summarize_recipients(&dsn.per_recipient);
    if verdict.recipients.is_empty()
        && let Some(original) = original
    {
        verdict
            .recipients
            .extend(header_addresses(&original.text, "to"));
    }
    let original_message_id = normalize_message_id(
        dsn.per_message
            .get("x-original-message-id")
            .map(String::as_str),
    )
    .or_else(|| original.and_then(|o| message_id_from_headers(&o.text)));
    let permanent = is_permanent_status(verdict.status.as_deref(), verdict.action.as_deref());
    let evidence = format!(
        "{} {}",
        verdict.diagnostic.as_deref().unwrap_or_default(),
        parsed.text
    );
    Some(BounceInfo {
        address_rejected: is_address_failure(permanent, verdict.status.as_deref(), &evidence),
        recipients: verdict.recipients,
        original_message_id,
        status: verdict.status,
        action: verdict.action,
        diagnostic: verdict.diagnostic,
        permanent,
        source: "dsn",
    })
}

fn looks_like_bounce_sender(parsed: &ParsedInbound) -> bool {
    if let Some(from) = &parsed.from {
        let local = from.email.split('@').next().unwrap_or_default();
        if SYSTEM_LOCAL_PARTS.contains(&local)
            || (local.starts_with("microsoftexchange")
                && weldsuite_reach_domain::js_len(local) > 30)
        {
            return true;
        }
        if from
            .name
            .as_deref()
            .is_some_and(|name| mentions_any(name, &SYSTEM_DISPLAY_NAMES))
        {
            return true;
        }
    }
    let subject = js_lower(js_trim(&parsed.subject));
    BOUNCE_SUBJECT_PREFIXES
        .iter()
        .any(|prefix| subject.starts_with(prefix))
}

/// `/^>:\s{0,3}host\b/` on the 12 units after an address.
fn followed_by_host(after: &[u16]) -> bool {
    let text = String::from_utf16_lossy(after);
    let Some(rest) = text.strip_prefix(">:") else {
        return false;
    };
    let mut rest = rest;
    for _ in 0..3 {
        match rest.chars().next() {
            Some(c) if is_js_space(c) => rest = &rest[c.len_utf8()..],
            _ => break,
        }
    }
    rest.strip_prefix("host").is_some_and(|tail| {
        tail.bytes()
            .next()
            .is_none_or(|b| !(b.is_ascii_alphanumeric() || b == b'_'))
    })
}

/// `recipientsFromText(text)`: the failed recipients, best signal first.
fn recipients_from_text(text: &str) -> Vec<String> {
    let lower = js_lower(text).replace('\u{2019}', "'");
    let lower_units = units(&lower);
    let mut out: Vec<String> = Vec::new();
    let mut add = |address: Option<String>| {
        if let Some(address) = address
            && !out.contains(&address)
        {
            out.push(address);
        }
    };
    for marker in FAILED_TO_MARKERS {
        if let Some(at) = lower.find(marker) {
            let at16 = weldsuite_reach_domain::js_len(&lower[..at]);
            add(email_after(
                &lower_units,
                at16 + weldsuite_reach_domain::js_len(marker),
            ));
        }
    }
    for found in find_emails_units(&lower_units) {
        let end = (found.end + 12).min(lower_units.len());
        if followed_by_host(&lower_units[found.end.min(end)..end]) {
            add(Some(found.email));
        }
    }
    let lines = split_lines(text);
    if let Some(separator) = lines
        .iter()
        .position(|line| is_quote_separator(js_trim(line)))
    {
        let joined = lines[separator + 1..].join("\n");
        let rest = joined.trim_start_matches(is_js_space);
        for address in header_addresses(rest, "to") {
            add(Some(address));
        }
    }
    out
}

static STATUS_WITH_REPLY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u)\b[245]\d\d[ -]([245]\.\d{1,3}\.\d{1,3})\b").expect("status pattern")
});
static STATUS_BARE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u)\b([45]\.\d{1,3}\.\d{1,3})\b").expect("status pattern"));

fn bounce_from_text(parsed: &ParsedInbound) -> Option<BounceInfo> {
    if !looks_like_bounce_sender(parsed) {
        return None;
    }
    let text = &parsed.text;
    let id = message_id_header(text, false);
    let status = STATUS_WITH_REPLY
        .captures(text)
        .or_else(|| STATUS_BARE.captures(text))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_owned());
    let delayed = mentions_any(&parsed.subject, &DELAY_HINTS)
        || (status.is_none() && mentions_any(text, &DELAY_HINTS));
    let permanent = status.as_deref().map_or(!delayed, |s| s.starts_with('5'));
    Some(BounceInfo {
        recipients: recipients_from_text(text),
        original_message_id: normalize_message_id(id.as_deref()),
        address_rejected: is_address_failure(permanent, status.as_deref(), &js_slice(text, 4000)),
        status,
        action: Some(if permanent { "failed" } else { "delayed" }.to_owned()),
        diagnostic: None,
        permanent,
        source: "text",
    })
}

/// `parseBounce(parsed)`: the bounce a message reports, or `None`.
pub fn parse_bounce(parsed: &ParsedInbound) -> Option<BounceInfo> {
    bounce_from_dsn(parsed).or_else(|| bounce_from_text(parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_emails() {
        let found = find_emails("Write to Jane.Doe@Acme.NL. or <x@y.io>; not a@b or @c.com");
        let emails: Vec<&str> = found.iter().map(|f| f.email.as_str()).collect();
        assert_eq!(emails, ["jane.doe@acme.nl", "x@y.io"]);
        assert_eq!(found[0].start, 9);
        assert_eq!(found[0].end, 25);
    }

    #[test]
    fn splits_on_blank_lines() {
        assert_eq!(split_blank_lines("a\r\n\r\nb\n \t\nc"), ["a", "b", "c"]);
        assert_eq!(split_blank_lines("a\nb"), ["a\nb"]);
    }

    #[test]
    fn field_groups() {
        let g = parse_field_group(
            "Final-Recipient: rfc822; a@b.co\r\nDiagnostic-Code: smtp; 550\r\n  user unknown\r\nStatus: 5.1.1",
        );
        assert_eq!(g["final-recipient"], "rfc822; a@b.co");
        assert_eq!(g["diagnostic-code"], "smtp; 550 user unknown");
        assert_eq!(
            parse_recipient_field(g.get("final-recipient")).as_deref(),
            Some("a@b.co")
        );
    }

    #[test]
    fn header_blocks() {
        assert_eq!(
            message_id_from_headers("To: a@b.co\r\nMessage-ID:\r\n <x@y>\r\n\r\nMessage-ID: <z@w>")
                .as_deref(),
            Some("x@y")
        );
        assert_eq!(
            header_addresses("Subject: x\nTO: <A@B.co>\n\nTo: c@d.co", "to"),
            ["a@b.co"]
        );
        assert!(followed_by_host(&units(">: host mx.example")));
        assert!(!followed_by_host(&units(">: hostname")));
    }
}
