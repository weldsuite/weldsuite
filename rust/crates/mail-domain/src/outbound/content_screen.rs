//! Outbound content screen (`outbound/content-screen.ts`): cheap,
//! synchronous signals from the text of one message. It never blocks a send
//! on its own; the score feeds the ledger's risk score, and the flags pick
//! which templates the AI reviews first.
//!
//! The patterns are the TypeScript ones, with JavaScript's semantics: `\b`
//! is an ASCII word boundary and `.` stops at line terminators.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::text::html_to_text;

/// One attachment as the screen sees it.
#[derive(Debug, Clone, Default)]
pub struct ScreenAttachment {
    pub filename: String,
    pub content_type: Option<String>,
}

/// `ContentScreenInput`.
#[derive(Debug, Clone, Default)]
pub struct ContentScreenInput<'a> {
    pub subject: Option<&'a str>,
    pub text: Option<&'a str>,
    pub html: Option<&'a str>,
    pub attachments: &'a [ScreenAttachment],
}

/// `ContentScreenResult.flags`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ContentFlags {
    pub cold_outreach: bool,
    pub bulk: bool,
    pub phishing: bool,
    pub links: usize,
}

/// `ContentScreenResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContentScreenResult {
    /// 0 = nothing notable; 3+ = worth a look; capped at 20.
    pub score: i64,
    pub reasons: Vec<String>,
    pub flags: ContentFlags,
}

/// JavaScript's `.` (no line terminators) and ASCII `\b`, for patterns
/// written as in the TypeScript file.
fn js(pattern: &str) -> Regex {
    let translated = pattern
        .replace(r"\b", r"(?-u:\b)")
        .replace(".{", r"[^\n\r\u{2028}\u{2029}]{");
    Regex::new(&translated).unwrap_or_else(|error| panic!("bad pattern {pattern}: {error}"))
}

fn all(patterns: &[&str]) -> Vec<Regex> {
    patterns.iter().map(|pattern| js(pattern)).collect()
}

/// Phrases cold outreach is built from.
static COLD_PHRASES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    all(&[
        r"\bquick question\b",
        r"\bi (?:came across|stumbled upon|noticed) (?:your|that your)\b",
        r"\bwould you be open to\b",
        r"\b(?:1[05]|20|30)[- ]?min(?:ute)?s?\b.{0,20}\b(?:call|chat|meeting)\b",
        r"\b(?:book|schedule|grab|hop on) a (?:quick )?(?:call|chat|meeting)\b",
        r"\b(?:are you|who is) the right person\b",
        r"\bif you(?:'re| are) not the right person\b",
        r"\bnot interested\?? (?:just )?(?:reply|let me know)\b",
        r"\b(?:i|we) help (?:companies|businesses|teams|agencies|founders)\b",
        r"\b(?:boost|grow|double|increase) your (?:sales|revenue|leads|pipeline|business)\b",
        r"\bpartnership opportunity\b",
        r"\bworth a (?:quick )?(?:chat|call)\b",
        r"\bjust (?:following up|bumping this)\b",
        // Dutch
        r"\bkort(?:e)? (?:gesprek|kennismaking|belletje)\b",
        r"\b(?:1[05]|20|30) minuten\b",
        r"\bik kwam (?:uw|jullie|je) (?:bedrijf|website|profiel) tegen\b",
        r"\bik zag dat (?:jullie|u|je)\b",
        r"\bvrijblijvend(?:e)? (?:kennismaking|gesprek|offerte|kennismaken)\b",
        r"\bwij helpen (?:bedrijven|organisaties|ondernemers)\b",
        r"\bbent u de juiste persoon\b",
        r"\b(?:even )?sparren\b",
        r"\bafspraak (?:in)?plannen\b",
    ])
});

/// Bulk-mail and spam vocabulary.
static BULK_PHRASES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    all(&[
        r"\bact now\b",
        r"\blimited time\b",
        r"\bguaranteed\b",
        r"\brisk[- ]free\b",
        r"\b100% free\b",
        r"\bclick here\b",
        r"\bearn (?:money|cash|\$)",
        r"\b(?:crypto|bitcoin) (?:opportunity|investment)\b",
        r"\bunsubscribe\b",
        r"\bto stop receiving these emails\b",
        r"\bklik hier\b",
        r"\bnu bestellen\b",
        r"\bafmelden\b",
        r"\btijdelijke? aanbieding\b",
    ])
});

/// Credential and payment lures.
static PHISHING_PHRASES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    all(&[
        r"\bverify your (?:account|identity|email)\b",
        r"\bconfirm your (?:identity|account|password)\b",
        r"\byour (?:password|account) (?:has )?expired?\b",
        r"\bunusual (?:sign[- ]in|login) activity\b",
        r"\byour account (?:will be|has been) (?:suspended|locked|closed)\b",
        r"\bupdate your (?:payment|billing) (?:details|information|method)\b",
        r"\bgift ?cards?\b.{0,40}\b(?:buy|purchase|send)\b",
        r"\bverifieer (?:uw|je) (?:account|identiteit)\b",
        r"\b(?:uw|je) account (?:wordt|is) (?:geblokkeerd|opgeschort)\b",
        r"\bwerk (?:uw|je) betaalgegevens bij\b",
    ])
});

static SHORTENERS: LazyLock<Regex> = LazyLock::new(|| {
    js(
        r"(?i)\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|rb\.gy|t\.ly)/",
    )
});
static BOOKING_LINKS: LazyLock<Regex> = LazyLock::new(|| {
    js(
        r"(?i)\b(?:calendly\.com|cal\.com|savvycal\.com|meetings\.hubspot\.com|zcal\.co|tidycal\.com)/",
    )
});
static LINK: LazyLock<Regex> = LazyLock::new(|| js(r#"(?i)\bhttps?://[^\s<>"')]+"#));
static RISKY_ATTACHMENT: LazyLock<Regex> = LazyLock::new(|| {
    js(r"(?i)\.(?:exe|scr|js|jse|vbs|vbe|bat|cmd|msi|jar|iso|img|lnk|hta|ps1|docm|xlsm|pptm)$")
});
static LEADING_DIGITS: LazyLock<Regex> = LazyLock::new(|| js(r#"^["']?([0-9]+)"#));
static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| js(r"\s+"));

/// A `width`/`height` attribute's number in one tag (white space removed).
fn attribute_number<'a>(compact_tag: &'a str, attr: &str) -> Option<&'a str> {
    let at = compact_tag.find(&format!("{attr}="))?;
    let rest = &compact_tag[at + attr.len() + 1..];
    LEADING_DIGITS
        .captures(rest)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str())
}

/// An `<img>` that is 1×1: the classic open-tracking pixel.
fn has_tracking_pixel(html: &str) -> bool {
    let lower = html.to_lowercase();
    let mut from = 0;
    loop {
        let Some(start) = lower[from..].find("<img").map(|at| at + from) else {
            return false;
        };
        let Some(end) = lower[start..].find('>').map(|at| at + start) else {
            return false;
        };
        let tag = WHITESPACE.replace_all(&lower[start..=end], "");
        if attribute_number(&tag, "width") == Some("1")
            && attribute_number(&tag, "height") == Some("1")
        {
            return true;
        }
        from = end + 1;
    }
}

fn count_matches(text: &str, patterns: &[Regex]) -> i64 {
    let hits = patterns.iter().filter(|re| re.is_match(text)).count();
    i64::try_from(hits).unwrap_or(i64::MAX)
}

/// `screenOutboundContent(input)`.
pub fn screen_outbound_content(input: &ContentScreenInput<'_>) -> ContentScreenResult {
    let html = input.html.unwrap_or_default();
    let body = match input.text.filter(|text| !text.is_empty()) {
        Some(text) => text.to_owned(),
        None if !html.is_empty() => html_to_text(html),
        None => String::new(),
    };
    let plain = format!("{}\n{body}", input.subject.unwrap_or_default()).to_lowercase();
    let mut reasons = Vec::new();
    let mut score = 0;

    let cold = count_matches(&plain, &COLD_PHRASES);
    if cold > 0 {
        score += cold.min(4);
        reasons.push(format!("cold_phrases:{cold}"));
    }
    let bulk = count_matches(&plain, &BULK_PHRASES);
    if bulk > 0 {
        score += bulk.min(3);
        reasons.push(format!("bulk_phrases:{bulk}"));
    }
    let phishing = count_matches(&plain, &PHISHING_PHRASES);
    if phishing > 0 {
        score += 3 * phishing.min(2);
        reasons.push(format!("phishing_phrases:{phishing}"));
    }

    let both = format!("{plain}\n{html}");
    let links = LINK
        .find_iter(&both)
        .map(|m| m.as_str())
        .collect::<HashSet<_>>()
        .len();
    if links >= 5 {
        score += 2;
        reasons.push(format!("links:{links}"));
    }
    if SHORTENERS.is_match(&plain) || SHORTENERS.is_match(html) {
        score += 2;
        reasons.push("url_shortener".to_owned());
    }
    if BOOKING_LINKS.is_match(&plain) || BOOKING_LINKS.is_match(html) {
        score += 1;
        reasons.push("booking_link".to_owned());
    }
    if !html.is_empty() && has_tracking_pixel(html) {
        score += 2;
        reasons.push("tracking_pixel".to_owned());
    }
    let risky = input
        .attachments
        .iter()
        .filter(|attachment| RISKY_ATTACHMENT.is_match(&attachment.filename))
        .count();
    if risky > 0 {
        score += 3;
        reasons.push("risky_attachment".to_owned());
    }

    ContentScreenResult {
        score: score.min(20),
        reasons,
        flags: ContentFlags {
            cold_outreach: cold >= 2 || (cold >= 1 && BOOKING_LINKS.is_match(&both)),
            bulk: bulk >= 2,
            phishing: phishing >= 1 || risky > 0,
            links,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(subject: &str, text: &str) -> ContentScreenResult {
        screen_outbound_content(&ContentScreenInput {
            subject: Some(subject),
            text: Some(text),
            html: None,
            attachments: &[],
        })
    }

    #[test]
    fn ordinary_mail_scores_nothing() {
        let result = screen(
            "Invoice 2026-114",
            "Hi Anna, attached is the invoice for October. Let me know if anything is off.",
        );
        assert_eq!(result.score, 0);
        assert!(!result.flags.cold_outreach);
    }

    #[test]
    fn cold_outreach_is_flagged() {
        let result = screen(
            "Quick question",
            "Hi Bram, I came across your website and would you be open to a 15 minute call? \
             We help companies grow your revenue. https://calendly.com/tom/intro",
        );
        // As the TypeScript screen answers for the same message.
        assert_eq!(result.score, 5);
        assert_eq!(result.reasons, ["cold_phrases:6", "booking_link"]);
        assert_eq!(
            result.flags,
            ContentFlags {
                cold_outreach: true,
                bulk: false,
                phishing: false,
                links: 1
            }
        );
    }

    #[test]
    fn dutch_phishing_and_risky_attachments() {
        let attachments = [ScreenAttachment {
            filename: "factuur.EXE".to_owned(),
            content_type: None,
        }];
        let result = screen_outbound_content(&ContentScreenInput {
            subject: Some("Let op"),
            text: Some("Verifieer uw account vandaag nog."),
            html: None,
            attachments: &attachments,
        });
        assert!(result.flags.phishing);
        assert_eq!(result.score, 6);
        assert_eq!(result.reasons, ["phishing_phrases:1", "risky_attachment"]);
    }

    #[test]
    fn tracking_pixels_and_links() {
        let html = r#"<p>Hi</p><img src="https://t.example/p.gif" width="1" height = "1">"#;
        let result = screen_outbound_content(&ContentScreenInput {
            subject: None,
            text: None,
            html: Some(html),
            attachments: &[],
        });
        assert!(result.reasons.contains(&"tracking_pixel".to_owned()));
        assert_eq!(result.flags.links, 1);
        assert!(has_tracking_pixel("<IMG WIDTH=1 HEIGHT='1'>"));
        assert!(!has_tracking_pixel("<img width=10 height=1>"));
    }
}
