//! Plain-text previews for notification bodies (`helpers/preview.ts`):
//! markdown markers taken out, whitespace folded, cut to a length.
//!
//! JavaScript's patterns there use lookarounds and a backreference, which
//! the `regex` crate does not have; those four (emphasis and strike) are
//! scanned by hand with the same leftmost, lazy, non-overlapping matches.

use std::sync::LazyLock;

use regex::Regex;

fn pattern(source: &str) -> Regex {
    Regex::new(source).expect("a valid pattern")
}

static CODE_SPAN: LazyLock<Regex> = LazyLock::new(|| pattern(r"`([^`\n]+)`"));
static LINK: LazyLock<Regex> = LazyLock::new(|| pattern(r"!?\[([^\[\]\n]*)\]\([^()\n]*\)"));
static AUTOLINK: LazyLock<Regex> = LazyLock::new(|| pattern(r"<(https?://[^>\s]+)>"));
static HEADING: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?m)^[ \t]{0,3}#{1,6}[ \t]+"));
static QUOTE: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?m)^[ \t]{0,3}>[ \t]?"));
static RULE: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?m)^[ \t]*(?:[-*_][ \t]*){3,}$"));
static LIST: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?m)^[ \t]*(?:[-*+]|[0-9]+[.)])[ \t]+"));
static WHITESPACE: LazyLock<Regex> = LazyLock::new(|| pattern(r"\s+"));

/// `stripCodeFences`: ```` ```lang\ncode``` ```` → `code`; an unclosed
/// fence stays as written.
fn strip_code_fences(text: &str) -> String {
    let parts: Vec<&str> = text.split("```").collect();
    let closed = if parts.len() % 2 == 1 {
        parts.len()
    } else {
        parts.len() - 1
    };
    let mut out = parts.first().copied().unwrap_or_default().to_owned();
    for (i, part) in parts.iter().enumerate().skip(1) {
        if i >= closed {
            out.push_str("```");
            out.push_str(part);
            continue;
        }
        match part.find('\n') {
            Some(newline) if i % 2 == 1 => out.push_str(&part[newline + 1..]),
            _ => out.push_str(part),
        }
    }
    out
}

/// JavaScript's `\w` (no `u` flag).
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `(MARK)(?=\S)([\s\S]*?\S)\1` → `$2` for each mark in `marks` (tried in
/// order at each position, as an alternation).
fn strip_paired(chars: &[char], marks: &[[char; 2]]) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut i = 0;
    'scan: while i < chars.len() {
        for mark in marks {
            if chars.get(i) != Some(&mark[0]) || chars.get(i + 1) != Some(&mark[1]) {
                continue;
            }
            if chars.get(i + 2).is_none_or(|c| c.is_whitespace()) {
                continue;
            }
            // The smallest end: a non-space last character, then the mark.
            let mut j = i + 3;
            while j + 1 < chars.len() {
                if chars[j] == mark[0] && chars[j + 1] == mark[1] && !chars[j - 1].is_whitespace() {
                    out.extend_from_slice(&chars[i + 2..j]);
                    i = j + 2;
                    continue 'scan;
                }
                j += 1;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `(^|[^\w<also>])M(?=\S)([^M\n]*?\S)M(?!\w)` → `$1$2`, for a single mark
/// `M` (`*` or `_`); `also` is a character the prefix may not be besides a
/// word character.
fn strip_single(chars: &[char], mark: char, also: Option<char>) -> Vec<char> {
    let prefix_ok = |c: char| !is_word(c) && Some(c) != also;
    // The span from a `mark` at `s`: the end of the closing mark, if it closes.
    let close = |s: usize| -> Option<usize> {
        if chars.get(s) != Some(&mark) || chars.get(s + 1).is_none_or(|c| c.is_whitespace()) {
            return None;
        }
        let mut k = s + 1;
        while k < chars.len() {
            let last_ok = !chars[k].is_whitespace();
            let closes =
                chars.get(k + 1) == Some(&mark) && !chars.get(k + 2).is_some_and(|c| is_word(*c));
            if last_ok && closes {
                return Some(k + 2);
            }
            if chars[k] == mark || chars[k] == '\n' {
                return None;
            }
            k += 1;
        }
        None
    };
    let mut out = Vec::with_capacity(chars.len());
    let mut p = 0;
    while p < chars.len() {
        // `^` (only at the start), then one prefix character.
        if p == 0
            && let Some(end) = close(0)
        {
            out.extend_from_slice(&chars[1..end - 1]);
            p = end;
            continue;
        }
        if prefix_ok(chars[p])
            && let Some(end) = close(p + 1)
        {
            out.push(chars[p]);
            out.extend_from_slice(&chars[p + 2..end - 1]);
            p = end;
            continue;
        }
        out.push(chars[p]);
        p += 1;
    }
    out
}

/// `stripMarkdown(text)`: emphasis, headings, list and quote markers, code
/// fences and spans, links (their label) and images (their alt text) taken
/// out; line breaks and `<@user>` tokens stay.
pub fn strip_markdown(text: &str) -> String {
    let text = strip_code_fences(text);
    let text = CODE_SPAN.replace_all(&text, "$1");
    let text = LINK.replace_all(&text, "$1");
    let text = AUTOLINK.replace_all(&text, "$1");
    let text = HEADING.replace_all(&text, "");
    let text = QUOTE.replace_all(&text, "");
    let text = RULE.replace_all(&text, "");
    let text = LIST.replace_all(&text, "");
    let chars: Vec<char> = text.chars().collect();
    let chars = strip_paired(&chars, &[['*', '*'], ['_', '_']]);
    let chars = strip_single(&chars, '*', Some('*'));
    let chars = strip_single(&chars, '_', None);
    let chars = strip_paired(&chars, &[['~', '~']]);
    chars.into_iter().collect()
}

/// `notificationPreview(text, max)`: one line of plain text, at most `max`
/// UTF-16 units, cut with `…`.
pub fn notification_preview(text: &str, max: usize) -> String {
    let stripped = strip_markdown(text);
    let folded = WHITESPACE.replace_all(&stripped, " ");
    let clean = folded.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if clean.encode_utf16().count() <= max {
        return clean.to_owned();
    }
    let mut out = String::new();
    let mut units = 0;
    for c in clean.chars() {
        let width = c.len_utf16();
        if units + width > max - 1 {
            break;
        }
        units += width;
        out.push(c);
    }
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_go_and_words_stay() {
        assert_eq!(
            notification_preview("Why did **visitors** drop?", 180),
            "Why did visitors drop?"
        );
        assert_eq!(
            strip_markdown("## Notes\n- *one* and _two_"),
            "Notes\none and two"
        );
        assert_eq!(
            strip_markdown("keep snake_case_names"),
            "keep snake_case_names"
        );
        assert_eq!(strip_markdown("[label](https://x.y) ~~old~~"), "label old");
        assert_eq!(strip_markdown("```js\ncode```"), "code");
        assert_eq!(notification_preview(&"a".repeat(200), 10), "aaaaaaaaa…");
    }
}
