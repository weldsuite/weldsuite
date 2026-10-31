//! Identifiers (`@weldsuite/books-domain/identifiers`): IBANs.

use crate::jurisdictions::DATA;

/// `normalizeIban(raw)`: without whitespace, upper case.
pub fn normalize_iban(raw: &str) -> String {
    raw.chars()
        .filter(|c| !crate::jurisdictions::is_js_space(*c))
        .collect::<String>()
        .to_uppercase()
}

/// `ibanProblem(raw)`: `format`, `country_length` or `checksum`, or `None`.
pub fn iban_problem(raw: &str) -> Option<&'static str> {
    let iban = normalize_iban(raw);
    let b = iban.as_bytes();
    let shaped = (15..=34).contains(&b.len())
        && b[..2].iter().all(u8::is_ascii_uppercase)
        && b[2..4].iter().all(u8::is_ascii_digit)
        && b[4..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    if !shaped {
        return Some("format");
    }
    if let Some(expected) = DATA["ibanLengths"]
        .get(&iban[..2])
        .and_then(serde_json::Value::as_u64)
        && usize::try_from(expected).ok() != Some(iban.len())
    {
        return Some("country_length");
    }
    let rearranged = format!("{}{}", &iban[4..], &iban[..4]);
    let mut remainder: u32 = 0;
    for c in rearranged.chars() {
        let value = if c.is_ascii_uppercase() {
            (u32::from(c) - 55).to_string()
        } else {
            c.to_string()
        };
        for digit in value.chars() {
            remainder = (remainder * 10 + digit.to_digit(10).unwrap_or(0)) % 97;
        }
    }
    (remainder != 1).then_some("checksum")
}

/// `isValidIban(raw)`.
pub fn is_valid_iban(raw: &str) -> bool {
    iban_problem(raw).is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ibans() {
        assert!(is_valid_iban("NL91 ABNA 0417 1643 00"));
        assert_eq!(iban_problem("NL91ABNA0417164301"), Some("checksum"));
        assert_eq!(iban_problem("NL91ABNA041716430"), Some("country_length"));
    }
}
