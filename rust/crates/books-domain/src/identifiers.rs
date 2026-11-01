//! Identifiers (`@weldsuite/books-domain/identifiers`): EU VAT number formats
//! and IBANs. Format checks only: whether a VAT number is registered is
//! VIES ([`crate::vies`]).

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

/// The national part of a VAT number per VAT prefix (what VIES documents),
/// without the prefix: `VAT_PATTERNS`, and `VAT_EXAMPLES` for messages.
const VAT_FORMATS: [(&str, &str, &str); 29] = [
    ("AT", r"^U[0-9]{8}$", "ATU12345678"),
    ("BE", r"^[01][0-9]{9}$", "BE0123456789"),
    ("BG", r"^[0-9]{9,10}$", "BG123456789"),
    ("CY", r"^[0-9]{8}[A-Z]$", "CY12345678X"),
    ("CZ", r"^[0-9]{8,10}$", "CZ12345678"),
    ("DE", r"^[0-9]{9}$", "DE123456789"),
    ("DK", r"^[0-9]{8}$", "DK12345678"),
    ("EE", r"^[0-9]{9}$", "EE123456789"),
    ("EL", r"^[0-9]{9}$", "EL123456789"),
    ("ES", r"^[A-Z0-9][0-9]{7}[A-Z0-9]$", "ESX1234567X"),
    ("FI", r"^[0-9]{8}$", "FI12345678"),
    ("FR", r"^[A-HJ-NP-Z0-9]{2}[0-9]{9}$", "FR12345678901"),
    (
        "GB",
        r"^([0-9]{9}|[0-9]{12}|GD[0-9]{3}|HA[0-9]{3})$",
        "GB123456789",
    ),
    ("HR", r"^[0-9]{11}$", "HR12345678901"),
    ("HU", r"^[0-9]{8}$", "HU12345678"),
    (
        "IE",
        r"^([0-9]{7}[A-W][A-IW]?|[0-9][A-Z+*][0-9]{5}[A-W])$",
        "IE1234567X",
    ),
    ("IT", r"^[0-9]{11}$", "IT12345678901"),
    ("LT", r"^([0-9]{9}|[0-9]{12})$", "LT123456789"),
    ("LU", r"^[0-9]{8}$", "LU12345678"),
    ("LV", r"^[0-9]{11}$", "LV12345678901"),
    ("MT", r"^[0-9]{8}$", "MT12345678"),
    ("NL", r"^[0-9]{9}B[0-9]{2}$", "NL123456789B01"),
    ("PL", r"^[0-9]{10}$", "PL1234567890"),
    ("PT", r"^[0-9]{9}$", "PT123456789"),
    ("RO", r"^[0-9]{2,10}$", "RO1234567890"),
    ("SE", r"^[0-9]{12}$", "SE123456789012"),
    ("SI", r"^[0-9]{8}$", "SI12345678"),
    ("SK", r"^[0-9]{10}$", "SK1234567890"),
    (
        "XI",
        r"^([0-9]{9}|[0-9]{12}|GD[0-9]{3}|HA[0-9]{3})$",
        "XI123456789",
    ),
];

static VAT_PATTERNS: std::sync::LazyLock<Vec<(&'static str, regex::Regex, &'static str)>> =
    std::sync::LazyLock::new(|| {
        VAT_FORMATS
            .iter()
            .map(|(prefix, pattern, example)| {
                (
                    *prefix,
                    regex::Regex::new(pattern).expect("the VAT patterns compile"),
                    *example,
                )
            })
            .collect()
    });

fn vat_format(prefix: &str) -> Option<&'static (&'static str, regex::Regex, &'static str)> {
    VAT_PATTERNS.iter().find(|(p, _, _)| *p == prefix)
}

/// `VAT_EXAMPLES[prefix]`.
pub fn vat_example(prefix: &str) -> Option<&'static str> {
    vat_format(prefix).map(|(_, _, example)| *example)
}

/// `vatPrefixOf(countryCode)`: the prefix a country's VAT numbers carry
/// (Greece is `EL`), when it has a pattern.
fn vat_prefix_of(country_code: Option<&str>) -> Option<&'static str> {
    let code = crate::jurisdictions::js_trim(country_code?).to_uppercase();
    if code.encode_utf16().count() != 2 {
        return None;
    }
    let prefix = if code == "GR" { "EL" } else { code.as_str() };
    vat_format(prefix).map(|(p, _, _)| *p)
}

/// `VatFormatCheck`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VatFormatCheck {
    /// False only when the value is shaped like a VAT number of a country and is wrong for it.
    pub valid: bool,
    /// The VAT prefix the check ran for (`BE`), when there was one.
    pub prefix: Option<&'static str>,
    /// The number in its compact upper-case form (`BE0123456789`); the compact
    /// value itself when no prefix applied.
    pub formatted: Option<String>,
    /// An example of a correct number for that prefix.
    pub example: Option<&'static str>,
}

/// `checkVatNumberFormat(raw, countryCode)`: a typed VAT number against
/// the format of its country (the typed prefix, else the contact's
/// country). A value with no EU prefix for a country without a pattern (a
/// US EIN, an Indian GSTIN) is not judged: `valid`, no prefix.
pub fn check_vat_number_format(raw: Option<&str>, country_code: Option<&str>) -> VatFormatCheck {
    let compact: String = raw
        .unwrap_or_default()
        .chars()
        .filter(|c| !(crate::jurisdictions::is_js_space(*c) || matches!(c, '.' | '-' | '/')))
        .collect::<String>()
        .to_uppercase();
    let skip = VatFormatCheck {
        valid: true,
        prefix: None,
        formatted: (!compact.is_empty()).then(|| compact.clone()),
        example: None,
    };
    if compact.is_empty() {
        return skip;
    }
    let b = compact.as_bytes();
    let starts_with_letters =
        b.len() >= 2 && b[0].is_ascii_uppercase() && b[1].is_ascii_uppercase();
    let typed_prefix = starts_with_letters
        .then(|| vat_format(&compact[..2]).map(|(p, _, _)| *p))
        .flatten();
    let greek = typed_prefix.is_none()
        && compact.starts_with("GR")
        && b.get(2).is_some_and(u8::is_ascii_digit);
    let prefix = typed_prefix.or(if greek {
        Some("EL")
    } else {
        vat_prefix_of(country_code)
    });
    let Some(prefix) = prefix else {
        return skip;
    };
    let national = if typed_prefix.is_some() || greek {
        &compact[2..]
    } else {
        compact.as_str()
    };
    let format = vat_format(prefix);
    let valid = format.is_some_and(|(_, pattern, _)| pattern.is_match(national));
    VatFormatCheck {
        valid,
        prefix: Some(prefix),
        formatted: valid.then(|| format!("{prefix}{national}")),
        example: format.map(|(_, _, example)| *example),
    }
}

/// `IBAN_LENGTHS[countryCode]`: an IBAN's length in that country.
pub fn iban_length(country_code: &str) -> Option<u64> {
    DATA["ibanLengths"]
        .get(country_code)
        .and_then(serde_json::Value::as_u64)
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

    #[test]
    fn vat_number_formats() {
        let be = check_vat_number_format(Some("be 0123.456.789"), None);
        assert!(be.valid);
        assert_eq!(be.formatted.as_deref(), Some("BE0123456789"));
        let bad = check_vat_number_format(Some("0123"), Some("be"));
        assert!(!bad.valid);
        assert_eq!(bad.prefix, Some("BE"));
        assert_eq!(bad.example, Some("BE0123456789"));
        let greek = check_vat_number_format(Some("GR123456789"), None);
        assert_eq!(greek.formatted.as_deref(), Some("EL123456789"));
        let ein = check_vat_number_format(Some("12-3456789"), Some("US"));
        assert!(ein.valid);
        assert_eq!(ein.prefix, None);
        assert_eq!(ein.formatted.as_deref(), Some("123456789"));
    }
}
