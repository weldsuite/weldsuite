//! postal-mime's `address-parser.js`: address headers into names and
//! addresses, groups included.

use super::decode::{decode_words, is_js_space, js_trim};

/// One parsed address, or a group of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailAddress {
    pub name: String,
    /// `None` for a group.
    pub address: Option<String>,
    /// The members, for a group.
    pub group: Option<Vec<MailAddress>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    Operator,
    Text,
}

#[derive(Debug, Clone)]
struct Token {
    kind: Kind,
    value: String,
    no_break: bool,
}

/// `Tokenizer`.
fn tokenize(text: &str) -> Vec<Token> {
    let chars: Vec<char> = text.chars().collect();
    let mut list: Vec<Token> = Vec::new();
    let mut node: Option<usize> = None;
    let mut expecting: Option<char> = None;
    let mut escaped = false;
    let operator_end = |c: char| -> Option<Option<char>> {
        match c {
            '"' => Some(Some('"')),
            '(' => Some(Some(')')),
            '<' => Some(Some('>')),
            ':' => Some(Some(';')),
            ',' | ';' => Some(None),
            _ => None,
        }
    };
    for (i, &c) in chars.iter().enumerate() {
        let next = chars.get(i + 1).copied();
        if !escaped {
            if Some(c) == expecting {
                list.push(Token {
                    kind: Kind::Operator,
                    value: c.to_string(),
                    no_break: next
                        .is_some_and(|n| !matches!(n, ' ' | '\t' | '\r' | '\n' | ',' | ';')),
                });
                node = None;
                expecting = None;
                escaped = false;
                continue;
            }
            if expecting.is_none()
                && let Some(end) = operator_end(c)
            {
                list.push(Token {
                    kind: Kind::Operator,
                    value: c.to_string(),
                    no_break: false,
                });
                node = None;
                expecting = end;
                escaped = false;
                continue;
            }
            if matches!(expecting, Some('"' | '\'')) && c == '\\' {
                escaped = true;
                continue;
            }
        }
        let index = if let Some(index) = node {
            index
        } else {
            list.push(Token {
                kind: Kind::Text,
                value: String::new(),
                no_break: false,
            });
            node = Some(list.len() - 1);
            list.len() - 1
        };
        let c = if c == '\n' { ' ' } else { c };
        // `chr.charCodeAt(0) >= 0x21 || [' ', '\t'].includes(chr)`.
        if u32::from(c) >= 0x21 || c == ' ' || c == '\t' {
            list[index].value.push(c);
        }
        escaped = false;
    }
    list.into_iter()
        .filter_map(|mut token| {
            let trimmed = js_trim(&token.value).to_owned();
            token.value = trimmed;
            (!token.value.is_empty()).then_some(token)
        })
        .collect()
}

/// `/^[^@\s]+@[^@\s]+$/`.
fn is_bare_address(text: &str) -> bool {
    let Some((local, domain)) = text.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && !local.chars().any(is_js_space)
        && !domain.chars().any(|c| c == '@' || is_js_space(c))
}

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `text.replace(/\s*\b[^@\s]+@[^\s]+\b\s*/, …)`: the first match's range
/// and the address inside it.
fn find_embedded(text: &str) -> Option<(usize, usize)> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let at = |i: usize| chars.get(i).map(|(_, c)| *c);
    let byte = |i: usize| chars.get(i).map_or(text.len(), |(b, _)| *b);
    for start in 0..chars.len() {
        let mut q = start;
        while at(q).is_some_and(is_js_space) {
            q += 1;
        }
        // `\b` before the local part.
        if is_word(q.checked_sub(1).and_then(at)) == is_word(at(q)) {
            continue;
        }
        let mut local_end = q;
        while at(local_end).is_some_and(|c| c != '@' && !is_js_space(c)) {
            local_end += 1;
        }
        if local_end == q || at(local_end) != Some('@') {
            continue;
        }
        let domain_start = local_end + 1;
        let mut run_end = domain_start;
        while at(run_end).is_some_and(|c| !is_js_space(c)) {
            run_end += 1;
        }
        let mut end = None;
        let mut e = run_end;
        while e > domain_start {
            if is_word(at(e - 1)) != is_word(at(e)) {
                end = Some(e);
                break;
            }
            e -= 1;
        }
        let Some(mut end) = end else {
            continue;
        };
        while at(end).is_some_and(is_js_space) {
            end += 1;
        }
        return Some((byte(start), byte(end)));
    }
    None
}

/// `/^=\?[^=]+?=$/`.
fn looks_encoded(text: &str) -> bool {
    text.len() > 3
        && text.starts_with("=?")
        && text.ends_with('=')
        && !text[2..text.len() - 1].contains('=')
}

#[derive(Default)]
struct Data {
    address: Vec<String>,
    comment: Vec<String>,
    group: Vec<String>,
    text: Vec<String>,
    text_was_quoted: Vec<bool>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Address,
    Comment,
    Group,
    Text,
}

impl Data {
    fn list(&mut self, state: State) -> &mut Vec<String> {
        match state {
            State::Address => &mut self.address,
            State::Comment => &mut self.comment,
            State::Group => &mut self.group,
            State::Text => &mut self.text,
        }
    }
}

/// `_handleAddress(tokens, depth)`.
#[allow(clippy::too_many_lines)] // the JavaScript function, step by step
fn handle_address(tokens: &[Token], depth: usize) -> Vec<MailAddress> {
    let mut is_group = false;
    let mut state = State::Text;
    let mut data = Data::default();
    let mut inside_quotes = false;
    for (i, token) in tokens.iter().enumerate() {
        let prev = i.checked_sub(1).map(|p| &tokens[p]);
        if token.kind == Kind::Operator {
            match token.value.as_str() {
                "<" => {
                    state = State::Address;
                    inside_quotes = false;
                }
                "(" => {
                    state = State::Comment;
                    inside_quotes = false;
                }
                ":" => {
                    state = State::Group;
                    is_group = true;
                    inside_quotes = false;
                }
                "\"" => {
                    inside_quotes = !inside_quotes;
                    state = State::Text;
                }
                _ => {
                    state = State::Text;
                    inside_quotes = false;
                }
            }
            continue;
        }
        let mut value = token.value.clone();
        if value.is_empty() {
            continue;
        }
        if state == State::Address {
            // `token.value.replace(/^[^<]*<\s*/, '')`.
            if let Some(lt) = value.find('<') {
                let rest = &value[lt + 1..];
                let stripped = rest.trim_start_matches(is_js_space).to_owned();
                value = stripped;
            }
        }
        let join = prev.is_some_and(|p| p.no_break) && !data.list(state).is_empty();
        if join {
            if let Some(last) = data.list(state).last_mut() {
                last.push_str(&value);
            }
            if state == State::Text
                && inside_quotes
                && let Some(last) = data.text_was_quoted.last_mut()
            {
                *last = true;
            }
        } else {
            data.list(state).push(value);
            if state == State::Text {
                data.text_was_quoted.push(inside_quotes);
            }
        }
    }

    if data.text.is_empty() && !data.comment.is_empty() {
        data.text = std::mem::take(&mut data.comment);
    }

    if is_group {
        let text = data.text.join(" ");
        let mut members = Vec::new();
        if !data.group.is_empty() {
            for member in parse_depth(&data.group.join(","), depth + 1) {
                match member.group {
                    Some(group) => members.extend(group),
                    None => members.push(member),
                }
            }
        }
        return vec![MailAddress {
            name: decode_words(&text),
            address: None,
            group: Some(members),
        }];
    }

    if data.address.is_empty() && !data.text.is_empty() {
        for i in (0..data.text.len()).rev() {
            let quoted = data.text_was_quoted.get(i).copied().unwrap_or(false);
            if !quoted && is_bare_address(&data.text[i]) {
                data.address = vec![data.text.remove(i)];
                if i < data.text_was_quoted.len() {
                    data.text_was_quoted.remove(i);
                }
                break;
            }
        }
        if data.address.is_empty() {
            for i in (0..data.text.len()).rev() {
                let quoted = data.text_was_quoted.get(i).copied().unwrap_or(false);
                if quoted {
                    continue;
                }
                if let Some((start, end)) = find_embedded(&data.text[i]) {
                    let matched = data.text[i][start..end].to_owned();
                    data.address = vec![js_trim(&matched).to_owned()];
                    let replaced = format!("{} {}", &data.text[i][..start], &data.text[i][end..]);
                    js_trim(&replaced).clone_into(&mut data.text[i]);
                } else {
                    let trimmed = js_trim(&data.text[i]).to_owned();
                    data.text[i] = trimmed;
                }
                if !data.address.is_empty() {
                    break;
                }
            }
        }
    }

    if data.text.is_empty() && !data.comment.is_empty() {
        data.text = std::mem::take(&mut data.comment);
    }
    if data.address.len() > 1 {
        let rest = data.address.split_off(1);
        data.text.extend(rest);
    }
    let text = data.text.join(" ");
    let address = data.address.join(" ");

    if address.is_empty() && looks_encoded(js_trim(&text)) {
        let parsed = parse_depth(&decode_words(&text), 0);
        if !parsed.is_empty() {
            return parsed;
        }
    }

    let mut out_address = if address.is_empty() {
        text.clone()
    } else {
        address.clone()
    };
    let mut name = decode_words(if text.is_empty() { &address } else { &text });
    if out_address == name {
        if out_address.contains('@') {
            name = String::new();
        } else {
            out_address = String::new();
        }
    }
    vec![MailAddress {
        name,
        address: Some(out_address),
        group: None,
    }]
}

/// Nested groups go no deeper than this.
const MAX_NESTED_GROUP_DEPTH: usize = 50;

fn parse_depth(text: &str, depth: usize) -> Vec<MailAddress> {
    if depth > MAX_NESTED_GROUP_DEPTH {
        return Vec::new();
    }
    let tokens = tokenize(text);
    let mut addresses: Vec<Vec<Token>> = Vec::new();
    let mut current: Vec<Token> = Vec::new();
    for token in tokens {
        if token.kind == Kind::Operator && (token.value == "," || token.value == ";") {
            if !current.is_empty() {
                addresses.push(std::mem::take(&mut current));
            }
        } else {
            current.push(token);
        }
    }
    if !current.is_empty() {
        addresses.push(current);
    }
    addresses
        .iter()
        .flat_map(|tokens| handle_address(tokens, depth))
        .collect()
}

/// `addressParser(str)`.
pub fn parse_addresses(text: &str) -> Vec<MailAddress> {
    parse_depth(text, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn simple(name: &str, address: &str) -> MailAddress {
        MailAddress {
            name: name.to_owned(),
            address: Some(address.to_owned()),
            group: None,
        }
    }

    #[test]
    fn names_and_addresses() {
        assert_eq!(
            parse_addresses("Jane Doe <jane@example.com>, bob@example.com"),
            vec![
                simple("Jane Doe", "jane@example.com"),
                simple("", "bob@example.com")
            ]
        );
        assert_eq!(
            parse_addresses("\"Doe, Jane\" <jane@example.com>"),
            vec![simple("Doe, Jane", "jane@example.com")]
        );
        assert_eq!(
            parse_addresses("jane@example.com (Jane)"),
            vec![simple("Jane", "jane@example.com")]
        );
    }

    #[test]
    fn groups() {
        let parsed = parse_addresses("Team: a@x.com, b@x.com;");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "Team");
        assert_eq!(
            parsed[0].group.as_deref(),
            Some(&[simple("", "a@x.com"), simple("", "b@x.com")][..])
        );
    }

    #[test]
    fn encoded_names() {
        assert_eq!(
            parse_addresses("=?utf-8?Q?J=C3=B6rg?= <j@x.de>"),
            vec![simple("Jörg", "j@x.de")]
        );
    }
}
