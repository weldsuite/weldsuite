//! The United States (`jurisdictions/us`): entity types and tax
//! classifications, the income-tax return each files and its line catalog,
//! EIN / SSN / state tax ID / ZIP checks, address state codes, 1099 boxes.

use serde_json::Value;

use super::{DATA, TaxIdValidation, js_trim, strip};

fn strings(value: &'static Value) -> Vec<&'static str> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// `US_ENTITY_TYPES`.
pub fn entity_types() -> Vec<&'static str> {
    strings(&DATA["us"]["entityTypes"])
}

/// `US_TAX_CLASSIFICATIONS`.
pub fn tax_classifications() -> Vec<&'static str> {
    strings(&DATA["us"]["classifications"])
}

/// `isUsEntityType(value)`.
pub fn is_entity_type(value: &str) -> bool {
    entity_types().contains(&value)
}

/// `isUsTaxClassification(value)`.
pub fn is_tax_classification(value: &str) -> bool {
    tax_classifications().contains(&value)
}

/// `US_ENTITY_TYPE_INFO[type]`: `type`, `label`, `description`,
/// `classifications`, `minOwners`.
pub fn entity_type_info(entity_type: &str) -> Option<&'static Value> {
    DATA["us"]["entityTypeInfo"].get(entity_type)
}

/// `allowedTaxClassifications(entityType)`: default first; empty for an
/// unknown type.
pub fn allowed_tax_classifications(entity_type: Option<&str>) -> Vec<&'static str> {
    entity_type
        .and_then(entity_type_info)
        .map(|info| strings(&info["classifications"]))
        .unwrap_or_default()
}

/// `defaultTaxClassification(entityType)`.
pub fn default_tax_classification(entity_type: Option<&str>) -> &'static str {
    allowed_tax_classifications(entity_type)
        .first()
        .copied()
        .unwrap_or("sole_proprietor")
}

/// `isValidTaxClassification(entityType, classification)`.
pub fn is_valid_tax_classification(
    entity_type: Option<&str>,
    classification: Option<&str>,
) -> bool {
    classification.is_some_and(|c| {
        is_tax_classification(c) && allowed_tax_classifications(entity_type).contains(&c)
    })
}

/// `effectiveTaxClassification(entityType, classification)`.
pub fn effective_tax_classification(
    entity_type: Option<&str>,
    classification: Option<&str>,
) -> String {
    if is_valid_tax_classification(entity_type, classification)
        && let Some(c) = classification
    {
        return c.to_owned();
    }
    if !entity_type.is_some_and(is_entity_type)
        && let Some(c) = classification.filter(|c| is_tax_classification(c))
    {
        return c.to_owned();
    }
    default_tax_classification(entity_type).to_owned()
}

/// `taxFormForClassification(classification)`.
pub fn tax_form_for_classification(classification: &str) -> &'static str {
    DATA["us"]["formByClassification"][classification]
        .as_str()
        .unwrap_or("sch_c")
}

/// `taxFormForEntity(entityType, classification)`: the return the entity files.
pub fn tax_form_for_entity(
    entity_type: Option<&str>,
    classification: Option<&str>,
) -> &'static str {
    tax_form_for_classification(&effective_tax_classification(entity_type, classification))
}

/// `TAX_FORM_LABELS[form]`.
pub fn form_label(form: &str) -> &'static str {
    DATA["us"]["formLabels"][form].as_str().unwrap_or_default()
}

/// `TAX_SECTION_LABELS[section]`.
pub fn section_label(section: &str) -> Value {
    DATA["us"]["sectionLabels"]
        .get(section)
        .cloned()
        .unwrap_or(Value::Null)
}

/// `TAX_LINE_CATEGORY_KEYS`.
pub fn tax_line_categories() -> Vec<&'static str> {
    strings(&DATA["us"]["taxLineCategories"])
}

/// `layoutFor(form, taxYear)`: Schedule C swapped 27a/27b for 2025.
fn layout_for(form: &str, tax_year: i64) -> &'static str {
    if form == "sch_c" && tax_year >= 2025 {
        "v2025"
    } else {
        "v2023"
    }
}

/// `getTaxLineCatalog(form, taxYear)`: `{ code, form, line, label, section }`.
pub fn tax_line_catalog(form: &str, tax_year: i64) -> &'static [Value] {
    DATA["us"]["catalogs"][form][layout_for(form, tax_year)]
        .as_array()
        .map_or(&[], Vec::as_slice)
}

/// `getTaxLine(code, taxYear)`.
pub fn tax_line(code: &str, tax_year: i64) -> Option<&'static Value> {
    let dot = code.find('.')?;
    if dot == 0 {
        return None;
    }
    let form = &code[..dot];
    tax_line_catalog(form, tax_year)
        .iter()
        .find(|line| line["code"].as_str() == Some(code))
}

/// `resolveTaxLine(category, form, taxYear)`.
pub fn resolve_tax_line(category: &str, form: &str, tax_year: i64) -> Option<&'static Value> {
    let code = DATA["us"]["taxLineMap"]
        .get(category)?
        .get(form)?
        .get(layout_for(form, tax_year))?
        .as_str()?;
    tax_line(code, tax_year)
}

/// `FORM_1099_OMIT`.
pub fn form_1099_omit() -> &'static str {
    DATA["us"]["form1099Omit"].as_str().unwrap_or("omit")
}

/// `isForm1099BoxCode(code)`.
pub fn is_form_1099_box_code(code: &str) -> bool {
    strings(&DATA["us"]["form1099Boxes"]).contains(&code)
}

/// `isUsAddressStateCode(code)`: a state or territory code.
pub fn is_address_state_code(code: &str) -> bool {
    let upper = js_trim(code).to_uppercase();
    strings(&DATA["us"]["stateCodes"]).contains(&upper.as_str())
        || strings(&DATA["us"]["territoryCodes"]).contains(&upper.as_str())
}

/// Primary time zone of each state, the default of a new US entity.
const STATE_TIME_ZONES: [(&str, &str); 56] = [
    ("AL", "America/Chicago"),
    ("AK", "America/Anchorage"),
    ("AZ", "America/Phoenix"),
    ("AR", "America/Chicago"),
    ("CA", "America/Los_Angeles"),
    ("CO", "America/Denver"),
    ("CT", "America/New_York"),
    ("DE", "America/New_York"),
    ("DC", "America/New_York"),
    ("FL", "America/New_York"),
    ("GA", "America/New_York"),
    ("HI", "Pacific/Honolulu"),
    ("ID", "America/Boise"),
    ("IL", "America/Chicago"),
    ("IN", "America/Indiana/Indianapolis"),
    ("IA", "America/Chicago"),
    ("KS", "America/Chicago"),
    ("KY", "America/New_York"),
    ("LA", "America/Chicago"),
    ("ME", "America/New_York"),
    ("MD", "America/New_York"),
    ("MA", "America/New_York"),
    ("MI", "America/Detroit"),
    ("MN", "America/Chicago"),
    ("MS", "America/Chicago"),
    ("MO", "America/Chicago"),
    ("MT", "America/Denver"),
    ("NE", "America/Chicago"),
    ("NV", "America/Los_Angeles"),
    ("NH", "America/New_York"),
    ("NJ", "America/New_York"),
    ("NM", "America/Denver"),
    ("NY", "America/New_York"),
    ("NC", "America/New_York"),
    ("ND", "America/Chicago"),
    ("OH", "America/New_York"),
    ("OK", "America/Chicago"),
    ("OR", "America/Los_Angeles"),
    ("PA", "America/New_York"),
    ("RI", "America/New_York"),
    ("SC", "America/New_York"),
    ("SD", "America/Chicago"),
    ("TN", "America/Chicago"),
    ("TX", "America/Chicago"),
    ("UT", "America/Denver"),
    ("VT", "America/New_York"),
    ("VA", "America/New_York"),
    ("WA", "America/Los_Angeles"),
    ("WV", "America/New_York"),
    ("WI", "America/Chicago"),
    ("WY", "America/Denver"),
    ("PR", "America/Puerto_Rico"),
    ("VI", "America/St_Thomas"),
    ("GU", "Pacific/Guam"),
    ("AS", "Pacific/Pago_Pago"),
    ("MP", "Pacific/Saipan"),
];

/// `defaultUsTimeZone(state)`.
pub fn default_time_zone(state: Option<&str>) -> &'static str {
    let upper = state.filter(|s| !s.is_empty()).map(str::to_uppercase);
    upper
        .and_then(|s| {
            STATE_TIME_ZONES
                .iter()
                .find(|(code, _)| *code == s)
                .map(|(_, zone)| *zone)
        })
        .unwrap_or("America/New_York")
}

// ── identifiers ─────────────────────────────────────────────────────────────

const EIN_VALID_PREFIX_RANGES: [(i64, i64); 9] = [
    (1, 6),
    (10, 16),
    (20, 27),
    (30, 48),
    (50, 68),
    (71, 77),
    (80, 88),
    (90, 95),
    (98, 99),
];

fn digits(value: &str) -> bool {
    value.bytes().all(|b| b.is_ascii_digit())
}

/// `XX-XXXXXXX` or nine digits: the nine digits.
fn ein_digits(value: &str) -> Option<String> {
    let b = value.as_bytes();
    if b.len() == 10 && b[2] == b'-' && digits(&value[..2]) && digits(&value[3..]) {
        return Some(format!("{}{}", &value[..2], &value[3..]));
    }
    (b.len() == 9 && digits(value)).then(|| value.to_owned())
}

/// `XXX-XX-XXXX` or nine digits: area, group, serial.
fn ssn_parts(value: &str) -> Option<(String, String, String)> {
    let b = value.as_bytes();
    if b.len() == 11
        && b[3] == b'-'
        && b[6] == b'-'
        && digits(&value[..3])
        && digits(&value[4..6])
        && digits(&value[7..])
    {
        return Some((
            value[..3].to_owned(),
            value[4..6].to_owned(),
            value[7..].to_owned(),
        ));
    }
    (b.len() == 9 && digits(value)).then(|| {
        (
            value[..3].to_owned(),
            value[3..5].to_owned(),
            value[5..].to_owned(),
        )
    })
}

/// `validateEin(value)`.
pub fn validate_ein(value: &str) -> TaxIdValidation {
    let trimmed = js_trim(value);
    let Some(digits) = ein_digits(trimmed) else {
        return TaxIdValidation::fail(
            "EIN must be 9 digits, formatted XX-XXXXXXX (for example 12-3456789)",
        );
    };
    let prefix = &digits[..2];
    let n: i64 = prefix.parse().unwrap_or(-1);
    if !EIN_VALID_PREFIX_RANGES
        .iter()
        .any(|(from, to)| n >= *from && n <= *to)
    {
        return TaxIdValidation::fail(format!("EIN prefix {prefix} is not one the IRS assigns"));
    }
    TaxIdValidation::ok(format!("{}-{}", &digits[..2], &digits[2..9]))
}

/// `validateSsn(value)`.
pub fn validate_ssn(value: &str) -> TaxIdValidation {
    let trimmed = js_trim(value);
    let Some((area, group, serial)) = ssn_parts(trimmed) else {
        return TaxIdValidation::fail(
            "SSN must be 9 digits, formatted XXX-XX-XXXX (for example 123-45-6789)",
        );
    };
    let area_number: i64 = area.parse().unwrap_or(0);
    if area_number == 0 || area_number == 666 || area_number >= 900 {
        return TaxIdValidation::fail(format!("SSN area number {area} is not issued"));
    }
    if group == "00" {
        return TaxIdValidation::fail("SSN group number 00 is not issued");
    }
    if serial == "0000" {
        return TaxIdValidation::fail("SSN serial number 0000 is not issued");
    }
    let all = format!("{area}{group}{serial}");
    if all == "078051120" || all == "219099999" {
        return TaxIdValidation::fail("This SSN was voided by the SSA");
    }
    TaxIdValidation::ok(format!("{area}-{group}-{serial}"))
}

/// `validateEinOrSsn(value)`.
pub fn validate_ein_or_ssn(value: &str) -> TaxIdValidation {
    let trimmed = js_trim(value);
    let b = trimmed.as_bytes();
    if b.len() == 11 && b[3] == b'-' && b[6] == b'-' && ssn_parts(trimmed).is_some() {
        return validate_ssn(trimmed);
    }
    if b.len() == 10 && b[2] == b'-' && ein_digits(trimmed).is_some() {
        return validate_ein(trimmed);
    }
    if b.len() == 9 && digits(trimmed) {
        let ein = validate_ein(trimmed);
        if ein.valid {
            return ein;
        }
        let ssn = validate_ssn(trimmed);
        return if ssn.valid {
            ssn
        } else {
            TaxIdValidation::fail("Enter an EIN (12-3456789) or an SSN (123-45-6789)")
        };
    }
    TaxIdValidation::fail("Enter an EIN (12-3456789) or an SSN (123-45-6789)")
}

/// `validateStateTaxId(value)`.
pub fn validate_state_tax_id(value: &str) -> TaxIdValidation {
    let trimmed = js_trim(value);
    let length: usize = trimmed.chars().map(char::len_utf16).sum();
    if length == 0 {
        return TaxIdValidation::fail("State tax ID is required");
    }
    if length > 40 {
        return TaxIdValidation::fail("State tax ID is too long (40 characters at most)");
    }
    let mut chars = trimmed.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    let rest_ok =
        chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '/' | '#' | '-'));
    if !first_ok || !rest_ok {
        return TaxIdValidation::fail(
            "State tax ID may only contain letters, digits, spaces and - . / #",
        );
    }
    TaxIdValidation::ok(trimmed)
}

/// `validateZip(value)`: `12345`, `12345-6789` or nine digits.
pub fn validate_zip(value: &str) -> TaxIdValidation {
    let trimmed = js_trim(value);
    let b = trimmed.as_bytes();
    let (zip5, plus4) = match b.len() {
        5 if digits(trimmed) => (trimmed.to_owned(), None),
        9 if digits(trimmed) => (trimmed[..5].to_owned(), Some(trimmed[5..].to_owned())),
        10 if b[5] == b'-' && digits(&trimmed[..5]) && digits(&trimmed[6..]) => {
            (trimmed[..5].to_owned(), Some(trimmed[6..].to_owned()))
        }
        _ => {
            return TaxIdValidation::fail(
                "ZIP code must be 5 digits or ZIP+4 (12345 or 12345-6789)",
            );
        }
    };
    if zip5 == "00000" {
        return TaxIdValidation::fail("ZIP code is not valid");
    }
    TaxIdValidation::ok(match plus4 {
        Some(plus4) => format!("{zip5}-{plus4}"),
        None => zip5,
    })
}

/// `tinLast4(value)`: the last four of nine digits, else `None`.
pub fn tin_last4(value: &str) -> Option<String> {
    if value.is_empty()
        || !value
            .chars()
            .all(|c| c.is_ascii_digit() || c == '-' || super::is_js_space(c))
    {
        return None;
    }
    let digits = strip(value, &['-']);
    (digits.len() == 9).then(|| digits[5..].to_owned())
}

/// `maskTin(value, type)`: `***-**-6789` (SSN, ITIN) or `**-***6789` (EIN).
/// Without a type, `XX-XXXXXXX` is an EIN and anything else personal.
pub fn mask_tin(value: &str, tin_type: Option<&str>) -> String {
    let trimmed = js_trim(value);
    let b = trimmed.as_bytes();
    let ein = match tin_type {
        Some(t) => t == "ein",
        None => b.len() == 10 && b[2] == b'-' && ein_digits(trimmed).is_some(),
    };
    let only_digits = trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || c == '-' || super::is_js_space(c));
    let digits = if only_digits {
        strip(trimmed, &['-'])
    } else {
        String::new()
    };
    let last4 = if digits.len() >= 4 {
        digits[digits.len() - 4..].to_owned()
    } else {
        "****".to_owned()
    };
    if ein {
        format!("**-***{last4}")
    } else {
        format!("***-**-{last4}")
    }
}

/// `US_STATES`: the states (and DC) as sales tax jurisdictions, as
/// `UsStateInfo` objects (`code`, `name`, `fips`, sourcing, rounding, ...).
pub fn states() -> &'static [Value] {
    DATA["us"]["states"].as_array().map_or(&[], Vec::as_slice)
}

/// `getUsState(code)`: by USPS code, trimmed, in any case.
pub fn state(code: Option<&str>) -> Option<&'static Value> {
    let upper = js_trim(code.filter(|c| !c.is_empty())?).to_uppercase();
    states()
        .iter()
        .find(|s| s["code"].as_str() == Some(upper.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers() {
        assert_eq!(
            validate_ein("123456789").formatted.as_deref(),
            Some("12-3456789")
        );
        assert!(!validate_ein("07-1234567").valid);
        assert_eq!(
            validate_ssn("123456789").formatted.as_deref(),
            Some("123-45-6789")
        );
        assert_eq!(
            validate_ein_or_ssn("123-45-6789").formatted.as_deref(),
            Some("123-45-6789")
        );
        assert_eq!(tin_last4("123-45-6789").as_deref(), Some("6789"));
        assert_eq!(mask_tin("12-3456789", None), "**-***6789");
        assert_eq!(
            validate_zip("02134-1234").formatted.as_deref(),
            Some("02134-1234")
        );
    }
}
