//! Reply text (`inbound/text.ts`, `inbound/strings.ts`): HTML to text,
//! cutting the quoted conversation off a reply, subjects and snippets, all
//! in linear scans as the TypeScript does, plus the JavaScript string
//! semantics they rely on (`trim`, `\s`).

use std::sync::LazyLock;

use regex::Regex;

/// A character JavaScript's `\s` and `trim()` treat as white space.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{0B}'
            | '\u{0C}'
            | '\r'
            | ' '
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `str.trim()`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `str.trimEnd()`.
pub fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_space)
}

/// `str.trimStart()`.
pub fn js_trim_start(text: &str) -> &str {
    text.trim_start_matches(is_js_space)
}

/// `str.replace(/\s+/g, ' ')`.
pub fn collapse_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `trimEdges(value, chars)`.
pub fn trim_edges<'a>(value: &'a str, chars: &str) -> &'a str {
    value.trim_matches(|c| chars.contains(c))
}

/// `trimEnd(value, chars)`.
pub fn trim_end_chars<'a>(value: &'a str, chars: &str) -> &'a str {
    value.trim_end_matches(|c| chars.contains(c))
}

const NAMED_ENTITIES: &[(&str, &str)] = &[
    ("nbsp", " "),
    ("amp", "&"),
    ("lt", "<"),
    ("gt", ">"),
    ("quot", "\""),
    ("apos", "'"),
    ("ndash", "-"),
    ("mdash", "-"),
    ("hellip", "..."),
    ("rsquo", "'"),
    ("lsquo", "'"),
    ("rdquo", "\""),
    ("ldquo", "\""),
    ("euro", "EUR"),
];

static ENTITY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});").expect("entity pattern")
});

fn decode_entities(input: &str) -> String {
    ENTITY_RE
        .replace_all(input, |caps: &regex::Captures<'_>| {
            let lower = caps[1].to_lowercase();
            if let Some(number) = lower.strip_prefix('#') {
                let code = match number.strip_prefix('x') {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => number.parse::<u32>().ok(),
                };
                return match code.filter(|c| *c > 0 && *c < 0x11_0000).and_then(char::from_u32) {
                    Some(c) => c.to_string(),
                    None => caps[0].to_owned(),
                };
            }
            NAMED_ENTITIES
                .iter()
                .find(|(name, _)| *name == lower)
                .map_or_else(|| caps[0].to_owned(), |(_, value)| (*value).to_owned())
        })
        .into_owned()
}

const HTML_QUOTE_MARKERS: &[&str] = &[
    "class=\"gmail_quote",
    "class='gmail_quote",
    "class=\"gmail_attr",
    "id=\"divrplyfwdmsg\"",
    "id=\"appendonsend\"",
    "<blockquote",
];

/// Drop `<...>` tags; a `<` that never closes is kept.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut index = 0;
    while index < html.len() {
        let Some(open) = html[index..].find('<').map(|i| i + index) else {
            out.push_str(&html[index..]);
            break;
        };
        let Some(close) = html[open + 1..].find('>').map(|i| i + open + 1) else {
            out.push_str(&html[index..]);
            break;
        };
        out.push_str(&html[index..open]);
        index = close + 1;
    }
    out
}

/// ASCII lower-casing that keeps byte offsets (what the scans index by).
fn ascii_lower(text: &str) -> String {
    text.to_ascii_lowercase()
}

fn remove_blocks(html: &str, name: &str) -> String {
    let lower = ascii_lower(html);
    let mut out = String::new();
    let mut index = 0;
    let mut search = 0;
    let open_tag = format!("<{name}");
    let close_tag = format!("</{name}>");
    loop {
        let Some(open) = lower[search..].find(&open_tag).map(|i| i + search) else {
            out.push_str(&html[index..]);
            return out;
        };
        let next = lower[open + name.len() + 1..].chars().next();
        if let Some(next) = next
            && next != '>'
            && next != '/'
            && !is_js_space(next)
        {
            search = open + 1;
            continue;
        }
        let close = lower[open..].find(&close_tag).map(|i| i + open);
        out.push_str(&html[index..open]);
        let Some(close) = close else {
            return out;
        };
        index = close + name.len() + 3;
        search = index;
    }
}

static BR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<br\s{0,4}/?>").expect("br"));
static BLOCK_END_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</(p|div|li|tr|h[1-6]|table|ul|ol)>").expect("block end"));
static SPACES_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new("[ \t\u{A0}]+").expect("spaces"));
static NEWLINE_SPACE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(" ?\n ?").expect("newline"));
static BLANKS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new("\n{3,}").expect("blanks"));

/// `htmlToText(html)`: plain text of an HTML body, without the quoted conversation.
pub fn html_to_text(html: &str) -> String {
    let lower = ascii_lower(html);
    let body_start = lower.find("<body");
    let body_end = body_start.and_then(|start| lower[start..].find('>').map(|i| i + start));
    let mut body: String = match body_end {
        Some(end) => html[end + 1..].to_owned(),
        None => html.to_owned(),
    };
    let body_lower = ascii_lower(&body);
    let cut = HTML_QUOTE_MARKERS
        .iter()
        .map(|marker| body_lower.find(marker).unwrap_or(body.len()))
        .min()
        .unwrap_or(body.len());
    // `lastIndexOf('<', cut)` looks at `cut` itself too (`<blockquote`).
    let tag_start = if cut < body.len() {
        body[..=cut].rfind('<')
    } else {
        Some(cut)
    };
    body.truncate(tag_start.unwrap_or(cut));
    for name in ["head", "style", "script"] {
        body = remove_blocks(&body, name);
    }
    let with_breaks = BR_RE.replace_all(&body, "\n");
    let with_breaks = BLOCK_END_RE.replace_all(&with_breaks, "\n");
    let text = decode_entities(&strip_tags(&with_breaks));
    let text = SPACES_RE.replace_all(&text, " ");
    let text = NEWLINE_SPACE_RE.replace_all(&text, "\n");
    let text = BLANKS_RE.replace_all(&text, "\n\n");
    js_trim(&text).to_owned()
}

const ATTRIBUTION_STARTS: &[&str] = &["on ", "op ", "am ", "le ", "el ", "il "];
const ATTRIBUTION_VERBS: &[&str] = &["wrote", "a écrit", "a ecrit", "escribió", "escribio", "ha scritto"];
const ATTRIBUTION_MID_VERBS: &[&str] = &[" schreef ", " schrieb "];
const SEPARATOR_PHRASES: &[&str] = &[
    "original message",
    "oorspronkelijk bericht",
    "ursprüngliche nachricht",
    "ursprungliche nachricht",
    "message d'origine",
    "mensaje original",
    "forwarded message",
    "doorgestuurd bericht",
    "weitergeleitete nachricht",
];
const HEADER_START_KEYS: &[&str] = &["from", "van", "von", "de", "da"];
const HEADER_FOLLOW_KEYS: &[&str] = &[
    "sent", "verzonden", "gesendet", "date", "datum", "envoyé", "envoye", "enviado", "inviato", "to", "aan", "an",
    "subject", "onderwerp", "betreff", "objet", "cc",
];
const TRAILING_NOISE_PREFIXES: &[&str] = &[
    "sent from my ",
    "sent from outlook",
    "sent from mail",
    "sent from yahoo mail",
    "sent from gmail",
    "get outlook for ",
    "verzonden vanaf mijn ",
    "verzonden vanuit ",
    "envoyé de mon ",
    "envoye de mon ",
];

/// The UTF-16 index of `needle` in `text` (`indexOf`), for the length rules.
fn utf16_index(text: &str, byte_index: usize) -> usize {
    crate::js_len(&text[..byte_index])
}

fn header_key(line: &str) -> Option<String> {
    let colon = line.find(':')?;
    let colon16 = utf16_index(line, colon);
    if colon16 == 0 || colon16 > 20 {
        return None;
    }
    let key = js_trim(&line[..colon]).to_lowercase();
    (!key.contains(' ')).then_some(key)
}

fn ends_with_attribution(text: &str) -> bool {
    let lower = text.to_lowercase();
    let lower = js_trim_end(&lower);
    let without_colon = match lower.strip_suffix(':') {
        Some(rest) => rest.trim_end_matches(' '),
        None => lower,
    };
    if ATTRIBUTION_VERBS.iter().any(|verb| without_colon.ends_with(verb)) {
        return true;
    }
    lower.ends_with(':') && ATTRIBUTION_MID_VERBS.iter().any(|verb| lower.contains(verb))
}

fn starts_attribution_line(lines: &[&str], index: usize) -> bool {
    let first = js_trim(lines[index]);
    let lower = first.to_lowercase();
    if crate::js_len(first) < 8 || !ATTRIBUTION_STARTS.iter().any(|start| lower.starts_with(start)) {
        return false;
    }
    let mut joined = first.to_owned();
    for extra in 0..4 {
        if ends_with_attribution(&joined) {
            return true;
        }
        let Some(next) = lines.get(index + 1 + extra) else {
            return false;
        };
        joined = format!("{joined} {}", js_trim(next));
        if crate::js_len(&joined) > 400 {
            return false;
        }
    }
    false
}

fn starts_header_block(lines: &[&str], index: usize) -> bool {
    let start = js_trim(lines[index]);
    let Some(key) = header_key(start) else {
        return false;
    };
    let colon = start.find(':').unwrap_or_default();
    if !HEADER_START_KEYS.contains(&key.as_str()) || js_trim(&start[colon + 1..]).is_empty() {
        return false;
    }
    let mut follow = 0;
    let mut i = index + 1;
    while i <= index + 6 && i < lines.len() {
        if let Some(key) = header_key(js_trim(lines[i]))
            && HEADER_FOLLOW_KEYS.contains(&key.as_str())
        {
            follow += 1;
        }
        i += 1;
    }
    follow >= 2
}

/// `isQuoteSeparator(line)`.
pub fn is_quote_separator(line: &str) -> bool {
    if crate::js_len(line) >= 8 && trim_edges(line, "_").is_empty() {
        return true;
    }
    if !line.starts_with("--") || !line.ends_with("--") {
        return false;
    }
    SEPARATOR_PHRASES.contains(&trim_edges(line, "- \t").to_lowercase().as_str())
}

fn is_trailing_noise(line: &str) -> bool {
    let lower = js_trim(line).to_lowercase();
    if lower.is_empty() {
        return true;
    }
    if lower.starts_with("von meinem ") && lower.contains(" gesendet") {
        return true;
    }
    TRAILING_NOISE_PREFIXES.iter().any(|prefix| lower.starts_with(prefix))
}

fn quote_start(lines: &[&str]) -> usize {
    for i in 0..lines.len() {
        if lines[i] == "-- " {
            return i;
        }
        if starts_attribution_line(lines, i) || starts_header_block(lines, i) || is_quote_separator(js_trim(lines[i])) {
            return i;
        }
    }
    lines.len()
}

/// `stripQuotedHistory(text)`: the reply's own text.
pub fn strip_quoted_history(text: &str) -> String {
    let normalised = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalised.split('\n').collect();
    let mut kept: Vec<&str> = lines[..quote_start(&lines)]
        .iter()
        .copied()
        .filter(|line| !js_trim_start(line).starts_with('>'))
        .collect();
    while kept.last().is_some_and(|line| is_trailing_noise(line)) {
        kept.pop();
    }
    js_trim(&kept.join("\n")).to_owned()
}

/// `makeSnippet(text, 500)`.
pub fn make_snippet(text: &str, max: usize) -> String {
    crate::js_slice(js_trim(&collapse_spaces(text)), max)
}

const SUBJECT_PREFIXES: &[&str] = &[
    "re", "aw", "antw", "antwoord", "sv", "vs", "wg", "fw", "fwd", "doorgestuurd", "ref", "tr",
];

fn without_prefix(subject: &str) -> Option<&str> {
    let colon = subject.find(':')?;
    let colon16 = utf16_index(subject, colon);
    if colon16 == 0 || colon16 > 20 {
        return None;
    }
    let bracket = subject.find('[');
    let prefix = match bracket {
        Some(b) if b > 0 && b < colon => &subject[..b],
        _ => &subject[..colon],
    };
    SUBJECT_PREFIXES
        .contains(&js_trim(prefix).to_lowercase().as_str())
        .then(|| &subject[colon + 1..])
}

/// `normalizeSubject(subject)`.
pub fn normalize_subject(subject: &str) -> String {
    let mut out = js_trim(subject).to_owned();
    for _ in 0..10 {
        match without_prefix(&out) {
            Some(next) => out = js_trim(next).to_owned(),
            None => break,
        }
    }
    out
}

/// `replySubject(subject)` of the inbox (`inbound/text.ts`).
pub fn reply_subject(subject: Option<&str>) -> String {
    let base = normalize_subject(subject.unwrap_or_default());
    if base.is_empty() {
        "Re:".to_owned()
    } else {
        format!("Re: {base}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_history_is_cut() {
        let text = "Thanks, sounds good.\n\nOn Mon, 12 Oct 2026 at 09:14, Sam <sam@x.com> wrote:\n> earlier";
        assert_eq!(strip_quoted_history(text), "Thanks, sounds good.");
        assert_eq!(
            strip_quoted_history("Yes\n-----Original Message-----\nFrom: a"),
            "Yes"
        );
        assert_eq!(strip_quoted_history("Hi\n\nSent from my iPhone"), "Hi");
    }

    #[test]
    fn html_becomes_text() {
        let html = "<html><body><p>Hello&nbsp;there</p><div>Second<br/>line</div><div class=\"gmail_quote\">old</div></body></html>";
        assert_eq!(html_to_text(html), "Hello there\nSecond\nline");
    }

    #[test]
    fn subjects() {
        assert_eq!(reply_subject(Some("RE: Fwd: Hello")), "Re: Hello");
        assert_eq!(reply_subject(None), "Re:");
        assert_eq!(normalize_subject("Re[2]: x"), "x");
    }
}
