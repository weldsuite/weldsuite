//! `lib/inbound/auto-reply.ts`, `intent.ts` and `kind.ts`: automatic
//! replies, the rule-detected opt-out, and what kind an inbound message is.

use std::collections::HashMap;

use weldsuite_reach_domain::text::{js_trim, normalize_subject, trim_end_chars};

use super::bounce::{BounceInfo, parse_bounce};
use super::parse::{ParsedInbound, js_lower, js_split_ws};

/// Subjects only an auto-responder writes, anywhere in the subject
/// (`SUBJECT_ANYWHERE`, case-insensitive), with each `[ -]`, `[ée]` and
/// `[aá]` spelled out.
const SUBJECT_ANYWHERE: &[&str] = &[
    "out of the office",
    "out of the-office",
    "out of-the office",
    "out of-the-office",
    "out-of the office",
    "out-of the-office",
    "out-of-the office",
    "out-of-the-office",
    "out of office",
    "out of-office",
    "out-of office",
    "out-of-office",
    "automatic reply",
    "automatisch antwoord",
    "automatisch bericht",
    "afwezigheidsmelding",
    "automatische antwort",
    "abwesenheitsnotiz",
    "abwesenheitsmeldung",
    "réponse automatique",
    "reponse automatique",
    "absence du bureau",
    "respuesta automatica",
    "respuesta automática",
    "risposta automatica",
];

/// What `SUBJECT_PREFIX` matches before its `\b`
/// (`^(?:auto[ -]?reply|auto[ -]?response|autoreply|autorespond|afwezig(?:heid)?|abwesen(?:d|heit)|ooo)\b`).
const SUBJECT_PREFIXES: &[&str] = &[
    "auto reply",
    "auto-reply",
    "autoreply",
    "auto response",
    "auto-response",
    "autoresponse",
    "autorespond",
    "afwezig",
    "afwezigheid",
    "abwesend",
    "abwesenheit",
    "ooo",
];

const AUTO_PRECEDENCE: [&str; 5] = ["auto_reply", "auto-reply", "bulk", "junk", "list"];

/// `AutoReplyDetection`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoReplyDetection {
    pub auto: bool,
    pub reason: Option<String>,
}

fn is_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn starts_with_prefix(bare: &str) -> bool {
    // `/i` without the `u` flag folds ASCII letters only here.
    let lower = bare.to_ascii_lowercase();
    SUBJECT_PREFIXES.iter().any(|prefix| {
        lower.starts_with(prefix)
            && lower
                .as_bytes()
                .get(prefix.len())
                .is_none_or(|b| !is_word(*b))
    })
}

/// `detectAutoReply(headers, subject)`.
pub fn detect_auto_reply<S: std::hash::BuildHasher>(
    headers: &HashMap<String, String, S>,
    subject: &str,
) -> AutoReplyDetection {
    let found = |reason: String| AutoReplyDetection {
        auto: true,
        reason: Some(reason),
    };
    if let Some(value) = headers.get("auto-submitted") {
        let value = js_lower(js_trim(value));
        if !value.is_empty() && value != "no" {
            return found(format!("auto-submitted:{value}"));
        }
    }
    for key in [
        "x-autoreply",
        "x-autorespond",
        "x-autoresponder",
        "x-auto-reply",
    ] {
        if headers.contains_key(key) {
            return found(key.to_owned());
        }
    }
    if let Some(value) = headers.get("precedence") {
        let value = js_lower(js_trim(value));
        if AUTO_PRECEDENCE.contains(&value.as_str()) {
            return found(format!("precedence:{value}"));
        }
    }
    if let Some(value) = headers.get("x-auto-response-suppress") {
        let value = js_lower(value);
        if !value.is_empty() && (value.contains("oof") || js_trim(&value) == "all") {
            return found("x-auto-response-suppress".to_owned());
        }
    }
    let bare = normalize_subject(subject);
    let lower = js_lower(subject);
    if starts_with_prefix(&bare) || SUBJECT_ANYWHERE.iter().any(|s| lower.contains(s)) {
        return found("subject".to_owned());
    }
    AutoReplyDetection {
        auto: false,
        reason: None,
    }
}

/// `looksLikeBulk(headers)`: newsletter and list mail.
pub fn looks_like_bulk<S: std::hash::BuildHasher>(headers: &HashMap<String, String, S>) -> bool {
    headers.contains_key("list-unsubscribe")
        || headers.contains_key("list-id")
        || headers
            .get("x-spam-flag")
            .is_some_and(|v| js_lower(js_trim(v)) == "yes")
}

const FILLER_WORDS: &[&str] = &[
    "please",
    "pls",
    "kindly",
    "me",
    "us",
    "now",
    "asap",
    "mij",
    "ons",
    "nu",
    "alsjeblieft",
    "alstublieft",
    "graag",
    "bitte",
    "jetzt",
];

const OPT_OUT_PHRASES: &[&str] = &[
    "stop",
    "stop emailing",
    "stop mailing",
    "stop sending",
    "stop contacting",
    "unsubscribe",
    "remove",
    "remove from list",
    "remove from your list",
    "remove from the list",
    "remove from this list",
    "remove from your mailing list",
    "remove from the mailing list",
    "remove from your database",
    "opt out",
    "opt-out",
    "optout",
    "afmelden",
    "uitschrijven",
    "schrijf uit",
    "verwijder",
    "verwijder van de lijst",
    "verwijder van jullie lijst",
    "abmelden",
    "austragen",
    "aus verteiler streichen",
    "aus dem verteiler entfernen",
    "désabonner",
    "desabonner",
    "désinscription",
    "desinscription",
    "désinscrire",
    "desinscrire",
];

/// Longer bodies are conversation, not a bare subject-only opt-out.
const SUBJECT_ONLY_MAX_BODY: usize = 300;

fn is_opt_out_line(line: &str) -> bool {
    let lower = js_lower(js_trim(line));
    let words = js_split_ws(trim_end_chars(&lower, ".!"));
    let core = words
        .into_iter()
        .filter(|word| !FILLER_WORDS.contains(word))
        .collect::<Vec<_>>()
        .join(" ");
    OPT_OUT_PHRASES.contains(&core.as_str())
}

/// `str.split(/\r?\n/)`.
pub(crate) fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

/// `isUnsubscribeRequest(subject, replyText)`: the first non-empty line is
/// an opt-out, or the subject is "unsubscribe" with next to no body.
pub fn is_unsubscribe_request(subject: &str, reply_text: &str) -> bool {
    let first = split_lines(reply_text)
        .into_iter()
        .map(js_trim)
        .find(|line| !line.is_empty());
    if first.is_some_and(is_opt_out_line) {
        return true;
    }
    let bare = js_lower(&normalize_subject(subject));
    trim_end_chars(&bare, ".! \t") == "unsubscribe"
        && weldsuite_reach_domain::js_len(js_trim(reply_text)) <= SUBJECT_ONLY_MAX_BODY
}

/// `InboundClassification`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboundClassification {
    /// `bounce`, `auto_reply` or `reply`.
    pub kind: &'static str,
    pub bounce: Option<BounceInfo>,
    pub auto_reply_reason: Option<String>,
}

/// DSN actions that are good news.
const SUCCESS_ACTIONS: [&str; 3] = ["delivered", "relayed", "expanded"];

/// `classifyInbound(parsed)`: a delivery failure, an automatic reply, or a
/// person answering, checked in that order.
pub fn classify_inbound(parsed: &ParsedInbound) -> InboundClassification {
    let content_type = parsed.content_type.to_ascii_lowercase();
    if content_type.contains("multipart/report")
        && content_type.contains("disposition-notification")
    {
        return InboundClassification {
            kind: "auto_reply",
            bounce: None,
            auto_reply_reason: Some("disposition-notification".to_owned()),
        };
    }
    if let Some(bounce) = parse_bounce(parsed) {
        if let Some(action) = bounce
            .action
            .as_deref()
            .filter(|a| SUCCESS_ACTIONS.contains(a))
        {
            return InboundClassification {
                kind: "auto_reply",
                bounce: None,
                auto_reply_reason: Some(format!("dsn:{action}")),
            };
        }
        return InboundClassification {
            kind: "bounce",
            bounce: Some(bounce),
            auto_reply_reason: None,
        };
    }
    let auto = detect_auto_reply(&parsed.headers, &parsed.subject);
    if auto.auto {
        return InboundClassification {
            kind: "auto_reply",
            bounce: None,
            auto_reply_reason: auto.reason,
        };
    }
    InboundClassification {
        kind: "reply",
        bounce: None,
        auto_reply_reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(headers: &[(&str, &str)], subject: &str) -> &'static str {
        let parsed = ParsedInbound {
            message_id: Some("x@y".to_owned()),
            subject: subject.to_owned(),
            text: "hello".to_owned(),
            headers: headers
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            content_type: "text/plain".to_owned(),
            ..ParsedInbound::default()
        };
        classify_inbound(&parsed).kind
    }

    #[test]
    fn header_signals() {
        assert_eq!(
            kind(&[("auto-submitted", "auto-generated")], "Re: hi"),
            "auto_reply"
        );
        assert_eq!(kind(&[("auto-submitted", "no")], "Re: hi"), "reply");
        assert_eq!(kind(&[("x-autoreply", "yes")], "Re: hi"), "auto_reply");
        assert_eq!(kind(&[("precedence", "bulk")], "Re: hi"), "auto_reply");
        assert_eq!(
            kind(
                &[("x-auto-response-suppress", "DR, RN, NRN, OOF, AutoReply")],
                "Re: hi"
            ),
            "auto_reply"
        );
        assert_eq!(
            kind(&[("x-auto-response-suppress", "DR")], "Re: hi"),
            "reply"
        );
    }

    #[test]
    fn subjects() {
        for subject in [
            "Out of Office: back Monday",
            "Automatic reply: Quick question",
            "Autoreply: re your email",
            "Afwezig: Quick question",
            "Automatisch antwoord: Quick question",
            "Abwesenheitsnotiz: Frage",
            "Réponse automatique : Question",
            "RE: Out of office",
            "OOO",
        ] {
            assert_eq!(kind(&[], subject), "auto_reply", "{subject}");
        }
        assert_eq!(kind(&[], "Oooh nice"), "reply");
        assert_eq!(kind(&[], "Autoresponders are great"), "reply");
    }

    #[test]
    fn opt_outs() {
        assert!(is_unsubscribe_request(
            "Re: hi",
            "Unsubscribe\n\nOn Monday..."
        ));
        assert!(is_unsubscribe_request(
            "Re: hi",
            "please remove me from your list!"
        ));
        assert!(is_unsubscribe_request("unsubscribe", ""));
        assert!(!is_unsubscribe_request("Re: hi", "stop !"));
        assert!(!is_unsubscribe_request("Re: hi", "Sure, let's talk"));
    }
}
