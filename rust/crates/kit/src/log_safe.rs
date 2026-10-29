//! Log-injection guard (`logSafe` in `@weldsuite/text`).

/// Replace every run of line breaks (`\r`, `\n`, U+2028, U+2029) with one
/// space, so a value from a request or a webhook cannot forge extra log lines.
pub fn log_safe(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_break = false;
    for c in value.chars() {
        if matches!(c, '\r' | '\n' | '\u{2028}' | '\u{2029}') {
            if !in_break {
                out.push(' ');
                in_break = true;
            }
        } else {
            out.push(c);
            in_break = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::log_safe;

    #[test]
    fn replaces_line_breaks_and_unicode_separators_with_a_space() {
        // Same case as packages/core/text/src/index.test.ts.
        assert_eq!(log_safe("a\r\nb\nc\u{2028}d\u{2029}e"), "a b c d e");
    }

    #[test]
    fn leaves_other_text_alone() {
        assert_eq!(log_safe("tab\there"), "tab\there");
        assert_eq!(log_safe(""), "");
    }
}
