//! The tiny XML writer of the Dutch filings (`nl/xml.ts`).

use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, PartialEq)]
pub struct XmlNode {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<XmlNode>,
    /// `null` text and no children: an empty element.
    pub text: Option<String>,
}

/// `el(name, content)` with text content (a number is `String(n)`).
pub fn el(name: &str, text: impl Into<String>) -> XmlNode {
    XmlNode {
        name: name.to_owned(),
        attrs: vec![],
        children: vec![],
        text: Some(text.into()),
    }
}

/// `el(name, children)`.
pub fn el_children(name: &str, children: Vec<XmlNode>) -> XmlNode {
    XmlNode {
        name: name.to_owned(),
        attrs: vec![],
        children,
        text: None,
    }
}

/// `el(name, n)` of a number: `String(n)`.
pub fn el_num(name: &str, n: f64) -> XmlNode {
    el(name, crate::js::number_text(n))
}

/// `escapeXml(text)`.
pub fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// `toLatin1(text)`: characters past U+00FF lose their accents, or become
/// `?`; control characters XML 1.0 forbids are dropped.
pub fn to_latin1(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if u32::from(ch) <= 0xff {
            out.push(ch);
            continue;
        }
        let base: String = ch
            .to_string()
            .nfd()
            .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
            .collect();
        if base.chars().all(|c| u32::from(c) <= 0xff) {
            out.push_str(&base);
        } else {
            out.push('?');
        }
    }
    out.chars()
        .filter(|c| !matches!(u32::from(*c), 0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f))
        .collect()
}

/// `serialize(node, indent, depth)`.
pub fn serialize(node: &XmlNode, indent: &str, depth: usize) -> String {
    let pad = indent.repeat(depth);
    let mut attrs = String::new();
    for (k, v) in &node.attrs {
        attrs.push(' ');
        attrs.push_str(k);
        attrs.push_str("=\"");
        attrs.push_str(&escape_xml(v));
        attrs.push('"');
    }
    if !node.children.is_empty() {
        let nl = if indent.is_empty() { "" } else { "\n" };
        let inner: Vec<String> = node
            .children
            .iter()
            .map(|c| serialize(c, indent, depth + 1))
            .collect();
        return format!(
            "{pad}<{}{attrs}>{nl}{}{nl}{pad}</{}>",
            node.name,
            inner.join(nl),
            node.name
        );
    }
    let text = node
        .text
        .as_deref()
        .map(|t| escape_xml(&to_latin1(t)))
        .unwrap_or_default();
    format!("{pad}<{}{attrs}>{text}</{}>", node.name, node.name)
}
