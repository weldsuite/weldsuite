//! `corpus/validate.ts`: the checks every corpus thread passes, the stored
//! set's and every freshly generated one. A thread that fails one is dropped,
//! never repaired: the corpus is plain, link-free, marker-free business
//! email, and one thread that reads like marketing or like a test costs more
//! than it adds.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;
use weldsuite_reach_domain::text::js_trim;

use super::corpus::{CorpusMessage, CorpusThread};

const SUBJECT_MIN: usize = 3;
const SUBJECT_MAX: usize = 120;
const BODY_MIN: usize = 10;
const BODY_MAX: usize = 1500;
/// A run of this many digits (separators allowed) looks like a phone number.
const PHONE_DIGITS: usize = 9;

/// `PLACEHOLDER_NAMES`: the writer of a message is always the "sender".
pub const PLACEHOLDER_NAMES: [&str; 4] = [
    "senderFirstName",
    "senderLastName",
    "recipientFirstName",
    "recipientLastName",
];

/// `FORBIDDEN_WORDS`: never in a warmup email (whole words, any case).
pub const FORBIDDEN_WORDS: [&str; 47] = [
    // gives the network away
    "warmup",
    "warm-up",
    "deliverability",
    "inbox",
    "mailbox",
    "test",
    "tests",
    "tested",
    "testing",
    // spam triggers
    "spam",
    "spammy",
    "newsletter",
    "newsletters",
    "unsubscribe",
    "unsubscribing",
    "click",
    "clicks",
    "clicked",
    "clicking",
    "offer",
    "offers",
    "offered",
    "offering",
    "free",
    "promotion",
    "promotions",
    "promotional",
    "promo",
    "discount",
    "discounts",
    "sale",
    "urgent",
    "guarantee",
    "guaranteed",
    "bonus",
    "winner",
    "lottery",
    "cheap",
    "congratulations",
    "casino",
    "crypto",
    "bitcoin",
    // an attachment that is not there reads as odd to a person
    "attach",
    "attached",
    "attachment",
    "attachments",
    "enclosed",
];

/// `FORBIDDEN_PHRASES`: never in a warmup email (anywhere, any case).
pub const FORBIDDEN_PHRASES: [&str; 15] = [
    "warm up",
    "limited time",
    "act now",
    "buy now",
    "click here",
    "opt out",
    "opt-out",
    "no obligation",
    "risk-free",
    "risk free",
    "make money",
    "dear friend",
    "credit card",
    "100%",
    "once in a lifetime",
];

const TRAILING_PUNCTUATION: &str = ".,;:!?)\"'";
const CURRENCY_SYMBOLS: [char; 5] = ['$', '€', '£', '¥', '₹'];
const DOMAIN_SUFFIXES: [&str; 11] = [
    "com", "org", "net", "io", "co", "nl", "de", "uk", "eu", "app", "dev",
];
/// Words that may follow "Hi" / "Hello" in a greeting without being a name.
const GREETING_NON_NAMES: [&str; 7] =
    ["there", "all", "team", "everyone", "both", "folks", "again"];

static SIGN_OFF_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:thanks|thank you|many thanks|best|best regards|kind regards|warm regards|regards|cheers|talk soon|speak soon|take care|all the best|sincerely),?$",
    )
    .expect("pattern")
});
static GREETING_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:hi|hello|hey|dear|good\s+morning|good\s+afternoon|good\s+evening)\s+([^\s,!.{]+)",
    )
    .expect("pattern")
});
static PLACEHOLDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{[A-Za-z]+\}\}").expect("pattern"));
static PICTOGRAPHIC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\p{Extended_Pictographic}").expect("pattern"));
static WORD_BREAK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^a-z0-9'-]+").expect("pattern"));

/// The words the generation prompt names (`FORBIDDEN_WORDS` without the
/// hyphenated ones).
pub fn prompt_forbidden_words() -> Vec<&'static str> {
    FORBIDDEN_WORDS
        .iter()
        .copied()
        .filter(|w| !w.contains('-'))
        .collect()
}

fn strip_trailing_punctuation(token: &str) -> &str {
    token.trim_end_matches(|c| TRAILING_PUNCTUATION.contains(c))
}

fn has_link_or_address(text: &str) -> bool {
    let lower = text.to_lowercase();
    if lower.contains("http")
        || lower.contains("www.")
        || lower.contains("://")
        || lower.contains('@')
    {
        return true;
    }
    lower.split_whitespace().any(|token| {
        let trimmed = strip_trailing_punctuation(token);
        trimmed.rfind('.').is_some_and(|dot| {
            let suffix = &trimmed[dot + 1..];
            dot > 0 && !suffix.is_empty() && DOMAIN_SUFFIXES.contains(&suffix)
        })
    })
}

/// Digits with only spaces, dots, dashes, parentheses or a plus between
/// them, nine or more in a row.
fn has_phone_like_number(text: &str) -> bool {
    let mut digits = 0;
    for c in text.chars() {
        if c.is_ascii_digit() {
            digits += 1;
            if digits >= PHONE_DIGITS {
                return true;
            }
        } else if !" .-()+".contains(c) {
            digits = 0;
        }
    }
    false
}

fn find_forbidden_term(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    if let Some(word) = WORD_BREAK
        .split(&lower)
        .find(|word| FORBIDDEN_WORDS.contains(word))
    {
        return Some(word.to_owned());
    }
    FORBIDDEN_PHRASES
        .iter()
        .find(|phrase| lower.contains(*phrase))
        .map(|phrase| (*phrase).to_owned())
}

fn has_markup_or_emoji(text: &str) -> bool {
    text.contains("**")
        || text.contains("```")
        || text.contains('`')
        || text.contains('<')
        || text.contains('>')
        || PICTOGRAPHIC.is_match(text)
}

/// Every `{{name}}` is a known placeholder and no brace is left dangling.
fn find_placeholder_issue(text: &str) -> Option<String> {
    let mut pos = 0;
    while let Some(open) = text[pos..].find("{{").map(|i| i + pos) {
        let Some(close) = text[open + 2..].find("}}").map(|i| i + open + 2) else {
            return Some("unterminated placeholder".to_owned());
        };
        let name = &text[open + 2..close];
        if !PLACEHOLDER_NAMES.contains(&name) {
            return Some(format!("unknown placeholder \"{name}\""));
        }
        pos = close + 2;
    }
    let rest = PLACEHOLDER.replace_all(text, "");
    (rest.contains('{') || rest.contains('}')).then(|| "stray brace".to_owned())
}

/// A greeting or sign-off that names a person must use the placeholders.
fn find_hardcoded_name(body: &str) -> Option<String> {
    let lines: Vec<&str> = body
        .split('\n')
        .map(js_trim)
        .filter(|line| !line.is_empty())
        .collect();
    if let Some(name) = lines
        .first()
        .and_then(|line| GREETING_NAME.captures(line))
        .and_then(|captures| captures.get(1))
        .map(|name| name.as_str())
        && !GREETING_NON_NAMES.contains(&name.to_lowercase().as_str())
    {
        return Some(format!("greeting names \"{name}\""));
    }
    if lines.len() >= 2 {
        let sign_off = lines[lines.len() - 2];
        let signature = lines[lines.len() - 1];
        if SIGN_OFF_LINE.is_match(sign_off) && !signature.contains("{{") {
            return Some(format!("signature \"{signature}\" is not a placeholder"));
        }
    }
    None
}

/// `findContentIssue(text)`: what is wrong with a piece of corpus text.
pub fn find_content_issue(text: &str) -> Option<String> {
    if has_link_or_address(text) {
        return Some("contains a link or an address".to_owned());
    }
    if has_phone_like_number(text) {
        return Some("contains a phone number".to_owned());
    }
    if CURRENCY_SYMBOLS.iter().any(|symbol| text.contains(*symbol)) {
        return Some("contains a currency symbol".to_owned());
    }
    if let Some(term) = find_forbidden_term(text) {
        return Some(format!("contains \"{term}\""));
    }
    if has_markup_or_emoji(text) {
        return Some("contains markup or an emoji".to_owned());
    }
    find_placeholder_issue(text)
}

/// A string's length as JavaScript counts it (UTF-16 units).
fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `z.string().trim().min(min).max(max)`: the trimmed string when it fits.
fn trimmed_between(value: &Value, min: usize, max: usize) -> Option<String> {
    let text = js_trim(value.as_str()?);
    (min..=max).contains(&js_len(text)).then(|| text.to_owned())
}

/// `parseCorpusThread(value)`: the thread when it passes every check (its
/// subject and bodies trimmed).
pub fn parse_corpus_thread(value: &Value) -> Option<CorpusThread> {
    let fields = value.as_object()?;
    let id = fields.get("id")?.as_str()?;
    let id_ok = (1..=64).contains(&js_len(id))
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !id_ok {
        return None;
    }
    let subject = trimmed_between(fields.get("subject")?, SUBJECT_MIN, SUBJECT_MAX)?;
    let raw_messages = fields.get("messages")?.as_array()?;
    if !(2..=4).contains(&raw_messages.len()) {
        return None;
    }
    let mut messages = Vec::with_capacity(raw_messages.len());
    for (index, raw) in raw_messages.iter().enumerate() {
        let raw = raw.as_object()?;
        let author = raw.get("author")?.as_str()?;
        if !matches!(author, "starter" | "responder") {
            return None;
        }
        let body = trimmed_between(raw.get("body")?, BODY_MIN, BODY_MAX)?;
        let expected = if index % 2 == 0 {
            "starter"
        } else {
            "responder"
        };
        if author != expected
            || find_content_issue(&body).is_some()
            || find_hardcoded_name(&body).is_some()
        {
            return None;
        }
        messages.push(CorpusMessage {
            author: author.to_owned(),
            body,
        });
    }
    let re = subject
        .get(..3)
        .is_some_and(|start| start.eq_ignore_ascii_case("re:"));
    if re || subject.contains('\n') || find_content_issue(&subject).is_some() {
        return None;
    }
    Some(CorpusThread {
        id: id.to_owned(),
        subject,
        messages,
    })
}

/// `parseCorpusThreads(value)`: the valid threads of a stored set, in order,
/// repeated ids dropped; nothing for a value that is not an array.
pub fn parse_corpus_threads(value: &Value) -> Vec<CorpusThread> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    let mut threads: Vec<CorpusThread> = Vec::new();
    for item in items {
        if let Some(thread) = parse_corpus_thread(item)
            && !threads.iter().any(|t| t.id == thread.id)
        {
            threads.push(thread);
        }
    }
    threads
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn thread() -> Value {
        json!({
            "id": "gen-2026-10-001",
            "subject": "Moving our meeting",
            "messages": [
                { "author": "starter", "body": "Hi {{recipientFirstName}}, can we move our meeting to Friday morning?\n\nThanks,\n{{senderFirstName}}" },
                { "author": "responder", "body": "Friday morning works for me, see you then.\n\n{{senderFirstName}}" },
            ],
        })
    }

    fn with(key: &str, value: Value) -> Value {
        let mut thread = thread();
        thread[key] = value;
        thread
    }

    fn with_body(index: usize, body: &str) -> Value {
        let mut thread = thread();
        thread["messages"][index]["body"] = json!(body);
        thread
    }

    #[test]
    fn content_issues_match_typescript() {
        for text in [
            "Have a look at http://example.invalid/page when you can.",
            "Details are on www.example.invalid for now.",
            "Write to me at someone@example.invalid please.",
            "The details are on example.com if you want them.",
            "You can reach me on +31 6 1234 5678 after lunch.",
            "The quote came to $4,200 in the end.",
            "The quote came to €4,200 in the end.",
            "This is a free upgrade for you.",
            "This is only a warmup message.",
            "Just a quick test before we go live.",
            "Act now before the date passes.",
            "See the attached document for details.",
            "This is **really** important to me.",
            "Thanks a lot \u{1F600} see you soon.",
            "Hi {{customerName}}, thanks for your time.",
            "Hi {{recipientFirstName, thanks for your time.",
        ] {
            assert!(find_content_issue(text).is_some(), "{text}");
        }
        for text in [
            "Thursday morning works. How about 10:00? I will send an invite.",
            "The order was placed under reference 4471 and totals 2,300 for the quarter.",
            "We moved from 12 to 15 people, so the quote changes a little.",
            "Please see the latest version, and the contest rules are fine.",
            "Hi {{recipientFirstName}}, thanks.\n\nBest,\n{{senderFirstName}} {{senderLastName}}",
            "Meet at 2 p.m. at the entrance, e.g. by the front desk.",
            "The latest contest results and a freelance designer are fine.",
        ] {
            assert_eq!(find_content_issue(text), None, "{text}");
        }
    }

    #[test]
    fn threads_parse_as_typescript_parses_them() {
        let parsed = parse_corpus_thread(&with("subject", json!("  Moving our meeting  ")))
            .expect("a valid thread");
        assert_eq!(parsed.subject, "Moving our meeting");
        assert_eq!(parsed.messages.len(), 2);
        let first = thread()["messages"][0].clone();
        let second = thread()["messages"][1].clone();
        for bad in [
            with("messages", json!([first])),
            with("messages", json!([first, second, first, second, first])),
            with("messages", json!([second, first])),
            with("subject", json!("   ")),
            with("subject", json!("x".repeat(200))),
            with_body(1, "   "),
            with_body(1, &"word ".repeat(400)),
            with("subject", json!("Re: Moving our meeting")),
            with_body(
                0,
                "Hi {{recipientFirstName}}, see http://example.invalid today.",
            ),
            with_body(1, "Mail me on someone@example.invalid thanks."),
            with("subject", json!("Free tickets for you")),
            with_body(
                0,
                "Hi Sarah, can we move our meeting to Friday?\n\nThanks,\n{{senderFirstName}}",
            ),
            with_body(1, "Friday works for me, see you then.\n\nBest,\nDaniel"),
            Value::Null,
            json!("thread"),
            json!({ "id": "x", "subject": "Hello there", "messages": "no" }),
        ] {
            assert_eq!(parse_corpus_thread(&bad), None, "{bad}");
        }
        let group = with_body(
            0,
            "Hi all, can we move our meeting to Friday morning?\n\nThanks,\n{{senderFirstName}}",
        );
        assert!(parse_corpus_thread(&group).is_some());
    }

    #[test]
    fn a_stored_set_keeps_its_valid_threads_once() {
        let a = with("id", json!("a"));
        let mut b = with("id", json!("b"));
        b["subject"] = json!("Re: broken");
        let c = with("id", json!("c"));
        let mut duplicate = with("id", json!("a"));
        duplicate["subject"] = json!("Another subject");
        let ids: Vec<String> = parse_corpus_threads(&json!([a, b, c, duplicate, 42]))
            .into_iter()
            .map(|t| t.id)
            .collect();
        assert_eq!(ids, ["a", "c"]);
        assert_eq!(parse_corpus_threads(&json!({ "threads": [thread()] })), []);
        assert_eq!(parse_corpus_threads(&Value::Null), []);
    }

    #[test]
    fn the_built_in_corpus_passes() {
        for thread in super::super::corpus::corpus() {
            let value = serde_json::json!({
                "id": thread.id,
                "subject": thread.subject,
                "messages": thread.messages.iter().map(|m| json!({ "author": m.author, "body": m.body })).collect::<Vec<_>>(),
            });
            assert!(parse_corpus_thread(&value).is_some(), "{}", thread.id);
        }
    }
}
