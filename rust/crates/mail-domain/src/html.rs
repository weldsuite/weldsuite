//! `sanitizeEmailHtml` (`@weldsuite/email/sanitize`): the email-HTML
//! allowlist every outbound (and stored) body goes through, with the
//! TypeScript's parser and serializer semantics, so both backends store and
//! send the same markup:
//!
//! - parsing as `htmlparser2` does in HTML mode: lower-cased names, the first
//!   of duplicate attributes, implied closes (`<p>` before a block, `<li>`
//!   before `<li>`), `</p>` without an open `p` as an empty `<p></p>`, raw
//!   text in `script`, `style`, `textarea`, `title`, entities decoded in text
//!   and attribute values;
//! - serializing as `dom-serializer` does: `encodeXML` for text and
//!   attribute values (`&`, `<`, `>`, `"`, `'`, `$` and every non-ASCII
//!   character as an entity), an empty attribute as its bare name, void
//!   elements without a closing tag.
//!
//! The entity table covers the named entities mail clients write (and the
//! legacy ones that need no `;`); an unknown name stays literal text.

use std::fmt::Write as _;
use std::sync::LazyLock;

use regex::Regex;

const ALLOWED_TAGS: [&str; 64] = [
    "html",
    "body",
    "a",
    "abbr",
    "address",
    "area",
    "b",
    "bdi",
    "bdo",
    "blockquote",
    "br",
    "caption",
    "center",
    "cite",
    "code",
    "col",
    "colgroup",
    "dd",
    "del",
    "details",
    "dfn",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "font",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "ins",
    "kbd",
    "label",
    "legend",
    "li",
    "map",
    "mark",
    "ol",
    "p",
    "pre",
    "q",
    "s",
    "samp",
    "small",
    "span",
    "strike",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "time",
];
const ALLOWED_TAGS_MORE: [&str; 5] = ["tr", "u", "ul", "var", "wbr"];

const DROP_WITH_CONTENT: [&str; 18] = [
    "script", "style", "iframe", "object", "embed", "applet", "noscript", "svg", "math", "head",
    "title", "frame", "frameset", "template", "link", "meta", "base", "xml",
];

const URL_ATTRS: [&str; 9] = [
    "href",
    "src",
    "action",
    "formaction",
    "xlink:href",
    "background",
    "poster",
    "cite",
    "longdesc",
];

const VOID_ELEMENTS: [&str; 19] = [
    "area", "base", "basefont", "br", "col", "command", "embed", "frame", "hr", "img", "input",
    "isindex", "keygen", "link", "meta", "param", "source", "track", "wbr",
];

const RAW_TEXT: [&str; 4] = ["script", "style", "textarea", "title"];

const FORM_TAGS: &[&str] = &[
    "input", "option", "optgroup", "select", "button", "datalist", "textarea",
];

/// `openImpliesClose`: opening the key closes these while they are on top.
fn implied_closes(name: &str) -> &'static [&'static str] {
    match name {
        "tr" => &["tr", "th", "td"],
        "th" => &["th"],
        "td" => &["thead", "th", "td"],
        "body" => &["head", "link", "script"],
        "li" => &["li"],
        "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "address" | "article" | "aside"
        | "blockquote" | "details" | "div" | "dl" | "fieldset" | "figcaption" | "figure"
        | "footer" | "form" | "header" | "hr" | "main" | "nav" | "ol" | "pre" | "section"
        | "table" | "ul" => &["p"],
        "select" | "input" | "output" | "button" | "datalist" | "textarea" => FORM_TAGS,
        "option" => &["option"],
        "optgroup" => &["optgroup", "option"],
        "dd" | "dt" => &["dd", "dt"],
        "rt" | "rp" => &["rt", "rp"],
        "tbody" | "tfoot" => &["thead", "tbody"],
        _ => &[],
    }
}

/// Named entities: `(name, text, legacy)`; a legacy one decodes without `;`.
const ENTITIES: &[(&str, &str, bool)] = &[
    ("amp", "&", true),
    ("lt", "<", true),
    ("gt", ">", true),
    ("quot", "\"", true),
    ("apos", "'", false),
    ("nbsp", "\u{a0}", true),
    ("copy", "\u{a9}", true),
    ("reg", "\u{ae}", true),
    ("trade", "\u{2122}", false),
    ("hellip", "\u{2026}", false),
    ("mdash", "\u{2014}", false),
    ("ndash", "\u{2013}", false),
    ("lsquo", "\u{2018}", false),
    ("rsquo", "\u{2019}", false),
    ("ldquo", "\u{201c}", false),
    ("rdquo", "\u{201d}", false),
    ("sbquo", "\u{201a}", false),
    ("bdquo", "\u{201e}", false),
    ("laquo", "\u{ab}", true),
    ("raquo", "\u{bb}", true),
    ("euro", "\u{20ac}", false),
    ("pound", "\u{a3}", true),
    ("yen", "\u{a5}", true),
    ("cent", "\u{a2}", true),
    ("sect", "\u{a7}", true),
    ("para", "\u{b6}", true),
    ("middot", "\u{b7}", true),
    ("bull", "\u{2022}", false),
    ("deg", "\u{b0}", true),
    ("plusmn", "\u{b1}", true),
    ("times", "\u{d7}", true),
    ("divide", "\u{f7}", true),
    ("frac12", "\u{bd}", true),
    ("frac14", "\u{bc}", true),
    ("frac34", "\u{be}", true),
    ("shy", "\u{ad}", true),
    ("zwnj", "\u{200c}", false),
    ("zwj", "\u{200d}", false),
    ("ensp", "\u{2002}", false),
    ("emsp", "\u{2003}", false),
    ("thinsp", "\u{2009}", false),
    ("iexcl", "\u{a1}", true),
    ("iquest", "\u{bf}", true),
    ("auml", "\u{e4}", true),
    ("euml", "\u{eb}", true),
    ("iuml", "\u{ef}", true),
    ("ouml", "\u{f6}", true),
    ("uuml", "\u{fc}", true),
    ("Auml", "\u{c4}", true),
    ("Ouml", "\u{d6}", true),
    ("Uuml", "\u{dc}", true),
    ("eacute", "\u{e9}", true),
    ("egrave", "\u{e8}", true),
    ("ecirc", "\u{ea}", true),
    ("aacute", "\u{e1}", true),
    ("agrave", "\u{e0}", true),
    ("acirc", "\u{e2}", true),
    ("oacute", "\u{f3}", true),
    ("iacute", "\u{ed}", true),
    ("uacute", "\u{fa}", true),
    ("ccedil", "\u{e7}", true),
    ("ntilde", "\u{f1}", true),
    ("szlig", "\u{df}", true),
    ("Eacute", "\u{c9}", true),
    ("larr", "\u{2190}", false),
    ("rarr", "\u{2192}", false),
    ("uarr", "\u{2191}", false),
    ("darr", "\u{2193}", false),
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    Element(Element),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Element {
    name: String,
    attrs: Vec<(String, String)>,
    children: Vec<Node>,
}

/// Decode entities in text or an attribute value, as `htmlparser2` does.
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        if let Some((decoded, used)) = entity_at(after) {
            out.push_str(&decoded);
            rest = &after[used..];
        } else {
            out.push('&');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// The entity at the start of `after` (`&` already consumed): its text and
/// how many bytes it used.
fn entity_at(after: &str) -> Option<(String, usize)> {
    if let Some(number) = after.strip_prefix('#') {
        let (radix, digits_from) = match number.chars().next() {
            Some('x' | 'X') => (16, 1),
            _ => (10, 0),
        };
        let digits: String = number[digits_from..]
            .chars()
            .take_while(|c| c.is_digit(radix))
            .collect();
        if digits.is_empty() {
            return None;
        }
        let mut used = 1 + digits_from + digits.len();
        if number[digits_from + digits.len()..].starts_with(';') {
            used += 1;
        }
        let code = u32::from_str_radix(&digits, radix).unwrap_or(0xfffd);
        let ch = match code {
            0 => '\u{fffd}',
            c if c > 0x0010_ffff => '\u{fffd}',
            c => char::from_u32(c).unwrap_or('\u{fffd}'),
        };
        return Some((ch.to_string(), used));
    }
    let name: String = after
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .collect();
    if name.is_empty() {
        return None;
    }
    let terminated = after[name.len()..].starts_with(';');
    if terminated && let Some((_, text, _)) = ENTITIES.iter().find(|(n, _, _)| *n == name) {
        return Some(((*text).to_owned(), name.len() + 1));
    }
    // A legacy entity decodes without `;`, by its longest prefix.
    ENTITIES
        .iter()
        .filter(|(n, _, legacy)| *legacy && name.starts_with(n))
        .max_by_key(|(n, _, _)| n.len())
        .map(|(n, text, _)| ((*text).to_owned(), n.len()))
}

struct Builder {
    root: Vec<Node>,
    /// Open elements, innermost last; each with its children so far.
    stack: Vec<Element>,
}

impl Builder {
    fn new() -> Self {
        Self {
            root: Vec::new(),
            stack: Vec::new(),
        }
    }

    fn push_node(&mut self, node: Node) {
        match self.stack.last_mut() {
            Some(parent) => parent.children.push(node),
            None => self.root.push(node),
        }
    }

    fn text(&mut self, text: String) {
        if text.is_empty() {
            return;
        }
        // Adjacent text joins, as `domhandler` merges it.
        let siblings = match self.stack.last_mut() {
            Some(parent) => &mut parent.children,
            None => &mut self.root,
        };
        if let Some(Node::Text(previous)) = siblings.last_mut() {
            previous.push_str(&text);
        } else {
            siblings.push(Node::Text(text));
        }
    }

    fn close_top(&mut self) {
        if let Some(element) = self.stack.pop() {
            self.push_node(Node::Element(element));
        }
    }

    fn open(&mut self, name: String, attrs: Vec<(String, String)>) {
        let implied = implied_closes(&name);
        while self
            .stack
            .last()
            .is_some_and(|top| implied.contains(&top.name.as_str()))
        {
            self.close_top();
        }
        let element = Element {
            name,
            attrs,
            children: Vec::new(),
        };
        if VOID_ELEMENTS.contains(&element.name.as_str()) {
            self.push_node(Node::Element(element));
        } else {
            self.stack.push(element);
        }
    }

    fn close(&mut self, name: &str) {
        if VOID_ELEMENTS.contains(&name) {
            if name == "br" {
                self.push_node(Node::Element(Element {
                    name: "br".to_owned(),
                    attrs: Vec::new(),
                    children: Vec::new(),
                }));
            }
            return;
        }
        if let Some(at) = self.stack.iter().rposition(|e| e.name == name) {
            while self.stack.len() > at {
                self.close_top();
            }
        } else if name == "p" {
            self.open("p".to_owned(), Vec::new());
            self.close_top();
        }
    }

    fn finish(mut self) -> Vec<Node> {
        while !self.stack.is_empty() {
            self.close_top();
        }
        self.root
    }
}

fn is_name_char(c: char) -> bool {
    !c.is_whitespace() && c != '/' && c != '>'
}

/// Parse `html` into nodes (comments and declarations left out).
fn parse(html: &str) -> Vec<Node> {
    let mut builder = Builder::new();
    let bytes = html.as_bytes();
    let mut i = 0;
    let mut text_start = 0;
    let flush = |builder: &mut Builder, from: usize, to: usize| {
        if to > from {
            builder.text(decode_entities(&html[from..to]));
        }
    };
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        let next = bytes.get(i + 1).copied();
        match next {
            Some(b'/') if bytes.get(i + 2).is_some_and(u8::is_ascii_alphabetic) => {
                flush(&mut builder, text_start, i);
                let name_start = i + 2;
                let name_end = html[name_start..]
                    .find(|c: char| !is_name_char(c))
                    .map_or(html.len(), |at| name_start + at);
                let name = html[name_start..name_end].to_lowercase();
                let close = html[name_end..]
                    .find('>')
                    .map_or(html.len(), |at| name_end + at + 1);
                builder.close(&name);
                i = close;
                text_start = i;
            }
            Some(b'/') => {
                // `</>` and `</ ...>`: a bogus comment, dropped.
                flush(&mut builder, text_start, i);
                i = html[i..].find('>').map_or(html.len(), |at| i + at + 1);
                text_start = i;
            }
            Some(b'!') => {
                flush(&mut builder, text_start, i);
                i = if html[i..].starts_with("<!--") {
                    html[i + 4..]
                        .find("-->")
                        .map_or(html.len(), |at| i + 4 + at + 3)
                } else {
                    html[i..].find('>').map_or(html.len(), |at| i + at + 1)
                };
                text_start = i;
            }
            Some(b'?') => {
                flush(&mut builder, text_start, i);
                i = html[i..].find('>').map_or(html.len(), |at| i + at + 1);
                text_start = i;
            }
            Some(c) if c.is_ascii_alphabetic() => {
                flush(&mut builder, text_start, i);
                let (name, attrs, end) = open_tag(html, i + 1);
                let raw = RAW_TEXT.contains(&name.as_str());
                builder.open(name.clone(), attrs);
                i = end;
                if raw {
                    let (content_end, after) = raw_text_end(html, i, &name);
                    if content_end > i {
                        builder.text(html[i..content_end].to_owned());
                    }
                    builder.close(&name);
                    i = after;
                }
                text_start = i;
            }
            _ => i += 1,
        }
    }
    flush(&mut builder, text_start, html.len());
    builder.finish()
}

/// The open tag from `from` (just after `<`): name, attributes, and where it
/// ends.
fn open_tag(html: &str, from: usize) -> (String, Vec<(String, String)>, usize) {
    let name_end = html[from..]
        .find(|c: char| !is_name_char(c))
        .map_or(html.len(), |at| from + at);
    let name = html[from..name_end].to_lowercase();
    let mut attrs: Vec<(String, String)> = Vec::new();
    let mut i = name_end;
    let rest = |i: usize| &html[i..];
    loop {
        let skipped = rest(i).len() - rest(i).trim_start().len();
        i += skipped;
        if i >= html.len() {
            return (name, attrs, html.len());
        }
        if rest(i).starts_with('>') {
            return (name, attrs, i + 1);
        }
        if rest(i).starts_with('/') {
            i += 1;
            continue;
        }
        let attr_end = rest(i)
            .find(|c: char| c.is_whitespace() || c == '=' || c == '>' || c == '/')
            .map_or(html.len(), |at| i + at);
        let attr_name = html[i..attr_end].to_lowercase();
        i = attr_end;
        let ws = rest(i).len() - rest(i).trim_start().len();
        let mut value = String::new();
        if rest(i + ws).starts_with('=') {
            i += ws + 1;
            let ws = rest(i).len() - rest(i).trim_start().len();
            i += ws;
            if let Some(quote @ ('"' | '\'')) = rest(i).chars().next() {
                let end = rest(i + 1).find(quote).map_or(html.len(), |at| i + 1 + at);
                value = decode_entities(&html[i + 1..end]);
                i = (end + 1).min(html.len());
            } else {
                let end = rest(i)
                    .find(|c: char| c.is_whitespace() || c == '>')
                    .map_or(html.len(), |at| i + at);
                value = decode_entities(&html[i..end]);
                i = end;
            }
        }
        if !attr_name.is_empty() && !attrs.iter().any(|(n, _)| *n == attr_name) {
            attrs.push((attr_name, value));
        }
    }
}

/// Where the raw text of `name` from `from` ends, and where its closing tag
/// ends.
fn raw_text_end(html: &str, from: usize, name: &str) -> (usize, usize) {
    let lower = html[from..].to_ascii_lowercase();
    let needle = format!("</{name}");
    let mut search = 0;
    while let Some(at) = lower[search..].find(&needle) {
        let start = search + at;
        let after = lower[start + needle.len()..].chars().next();
        if after.is_none_or(|c| c.is_whitespace() || c == '>' || c == '/') {
            let close = html[from + start..]
                .find('>')
                .map_or(html.len(), |end| from + start + end + 1);
            return (from + start, close);
        }
        search = start + needle.len();
    }
    (html.len(), html.len())
}

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

static SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)^([a-z][a-z0-9+.\-]*):").unwrap_or_else(|e| panic!("{e}")));
static DATA_IMAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)^data:image/").unwrap_or_else(|e| panic!("{e}")));
static CSS: LazyLock<[Regex; 6]> = LazyLock::new(|| {
    [
        r"(?i-u)expression\s*\(",
        r"(?i-u)javascript\s*:",
        r"(?i-u)vbscript\s*:",
        r"(?i-u)-moz-binding",
        r"(?i-u)behaviou?r\s*:",
        r"(?i-u)@import",
    ]
    .map(|p| Regex::new(p).unwrap_or_else(|e| panic!("{e}")))
});

/// `isSafeUrl(value)`.
fn is_safe_url(value: &str) -> bool {
    let trimmed = crate::text::js_trim(value);
    if DATA_IMAGE.is_match(trimmed) {
        return true;
    }
    // The URL parser drops tabs and newlines and trims C0 controls and spaces.
    let cleaned: String = trimmed
        .trim_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    match SCHEME.captures(&cleaned) {
        Some(caps) => matches!(
            caps[1].to_ascii_lowercase().as_str(),
            "http" | "https" | "mailto" | "tel" | "cid"
        ),
        None => true,
    }
}

fn clean_css(css: &str) -> String {
    CSS.iter().fold(css.to_owned(), |text, re| {
        re.replace_all(&text, "").into_owned()
    })
}

fn clean_attrs(attrs: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut kept = Vec::with_capacity(attrs.len());
    for (name, value) in attrs {
        let lower = name.to_lowercase();
        if lower.starts_with("on") || matches!(lower.as_str(), "srcdoc" | "xmlns" | "is") {
            continue;
        }
        if lower == "style" {
            kept.push((name, clean_css(&value)));
            continue;
        }
        if lower == "srcset" {
            let unsafe_url = value
                .split(',')
                .filter_map(|candidate| candidate.split_whitespace().next())
                .any(|url| !is_safe_url(url));
            if !unsafe_url {
                kept.push((name, value));
            }
            continue;
        }
        if URL_ATTRS.contains(&lower.as_str()) && !is_safe_url(&value) {
            continue;
        }
        kept.push((name, value));
    }
    kept
}

fn is_allowed(tag: &str) -> bool {
    ALLOWED_TAGS.contains(&tag) || ALLOWED_TAGS_MORE.contains(&tag)
}

fn sanitize_nodes(nodes: Vec<Node>) -> Vec<Node> {
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        match node {
            Node::Text(_) => out.push(node),
            Node::Element(element) => {
                if DROP_WITH_CONTENT.contains(&element.name.as_str()) {
                    continue;
                }
                let children = sanitize_nodes(element.children);
                if !is_allowed(&element.name) {
                    out.extend(children);
                    continue;
                }
                out.push(Node::Element(Element {
                    name: element.name,
                    attrs: clean_attrs(element.attrs),
                    children,
                }));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Serializing
// ---------------------------------------------------------------------------

/// `encodeXML(text)`.
pub fn encode_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '$' => out.push_str("&#x24;"),
            c if u32::from(c) >= 0x80 => {
                let _ = write!(out, "&#x{:x};", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out
}

fn render(nodes: &[Node], out: &mut String) {
    for node in nodes {
        match node {
            Node::Text(text) => out.push_str(&encode_xml(text)),
            Node::Element(element) => {
                out.push('<');
                out.push_str(&element.name);
                for (name, value) in &element.attrs {
                    out.push(' ');
                    out.push_str(name);
                    if !value.is_empty() {
                        out.push_str("=\"");
                        out.push_str(&encode_xml(value));
                        out.push('"');
                    }
                }
                out.push('>');
                if !VOID_ELEMENTS.contains(&element.name.as_str()) {
                    render(&element.children, out);
                    out.push_str("</");
                    out.push_str(&element.name);
                    out.push('>');
                }
            }
        }
    }
}

/// `sanitizeEmailHtml(html)`: `""` for empty input.
pub fn sanitize_email_html(html: Option<&str>) -> String {
    let Some(html) = html.filter(|h| !h.is_empty()) else {
        return String::new();
    };
    let mut out = String::with_capacity(html.len());
    render(&sanitize_nodes(parse(html)), &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each input as `sanitizeEmailHtml` answers it in TypeScript.
    #[test]
    fn matches_the_typescript_sanitizer() {
        let cases: &[(&str, &str)] = &[
            ("<p>Hello <b>there</b></p>", "<p>Hello <b>there</b></p>"),
            (
                "<p>Héllo &amp; “quotes” &nbsp;x</p>",
                "<p>H&#xe9;llo &amp; &#x201c;quotes&#x201d; &#xa0;x</p>",
            ),
            (
                "<div style=\"color:red\" onclick=\"x()\">a<br>b<br/>c</div>",
                "<div style=\"color:red\">a<br>b<br>c</div>",
            ),
            (
                "<p>unclosed <b>bold<p>next",
                "<p>unclosed <b>bold<p>next</p></b></p>",
            ),
            (
                "<a href=\"javascript:alert(1)\" title='t\"q'>x</a><img src=\"cid:abc\" alt=x>",
                "<a title=\"t&quot;q\">x</a><img src=\"cid:abc\" alt=\"x\">",
            ),
            (
                "<script>bad()</script><style>p{}</style><form><input value=1>text</form>",
                "text",
            ),
            (
                "plain text with <3 and a < b",
                "plain text with &lt;3 and a &lt; b",
            ),
            (
                "<table><tr><td>1</td></tr></table>",
                "<table><tr><td>1</td></tr></table>",
            ),
            ("<!-- c --><p>after</p>", "<p>after</p>"),
            (
                "<p class=a data-x='1'>it's</p>",
                "<p class=\"a\" data-x=\"1\">it&apos;s</p>",
            ),
            (
                "<ul><li>one<li>two</ul>",
                "<ul><li>one</li><li>two</li></ul>",
            ),
            ("<P>Upper</P>", "<p>Upper</p>"),
            (
                "<html><head><title>t</title></head><body><p>b</p></body></html>",
                "<html><body><p>b</p></body></html>",
            ),
            (
                "<img alt=\"\" src=\"x.png\" width=1>",
                "<img alt src=\"x.png\" width=\"1\">",
            ),
            (
                "<p title=\"A & B é $5\">cost $5 😀 \u{a0} tab\there</p>",
                "<p title=\"A &amp; B &#xe9; &#x24;5\">cost &#x24;5 &#x1f600; &#xa0; tab\there</p>",
            ),
            ("<p>a<p>b</p></p>c</b>", "<p>a</p><p>b</p><p></p>c"),
            (
                "<textarea>x &amp; <b>y</b></textarea>",
                "x &amp;amp; &lt;b&gt;y&lt;/b&gt;",
            ),
            ("<title>t &amp; x</title><p>z</p>", "<p>z</p>"),
            (
                "<div><p>one<div>two</div></div>",
                "<div><p>one</p><div>two</div></div>",
            ),
            ("<p>x</br>y</p>", "<p>x<br>y</p>"),
            (
                "<a href=\"https://x.com/?a=1&b=2\">l</a>",
                "<a href=\"https://x.com/?a=1&amp;b=2\">l</a>",
            ),
            (
                "<a HREF=\"mailto:a@b.c\">m</a><a href=\"/rel\">r</a><a href=\"data:text/html,x\">d</a>",
                "<a href=\"mailto:a@b.c\">m</a><a href=\"/rel\">r</a><a>d</a>",
            ),
            ("<img srcset=\"a.png 1x, javascript:x 2x\">", "<img>"),
            (
                "<span style=\"background:url(javascript:alert(1));width: expression(1)\">s</span>",
                "<span style=\"background:url(alert(1));width: 1)\">s</span>",
            ),
            (
                "<p>line1\nline2\r\nline3</p>",
                "<p>line1\nline2\r\nline3</p>",
            ),
            ("<!DOCTYPE html><p>d</p>", "<p>d</p>"),
            ("<b>unclosed", "<b>unclosed</b>"),
            ("<p a=1 a=2>dup</p>", "<p a=\"1\">dup</p>"),
            (
                "a &lt; b &unknown; &#169; &copy &nbsp",
                "a &lt; b &amp;unknown; &#xa9; &#xa9; &#xa0;",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(
                sanitize_email_html(Some(input)),
                *expected,
                "input: {input}"
            );
        }
        assert_eq!(sanitize_email_html(None), "");
        assert_eq!(sanitize_email_html(Some("")), "");
    }
}
