//! Escaping and the filters the exported templates call.

use std::fmt::Write as _;

use minijinja::Value;

/// React's text and attribute escaping (`escapeTextForBrowser`), so a value
/// lands in the HTML byte for byte as the workers write it.
pub(crate) fn escape_html(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            c => out.push(c),
        }
    }
}

fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    escape_html(text, &mut out);
    out
}

/// `<MultilineText>`: each line in a `<span>`, a `<br/>` between them.
pub(crate) fn multiline(value: &str) -> Value {
    let lines: Vec<&str> = value
        .split("\r\n")
        .flat_map(|l| l.split(['\r', '\n']))
        .collect();
    let mut out = String::new();
    for (i, line) in lines.iter().enumerate() {
        out.push_str("<span>");
        escape_html(line, &mut out);
        if i + 1 < lines.len() {
            out.push_str("<br/>");
        }
        out.push_str("</span>");
    }
    Value::from_safe_string(out)
}

/// The plain-text form of a multiline value: its lines, `\n`-separated, each
/// with runs of spaces collapsed as html-to-text does.
pub(crate) fn text_lines(value: &str) -> String {
    value
        .split("\r\n")
        .flat_map(|l| l.split(['\r', '\n']))
        .map(collapse)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Runs of whitespace as one space, as html-to-text writes inline text (its
/// `whitespaceCharacters`: space, tab, CR, LF, form feed, zero-width space).
pub(crate) fn collapse(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut space = false;
    for c in value.chars() {
        if matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{c}' | '\u{200b}') {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out
}

/// The JavaScript `length` of a string: UTF-16 code units.
fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// React Email's `<Preview>`: the text cut at 150 UTF-16 units, then filler
/// characters up to 150 so clients don't show the body after it.
pub(crate) fn preview_block(text: &str) -> Value {
    const MAX: usize = 150;
    const FILLER: &str = "\u{a0}\u{200c}\u{200b}\u{200d}\u{200e}\u{200f}\u{feff}";
    let units: Vec<u16> = text.encode_utf16().collect();
    let text = if units.len() > MAX {
        String::from_utf16_lossy(&units[..MAX])
    } else {
        text.to_owned()
    };
    let mut out = escaped(&text);
    let length = js_len(&text);
    if length < MAX {
        let _ = write!(out, "<div>{}</div>", FILLER.repeat(MAX - length));
    }
    Value::from_safe_string(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_react() {
        assert_eq!(
            escaped(r#"<a href="x">Tom & Jerry's</a>"#),
            "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#x27;s&lt;/a&gt;"
        );
    }

    #[test]
    fn multiline_like_multiline_text() {
        assert_eq!(
            multiline("Hi <Ann>,\r\nHere\nit is").to_string(),
            "<span>Hi &lt;Ann&gt;,<br/></span><span>Here<br/></span><span>it is</span>"
        );
        assert_eq!(text_lines("a  b\r\nc"), "a b\nc");
    }

    #[test]
    fn previews_are_padded_to_150() {
        let block = preview_block("Your code is 123456.").to_string();
        assert!(block.starts_with("Your code is 123456.<div>"));
        assert_eq!(block.matches('\u{feff}').count(), 150 - 20);
        assert!(
            !preview_block(&"x".repeat(160))
                .to_string()
                .contains("<div>")
        );
    }
}
