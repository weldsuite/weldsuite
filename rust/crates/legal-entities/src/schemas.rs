//! The request schemas of `/api/legal-entities`
//! (`@weldsuite/app-api-client/schemas/legal-entities`), read as Zod 3 reads
//! them through `zValidator`: a failure is the 400 [`Invalid`] with Zod's
//! issues, and a success the service's input type.
//!
//! Issue order: Zod reports type and length issues in key order while it
//! walks the body, and settles refinements (`.refine`, `.superRefine`) and
//! unions (`.or(z.literal(''))`) after them, because `zValidator` parses
//! asynchronously. The readers here do the same: synchronous issues in key
//! order, then the refinements and unions in key order, then the
//! registration's `superRefine`.
//!
//! The format helpers (`normalizeRegistrationNumber`,
//! `registrationNumberError`, `isValidIban`, `isValidAbaRouting`) are
//! exported for the service and for callers that build inputs by hand.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{
    Field, Format, Invalid, Issues, Number, Presence, Text, js_trim, query_values,
};

use crate::extensions::LegalEntityApp;
use crate::service::{
    CreateBankAccountInput, CreateLegalEntityInput, CreateRegistrationInput,
    ListLegalEntitiesOptions, UpdateBankAccountInput, UpdateLegalEntityInput,
    UpdateRegistrationInput,
};

// ---------------------------------------------------------------------------
// Registration types and number formats
// ---------------------------------------------------------------------------

/// `LEGAL_ENTITY_REGISTRATION_TYPES`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationType {
    Vat,
    CompanyRegistration,
    Rsin,
    Ein,
    Gstin,
    Pan,
    Eori,
    NlPayrollTax,
    UsStateWithholding,
    UsStateUnemployment,
    Other,
}

impl RegistrationType {
    /// In the schema's order.
    pub const ALL: [Self; 11] = [
        Self::Vat,
        Self::CompanyRegistration,
        Self::Rsin,
        Self::Ein,
        Self::Gstin,
        Self::Pan,
        Self::Eori,
        Self::NlPayrollTax,
        Self::UsStateWithholding,
        Self::UsStateUnemployment,
        Self::Other,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vat => "vat",
            Self::CompanyRegistration => "company_registration",
            Self::Rsin => "rsin",
            Self::Ein => "ein",
            Self::Gstin => "gstin",
            Self::Pan => "pan",
            Self::Eori => "eori",
            Self::NlPayrollTax => "nl_payroll_tax",
            Self::UsStateWithholding => "us_state_withholding",
            Self::UsStateUnemployment => "us_state_unemployment",
            Self::Other => "other",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == value)
    }

    /// `PRIMARY_TYPES`: types where one number per entity (per region for
    /// state types) is the primary.
    pub fn is_primary_type(self) -> bool {
        matches!(
            self,
            Self::Vat
                | Self::Gstin
                | Self::CompanyRegistration
                | Self::Rsin
                | Self::Ein
                | Self::Pan
                | Self::Eori
                | Self::NlPayrollTax
        )
    }

    /// `REGISTRATION_FORMATS[type]`: the pattern and its message.
    fn format(self) -> Option<(&'static Regex, &'static str)> {
        let (regex, message): (&'static LazyLock<Regex>, &'static str) = match self {
            Self::Vat => (
                &VAT,
                "Use the VAT number with its country prefix, e.g. NL123456789B01",
            ),
            Self::Rsin => (&RSIN, "An RSIN has nine digits"),
            Self::Ein => (&EIN, "An EIN has nine digits (12-3456789)"),
            Self::Gstin => (&GSTIN, "A GSTIN has 15 characters, e.g. 27AAPFU0939F1ZV"),
            Self::Pan => (&PAN, "A PAN has 10 characters, e.g. AAPFU0939F"),
            Self::Eori => (&EORI, "Use the EORI number with its country prefix"),
            Self::NlPayrollTax => (
                &NL_PAYROLL_TAX,
                "A loonheffingennummer looks like 123456789L01",
            ),
            _ => return None,
        };
        Some((LazyLock::force(regex), message))
    }
}

/// A pattern of the TypeScript schemas. JavaScript's `\d` is ASCII, so the
/// patterns spell digits as `[0-9]` (Rust's `\d` is Unicode).
fn pattern(source: &str) -> Regex {
    Regex::new(source)
        .unwrap_or_else(|error| panic!("legal entities: bad pattern {source}: {error}"))
}

static VAT: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[A-Z]{2}[0-9A-Z+*.]{2,13}$"));
static RSIN: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[0-9]{9}$"));
static EIN: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[0-9]{2}-?[0-9]{7}$"));
static GSTIN: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$"));
static PAN: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[A-Z]{5}[0-9]{4}[A-Z]$"));
static EORI: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[A-Z]{2}[0-9A-Z]{1,15}$"));
static NL_PAYROLL_TAX: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[0-9]{9}L[0-9]{2}$"));
static IBAN: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$"));
static BIC: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$"));
static ACCOUNT_NUMBER: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[0-9A-Za-z]{4,34}$"));
/// Zod 3's `z.string().date()`: a real calendar date, leap years included.
static DATE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r"^(([0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|(02)-(0[1-9]|1[0-9]|2[0-8])))$",
    )
});

/// JavaScript's `\s`: Unicode spaces and line terminators plus the BOM, but
/// not NEL (U+0085), which Rust's `char::is_whitespace` includes.
fn is_js_space(c: char) -> bool {
    c != '\u{85}' && (c.is_whitespace() || c == '\u{feff}')
}

/// `normalizeRegistrationNumber`: upper-case and strip spaces, and for VAT,
/// payroll tax and RSIN numbers dots (dashes stay: EINs keep them).
pub fn normalize_registration_number(kind: RegistrationType, raw: &str) -> String {
    let cleaned: String = js_trim(raw)
        .to_uppercase()
        .chars()
        .filter(|c| !is_js_space(*c))
        .collect();
    if matches!(
        kind,
        RegistrationType::Vat | RegistrationType::NlPayrollTax | RegistrationType::Rsin
    ) {
        cleaned.replace('.', "")
    } else {
        cleaned
    }
}

/// `registrationNumberError`: `None` when the number is valid for its type,
/// else the reason. Types without a format accept any 1–64 characters.
pub fn registration_number_error(kind: RegistrationType, number: &str) -> Option<&'static str> {
    if let Some((regex, message)) = kind.format() {
        return (!regex.is_match(number)).then_some(message);
    }
    let length = number.encode_utf16().count();
    (length == 0 || length > 64).then_some("Enter a number")
}

/// `BANK_ACCOUNT_TYPES`.
pub const BANK_ACCOUNT_TYPES: [&str; 5] = [
    "checking",
    "savings",
    "credit_card",
    "money_market",
    "line_of_credit",
];

/// `isValidAbaRouting`: nine digits, weights 3-7-1, sum divisible by 10.
pub fn is_valid_aba_routing(value: &str) -> bool {
    if !RSIN.is_match(value) {
        return false;
    }
    let weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
    let sum: u32 = value
        .bytes()
        .zip(weights)
        .map(|(digit, weight)| u32::from(digit - b'0') * weight)
        .sum();
    sum.is_multiple_of(10)
}

/// `isValidIban`: the mod-97 check on the compact form.
pub fn is_valid_iban(raw: &str) -> bool {
    let iban: String = raw
        .chars()
        .filter(|c| !is_js_space(*c))
        .collect::<String>()
        .to_uppercase();
    if !IBAN.is_match(&iban) {
        return false;
    }
    let (head, tail) = iban.split_at(4);
    let mut remainder: u32 = 0;
    for c in tail.chars().chain(head.chars()) {
        let digits = if c.is_ascii_uppercase() {
            (u32::from(c) - 55).to_string()
        } else {
            c.to_string()
        };
        for d in digits.chars() {
            remainder = (remainder * 10 + d.to_digit(10).unwrap_or(0)) % 97;
        }
    }
    remainder == 1
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/// The issues of one body: Zod's synchronous ones in `issues`, the
/// refinements and unions it settles afterwards in `deferred`.
#[derive(Default)]
struct Reader {
    deferred: Vec<Value>,
}

impl Reader {
    /// A failed `.refine(check, message)` on `key`, settled after the body.
    fn refine(&mut self, issues: &Issues, key: &str, message: &str) {
        self.deferred.push(json!({
            "code": "custom",
            "message": message,
            "path": issues.path_of(key),
        }));
    }

    /// `z.string().trim().transform(upper).refine(/^[A-Z]{length}$/, message)`:
    /// the country and currency codes. `Absent` when invalid.
    fn code(
        &mut self,
        issues: &mut Issues,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
        (length, message): (usize, &str),
    ) -> Field<String> {
        match issues.text_with(body, key, presence, Text::trimmed(None, None)) {
            Field::Set(text) => {
                let upper = text.to_uppercase();
                if upper.len() == length && upper.bytes().all(|b| b.is_ascii_uppercase()) {
                    Field::Set(upper)
                } else {
                    self.refine(issues, key, message);
                    Field::Absent
                }
            }
            other => other,
        }
    }

    /// `countryCode`.
    fn country_code(
        &mut self,
        issues: &mut Issues,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
    ) -> Field<String> {
        self.code(
            issues,
            body,
            key,
            presence,
            (2, "Use a two-letter country code"),
        )
    }

    /// `currencyCode`.
    fn currency_code(
        &mut self,
        issues: &mut Issues,
        body: &Map<String, Value>,
        key: &str,
        presence: Presence,
    ) -> Field<String> {
        self.code(
            issues,
            body,
            key,
            presence,
            (3, "Use a three-letter currency code"),
        )
    }

    /// `z.string().trim()[.email()].max(max).optional().or(z.literal(''))`.
    /// A string that fails the first option is reported with that option's
    /// issues (Zod returns the first "dirty" option); anything else that is
    /// not a string is an `invalid_union`. Settled after the body.
    fn text_or_empty(
        &mut self,
        issues: &Issues,
        body: &Map<String, Value>,
        key: &str,
        email: bool,
        max: usize,
    ) -> Field<String> {
        let path = issues.path_of(key);
        match body.get(key) {
            None => Field::Absent,
            Some(Value::String(raw)) if raw.is_empty() => Field::Set(String::new()),
            Some(Value::String(raw)) => {
                let text = js_trim(raw).to_owned();
                let mut failed = Vec::new();
                if email && !Format::Email.accepts(&text) {
                    failed.push(json!({
                        "validation": "email",
                        "code": "invalid_string",
                        "message": "Invalid email",
                        "path": path,
                    }));
                }
                if text.encode_utf16().count() > max {
                    failed.push(json!({
                        "code": "too_big",
                        "maximum": max,
                        "type": "string",
                        "inclusive": true,
                        "exact": false,
                        "message": format!("String must contain at most {max} character(s)"),
                        "path": path,
                    }));
                }
                if failed.is_empty() {
                    Field::Set(text)
                } else {
                    self.deferred.extend(failed);
                    Field::Absent
                }
            }
            Some(other) => {
                let received = parsed_type(other);
                self.deferred.push(json!({
                    "code": "invalid_union",
                    "unionErrors": [
                        { "issues": [{
                            "code": "invalid_type",
                            "expected": "string",
                            "received": received,
                            "path": path,
                            "message": format!("Expected string, received {received}"),
                        }], "name": "ZodError" },
                        { "issues": [{
                            "received": other,
                            "code": "invalid_literal",
                            "expected": "",
                            "path": path,
                            "message": "Invalid literal value, expected \"\"",
                        }], "name": "ZodError" },
                    ],
                    "path": path,
                    "message": "Invalid input",
                }));
                Field::Absent
            }
        }
    }

    /// Push the settled issues and answer the 400 when anything failed.
    fn finish(self, mut issues: Issues) -> Result<(), Invalid> {
        for issue in self.deferred {
            issues.push_raw(issue);
        }
        issues.finish()
    }
}

/// Zod's name for a JSON value's type.
fn parsed_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// `optionalText(max)`: `z.string().trim().max(max).nullish()`.
fn optional_text(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    max: usize,
) -> Field<String> {
    issues.text_with(body, key, Presence::Nullish, Text::trimmed(None, Some(max)))
}

/// Optional trimmed strings of an object, copied into `out` when present.
fn copy_texts(
    issues: &mut Issues,
    body: &Map<String, Value>,
    fields: &[(&str, usize)],
    out: &mut Map<String, Value>,
) {
    for (key, max) in fields {
        if let Field::Set(text) = issues.text_with(
            body,
            key,
            Presence::Optional,
            Text::trimmed(None, Some(*max)),
        ) {
            out.insert((*key).to_owned(), Value::String(text));
        }
    }
}

fn read_address(issues: &mut Issues, body: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    copy_texts(
        issues,
        body,
        &[
            ("line1", 255),
            ("line2", 255),
            ("houseNumber", 20),
            ("houseNumberAddition", 20),
            ("city", 120),
            ("state", 120),
            ("postalCode", 20),
            ("country", 2),
            ("county", 120),
        ],
        &mut out,
    );
    Value::Object(out)
}

fn read_contact(reader: &mut Reader, issues: &mut Issues, body: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    if let Field::Set(email) = reader.text_or_empty(issues, body, "email", true, 255) {
        out.insert("email".to_owned(), Value::String(email));
    }
    copy_texts(issues, body, &[("phone", 50), ("website", 500)], &mut out);
    if let Field::Set(person) = issues.nested(
        body,
        "contactPerson",
        Presence::Optional,
        |issues, person| {
            let mut out = Map::new();
            copy_texts(
                issues,
                person,
                &[("firstName", 120), ("lastName", 120)],
                &mut out,
            );
            Value::Object(out)
        },
    ) {
        out.insert("contactPerson".to_owned(), person);
    }
    Value::Object(out)
}

fn read_branding(reader: &mut Reader, issues: &mut Issues, body: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    if let Field::Set(logo) = reader.text_or_empty(issues, body, "logoUrl", false, 500) {
        out.insert("logoUrl".to_owned(), Value::String(logo));
    }
    copy_texts(
        issues,
        body,
        &[("primaryColor", 20), ("accentColor", 20)],
        &mut out,
    );
    Value::Object(out)
}

/// `fiscalYearConfigSchema`.
fn read_fiscal_year_config(issues: &mut Issues, body: &Map<String, Value>) -> Value {
    const KIND: &str = "fifty_two_fifty_three";
    let mut out = Map::new();
    match body.get("type") {
        Some(Value::String(kind)) if kind == KIND => {
            out.insert("type".to_owned(), Value::String(KIND.to_owned()));
        }
        received => {
            let mut issue = json!({
                "code": "invalid_literal",
                "expected": KIND,
                "message": format!("Invalid literal value, expected \"{KIND}\""),
            });
            if let Some(received) = received {
                issue["received"] = received.clone();
            }
            issues.issue_at("type", issue);
        }
    }
    let int = |min: f64, max: f64| Number {
        coerce: false,
        int: true,
        min: Some(min),
        max: Some(max),
    };
    if let Field::Set(month) =
        issues.whole_number(body, "endMonth", Presence::Required, int(1.0, 12.0))
    {
        out.insert("endMonth".to_owned(), json!(month));
    }
    if let Field::Set(day) = issues.whole_number(body, "weekday", Presence::Required, int(0.0, 6.0))
    {
        out.insert("weekday".to_owned(), json!(day));
    }
    if let Field::Set(rule) = issues.choice(body, "rule", Presence::Required, &["last", "nearest"])
    {
        out.insert("rule".to_owned(), Value::String(rule));
    }
    Value::Object(out)
}

fn required_or(partial: bool) -> Presence {
    if partial {
        Presence::Optional
    } else {
        Presence::Required
    }
}

/// The fields of `createLegalEntitySchema` (`partial`: the update schema).
fn read_entity(
    reader: &mut Reader,
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> (UpdateLegalEntityInput, Option<bool>) {
    let name = issues
        .text_with(
            body,
            "name",
            required_or(partial),
            Text::trimmed(Some(1), Some(255)),
        )
        .into_option();
    let legal_name = optional_text(issues, body, "legalName", 255);
    let dba = optional_text(issues, body, "dba", 255);
    let entity_type = optional_text(issues, body, "entityType", 20);
    let jurisdiction_code = reader
        .country_code(issues, body, "jurisdictionCode", required_or(partial))
        .into_option();
    let base_currency = reader
        .currency_code(issues, body, "baseCurrency", required_or(partial))
        .into_option();
    let locale = issues
        .text_with(
            body,
            "locale",
            Presence::Optional,
            Text::trimmed(Some(2), Some(10)),
        )
        .into_option();
    let timezone = issues
        .text_with(
            body,
            "timezone",
            Presence::Optional,
            Text::trimmed(None, Some(50)),
        )
        .into_option();
    let address = issues.nested(body, "address", Presence::Nullish, read_address);
    let contact = issues.nested(body, "contact", Presence::Nullish, |issues, body| {
        read_contact(reader, issues, body)
    });
    let branding = issues.nested(body, "branding", Presence::Nullish, |issues, body| {
        read_branding(reader, issues, body)
    });
    let fiscal_year_start = issues
        .whole_number(
            body,
            "fiscalYearStart",
            Presence::Optional,
            Number {
                coerce: false,
                int: true,
                min: Some(1.0),
                max: Some(12.0),
            },
        )
        .into_option()
        .and_then(|month| i32::try_from(month).ok());
    let fiscal_year_config = issues.nested(
        body,
        "fiscalYearConfig",
        Presence::Nullish,
        read_fiscal_year_config,
    );
    let tax_classification = optional_text(issues, body, "taxClassification", 20);
    let is_default = if partial {
        None
    } else {
        issues
            .boolean(body, "isDefault", Presence::Optional)
            .into_option()
    };
    (
        UpdateLegalEntityInput {
            name,
            legal_name,
            dba,
            entity_type,
            jurisdiction_code,
            base_currency,
            locale,
            timezone,
            address,
            contact,
            branding,
            fiscal_year_start,
            fiscal_year_config,
            tax_classification,
        },
        is_default,
    )
}

/// Read `body` as an object with `read`, then settle the deferred issues.
fn parse<T>(
    body: &Value,
    read: impl FnOnce(&mut Reader, &mut Issues, &Map<String, Value>) -> T,
) -> Result<T, Invalid> {
    let mut issues = Issues::default();
    let mut reader = Reader::default();
    let value = issues
        .object(body)
        .map(|fields| read(&mut reader, &mut issues, fields));
    reader.finish(issues)?;
    // No issue means the body was an object.
    value.ok_or_else(invalid_input)
}

/// A 400 for a body that read without issues but holds nothing: never
/// reached, as a body that is not an object already failed.
fn invalid_input() -> Invalid {
    let mut issues = Issues::default();
    issues.custom_root("Invalid input");
    match issues.finish() {
        Err(invalid) => invalid,
        Ok(()) => unreachable!("an issue was just added"),
    }
}

/// `createLegalEntitySchema`.
pub fn parse_create_legal_entity(body: &Value) -> Result<CreateLegalEntityInput, Invalid> {
    let (fields, is_default) = parse(body, |reader, issues, body| {
        read_entity(reader, issues, body, false)
    })?;
    Ok(CreateLegalEntityInput {
        name: fields.name.unwrap_or_default(),
        legal_name: fields.legal_name,
        dba: fields.dba,
        entity_type: fields.entity_type,
        jurisdiction_code: fields.jurisdiction_code.unwrap_or_default(),
        base_currency: fields.base_currency.unwrap_or_default(),
        locale: fields.locale,
        timezone: fields.timezone,
        address: fields.address,
        contact: fields.contact,
        branding: fields.branding,
        fiscal_year_start: fields.fiscal_year_start,
        fiscal_year_config: fields.fiscal_year_config,
        tax_classification: fields.tax_classification,
        is_default,
    })
}

/// `updateLegalEntitySchema`: the create schema without `isDefault`, every
/// field optional.
pub fn parse_update_legal_entity(body: &Value) -> Result<UpdateLegalEntityInput, Invalid> {
    parse(body, |reader, issues, body| {
        read_entity(reader, issues, body, true).0
    })
}

/// `listLegalEntitiesQuerySchema` on the raw query string.
pub fn parse_list_query(query: Option<&str>) -> Result<ListLegalEntitiesOptions, Invalid> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let app = issues.choice(&values, "app", Presence::Optional, &["weldbooks", "weldhr"]);
    let include_archived = issues.choice(
        &values,
        "includeArchived",
        Presence::Optional,
        &["true", "false"],
    );
    issues.finish()?;
    Ok(ListLegalEntitiesOptions {
        app: app
            .as_set()
            .map(String::as_str)
            .and_then(LegalEntityApp::parse),
        include_archived: include_archived
            .as_set()
            .is_some_and(|value| value == "true"),
    })
}

/// `z.string().date().nullish()`: an `invalid_string` (`date`) for a string
/// that is not a calendar date. Not trimmed.
fn optional_date(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Field<String> {
    let field = issues.text_with(body, key, Presence::Nullish, Text::default());
    match field {
        Field::Set(text) if !DATE.is_match(&text) => {
            issues.issue_at(
                key,
                json!({ "validation": "date", "code": "invalid_string", "message": "Invalid date" }),
            );
            Field::Absent
        }
        other => other,
    }
}

/// The fields of `registrationBase` after `type`.
struct RegistrationFields {
    number: Option<String>,
    country: Field<String>,
    region: Field<String>,
    label: Field<String>,
    valid_from: Field<String>,
    valid_to: Field<String>,
    is_primary: Option<bool>,
}

fn read_registration(
    reader: &mut Reader,
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> RegistrationFields {
    let number = issues
        .text_with(
            body,
            "number",
            required_or(partial),
            Text::trimmed(Some(1), Some(64)),
        )
        .into_option();
    let country = reader.country_code(issues, body, "country", Presence::Nullish);
    let region = issues.text_with(
        body,
        "region",
        Presence::Nullish,
        Text::trimmed(None, Some(10)),
    );
    let label = optional_text(issues, body, "label", 120);
    let valid_from = optional_date(issues, body, "validFrom");
    let valid_to = optional_date(issues, body, "validTo");
    let is_primary = issues
        .boolean(body, "isPrimary", Presence::Optional)
        .into_option();
    RegistrationFields {
        number,
        country,
        region,
        label,
        valid_from,
        valid_to,
        is_primary,
    }
}

/// Codes of issues that abort a Zod object (a type that does not match), so
/// its `superRefine` does not run. Failed checks only make it "dirty".
fn aborts(issue: &Value) -> bool {
    matches!(
        issue["code"].as_str(),
        Some("invalid_type" | "invalid_enum_value" | "invalid_literal" | "invalid_union")
    )
}

/// `createRegistrationSchema`: `registrationBase` plus the number's format
/// for its type (a `custom` issue at `number`, after everything else).
pub fn parse_create_registration(body: &Value) -> Result<CreateRegistrationInput, Invalid> {
    let mut issues = Issues::default();
    let mut reader = Reader::default();
    let read = issues.object(body).map(|fields| {
        let options: Vec<&str> = RegistrationType::ALL
            .iter()
            .map(|kind| kind.as_str())
            .collect();
        let kind = issues
            .choice(fields, "type", Presence::Required, &options)
            .into_option()
            .and_then(|kind| RegistrationType::parse(&kind));
        let rest = read_registration(&mut reader, &mut issues, fields, false);
        // The value the refinement sees: the trimmed number, even when a
        // length check failed.
        let raw_number = match fields.get("number") {
            Some(Value::String(raw)) => Some(js_trim(raw).to_owned()),
            _ => None,
        };
        (kind, rest, raw_number)
    });
    let mut refinement = None;
    if let Some((Some(kind), _, Some(number))) = &read {
        let aborted =
            issues.issues_since(0).iter().any(aborts) || reader.deferred.iter().any(aborts);
        if !aborted {
            refinement =
                registration_number_error(*kind, &normalize_registration_number(*kind, number));
        }
    }
    if let Some(message) = refinement {
        reader.refine(&issues, "number", message);
    }
    reader.finish(issues)?;
    let Some((Some(kind), rest, _)) = read else {
        return Err(invalid_input());
    };
    Ok(CreateRegistrationInput {
        registration_type: kind,
        number: rest.number.unwrap_or_default(),
        country: rest.country,
        region: rest.region,
        label: rest.label,
        valid_from: rest.valid_from,
        valid_to: rest.valid_to,
        is_primary: rest.is_primary,
    })
}

/// `updateRegistrationSchema`: `registrationBase` without `type`, every field
/// optional, no format refinement (the service checks the number against the
/// stored type).
pub fn parse_update_registration(body: &Value) -> Result<UpdateRegistrationInput, Invalid> {
    let rest = parse(body, |reader, issues, body| {
        read_registration(reader, issues, body, true)
    })?;
    Ok(UpdateRegistrationInput {
        number: rest.number,
        country: rest.country,
        region: rest.region,
        label: rest.label,
        valid_from: rest.valid_from,
        valid_to: rest.valid_to,
        is_primary: rest.is_primary,
    })
}

/// The fields of `bankAccountBase`.
struct BankAccountFields {
    name: Option<String>,
    account_holder_name: Field<String>,
    iban: Field<String>,
    bic: Field<String>,
    bank_name: Field<String>,
    currency: Option<String>,
    account_type: Field<String>,
    routing_number: Field<String>,
    account_number: Field<String>,
    ach_settings: Field<Value>,
    is_default: Option<bool>,
    is_active: Option<bool>,
}

fn read_bank_account(
    reader: &mut Reader,
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> BankAccountFields {
    let name = issues
        .text_with(
            body,
            "name",
            required_or(partial),
            Text::trimmed(Some(1), Some(255)),
        )
        .into_option();
    let account_holder_name = optional_text(issues, body, "accountHolderName", 255);
    let iban = match issues.text_with(body, "iban", Presence::Nullish, Text::trimmed(None, None)) {
        Field::Set(text) => {
            let compact: String = text
                .chars()
                .filter(|c| !is_js_space(*c))
                .collect::<String>()
                .to_uppercase();
            if compact.is_empty() || is_valid_iban(&compact) {
                Field::Set(compact)
            } else {
                reader.refine(issues, "iban", "This IBAN is not valid");
                Field::Absent
            }
        }
        other => other,
    };
    let bic = match issues.text_with(body, "bic", Presence::Nullish, Text::trimmed(None, None)) {
        Field::Set(text) => {
            let upper = text.to_uppercase();
            if upper.is_empty() || BIC.is_match(&upper) {
                Field::Set(upper)
            } else {
                reader.refine(issues, "bic", "This BIC is not valid");
                Field::Absent
            }
        }
        other => other,
    };
    let bank_name = optional_text(issues, body, "bankName", 255);
    let currency = reader
        .currency_code(issues, body, "currency", Presence::Optional)
        .into_option();
    let account_type = issues.choice(body, "accountType", Presence::Nullish, &BANK_ACCOUNT_TYPES);
    let routing_number = match issues.text_with(
        body,
        "routingNumber",
        Presence::Nullish,
        Text::trimmed(None, None),
    ) {
        Field::Set(text) if !(text.is_empty() || is_valid_aba_routing(&text)) => {
            reader.refine(issues, "routingNumber", "This routing number is not valid");
            Field::Absent
        }
        other => other,
    };
    let account_number =
        match issues.text_with(body, "accountNumber", Presence::Nullish, Text::default()) {
            Field::Set(text) => {
                let compact: String = text
                    .chars()
                    .filter(|c| !is_js_space(*c) && *c != '-')
                    .collect();
                if compact.is_empty() || ACCOUNT_NUMBER.is_match(&compact) {
                    Field::Set(compact)
                } else {
                    reader.refine(issues, "accountNumber", "Enter 4 to 34 letters or digits");
                    Field::Absent
                }
            }
            other => other,
        };
    let ach_settings = issues.nested(body, "achSettings", Presence::Nullish, |_, fields| {
        Value::Object(fields.clone())
    });
    let is_default = issues
        .boolean(body, "isDefault", Presence::Optional)
        .into_option();
    let is_active = issues
        .boolean(body, "isActive", Presence::Optional)
        .into_option();
    BankAccountFields {
        name,
        account_holder_name,
        iban,
        bic,
        bank_name,
        currency,
        account_type,
        routing_number,
        account_number,
        ach_settings,
        is_default,
        is_active,
    }
}

/// `createBankAccountSchema`.
pub fn parse_create_bank_account(body: &Value) -> Result<CreateBankAccountInput, Invalid> {
    let fields = parse(body, |reader, issues, body| {
        read_bank_account(reader, issues, body, false)
    })?;
    Ok(CreateBankAccountInput {
        name: fields.name.unwrap_or_default(),
        account_holder_name: fields.account_holder_name,
        iban: fields.iban,
        bic: fields.bic,
        bank_name: fields.bank_name,
        currency: fields.currency,
        account_type: fields.account_type,
        routing_number: fields.routing_number,
        account_number: fields.account_number,
        ach_settings: fields.ach_settings,
        is_default: fields.is_default,
        is_active: fields.is_active,
    })
}

/// `updateBankAccountSchema`: every field optional.
pub fn parse_update_bank_account(body: &Value) -> Result<UpdateBankAccountInput, Invalid> {
    let fields = parse(body, |reader, issues, body| {
        read_bank_account(reader, issues, body, true)
    })?;
    Ok(UpdateBankAccountInput {
        name: fields.name,
        account_holder_name: fields.account_holder_name,
        iban: fields.iban,
        bic: fields.bic,
        bank_name: fields.bank_name,
        currency: fields.currency,
        account_type: fields.account_type,
        routing_number: fields.routing_number,
        account_number: fields.account_number,
        ach_settings: fields.ach_settings,
        is_default: fields.is_default,
        is_active: fields.is_active,
    })
}

/// `revealBankAccountSchema`: the optional reason. The route reads it with
/// `safeParse` on `c.req.json().catch(() => ({}))` (a body that is not JSON
/// is `{}`) and answers a failure as `error.badRequest(c, 'Invalid request',
/// error.flatten())`: [`Invalid::flatten`].
pub fn parse_reveal_bank_account(body: &Value) -> Result<Option<String>, Invalid> {
    parse(body, |_, issues, body| {
        issues
            .text_with(
                body,
                "reason",
                Presence::Optional,
                Text::trimmed(None, Some(255)),
            )
            .into_option()
    })
}

/// `updateEntityAccessSchema`: the Restricted switch.
pub fn parse_update_entity_access(body: &Value) -> Result<bool, Invalid> {
    parse(body, |_, issues, body| {
        issues
            .boolean(body, "restricted", Presence::Required)
            .into_option()
    })
    .map(Option::unwrap_or_default)
}

/// `setEntityMemberSchema`: the member's role in the entity, `None` for their
/// workspace role.
pub fn parse_set_entity_member(body: &Value) -> Result<Option<String>, Invalid> {
    parse(body, |_, issues, body| {
        issues
            .text_with(
                body,
                "roleId",
                Presence::Nullable,
                Text::trimmed(Some(1), Some(30)),
            )
            .into_option()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_numbers_are_normalized_per_type() {
        assert_eq!(
            normalize_registration_number(RegistrationType::Vat, " nl 1234.56789.b01 "),
            "NL123456789B01"
        );
        assert_eq!(
            normalize_registration_number(RegistrationType::Ein, "12-3456789"),
            "12-3456789"
        );
        assert_eq!(
            normalize_registration_number(RegistrationType::CompanyRegistration, "kvk 1.2"),
            "KVK1.2"
        );
    }

    #[test]
    fn registration_formats() {
        let check = |kind, number: &str| registration_number_error(kind, number);
        assert_eq!(check(RegistrationType::Vat, "NL123456789B01"), None);
        assert_eq!(
            check(RegistrationType::Vat, "123"),
            Some("Use the VAT number with its country prefix, e.g. NL123456789B01")
        );
        assert_eq!(check(RegistrationType::NlPayrollTax, "123456789L01"), None);
        assert!(check(RegistrationType::NlPayrollTax, "123456789L1").is_some());
        assert_eq!(check(RegistrationType::Ein, "123456789"), None);
        assert_eq!(check(RegistrationType::Gstin, "27AAPFU0939F1ZV"), None);
        assert_eq!(check(RegistrationType::Pan, "AAPFU0939F"), None);
        // `\d` is ASCII in JavaScript.
        assert!(check(RegistrationType::Rsin, "١٢٣٤٥٦٧٨٩").is_some());
        assert_eq!(check(RegistrationType::Other, ""), Some("Enter a number"));
        assert_eq!(
            check(RegistrationType::Other, &"x".repeat(65)),
            Some("Enter a number")
        );
        assert_eq!(check(RegistrationType::Other, "anything"), None);
    }

    #[test]
    fn primary_types() {
        assert!(RegistrationType::NlPayrollTax.is_primary_type());
        assert!(!RegistrationType::UsStateWithholding.is_primary_type());
        assert!(!RegistrationType::Other.is_primary_type());
        for kind in RegistrationType::ALL {
            assert_eq!(RegistrationType::parse(kind.as_str()), Some(kind));
        }
    }

    #[test]
    fn iban_and_routing_checks() {
        assert!(is_valid_iban("NL91 ABNA 0417 1643 00"));
        assert!(is_valid_iban("gb82west12345698765432"));
        assert!(!is_valid_iban("NL91ABNA0417164301"));
        assert!(!is_valid_iban("NL91"));
        assert!(is_valid_aba_routing("011000015"));
        assert!(is_valid_aba_routing("021000021"));
        assert!(!is_valid_aba_routing("021000022"));
        assert!(!is_valid_aba_routing("02100002"));
    }

    #[test]
    fn a_create_body_reads_like_zod() {
        let body = json!({
            "name": "  Acme BV ",
            "jurisdictionCode": "nl",
            "baseCurrency": "eur",
            "address": { "line1": " Main 1 ", "unknown": true },
            "contact": { "email": "" },
            "branding": null,
            "fiscalYearStart": 4,
            "extra": "dropped",
        });
        let input = parse_create_legal_entity(&body).expect("valid");
        assert_eq!(input.name, "Acme BV");
        assert_eq!(input.jurisdiction_code, "NL");
        assert_eq!(input.base_currency, "EUR");
        assert_eq!(input.address, Field::Set(json!({ "line1": "Main 1" })));
        assert_eq!(input.contact, Field::Set(json!({ "email": "" })));
        assert_eq!(input.branding, Field::Null);
        assert_eq!(input.fiscal_year_start, Some(4));
        assert_eq!(input.legal_name, Field::Absent);
    }

    #[test]
    fn a_create_body_reports_zod_issues_with_refinements_last() {
        let body = json!({
            "name": "",
            "jurisdictionCode": "Netherlands",
            "baseCurrency": "EUR",
            "contact": { "email": "not-an-email" },
        });
        let Err(invalid) = parse_create_legal_entity(&body) else {
            panic!("invalid");
        };
        let codes: Vec<(&str, Value)> = invalid
            .issues()
            .iter()
            .map(|issue| {
                (
                    issue["code"].as_str().unwrap_or_default(),
                    issue["path"].clone(),
                )
            })
            .collect();
        assert_eq!(
            codes,
            vec![
                ("too_small", json!(["name"])),
                ("custom", json!(["jurisdictionCode"])),
                ("invalid_string", json!(["contact", "email"])),
            ]
        );
        assert_eq!(
            invalid.issues()[1]["message"],
            "Use a two-letter country code"
        );
    }

    #[test]
    fn a_registration_body_checks_the_number_for_its_type() {
        let Err(invalid) = parse_create_registration(&json!({ "type": "vat", "number": "123" }))
        else {
            panic!("invalid");
        };
        assert_eq!(
            invalid.issues(),
            [json!({
                "code": "custom",
                "message": "Use the VAT number with its country prefix, e.g. NL123456789B01",
                "path": ["number"],
            })]
        );
        // A type error aborts the object: no format check.
        let Err(invalid) = parse_create_registration(
            &json!({ "type": "vat", "number": "123", "isPrimary": "yes" }),
        ) else {
            panic!("invalid");
        };
        assert_eq!(invalid.issues().len(), 1);
        assert_eq!(invalid.issues()[0]["code"], "invalid_type");
        let ok = parse_create_registration(&json!({
            "type": "nl_payroll_tax",
            "number": " 123456789l01 ",
            "validFrom": "2026-02-28",
        }))
        .expect("valid");
        assert_eq!(ok.number, "123456789l01");
        assert_eq!(ok.valid_from, Field::Set("2026-02-28".to_owned()));
        let Err(invalid) = parse_create_registration(
            &json!({ "type": "other", "number": "x", "validTo": "2026-02-29" }),
        ) else {
            panic!("invalid");
        };
        assert_eq!(invalid.issues()[0]["validation"], "date");
    }

    #[test]
    fn a_bank_account_body_compacts_and_checks_its_numbers() {
        let input = parse_create_bank_account(&json!({
            "name": "Main",
            "iban": " nl91 abna 0417 1643 00 ",
            "bic": "abnanl2a",
            "accountNumber": "1234-5678 90",
            "routingNumber": "",
        }))
        .expect("valid");
        assert_eq!(input.iban, Field::Set("NL91ABNA0417164300".to_owned()));
        assert_eq!(input.bic, Field::Set("ABNANL2A".to_owned()));
        assert_eq!(input.account_number, Field::Set("1234567890".to_owned()));
        assert_eq!(input.routing_number, Field::Set(String::new()));
        let Err(invalid) =
            parse_update_bank_account(&json!({ "iban": "NL00", "routingNumber": "123" }))
        else {
            panic!("invalid");
        };
        let messages: Vec<&str> = invalid
            .issues()
            .iter()
            .filter_map(|issue| issue["message"].as_str())
            .collect();
        assert_eq!(
            messages,
            ["This IBAN is not valid", "This routing number is not valid"]
        );
    }

    #[test]
    fn access_bodies() {
        assert_eq!(
            parse_update_entity_access(&json!({ "restricted": true })),
            Ok(true)
        );
        assert!(parse_update_entity_access(&json!({})).is_err());
        assert_eq!(
            parse_set_entity_member(&json!({ "roleId": null })),
            Ok(None)
        );
        assert_eq!(
            parse_set_entity_member(&json!({ "roleId": " role_1 " })),
            Ok(Some("role_1".to_owned()))
        );
        let Err(missing) = parse_set_entity_member(&json!({})) else {
            panic!("invalid");
        };
        assert_eq!(missing.issues()[0]["message"], "Required");
        assert_eq!(parse_reveal_bank_account(&json!({})), Ok(None));
        let Err(not_object) = parse_reveal_bank_account(&json!([])) else {
            panic!("invalid");
        };
        assert_eq!(
            not_object.flatten(),
            json!({ "formErrors": ["Expected object, received array"], "fieldErrors": {} })
        );
    }

    #[test]
    fn list_queries() {
        assert_eq!(
            parse_list_query(Some("app=weldbooks&includeArchived=true")),
            Ok(ListLegalEntitiesOptions {
                app: Some(LegalEntityApp::Weldbooks),
                include_archived: true,
            })
        );
        assert_eq!(
            parse_list_query(None),
            Ok(ListLegalEntitiesOptions::default())
        );
        assert!(parse_list_query(Some("app=weldcrm")).is_err());
    }
}
