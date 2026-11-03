//! postal-mime's `text-format.js`: the HTML ↔ text conversions it falls
//! back on when a message has only one of the two, and the header block it
//! prints for an inline forwarded message.

use std::fmt::Write as _;
use std::sync::LazyLock;

use regex::Regex;

use super::Email;
use super::address::MailAddress;
use super::decode::js_trim;
use super::entities::ENTITIES;

/// JavaScript's `\s` as a regex class body.
const JS_S: &str = r"\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";
/// JavaScript's `.` (no line terminator) as a regex class.
const JS_DOT: &str = r"[^\n\r\u{2028}\u{2029}]";

fn re(pattern: &str) -> Regex {
    let pattern = pattern
        .replace("{S}", JS_S)
        .replace("{DOT}", JS_DOT)
        .replace("\\b", "(?-u:\\b)");
    Regex::new(&pattern).expect("a valid pattern")
}

/// `decodeHTMLEntities(str)`.
pub(crate) fn decode_html_entities(text: &str) -> String {
    static ENTITY: LazyLock<Regex> =
        LazyLock::new(|| re(r"(?i)&(#[0-9]+|#x[a-f0-9]+|[a-z]+[0-9]*);?"));
    ENTITY
        .replace_all(text, |caps: &regex::Captures<'_>| {
            let whole = &caps[0];
            if let Ok(index) = ENTITIES.binary_search_by(|(name, _)| (*name).cmp(whole)) {
                return ENTITIES[index].1.to_owned();
            }
            let entity = &caps[1];
            if !entity.starts_with('#') || !whole.ends_with(';') {
                return whole.to_owned();
            }
            // `entity.charAt(1) === 'x'` is case-sensitive: `#X1F` is read
            // as a decimal, which parses as NaN, which is U+0000.
            let code = if let Some(hex) = entity.strip_prefix("#x") {
                u64::from_str_radix(hex, 16).ok()
            } else if entity[1..].bytes().all(|b| b.is_ascii_digit()) {
                entity[1..].parse::<u64>().ok().or(Some(u64::MAX))
            } else {
                Some(0)
            };
            let code = code.unwrap_or(u64::MAX);
            if (0xd800..=0xdfff).contains(&code) || code > 0x10_ffff {
                return "\u{fffd}".to_owned();
            }
            u32::try_from(code)
                .ok()
                .and_then(char::from_u32)
                .map_or_else(|| "\u{fffd}".to_owned(), |c| c.to_string())
        })
        .into_owned()
}

/// `escapeHtml(str)`.
pub(crate) fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in js_trim(text).chars() {
        if matches!(c, '<' | '>' | '"' | '\'' | '?' | '&') {
            let _ = write!(out, "&#x{:02X};", u32::from(c));
        } else {
            out.push(c);
        }
    }
    out
}

/// `textToHtml(str)`.
pub(crate) fn text_to_html(text: &str) -> String {
    format!("<div>{}</div>", escape_html(text).replace('\n', "<br />"))
}

/// `htmlToText(str)`.
pub(crate) fn html_to_text(html: &str) -> String {
    static STEPS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
        vec![
            (re(r"\r?\n"), "\u{1}"),
            (re(r"(?i)<!--{DOT}*?-->"), " "),
            (re(r"(?i)<br\b[^>]*>"), "\n"),
            (re(r"(?i)</?(p|div|table|tr|td|th)\b[^>]*>"), "\n\n"),
            (re(r"(?i)<script\b[^>]*>{DOT}*?</script\b[^>]*>"), " "),
        ]
    });
    static FIRST: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        vec![
            re(r"(?i)^{DOT}*<body\b[^>]*>"),
            re(r"(?i)^{DOT}*</head\b[^>]*>"),
            re(r"(?i)^{DOT}*<!doctype\b[^>]*>"),
            re(r"(?i)</body\b[^>]*>{DOT}*$"),
            re(r"(?i)</html\b[^>]*>{DOT}*$"),
        ]
    });
    static LINK: LazyLock<Regex> =
        LazyLock::new(|| re(r#"(?i)<a\b[^>]*href[{S}]*=[{S}]*["']?([^{S}"']+)[^>]*>"#));
    static REST: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
        vec![
            (re(r"(?i)</?(span|em|i|strong|b|u|a)\b[^>]*>"), ""),
            (re(r"(?i)<li\b[^>]*>[\n\u{1}{S}]*"), "* "),
            (re(r"<hr\b[^>]*>"), "\n-------------\n"),
            (re(r"<[^>]*>"), " "),
            (re(r"\u{1}"), "\n"),
            (re(r"[ \t]+"), " "),
            (re(r"(?m)^[{S}]+$"), ""),
            (re(r"\n\n+"), "\n\n"),
        ]
    });
    static EDGES: LazyLock<(Regex, Regex)> = LazyLock::new(|| (re(r"^\n+"), re(r"\n+$")));

    let mut text = html.to_owned();
    for (pattern, replacement) in STEPS.iter() {
        text = pattern.replace_all(&text, *replacement).into_owned();
    }
    for pattern in FIRST.iter() {
        text = pattern.replace(&text, "").into_owned();
    }
    text = LINK.replace_all(&text, " ($1) ").into_owned();
    for (pattern, replacement) in REST.iter() {
        text = pattern
            .replace_all(&text, regex::NoExpand(replacement))
            .into_owned();
    }
    text = EDGES.0.replace(&text, "\n").into_owned();
    text = EDGES.1.replace(&text, "\n").into_owned();
    decode_html_entities(&text)
}

fn format_text_address(address: &MailAddress) -> String {
    let target = address.address.clone().unwrap_or_default();
    if address.name.is_empty() {
        target
    } else {
        format!("{} <{target}>", address.name)
    }
}

fn format_text_addresses(addresses: &[MailAddress]) -> String {
    fn walk(address: &MailAddress, counter: usize, parts: &mut Vec<String>) {
        if counter > 0 {
            parts.push(", ".to_owned());
        }
        if let Some(group) = &address.group {
            parts.push(format!("{}:", address.name));
            for (i, member) in group.iter().enumerate() {
                walk(member, i, parts);
            }
            parts.push(";".to_owned());
        } else {
            parts.push(format_text_address(address));
        }
    }
    let mut parts = Vec::new();
    for (i, address) in addresses.iter().enumerate() {
        walk(address, i, &mut parts);
    }
    parts.concat()
}

fn format_html_address(address: &MailAddress) -> String {
    let target = address.address.clone().unwrap_or_default();
    let label = if address.name.is_empty() {
        format!("<{target}>")
    } else {
        address.name.clone()
    };
    format!(
        "<a href=\"mailto:{}\" class=\"postal-email-address\">{}</a>",
        escape_html(&target),
        escape_html(&label)
    )
}

fn format_html_addresses(addresses: &[MailAddress]) -> String {
    fn walk(address: &MailAddress, counter: usize, parts: &mut Vec<String>) {
        if counter > 0 {
            parts.push("<span class=\"postal-email-address-separator\">, </span>".to_owned());
        }
        if let Some(group) = &address.group {
            parts.push(format!(
                "<span class=\"postal-email-address-group\">{}:</span>",
                escape_html(&address.name)
            ));
            for (i, member) in group.iter().enumerate() {
                walk(member, i, parts);
            }
            parts.push("<span class=\"postal-email-address-group\">;</span>".to_owned());
        } else {
            parts.push(format_html_address(address));
        }
    }
    let mut parts = Vec::new();
    for (i, address) in addresses.iter().enumerate() {
        walk(address, i, &mut parts);
    }
    parts.join(" ")
}

/// `foldLines(str, lineLength, afterSpace)` on characters.
fn fold_lines(text: &str, line_length: usize, after_space: bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut pos = 0;
    let mut result = String::new();
    while pos < len {
        let end = (pos + line_length).min(len);
        let mut line: Vec<char> = chars[pos..end].to_vec();
        if line.len() < line_length {
            result.extend(line);
            break;
        }
        // `/^[^\n\r]*(\r?\n|\r)/`
        if let Some(nl) = line.iter().position(|c| *c == '\n' || *c == '\r') {
            let mut cut = nl + 1;
            if line[nl] == '\r' && line.get(nl + 1) == Some(&'\n') {
                cut += 1;
            }
            result.extend(&line[..cut]);
            pos += cut;
            continue;
        }
        // `/(\s+)[^\s]*$/`
        let is_space = |c: &char| super::decode::is_js_space(*c);
        let tail_word = line.iter().rev().take_while(|c| !is_space(c)).count();
        let spaces = line[..line.len() - tail_word]
            .iter()
            .rev()
            .take_while(|c| is_space(c))
            .count();
        let whole = spaces + tail_word;
        let cut = whole - if after_space { spaces } else { 0 };
        if spaces > 0 && cut < line.len() {
            line.truncate(line.len() - cut);
        } else {
            // `/^[^\s]+(\s*)/` on what follows.
            let rest = &chars[pos + line.len()..];
            let word = rest.iter().take_while(|c| !is_space(c)).count();
            if word > 0 {
                let trailing = rest[word..].iter().take_while(|c| is_space(c)).count();
                let take = word + trailing - if after_space { 0 } else { trailing };
                line.extend(&rest[..take]);
            }
        }
        pos += line.len();
        result.extend(line);
        if pos < len {
            result.push_str("\r\n");
        }
    }
    result
}

/// `new Intl.DateTimeFormat('default', { …numeric, hour12: false })` in
/// UTC with the `en-US` locale, as a worker formats it.
fn format_date(iso: &str) -> String {
    let Ok(date) = time::OffsetDateTime::parse(iso, &time::format_description::well_known::Rfc3339)
    else {
        return iso.to_owned();
    };
    format!(
        "{}/{}/{}, {:02}:{:02}:{:02}",
        u8::from(date.month()),
        date.day(),
        date.year(),
        date.hour(),
        date.minute(),
        date.second()
    )
}

/// `formatTextHeader(message)`.
pub(crate) fn format_text_header(message: &Email) -> String {
    let mut rows: Vec<(&str, String)> = Vec::new();
    if let Some(from) = &message.from {
        rows.push(("From", format_text_address(from)));
    }
    if let Some(subject) = message.subject.as_deref().filter(|s| !s.is_empty()) {
        rows.push(("Subject", subject.to_owned()));
    }
    if let Some(date) = message.date.as_ref().filter(|d| !d.is_empty()) {
        rows.push(("Date", format_date(date)));
    }
    for (key, list) in [
        ("To", &message.to),
        ("Cc", &message.cc),
        ("Bcc", &message.bcc),
    ] {
        if !list.is_empty() {
            rows.push((key, format_text_addresses(list)));
        }
    }
    let max_key = rows.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
    let mut lines = Vec::new();
    for (key, value) in &rows {
        let sep = max_key - key.len();
        let prefix = format!("{key}: {}", " ".repeat(sep));
        let empty = format!("{} {}", " ".repeat(key.len() + 1), " ".repeat(sep));
        let folded = fold_lines(value, 80, true);
        for (i, line) in folded
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .enumerate()
        {
            let line = js_trim(line);
            lines.push(format!("{}{line}", if i > 0 { &empty } else { &prefix }));
        }
    }
    let max_line = lines
        .iter()
        .map(|l| l.encode_utf16().count())
        .max()
        .unwrap_or(0);
    let marker = "-".repeat(max_line);
    format!("\n{marker}\n{}\n{marker}\n", lines.join("\n"))
}

/// `formatHtmlHeader(message)`.
pub(crate) fn format_html_header(message: &Email) -> String {
    let mut rows = Vec::new();
    if let Some(from) = &message.from {
        rows.push(format!(
            "<div class=\"postal-email-header-key\">From</div><div class=\"postal-email-header-value\">{}</div>",
            format_html_address(from)
        ));
    }
    if let Some(subject) = message.subject.as_deref().filter(|s| !s.is_empty()) {
        rows.push(format!(
            "<div class=\"postal-email-header-key\">Subject</div><div class=\"postal-email-header-value postal-email-header-subject\">{}</div>",
            escape_html(subject)
        ));
    }
    if let Some(date) = message.date.as_ref().filter(|d| !d.is_empty()) {
        rows.push(format!(
            "<div class=\"postal-email-header-key\">Date</div><div class=\"postal-email-header-value postal-email-header-date\" data-date=\"{}\">{}</div>",
            escape_html(date),
            escape_html(&format_date(date))
        ));
    }
    for (key, list) in [
        ("To", &message.to),
        ("Cc", &message.cc),
        ("Bcc", &message.bcc),
    ] {
        if !list.is_empty() {
            rows.push(format!(
                "<div class=\"postal-email-header-key\">{key}</div><div class=\"postal-email-header-value\">{}</div>",
                format_html_addresses(list)
            ));
        }
    }
    if rows.is_empty() {
        return "<div class=\"postal-email-header\"></div>".to_owned();
    }
    format!(
        "<div class=\"postal-email-header\"><div class=\"postal-email-header-row\">{}</div></div>",
        rows.join("</div>\n<div class=\"postal-email-header-row\">")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities() {
        assert_eq!(
            decode_html_entities("a &amp; b &lt;c&gt; &#233; &#x1F600; &nope;"),
            "a & b <c> é 😀 &nope;"
        );
        assert_eq!(decode_html_entities("&amp"), "&");
    }

    #[test]
    fn html_to_text_like_postal_mime() {
        assert_eq!(
            html_to_text(
                "<html><body><p>Hello <b>you</b></p><a href=\"https://x.test\">link</a></body></html>"
            ),
            "\nHello you\n\n (https://x.test) link"
        );
    }

    #[test]
    fn text_to_html_escapes() {
        assert_eq!(text_to_html(" a<b\nc "), "<div>a&#x3C;b<br />c</div>");
    }
}
