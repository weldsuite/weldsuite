//! `@weldsuite/mail-domain/store/thread-match` (the worker re-exports it as
//! `thread-match.ts`): tolerant Message-ID and subject matching for finding
//! the thread an inbound message belongs to. Pure.

use serde_json::Value;

use crate::mime::{is_js_space, js_trim};

/// `bareMessageId(id)`: angle brackets and surrounding whitespace removed.
pub fn bare_message_id(id: &str) -> String {
    let chars: Vec<char> = id.chars().collect();
    let mut start = 0;
    let mut end = chars.len();
    while start < end && (chars[start] == '<' || is_js_space(chars[start])) {
        start += 1;
    }
    while end > start && (chars[end - 1] == '>' || is_js_space(chars[end - 1])) {
        end -= 1;
    }
    chars[start..end].iter().collect()
}

/// `messageIdVariants(ids)`: each id bare and bracketed, once each, in
/// order.
pub fn message_id_variants<S: AsRef<str>>(ids: &[S]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in ids {
        let bare = bare_message_id(raw.as_ref());
        if bare.is_empty() {
            continue;
        }
        for variant in [bare.clone(), format!("<{bare}>")] {
            if !out.contains(&variant) {
                out.push(variant);
            }
        }
    }
    out
}

/// `providerMessageIds(ids)`: the local part of each id.
pub fn provider_message_ids<S: AsRef<str>>(ids: &[S]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in ids {
        let bare = bare_message_id(raw.as_ref());
        let local = bare.split('@').next().unwrap_or_default().to_owned();
        if !local.is_empty() && !out.contains(&local) {
            out.push(local);
        }
    }
    out
}

/// One `SUBJECT_PREFIX` (`/^(?:re|fwd?|aw|sv|vs|antw)(?:\[\d+\])?\s*:/i`)
/// at the start of `text`: its length in bytes.
fn subject_prefix(text: &str) -> Option<usize> {
    let lower = text.to_ascii_lowercase();
    let word = ["antw", "fwd", "fw", "re", "aw", "sv", "vs"]
        .into_iter()
        .find(|w| lower.starts_with(w))?;
    let mut at = word.len();
    let bytes = lower.as_bytes();
    if bytes.get(at) == Some(&b'[') {
        let digits = bytes[at + 1..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if digits > 0 && bytes.get(at + 1 + digits) == Some(&b']') {
            at += digits + 2;
        }
    }
    let rest = &text[at..];
    let space: usize = rest
        .chars()
        .take_while(|c| is_js_space(*c))
        .map(char::len_utf8)
        .sum();
    (text.as_bytes().get(at + space) == Some(&b':')).then_some(at + space + 1)
}

/// `stripSubjectPrefixes(subject)`.
fn strip_subject_prefixes(subject: &str) -> (String, bool) {
    let mut rest = js_trim(subject);
    let mut prefixed = false;
    while let Some(len) = subject_prefix(rest) {
        rest = rest[len..].trim_start_matches(is_js_space);
        prefixed = true;
    }
    (js_trim(rest).to_owned(), prefixed)
}

/// `bareSubject(subject)`.
pub fn bare_subject(subject: Option<&str>) -> String {
    strip_subject_prefixes(subject.unwrap_or_default()).0
}

/// `hasReplyPrefix(subject)`.
pub fn has_reply_prefix(subject: Option<&str>) -> bool {
    strip_subject_prefixes(subject.unwrap_or_default()).1
}

/// `conversationSubjects(subject)`.
pub fn conversation_subjects(subject: Option<&str>) -> Vec<String> {
    let bare = bare_subject(subject).to_lowercase();
    if bare.is_empty() {
        Vec::new()
    } else {
        vec![bare.clone(), format!("re: {bare}")]
    }
}

fn emails_of(value: &Value) -> Vec<String> {
    let list: Vec<&Value> = match value {
        Value::Array(items) => items.iter().collect(),
        Value::Null | Value::Bool(false) => Vec::new(),
        Value::String(s) if s.is_empty() => Vec::new(),
        Value::Number(n) if n.as_f64() == Some(0.0) => Vec::new(),
        other => vec![other],
    };
    list.into_iter()
        .filter_map(|entry| entry.get("email").and_then(Value::as_str))
        .filter(|email| !email.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// `involvesAddress(message, address)` over a stored row's `from`, `to`
/// and `cc`.
pub fn involves_address(from: &Value, to: &Value, cc: &Value, address: Option<&str>) -> bool {
    let Some(address) = address.filter(|a| !a.is_empty()) else {
        return false;
    };
    let wanted = address.to_lowercase();
    emails_of(from)
        .into_iter()
        .chain(emails_of(to))
        .chain(emails_of(cc))
        .any(|email| email == wanted)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn message_ids() {
        assert_eq!(
            bare_message_id(" <abc@weldmail.example> "),
            "abc@weldmail.example"
        );
        assert_eq!(
            message_id_variants(&["<abc@x.test>", "def@y.test", "<abc@x.test>", ""]),
            ["abc@x.test", "<abc@x.test>", "def@y.test", "<def@y.test>"]
        );
        assert_eq!(
            provider_message_ids(&[
                "<abc-123@eu-west-1.amazonses.com>",
                "abc-123@other.test",
                "plain"
            ]),
            ["abc-123", "plain"]
        );
    }

    #[test]
    fn subjects() {
        assert_eq!(
            bare_subject(Some("Re: RE: Fwd: Quarterly numbers")),
            "Quarterly numbers"
        );
        assert_eq!(bare_subject(Some("AW: Re[2]: Hello")), "Hello");
        assert_eq!(bare_subject(Some("Fw:Hello")), "Hello");
        assert_eq!(bare_subject(Some("Revenue: Q3")), "Revenue: Q3");
        assert_eq!(bare_subject(None), "");
        assert!(has_reply_prefix(Some("Re: Support request")));
        assert!(has_reply_prefix(Some("FWD: Support request")));
        assert!(!has_reply_prefix(Some("Support request")));
        assert!(!has_reply_prefix(Some("Reminder: invoice")));
        assert_eq!(
            conversation_subjects(Some("Re: Support Request")),
            ["support request", "re: support request"]
        );
        assert_eq!(conversation_subjects(Some("Re:")).len(), 0);
    }

    #[test]
    fn involves() {
        let from = json!({ "email": "Me@Weldmail.example", "name": "Me" });
        let to = json!([{ "email": "support@helpdesk.example" }]);
        assert!(involves_address(
            &from,
            &to,
            &Value::Null,
            Some("support@HELPDESK.example")
        ));
        assert!(involves_address(
            &from,
            &to,
            &Value::Null,
            Some("me@weldmail.example")
        ));
        assert!(!involves_address(
            &from,
            &to,
            &Value::Null,
            Some("stranger@elsewhere.example")
        ));
        assert!(!involves_address(&from, &to, &Value::Null, None));
    }
}
