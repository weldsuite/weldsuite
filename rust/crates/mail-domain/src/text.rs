//! Text helpers for outbound mail (`@weldsuite/mail-domain/text`): the
//! text/plain alternative, the list preview and the quoted headers of a
//! forward. Same patterns as the TypeScript, with JavaScript's semantics
//! where they differ (`\b` and `\d` are ASCII there; `[^>]` crosses lines).

use std::sync::LazyLock;

use regex::{Captures, Regex};

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|error| panic!("bad pattern {pattern}: {error}"))
}

const B: &str = r"(?-u:\b)";

static BLOCK_BREAK: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)</(?:p|div|h[1-6]|li|tr|blockquote|pre|table|ul|ol)\s*>"));
static LINE_BREAK: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)<br\s*/?>"));
static LIST_ITEM: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"(?i)<li{B}[^>]*>")));
/// `<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>`, one per tag (no
/// backreferences here).
static DROPPED_BLOCKS: LazyLock<[Regex; 4]> = LazyLock::new(|| {
    ["style", "script", "head", "title"]
        .map(|tag| re(&format!(r"(?is)<{tag}{B}[^>]*>.*?</{tag}\s*>")))
});
static OPENING_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"(?i)([^\n>])<(?:div|p){B}[^>]*>")));
static ANY_TAG: LazyLock<Regex> = LazyLock::new(|| re(r"<[^>]+>"));
static HTML_TAG: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"(?i)</?(?:div|p|br|span|b|i|u|s|strong|em|ul|ol|li|a|h[1-6]|table|tbody|tr|td|th|blockquote|img|font|pre|code|hr|html|body){B}[^>]*>"
    ))
});
static ENTITY: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)&(#x[0-9a-f]+|#[0-9]+|[a-z]+);"));
static TRAILING_SPACE: LazyLock<Regex> = LazyLock::new(|| re(r"[ \t]+\n"));
static BLANK_LINES: LazyLock<Regex> = LazyLock::new(|| re(r"\n{3,}"));

/// The earliest match of any of `patterns`, removed, until none is left:
/// what one `replace` of an alternation with a backreference does.
fn drop_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let next = DROPPED_BLOCKS
            .iter()
            .filter_map(|pattern| pattern.find(rest))
            .min_by_key(|found| (found.start(), std::cmp::Reverse(found.end())));
        if let Some(found) = next {
            out.push_str(&rest[..found.start()]);
            rest = &rest[found.end()..];
        } else {
            out.push_str(rest);
            return out;
        }
    }
}

fn named_entity(name: &str) -> Option<&'static str> {
    Some(match name.to_lowercase().as_str() {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        _ => return None,
    })
}

fn decode_entities(text: &str) -> String {
    ENTITY
        .replace_all(text, |caps: &Captures<'_>| {
            let whole = caps[0].to_owned();
            let entity = &caps[1];
            if let Some(number) = entity.strip_prefix('#') {
                let code = match number.strip_prefix(['x', 'X']) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => number.parse::<u32>().ok(),
                };
                return code
                    .filter(|code| *code > 0 && *code <= 0x0010_ffff)
                    .and_then(char::from_u32)
                    .map_or(whole, String::from);
            }
            named_entity(entity).map_or(whole, str::to_owned)
        })
        .into_owned()
}

/// `looksLikeHtml(text)`: a tag an editor or mail client emits.
pub fn looks_like_html(text: &str) -> bool {
    HTML_TAG.is_match(text)
}

/// `htmlToText(html)`: block ends become line breaks, tags go, entities are
/// decoded.
pub fn html_to_text(html: &str) -> String {
    let text = drop_blocks(html);
    let text = LINE_BREAK.replace_all(&text, "\n");
    let text = LIST_ITEM.replace_all(&text, "- ");
    let text = BLOCK_BREAK.replace_all(&text, "\n");
    let text = OPENING_BLOCK.replace_all(&text, "$1\n");
    let text = ANY_TAG.replace_all(&text, "");
    let text = decode_entities(&text);
    let text = TRAILING_SPACE.replace_all(&text, "\n");
    let text = BLANK_LINES.replace_all(&text, "\n\n");
    js_trim(&text).to_owned()
}

/// JavaScript's `String.prototype.trim` (Unicode white space and line
/// terminators, BOM included).
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `plainTextBody(body, htmlBody)`: the text/plain body to send and store.
pub fn plain_text_body(body: Option<&str>, html_body: Option<&str>) -> Option<String> {
    if let Some(body) = body.filter(|body| !js_trim(body).is_empty()) {
        let declared_plain = html_body.is_some_and(|html| {
            let html = js_trim(html);
            !html.is_empty() && html != js_trim(body)
        });
        if declared_plain {
            return Some(body.to_owned());
        }
        return Some(if looks_like_html(body) {
            html_to_text(body)
        } else {
            body.to_owned()
        });
    }
    if let Some(html) = html_body.filter(|html| !html.is_empty()) {
        let text = html_to_text(html);
        return (!text.is_empty()).then_some(text);
    }
    body.map(str::to_owned)
}

/// `escapeHtml(text)`.
pub fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// The first `units` UTF-16 code units of `text` (`text.slice(0, units)`),
/// never splitting a character.
pub fn utf16_prefix(text: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, ch) in text.char_indices() {
        count += ch.len_utf16();
        if count > units {
            return &text[..index];
        }
    }
    text
}

/// `text.length` in JavaScript (UTF-16 code units).
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_becomes_readable_text() {
        assert_eq!(
            html_to_text("<p>Hello <b>Anna</b></p><p>Second&nbsp;line &amp; more</p>"),
            "Hello Anna\nSecond line & more"
        );
        assert_eq!(
            html_to_text("first line<div>second line</div>"),
            "first line\nsecond line"
        );
        assert_eq!(
            html_to_text("<style>p{color:red}</style><ul><li>one</li><li>two</li></ul>"),
            "- one\n- two"
        );
        assert_eq!(html_to_text("a<br>b<br/>c &#x41;&#66;"), "a\nb\nc AB");
    }

    #[test]
    fn plain_text_rules() {
        assert_eq!(
            plain_text_body(Some("<p>Hi</p>"), None).as_deref(),
            Some("Hi")
        );
        assert_eq!(
            plain_text_body(Some("a < b <strong>"), Some("<p>other</p>")).as_deref(),
            Some("a < b <strong>")
        );
        assert_eq!(
            plain_text_body(Some("<p>Hi</p>"), Some("<p>Hi</p>")).as_deref(),
            Some("Hi")
        );
        assert_eq!(
            plain_text_body(None, Some("<p>Only html</p>")).as_deref(),
            Some("Only html")
        );
        assert_eq!(plain_text_body(Some("  "), None).as_deref(), Some("  "));
        assert!(looks_like_html("x <div class=a>"));
        assert!(!looks_like_html("a < b and <3"));
    }

    #[test]
    fn utf16_slicing() {
        assert_eq!(utf16_prefix("héllo", 2), "hé");
        assert_eq!(utf16_prefix("a😀b", 2), "a");
        assert_eq!(utf16_len("a😀b"), 4);
    }
}
