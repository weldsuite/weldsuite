//! The VAT / tax ID format check of `@weldsuite/app-api-client/schemas/
//! vat-number` (`checkVatNumber`), which `PUT /api/workspace-settings`
//! validates `vatNumber` with. A format check only: the right prefix, length
//! and characters. Keep the patterns in step with the TypeScript file.

use std::sync::LazyLock;

use regex::Regex;

/// National part of a VAT number per prefix, and a correct example.
const PATTERNS: &[(&str, &str, &str)] = &[
    ("AT", r"^U\d{8}$", "ATU12345678"),
    ("BE", r"^[01]\d{9}$", "BE0123456789"),
    ("BG", r"^\d{9,10}$", "BG123456789"),
    ("CY", r"^\d{8}[A-Z]$", "CY12345678X"),
    ("CZ", r"^\d{8,10}$", "CZ12345678"),
    ("DE", r"^\d{9}$", "DE123456789"),
    ("DK", r"^\d{8}$", "DK12345678"),
    ("EE", r"^\d{9}$", "EE123456789"),
    ("EL", r"^\d{9}$", "EL123456789"),
    ("ES", r"^[A-Z0-9]\d{7}[A-Z0-9]$", "ESX1234567X"),
    ("FI", r"^\d{8}$", "FI12345678"),
    ("FR", r"^[A-HJ-NP-Z0-9]{2}\d{9}$", "FR12345678901"),
    ("GB", r"^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$", "GB123456789"),
    ("HR", r"^\d{11}$", "HR12345678901"),
    ("HU", r"^\d{8}$", "HU12345678"),
    (
        "IE",
        r"^(\d{7}[A-W][A-IW]?|\d[A-Z+*]\d{5}[A-W])$",
        "IE1234567X",
    ),
    ("IT", r"^\d{11}$", "IT12345678901"),
    ("LT", r"^(\d{9}|\d{12})$", "LT123456789"),
    ("LU", r"^\d{8}$", "LU12345678"),
    ("LV", r"^\d{11}$", "LV12345678901"),
    ("MT", r"^\d{8}$", "MT12345678"),
    ("NL", r"^\d{9}B\d{2}$", "NL123456789B01"),
    ("PL", r"^\d{10}$", "PL1234567890"),
    ("PT", r"^\d{9}$", "PT123456789"),
    ("RO", r"^\d{2,10}$", "RO1234567890"),
    ("SE", r"^\d{12}$", "SE123456789012"),
    ("SI", r"^\d{8}$", "SI12345678"),
    ("SK", r"^\d{10}$", "SK1234567890"),
    ("XI", r"^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$", "XI123456789"),
];

static COMPILED: LazyLock<Vec<(&'static str, Regex, &'static str)>> = LazyLock::new(|| {
    PATTERNS
        .iter()
        .map(|(prefix, pattern, example)| {
            (
                *prefix,
                Regex::new(&format!("(?-u){pattern}")).expect("the VAT pattern compiles"),
                *example,
            )
        })
        .collect()
});

fn pattern(prefix: &str) -> Option<&'static (&'static str, Regex, &'static str)> {
    COMPILED.iter().find(|(p, _, _)| *p == prefix)
}

/// `LENIENT_TAX_ID`: 4 to 20 letters and digits, at least one digit.
fn lenient(compact: &str) -> bool {
    let len = compact.len();
    (4..=20).contains(&len)
        && compact
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        && compact.bytes().any(|b| b.is_ascii_digit())
}

/// `normalizeVatNumber`: without spaces, dots, hyphens and slashes, upper case.
fn normalize(raw: &str) -> String {
    raw.chars()
        .filter(|c| !(c.is_whitespace() || matches!(c, '.' | '-' | '/')))
        .collect::<String>()
        .to_uppercase()
}

/// `vatPrefixForCountry`.
fn prefix_for_country(country: Option<&str>) -> Option<&'static str> {
    let code = country?.trim().to_uppercase();
    if code.chars().count() != 2 {
        return None;
    }
    let prefix = if code == "GR" { "EL".to_owned() } else { code };
    pattern(&prefix).map(|(p, _, _)| *p)
}

/// `typedVatPrefix`: the prefix the value starts with (`GR` is `EL`).
fn typed_prefix(compact: &str) -> Option<&'static str> {
    let head: String = compact.chars().take(2).collect();
    if let Some((p, _, _)) = pattern(&head) {
        return Some(p);
    }
    (head == "GR").then_some("EL")
}

/// `checkVatNumber(raw, country)`: `Ok(())` when valid, else the message the
/// schema's refinement writes.
pub(crate) fn check(raw: &str, country: Option<&str>) -> Result<(), String> {
    let compact = normalize(raw);
    if compact.is_empty() {
        return Ok(());
    }
    let has_country = country.is_some_and(|c| !c.trim().is_empty());
    let country_prefix = prefix_for_country(country);
    let typed = typed_prefix(&compact);
    let prefix = if has_country && country_prefix.is_none() {
        None
    } else {
        typed.or(country_prefix)
    };
    let Some((prefix, regex, example)) = prefix.and_then(pattern) else {
        return if lenient(&compact) {
            Ok(())
        } else {
            Err("Not a valid VAT / tax ID: use letters and digits only".to_owned())
        };
    };
    // JavaScript slices UTF-16 units; a matching prefix is two ASCII letters.
    let national = if typed.is_some() {
        compact.chars().skip(2).collect::<String>()
    } else {
        compact.clone()
    };
    if regex.is_match(&national) {
        Ok(())
    } else {
        Err(format!(
            "Not a valid VAT number for {prefix}. Example: {example}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::check;

    #[test]
    fn accepts_what_the_typescript_check_accepts() {
        for (value, country) in [
            ("NL123456789B01", "NL"),
            ("nl 1234.56.789 b01", "NL"),
            ("123456789B01", "NL"),
            ("BE 0123.456.789", "BE"),
            ("EL123456789", "GR"),
            ("GR123456789", "GR"),
            ("XI123456789", "GB"),
            ("12-3456789", "US"),
        ] {
            assert_eq!(check(value, Some(country)), Ok(()), "{value} {country}");
        }
        assert_eq!(check("", Some("NL")), Ok(()));
        assert_eq!(check("BE0123456789", None), Ok(()));
    }

    #[test]
    fn refuses_with_the_typescript_messages() {
        assert_eq!(
            check("NL123456789", Some("NL")),
            Err("Not a valid VAT number for NL. Example: NL123456789B01".to_owned())
        );
        assert_eq!(
            check("NOT A VAT!!", Some("US")),
            Err("Not a valid VAT / tax ID: use letters and digits only".to_owned())
        );
        assert_eq!(
            check("hello", Some("DE")),
            Err("Not a valid VAT number for DE. Example: DE123456789".to_owned())
        );
    }
}
