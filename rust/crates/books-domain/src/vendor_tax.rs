//! Vendor tax data on `parties` (books-api's `services/vendor-tax-data`):
//! the W-9 facts, the encrypted TIN and the vendor's ACH details, and the
//! online W-9 request tokens (`services/w9-requests`).
//!
//! The full TIN and the ACH account number live only in
//! `parties.sensitive_encrypted`, a JSON blob `{ tin?, achAccountNumber? }`
//! sealed with `DATABASE_ENCRYPTION_KEY`. Responses carry the last four
//! digits; a full value comes back only through [`reveal_party_secret`],
//! which writes the `tax_id_reveals` row before it returns anything. No
//! value leaves this module in an error message.
//!
//! A change to the routing number, the account number or the account type
//! sets `bank_details_changed_at` and clears the verification: payment runs
//! hold a vendor whose bank details are unverified.

use base64::Engine as _;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use weldsuite_db::{Keyring, PgPool, decrypt_field, encrypt_field};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Format, Issues, Presence, Text, js_date_iso};

use crate::http::now;
use crate::jurisdictions::us::{tin_last4, validate_ein, validate_ssn};
use crate::jurisdictions::{TaxIdValidation, is_js_space, js_trim};

// ---------------------------------------------------------------------------
// US identifiers the vendor data needs (`jurisdictions/us/identifiers`,
// `jurisdictions/us/form-1099`, `us-compliance/form-1099-pdf-data`)
// ---------------------------------------------------------------------------

/// `TIN_TYPES`.
pub const TIN_TYPES: [&str; 3] = ["ein", "ssn", "itin"];

/// `isTinType(value)`.
pub fn is_tin_type(value: Option<&str>) -> bool {
    value.is_some_and(|v| TIN_TYPES.contains(&v))
}

/// `XXX-XX-XXXX` or nine digits, as `(area, group, serial)`.
fn ssn_parts(value: &str) -> Option<(&str, &str, &str)> {
    let b = value.as_bytes();
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    if b.len() == 11 && b[3] == b'-' && b[6] == b'-' {
        let (area, group, serial) = (&value[..3], &value[4..6], &value[7..]);
        return (digits(area) && digits(group) && digits(serial)).then_some((area, group, serial));
    }
    (b.len() == 9 && digits(value)).then(|| (&value[..3], &value[3..5], &value[5..]))
}

/// `validateItin(value)`.
pub fn validate_itin(value: &str) -> TaxIdValidation {
    let trimmed = js_trim(value);
    let Some((area, group, serial)) = ssn_parts(trimmed) else {
        return TaxIdValidation::fail(
            "ITIN must be 9 digits, formatted 9XX-XX-XXXX (for example 912-70-1234)",
        );
    };
    if !area.starts_with('9') {
        return TaxIdValidation::fail("An ITIN starts with 9");
    }
    let middle: i64 = group.parse().unwrap_or(-1);
    let ranges = [(50, 65), (70, 88), (90, 92), (94, 99)];
    if !ranges
        .iter()
        .any(|(from, to)| middle >= *from && middle <= *to)
    {
        return TaxIdValidation::fail(format!(
            "ITIN digits 4-5 ({group}) are outside the ranges the IRS issues"
        ));
    }
    TaxIdValidation::ok(format!("{area}-{group}-{serial}"))
}

/// `validateTin(type, value)`.
pub fn validate_tin(tin_type: &str, value: &str) -> TaxIdValidation {
    match tin_type {
        "ein" => validate_ein(value),
        "ssn" => validate_ssn(value),
        _ => validate_itin(value),
    }
}

/// `validateRoutingNumber(value)`: nine digits, a Federal Reserve prefix and
/// the ABA checksum.
pub fn validate_routing_number(value: &str) -> TaxIdValidation {
    let trimmed = js_trim(value);
    if trimmed.is_empty()
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_digit() || is_js_space(c))
    {
        return TaxIdValidation::fail("Routing number must be 9 digits");
    }
    let digits: String = trimmed.chars().filter(char::is_ascii_digit).collect();
    if digits.len() != 9 {
        return TaxIdValidation::fail("Routing number must be 9 digits");
    }
    if digits.bytes().all(|b| b == b'0') {
        return TaxIdValidation::fail("Routing number is not valid");
    }
    let prefix: i64 = digits[..2].parse().unwrap_or(-1);
    let ranges = [(0, 12), (21, 32), (61, 72), (80, 80)];
    if !ranges
        .iter()
        .any(|(from, to)| prefix >= *from && prefix <= *to)
    {
        return TaxIdValidation::fail(format!(
            "Routing number prefix {} is not a Federal Reserve district",
            &digits[..2]
        ));
    }
    let d: Vec<u32> = digits.chars().filter_map(|c| c.to_digit(10)).collect();
    let sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
    if !sum.is_multiple_of(10) {
        return TaxIdValidation::fail("Routing number checksum does not match, check for a typo");
    }
    TaxIdValidation::ok(digits)
}

/// `formatTin(tinType, tin)`: `12-3456789` or `123-45-6789`; the digits as
/// they are when there aren't nine.
pub fn format_tin(tin_type: &str, tin: &str) -> String {
    let digits = digits_only(tin);
    if digits.len() != 9 {
        return digits;
    }
    if tin_type == "ein" {
        format!("{}-{}", &digits[..2], &digits[2..])
    } else {
        format!("{}-{}-{}", &digits[..3], &digits[3..5], &digits[5..])
    }
}

/// `FORM_1099_OMIT`.
pub const FORM_1099_OMIT: &str = "omit";

/// `isAllocatableBox(code)`: the amount boxes other than tax withheld.
pub fn is_allocatable_box(code: &str) -> bool {
    matches!(
        code,
        "nec_1"
            | "nec_3"
            | "misc_1"
            | "misc_2"
            | "misc_3"
            | "misc_5"
            | "misc_6"
            | "misc_8"
            | "misc_9"
            | "misc_10"
            | "misc_11"
            | "misc_12"
            | "misc_14"
    )
}

/// `isCorporationClassification(federal, llc)` (`us-compliance/form-1099-compute`).
pub fn is_corporation_classification(federal: Option<&str>, llc: Option<&str>) -> bool {
    let normalize = |value: Option<&str>| -> String {
        value
            .unwrap_or_default()
            .to_lowercase()
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect()
    };
    let federal = normalize(federal);
    if federal.is_empty() {
        return false;
    }
    if federal.contains("ccorp")
        || federal.contains("scorp")
        || federal == "corporation"
        || federal == "corp"
    {
        return true;
    }
    if let Some(rest) = federal.strip_prefix("llc") {
        let own = normalize(llc);
        let llc = if own.is_empty() { rest.to_owned() } else { own };
        return llc == "c"
            || llc == "s"
            || llc.contains("ccorp")
            || llc.contains("scorp")
            || llc.starts_with("taxedasc")
            || llc.starts_with("taxedass");
    }
    false
}

/// `value.replace(/\D/g, '')`.
fn digits_only(value: &str) -> String {
    value.chars().filter(char::is_ascii_digit).collect()
}

// ---------------------------------------------------------------------------
// Request schema (merged into the contact create/update schema)
// ---------------------------------------------------------------------------

/// `W9_FEDERAL_CLASSIFICATIONS`.
pub const W9_FEDERAL_CLASSIFICATIONS: [&str; 7] = [
    "individual",
    "c_corporation",
    "s_corporation",
    "partnership",
    "trust_estate",
    "llc",
    "other",
];

/// The refinement message of `default1099Box`.
pub const DEFAULT_BOX_MESSAGE: &str = "Not a 1099 box code (for example nec_1 or misc_1)";

/// `VendorTaxInput`: the vendor tax fields of a contact body, as Zod let
/// them through.
#[derive(Debug, Clone, Default)]
pub struct VendorTaxInput {
    pub tax_use: Field<String>,
    pub is_1099_vendor: Field<bool>,
    pub default_1099_form: Field<String>,
    pub default_1099_box: Field<String>,
    pub tin_type: Field<String>,
    /// Write-only. `null` removes the stored TIN.
    pub tin: Field<String>,
    /// The W-9 keys the body set (`w9InputSchema.partial()`), trimmed.
    pub w9: Field<Map<String, Value>>,
    pub backup_withholding: Field<bool>,
    /// A datetime with an offset, or `true` (now) / `false` (withdrawn).
    pub form_1099_e_delivery_consent_at: Field<Value>,
    pub ach_routing_number: Field<String>,
    /// Write-only. `null` removes the stored account number.
    pub ach_account_number: Field<String>,
    pub ach_account_type: Field<String>,
}

/// The fields read, and whether `default1099Box`'s refinement failed: Zod
/// settles it after the body's synchronous checks, so the caller adds
/// `issues.custom("default1099Box", DEFAULT_BOX_MESSAGE)` once every other
/// field is read.
#[derive(Debug, Clone, Default)]
pub struct VendorTaxRead {
    pub input: VendorTaxInput,
    pub box_refine_failed: bool,
}

/// `w9InputSchema` (`.partial()`): the keys present, in the schema's order.
pub fn read_w9_input(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let text = |issues: &mut Issues, key: &str, max: usize, out: &mut Map<String, Value>| {
        if let Field::Set(value) = issues.text_with(
            body,
            key,
            Presence::Optional,
            Text::trimmed(None, Some(max)),
        ) {
            out.insert(key.to_owned(), Value::String(value));
        }
    };
    text(issues, "legalName", 100, &mut out);
    text(issues, "businessName", 100, &mut out);
    if let Field::Set(value) = issues.choice(
        body,
        "federalTaxClassification",
        Presence::Optional,
        &W9_FEDERAL_CLASSIFICATIONS,
    ) {
        out.insert("federalTaxClassification".to_owned(), Value::String(value));
    }
    if let Field::Set(value) = issues.choice(
        body,
        "llcTaxClassification",
        Presence::Optional,
        &["C", "S", "P"],
    ) {
        out.insert("llcTaxClassification".to_owned(), Value::String(value));
    }
    text(issues, "exemptPayeeCode", 2, &mut out);
    text(issues, "fatcaCode", 2, &mut out);
    if let Field::Set(value) = issues.pattern(
        body,
        "receivedAt",
        Presence::Optional,
        None,
        None,
        |s| {
            let b = s.as_bytes();
            b.len() >= 10
                && b[4] == b'-'
                && b[7] == b'-'
                && [0, 1, 2, 3, 5, 6, 8, 9]
                    .iter()
                    .all(|i| b[*i].is_ascii_digit())
        },
        "Use a YYYY-MM-DD date",
    ) {
        out.insert("receivedAt".to_owned(), Value::String(value));
    }
    text(issues, "documentId", 30, &mut out);
    text(issues, "signedName", 100, &mut out);
    if let Field::Set(value) =
        issues.choice(body, "source", Presence::Optional, &["upload", "online"])
    {
        out.insert("source".to_owned(), Value::String(value));
    }
    if let Field::Set(value) = issues.boolean(body, "isAttorney", Presence::Optional) {
        out.insert("isAttorney".to_owned(), Value::Bool(value));
    }
    out
}

/// `vendorTaxFields`, read from a body in the schema's order. `presence`
/// does not change: every field is optional (`.partial()` keeps them so).
pub fn read_vendor_tax(issues: &mut Issues, body: &Map<String, Value>) -> VendorTaxRead {
    let nullish = Presence::Nullish;
    let mut input = VendorTaxInput {
        tax_use: issues.choice(body, "taxUse", nullish, &["business", "personal"]),
        is_1099_vendor: issues.boolean(body, "is1099Vendor", Presence::Optional),
        default_1099_form: issues.choice(body, "default1099Form", nullish, &["nec", "misc"]),
        ..VendorTaxInput::default()
    };
    let mut box_refine_failed = false;
    let rules = Text {
        trim: true,
        lowercase: true,
        ..Text::default()
    };
    input.default_1099_box = match issues.text_with(body, "default1099Box", nullish, rules) {
        Field::Set(code) if code != FORM_1099_OMIT && !is_allocatable_box(&code) => {
            box_refine_failed = true;
            Field::Absent
        }
        other => other,
    };
    input.tin_type = issues.choice(body, "tinType", nullish, &TIN_TYPES);
    input.tin = issues.text_with(body, "tin", nullish, Text::trimmed(None, Some(20)));
    input.w9 = issues.nested(body, "w9", nullish, read_w9_input);
    input.backup_withholding = issues.boolean(body, "backupWithholding", Presence::Optional);
    input.form_1099_e_delivery_consent_at = read_consent(issues, body);
    input.ach_routing_number = issues.text_with(
        body,
        "achRoutingNumber",
        nullish,
        Text::trimmed(None, Some(20)),
    );
    input.ach_account_number = issues.text_with(
        body,
        "achAccountNumber",
        nullish,
        Text::trimmed(None, Some(40)),
    );
    input.ach_account_type =
        issues.choice(body, "achAccountType", nullish, &["checking", "savings"]);
    VendorTaxRead {
        input,
        box_refine_failed,
    }
}

/// `z.union([z.string().datetime({ offset: true }), z.boolean()]).nullable().optional()`:
/// a string that fails is the string option's own issue (Zod returns the
/// first dirty option), anything else one `invalid_union`.
fn read_consent(issues: &mut Issues, body: &Map<String, Value>) -> Field<Value> {
    const KEY: &str = "form1099EDeliveryConsentAt";
    match body.get(KEY) {
        None => Field::Absent,
        Some(Value::Null) => Field::Null,
        Some(Value::Bool(flag)) => Field::Set(Value::Bool(*flag)),
        Some(Value::String(_)) => {
            let rules = Text {
                format: Some(Format::DatetimeOffset),
                ..Text::default()
            };
            match issues.text_with(body, KEY, Presence::Required, rules) {
                Field::Set(text) => Field::Set(Value::String(text)),
                _ => Field::Absent,
            }
        }
        Some(other) => {
            let path = issues.path_of(KEY);
            let received = js_type_of(other);
            let option = |expected: &str| {
                json!({
                    "issues": [{
                        "code": "invalid_type",
                        "expected": expected,
                        "received": received,
                        "path": path,
                        "message": format!("Expected {expected}, received {received}"),
                    }],
                    "name": "ZodError",
                })
            };
            issues.push_raw(json!({
                "code": "invalid_union",
                "unionErrors": [option("string"), option("boolean")],
                "path": path,
                "message": "Invalid input",
            }));
            Field::Absent
        }
    }
}

/// Zod's parsed type name of a JSON value.
fn js_type_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// What [`build_vendor_tax_change`] and [`reveal_party_secret`] refuse with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VendorTaxError {
    /// `VendorTaxError`: a bad value; the message never contains it (400).
    Invalid(String),
    /// `VendorTaxKeyError`: no encryption key (503).
    NoKey,
    /// `SecretNotFoundError`: nothing of that kind on file (404).
    SecretNotFound(SecretField),
    /// Anything else (the stored blob doesn't open, a database error): 500.
    Internal(String),
}

/// `VendorTaxKeyError`'s message.
pub const NO_KEY_MESSAGE: &str =
    "Sensitive vendor data cannot be stored or read: the worker has no encryption key";

impl std::fmt::Display for VendorTaxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) | Self::Internal(message) => f.write_str(message),
            Self::NoKey => f.write_str(NO_KEY_MESSAGE),
            Self::SecretNotFound(field) => f.write_str(field.not_found_message()),
        }
    }
}

impl From<sqlx::Error> for VendorTaxError {
    fn from(error: sqlx::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

fn invalid(message: impl Into<String>) -> VendorTaxError {
    VendorTaxError::Invalid(message.into())
}

/// `requireKeyring(env)`.
pub fn require_keyring(keyring: &Keyring) -> Result<&Keyring, VendorTaxError> {
    if keyring.v1.is_none() && keyring.v2.is_none() {
        return Err(VendorTaxError::NoKey);
    }
    Ok(keyring)
}

// ---------------------------------------------------------------------------
// Sealing and reading the blob
// ---------------------------------------------------------------------------

/// `PartySensitive`: what `sensitive_encrypted` holds once decrypted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PartySensitive {
    pub tin: Option<String>,
    pub ach_account_number: Option<String>,
}

fn text_of<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// A non-empty string of a row (`if (row.x)`).
fn filled<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    text_of(row, key).filter(|v| !v.is_empty())
}

/// `readSensitive(party, keyring)`: the decrypted blob of a party row
/// (`sensitiveEncrypted`), empty without one.
pub fn read_sensitive(party: &Value, keyring: &Keyring) -> Result<PartySensitive, VendorTaxError> {
    let Some(sealed) = filled(party, "sensitiveEncrypted") else {
        return Ok(PartySensitive::default());
    };
    let plain = decrypt_field(sealed, keyring)
        .map_err(|error| VendorTaxError::Internal(format!("decrypt failed: {error:?}")))?;
    let blob: Value = serde_json::from_str(&plain)
        .map_err(|_| VendorTaxError::Internal("the sealed vendor data is not JSON".to_owned()))?;
    let field = |key: &str| blob.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(PartySensitive {
        tin: field("tin"),
        ach_account_number: field("achAccountNumber"),
    })
}

/// `seal(blob, keyring)`: `{ tin?, achAccountNumber? }` (empty values left
/// out) sealed, or `None` when there is nothing to keep. The JSON keeps
/// TypeScript's key order.
fn seal(blob: &PartySensitive, keyring: &Keyring) -> Result<Option<String>, VendorTaxError> {
    let mut parts = Vec::new();
    if let Some(tin) = blob.tin.as_deref().filter(|v| !v.is_empty()) {
        parts.push(format!("\"tin\":{}", Value::String(tin.to_owned())));
    }
    if let Some(account) = blob.ach_account_number.as_deref().filter(|v| !v.is_empty()) {
        parts.push(format!(
            "\"achAccountNumber\":{}",
            Value::String(account.to_owned())
        ));
    }
    if parts.is_empty() {
        return Ok(None);
    }
    let plain = format!("{{{}}}", parts.join(","));
    encrypt_field(&plain, keyring)
        .map(Some)
        .map_err(|error| VendorTaxError::Internal(format!("encrypt failed: {error:?}")))
}

/// `decryptPartyTin(party, keyring)`: the full TIN, without a reveal log
/// (callers log it or keep it server-side).
pub fn decrypt_party_tin(
    party: &Value,
    keyring: &Keyring,
) -> Result<Option<String>, VendorTaxError> {
    Ok(read_sensitive(party, keyring)?.tin)
}

// ---------------------------------------------------------------------------
// Applying input to a party
// ---------------------------------------------------------------------------

/// `VendorTaxChange`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VendorTaxChange {
    /// The party properties (`tinLast4`, `w9`, …) and their new values;
    /// dates as `toISOString()`.
    pub columns: Map<String, Value>,
    /// Audit-safe summary of what changed: names only, never values.
    pub changes: Map<String, Value>,
    pub tin_changed: bool,
    pub bank_details_changed: bool,
}

fn change(old: Option<&str>, new: Option<&str>) -> Value {
    json!({ "old": old, "new": new })
}

/// The value of a nullish field as JSON (`input.x` with `null` kept).
fn field_json<T: Clone + Into<Value>>(field: &Field<T>) -> Value {
    match field {
        Field::Set(value) => value.clone().into(),
        _ => Value::Null,
    }
}

fn box_matches_form(code: &str, form: &str) -> bool {
    code == FORM_1099_OMIT || code.starts_with(&format!("{form}_"))
}

/// `cleanW9(w9)`: without empty values, `None` when nothing is left.
fn clean_w9(w9: Map<String, Value>) -> Option<Map<String, Value>> {
    let cleaned: Map<String, Value> = w9
        .into_iter()
        .filter(|(_, value)| !value.is_null() && value.as_str() != Some(""))
        .collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// `buildVendorTaxChange(existing, input, env)`: validate the vendor tax
/// fields of a create (`existing` is `None`) or an update, and build the
/// party columns they change. The keyring is needed only when a TIN or an
/// account number is written.
#[allow(clippy::too_many_lines)] // mirrors the TypeScript function step by step
pub fn build_vendor_tax_change(
    existing: Option<&Value>,
    input: &VendorTaxInput,
    keyring: &Keyring,
) -> Result<VendorTaxChange, VendorTaxError> {
    let empty = Value::Null;
    let party = existing.unwrap_or(&empty);
    let mut columns = Map::new();
    let mut changes = Map::new();
    let mut tin_changed = false;
    let mut bank_details_changed = false;

    if !input.tax_use.is_absent() {
        columns.insert("taxUse".to_owned(), field_json(&input.tax_use));
    }
    if let Field::Set(flag) = input.is_1099_vendor {
        columns.insert("is1099Vendor".to_owned(), Value::Bool(flag));
    }
    if let Field::Set(flag) = input.backup_withholding {
        columns.insert("backupWithholding".to_owned(), Value::Bool(flag));
    }

    // 1099 defaults: the box has to belong to the form.
    let form: Option<String> = if input.default_1099_form.is_absent() {
        filled(party, "default1099Form").map(str::to_owned)
    } else {
        input.default_1099_form.as_set().cloned()
    };
    if !input.default_1099_form.is_absent() {
        columns.insert(
            "default1099Form".to_owned(),
            field_json(&input.default_1099_form),
        );
    }
    if !input.default_1099_box.is_absent() {
        if let (Some(code), Some(form)) = (
            input.default_1099_box.as_set().filter(|c| !c.is_empty()),
            form.as_deref().filter(|f| !f.is_empty()),
        ) && !box_matches_form(code, form)
        {
            return Err(invalid(format!(
                "default1099Box {code} does not belong to form 1099-{}",
                form.to_uppercase()
            )));
        }
        columns.insert(
            "default1099Box".to_owned(),
            field_json(&input.default_1099_box),
        );
    } else if !input.default_1099_form.is_absent()
        && let (Some(code), Some(form)) = (
            filled(party, "default1099Box"),
            input.default_1099_form.as_set().filter(|f| !f.is_empty()),
        )
        && !box_matches_form(code, form)
    {
        columns.insert("default1099Box".to_owned(), Value::Null);
    }

    // e-delivery consent
    match &input.form_1099_e_delivery_consent_at {
        Field::Absent => {}
        Field::Null | Field::Set(Value::Bool(false)) => {
            columns.insert("form1099EDeliveryConsentAt".to_owned(), Value::Null);
        }
        Field::Set(Value::Bool(true)) => {
            columns.insert(
                "form1099EDeliveryConsentAt".to_owned(),
                Value::String(now()),
            );
        }
        Field::Set(value) => {
            let iso = value.as_str().and_then(js_date_iso);
            columns.insert(
                "form1099EDeliveryConsentAt".to_owned(),
                iso.map_or(Value::Null, Value::String),
            );
        }
    }

    // W-9
    match &input.w9 {
        Field::Absent => {}
        Field::Null => {
            columns.insert("w9".to_owned(), Value::Null);
        }
        Field::Set(sent) => {
            let mut merged = party
                .get("w9")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (key, value) in sent {
                merged.insert(key.clone(), value.clone());
            }
            let mut merged = clean_w9(merged);
            if let Some(w9) = &mut merged {
                let federal = w9.get("federalTaxClassification").and_then(Value::as_str);
                // `cleanW9` left no null or blank value behind.
                let llc = w9
                    .get("llcTaxClassification")
                    .is_some_and(|v| v != &Value::Bool(false));
                if federal == Some("llc") && !llc {
                    return Err(invalid(
                        "llcTaxClassification (C, S or P) is required for an LLC",
                    ));
                }
                if llc && federal != Some("llc") {
                    w9.remove("llcTaxClassification");
                }
            }
            columns.insert("w9".to_owned(), merged.map_or(Value::Null, Value::Object));
        }
    }

    // TIN. A blank value means "unchanged" for the write-only fields; only null removes them.
    let blank_is_absent = |field: &Field<String>| match field {
        Field::Set(value) if value.is_empty() => Field::Absent,
        other => other.clone(),
    };
    let tin_value = blank_is_absent(&input.tin);
    let account_value = blank_is_absent(&input.ach_account_number);
    let wants_tin = !tin_value.is_absent();
    let type_given = !input.tin_type.is_absent();
    let touches_secrets = wants_tin || !account_value.is_absent();
    let keyring = if touches_secrets {
        Some(require_keyring(keyring)?)
    } else {
        None
    };
    let stored = match keyring {
        Some(keyring) if filled(party, "sensitiveEncrypted").is_some() => {
            read_sensitive(party, keyring)?
        }
        _ => PartySensitive::default(),
    };
    let mut next = stored.clone();
    let existing_last4 = filled(party, "tinLast4");
    let existing_type = text_of(party, "tinType");

    if type_given && !wants_tin {
        if let Field::Set(tin_type) = &input.tin_type
            && existing_last4.is_some()
            && Some(tin_type.as_str()) != existing_type
        {
            return Err(invalid(
                "Send the TIN together with tinType: the stored TIN was validated for another type",
            ));
        }
        if matches!(input.tin_type, Field::Null) && existing_last4.is_some() {
            return Err(invalid("Remove the TIN (tin: null) together with its type"));
        }
        columns.insert("tinType".to_owned(), field_json(&input.tin_type));
    }

    if wants_tin {
        if let Field::Set(tin) = &tin_value {
            let tin_type = input.tin_type.as_set().cloned().or_else(|| {
                is_tin_type(existing_type).then(|| existing_type.unwrap_or_default().to_owned())
            });
            let Some(tin_type) = tin_type else {
                return Err(invalid("tinType (ein, ssn or itin) is required with a TIN"));
            };
            let check = validate_tin(&tin_type, tin);
            if !check.valid {
                return Err(invalid(
                    check
                        .error
                        .unwrap_or_else(|| "The TIN is not valid".to_owned()),
                ));
            }
            let digits = digits_only(check.formatted.as_deref().unwrap_or(tin));
            if stored.tin.as_deref() != Some(digits.as_str())
                || existing.is_none()
                || existing_type != Some(tin_type.as_str())
            {
                tin_changed = true;
                let old = existing_last4.is_some().then_some("on file");
                changes.insert("tin".to_owned(), change(old, Some("changed")));
            }
            columns.insert(
                "tinLast4".to_owned(),
                tin_last4(&digits).map_or(Value::Null, Value::String),
            );
            columns.insert("tinType".to_owned(), Value::String(tin_type));
            next.tin = Some(digits);
        } else {
            if stored.tin.as_deref().is_some_and(|t| !t.is_empty()) || existing_last4.is_some() {
                tin_changed = true;
                changes.insert("tin".to_owned(), change(Some("on file"), None));
            }
            next.tin = None;
            columns.insert("tinLast4".to_owned(), Value::Null);
            columns.insert("tinType".to_owned(), field_json(&input.tin_type));
        }
        if tin_changed {
            // A new TIN has to be matched again.
            columns.insert("tinMatchStatus".to_owned(), Value::Null);
            columns.insert("tinMatchedAt".to_owned(), Value::Null);
        }
    }

    // ACH details
    let routing_before = text_of(party, "achRoutingNumber").map(str::to_owned);
    if !input.ach_routing_number.is_absent() {
        let routing_after = match &input.ach_routing_number {
            Field::Set(routing) if !routing.is_empty() => {
                let check = validate_routing_number(routing);
                if !check.valid {
                    return Err(invalid(
                        check
                            .error
                            .unwrap_or_else(|| "The routing number is not valid".to_owned()),
                    ));
                }
                Some(check.formatted.unwrap_or_else(|| digits_only(routing)))
            }
            _ => None,
        };
        if routing_after != routing_before {
            bank_details_changed = true;
        }
        columns.insert(
            "achRoutingNumber".to_owned(),
            routing_after.map_or(Value::Null, Value::String),
        );
    }

    match &account_value {
        Field::Absent => {}
        Field::Null => {
            if stored
                .ach_account_number
                .as_deref()
                .is_some_and(|a| !a.is_empty())
                || filled(party, "achAccountLast4").is_some()
            {
                bank_details_changed = true;
            }
            next.ach_account_number = None;
            columns.insert("achAccountLast4".to_owned(), Value::Null);
        }
        Field::Set(account) => {
            let digits = digits_only(account);
            let bad_char = account
                .chars()
                .any(|c| !(c.is_ascii_digit() || is_js_space(c) || c == '-'));
            if !(4..=17).contains(&digits.len()) || bad_char {
                return Err(invalid("The account number must have 4 to 17 digits"));
            }
            if stored.ach_account_number.as_deref() != Some(digits.as_str()) {
                bank_details_changed = true;
            }
            columns.insert(
                "achAccountLast4".to_owned(),
                Value::String(digits[digits.len() - 4..].to_owned()),
            );
            next.ach_account_number = Some(digits);
        }
    }

    if !input.ach_account_type.is_absent() {
        let new_type = input.ach_account_type.as_set().map(String::as_str);
        columns.insert(
            "achAccountType".to_owned(),
            field_json(&input.ach_account_type),
        );
        if new_type != text_of(party, "achAccountType") {
            bank_details_changed = true;
        }
    }

    if bank_details_changed {
        let on_file = filled(party, "achAccountLast4").is_some()
            || routing_before.as_deref().is_some_and(|r| !r.is_empty());
        changes.insert(
            "bankDetails".to_owned(),
            change(on_file.then_some("on file"), Some("changed")),
        );
        let now_value = |prop: &str| -> bool {
            match columns.get(prop) {
                Some(value) => value.as_str().is_some_and(|v| !v.is_empty()),
                None => filled(party, prop).is_some(),
            }
        };
        let has_details = now_value("achRoutingNumber") || now_value("achAccountLast4");
        columns.insert(
            "bankDetailsChangedAt".to_owned(),
            if has_details {
                Value::String(now())
            } else {
                Value::Null
            },
        );
        columns.insert("bankDetailsVerifiedAt".to_owned(), Value::Null);
        columns.insert("bankDetailsVerifiedBy".to_owned(), Value::Null);
    }

    if let Some(keyring) = keyring
        && stored != next
    {
        columns.insert(
            "sensitiveEncrypted".to_owned(),
            seal(&next, keyring)?.map_or(Value::Null, Value::String),
        );
    }

    Ok(VendorTaxChange {
        columns,
        changes,
        tin_changed,
        bank_details_changed,
    })
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// `vendorTaxDerived(party)`: the display-safe tax fields of a contact view.
pub fn vendor_tax_derived(party: &Value) -> Map<String, Value> {
    let tin_type = text_of(party, "tinType").filter(|t| is_tin_type(Some(t)));
    let last4 = filled(party, "tinLast4");
    let mut out = Map::new();
    out.insert("hasTin".to_owned(), Value::Bool(last4.is_some()));
    out.insert(
        "tinMasked".to_owned(),
        last4.map_or(Value::Null, |l| {
            Value::String(crate::jurisdictions::us::mask_tin(l, tin_type))
        }),
    );
    out.insert(
        "hasAchAccount".to_owned(),
        Value::Bool(filled(party, "achAccountLast4").is_some()),
    );
    let verified = party
        .get("bankDetailsVerifiedAt")
        .is_some_and(|v| !v.is_null() && v.as_str() != Some(""));
    out.insert(
        "bankDetailsNeedVerification".to_owned(),
        Value::Bool(
            filled(party, "achRoutingNumber").is_some()
                && filled(party, "achAccountLast4").is_some()
                && !verified,
        ),
    );
    out
}

/// `TAX_EVENT_STRIP`: fields that must not reach entity events.
pub const TAX_EVENT_STRIP: [&str; 6] = [
    "sensitiveEncrypted",
    "tinLast4",
    "tinMasked",
    "achRoutingNumber",
    "achAccountLast4",
    "w9",
];

/// `stripTaxFieldsForEvent(view)`.
pub fn strip_tax_fields_for_event(view: &Value) -> Value {
    let mut copy = view.as_object().cloned().unwrap_or_default();
    for key in TAX_EVENT_STRIP {
        copy.remove(key);
    }
    Value::Object(copy)
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

/// `PartySecretField`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretField {
    Tin,
    AchAccountNumber,
}

impl SecretField {
    /// The `field` written to `tax_id_reveals`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tin => "tin",
            Self::AchAccountNumber => "ach_account_number",
        }
    }

    /// `SecretNotFoundError`'s message.
    pub fn not_found_message(self) -> &'static str {
        match self {
            Self::Tin => "This vendor has no TIN on file",
            Self::AchAccountNumber => "This vendor has no ACH account number on file",
        }
    }
}

/// `revealPartySecret(db, env, args)`: decrypt one stored secret for an
/// authorized reveal. The reveal is logged first; a failed log write
/// refuses it.
pub async fn reveal_party_secret(
    db: &PgPool,
    keyring: &Keyring,
    party: &Value,
    field: SecretField,
    user_id: &str,
    reason: Option<&str>,
    entity_id: Option<&str>,
) -> Result<String, VendorTaxError> {
    let keyring = require_keyring(keyring)?;
    let blob = read_sensitive(party, keyring)?;
    let value = match field {
        SecretField::Tin => blob.tin,
        SecretField::AchAccountNumber => blob.ach_account_number,
    }
    .filter(|v| !v.is_empty())
    .ok_or(VendorTaxError::SecretNotFound(field))?;
    sqlx::query(
        "insert into tax_id_reveals (id, entity_id, subject_type, subject_id, field, revealed_by, reason) \
         values ($1, $2, 'party', $3, $4, $5, $6)",
    )
    .bind(generate_id("tir"))
    .bind(entity_id)
    .bind(text_of(party, "id").unwrap_or_default())
    .bind(field.as_str())
    .bind(user_id)
    .bind(reason)
    .execute(db)
    .await?;
    Ok(value)
}

// ---------------------------------------------------------------------------
// Online W-9 requests (`services/w9-requests`)
// ---------------------------------------------------------------------------

/// `W9_KV_PREFIX`.
pub const W9_KV_PREFIX: &str = "w9:";
/// `W9_DEFAULT_EXPIRY_DAYS`.
pub const W9_DEFAULT_EXPIRY_DAYS: i64 = 30;
/// `W9_MAX_EXPIRY_DAYS`.
pub const W9_MAX_EXPIRY_DAYS: i64 = 90;

/// `w9KvKey(tokenHash)`: the `WORKSPACE_CACHE` key that leads a token to its
/// workspace (`{ orgId, requestId }`).
pub fn w9_kv_key(token_hash: &str) -> String {
    format!("{W9_KV_PREFIX}{token_hash}")
}

/// `generateW9Token()`: 32 random bytes, base64url (43 characters).
///
/// # Panics
///
/// When the operating system has no random source.
pub fn generate_w9_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the operating system has a random source");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// `sha256Hex(value)`.
pub fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// `w9Url(env, token)`: the platform page the vendor opens (`PLATFORM_URL`,
/// default `https://app.weldsuite.org`).
pub fn w9_url(platform_url: Option<&str>, token: &str) -> String {
    let base = platform_url
        .filter(|u| !u.is_empty())
        .unwrap_or("https://app.weldsuite.org")
        .trim_end_matches('/');
    format!("{base}/w9/{token}")
}

/// Milliseconds of an ISO timestamp (`Date.getTime()`), `None` when it isn't one.
pub fn iso_millis(iso: &str) -> Option<i64> {
    let at = OffsetDateTime::parse(iso, &Rfc3339).ok()?;
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok()
}

/// `toW9RequestView(row, now)`: the row without its token hash; a pending
/// request past its expiry reads as `expired`.
pub fn to_w9_request_view(row: &Value, now_ms: i64) -> Value {
    let mut view = row.as_object().cloned().unwrap_or_default();
    view.remove("tokenHash");
    let expired = text_of(row, "status") == Some("pending")
        && text_of(row, "expiresAt")
            .and_then(iso_millis)
            .is_some_and(|at| at <= now_ms);
    if expired {
        view.insert("status".to_owned(), json!("expired"));
    }
    Value::Object(view)
}

/// `w9EventData(row, extra)`.
pub fn w9_event_data(row: &Value, extra: Map<String, Value>) -> Value {
    let mut data = Map::new();
    for key in ["id", "entityId", "partyId", "status", "expiresAt"] {
        data.insert(key.to_owned(), row.get(key).cloned().unwrap_or(Value::Null));
    }
    data.extend(extra);
    Value::Object(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keyring() -> Keyring {
        Keyring {
            v1: None,
            v2: Some("a".repeat(64)),
        }
    }

    #[test]
    fn tins_and_routing_numbers() {
        assert_eq!(
            validate_tin("itin", "912-70-1234").formatted.as_deref(),
            Some("912-70-1234")
        );
        assert!(!validate_itin("812-70-1234").valid);
        assert_eq!(
            validate_itin("912-93-1234").error.as_deref(),
            Some("ITIN digits 4-5 (93) are outside the ranges the IRS issues")
        );
        assert_eq!(
            validate_routing_number("021000021").formatted.as_deref(),
            Some("021000021")
        );
        assert_eq!(
            validate_routing_number("021000022").error.as_deref(),
            Some("Routing number checksum does not match, check for a typo")
        );
        assert_eq!(
            validate_routing_number("12-3").error.as_deref(),
            Some("Routing number must be 9 digits")
        );
        assert_eq!(format_tin("ein", "123456789"), "12-3456789");
        assert_eq!(format_tin("ssn", "123456789"), "123-45-6789");
    }

    #[test]
    fn corporations() {
        assert!(is_corporation_classification(Some("c_corporation"), None));
        assert!(is_corporation_classification(Some("llc"), Some("S")));
        assert!(!is_corporation_classification(Some("llc"), Some("P")));
        assert!(!is_corporation_classification(Some("individual"), None));
    }

    #[test]
    fn a_new_tin_is_sealed_with_its_last_four() {
        let input = VendorTaxInput {
            tin_type: Field::Set("ein".to_owned()),
            tin: Field::Set("12-3456789".to_owned()),
            ..VendorTaxInput::default()
        };
        let change = build_vendor_tax_change(None, &input, &keyring()).expect("change");
        assert!(change.tin_changed);
        assert_eq!(change.columns["tinLast4"], json!("6789"));
        assert_eq!(change.columns["tinType"], json!("ein"));
        let party = json!({ "sensitiveEncrypted": change.columns["sensitiveEncrypted"] });
        let blob = read_sensitive(&party, &keyring()).expect("blob");
        assert_eq!(blob.tin.as_deref(), Some("123456789"));
        assert_eq!(
            build_vendor_tax_change(None, &input, &Keyring::default()),
            Err(VendorTaxError::NoKey)
        );
    }

    #[test]
    fn refusals_name_no_values() {
        let input = VendorTaxInput {
            default_1099_form: Field::Set("misc".to_owned()),
            default_1099_box: Field::Set("nec_1".to_owned()),
            ..VendorTaxInput::default()
        };
        assert_eq!(
            build_vendor_tax_change(None, &input, &keyring()),
            Err(invalid(
                "default1099Box nec_1 does not belong to form 1099-MISC"
            ))
        );
        let input = VendorTaxInput {
            w9: Field::Set(
                json!({ "federalTaxClassification": "llc" })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            ),
            ..VendorTaxInput::default()
        };
        assert_eq!(
            build_vendor_tax_change(None, &input, &keyring()),
            Err(invalid(
                "llcTaxClassification (C, S or P) is required for an LLC"
            ))
        );
    }

    #[test]
    fn bank_detail_changes_clear_the_verification() {
        let existing = json!({ "achRoutingNumber": "021000021", "achAccountLast4": "1234", "bankDetailsVerifiedAt": "2026-01-01T00:00:00.000Z" });
        let input = VendorTaxInput {
            ach_account_type: Field::Set("savings".to_owned()),
            ..VendorTaxInput::default()
        };
        let change = build_vendor_tax_change(Some(&existing), &input, &keyring()).expect("change");
        assert!(change.bank_details_changed);
        assert_eq!(change.columns["bankDetailsVerifiedAt"], Value::Null);
        assert!(change.columns["bankDetailsChangedAt"].is_string());
        assert_eq!(
            change.changes["bankDetails"],
            json!({ "old": "on file", "new": "changed" })
        );
    }

    #[test]
    fn w9_tokens_and_views() {
        let token = generate_w9_token();
        assert_eq!(token.len(), 43);
        assert_eq!(sha256_hex("abc").len(), 64);
        assert_eq!(
            w9_url(Some("https://app-test.weldsuite.org/"), "t"),
            "https://app-test.weldsuite.org/w9/t"
        );
        let row = json!({ "id": "w9r_1", "status": "pending", "expiresAt": "2026-01-01T00:00:00.000Z", "tokenHash": "h" });
        let view = to_w9_request_view(&row, iso_millis("2026-02-01T00:00:00.000Z").expect("ms"));
        assert_eq!(view["status"], json!("expired"));
        assert!(view.get("tokenHash").is_none());
    }
}
