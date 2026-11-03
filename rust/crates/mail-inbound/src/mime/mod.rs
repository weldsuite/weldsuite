//! A port of postal-mime 2.7.3 (`postal-mime.js`), the parser
//! `@weldsuite/email`'s `parseRawEmail` runs on every inbound message, so a
//! message reads the same on both editions: which parts are the text and
//! the HTML, which are attachments, how headers, encoded words, charsets
//! and addresses decode.

mod address;
mod date;
pub(crate) mod decode;
mod entities;
mod node;
mod text;

use std::sync::atomic::{AtomicU64, Ordering};

pub use address::{MailAddress, parse_addresses};
pub(crate) use date::{parse_date, to_iso};
pub(crate) use decode::{decode_words, is_js_space, js_trim};
use node::{Node, NodeState};

/// One attachment as postal-mime returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub filename: Option<String>,
    pub mime_type: String,
    pub disposition: Option<String>,
    pub content_id: Option<String>,
    pub content: Vec<u8>,
}

/// What postal-mime's `parse()` returns.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Email {
    /// Every header in the order written: lower-cased name, value with
    /// whitespace runs collapsed.
    pub headers: Vec<(String, String)>,
    pub from: Option<MailAddress>,
    pub to: Vec<MailAddress>,
    pub cc: Vec<MailAddress>,
    pub bcc: Vec<MailAddress>,
    pub reply_to: Vec<MailAddress>,
    pub subject: Option<String>,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    /// The `Date` header as an ISO string when it parses, else as written.
    pub date: Option<String>,
    pub html: Option<String>,
    pub text: Option<String>,
    pub attachments: Vec<Attachment>,
}

/// Why a message could not be parsed (postal-mime throws).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError(pub String);

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ParseError {}

const MAX_NESTING_DEPTH: usize = 256;

/// Every node of every parser gets its own key in the text map (postal-mime
/// keys its `textMap` by node object, sub-messages' nodes included).
static NEXT_KEY: AtomicU64 = AtomicU64::new(0);

struct Parser {
    nodes: Vec<Node>,
    keys: Vec<u64>,
    depths: Vec<usize>,
    current: usize,
    boundaries: Vec<(Vec<u8>, usize)>,
}

impl Parser {
    fn new() -> Self {
        Self {
            nodes: vec![Node::new(None, None)],
            keys: vec![NEXT_KEY.fetch_add(1, Ordering::Relaxed)],
            depths: vec![0],
            current: 0,
            boundaries: Vec::new(),
        }
    }

    fn process_headers(&mut self, index: usize) {
        if let Some(boundary) = self.nodes[index].process_headers() {
            self.boundaries.push((boundary, index));
        }
    }

    fn finalize(&mut self, index: usize) {
        if self.nodes[index].state == NodeState::Finished {
            return;
        }
        if self.nodes[index].state == NodeState::Header {
            self.process_headers(index);
        }
        if let Some(at) = self.boundaries.iter().rposition(|(_, node)| *node == index) {
            self.boundaries.remove(at);
        }
        self.finalize_children(index);
        self.nodes[index].finish_content();
    }

    fn finalize_children(&mut self, index: usize) {
        let children = self.nodes[index].children.clone();
        for child in children {
            self.finalize(child);
        }
    }

    fn feed(&mut self, line: &[u8]) -> Result<(), ParseError> {
        let index = self.current;
        match self.nodes[index].state {
            NodeState::Header => {
                if self.nodes[index].feed_header(line).map_err(ParseError)? {
                    self.process_headers(index);
                }
            }
            NodeState::Body => self.nodes[index].feed_body(line),
            NodeState::Finished => {}
        }
        Ok(())
    }

    /// `processLine(line, isFinal)`.
    fn process_line(&mut self, line: &[u8], is_final: bool) -> Result<(), ParseError> {
        if !self.boundaries.is_empty() && line.len() > 2 && line[0] == b'-' && line[1] == b'-' {
            for i in (0..self.boundaries.len()).rev() {
                let (boundary, node) = &self.boundaries[i];
                let (blen, node) = (boundary.len(), *node);
                if line.len() < blen + 2 || line[2..2 + blen] != boundary[..] {
                    continue;
                }
                let mut end = blen + 2;
                let mut terminator = false;
                if line.len() >= blen + 4 && line[blen + 2] == b'-' && line[blen + 3] == b'-' {
                    terminator = true;
                    end = blen + 4;
                }
                if !line[end..].iter().all(|c| *c == b' ' || *c == b'\t') {
                    continue;
                }
                if terminator {
                    self.finalize(node);
                    self.current = self.nodes[node].parent.unwrap_or(0);
                } else {
                    self.finalize_children(node);
                    let depth = self.depths[node] + 1;
                    if depth > MAX_NESTING_DEPTH {
                        return Err(ParseError(format!(
                            "Maximum MIME nesting depth of {MAX_NESTING_DEPTH} levels exceeded"
                        )));
                    }
                    let multipart = self.nodes[node].content_type.multipart.clone();
                    self.nodes.push(Node::new(Some(node), multipart.as_deref()));
                    self.keys.push(NEXT_KEY.fetch_add(1, Ordering::Relaxed));
                    self.depths.push(depth);
                    let child = self.nodes.len() - 1;
                    self.nodes[node].children.push(child);
                    self.current = child;
                }
                if is_final {
                    self.finalize(0);
                }
                return Ok(());
            }
        }
        self.feed(line)?;
        if is_final {
            self.finalize(0);
        }
        Ok(())
    }
}

/// A text map entry's text (`{ type: 'text' | 'subMessage', value }`).
enum TextEntry {
    Text(String),
    Sub(Box<Email>),
}

#[derive(Default)]
struct TextSlot {
    plain: Vec<TextEntry>,
    html: Vec<TextEntry>,
}

struct Tree {
    /// `textMap`, in insertion order.
    map: Vec<(u64, TextSlot)>,
    plain: bool,
    html: bool,
    attachments: Vec<Attachment>,
}

impl Tree {
    fn slot(&mut self, key: u64) -> &mut TextSlot {
        if let Some(at) = self.map.iter().position(|(k, _)| *k == key) {
            return &mut self.map[at].1;
        }
        self.map.push((key, TextSlot::default()));
        let last = self.map.len() - 1;
        &mut self.map[last].1
    }
}

/// `forceRfc822Attachments()`: a delivery or feedback report keeps its
/// forwarded message as an attachment.
fn force_rfc822_attachments(parser: &Parser) -> bool {
    parser.nodes.iter().any(|node| {
        node.content_type.multipart.is_none()
            && matches!(
                node.content_type.parsed.value.as_str(),
                "message/delivery-status" | "message/feedback-report"
            )
    })
}

fn walk(
    parser: &Parser,
    tree: &mut Tree,
    index: usize,
    mut alternative: Option<usize>,
    force_rfc822: bool,
) -> Result<(), ParseError> {
    let node = &parser.nodes[index];
    let value = node.content_type.parsed.value.as_str();
    let disposition = node.content_disposition.value.as_str();
    if node.content_type.multipart.is_none() {
        let inline_rfc822 = value == "message/rfc822"
            && (if disposition.is_empty() {
                "inline"
            } else {
                disposition
            }) == "inline";
        if inline_rfc822 && !force_rfc822 {
            let (sub, sub_tree) = parse_tree(node.content.as_deref().unwrap_or_default())?;
            let key = parser.keys[index];
            let has_text = sub.text.is_some();
            let has_html = sub.html.is_some();
            let sub = Box::new(sub);
            if has_text || !has_html {
                tree.slot(key).plain.push(TextEntry::Sub(sub.clone()));
                tree.plain = true;
            }
            if has_html {
                tree.slot(key).html.push(TextEntry::Sub(sub.clone()));
                tree.html = true;
            }
            for (sub_key, slot) in sub_tree.map {
                if let Some(at) = tree.map.iter().position(|(k, _)| *k == sub_key) {
                    tree.map[at].1 = slot;
                } else {
                    tree.map.push((sub_key, slot));
                }
            }
            tree.attachments.extend(sub.attachments.iter().cloned());
        } else if disposition != "attachment" && (value == "text/html" || value == "text/plain") {
            let key = parser.keys[alternative.unwrap_or(index)];
            let text = node.text_content();
            if value == "text/html" {
                tree.slot(key).html.push(TextEntry::Text(text));
                tree.html = true;
            } else {
                tree.slot(key).plain.push(TextEntry::Text(text));
                tree.plain = true;
            }
        } else if let Some(content) = &node.content {
            let params = &node.content_type.parsed;
            let filename = node
                .content_disposition
                .param("filename")
                .filter(|f| !f.is_empty())
                .or_else(|| params.param("name").filter(|n| !n.is_empty()))
                .map(decode_words);
            let content = if matches!(value, "text/calendar" | "application/ics") {
                let text = node.text_content().replace("\r\n", "\n");
                let trimmed = text.trim_end_matches('\n');
                format!("{trimmed}\n").into_bytes()
            } else {
                content.clone()
            };
            tree.attachments.push(Attachment {
                filename,
                mime_type: value.to_owned(),
                disposition: (!disposition.is_empty()).then(|| disposition.to_owned()),
                content_id: node.content_id.clone().filter(|id| !id.is_empty()),
                content,
            });
        }
    } else if node.content_type.multipart.as_deref() == Some("alternative") {
        alternative = Some(index);
    }
    for child in node.children.clone() {
        walk(parser, tree, child, alternative, force_rfc822)?;
    }
    Ok(())
}

/// The header postal-mime reads a value from: the last one written.
fn last_header<'a>(headers: &'a [(String, String)], key: &str) -> Option<&'a str> {
    headers
        .iter()
        .rev()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

/// Every non-empty header of `key`, the last one written first.
fn addresses_of(headers: &[(String, String)], key: &str) -> Vec<MailAddress> {
    headers
        .iter()
        .rev()
        .filter(|(k, v)| k == key && !v.is_empty())
        .flat_map(|(_, v)| parse_addresses(v))
        .collect()
}

/// The lines of a message as `readLine()` cuts them: at `\n`, without the
/// trailing `\r`s and `\n`; whether it is the last.
fn lines(raw: &[u8]) -> Vec<(&[u8], bool)> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < raw.len() {
        let start = at;
        let mut end = at;
        while let Some(&c) = raw.get(at) {
            at += 1;
            if c != b'\r' && c != b'\n' {
                end = at;
            }
            if c == b'\n' {
                break;
            }
        }
        out.push((&raw[start..end], at >= raw.len()));
    }
    out
}

fn parse_tree(raw: &[u8]) -> Result<(Email, Tree), ParseError> {
    let mut parser = Parser::new();
    for (line, is_final) in lines(raw) {
        parser.process_line(line, is_final)?;
    }
    let force = force_rfc822_attachments(&parser);
    let mut tree = Tree {
        map: Vec::new(),
        plain: false,
        html: false,
        attachments: Vec::new(),
    };
    walk(&parser, &mut tree, 0, None, force)?;

    let mut plain_parts: Vec<String> = Vec::new();
    let mut html_parts: Vec<String> = Vec::new();
    for (_, slot) in &tree.map {
        if tree.plain {
            if slot.plain.is_empty() {
                for entry in &slot.html {
                    plain_parts.push(match entry {
                        TextEntry::Text(text) => text::html_to_text(text),
                        TextEntry::Sub(sub) => text::format_text_header(sub),
                    });
                }
            } else {
                for entry in &slot.plain {
                    plain_parts.push(match entry {
                        TextEntry::Text(text) => text.clone(),
                        TextEntry::Sub(sub) => text::format_text_header(sub),
                    });
                }
            }
        }
        if tree.html {
            if slot.html.is_empty() {
                for entry in &slot.plain {
                    html_parts.push(match entry {
                        TextEntry::Text(text) => text::text_to_html(text),
                        TextEntry::Sub(sub) => text::format_html_header(sub),
                    });
                }
            } else {
                for entry in &slot.html {
                    html_parts.push(match entry {
                        TextEntry::Text(text) => text.clone(),
                        TextEntry::Sub(sub) => text::format_html_header(sub),
                    });
                }
            }
        }
    }

    let root = &parser.nodes[0];
    let headers: Vec<(String, String)> = root.headers.iter().rev().cloned().collect();
    let first_address = |key: &str| {
        last_header(&headers, key)
            .filter(|v| !v.is_empty())
            .and_then(|v| parse_addresses(v).into_iter().next())
    };
    let decoded = |key: &str| {
        last_header(&headers, key)
            .filter(|v| !v.is_empty())
            .map(decode_words)
    };
    let date = last_header(&headers, "date").map(|value| match parse_date(value) {
        Some(ms) => to_iso(ms),
        None => value.to_owned(),
    });
    let html = html_parts.join("\n");
    let text = plain_parts.join("\n");
    let email = Email {
        from: first_address("from"),
        to: addresses_of(&headers, "to"),
        cc: addresses_of(&headers, "cc"),
        bcc: addresses_of(&headers, "bcc"),
        reply_to: addresses_of(&headers, "reply-to"),
        subject: decoded("subject"),
        message_id: decoded("message-id"),
        in_reply_to: decoded("in-reply-to"),
        references: decoded("references"),
        date,
        html: (!html.is_empty()).then_some(html),
        text: (!text.is_empty()).then_some(text),
        attachments: std::mem::take(&mut tree.attachments),
        headers,
    };
    Ok((email, tree))
}

/// `PostalMime.parse(raw)`.
pub fn parse(raw: &[u8]) -> Result<Email, ParseError> {
    parse_tree(raw).map(|(email, _)| email)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_message() {
        let raw = b"From: Jane <jane@example.com>\r\nTo: a@x.com, b@x.com\r\nSubject: =?utf-8?Q?Caf=C3=A9?=\r\nMessage-ID: <m1@example.com>\r\nDate: Tue, 29 Oct 2026 12:00:00 +0000\r\n\r\nHello\r\nthere\r\n";
        let email = parse(raw).expect("parses");
        assert_eq!(email.subject.as_deref(), Some("Café"));
        assert_eq!(email.text.as_deref(), Some("Hello\nthere\n"));
        assert_eq!(email.html, None);
        assert_eq!(email.message_id.as_deref(), Some("<m1@example.com>"));
        assert_eq!(email.date.as_deref(), Some("2026-10-29T12:00:00.000Z"));
        assert_eq!(email.to.len(), 2);
        assert_eq!(
            email.from.and_then(|f| f.address).as_deref(),
            Some("jane@example.com")
        );
    }

    #[test]
    fn alternative_and_attachments() {
        let raw = b"Content-Type: multipart/mixed; boundary=\"outer\"\r\n\r\n--outer\r\nContent-Type: multipart/alternative; boundary=\"inner\"\r\n\r\n--inner\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nplain\r\n--inner\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<p>caf=C3=A9</p>\r\n--inner--\r\n--outer\r\nContent-Type: application/pdf; name=\"a.pdf\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\"a.pdf\"\r\n\r\naGVsbG8=\r\n--outer--\r\n";
        let email = parse(raw).expect("parses");
        assert_eq!(email.text.as_deref(), Some("plain\n"));
        assert_eq!(email.html.as_deref(), Some("<p>café</p>\n"));
        assert_eq!(email.attachments.len(), 1);
        assert_eq!(email.attachments[0].filename.as_deref(), Some("a.pdf"));
        assert_eq!(email.attachments[0].content, b"hello");
    }
}
