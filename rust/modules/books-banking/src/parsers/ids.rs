//! Ids for statement lines whose file carries none (`bank-parsers/ids.ts`):
//! a hash of the line's date, amount and text plus a counter for identical
//! lines in the same file, so importing the same file twice finds every line
//! again. The hash must be the TypeScript one byte for byte: both backends
//! read lines the other imported.

use std::collections::HashMap;

use super::js_trim;

/// `shortHash`: two FNV-1a passes over the UTF-16 units with different
/// offsets, 16 hex characters. Not cryptographic.
pub(crate) fn short_hash(input: &str) -> String {
    // With no input JavaScript never runs `>>> 0` on the second pass: its
    // seed prints as the signed 32-bit number it is.
    if input.is_empty() {
        return "811c9dc5-20524084".to_owned();
    }
    let mut h1: u32 = 0x811c_9dc5;
    let mut h2: u32 = 0x0100_0193 ^ 0xdead_beef;
    for code in input.encode_utf16() {
        let code = u32::from(code);
        h1 = (h1 ^ code).wrapping_mul(0x0100_0193);
        h2 = (h2 ^ code).wrapping_mul(0x85eb_ca6b);
        h2 ^= h2 >> 13;
    }
    format!("{h1:08x}{h2:08x}")
}

/// `syntheticExternalId(prefix, parts, occurrence)`: `prefix:<hash of the
/// parts>`, plus `#n` from the second identical line on.
pub(crate) fn synthetic_external_id(
    prefix: &str,
    parts: &[Option<&str>],
    occurrence: usize,
) -> String {
    let joined = parts
        .iter()
        .map(|part| js_trim(part.unwrap_or_default()).to_lowercase())
        .collect::<Vec<_>>()
        .join("|");
    let base = format!("{prefix}:{}", short_hash(&joined));
    if occurrence > 1 {
        format!("{base}#{occurrence}")
    } else {
        base
    }
}

/// `occurrenceCounter()`: 1 the first time a key is seen, 2 the second, …
pub(crate) fn occurrence_counter() -> impl FnMut(&str) -> usize {
    let mut seen: HashMap<String, usize> = HashMap::new();
    move |key: &str| {
        let next = seen.get(key).copied().unwrap_or(0) + 1;
        seen.insert(key.to_owned(), next);
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_match_the_worker() {
        // Values computed with the TypeScript `shortHash`.
        assert_eq!(short_hash(""), "811c9dc5-20524084");
        assert_eq!(short_hash("a"), "e40c292c170a7b49");
        assert_eq!(short_hash("2026-01-02|12.50|café|é"), "5f006ef211c29572");
        let id = synthetic_external_id("imp", &[Some("2026-01-02"), Some(" 12.50 "), None], 2);
        assert!(id.starts_with("imp:"));
        assert!(id.ends_with("#2"));
    }

    #[test]
    fn occurrences_count_per_key() {
        let mut next = occurrence_counter();
        assert_eq!(next("a"), 1);
        assert_eq!(next("a"), 2);
        assert_eq!(next("b"), 1);
    }
}
