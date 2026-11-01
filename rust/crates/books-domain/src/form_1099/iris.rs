//! The IRS IRIS upload files of 1099-NEC / 1099-MISC (`us-compliance/iris-csv`):
//! the column layout of the IRS templates (or a downloaded template's own
//! header row), cleaned and clipped values, at most 100 records per file.

use unicode_normalization::UnicodeNormalization;

use super::form_1099_box;

/// `IRIS_MAX_RECORDS_PER_FILE`.
pub const MAX_RECORDS_PER_FILE: usize = 100;

/// `IrisAddress`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Address {
    pub line1: String,
    pub line2: Option<String>,
    pub city: String,
    pub state: String,
    pub zip: String,
    pub country: Option<String>,
}

/// `IrisPayer`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Payer {
    pub name: String,
    pub name_line2: Option<String>,
    /// `ein` or `ssn`.
    pub tin_type: String,
    pub tin: String,
    pub address: Address,
    pub phone: Option<String>,
    pub email: Option<String>,
}

/// `IrisRecipientState`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StateEntry {
    pub code: String,
    pub payer_state_number: Option<String>,
    pub withheld: Option<f64>,
    pub income: Option<f64>,
}

/// `IrisRecipient`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Recipient {
    pub id: Option<String>,
    pub legal_name: String,
    pub business_name: Option<String>,
    /// `ein`, `ssn` or `itin`.
    pub tin_type: String,
    pub tin: String,
    pub address: Address,
    pub account_number: Option<String>,
    pub corrected: bool,
    /// `(box code, amount)`.
    pub boxes: Vec<(String, f64)>,
    pub states: Vec<StateEntry>,
}

/// `IrisCsvFile`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CsvFile {
    pub filename: String,
    pub content: String,
    pub record_count: usize,
    pub warnings: Vec<String>,
}

struct Column {
    header: &'static str,
    key: &'static str,
    aliases: &'static [&'static str],
}

const fn col(header: &'static str, key: &'static str, aliases: &'static [&'static str]) -> Column {
    Column {
        header,
        key,
        aliases,
    }
}

const PAYER_AND_RECIPIENT: [Column; 37] = [
    col("Form Type", "form_type", &[]),
    col("Tax Year", "tax_year", &[]),
    col("Payer TIN Type", "payer_tin_type", &["Issuer TIN Type"]),
    col(
        "Payer Taxpayer ID Number",
        "payer_tin",
        &["Issuer Taxpayer ID Number", "Payer TIN"],
    ),
    col("Payer Name Type", "payer_name_type", &["Issuer Name Type"]),
    col(
        "Payer Business or Entity Name Line 1",
        "payer_name_1",
        &[
            "Payer Business Name Line 1",
            "Issuer Business or Entity Name Line 1",
        ],
    ),
    col(
        "Payer Business or Entity Name Line 2",
        "payer_name_2",
        &[
            "Payer Business Name Line 2",
            "Issuer Business or Entity Name Line 2",
        ],
    ),
    col("Payer First Name", "payer_first", &["Issuer First Name"]),
    col("Payer Middle Name", "payer_middle", &["Issuer Middle Name"]),
    col("Payer Last Name", "payer_last", &["Issuer Last Name"]),
    col("Payer Suffix", "payer_suffix", &["Issuer Suffix"]),
    col(
        "Payer Address Line 1",
        "payer_address_1",
        &["Issuer Address Line 1"],
    ),
    col(
        "Payer Address Line 2",
        "payer_address_2",
        &["Issuer Address Line 2"],
    ),
    col("Payer City", "payer_city", &["Issuer City"]),
    col("Payer State", "payer_state", &["Issuer State"]),
    col(
        "Payer ZIP Code",
        "payer_zip",
        &["Issuer ZIP Code", "Payer Zip"],
    ),
    col("Payer Country", "payer_country", &["Issuer Country"]),
    col(
        "Payer Phone Number",
        "payer_phone",
        &["Issuer Phone Number", "Payer Telephone Number"],
    ),
    col(
        "Payer Email Address",
        "payer_email",
        &["Issuer Email Address"],
    ),
    col("Recipient TIN Type", "recipient_tin_type", &[]),
    col(
        "Recipient Taxpayer ID Number",
        "recipient_tin",
        &["Recipient TIN"],
    ),
    col("Recipient Name Type", "recipient_name_type", &[]),
    col(
        "Recipient Business or Entity Name Line 1",
        "recipient_name_1",
        &["Business Name Line 1", "Recipient Business Name Line 1"],
    ),
    col(
        "Recipient Business or Entity Name Line 2",
        "recipient_name_2",
        &["Business Name Line 2", "Recipient Business Name Line 2"],
    ),
    col("Recipient First Name", "recipient_first", &[]),
    col("Recipient Middle Name", "recipient_middle", &[]),
    col("Recipient Last Name", "recipient_last", &[]),
    col("Recipient Suffix", "recipient_suffix", &[]),
    col("Recipient Address Line 1", "recipient_address_1", &[]),
    col("Recipient Address Line 2", "recipient_address_2", &[]),
    col("Recipient City", "recipient_city", &[]),
    col("Recipient State", "recipient_state", &[]),
    col("Recipient ZIP Code", "recipient_zip", &["Recipient Zip"]),
    col("Recipient Country", "recipient_country", &[]),
    col("Form Account Number", "account_number", &["Account Number"]),
    col("Second TIN Notice", "second_tin_notice", &[]),
    col("Corrected", "corrected", &["Corrected Indicator"]),
];

const STATES: [Column; 8] = [
    col("State 1 - State Code", "state1_code", &[]),
    col("State 1 - State Tax Withheld", "state1_withheld", &[]),
    col("State 1 - State/Payer's State No.", "state1_number", &[]),
    col("State 1 - State Income", "state1_income", &[]),
    col("State 2 - State Code", "state2_code", &[]),
    col("State 2 - State Tax Withheld", "state2_withheld", &[]),
    col("State 2 - State/Payer's State No.", "state2_number", &[]),
    col("State 2 - State Income", "state2_income", &[]),
];

const NEC_BOXES: [Column; 4] = [
    col(
        "Box 1 - Nonemployee Compensation",
        "box:nec_1",
        &["Box 1a - Nonemployee Compensation"],
    ),
    col(
        "Box 2 - Direct Sales Indicator",
        "direct_sales",
        &[
            "Box 2 - Direct Sales",
            "Box 2 - Payer Made Direct Sales Totaling $5,000 or More of Consumer Products to Recipient for Resale",
        ],
    ),
    col("Box 3 - Excess Golden Parachute Payments", "box:nec_3", &[]),
    col("Box 4 - Federal Income Tax Withheld", "box:nec_4", &[]),
];

const MISC_BOXES: [Column; 14] = [
    col("Box 1 - Rents", "box:misc_1", &[]),
    col("Box 2 - Royalties", "box:misc_2", &[]),
    col("Box 3 - Other Income", "box:misc_3", &[]),
    col("Box 4 - Federal Income Tax Withheld", "box:misc_4", &[]),
    col("Box 5 - Fishing Boat Proceeds", "box:misc_5", &[]),
    col(
        "Box 6 - Medical and Health Care Payments",
        "box:misc_6",
        &[],
    ),
    col(
        "Box 7 - Direct Sales Indicator",
        "direct_sales",
        &[
            "Box 7 - Direct Sales",
            "Box 7 - Payer Made Direct Sales Totaling $5,000 or More of Consumer Products to Recipient for Resale",
        ],
    ),
    col(
        "Box 8 - Substitute Payments in Lieu of Dividends or Interest",
        "box:misc_8",
        &[],
    ),
    col("Box 9 - Crop Insurance Proceeds", "box:misc_9", &[]),
    col(
        "Box 10 - Gross Proceeds Paid to an Attorney",
        "box:misc_10",
        &[],
    ),
    col("Box 11 - Fish Purchased for Resale", "box:misc_11", &[]),
    col("Box 12 - Section 409A Deferrals", "box:misc_12", &[]),
    col("Box 13 - FATCA Filing Requirement", "fatca", &[]),
    col(
        "Box 14 - Nonqualified Deferred Compensation",
        "box:misc_14",
        &[],
    ),
];

fn columns_for(form: &str) -> Vec<&'static Column> {
    let boxes: &'static [Column] = if form == "nec" {
        &NEC_BOXES
    } else {
        &MISC_BOXES
    };
    PAYER_AND_RECIPIENT
        .iter()
        .chain(boxes)
        .chain(STATES.iter())
        .collect()
}

/// `irisFormLabel(form)`.
pub fn form_label(form: &str) -> &'static str {
    if form == "nec" {
        "1099-NEC"
    } else {
        "1099-MISC"
    }
}

fn normalize_header(header: &str) -> String {
    header
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '$')
        .collect()
}

/// `cleanIrisText(value, allowSlash)`: accents stripped, only the characters
/// IRIS takes, spaces collapsed, no leading formula characters.
pub fn clean_text(value: Option<&str>, allow_slash: bool) -> String {
    let decomposed: String = value.unwrap_or_default().nfd().collect();
    let kept: String = decomposed
        .chars()
        .filter(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, ' ' | '&' | '\'' | '-' | '#' | '(' | ')')
                || (allow_slash && *c == '/')
        })
        .collect();
    let collapsed = kept
        .split(' ')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let start = collapsed
        .char_indices()
        .find(|(_, c)| !matches!(c, '-' | '=' | '+' | '@' | ' '))
        .map_or(collapsed.len(), |(i, _)| i);
    collapsed[start..].trim().to_owned()
}

fn digits(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_digit)
        .collect()
}

fn amount(value: Option<f64>) -> String {
    let Some(value) = value.filter(|v| v.is_finite()) else {
        return String::new();
    };
    let cents = super::compute::to_cents(value);
    if cents == 0 {
        return String::new();
    }
    #[allow(clippy::cast_precision_loss)]
    crate::js::to_fixed(cents as f64 / 100.0, 2)
}

fn flag(value: bool) -> &'static str {
    if value { "Y" } else { "N" }
}

fn tin_label(tin_type: &str) -> &'static str {
    match tin_type {
        "ssn" => "SSN",
        "itin" => "ITIN",
        _ => "EIN",
    }
}

/// `escapeCsvField(value)`.
pub fn escape_csv(value: &str) -> String {
    if value.contains(['"', ',', '\r', '\n']) || value != value.trim() {
        return format!("\"{}\"", value.replace('"', "\"\""));
    }
    value.to_owned()
}

const SUFFIXES: [&str; 6] = ["JR", "SR", "II", "III", "IV", "V"];

/// `splitPersonName(full)`: first, middle, last, suffix.
pub fn split_person_name(full: &str) -> (String, String, String, String) {
    let cleaned = clean_text(Some(&full.replace([',', '.'], " ")), false);
    let mut tokens: Vec<&str> = cleaned.split(' ').filter(|t| !t.is_empty()).collect();
    let mut suffix = String::new();
    if tokens.len() >= 3
        && let Some(last) = tokens.last()
        && SUFFIXES.contains(&last.to_uppercase().as_str())
    {
        suffix = (*last).to_owned();
        tokens.pop();
    }
    match tokens.len() {
        0 => (String::new(), String::new(), String::new(), suffix),
        1 => (String::new(), String::new(), tokens[0].to_owned(), suffix),
        n => (
            tokens[0].to_owned(),
            tokens[1..n - 1].join(" "),
            tokens[n - 1].to_owned(),
            suffix,
        ),
    }
}

struct NameBlock {
    name_type: &'static str,
    line1: String,
    line2: String,
    first: String,
    middle: String,
    last: String,
    suffix: String,
}

fn fit(value: &str, max: usize, label: &str, warnings: &mut Vec<String>) -> String {
    if crate::js::utf16_len(value) <= max {
        return value.to_owned();
    }
    warnings.push(format!(
        "{label} is longer than {max} characters and was shortened."
    ));
    crate::js::slice_utf16(value, max).trim().to_owned()
}

const NAME_MAX: usize = 40;

fn business_lines(
    name: &str,
    second: &str,
    label: &str,
    warnings: &mut Vec<String>,
) -> (String, String) {
    if crate::js::utf16_len(name) <= NAME_MAX {
        return (
            name.to_owned(),
            fit(second, NAME_MAX, &format!("{label} line 2"), warnings),
        );
    }
    if !second.is_empty() {
        return (
            fit(name, NAME_MAX, &format!("{label} line 1"), warnings),
            fit(second, NAME_MAX, &format!("{label} line 2"), warnings),
        );
    }
    // `name.lastIndexOf(' ', NAME_MAX)`: names are ASCII once cleaned.
    let cut = name
        .char_indices()
        .filter(|(i, c)| *c == ' ' && *i <= NAME_MAX)
        .map(|(i, _)| i)
        .next_back();
    match cut {
        Some(cut) if cut > 0 => (
            name[..cut].trim().to_owned(),
            fit(
                name[cut + 1..].trim(),
                NAME_MAX,
                &format!("{label} line 2"),
                warnings,
            ),
        ),
        _ => (
            fit(name, NAME_MAX, &format!("{label} line 1"), warnings),
            String::new(),
        ),
    }
}

fn recipient_name(recipient: &Recipient, label: &str, warnings: &mut Vec<String>) -> NameBlock {
    let legal = clean_text(Some(&recipient.legal_name), false);
    let business = clean_text(recipient.business_name.as_deref(), false);
    let business_block = |line1: String, line2: String| NameBlock {
        name_type: "B",
        line1,
        line2,
        first: String::new(),
        middle: String::new(),
        last: String::new(),
        suffix: String::new(),
    };
    if recipient.tin_type == "ein" {
        let second = if !business.is_empty() && business != legal {
            business.clone()
        } else {
            String::new()
        };
        let (line1, line2) = business_lines(&legal, &second, label, warnings);
        return business_block(line1, line2);
    }
    if !business.is_empty() && business != legal {
        let (line1, line2) = business_lines(&legal, &business, label, warnings);
        return business_block(line1, line2);
    }
    let (first, middle, last, suffix) = split_person_name(&legal);
    if first.is_empty() || last.is_empty() {
        warnings.push(format!(
            "{label}: the individual name needs a first and a last name."
        ));
    }
    NameBlock {
        name_type: "I",
        line1: String::new(),
        line2: String::new(),
        first: fit(&first, 20, &format!("{label} first name"), warnings),
        middle: fit(&middle, 20, &format!("{label} middle name"), warnings),
        last: fit(&last, 20, &format!("{label} last name"), warnings),
        suffix: fit(&suffix, 10, &format!("{label} suffix"), warnings),
    }
}

struct AddressBlock {
    line1: String,
    line2: String,
    city: String,
    state: String,
    zip: String,
    country: String,
}

fn address(source: &Address, label: &str, warnings: &mut Vec<String>) -> AddressBlock {
    let zip = digits(Some(&source.zip));
    if zip.len() != 5 && zip.len() != 9 && source.country.as_deref().is_none_or(str::is_empty) {
        warnings.push(format!("{label}: ZIP code must have 5 or 9 digits."));
    }
    let state = clean_text(Some(&source.state), false).to_uppercase();
    let line1 = fit(
        &clean_text(Some(&source.line1), true),
        35,
        &format!("{label} address line 1"),
        warnings,
    );
    let city = fit(
        &clean_text(Some(&source.city), false),
        22,
        &format!("{label} city"),
        warnings,
    );
    if line1.is_empty() || city.is_empty() || state.is_empty() {
        warnings.push(format!("{label}: the address is incomplete."));
    }
    AddressBlock {
        line2: fit(
            &clean_text(source.line2.as_deref(), true),
            35,
            &format!("{label} address line 2"),
            warnings,
        ),
        line1,
        city,
        state,
        zip,
        country: clean_text(source.country.as_deref(), false).to_uppercase(),
    }
}

struct Context<'a> {
    tax_year: i64,
    form: &'a str,
    payer: &'a Payer,
    payer_name: &'a NameBlock,
    payer_address: &'a AddressBlock,
    recipient: &'a Recipient,
    name: NameBlock,
    address: AddressBlock,
}

fn state_value(recipient: &Recipient, index: usize, field: &str) -> String {
    let Some(state) = recipient.states.get(index) else {
        return String::new();
    };
    match field {
        "code" => clean_text(Some(&state.code), false).to_uppercase(),
        "withheld" => amount(state.withheld),
        "number" => clean_text(state.payer_state_number.as_deref(), false),
        _ => amount(state.income),
    }
}

#[allow(clippy::too_many_lines)] // one arm per column
fn field_value(key: &str, ctx: &Context<'_>) -> String {
    if let Some(code) = key.strip_prefix("box:") {
        if form_1099_box(code).is_some_and(|d| d.kind == "amount") {
            return amount(
                ctx.recipient
                    .boxes
                    .iter()
                    .find(|(c, _)| c == code)
                    .map(|(_, v)| *v),
            );
        }
        return String::new();
    }
    let r = ctx.recipient;
    match key {
        "form_type" => form_label(ctx.form).to_owned(),
        "tax_year" => ctx.tax_year.to_string(),
        "payer_tin_type" => tin_label(&ctx.payer.tin_type).to_owned(),
        "payer_tin" => digits(Some(&ctx.payer.tin)),
        "payer_name_type" => ctx.payer_name.name_type.to_owned(),
        "payer_name_1" => ctx.payer_name.line1.clone(),
        "payer_name_2" => ctx.payer_name.line2.clone(),
        "payer_address_1" => ctx.payer_address.line1.clone(),
        "payer_address_2" => ctx.payer_address.line2.clone(),
        "payer_city" => ctx.payer_address.city.clone(),
        "payer_state" => ctx.payer_address.state.clone(),
        "payer_zip" => ctx.payer_address.zip.clone(),
        "payer_country" => ctx.payer_address.country.clone(),
        "payer_phone" => {
            let phone = digits(ctx.payer.phone.as_deref());
            if phone.len() == 11 && phone.starts_with('1') {
                phone[1..].to_owned()
            } else {
                phone
            }
        }
        "payer_email" => ctx
            .payer
            .email
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_owned(),
        "recipient_tin_type" => tin_label(&r.tin_type).to_owned(),
        "recipient_tin" => digits(Some(&r.tin)),
        "recipient_name_type" => ctx.name.name_type.to_owned(),
        "recipient_name_1" => ctx.name.line1.clone(),
        "recipient_name_2" => ctx.name.line2.clone(),
        "recipient_first" => ctx.name.first.clone(),
        "recipient_middle" => ctx.name.middle.clone(),
        "recipient_last" => ctx.name.last.clone(),
        "recipient_suffix" => ctx.name.suffix.clone(),
        "recipient_address_1" => ctx.address.line1.clone(),
        "recipient_address_2" => ctx.address.line2.clone(),
        "recipient_city" => ctx.address.city.clone(),
        "recipient_state" => ctx.address.state.clone(),
        "recipient_zip" => ctx.address.zip.clone(),
        "recipient_country" => ctx.address.country.clone(),
        "account_number" => {
            let cleaned = clean_text(r.account_number.as_deref(), false).replace(' ', "");
            cleaned.chars().take(20).collect()
        }
        "second_tin_notice" | "direct_sales" | "fatca" => flag(false).to_owned(),
        "corrected" => flag(r.corrected).to_owned(),
        "state1_code" => state_value(r, 0, "code"),
        "state1_withheld" => state_value(r, 0, "withheld"),
        "state1_number" => state_value(r, 0, "number"),
        "state1_income" => state_value(r, 0, "income"),
        "state2_code" => state_value(r, 1, "code"),
        "state2_withheld" => state_value(r, 1, "withheld"),
        "state2_number" => state_value(r, 1, "number"),
        "state2_income" => state_value(r, 1, "income"),
        _ => String::new(),
    }
}

/// `validateIrisRecipient(recipient, form)`.
pub fn validate_recipient(recipient: &Recipient, form: &str) -> Vec<String> {
    let mut issues = Vec::new();
    if digits(Some(&recipient.tin)).len() != 9 {
        issues.push("The TIN must have 9 digits.".to_owned());
    }
    if clean_text(Some(&recipient.legal_name), false).is_empty() {
        issues.push("The name is missing.".to_owned());
    }
    let any_amount = recipient.boxes.iter().any(|(code, value)| {
        form_1099_box(code).is_some_and(|d| d.form == form && d.kind == "amount")
            && super::compute::to_cents(*value) > 0
    });
    if !any_amount {
        issues.push(format!("No {} amount.", form_label(form)));
    }
    for (code, value) in &recipient.boxes {
        if super::compute::to_cents(*value) < 0 {
            issues.push(format!(
                "Box {code} is negative; IRIS accepts only positive amounts."
            ));
        }
        if form_1099_box(code).is_some_and(|d| d.form != form) {
            issues.push(format!("Box {code} belongs to the other form."));
        }
    }
    if recipient.states.len() > 2 {
        issues.push("Only two states fit on the form.".to_owned());
    }
    issues
}

/// `generateIrisCsv({ taxYear, form, payer, recipients, templateHeaders })`.
pub fn generate_iris_csv(
    tax_year: i64,
    form: &str,
    payer: &Payer,
    recipients: &[Recipient],
    template_headers: Option<&[String]>,
) -> Vec<CsvFile> {
    if recipients.is_empty() {
        return Vec::new();
    }
    let built_in = columns_for(form);
    let (columns, unmatched, missing): (Vec<(String, Option<&str>)>, Vec<String>, Vec<&str>) =
        match template_headers.filter(|h| !h.is_empty()) {
            None => (
                built_in
                    .iter()
                    .map(|c| (c.header.to_owned(), Some(c.key)))
                    .collect(),
                Vec::new(),
                Vec::new(),
            ),
            Some(headers) => {
                let mut lookup: Vec<(String, &'static str)> = Vec::new();
                for column in &built_in {
                    lookup.push((normalize_header(column.header), column.key));
                    for alias in column.aliases {
                        lookup.push((normalize_header(alias), column.key));
                    }
                }
                let mut used: Vec<&str> = Vec::new();
                let mut unmatched = Vec::new();
                let columns = headers
                    .iter()
                    .map(|header| {
                        let normalized = normalize_header(header);
                        // `Map.set` keeps the last value of a repeated key.
                        let key = lookup
                            .iter()
                            .rev()
                            .find(|(h, _)| *h == normalized)
                            .map(|(_, k)| *k);
                        match key {
                            Some(key) => used.push(key),
                            None => unmatched.push(header.clone()),
                        }
                        (header.clone(), key)
                    })
                    .collect();
                let missing = built_in
                    .iter()
                    .map(|c| c.key)
                    .filter(|k| !used.contains(k))
                    .collect();
                (columns, unmatched, missing)
            }
        };
    let mut base_warnings: Vec<String> = unmatched
        .iter()
        .map(|h| format!("Template column \"{h}\" is not recognised and stays empty."))
        .collect();
    if !missing.is_empty() {
        base_warnings.push(format!(
            "The template has no column for: {}.",
            missing.join(", ")
        ));
    }

    let mut payer_warnings = Vec::new();
    let payer_name = {
        let legal = clean_text(Some(&payer.name), false);
        let second = clean_text(payer.name_line2.as_deref(), false);
        let (line1, line2) = business_lines(&legal, &second, "Payer name", &mut payer_warnings);
        NameBlock {
            name_type: "B",
            line1,
            line2,
            first: String::new(),
            middle: String::new(),
            last: String::new(),
            suffix: String::new(),
        }
    };
    let payer_address = address(&payer.address, "Payer", &mut payer_warnings);
    if digits(Some(&payer.tin)).len() != 9 {
        payer_warnings.push("Payer: the TIN must have 9 digits.".to_owned());
    }

    let total = recipients.len().div_ceil(MAX_RECORDS_PER_FILE);
    let mut files = Vec::new();
    for (part, chunk) in recipients.chunks(MAX_RECORDS_PER_FILE).enumerate() {
        let mut warnings: Vec<String> = base_warnings
            .iter()
            .chain(&payer_warnings)
            .cloned()
            .collect();
        let mut lines = vec![
            columns
                .iter()
                .map(|(header, _)| escape_csv(header))
                .collect::<Vec<_>>()
                .join(","),
        ];
        for (index, recipient) in chunk.iter().enumerate() {
            let label = format!(
                "Recipient {}",
                recipient
                    .id
                    .clone()
                    .unwrap_or_else(|| (part * MAX_RECORDS_PER_FILE + index + 1).to_string())
            );
            let mut record_warnings: Vec<String> = validate_recipient(recipient, form)
                .into_iter()
                .map(|issue| format!("{label}: {issue}"))
                .collect();
            let name = recipient_name(recipient, &label, &mut record_warnings);
            let address = address(&recipient.address, &label, &mut record_warnings);
            let ctx = Context {
                tax_year,
                form,
                payer,
                payer_name: &payer_name,
                payer_address: &payer_address,
                recipient,
                name,
                address,
            };
            warnings.extend(record_warnings);
            lines.push(
                columns
                    .iter()
                    .map(|(_, key)| {
                        escape_csv(&key.map(|k| field_value(k, &ctx)).unwrap_or_default())
                    })
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        let prefix = format!("iris-1099-{form}-{tax_year}");
        files.push(CsvFile {
            filename: if total == 1 {
                format!("{prefix}.csv")
            } else {
                format!("{prefix}-{:03}-of-{total:03}.csv", part + 1)
            },
            content: format!("{}\r\n", lines.join("\r\n")),
            record_count: chunk.len(),
            warnings,
        });
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleaning_and_names() {
        assert_eq!(
            clean_text(Some("  =José  O'Brien & Co. "), false),
            "Jose O'Brien & Co"
        );
        assert_eq!(
            split_person_name("Smith, John Q Jr"),
            ("Smith".into(), "John".into(), "Q".into(), "Jr".into())
        );
        assert_eq!(escape_csv("a,b"), "\"a,b\"");
        assert_eq!(escape_csv(" x"), "\" x\"");
    }
}
