//! postal-mime's `mime-node.js`: one MIME part, its headers and its decoded
//! body.

use super::decode::{
    ContentDecoder, decode_text, decode_uri_component_with_charset, decoder, is_js_space, js_trim,
};

/// A parsed structured header (`parseStructuredHeader`): the value, lower
/// cased, and its parameters, continuations joined.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Structured {
    pub(crate) value: String,
    /// Parameters in the order they were written (`Object.keys` order;
    /// names are lower cased).
    pub(crate) params: Vec<(String, String)>,
}

impl Structured {
    pub(crate) fn param(&self, name: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn set(&mut self, key: String, value: String) {
        if let Some(slot) = self.params.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = value;
        } else {
            self.params.push((key, value));
        }
    }
}

/// `stripComments(str)`: RFC 822 comments removed outside quotes.
fn strip_comments(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut depth = 0u32;
    let mut escaped = false;
    let mut in_quote = false;
    for c in text.chars() {
        if escaped {
            if depth == 0 {
                result.push(c);
            }
            escaped = false;
            continue;
        }
        if c == '\\' {
            escaped = true;
            if depth == 0 {
                result.push(c);
            }
            continue;
        }
        if c == '"' && depth == 0 {
            in_quote = !in_quote;
            result.push(c);
            continue;
        }
        if !in_quote {
            if c == '(' {
                depth += 1;
                continue;
            }
            if c == ')' && depth > 0 {
                depth -= 1;
                continue;
            }
        }
        if depth == 0 {
            result.push(c);
        }
    }
    result
}

/// `parseStructuredHeader(str)`.
pub(crate) fn parse_structured(text: &str) -> Structured {
    let text = strip_comments(text);
    let mut response = Structured::default();
    let mut key: Option<String> = None;
    let mut value = String::new();
    let mut in_key = false;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for c in text.chars() {
        if in_key {
            if c == '=' {
                key = Some(js_trim(&value).to_lowercase());
                in_key = false;
                value.clear();
            } else {
                value.push(c);
            }
            continue;
        }
        if escaped {
            value.push(c);
        } else if c == '\\' {
            escaped = true;
            continue;
        } else if quote == Some(c) {
            quote = None;
        } else if quote.is_none() && c == '"' {
            quote = Some(c);
        } else if quote.is_none() && c == ';' {
            match &key {
                None => js_trim(&value).clone_into(&mut response.value),
                Some(key) => response.set(key.clone(), js_trim(&value).to_owned()),
            }
            in_key = true;
            value.clear();
        } else {
            value.push(c);
        }
        escaped = false;
    }
    let value = js_trim(&value).to_owned();
    if in_key {
        if !value.is_empty() {
            response.set(value.to_lowercase(), String::new());
        }
    } else {
        match key {
            None => response.value = value,
            Some(key) => response.set(key, value),
        }
    }
    response.value = response.value.to_lowercase();
    decode_continuations(&mut response);
    response
}

/// `decodeParameterValueContinuations(header)` (RFC 2231).
fn decode_continuations(header: &mut Structured) {
    struct Param {
        charset: Option<String>,
        values: Vec<(f64, String)>,
    }
    let mut joined: Vec<(String, Param)> = Vec::new();
    let mut kept = Vec::new();
    for (key, value) in std::mem::take(&mut header.params) {
        // `/\*((\d+)\*?)?$/`
        let Some((base, nr, ends_with_star)) = continuation(&key) else {
            kept.push((key, value));
            continue;
        };
        let actual = base.to_lowercase();
        let index = if let Some(index) = joined.iter().position(|(k, _)| *k == actual) {
            index
        } else {
            joined.push((
                actual,
                Param {
                    charset: None,
                    values: Vec::new(),
                },
            ));
            joined.len() - 1
        };
        let param = &mut joined[index].1;
        let mut value = value;
        if nr == 0.0
            && ends_with_star
            && let Some((charset, rest)) = value.split_once('\'')
            && let Some((_, text)) = rest.split_once('\'')
        {
            param.charset = Some(if charset.is_empty() {
                "utf-8".to_owned()
            } else {
                charset.to_owned()
            });
            let text = text.to_owned();
            value = text;
        }
        param.values.push((nr, value));
    }
    header.params = kept;
    for (key, mut param) in joined {
        param.values.sort_by(|a, b| a.0.total_cmp(&b.0));
        let encoded: String = param.values.into_iter().map(|(_, v)| v).collect();
        let value = decode_uri_component_with_charset(&encoded, param.charset.as_deref());
        header.set(key, value);
    }
}

/// A continuation key (`/\*((\d+)\*?)?$/`, the leftmost match): its base
/// name, its number and whether the match ends in `*` (an encoded value).
fn continuation(key: &str) -> Option<(&str, f64, bool)> {
    let bytes = key.as_bytes();
    for (i, &c) in bytes.iter().enumerate() {
        if c != b'*' {
            continue;
        }
        let rest = &bytes[i + 1..];
        if rest.is_empty() {
            return Some((&key[..i], 0.0, true));
        }
        let digits = rest.iter().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 {
            continue;
        }
        let nr = key[i + 1..i + 1 + digits].parse::<f64>().unwrap_or(0.0);
        match &rest[digits..] {
            [] => return Some((&key[..i], nr, false)),
            [b'*'] => return Some((&key[..i], nr, true)),
            _ => {}
        }
    }
    None
}

/// `MAX_HEADERS_SIZE`: the most header bytes one part may have.
const MAX_HEADERS_SIZE: usize = 2 * 1024 * 1024;

/// The node's `contentType`.
#[derive(Debug, Clone, Default)]
pub(crate) struct ContentType {
    pub(crate) value: String,
    pub(crate) default: bool,
    pub(crate) parsed: Structured,
    /// `multipart/<this>`.
    pub(crate) multipart: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NodeState {
    Header,
    Body,
    Finished,
}

/// `MimeNode`.
#[derive(Debug)]
pub(crate) struct Node {
    pub(crate) parent: Option<usize>,
    pub(crate) children: Vec<usize>,
    pub(crate) state: NodeState,
    header_lines: Vec<String>,
    header_size: usize,
    pub(crate) content_type: ContentType,
    transfer_encoding: String,
    pub(crate) content_disposition: Structured,
    pub(crate) content_id: Option<String>,
    /// `headers`: lower-cased names, in the order postal-mime keeps them
    /// (the last header first).
    pub(crate) headers: Vec<(String, String)>,
    decoder: Option<ContentDecoder>,
    pub(crate) content: Option<Vec<u8>>,
}

impl Node {
    pub(crate) fn new(parent: Option<usize>, parent_multipart: Option<&str>) -> Self {
        let default = if parent_multipart == Some("digest") {
            "message/rfc822"
        } else {
            "text/plain"
        };
        Self {
            parent,
            children: Vec::new(),
            state: NodeState::Header,
            header_lines: Vec::new(),
            header_size: 0,
            content_type: ContentType {
                value: default.to_owned(),
                default: true,
                ..ContentType::default()
            },
            transfer_encoding: "8bit".to_owned(),
            content_disposition: Structured::default(),
            content_id: None,
            headers: Vec::new(),
            decoder: None,
            content: None,
        }
    }

    /// `processHeaders()`; the boundary to listen for, when multipart.
    pub(crate) fn process_headers(&mut self) -> Option<Vec<u8>> {
        let mut lines = std::mem::take(&mut self.header_lines);
        // Folded lines into the one before them.
        let mut i = lines.len();
        while i > 1 {
            i -= 1;
            if lines[i].starts_with(is_js_space) {
                let line = lines.remove(i);
                lines[i - 1].push('\n');
                lines[i - 1].push_str(&line);
            }
        }
        let mut content_type: Option<String> = None;
        let mut disposition = String::new();
        for raw in lines.iter().rev() {
            let normalized = collapse_space(raw);
            let (key, value) = match normalized.find(':') {
                Some(sep) => (
                    js_trim(&normalized[..sep]).to_owned(),
                    js_trim(&normalized[sep + 1..]).to_owned(),
                ),
                None => (js_trim(&normalized).to_owned(), String::new()),
            };
            let lower = key.to_lowercase();
            match lower.as_str() {
                "content-type" if content_type.is_none() => content_type = Some(value.clone()),
                "content-transfer-encoding" => self.transfer_encoding.clone_from(&value),
                "content-disposition" => disposition.clone_from(&value),
                "content-id" => self.content_id = Some(value.clone()),
                _ => {}
            }
            self.headers.push((lower, value));
        }
        if let Some(value) = content_type {
            self.content_type.value = value;
            self.content_type.default = false;
        }
        self.content_type.parsed = parse_structured(&self.content_type.value);
        let parsed_value = &self.content_type.parsed.value;
        self.content_type.multipart = parsed_value
            .strip_prefix("multipart/")
            .filter(|kind| !kind.is_empty())
            .map(str::to_owned);
        let boundary = self
            .content_type
            .multipart
            .as_ref()
            .and(self.content_type.parsed.param("boundary"))
            .filter(|b| !b.is_empty())
            .map(|b| b.as_bytes().to_vec());
        self.content_disposition = parse_structured(&disposition);
        let encoding: String = self
            .transfer_encoding
            .to_lowercase()
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        self.decoder = Some(ContentDecoder::for_encoding(
            &encoding,
            self.content_type.parsed.param("charset"),
        ));
        boundary
    }

    /// `feed(line)` in the header state: `Ok(true)` when the headers ended,
    /// an error past the header size limit.
    pub(crate) fn feed_header(&mut self, line: &[u8]) -> Result<bool, String> {
        if line.is_empty() {
            self.state = NodeState::Body;
            return Ok(true);
        }
        self.header_size += line.len();
        if self.header_size > MAX_HEADERS_SIZE {
            return Err(format!(
                "Maximum header size of {MAX_HEADERS_SIZE} bytes exceeded"
            ));
        }
        self.header_lines
            .push(decode_text(encoding_rs::UTF_8, line));
        Ok(false)
    }

    pub(crate) fn feed_body(&mut self, line: &[u8]) {
        if let Some(decoder) = &mut self.decoder {
            decoder.update(line);
        }
    }

    pub(crate) fn finish_content(&mut self) {
        self.content = self.decoder.take().map(ContentDecoder::finalize);
        self.state = NodeState::Finished;
    }

    /// `getTextContent()`.
    pub(crate) fn text_content(&self) -> String {
        let Some(content) = &self.content else {
            return String::new();
        };
        let params = &self.content_type.parsed;
        let text = decode_text(decoder(params.param("charset")), content);
        if params
            .param("format")
            .is_some_and(|f| f.eq_ignore_ascii_case("flowed"))
        {
            let del_sp = params
                .param("delsp")
                .is_some_and(|d| d.eq_ignore_ascii_case("yes"));
            return decode_flowed(&text, del_sp);
        }
        text
    }
}

/// `str.replace(/\s+/g, ' ')`.
pub(crate) fn collapse_space(text: &str) -> String {
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

/// `decodeFlowedText(str, delSp)` (RFC 3676).
fn decode_flowed(text: &str, del_sp: bool) -> String {
    let mut lines = split_lines(text).into_iter();
    let mut acc = lines.next().unwrap_or_default().to_owned();
    for line in lines {
        let soft = acc.ends_with(' ') && !ends_with_signature(&acc);
        if soft {
            if del_sp {
                acc.pop();
            }
            acc.push_str(line);
        } else {
            acc.push('\n');
            acc.push_str(line);
        }
    }
    // `.replace(/^ /gm, '')`: one space stuffed at each line's start.
    let mut out = String::with_capacity(acc.len());
    for (i, line) in acc.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(line.strip_prefix(' ').unwrap_or(line));
    }
    out
}

/// `/(^|\n)-- $/`.
fn ends_with_signature(text: &str) -> bool {
    text == "-- " || text.ends_with("\n-- ")
}

/// `str.split(/\r?\n/)`.
fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn params_map(s: &Structured) -> BTreeMap<String, String> {
        s.params.iter().cloned().collect()
    }

    #[test]
    fn structured_headers() {
        let parsed = parse_structured("Text/Plain; charset=\"UTF-8\"; format=flowed (comment)");
        assert_eq!(parsed.value, "text/plain");
        assert_eq!(parsed.param("charset"), Some("UTF-8"));
        assert_eq!(parsed.param("format"), Some("flowed"));
        let parsed = parse_structured("attachment; filename*=UTF-8''na%C3%AFve.txt");
        assert_eq!(parsed.param("filename"), Some("naïve.txt"));
        let parsed = parse_structured("attachment; filename*0=\"long\"; filename*1=\"name.pdf\"");
        assert_eq!(
            params_map(&parsed).get("filename").map(String::as_str),
            Some("longname.pdf")
        );
    }

    #[test]
    fn flowed_text() {
        assert_eq!(decode_flowed("a \nb\nc", false), "a b\nc");
        assert_eq!(decode_flowed("a \nb", true), "ab");
        assert_eq!(decode_flowed("-- \nsig", false), "-- \nsig");
    }
}
