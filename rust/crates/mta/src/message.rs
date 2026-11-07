//! RFC 5322 messages as bytes: the header block, unfolded header values,
//! addresses, line endings, dot-stuffing, and a small MIME reader (content
//! types and multipart bodies) for the reports the return path receives.

/// One header field: its name as written, the raw bytes of the whole field
/// (folding and the final CRLF included) and the unfolded value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub name: String,
    pub raw: Vec<u8>,
    pub value: String,
}

/// The header block and the body, split at the first empty line. The header
/// block keeps its final CRLF; the body starts after the empty line.
pub fn split(raw: &[u8]) -> (&[u8], &[u8]) {
    if raw.starts_with(b"\r\n") {
        return (&raw[..0], &raw[2..]);
    }
    if let Some(at) = find(raw, b"\r\n\r\n") {
        return (&raw[..at + 2], &raw[at + 4..]);
    }
    if let Some(at) = find(raw, b"\n\n") {
        return (&raw[..=at], &raw[at + 2..]);
    }
    (raw, &raw[raw.len()..])
}

pub(crate) fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The header fields of a header block, in order. Lines that are neither a
/// field nor a continuation are skipped.
pub fn headers(block: &[u8]) -> Vec<Header> {
    let mut out: Vec<Header> = Vec::new();
    for line in block.split_inclusive(|&b| b == b'\n') {
        if line == b"\r\n" || line == b"\n" {
            break;
        }
        if matches!(line.first(), Some(b' ' | b'\t')) {
            if let Some(last) = out.last_mut() {
                last.raw.extend_from_slice(line);
                last.value
                    .push_str(&String::from_utf8_lossy(trim_eol(line)));
            }
            continue;
        }
        let Some(colon) = line.iter().position(|&b| b == b':') else {
            continue;
        };
        let name = String::from_utf8_lossy(&line[..colon]).trim().to_owned();
        if name.is_empty() || name.contains(' ') {
            continue;
        }
        out.push(Header {
            name,
            raw: line.to_vec(),
            value: String::from_utf8_lossy(trim_eol(&line[colon + 1..])).into_owned(),
        });
    }
    for header in &mut out {
        header.value = header.value.trim().to_owned();
    }
    out
}

fn trim_eol(line: &[u8]) -> &[u8] {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line)
}

/// The first value of the header `name` (case-insensitive).
pub fn header_value(block: &[u8], name: &str) -> Option<String> {
    headers(block)
        .into_iter()
        .find(|header| header.name.eq_ignore_ascii_case(name))
        .map(|header| header.value)
}

/// The address in a mailbox header value (`"Anna" <anna@acme.eu>`,
/// `anna@acme.eu (Anna)`, `<anna@acme.eu>`), lowercased; the first one of a
/// list.
pub fn first_address(value: &str) -> Option<String> {
    if let (Some(open), Some(close)) = (value.find('<'), value.find('>'))
        && open < close
    {
        let inner = value[open + 1..close].trim();
        return valid_address(inner).then(|| inner.to_lowercase());
    }
    let candidate = value
        .split(',')
        .next()?
        .split_whitespace()
        .find(|word| word.contains('@'))?
        .trim_matches(|c: char| c == '"' || c == '(' || c == ')' || c == ';');
    valid_address(candidate).then(|| candidate.to_lowercase())
}

/// `local@domain` with a dotted domain and nothing that breaks an SMTP
/// command.
pub fn valid_address(address: &str) -> bool {
    let Some((local, domain)) = address.rsplit_once('@') else {
        return false;
    };
    !local.is_empty()
        && local.len() <= 64
        && domain.contains('.')
        && domain.len() <= 253
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && address
            .chars()
            .all(|c| !c.is_control() && !c.is_whitespace() && !matches!(c, '<' | '>'))
}

/// The domain of an address, lowercased.
pub fn domain_of(address: &str) -> Option<String> {
    address
        .rsplit_once('@')
        .map(|(_, domain)| domain.trim_end_matches('.').to_ascii_lowercase())
}

/// Every bare LF becomes CRLF; a lone CR is left alone.
pub fn normalize_crlf(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + raw.len() / 50);
    let mut previous = 0u8;
    for &byte in raw {
        if byte == b'\n' && previous != b'\r' {
            out.push(b'\r');
        }
        out.push(byte);
        previous = byte;
    }
    out
}

/// The message as it goes on the wire after `DATA`: lines starting with a
/// dot get another, the last line ends in CRLF, then `.\r\n`.
pub fn dot_stuff(message: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(message.len() + 64);
    let mut at_line_start = true;
    for &byte in message {
        if at_line_start && byte == b'.' {
            out.push(b'.');
        }
        out.push(byte);
        at_line_start = byte == b'\n';
    }
    if !out.ends_with(b"\r\n") {
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b".\r\n");
    out
}

/// Whether the message has bytes outside 7-bit ASCII (`BODY=8BITMIME`).
pub fn is_8bit(message: &[u8]) -> bool {
    message.iter().any(|&b| b >= 0x80)
}

/// `name: value\r\n` in front of the message.
pub fn prepend_header(message: &[u8], name: &str, value: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(message.len() + name.len() + value.len() + 4);
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(b": ");
    out.extend_from_slice(value.as_bytes());
    out.extend_from_slice(b"\r\n");
    out.extend_from_slice(message);
    out
}

/// A `Content-Type` value: the lowercased `type/subtype` and its
/// parameters (names lowercased, quotes removed).
pub fn content_type(value: &str) -> (String, Vec<(String, String)>) {
    let mut parts = split_params(value).into_iter();
    let kind = parts.next().unwrap_or_default().trim().to_ascii_lowercase();
    let params = parts
        .filter_map(|param| {
            let (name, value) = param.split_once('=')?;
            Some((
                name.trim().to_ascii_lowercase(),
                value.trim().trim_matches('"').to_owned(),
            ))
        })
        .collect();
    (kind, params)
}

/// Splits on `;` outside quotes.
fn split_params(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in value.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                current.push(c);
            }
            ';' if !quoted => out.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    out.push(current);
    out
}

pub fn param<'a>(params: &'a [(String, String)], name: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// The parts of a multipart body (each with its own headers), between the
/// `--boundary` delimiters; the preamble and epilogue are dropped.
pub fn multipart_parts<'a>(body: &'a [u8], boundary: &str) -> Vec<&'a [u8]> {
    let delimiter = format!("--{boundary}");
    let mut parts = Vec::new();
    let mut start: Option<usize> = None;
    let mut pos = 0;
    for line in body.split_inclusive(|&b| b == b'\n') {
        let trimmed = trim_eol(line);
        let is_delimiter = trimmed.starts_with(delimiter.as_bytes())
            && trimmed[delimiter.len()..]
                .iter()
                .all(|b| *b == b'-' || b.is_ascii_whitespace());
        if is_delimiter {
            if let Some(begin) = start {
                // The CRLF before the delimiter belongs to it.
                let mut end = pos;
                if body[..end].ends_with(b"\r\n") {
                    end -= 2;
                } else if body[..end].ends_with(b"\n") {
                    end -= 1;
                }
                parts.push(&body[begin..end.max(begin)]);
            }
            let closing = trimmed[delimiter.len()..].starts_with(b"--");
            if closing {
                return parts;
            }
            start = Some(pos + line.len());
        }
        pos += line.len();
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_and_unfolds_headers() {
        let raw =
            b"From: \"Anna\" <Anna@Acme.EU>\r\nSubject: one\r\n two\r\nX-Empty:\r\n\r\nbody\r\n";
        let (block, body) = split(raw);
        assert_eq!(body, b"body\r\n");
        let fields = headers(block);
        assert_eq!(fields.len(), 3);
        assert_eq!(fields[1].value, "one two");
        assert_eq!(fields[1].raw, b"Subject: one\r\n two\r\n");
        assert_eq!(fields[2].value, "");
        assert_eq!(
            header_value(block, "from").as_deref(),
            Some("\"Anna\" <Anna@Acme.EU>")
        );
    }

    #[test]
    fn reads_addresses() {
        assert_eq!(
            first_address("\"Anna\" <Anna@Acme.EU>").as_deref(),
            Some("anna@acme.eu")
        );
        assert_eq!(
            first_address("anna@acme.eu (Anna)").as_deref(),
            Some("anna@acme.eu")
        );
        assert_eq!(first_address("a@b.eu, c@d.eu").as_deref(), Some("a@b.eu"));
        assert_eq!(first_address("undisclosed-recipients:;"), None);
        assert_eq!(first_address("<bad>"), None);
        assert!(!valid_address("a b@c.eu"));
        assert!(!valid_address("a@localhost"));
        assert_eq!(domain_of("x@Acme.EU.").as_deref(), Some("acme.eu"));
    }

    #[test]
    fn stuffs_dots_and_ends_the_data() {
        assert_eq!(dot_stuff(b".a\r\nb\r\n..c"), b"..a\r\nb\r\n...c\r\n.\r\n");
        assert_eq!(dot_stuff(b"x\r\n"), b"x\r\n.\r\n");
        assert_eq!(normalize_crlf(b"a\nb\r\nc"), b"a\r\nb\r\nc");
    }

    #[test]
    fn reads_content_types_and_multipart_bodies() {
        let (kind, params) =
            content_type("multipart/report; report-type=\"delivery-status\"; boundary=\"b;1\"");
        assert_eq!(kind, "multipart/report");
        assert_eq!(param(&params, "report-type"), Some("delivery-status"));
        assert_eq!(param(&params, "boundary"), Some("b;1"));
        let body = b"preamble\r\n--b;1\r\nContent-Type: text/plain\r\n\r\none\r\n--b;1\r\n\r\ntwo\r\n--b;1--\r\nepilogue\r\n";
        let parts = multipart_parts(body, "b;1");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], b"Content-Type: text/plain\r\n\r\none");
        assert_eq!(parts[1], b"\r\ntwo");
    }
}
