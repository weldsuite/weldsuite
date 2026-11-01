//! Reading a received NF-e (layout 4.00; books-api's `br-fiscal/nfe-xml`):
//! the same small XML reader (elements, attributes, text, CDATA, the five
//! predefined entities and numeric references; DOCTYPEs and custom entities
//! never expanded) and what a purchase needs from the note.

use serde_json::{Value, json};
use weldsuite_books_domain::js::{self, number_value as n};
use weldsuite_books_domain::jurisdictions::is_js_space;

/// `XmlParseError`, or a failure JavaScript throws outside it (a numeric
/// reference past U+10FFFF).
#[derive(Debug, Clone)]
pub(crate) enum XmlError {
    Parse(String),
    Fatal(String),
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
    pub text: String,
}

impl Node {
    fn attr(&self, name: &str) -> Option<&str> {
        // `attrs[name]`: a later attribute of the same name wins.
        self.attrs
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

fn decode(text: &str) -> Result<String, XmlError> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 1..];
        let body_len = if let Some(hex) = tail.strip_prefix("#x") {
            let digits = hex.bytes().take_while(u8::is_ascii_hexdigit).count();
            (digits > 0).then_some(2 + digits)
        } else if let Some(dec) = tail.strip_prefix('#') {
            let digits = dec.bytes().take_while(u8::is_ascii_digit).count();
            (digits > 0).then_some(1 + digits)
        } else {
            let letters = tail.bytes().take_while(u8::is_ascii_alphabetic).count();
            (letters > 0).then_some(letters)
        };
        match body_len {
            Some(len) if tail.as_bytes().get(len) == Some(&b';') => {
                let body = &tail[..len];
                let replaced = if let Some(hex) = body.strip_prefix("#x") {
                    Some(code_point(u64::from_str_radix(hex, 16).unwrap_or(u64::MAX))?)
                } else if let Some(dec) = body.strip_prefix('#') {
                    Some(code_point(dec.parse::<u64>().unwrap_or(u64::MAX))?)
                } else {
                    match body {
                        "amp" => Some("&".to_owned()),
                        "lt" => Some("<".to_owned()),
                        "gt" => Some(">".to_owned()),
                        "quot" => Some("\"".to_owned()),
                        "apos" => Some("'".to_owned()),
                        _ => None,
                    }
                };
                match replaced {
                    Some(text) => out.push_str(&text),
                    None => {
                        out.push('&');
                        out.push_str(body);
                        out.push(';');
                    }
                }
                rest = &tail[len + 1..];
            }
            _ => {
                out.push('&');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// `String.fromCodePoint(n)`: a lone surrogate becomes U+FFFD here.
fn code_point(value: u64) -> Result<String, XmlError> {
    if value > 0x0010_FFFF {
        return Err(XmlError::Fatal(format!("Invalid code point {value}")));
    }
    let c = u32::try_from(value)
        .ok()
        .and_then(char::from_u32)
        .unwrap_or('\u{fffd}');
    Ok(c.to_string())
}

fn local_name(name: &str) -> String {
    name.split_once(':')
        .map_or(name, |(_, local)| local)
        .to_owned()
}

enum Token {
    Text(String),
    Open {
        name: String,
        attrs: Vec<(String, String)>,
        self_closing: bool,
    },
    Close(String),
}

fn is_name_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '.' | '-')
}

struct Scanner<'a> {
    xml: &'a [char],
}

impl Scanner<'_> {
    fn starts_with(&self, at: usize, text: &str) -> bool {
        let chars: Vec<char> = text.chars().collect();
        self.xml.get(at..at + chars.len()) == Some(chars.as_slice())
    }

    fn index_of(&self, text: &str, from: usize) -> Option<usize> {
        let chars: Vec<char> = text.chars().collect();
        (from..=self.xml.len().saturating_sub(chars.len()))
            .find(|&i| self.xml.get(i..i + chars.len()) == Some(chars.as_slice()))
    }

    fn slice(&self, from: usize, to: usize) -> String {
        self.xml[from..to].iter().collect()
    }

    fn skip(&self, from: usize, matches: impl Fn(char) -> bool, stop: bool) -> usize {
        let mut i = from;
        while i < self.xml.len() && matches(self.xml[i]) != stop {
            i += 1;
        }
        i
    }

    fn delimited(&self, pos: usize, open: &str, close: &str) -> Option<(String, usize)> {
        if !self.starts_with(pos, open) {
            return None;
        }
        let start = pos + open.chars().count();
        let at = self.index_of(close, start)?;
        Some((self.slice(start, at), at + close.chars().count()))
    }

    fn attribute(&self, from: usize) -> Option<(String, String, usize)> {
        let name_start = self.skip(from, is_js_space, false);
        if name_start == from {
            return None;
        }
        let name_end = self.skip(
            name_start,
            |c| is_js_space(c) || matches!(c, '=' | '/' | '>'),
            true,
        );
        if name_end == name_start {
            return None;
        }
        let equals = self.skip(name_end, is_js_space, false);
        if self.xml.get(equals) != Some(&'=') {
            return None;
        }
        let value_start = self.skip(equals + 1, is_js_space, false);
        let quote = *self.xml.get(value_start)?;
        if quote != '"' && quote != '\'' {
            return None;
        }
        let value_end = (value_start + 1..self.xml.len()).find(|&i| self.xml[i] == quote)?;
        Some((
            self.slice(name_start, name_end),
            self.slice(value_start + 1, value_end),
            value_end + 1,
        ))
    }

    fn tag(&self, pos: usize) -> Option<(Token, usize)> {
        let mut i = pos + 1;
        let closing = self.xml.get(i) == Some(&'/');
        if closing {
            i += 1;
        }
        if i >= self.xml.len() || !is_name_start(self.xml[i]) {
            return None;
        }
        let name_start = i;
        i = self.skip(i + 1, is_name_char, false);
        let name = self.slice(name_start, i);
        let mut attrs = Vec::new();
        while let Some((name, value, end)) = self.attribute(i) {
            attrs.push((name, value));
            i = end;
        }
        i = self.skip(i, is_js_space, false);
        let self_closing = self.xml.get(i) == Some(&'/');
        if self_closing {
            i += 1;
        }
        if self.xml.get(i) != Some(&'>') {
            return None;
        }
        let token = if closing {
            Token::Close(name)
        } else {
            Token::Open {
                name,
                attrs,
                self_closing,
            }
        };
        Some((token, i + 1))
    }

    fn at(&self, pos: usize) -> Result<(Option<Token>, usize), XmlError> {
        if self.xml[pos] != '<' {
            let end = self.index_of("<", pos).unwrap_or(self.xml.len());
            return Ok((Some(Token::Text(decode(&self.slice(pos, end))?)), end));
        }
        if let Some((inner, end)) = self.delimited(pos, "<![CDATA[", "]]>") {
            return Ok((Some(Token::Text(inner)), end));
        }
        if let Some((_, end)) = self
            .delimited(pos, "<!--", "-->")
            .or_else(|| self.delimited(pos, "<?", "?>"))
            .or_else(|| self.delimited(pos, "<!DOCTYPE", ">"))
        {
            return Ok((None, end));
        }
        Ok(self
            .tag(pos)
            .map_or((None, pos + 1), |(token, end)| (Some(token), end)))
    }
}

/// `parseXml(xml)`: the root element.
pub(crate) fn parse_xml(xml: &str) -> Result<Node, XmlError> {
    let chars: Vec<char> = xml.chars().collect();
    let scanner = Scanner { xml: &chars };
    let mut stack: Vec<Node> = vec![Node {
        name: "#document".into(),
        ..Node::default()
    }];
    let mut pos = 0;
    while pos < chars.len() {
        let (token, end) = scanner.at(pos)?;
        pos = end;
        let Some(token) = token else { continue };
        match token {
            Token::Text(text) => {
                if let Some(top) = stack.last_mut() {
                    top.text.push_str(&text);
                }
            }
            Token::Close(name) => {
                let matches = stack.len() > 1
                    && stack.last().is_some_and(|top| top.name == local_name(&name));
                if !matches {
                    return Err(XmlError::Parse(format!("Unexpected closing tag </{name}>")));
                }
                let node = stack.pop().unwrap_or_default();
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(node);
                }
            }
            Token::Open {
                name,
                attrs,
                self_closing,
            } => {
                let mut decoded = Vec::with_capacity(attrs.len());
                for (key, raw) in attrs {
                    decoded.push((local_name(&key), decode(&raw)?));
                }
                let node = Node {
                    name: local_name(&name),
                    attrs: decoded,
                    children: Vec::new(),
                    text: String::new(),
                };
                if self_closing {
                    if let Some(top) = stack.last_mut() {
                        top.children.push(node);
                    }
                } else {
                    stack.push(node);
                }
            }
        }
    }
    if stack.len() > 1 {
        let name = stack.last().map(|n| n.name.clone()).unwrap_or_default();
        return Err(XmlError::Parse(format!("Unclosed tag <{name}>")));
    }
    stack
        .pop()
        .and_then(|root| root.children.into_iter().next())
        .ok_or_else(|| XmlError::Parse("The file has no XML element".into()))
}

fn child<'a>(node: Option<&'a Node>, name: &str) -> Option<&'a Node> {
    node?.children.iter().find(|c| c.name == name)
}

fn children_of<'a>(node: Option<&'a Node>, name: &str) -> Vec<&'a Node> {
    node.map(|n| n.children.iter().filter(|c| c.name == name).collect())
        .unwrap_or_default()
}

fn find<'a>(node: Option<&'a Node>, name: &str) -> Option<&'a Node> {
    let node = node?;
    if node.name == name {
        return Some(node);
    }
    node.children.iter().find_map(|c| find(Some(c), name))
}

fn text_at(node: Option<&Node>, path: &[&str]) -> Option<String> {
    let mut current = node;
    for name in path {
        current = child(current, name);
    }
    let text = weldsuite_books_domain::jurisdictions::js_trim(&current?.text).to_owned();
    (!text.is_empty()).then_some(text)
}

fn number_at(node: Option<&Node>, path: &[&str]) -> f64 {
    let parsed = js::parse_float(&text_at(node, path).unwrap_or_default());
    if parsed.is_finite() { parsed } else { 0.0 }
}

fn tax_of(group: Option<&Node>, rate_tag: &str, value_tag: &str) -> Value {
    let variant = group.and_then(|g| {
        g.children
            .iter()
            .find(|c| child(Some(c), "CST").is_some() || child(Some(c), "CSOSN").is_some())
    });
    json!({
        "cst": text_at(variant, &["CST"]).or_else(|| text_at(variant, &["CSOSN"])),
        "base": n(number_at(variant, &["vBC"])),
        "rate": n(number_at(variant, &[rate_tag])),
        "value": n(number_at(variant, &[value_tag])),
    })
}

fn strip_zeros(value: Option<String>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    let stripped = value.trim_start_matches('0');
    Some(if stripped.is_empty() { "0".into() } else { stripped.into() })
}

/// `parseNfeXml(xml)`: the note as `ParsedNfe` (JSON, as it is stored).
pub(crate) fn parse_nfe(xml: &str) -> Result<Value, XmlError> {
    let root = parse_xml(xml)?;
    let root = Some(&root);
    let Some(inf) = find(root, "infNFe") else {
        return Err(XmlError::Parse(
            "This is not an NF-e: it has no infNFe element".into(),
        ));
    };
    let inf = Some(inf);
    let id = inf.and_then(|i| i.attr("Id")).unwrap_or_default();
    let from_id = id.strip_prefix("NFe").unwrap_or(id).to_owned();
    let access_key = if from_id.is_empty() {
        text_at(find(root, "infProt"), &["chNFe"]).unwrap_or_default()
    } else {
        from_id
    };
    if !(access_key.len() == 44 && access_key.bytes().all(|b| b.is_ascii_digit())) {
        return Err(XmlError::Parse(
            "The NF-e has no valid 44-digit access key".into(),
        ));
    }
    let ide = child(inf, "ide");
    let emit = child(inf, "emit");
    let dest = child(inf, "dest");
    let total = child(child(inf, "total"), "ICMSTot");
    let issued = text_at(ide, &["dhEmi"]).or_else(|| text_at(ide, &["dEmi"]));

    let items: Vec<Value> = children_of(inf, "det")
        .into_iter()
        .enumerate()
        .map(|(index, det)| {
            let prod = child(Some(det), "prod");
            let imposto = child(Some(det), "imposto");
            let icms = child(imposto, "ICMS");
            let number = det
                .attr("nItem")
                .and_then(js::parse_int)
                .filter(|v| *v != 0)
                .unwrap_or_else(|| i64::try_from(index + 1).unwrap_or(0));
            json!({
                "number": number,
                "code": text_at(prod, &["cProd"]).unwrap_or_default(),
                "description": text_at(prod, &["xProd"]).unwrap_or_default(),
                "ncm": text_at(prod, &["NCM"]).unwrap_or_default(),
                "cfop": text_at(prod, &["CFOP"]).unwrap_or_default(),
                "unit": text_at(prod, &["uCom"]).unwrap_or_else(|| "UN".into()),
                "quantity": n(number_at(prod, &["qCom"])),
                "unitPrice": n(number_at(prod, &["vUnCom"])),
                "total": n(number_at(prod, &["vProd"])),
                "discount": n(number_at(prod, &["vDesc"])),
                "origin": text_at(icms.and_then(|g| g.children.first()), &["orig"]),
                "icms": tax_of(icms, "pICMS", "vICMS"),
                "ipi": tax_of(child(imposto, "IPI"), "pIPI", "vIPI"),
                "pis": tax_of(child(imposto, "PIS"), "pPIS", "vPIS"),
                "cofins": tax_of(child(imposto, "COFINS"), "pCOFINS", "vCOFINS"),
            })
        })
        .collect();

    Ok(json!({
        "accessKey": access_key,
        "issuer": {
            "taxId": text_at(emit, &["CNPJ"]).or_else(|| text_at(emit, &["CPF"])),
            "name": text_at(emit, &["xNome"]),
            "tradeName": text_at(emit, &["xFant"]),
            "stateRegistration": text_at(emit, &["IE"]),
            "uf": text_at(emit, &["enderEmit", "UF"]),
        },
        "recipient": {
            "taxId": text_at(dest, &["CNPJ"]).or_else(|| text_at(dest, &["CPF"])),
            "name": text_at(dest, &["xNome"]),
        },
        "number": strip_zeros(text_at(ide, &["nNF"])),
        "series": strip_zeros(text_at(ide, &["serie"])),
        "issueDate": issued.map(|d| js::slice_utf16(&d, 10)),
        "operation": text_at(ide, &["natOp"]),
        "total": n(number_at(total, &["vNF"])),
        "products": n(number_at(total, &["vProd"])),
        "discount": n(number_at(total, &["vDesc"])),
        "freight": n(number_at(total, &["vFrete"])),
        "insurance": n(number_at(total, &["vSeg"])),
        "other": n(number_at(total, &["vOutro"])),
        "icmsSt": n(number_at(total, &["vST"])),
        "ipi": n(number_at(total, &["vIPI"])),
        "installments": children_of(child(inf, "cobr"), "dup").into_iter().map(|dup| json!({
            "number": text_at(Some(dup), &["nDup"]).unwrap_or_default(),
            "dueDate": text_at(Some(dup), &["dVenc"]),
            "amount": n(number_at(Some(dup), &["vDup"])),
        })).collect::<Vec<_>>(),
        "payments": children_of(child(inf, "pag"), "detPag").into_iter().map(|p| json!({
            "method": text_at(Some(p), &["tPag"]).unwrap_or_default(),
            "amount": n(number_at(Some(p), &["vPag"])),
        })).collect::<Vec<_>>(),
        "protocol": text_at(find(root, "infProt"), &["nProt"]),
        "items": items,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_elements_entities_and_errors() {
        let root = parse_xml("<?xml version=\"1.0\"?><a x='1'><b>Porca &lt;M8&gt; &#65;</b><c/><![CDATA[x<y]]></a>")
            .expect("parses");
        assert_eq!(root.name, "a");
        assert_eq!(root.children[0].text, "Porca <M8> A");
        assert_eq!(root.text, "x<y");
        assert!(matches!(parse_xml("<a></b>"), Err(XmlError::Parse(m)) if m == "Unexpected closing tag </b>"));
        assert!(matches!(parse_xml("<a>"), Err(XmlError::Parse(m)) if m == "Unclosed tag <a>"));
        assert!(matches!(parse_xml("text"), Err(XmlError::Parse(_))));
        assert!(matches!(parse_nfe("<invoice/>"), Err(XmlError::Parse(m)) if m.contains("infNFe")));
    }
}
