//! The SOAP messages this crate sends, built as a tree of namespaced
//! elements and written straight into Exclusive XML Canonicalization 1.0
//! (<https://www.w3.org/TR/xml-exc-c14n/>, without `InclusiveNamespaces`),
//! so a signed subtree digests to the same bytes on both ends without a
//! canonicalizing parser here. The port of
//! `packages/domains/payroll/src/nl/xmldsig.ts`:
//!
//! - a namespace is declared on an element only when the element or one of
//!   its attributes uses the prefix and no output ancestor already declared
//!   it with the same URI;
//! - declarations first (the default namespace first, then by prefix), then
//!   attributes by namespace URI and local name (unqualified first);
//! - start and end tags for empty elements, no XML declaration, no
//!   whitespace between elements; text and attribute values escaped as C14N
//!   prescribes.
//!
//! The answers are read with [`text_of`] and [`blocks`]: Digipoort's
//! responses are small and flat, so a namespace-agnostic match by local name
//! is enough, as in the TypeScript client.

use std::collections::BTreeMap;
use std::fmt::Write as _;

/// An attribute; `namespace` is `(prefix, uri)` for a qualified one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attribute {
    pub namespace: Option<(String, String)>,
    pub name: String,
    pub value: String,
}

/// A child of an [`Element`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    Element(Element),
    Text(String),
}

/// A namespaced element. An unqualified element has an empty prefix and
/// namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Element {
    pub namespace: String,
    pub prefix: String,
    pub name: String,
    pub attributes: Vec<Attribute>,
    pub children: Vec<Node>,
}

impl Element {
    pub fn new(namespace: &str, prefix: &str, name: &str) -> Self {
        Self {
            namespace: namespace.to_owned(),
            prefix: prefix.to_owned(),
            name: name.to_owned(),
            attributes: Vec::new(),
            children: Vec::new(),
        }
    }

    /// Appends a child element.
    #[must_use]
    pub fn child(mut self, element: Element) -> Self {
        self.children.push(Node::Element(element));
        self
    }

    /// Appends text.
    #[must_use]
    pub fn text(mut self, text: impl Into<String>) -> Self {
        self.children.push(Node::Text(text.into()));
        self
    }

    /// Adds an unqualified attribute.
    #[must_use]
    pub fn attr(mut self, name: &str, value: impl Into<String>) -> Self {
        self.attributes.push(Attribute {
            namespace: None,
            name: name.to_owned(),
            value: value.into(),
        });
        self
    }

    /// Adds a namespaced attribute (`prefix:name`).
    #[must_use]
    pub fn ns_attr(
        mut self,
        prefix: &str,
        uri: &str,
        name: &str,
        value: impl Into<String>,
    ) -> Self {
        self.attributes.push(Attribute {
            namespace: Some((prefix.to_owned(), uri.to_owned())),
            name: name.to_owned(),
            value: value.into(),
        });
        self
    }

    /// The element as the apex of an exclusive-canonical node-set.
    pub fn canonical(&self) -> String {
        let mut out = String::new();
        write(self, &BTreeMap::new(), &mut out);
        out
    }

    fn qname(&self) -> String {
        if self.prefix.is_empty() {
            self.name.clone()
        } else {
            format!("{}:{}", self.prefix, self.name)
        }
    }
}

/// `escText`: what C14N escapes in text.
fn escape_text(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\r' => out.push_str("&#xD;"),
            _ => out.push(c),
        }
    }
}

/// `escAttr`: what C14N escapes in attribute values.
fn escape_attribute(value: &str, out: &mut String) {
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '"' => out.push_str("&quot;"),
            '\t' => out.push_str("&#x9;"),
            '\n' => out.push_str("&#xA;"),
            '\r' => out.push_str("&#xD;"),
            _ => out.push(c),
        }
    }
}

/// `canonicalize(node, inScope)`: `in_scope` holds the declarations output
/// ancestors already wrote (prefix → URI).
fn write(element: &Element, in_scope: &BTreeMap<String, String>, out: &mut String) {
    let mut scope = in_scope.clone();
    // No default namespace in scope is the same as xmlns="": an unqualified
    // name needs no declaration.
    scope.entry(String::new()).or_default();
    let mut declarations: Vec<(String, String)> = Vec::new();
    let mut need = |prefix: &str, uri: &str, scope: &mut BTreeMap<String, String>| {
        if scope.get(prefix).map(String::as_str) != Some(uri) {
            scope.insert(prefix.to_owned(), uri.to_owned());
            declarations.push((prefix.to_owned(), uri.to_owned()));
        }
    };
    need(&element.prefix, &element.namespace, &mut scope);
    for attribute in &element.attributes {
        if let Some((prefix, uri)) = &attribute.namespace
            && !prefix.is_empty()
        {
            need(prefix, uri, &mut scope);
        }
    }
    // The default namespace ("") sorts before every prefix.
    declarations.sort_by(|a, b| a.0.cmp(&b.0));
    let mut attributes: Vec<&Attribute> = element.attributes.iter().collect();
    attributes.sort_by(|a, b| {
        let uri = |x: &Attribute| {
            x.namespace
                .as_ref()
                .map_or("", |(_, uri)| uri.as_str())
                .to_owned()
        };
        uri(a).cmp(&uri(b)).then_with(|| a.name.cmp(&b.name))
    });
    let qname = element.qname();
    out.push('<');
    out.push_str(&qname);
    for (prefix, uri) in &declarations {
        if prefix.is_empty() {
            out.push_str(" xmlns=\"");
        } else {
            let _ = write!(out, " xmlns:{prefix}=\"");
        }
        escape_attribute(uri, out);
        out.push('"');
    }
    for attribute in attributes {
        out.push(' ');
        if let Some((prefix, _)) = &attribute.namespace
            && !prefix.is_empty()
        {
            out.push_str(prefix);
            out.push(':');
        }
        out.push_str(&attribute.name);
        out.push_str("=\"");
        escape_attribute(&attribute.value, out);
        out.push('"');
    }
    out.push('>');
    for child in &element.children {
        match child {
            Node::Text(text) => escape_text(text, out),
            Node::Element(child) => write(child, &scope, out),
        }
    }
    out.push_str("</");
    out.push_str(&qname);
    out.push('>');
}

// ── Reading answers ─────────────────────────────────────────────────────────

fn element_pattern(local: &str, capture: bool) -> Option<regex::Regex> {
    let body = if capture { "(.*?)" } else { ".*?" };
    regex::Regex::new(&format!(
        r"(?s)<(?:[A-Za-z0-9_.-]+:)?{local}(?:[ \t\r\n][^>]*)?>{body}</(?:[A-Za-z0-9_.-]+:)?{local}>"
    ))
    .ok()
}

/// The text of the first element named `local` (any prefix): entities
/// decoded, CDATA sections taken as written (the receiving party's answer
/// in `statusdetails` comes in one).
pub fn text_of(xml: &str, local: &str) -> Option<String> {
    let pattern = element_pattern(local, true)?;
    pattern
        .captures(xml)
        .and_then(|captures| captures.get(1))
        .map(|text| decode_text(text.as_str()).trim().to_owned())
}

/// Character data: CDATA sections verbatim, the rest unescaped.
fn decode_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find("<![CDATA[") {
        out.push_str(&unescape(&rest[..start]));
        let after = &rest[start + 9..];
        let Some(end) = after.find("]]>") else {
            out.push_str(after);
            return out;
        };
        out.push_str(&after[..end]);
        rest = &after[end + 3..];
    }
    out.push_str(&unescape(rest));
    out
}

/// Every element named `local` (any prefix), as written.
pub fn blocks<'a>(xml: &'a str, local: &str) -> Vec<&'a str> {
    element_pattern(local, false).map_or_else(Vec::new, |pattern| {
        pattern.find_iter(xml).map(|m| m.as_str()).collect()
    })
}

/// Whether the answer holds an element named `local` (any prefix).
pub fn has_element(xml: &str, local: &str) -> bool {
    regex::Regex::new(&format!(r"<(?:[A-Za-z0-9_.-]+:)?{local}[ \t\r\n>/]"))
        .is_ok_and(|pattern| pattern.is_match(xml))
}

/// The five predefined entities and character references.
pub fn unescape(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.find(';') else {
            break;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()))
                .and_then(char::from_u32),
        };
        if let Some(c) = decoded {
            out.push(c);
        } else {
            out.push_str(&rest[..=end]);
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

/// XML-escapes text for a message written by hand (the XBRL instances).
pub fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_exclusive_canonical_form() {
        // The case of the TypeScript writer's test, byte for byte.
        let node = Element::new("urn:a", "a", "root")
            .child(Element::new("urn:a", "a", "child").text("1 < 2 & 3"))
            .child(
                Element::new("urn:b", "b", "other")
                    .attr("z", "\"q\"")
                    .attr("y", "x"),
            );
        assert_eq!(
            node.canonical(),
            "<a:root xmlns:a=\"urn:a\"><a:child>1 &lt; 2 &amp; 3</a:child><b:other xmlns:b=\"urn:b\" y=\"x\" z=\"&quot;q&quot;\"></b:other></a:root>"
        );
    }

    #[test]
    fn declares_attribute_namespaces_and_sorts_by_uri() {
        let node = Element::new("urn:e", "e", "x")
            .ns_attr("w", "urn:w", "Id", "id-1")
            .attr("b", "2")
            .attr("a", "1\n");
        assert_eq!(
            node.canonical(),
            "<e:x xmlns:e=\"urn:e\" xmlns:w=\"urn:w\" a=\"1&#xA;\" b=\"2\" w:Id=\"id-1\"></e:x>"
        );
    }

    #[test]
    fn reads_answers_by_local_name() {
        let xml = "<s:Envelope xmlns:s=\"x\"><s:Body><r xmlns=\"y\"><kenmerk>a1</kenmerk><n:item a=\"1\">One &amp; two</n:item><n:item>Three</n:item></r></s:Body></s:Envelope>";
        assert_eq!(text_of(xml, "kenmerk").as_deref(), Some("a1"));
        assert_eq!(text_of(xml, "item").as_deref(), Some("One & two"));
        assert_eq!(blocks(xml, "item").len(), 2);
        assert!(has_element(xml, "Body"));
        assert!(!has_element(xml, "Fault"));
        assert_eq!(text_of(xml, "missing"), None);
        assert_eq!(unescape("&#x41;&#66;&bogus;"), "AB&bogus;");
        let cdata = "<statusdetails><![CDATA[<resp>a &amp; b</resp>]]> &amp; more</statusdetails>";
        assert_eq!(
            text_of(cdata, "statusdetails").as_deref(),
            Some("<resp>a &amp; b</resp> & more")
        );
    }
}
