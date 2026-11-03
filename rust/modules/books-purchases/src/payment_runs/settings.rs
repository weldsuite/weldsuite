//! A bank account's payment settings (`services/payment-runs/settings.ts`,
//! `bank-settings.ts`): check printing, NACHA origination and the Positive
//! Pay format, in the `bank_accounts` columns `next_check_number`,
//! `check_settings`, `ach_settings` and `positive_pay_format`. Reading fills
//! in the defaults (an unknown or bad stored value falls back); writing merges
//! section by section, `null` clearing a key.

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::checks::{
    CheckAlignment, check_layouts_json, is_check_layout_id, is_fractional_numerator,
};
use weldsuite_books_domain::js::{number_value, utf16_len};
use weldsuite_books_domain::nacha::{aba_checksum_valid, company_id_from_ein};
use weldsuite_books_domain::positive_pay::{
    POSITIVE_PAY_DATE_FORMATS, POSITIVE_PAY_FIELDS, POSITIVE_PAY_FORMAT_IDS, PositivePayColumn,
    PositivePayOverrides, is_positive_pay_format, positive_pay_formats_json,
};
use weldsuite_books_domain::tables::{BANK_ACCOUNTS, ENTITIES};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text, js_trim};

use super::{RunError, load_bank_account, not_found, run_error};

pub(crate) const DEFAULT_HOLD_WINDOW_DAYS: i64 = 10;
pub(crate) const ACH_SEC_CODES: [&str; 4] = ["PPD", "CCD", "CCD+", "CTX"];

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `typeof v === 'string' && v.trim() ? v.trim() : null`.
fn trimmed(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// A JSON number that is a whole number between `min` and `max`.
fn whole_in(value: Option<&Value>, min: f64, max: f64) -> Option<i64> {
    let n = value.and_then(Value::as_f64)?;
    #[allow(clippy::cast_possible_truncation)]
    (n.is_finite() && n.fract() == 0.0 && n >= min && n <= max).then_some(n as i64)
}

// ── Check settings ──────────────────────────────────────────────────────────

/// `CheckSettings`, defaults filled in.
#[derive(Debug, Clone)]
pub(crate) struct CheckSettings {
    pub layout: String,
    /// The offsets that are set (`dx`, `dy`, `micrDx`, `micrDy`).
    pub alignment: Map<String, Value>,
    pub print_micr: bool,
    pub personal_micr: bool,
    pub check_number_width: i64,
    pub bank_name: Option<String>,
    pub bank_address_lines: Vec<String>,
    pub fractional_numerator: Option<String>,
    pub signature_line_text: Option<String>,
}

impl CheckSettings {
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "layout": self.layout,
            "alignment": self.alignment,
            "printMicr": self.print_micr,
            "micrLayout": if self.personal_micr { "personal" } else { "business" },
            "checkNumberWidth": self.check_number_width,
            "bankName": self.bank_name,
            "bankAddressLines": self.bank_address_lines,
            "fractionalNumerator": self.fractional_numerator,
            "signatureLineText": self.signature_line_text,
        })
    }

    /// The alignment with the defaults (`{ dx: 0, dy: 0, micrDx: 0, micrDy: 0, ...alignment }`).
    pub(crate) fn alignment(&self) -> CheckAlignment {
        let of = |key: &str| {
            self.alignment
                .get(key)
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        };
        CheckAlignment {
            dx: of("dx"),
            dy: of("dy"),
            micr_dx: of("micrDx"),
            micr_dy: of("micrDy"),
        }
    }
}

/// `readCheckSettings(raw)`.
pub(crate) fn read_check_settings(raw: Option<&Value>) -> CheckSettings {
    let source = raw
        .filter(|r| r.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let layout = text(&source, "layout")
        .filter(|l| is_check_layout_id(l))
        .unwrap_or("voucher_top")
        .to_owned();
    let mut alignment = Map::new();
    if let Some(Value::Object(offsets)) = source.get("alignment") {
        for key in ["dx", "dy", "micrDx", "micrDy"] {
            if let Some(value) = offsets
                .get(key)
                .filter(|v| v.as_f64().is_some_and(f64::is_finite))
            {
                alignment.insert(key.to_owned(), value.clone());
            }
        }
    }
    let width = match source.get("checkNumberWidth") {
        Some(Value::Number(_)) => whole_in(source.get("checkNumberWidth"), 4.0, 12.0).unwrap_or(6),
        _ => 6,
    };
    let bank_address_lines = match source.get("bankAddressLines") {
        Some(Value::Array(lines)) => lines
            .iter()
            .filter_map(Value::as_str)
            .filter(|l| !js_trim(l).is_empty())
            .take(3)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    };
    CheckSettings {
        layout,
        alignment,
        print_micr: source.get("printMicr") == Some(&Value::Bool(true)),
        personal_micr: text(&source, "micrLayout") == Some("personal"),
        check_number_width: width,
        bank_name: trimmed(source.get("bankName")),
        bank_address_lines,
        fractional_numerator: text(&source, "fractionalNumerator")
            .filter(|n| is_fractional_numerator(n))
            .map(str::to_owned),
        signature_line_text: trimmed(source.get("signatureLineText")),
    }
}

// ── ACH settings ────────────────────────────────────────────────────────────

/// `AchSettings`, defaults filled in.
#[derive(Debug, Clone)]
pub(crate) struct AchSettings {
    pub immediate_destination: Option<String>,
    pub immediate_destination_name: Option<String>,
    pub immediate_origin: Option<String>,
    pub immediate_origin_name: Option<String>,
    pub company_name: Option<String>,
    pub company_identification: Option<String>,
    pub odfi_routing_number: Option<String>,
    pub balanced: bool,
    pub offset_bank_account_id: Option<String>,
    pub default_sec_code: String,
    pub same_day_allowed: bool,
    pub entry_description: Option<String>,
    pub hold_window_days: i64,
    pub require_prenotes: bool,
}

impl AchSettings {
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "immediateDestination": self.immediate_destination,
            "immediateDestinationName": self.immediate_destination_name,
            "immediateOrigin": self.immediate_origin,
            "immediateOriginName": self.immediate_origin_name,
            "companyName": self.company_name,
            "companyIdentification": self.company_identification,
            "odfiRoutingNumber": self.odfi_routing_number,
            "balanced": self.balanced,
            "offsetBankAccountId": self.offset_bank_account_id,
            "defaultSecCode": self.default_sec_code,
            "sameDayAllowed": self.same_day_allowed,
            "entryDescription": self.entry_description,
            "holdWindowDays": self.hold_window_days,
            "requirePrenotes": self.require_prenotes,
        })
    }
}

/// `readAchSettings(raw)`.
pub(crate) fn read_ach_settings(raw: Option<&Value>) -> AchSettings {
    let source = raw
        .filter(|r| r.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let get = |key: &str| trimmed(source.get(key));
    let flag = |key: &str| source.get(key) == Some(&Value::Bool(true));
    let days = match source.get("holdWindowDays") {
        Some(Value::Number(_)) => {
            whole_in(source.get("holdWindowDays"), 1.0, 365.0).unwrap_or(DEFAULT_HOLD_WINDOW_DAYS)
        }
        _ => DEFAULT_HOLD_WINDOW_DAYS,
    };
    AchSettings {
        immediate_destination: get("immediateDestination"),
        immediate_destination_name: get("immediateDestinationName"),
        immediate_origin: get("immediateOrigin"),
        immediate_origin_name: get("immediateOriginName"),
        company_name: get("companyName"),
        company_identification: get("companyIdentification"),
        odfi_routing_number: get("odfiRoutingNumber"),
        balanced: flag("balanced"),
        offset_bank_account_id: get("offsetBankAccountId"),
        default_sec_code: text(&source, "defaultSecCode")
            .filter(|c| ACH_SEC_CODES.contains(c))
            .unwrap_or("CCD")
            .to_owned(),
        same_day_allowed: flag("sameDayAllowed"),
        entry_description: get("entryDescription"),
        hold_window_days: days,
        require_prenotes: flag("requirePrenotes"),
    }
}

// ── Positive Pay ────────────────────────────────────────────────────────────

/// `readPositivePayConfig(checkSettings)`: the stored config as the schema
/// parses it (unknown keys dropped), or `{}` when it does not parse.
pub(crate) fn read_positive_pay_config(
    check_settings: Option<&Value>,
) -> (Value, PositivePayOverrides) {
    let stored = check_settings.and_then(|s| s.get("positivePayConfig"));
    let mut issues = Issues::default();
    let parsed = stored
        .and_then(|config| issues.object(config))
        .map(|fields| read_positive_pay_fields(&mut issues, fields));
    match parsed {
        Some((value, overrides)) if issues.is_empty() => (value, overrides),
        _ => (json!({}), PositivePayOverrides::default()),
    }
}

/// `positivePayFormatOf(account, override)`.
pub(crate) fn positive_pay_format_of(account: &Value, wanted: Option<&str>) -> String {
    let wanted = wanted.or_else(|| text(account, "positivePayFormat"));
    wanted
        .filter(|w| is_positive_pay_format(w))
        .unwrap_or("generic_csv")
        .to_owned()
}

/// A string field with a max length (no trim), as the config schema reads it.
fn optional_text(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    max: usize,
) -> Field<String> {
    issues.text(body, key, Presence::Optional, None, Some(max))
}

/// `positivePayConfigSchema` (`.partial()`): the parsed object and the
/// builder's overrides.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
fn read_positive_pay_fields(
    issues: &mut Issues,
    body: &Map<String, Value>,
) -> (Value, PositivePayOverrides) {
    let mut out = Map::new();
    let mut o = PositivePayOverrides::default();
    if let Field::Set(kind) = issues.choice(body, "kind", Presence::Optional, &["csv", "fixed"]) {
        o.fixed = Some(kind == "fixed");
        out.insert("kind".to_owned(), json!(kind));
    }
    let columns = issues.list(
        body,
        "columns",
        Presence::Optional,
        Some(1),
        Some(30),
        |issues, item| {
            let fields = issues.object(item)?;
            let field = issues.choice(fields, "field", Presence::Required, &POSITIVE_PAY_FIELDS);
            let header = optional_text(issues, fields, "header", 60);
            let width = issues.whole_number(
                fields,
                "width",
                Presence::Optional,
                Number {
                    min: Some(1.0),
                    max: Some(200.0),
                    ..Number::default()
                },
            );
            let align = issues.choice(fields, "align", Presence::Optional, &["left", "right"]);
            let pad = issues.choice(fields, "pad", Presence::Optional, &[" ", "0"]);
            let literal = optional_text(issues, fields, "literal", 60);
            let field = field.into_option()?;
            let mut json = Map::new();
            json.insert("field".to_owned(), json!(field));
            let column = PositivePayColumn {
                field,
                header: header.into_option(),
                width: width.into_option().and_then(|w| usize::try_from(w).ok()),
                align: align.into_option(),
                pad: pad.into_option(),
                literal: literal.into_option(),
            };
            if let Some(header) = &column.header {
                json.insert("header".to_owned(), json!(header));
            }
            if let Some(width) = column.width {
                json.insert("width".to_owned(), json!(width));
            }
            if let Some(align) = &column.align {
                json.insert("align".to_owned(), json!(align));
            }
            if let Some(pad) = &column.pad {
                json.insert("pad".to_owned(), json!(pad));
            }
            if let Some(literal) = &column.literal {
                json.insert("literal".to_owned(), json!(literal));
            }
            Some((Value::Object(json), column))
        },
    );
    if let Field::Set(columns) = columns {
        out.insert(
            "columns".to_owned(),
            Value::Array(columns.iter().map(|(json, _)| json.clone()).collect()),
        );
        o.columns = Some(columns.into_iter().map(|(_, column)| column).collect());
    }
    if let Field::Set(format) = issues.choice(
        body,
        "dateFormat",
        Presence::Optional,
        &POSITIVE_PAY_DATE_FORMATS,
    ) {
        out.insert("dateFormat".to_owned(), json!(format));
        o.date_format = Some(format);
    }
    if let Field::Set(format) = issues.choice(
        body,
        "amountFormat",
        Presence::Optional,
        &["decimal", "implied_decimal"],
    ) {
        o.implied_decimal = Some(format == "implied_decimal");
        out.insert("amountFormat".to_owned(), json!(format));
    }
    if let Field::Set(delimiter) = issues.text(body, "delimiter", Presence::Optional, None, None) {
        let length = utf16_len(&delimiter);
        if length == 1 {
            out.insert("delimiter".to_owned(), json!(delimiter));
            o.delimiter = Some(delimiter);
        } else {
            issues.string_length("delimiter", 1, length);
        }
    }
    if let Field::Set(header) = issues.boolean(body, "header", Presence::Optional) {
        out.insert("header".to_owned(), json!(header));
        o.header = Some(header);
    }
    if let Field::Set(quote) = issues.boolean(body, "quoteAll", Presence::Optional) {
        out.insert("quoteAll".to_owned(), json!(quote));
        o.quote_all = Some(quote);
    }
    for (key, slot) in [
        ("issueFlag", &mut o.issue_flag),
        ("voidFlag", &mut o.void_flag),
        ("actionIssue", &mut o.action_issue),
        ("actionVoid", &mut o.action_void),
    ] {
        if let Field::Set(value) = optional_text(issues, body, key, 5) {
            out.insert(key.to_owned(), json!(value));
            *slot = Some(value);
        }
    }
    if let Field::Set(length) = issues.whole_number(
        body,
        "payeeMaxLength",
        Presence::Optional,
        Number {
            min: Some(1.0),
            max: Some(200.0),
            ..Number::default()
        },
    ) {
        out.insert("payeeMaxLength".to_owned(), json!(length));
        o.payee_max_length = usize::try_from(length).ok();
    }
    if let Field::Set(upper) = issues.boolean(body, "uppercasePayee", Presence::Optional) {
        out.insert("uppercasePayee".to_owned(), json!(upper));
        o.uppercase_payee = Some(upper);
    }
    if let Field::Set(ending) =
        issues.choice(body, "lineEnding", Presence::Optional, &["\r\n", "\n"])
    {
        out.insert("lineEnding".to_owned(), json!(ending));
        o.line_ending = Some(ending);
    }
    (Value::Object(out), o)
}

// ── The PUT body ────────────────────────────────────────────────────────────

/// `UpdateSettingsInput`: each section as Zod parsed it (only the keys sent,
/// strings trimmed); `Field::Null` clears.
#[derive(Debug, Default)]
pub(crate) struct SettingsInput {
    pub next_check_number: Field<i64>,
    pub check_settings: Option<Map<String, Value>>,
    pub ach_settings: Option<Map<String, Value>>,
    pub positive_pay_format: Field<String>,
    pub positive_pay_config: Field<Value>,
}

/// A refinement Zod settles after the body's synchronous checks.
struct Pending(Vec<Value>);

impl Pending {
    fn custom(&mut self, issues: &Issues, key: &str, message: &str) {
        self.0
            .push(json!({ "code": "custom", "message": message, "path": issues.path_of(key) }));
    }
}

/// `z.string().trim().regex(re, message)` (plus the field's other rules):
/// the trimmed value, or the issue.
#[allow(clippy::too_many_arguments)] // the field and its rules
fn trimmed_pattern(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
    max: Option<usize>,
    min: Option<usize>,
    matches: impl Fn(&str) -> bool,
    message: &str,
) -> Field<String> {
    let before = issues.count();
    let field = issues.text_with(body, key, presence, Text::trimmed(min, max));
    if let Some(Value::String(raw)) = body.get(key) {
        let value = js_trim(raw);
        if !matches(value) {
            issues.issue_at(
                key,
                json!({ "validation": "regex", "code": "invalid_string", "message": message }),
            );
            return Field::Absent;
        }
    }
    if issues.count() > before {
        return Field::Absent;
    }
    field
}

fn put(out: &mut Map<String, Value>, key: &str, field: Field<Value>) {
    match field {
        Field::Set(value) => {
            out.insert(key.to_owned(), value);
        }
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
}

fn string_field(field: Field<String>) -> Field<Value> {
    match field {
        Field::Set(text) => Field::Set(Value::String(text)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    }
}

/// `checkSettingsSchema`.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
fn read_check_settings_body(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let layouts: Vec<&str> = weldsuite_books_domain::checks::CHECK_LAYOUTS
        .iter()
        .map(|(id, _, _)| *id)
        .collect();
    put(
        &mut out,
        "layout",
        string_field(issues.choice(body, "layout", Presence::Optional, &layouts)),
    );
    let alignment = issues.nested(body, "alignment", Presence::Optional, |issues, fields| {
        let mut offsets = Map::new();
        for key in ["dx", "dy", "micrDx", "micrDy"] {
            if let Field::Set(n) = read_offset(issues, fields, key) {
                offsets.insert(key.to_owned(), number_value(n));
            }
        }
        Value::Object(offsets)
    });
    put(&mut out, "alignment", alignment);
    put(
        &mut out,
        "printMicr",
        match issues.boolean(body, "printMicr", Presence::Optional) {
            Field::Set(flag) => Field::Set(json!(flag)),
            _ => Field::Absent,
        },
    );
    put(
        &mut out,
        "micrLayout",
        string_field(issues.choice(
            body,
            "micrLayout",
            Presence::Optional,
            &["business", "personal"],
        )),
    );
    put(
        &mut out,
        "checkNumberWidth",
        match issues.whole_number(
            body,
            "checkNumberWidth",
            Presence::Optional,
            Number {
                min: Some(4.0),
                max: Some(12.0),
                ..Number::default()
            },
        ) {
            Field::Set(n) => Field::Set(json!(n)),
            _ => Field::Absent,
        },
    );
    put(
        &mut out,
        "bankName",
        string_field(issues.text_with(
            body,
            "bankName",
            Presence::Nullish,
            Text::trimmed(None, Some(60)),
        )),
    );
    let lines = issues.list(
        body,
        "bankAddressLines",
        Presence::Optional,
        None,
        Some(3),
        |issues, item| issues.item_text(item, Text::trimmed(None, Some(60))),
    );
    if let Field::Set(lines) = lines {
        out.insert("bankAddressLines".to_owned(), json!(lines));
    }
    put(
        &mut out,
        "fractionalNumerator",
        string_field(trimmed_pattern(
            issues,
            body,
            "fractionalNumerator",
            Presence::Nullish,
            None,
            None,
            is_fractional_numerator,
            "The numerator looks like 90-7162",
        )),
    );
    put(
        &mut out,
        "signatureLineText",
        string_field(issues.text_with(
            body,
            "signatureLineText",
            Presence::Nullish,
            Text::trimmed(None, Some(60)),
        )),
    );
    out
}

/// `z.number().finite().min(-72).max(72)`, optional.
fn read_offset(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Field<f64> {
    // JSON numbers are finite: `.finite()` never fails on a body.
    issues.number(
        body,
        key,
        Presence::Optional,
        Number {
            min: Some(-72.0),
            max: Some(72.0),
            ..Number::default()
        },
    )
}

fn nine_digits(value: &str) -> bool {
    value.len() == 9 && value.bytes().all(|b| b.is_ascii_digit())
}

/// `achSettingsSchema` (`.partial()`).
#[allow(clippy::too_many_lines)] // one field after the other, as the schema
fn read_ach_settings_body(
    issues: &mut Issues,
    body: &Map<String, Value>,
    pending: &mut Pending,
) -> Map<String, Value> {
    let mut out = Map::new();
    let routing = |issues: &mut Issues, pending: &mut Pending, key: &str| -> Field<Value> {
        let field = trimmed_pattern(
            issues,
            body,
            key,
            Presence::Nullish,
            None,
            None,
            nine_digits,
            "A routing number is 9 digits",
        );
        if let Some(Value::String(raw)) = body.get(key)
            && !aba_checksum_valid(js_trim(raw))
        {
            pending.custom(issues, key, "The routing number fails the ABA checksum");
            return Field::Absent;
        }
        string_field(field)
    };
    let destination = routing(issues, pending, "immediateDestination");
    put(&mut out, "immediateDestination", destination);
    put(
        &mut out,
        "immediateDestinationName",
        string_field(issues.text_with(
            body,
            "immediateDestinationName",
            Presence::Nullish,
            Text::trimmed(None, Some(23)),
        )),
    );
    put(
        &mut out,
        "immediateOrigin",
        string_field(trimmed_pattern(
            issues,
            body,
            "immediateOrigin",
            Presence::Nullish,
            None,
            None,
            |v| {
                (9..=10).contains(&v.len())
                    && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b' ')
            },
            "The immediate origin is a 10-character company id or a 9-digit routing number",
        )),
    );
    put(
        &mut out,
        "immediateOriginName",
        string_field(issues.text_with(
            body,
            "immediateOriginName",
            Presence::Nullish,
            Text::trimmed(None, Some(23)),
        )),
    );
    put(
        &mut out,
        "companyName",
        string_field(issues.text_with(
            body,
            "companyName",
            Presence::Nullish,
            Text::trimmed(None, Some(16)),
        )),
    );
    put(
        &mut out,
        "companyIdentification",
        string_field(trimmed_pattern(
            issues,
            body,
            "companyIdentification",
            Presence::Nullish,
            None,
            None,
            |v| v.len() == 10 && v.bytes().all(|b| b.is_ascii_alphanumeric()),
            "The company identification is 10 characters, e.g. 1 followed by the 9-digit EIN",
        )),
    );
    put(
        &mut out,
        "ein",
        string_field(issues.text_with(
            body,
            "ein",
            Presence::Optional,
            Text::trimmed(None, Some(11)),
        )),
    );
    let odfi = routing(issues, pending, "odfiRoutingNumber");
    put(&mut out, "odfiRoutingNumber", odfi);
    let flag = |issues: &mut Issues, key: &str| match issues.boolean(body, key, Presence::Optional)
    {
        Field::Set(flag) => Field::Set(json!(flag)),
        _ => Field::Absent,
    };
    let balanced = flag(issues, "balanced");
    put(&mut out, "balanced", balanced);
    put(
        &mut out,
        "offsetBankAccountId",
        string_field(issues.text_with(
            body,
            "offsetBankAccountId",
            Presence::Nullish,
            Text::trimmed(Some(1), Some(30)),
        )),
    );
    put(
        &mut out,
        "defaultSecCode",
        string_field(issues.choice(body, "defaultSecCode", Presence::Optional, &ACH_SEC_CODES)),
    );
    let same_day = flag(issues, "sameDayAllowed");
    put(&mut out, "sameDayAllowed", same_day);
    let description = issues.text_with(
        body,
        "entryDescription",
        Presence::Nullish,
        Text::trimmed(None, Some(10)),
    );
    if let Some(Value::String(raw)) = body.get("entryDescription") {
        let upper = js_trim(raw).to_uppercase();
        if upper == "PAYROLL" || upper == "PURCHASE" {
            pending.custom(
                issues,
                "entryDescription",
                "\"PAYROLL\" and \"PURCHASE\" are reserved by Nacha",
            );
        }
    }
    put(&mut out, "entryDescription", string_field(description));
    put(
        &mut out,
        "holdWindowDays",
        match issues.whole_number(
            body,
            "holdWindowDays",
            Presence::Optional,
            Number {
                min: Some(1.0),
                max: Some(365.0),
                ..Number::default()
            },
        ) {
            Field::Set(n) => Field::Set(json!(n)),
            _ => Field::Absent,
        },
    );
    let prenotes = flag(issues, "requirePrenotes");
    put(&mut out, "requirePrenotes", prenotes);
    out
}

/// `updateSettingsSchema`.
pub(crate) fn read_settings_body(issues: &mut Issues, body: &Map<String, Value>) -> SettingsInput {
    let mut pending = Pending(Vec::new());
    let next_check_number = issues.whole_number(
        body,
        "nextCheckNumber",
        Presence::Nullish,
        Number {
            min: Some(1.0),
            max: Some(999_999_999.0),
            ..Number::default()
        },
    );
    let check_settings = issues
        .nested(
            body,
            "checkSettings",
            Presence::Optional,
            read_check_settings_body,
        )
        .into_option();
    let ach_settings = issues
        .nested(body, "achSettings", Presence::Optional, |issues, fields| {
            read_ach_settings_body(issues, fields, &mut pending)
        })
        .into_option();
    let positive_pay_format = issues.choice(
        body,
        "positivePayFormat",
        Presence::Nullish,
        &POSITIVE_PAY_FORMAT_IDS,
    );
    let positive_pay_config = issues.nested(
        body,
        "positivePayConfig",
        Presence::Nullish,
        |issues, fields| read_positive_pay_fields(issues, fields).0,
    );
    for issue in pending.0 {
        issues.push_raw(issue);
    }
    SettingsInput {
        next_check_number,
        check_settings,
        ach_settings,
        positive_pay_format,
        positive_pay_config,
    }
}

/// `mergeSection(existing, patch)`: a shallow merge where `null` deletes.
fn merge_section(existing: Option<&Value>, patch: &Map<String, Value>) -> Value {
    let mut merged = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (key, value) in patch {
        if value.is_null() {
            merged.remove(key);
        } else {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

// ── What a NACHA file will say ──────────────────────────────────────────────

/// `EffectiveOriginator`.
#[derive(Debug, Clone)]
pub(crate) struct EffectiveOriginator {
    pub immediate_destination: Option<String>,
    pub immediate_destination_name: String,
    pub immediate_origin: Option<String>,
    pub immediate_origin_name: String,
    pub company_name: String,
    pub company_identification: Option<String>,
    pub odfi_routing_number: Option<String>,
}

impl EffectiveOriginator {
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "immediateDestination": self.immediate_destination,
            "immediateDestinationName": self.immediate_destination_name,
            "immediateOrigin": self.immediate_origin,
            "immediateOriginName": self.immediate_origin_name,
            "companyName": self.company_name,
            "companyIdentification": self.company_identification,
            "odfiRoutingNumber": self.odfi_routing_number,
        })
    }
}

fn owned(row: &Value, key: &str) -> Option<String> {
    text(row, key).map(str::to_owned)
}

/// `effectiveOriginator(bank, entity, ach)`.
pub(crate) fn effective_originator(
    bank: &Value,
    entity: &Value,
    ach: &AchSettings,
) -> EffectiveOriginator {
    let ein = entity
        .get("taxIdentifiers")
        .and_then(|t| t.get("einOrSsn"))
        .and_then(Value::as_str)
        .map(|raw| raw.chars().filter(char::is_ascii_digit).collect::<String>())
        .filter(|digits| digits.len() == 9);
    let company_identification = ach
        .company_identification
        .clone()
        .or_else(|| ein.as_deref().and_then(company_id_from_ein));
    let entity_name = owned(entity, "legalName")
        .or_else(|| owned(entity, "name"))
        .unwrap_or_default();
    EffectiveOriginator {
        immediate_destination: ach
            .immediate_destination
            .clone()
            .or_else(|| owned(bank, "routingNumber")),
        immediate_destination_name: ach
            .immediate_destination_name
            .clone()
            .or_else(|| owned(bank, "bankName"))
            .or_else(|| owned(bank, "name"))
            .unwrap_or_default(),
        immediate_origin: ach
            .immediate_origin
            .clone()
            .or_else(|| company_identification.clone()),
        immediate_origin_name: ach
            .immediate_origin_name
            .clone()
            .unwrap_or_else(|| entity_name.clone()),
        company_name: ach
            .company_name
            .clone()
            .or_else(|| owned(entity, "dba"))
            .unwrap_or(entity_name),
        company_identification,
        odfi_routing_number: ach
            .odfi_routing_number
            .clone()
            .or_else(|| ach.immediate_destination.clone())
            .or_else(|| owned(bank, "routingNumber")),
    }
}

/// `Readiness`.
pub(crate) fn readiness(missing: &[&str]) -> Value {
    json!({ "ready": missing.is_empty(), "missing": missing })
}

/// `achReadiness(effective, ach, hasOffsetAccount)`: what is missing.
pub(crate) fn ach_missing(
    effective: &EffectiveOriginator,
    ach: &AchSettings,
    has_offset: bool,
) -> Vec<&'static str> {
    let empty = |v: &Option<String>| v.as_deref().is_none_or(str::is_empty);
    let mut missing = Vec::new();
    if empty(&effective.immediate_destination) {
        missing.push("immediateDestination");
    }
    if empty(&effective.company_identification) {
        missing.push("companyIdentification");
    }
    if empty(&effective.immediate_origin) {
        missing.push("immediateOrigin");
    }
    if ach.balanced && !has_offset {
        missing.push("offsetBankAccount");
    }
    missing
}

fn truthy(row: &Value, key: &str) -> bool {
    weldsuite_books_domain::js::truthy(row.get(key))
}

/// `checkReadiness(bank, check)`.
fn check_missing(bank: &Value, check: &CheckSettings) -> Vec<&'static str> {
    let mut missing = Vec::new();
    if bank.get("nextCheckNumber").is_none_or(Value::is_null) {
        missing.push("nextCheckNumber");
    }
    if check.print_micr {
        if !truthy(bank, "routingNumber") {
            missing.push("routingNumber");
        }
        if !truthy(bank, "accountNumberLast4") {
            missing.push("accountNumber");
        }
    }
    missing
}

/// Whether a bank account can be the debit side of a balanced file.
pub(crate) fn can_offset(bank: Option<&Value>) -> bool {
    bank.is_some_and(|b| truthy(b, "routingNumber") && truthy(b, "accountNumberEncrypted"))
}

/// `highestCheckNumber(db, bankAccountId)`: voided checks included.
pub(crate) async fn highest_check_number(
    db: &PgPool,
    bank_account_id: &str,
) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar(
        "select max(check_number::bigint) from payments where bank_account_id = $1 and check_number ~ '^[0-9]{1,15}$'",
    )
    .bind(bank_account_id)
    .fetch_one(db)
    .await
}

/// The entity row.
pub(crate) async fn load_entity(
    db: &PgPool,
    entity_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(entities),
        " from entities t where t.id = $1 limit 1"
    ))
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| ENTITIES.js(row)))
}

/// `settingsView(db, bank)`.
pub(crate) async fn settings_view(db: &PgPool, bank: &Value) -> Result<Value, RunError> {
    let entity_id = text(bank, "entityId").unwrap_or_default();
    let Some(entity) = load_entity(db, entity_id).await? else {
        return Err(not_found("Accounting entity", entity_id));
    };
    let check = read_check_settings(bank.get("checkSettings"));
    let ach = read_ach_settings(bank.get("achSettings"));
    let effective = effective_originator(bank, &entity, &ach);
    let bank_id = text(bank, "id").unwrap_or_default();
    let offset = match ach.offset_bank_account_id.as_deref() {
        Some(offset_id) if ach.balanced && offset_id != bank_id => {
            let row: Option<Value> = sqlx::query_scalar(concat!(
                "select ",
                weldsuite_books_domain::books_row!(bank_accounts),
                " from bank_accounts t where t.id = $1 and t.deleted_at is null limit 1"
            ))
            .bind(offset_id)
            .fetch_optional(db)
            .await?;
            row.map(|row| BANK_ACCOUNTS.js(row))
        }
        _ => Some(bank.clone()),
    };
    let highest = highest_check_number(db, bank_id).await?;
    let has_number = truthy(bank, "accountNumberEncrypted");
    let (config, _) = read_positive_pay_config(bank.get("checkSettings"));
    let field = |key: &str| bank.get(key).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "bankAccountId": bank_id,
        "bankAccountName": field("name"),
        "bankName": field("bankName"),
        "routingNumber": field("routingNumber"),
        "accountNumberLast4": field("accountNumberLast4"),
        "hasAccountNumber": has_number,
        "nextCheckNumber": field("nextCheckNumber"),
        "highestCheckNumberUsed": highest,
        "checkSettings": check.to_json(),
        "achSettings": ach.to_json(),
        "effectiveAch": effective.to_json(),
        "positivePayFormat": positive_pay_format_of(bank, None),
        "positivePayConfig": config,
        "readiness": {
            "checks": readiness(&check_missing(bank, &check)),
            "ach": readiness(&ach_missing(&effective, &ach, can_offset(offset.as_ref()))),
            "positivePay": readiness(if has_number { &[][..] } else { &["accountNumber"][..] }),
        },
        "layouts": check_layouts_json(),
        "positivePayFormats": positive_pay_formats_json(),
    }))
}

/// `updateBankSettings(db, { entityId, bankAccountId, input })`: the view
/// and which sections changed.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub(crate) async fn update_bank_settings(
    db: &PgPool,
    entity_id: &str,
    bank_account_id: &str,
    input: SettingsInput,
) -> Result<(Value, Vec<&'static str>), RunError> {
    let bank = load_bank_account(db, entity_id, bank_account_id).await?;
    let bank_id = text(&bank, "id").unwrap_or_default().to_owned();
    let mut set = Map::new();
    set.insert(
        "updated_at".to_owned(),
        json!(weldsuite_books_domain::http::now()),
    );
    let mut changed: Vec<&'static str> = Vec::new();

    if !input.next_check_number.is_absent() {
        if let Field::Set(next) = input.next_check_number {
            let highest = highest_check_number(db, &bank_id).await?;
            if let Some(highest) = highest
                && next <= highest
            {
                return Err(run_error(
                    "CHECK_NUMBER_IN_USE",
                    format!(
                        "Check numbers only go forward: {highest} is already used on this account, so the next one has to be {} or more.",
                        highest + 1
                    ),
                    409,
                    Some(json!({ "highestUsed": highest })),
                ));
            }
            set.insert("next_check_number".to_owned(), json!(next));
        } else {
            set.insert("next_check_number".to_owned(), Value::Null);
        }
        changed.push("nextCheckNumber");
    }

    let original = bank.get("checkSettings").cloned().unwrap_or(Value::Null);
    let mut check_settings: Option<Value> = None;
    if let Some(patch) = &input.check_settings {
        check_settings = Some(merge_section(Some(&original), patch));
        changed.push("checkSettings");
    }
    if !input.positive_pay_config.is_absent() {
        let mut patch = Map::new();
        patch.insert(
            "positivePayConfig".to_owned(),
            input
                .positive_pay_config
                .as_set()
                .cloned()
                .unwrap_or(Value::Null),
        );
        let base = check_settings.clone().unwrap_or_else(|| original.clone());
        check_settings = Some(merge_section(Some(&base), &patch));
        changed.push("positivePayConfig");
    }
    if let Some(settings) = check_settings {
        set.insert("check_settings".to_owned(), settings);
    }

    if let Some(ach) = &input.ach_settings {
        let mut patch = ach.clone();
        if let Some(ein) = patch.remove("ein") {
            let Some(id) = ein.as_str().and_then(company_id_from_ein) else {
                return Err(run_error(
                    "INVALID_EIN",
                    "The EIN is 9 digits".to_owned(),
                    400,
                    None,
                ));
            };
            patch.insert("companyIdentification".to_owned(), json!(id));
        }
        if let Some(offset_id) = patch.get("offsetBankAccountId").and_then(Value::as_str)
            && offset_id != bank_id
        {
            let offset = load_bank_account(db, entity_id, offset_id).await?;
            if !truthy(&offset, "routingNumber") || !truthy(&offset, "accountNumberEncrypted") {
                return Err(run_error(
                    "OFFSET_ACCOUNT_INCOMPLETE",
                    format!(
                        "{} needs a routing number and an account number to be the offset account.",
                        text(&offset, "name").unwrap_or_default()
                    ),
                    400,
                    None,
                ));
            }
        }
        set.insert(
            "ach_settings".to_owned(),
            merge_section(bank.get("achSettings"), &patch),
        );
        changed.push("achSettings");
    }

    if !input.positive_pay_format.is_absent() {
        set.insert(
            "positive_pay_format".to_owned(),
            input
                .positive_pay_format
                .as_set()
                .map_or(Value::Null, |f| json!(f)),
        );
        changed.push("positivePayFormat");
    }

    let updated = BANK_ACCOUNTS.patch_raw(db, &bank_id, set, false).await?;
    let view = settings_view(db, updated.as_ref().unwrap_or(&bank)).await?;
    Ok((view, changed))
}
