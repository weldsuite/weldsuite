//! Template fingerprints for outbound mail (`outbound/fingerprint.ts`).
//!
//! One template going to many recipients who never wrote in is the core
//! cold-email pattern, whichever path sent it. Merge fields make every copy
//! a little different, so the body is normalised first and then hashed with
//! a 64-bit `SimHash` over word 3-shingles. Two copies of one template land
//! within a Hamming distance of [`FINGERPRINT_MAX_DISTANCE`]. The hashes run
//! over UTF-16 code units, as in JavaScript, so both backends give a
//! template the same fingerprint (verdicts are shared through the ledger).

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use super::limits::FINGERPRINT_MAX_DISTANCE;
use crate::text::{js_trim, utf16_prefix};

/// `MIN_FINGERPRINT_WORDS`: shorter templates are too generic.
pub const MIN_FINGERPRINT_WORDS: usize = 12;

/// `MAX_SAMPLE_CHARS`: the normalised text kept for an AI review sample.
pub const MAX_SAMPLE_CHARS: usize = 4_000;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|error| panic!("bad pattern {pattern}: {error}"))
}

/// `QUOTE_MARKERS` (`.` stops at line terminators; lines are split already).
static QUOTE_MARKERS: LazyLock<[Regex; 4]> = LazyLock::new(|| {
    [
        re(
            r"(?i)^-{2,}\s*(original message|forwarded message|oorspronkelijk bericht|doorgestuurd bericht)\s*-{2,}",
        ),
        re(r"(?i)^on .{3,200} wrote:\s*$"),
        re(r"(?i)^op .{3,200} schreef .{0,200}:\s*$"),
        re(r"(?i)^(from|van):\s.+$"),
    ]
});
static SUBJECT_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)^\s*((re|fw|fwd|aw|wg|antw)\s*:\s*)+"));
static NUMERIC_WORD: LazyLock<Regex> = LazyLock::new(|| re(r"^[0-9.,:/-]+$"));
static DIGITS: LazyLock<Regex> = LazyLock::new(|| re(r"[0-9]+"));
static NOT_WORD: LazyLock<Regex> = LazyLock::new(|| re(r"[^\p{L}\p{N}\s]+"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| re(r"\s+"));
static TOKEN_SPLIT: LazyLock<Regex> = LazyLock::new(|| re(r"[._+-]"));

/// `stripQuotedAndSignature(text)`: cut quoted history and the `-- `
/// signature.
pub fn strip_quoted_and_signature(text: &str) -> String {
    let normalised = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut out: Vec<&str> = Vec::new();
    for line in normalised.split('\n') {
        let trimmed = js_trim(line);
        if trimmed == "--" || line == "-- " {
            break;
        }
        if QUOTE_MARKERS.iter().any(|marker| marker.is_match(trimmed)) {
            break;
        }
        if trimmed.starts_with('>') {
            continue;
        }
        out.push(line);
    }
    out.join("\n")
}

/// One word, with an address, link or number replaced by a token.
fn tokenize_word(word: &str) -> String {
    if word.contains("://") || word.starts_with("www.") {
        return "tokurl".to_owned();
    }
    if let Some(at) = word.find('@') {
        // `word.indexOf('.', at) > at + 1`
        if at > 0 && word[at..].find('.').is_some_and(|dot| dot > 1) {
            return "tokemail".to_owned();
        }
    }
    if NUMERIC_WORD.is_match(word) && word.bytes().any(|b| b.is_ascii_digit()) {
        return "toknum".to_owned();
    }
    DIGITS.replace_all(word, " toknum ").into_owned()
}

/// JavaScript's `\b` (ASCII word characters) before index `at` of `text`.
fn is_ascii_boundary(text: &str, at: usize) -> bool {
    let word = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
    let before = text[..at].chars().next_back();
    let after = text[at..].chars().next();
    word(before) != word(after)
}

/// `text.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, 'g'), ' tokname ')`.
fn replace_token(text: &str, token: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut from = 0;
    while let Some(found) = text[from..].find(token).map(|at| at + from) {
        let end = found + token.len();
        if is_ascii_boundary(text, found) && is_ascii_boundary(text, end) {
            out.push_str(&text[from..found]);
            out.push_str(" tokname ");
            from = end;
        } else {
            // Next possible start: one character on.
            let step = text[found..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&text[from..found + step]);
            from = found + step;
        }
    }
    out.push_str(&text[from..]);
    out
}

/// `NormalizeInput`.
#[derive(Debug, Clone, Default)]
pub struct NormalizeInput<'a> {
    pub subject: Option<&'a str>,
    pub text: &'a str,
    pub personal_tokens: &'a [String],
}

/// `normalizeForFingerprint(input)`: lower-cased, tokenised text with merge
/// fields replaced.
pub fn normalize_for_fingerprint(input: &NormalizeInput<'_>) -> String {
    let subject = SUBJECT_PREFIX.replace(input.subject.unwrap_or_default(), "");
    let joined = format!("{subject}\n{}", strip_quoted_and_signature(input.text)).to_lowercase();
    let mut text = joined
        .split(|c: char| c.is_whitespace() || c == '\u{feff}')
        .collect::<Vec<_>>()
        .iter()
        .map(|word| tokenize_word(word))
        .collect::<Vec<_>>()
        .join(" ");
    for raw in input.personal_tokens {
        let token = js_trim(raw).to_lowercase();
        if token.chars().map(char::len_utf16).sum::<usize>() < 2 {
            continue;
        }
        text = replace_token(&text, &token);
    }
    let text = NOT_WORD.replace_all(&text, " ");
    let text = SPACES.replace_all(&text, " ");
    utf16_prefix(js_trim(&text), MAX_SAMPLE_CHARS).to_owned()
}

/// FNV-1a over UTF-16 code units, 32 bits, seeded, with a final avalanche.
fn fnv1a32(value: &str, seed: u32) -> u32 {
    let mut hash = 0x811c_9dc5_u32 ^ seed;
    for unit in value.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x85eb_ca6b);
    hash ^= hash >> 13;
    hash = hash.wrapping_mul(0xc2b2_ae35);
    hash ^= hash >> 16;
    hash
}

/// Word 3-shingles; fewer than three words are one shingle.
fn shingles_of(words: &[&str]) -> Vec<String> {
    if words.len() < 3 {
        return if words.is_empty() {
            Vec::new()
        } else {
            vec![words.join(" ")]
        };
    }
    words
        .windows(3)
        .map(|w| format!("{} {} {}", w[0], w[1], w[2]))
        .collect()
}

fn add_votes(weights: &mut [i64; 64], hash: u32, offset: usize) {
    for bit in 0..32 {
        weights[offset + bit] += if (hash >> bit) & 1 == 1 { 1 } else { -1 };
    }
}

fn bits_to_hex(weights: &[i64; 64], offset: usize) -> String {
    let mut value = 0_u32;
    for bit in 0..32 {
        if weights[offset + bit] > 0 {
            value |= 1 << bit;
        }
    }
    format!("{value:08x}")
}

/// `simhash64(normalized)`: 16 lower-case hex characters.
pub fn simhash64(normalized: &str) -> String {
    let mut weights = [0_i64; 64];
    let words: Vec<&str> = normalized.split(' ').filter(|w| !w.is_empty()).collect();
    for shingle in shingles_of(&words) {
        add_votes(&mut weights, fnv1a32(&shingle, 0x9e37_79b9), 0);
        add_votes(&mut weights, fnv1a32(&shingle, 0x7f4a_7c15), 32);
    }
    format!("{}{}", bits_to_hex(&weights, 0), bits_to_hex(&weights, 32))
}

/// `hammingDistance(a, b)`: 64 when either is malformed.
pub fn hamming_distance(a: &str, b: &str) -> u32 {
    if a.len() != 16 || b.len() != 16 {
        return 64;
    }
    match (u64::from_str_radix(a, 16), u64::from_str_radix(b, 16)) {
        (Ok(a), Ok(b)) => (a ^ b).count_ones(),
        _ => 64,
    }
}

/// `isSameTemplate(a, b)`.
pub fn is_same_template(a: &str, b: &str) -> bool {
    hamming_distance(a, b) <= FINGERPRINT_MAX_DISTANCE
}

/// `TemplateFingerprint`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateFingerprint {
    pub fingerprint: String,
    pub normalized: String,
    pub words: usize,
    pub too_short: bool,
}

/// `fingerprintTemplate(input)`.
pub fn fingerprint_template(input: &NormalizeInput<'_>) -> TemplateFingerprint {
    let normalized = normalize_for_fingerprint(input);
    let words = if normalized.is_empty() {
        0
    } else {
        normalized.split(' ').count()
    };
    TemplateFingerprint {
        fingerprint: simhash64(&normalized),
        words,
        too_short: words < MIN_FINGERPRINT_WORDS,
        normalized,
    }
}

const GENERIC_LABELS: [&str; 15] = [
    "info", "mail", "contact", "hello", "sales", "support", "admin", "office", "team", "gmail",
    "outlook", "hotmail", "yahoo", "icloud", "live",
];

/// Name-like parts of one address: local-part pieces and the domain's first
/// label.
fn address_tokens(address: &str) -> Vec<String> {
    let lower = address.to_lowercase();
    let mut parts = lower.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    TOKEN_SPLIT
        .split(local)
        .map(str::to_owned)
        .chain(std::iter::once(
            domain.split('.').next().unwrap_or_default().to_owned(),
        ))
        .filter(|part| {
            part.chars().map(char::len_utf16).sum::<usize>() >= 3
                && !GENERIC_LABELS.contains(&part.as_str())
        })
        .collect()
}

/// `personalTokensFor(recipients, names)`.
pub fn personal_tokens_for(recipients: &[String], names: &[String]) -> Vec<String> {
    let name_parts = names
        .iter()
        .flat_map(|name| {
            name.split(|c: char| c.is_whitespace() || c == '\u{feff}')
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|part| part.chars().map(char::len_utf16).sum::<usize>() >= 2);
    let mut seen = HashSet::new();
    name_parts
        .chain(recipients.iter().flat_map(|r| address_tokens(r)))
        .filter(|token| seen.insert(token.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEMPLATE: &str = "Hi {name},\n\nI noticed {company} is growing fast and wanted to reach out. \
        We help teams like yours cut their onboarding time in half with a simple tool. \
        Would you be open to a quick call next week to see if it fits?\n\nBest,\nTom";

    fn copy(name: &str, company: &str) -> String {
        TEMPLATE
            .replace("{name}", name)
            .replace("{company}", company)
    }

    fn fp(text: &str, recipient: &str, name: &str) -> TemplateFingerprint {
        let tokens = personal_tokens_for(&[recipient.to_owned()], &[name.to_owned()]);
        fingerprint_template(&NormalizeInput {
            subject: Some("Quick question"),
            text,
            personal_tokens: &tokens,
        })
    }

    #[test]
    fn copies_of_one_template_match() {
        let a = fp(&copy("Anna", "Acme"), "anna@acme.com", "Anna de Vries");
        let b = fp(&copy("Bram", "Bolt"), "bram@bolt.io", "Bram Jansen");
        assert!(!a.too_short);
        assert!(is_same_template(&a.fingerprint, &b.fingerprint));
        let other = fp(
            "Thanks for the invoice, we paid it this morning. The receipt is attached for your records and the next one is due in March.",
            "anna@acme.com",
            "Anna",
        );
        assert!(!is_same_template(&a.fingerprint, &other.fingerprint));
    }

    #[test]
    fn normalisation_cuts_quotes_signatures_and_tokens() {
        let normalized = normalize_for_fingerprint(&NormalizeInput {
            subject: Some("RE: Fwd: Plan"),
            text: "Call me at 06-1234 or mail tom@acme.com, see https://acme.com\n-- \nTom\n> quoted",
            personal_tokens: &[],
        });
        assert_eq!(
            normalized,
            "plan call me at toknum or mail tokemail see tokurl"
        );
        assert_eq!(
            strip_quoted_and_signature("hello\n> old\nOn Mon, Anna wrote:\nmore"),
            "hello"
        );
    }

    #[test]
    fn hashes_match_javascript() {
        // `simhash64('a b c')` and `fnv1a32` as the TypeScript computes them.
        assert_eq!(hamming_distance("0000000000000000", "000000000000000f"), 4);
        assert_eq!(hamming_distance("short", "000000000000000f"), 64);
        assert_eq!(simhash64(""), "0000000000000000");
        // Values the TypeScript `simhash64` returns for the same input.
        assert_eq!(simhash64("a b c"), "29699d6b7bc1bc7a");
        assert_eq!(simhash64("hello world this is"), "6060b8510012a8c0");
        assert_eq!(simhash64("héllo wörld 😀 x"), "2010951002418001");
        let a = fp(&copy("Anna", "Acme"), "anna@acme.com", "Anna de Vries");
        assert_eq!(a.fingerprint, "4af60179559eb53e");
        assert_eq!(a.words, 47);
        assert_eq!(
            a.normalized,
            "quick question hi tokname i noticed tokname is growing fast and wanted to reach out we help teams like yours cut their onboarding time in half with a simple tool would you be open to a quick call next week to see if it fits best tom"
        );
    }

    #[test]
    fn personal_tokens() {
        let tokens = personal_tokens_for(
            &[
                "anna.de.vries@acme.co.uk".to_owned(),
                "info@gmail.com".to_owned(),
            ],
            &["Anna de Vries".to_owned()],
        );
        assert_eq!(tokens, ["Anna", "de", "Vries", "anna", "vries", "acme"]);
    }
}
