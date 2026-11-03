//! The request schemas of the invoice routes (`routes/invoices/index.ts`,
//! `lib/br-fiscal-schemas.ts`, `lib/exchange-rate-schema.ts`), read in Zod's
//! field order with the values Zod outputs (defaults applied, strings
//! trimmed where the schema trims, unknown keys of an object dropped).

use serde_json::{Map, Value, json};
use weldsuite_books_domain::js;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};

/// `z.string().trim().regex(re, message)` with `presence`: the trimmed
/// value, or the regex issue.
pub(crate) fn trimmed_pattern(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
    max: Option<usize>,
    matches: impl Fn(&str) -> bool,
    message: &str,
) -> Field<String> {
    let field = issues.text_with(body, key, presence, Text::trimmed(None, max));
    if let Field::Set(text) = &field
        && !matches(text)
    {
        issues.push_issue(
            key,
            json!({ "validation": "regex", "code": "invalid_string", "message": message }),
        );
        return Field::Absent;
    }
    field
}

fn digits(text: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
}

/// `.strict()`: the keys the schema doesn't know, as Zod reports them (after
/// the fields).
fn strict(issues: &mut Issues, body: &Map<String, Value>, known: &[&str]) {
    let extra: Vec<&String> = body
        .keys()
        .filter(|k| !known.contains(&k.as_str()))
        .collect();
    if extra.is_empty() {
        return;
    }
    let listed = extra
        .iter()
        .map(|k| format!("'{k}'"))
        .collect::<Vec<_>>()
        .join(", ");
    issues.issue_here(json!({
        "code": "unrecognized_keys",
        "keys": extra,
        "message": format!("Unrecognized key(s) in object: {listed}"),
    }));
}

fn put<T: Into<Value>>(out: &mut Map<String, Value>, key: &str, field: Field<T>) {
    match field {
        Field::Set(value) => {
            out.insert(key.to_owned(), value.into());
        }
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
}

fn put_number(out: &mut Map<String, Value>, key: &str, field: &Field<f64>) {
    match *field {
        Field::Set(value) => {
            out.insert(key.to_owned(), js::number_value(value));
        }
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
}

/// `ncmSchema`.
pub(crate) fn ncm(issues: &mut Issues, body: &Map<String, Value>) -> Field<String> {
    trimmed_pattern(
        issues,
        body,
        "ncm",
        Presence::Nullish,
        None,
        |t| t.is_empty() || digits(t, 8, 8),
        "NCM must be 8 digits",
    )
}

/// `cfopSchema`.
pub(crate) fn cfop(issues: &mut Issues, body: &Map<String, Value>) -> Field<String> {
    trimmed_pattern(
        issues,
        body,
        "cfop",
        Presence::Nullish,
        None,
        |t| t.is_empty() || (digits(t, 4, 4) && (b'1'..=b'7').contains(&t.as_bytes()[0])),
        "CFOP must be 4 digits",
    )
}

/// `brLineFiscalSchema` (strict, nullish): the parsed object.
pub(crate) fn br_line_fiscal(issues: &mut Issues, body: &Map<String, Value>) -> Field<Value> {
    let percent = Number {
        min: Some(0.0),
        max: Some(100.0),
        ..Number::default()
    };
    issues.nested(body, "fiscalData", Presence::Nullish, |issues, fields| {
        let mut out = Map::new();
        let cest = trimmed_pattern(
            issues,
            fields,
            "cest",
            Presence::Optional,
            None,
            |t| digits(t, 7, 7),
            "CEST must be 7 digits",
        );
        put(&mut out, "cest", cest);
        let origin = issues.choice(
            fields,
            "origin",
            Presence::Optional,
            &["0", "1", "2", "3", "4", "5", "6", "7", "8"],
        );
        put(&mut out, "origin", origin);
        let icms = issues.number(fields, "icmsRate", Presence::Optional, percent);
        put_number(&mut out, "icmsRate", &icms);
        let ipi = issues.number(fields, "ipiRate", Presence::Optional, percent);
        put_number(&mut out, "ipiRate", &ipi);
        let iss = issues.number(
            fields,
            "issRate",
            Presence::Optional,
            Number {
                min: Some(0.0),
                max: Some(5.0),
                ..Number::default()
            },
        );
        put_number(&mut out, "issRate", &iss);
        for (key, max) in [
            ("serviceCode", 10),
            ("nbs", 12),
            ("ibsCbsCst", 3),
            ("cClassTrib", 6),
        ] {
            let value = issues.text_with(
                fields,
                key,
                Presence::Optional,
                Text::trimmed(None, Some(max)),
            );
            put(&mut out, key, value);
        }
        strict(
            issues,
            fields,
            &[
                "cest",
                "origin",
                "icmsRate",
                "ipiRate",
                "issRate",
                "serviceCode",
                "nbs",
                "ibsCbsCst",
                "cClassTrib",
            ],
        );
        Value::Object(out)
    })
}

/// `brDocumentFiscalSchema` (strict, nullish): the parsed object.
pub(crate) fn br_document_fiscal(issues: &mut Issues, body: &Map<String, Value>) -> Field<Value> {
    issues.nested(body, "fiscalData", Presence::Nullish, |issues, fields| {
        let mut out = Map::new();
        let withholdings =
            issues.nested(fields, "withholdings", Presence::Optional, |issues, w| {
                let mut out = Map::new();
                for (key, max) in [("iss", 5.0), ("irrf", 27.5)] {
                    let value = issues.number(
                        w,
                        key,
                        Presence::Nullish,
                        Number {
                            min: Some(0.0),
                            max: Some(max),
                            ..Number::default()
                        },
                    );
                    put_number(&mut out, key, &value);
                }
                let csrf = issues.boolean(w, "csrf", Presence::Nullish);
                put(&mut out, "csrf", csrf);
                let inss = issues.number(
                    w,
                    "inss",
                    Presence::Nullish,
                    Number {
                        min: Some(0.0),
                        max: Some(20.0),
                        ..Number::default()
                    },
                );
                put_number(&mut out, "inss", &inss);
                strict(issues, w, &["iss", "irrf", "csrf", "inss"]);
                Value::Object(out)
            });
        put(&mut out, "withholdings", withholdings);
        for key in [
            "finalConsumer",
            "buyerIcmsContributor",
            "counterpartySimples",
        ] {
            let flag = issues.boolean(fields, key, Presence::Optional);
            put(&mut out, key, flag);
        }
        let natureza = issues.text_with(
            fields,
            "naturezaOperacao",
            Presence::Optional,
            Text::trimmed(None, Some(60)),
        );
        put(&mut out, "naturezaOperacao", natureza);
        let access_key = trimmed_pattern(
            issues,
            fields,
            "accessKey",
            Presence::Optional,
            None,
            |t| digits(t, 44, 44),
            "The access key has 44 digits",
        );
        put(&mut out, "accessKey", access_key);
        strict(
            issues,
            fields,
            &[
                "withholdings",
                "finalConsumer",
                "buyerIcmsContributor",
                "counterpartySimples",
                "naturezaOperacao",
                "accessKey",
            ],
        );
        Value::Object(out)
    })
}

/// `exchangeRateSchema` (`.nullable().optional()`): the trimmed text, or
/// `Null`. A value that fails the refinement is returned as `Err(())` so the
/// caller reports it after the other fields (`custom`).
pub(crate) fn exchange_rate(
    issues: &mut Issues,
    body: &Map<String, Value>,
) -> (Field<String>, bool) {
    match issues.string_or_number(body, "exchangeRate", Presence::Nullish) {
        Field::Set(value) => {
            let text = match &value {
                Value::String(text) => weldsuite_kit::validation::js_trim(text).to_owned(),
                Value::Number(n) => js::number_text(n.as_f64().unwrap_or(f64::NAN)),
                _ => String::new(),
            };
            let number = weldsuite_kit::validation::js_number(&text);
            let ok = !text.is_empty() && number.is_finite() && number > 0.0;
            (if ok { Field::Set(text) } else { Field::Absent }, !ok)
        }
        Field::Null => (Field::Null, false),
        Field::Absent => (Field::Absent, false),
    }
}

/// `exchangeRateSchema`'s message.
pub(crate) const EXCHANGE_RATE_MESSAGE: &str = "The exchange rate must be a number above zero";

/// `addressSchema`: the known keys that are strings.
pub(crate) fn address(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Field<Value> {
    issues.nested(body, key, Presence::Nullish, |issues, fields| {
        let mut out = Map::new();
        for field in [
            "line1",
            "line2",
            "city",
            "state",
            "postalCode",
            "country",
            "county",
            "street",
            "houseNumber",
            "province",
        ] {
            let value = issues.text(fields, field, Presence::Optional, None, None);
            put(&mut out, field, value);
        }
        Value::Object(out)
    })
}

/// One line of `lineItemSchema`, as Zod outputs it.
#[derive(Debug, Clone, Default)]
pub(crate) struct LineInput {
    pub description: String,
    /// `.default('1')`.
    pub quantity: String,
    pub unit_price: String,
    pub unit: Option<String>,
    /// `.default('0')`.
    pub discount_percent: String,
    pub tax_rate_id: Option<String>,
    pub tax_rate: Option<String>,
    pub account_id: Option<String>,
    pub product_id: Option<String>,
    pub period: Option<Value>,
    pub sort_order: Option<f64>,
    pub tax_code: Option<String>,
    pub hsn_sac: Option<String>,
    pub ncm: Option<String>,
    pub cfop: Option<String>,
    pub fiscal_data: Option<Value>,
    pub tax_use: Option<String>,
    pub tax_included: Option<bool>,
    pub tax_override_amount: Option<String>,
    pub tax_override_reason: Option<String>,
    pub class_id: Option<String>,
    pub location_id: Option<String>,
    pub original_line_id: Option<String>,
}

fn id_field(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Option<String> {
    issues
        .text(body, key, Presence::Nullish, None, Some(30))
        .into_option()
}

pub(crate) fn read_line(issues: &mut Issues, item: &Value) -> Option<LineInput> {
    let fields = issues.object(item)?;
    let description = issues.text(fields, "description", Presence::Required, Some(1), None);
    let quantity = issues.text(fields, "quantity", Presence::Optional, None, None);
    let unit_price = issues.text(fields, "unitPrice", Presence::Required, None, None);
    let unit = issues.text(fields, "unit", Presence::Optional, None, Some(20));
    let discount = issues.text(fields, "discountPercent", Presence::Optional, None, None);
    let tax_rate_id = id_field(issues, fields, "taxRateId");
    let tax_rate = issues.text(fields, "taxRate", Presence::Optional, None, None);
    let account_id = id_field(issues, fields, "accountId");
    let product_id = id_field(issues, fields, "productId");
    let period = issues.nested(fields, "period", Presence::Optional, |issues, p| {
        let mut out = Map::new();
        for key in ["from", "to"] {
            let value = issues.text(p, key, Presence::Optional, None, None);
            put(&mut out, key, value);
        }
        Value::Object(out)
    });
    let sort_order = issues.number(fields, "sortOrder", Presence::Optional, Number::default());
    let tax_code = id_field(issues, fields, "taxCode");
    let hsn_sac = trimmed_pattern(
        issues,
        fields,
        "hsnSac",
        Presence::Nullish,
        None,
        |t| t.is_empty() || digits(t, 4, 8),
        "HSN/SAC must be 4 to 8 digits",
    );
    let ncm = ncm(issues, fields);
    let cfop = cfop(issues, fields);
    let fiscal = br_line_fiscal(issues, fields);
    let tax_use = issues.choice(
        fields,
        "taxUse",
        Presence::Nullish,
        &["business", "personal"],
    );
    let tax_included = issues.boolean(fields, "taxIncluded", Presence::Optional);
    let override_amount = issues.string_or_number(fields, "taxOverrideAmount", Presence::Nullish);
    let override_reason = issues.text(
        fields,
        "taxOverrideReason",
        Presence::Nullish,
        None,
        Some(255),
    );
    let class_id = id_field(issues, fields, "classId");
    let location_id = id_field(issues, fields, "locationId");
    let original_line_id = id_field(issues, fields, "originalLineId");
    Some(LineInput {
        description: description.into_option()?,
        quantity: quantity.into_option().unwrap_or_else(|| "1".into()),
        unit_price: unit_price.into_option()?,
        unit: unit.into_option(),
        discount_percent: discount.into_option().unwrap_or_else(|| "0".into()),
        tax_rate_id,
        tax_rate: tax_rate.into_option(),
        account_id,
        product_id,
        period: period.into_option(),
        sort_order: sort_order.into_option(),
        tax_code,
        hsn_sac: hsn_sac.into_option(),
        ncm: ncm.into_option(),
        cfop: cfop.into_option(),
        fiscal_data: fiscal.into_option(),
        tax_use: tax_use.into_option(),
        tax_included: tax_included.into_option(),
        tax_override_amount: override_amount.into_option().map(|v| match v {
            Value::String(text) => text,
            Value::Number(n) => js::number_text(n.as_f64().unwrap_or(f64::NAN)),
            other => other.to_string(),
        }),
        tax_override_reason: override_reason.into_option(),
        class_id,
        location_id,
        original_line_id,
    })
}

/// `invoiceStatusSchema`.
pub(crate) const INVOICE_STATUSES: [&str; 8] = [
    "draft",
    "sent",
    "paid",
    "overdue",
    "partial",
    "cancelled",
    "uncollectible",
    "finalized",
];

/// `createInvoiceSchema` / `updateInvoiceSchema` (the create schema without
/// `status`, every field optional) as Zod outputs them.
#[derive(Debug, Clone, Default)]
pub(crate) struct InvoiceInput {
    /// Create: `.default('standard')`; update: absent stays absent.
    pub kind: Option<String>,
    pub status: Option<String>,
    pub contact_id: Option<String>,
    pub contact_name: Option<String>,
    pub contact_email: Option<String>,
    pub issue_date: Option<String>,
    pub due_date: Option<String>,
    pub currency: Option<String>,
    pub exchange_rate: Field<String>,
    pub payment_terms_days: Option<f64>,
    pub reference: Option<String>,
    pub notes: Option<String>,
    pub internal_notes: Option<String>,
    pub billing_address: Field<Value>,
    pub shipping_address: Field<Value>,
    pub ship_from_address: Field<Value>,
    pub place_of_supply: Field<String>,
    pub fiscal_data: Field<Value>,
    pub marketplace_facilitated: Option<bool>,
    pub revenue_account_id: Option<String>,
    pub credit_note_for_invoice_id: Option<String>,
    pub template_id: Field<String>,
    pub items: Option<Vec<LineInput>>,
}

/// Reads the invoice body; `partial` is the update schema.
pub(crate) fn read_invoice(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> InvoiceInput {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let kind = issues.choice(
        body,
        "type",
        Presence::Optional,
        &["standard", "credit_note", "proforma", "correction"],
    );
    let status = if partial {
        Field::Absent
    } else {
        issues.choice(body, "status", Presence::Optional, &INVOICE_STATUSES)
    };
    let contact_id = issues.text(body, "contactId", required, Some(1), None);
    let contact_name = issues.text(body, "contactName", Presence::Optional, None, None);
    let contact_email = issues.text(body, "contactEmail", Presence::Optional, None, None);
    let issue_date = issues.text(body, "issueDate", required, None, None);
    let due_date = issues.text(body, "dueDate", required, None, None);
    let currency = read_currency(issues, body);
    let (exchange_rate, bad_rate) = exchange_rate(issues, body);
    let terms = issues.number(
        body,
        "paymentTermsDays",
        Presence::Optional,
        Number::default(),
    );
    let reference = issues.text(body, "reference", Presence::Optional, None, Some(255));
    let notes = issues.text(body, "notes", Presence::Optional, None, None);
    let internal_notes = issues.text(body, "internalNotes", Presence::Optional, None, None);
    let billing = address(issues, body, "billingAddress");
    let shipping = address(issues, body, "shippingAddress");
    let ship_from = address(issues, body, "shipFromAddress");
    let place = issues.pattern(
        body,
        "placeOfSupply",
        Presence::Nullish,
        None,
        None,
        |t| digits(t, 2, 2),
        "Place of supply is a two-digit GST state code",
    );
    let fiscal = br_document_fiscal(issues, body);
    let marketplace = issues.boolean(body, "marketplaceFacilitated", Presence::Optional);
    let revenue = issues.text(body, "revenueAccountId", Presence::Optional, None, Some(30));
    let credit_for = issues.text(
        body,
        "creditNoteForInvoiceId",
        Presence::Optional,
        None,
        Some(30),
    );
    let template = issues.text(body, "templateId", Presence::Nullish, None, Some(30));
    let items = issues.list(body, "items", required, Some(1), None, read_line);
    if bad_rate {
        issues.custom("exchangeRate", EXCHANGE_RATE_MESSAGE);
    }
    InvoiceInput {
        kind: kind
            .into_option()
            .or_else(|| (!partial).then(|| "standard".to_owned())),
        status: status.into_option(),
        contact_id: contact_id.into_option(),
        contact_name: contact_name.into_option(),
        contact_email: contact_email.into_option(),
        issue_date: issue_date.into_option(),
        due_date: due_date.into_option(),
        currency,
        exchange_rate,
        payment_terms_days: terms.into_option(),
        reference: reference.into_option(),
        notes: notes.into_option(),
        internal_notes: internal_notes.into_option(),
        billing_address: billing,
        shipping_address: shipping,
        ship_from_address: ship_from,
        place_of_supply: place,
        fiscal_data: fiscal,
        marketplace_facilitated: marketplace.into_option(),
        revenue_account_id: revenue.into_option(),
        credit_note_for_invoice_id: credit_for.into_option(),
        template_id: template,
        items: items.into_option(),
    }
}

/// `z.string().length(3).optional()`.
pub(crate) fn read_currency(issues: &mut Issues, body: &Map<String, Value>) -> Option<String> {
    match body.get("currency") {
        Some(Value::String(text)) => {
            let length = text.encode_utf16().count();
            if length == 3 {
                Some(text.clone())
            } else {
                issues.string_length("currency", 3, length);
                None
            }
        }
        _ => issues
            .text(body, "currency", Presence::Optional, None, None)
            .into_option(),
    }
}

/// `recordPaymentSchema`.
#[derive(Debug, Clone, Default)]
pub(crate) struct RecordPaymentInput {
    pub amount: String,
    pub date: String,
    pub payment_method: Option<String>,
    pub check_number: Option<String>,
    pub reference: Option<String>,
    pub bank_account_id: Option<String>,
    pub deposit_to: Option<String>,
    pub notes: Option<String>,
    pub exchange_rate: Option<String>,
}

pub(crate) fn read_record_payment(
    issues: &mut Issues,
    body: &Map<String, Value>,
) -> Option<RecordPaymentInput> {
    let amount = issues.text(body, "amount", Presence::Required, None, None);
    let date = issues.text(body, "date", Presence::Required, None, None);
    let method = issues.text(body, "paymentMethod", Presence::Optional, None, Some(30));
    let check = issues.text(body, "checkNumber", Presence::Optional, None, Some(30));
    let reference = issues.text(body, "reference", Presence::Optional, None, None);
    let bank = issues.text(body, "bankAccountId", Presence::Optional, None, None);
    let deposit = issues.choice(
        body,
        "depositTo",
        Presence::Optional,
        &["undeposited_funds", "bank"],
    );
    let notes = issues.text(body, "notes", Presence::Optional, None, None);
    let (rate, bad_rate) = exchange_rate(issues, body);
    if bad_rate {
        issues.custom("exchangeRate", EXCHANGE_RATE_MESSAGE);
    }
    Some(RecordPaymentInput {
        amount: amount.into_option()?,
        date: date.into_option()?,
        payment_method: method.into_option(),
        check_number: check.into_option(),
        reference: reference.into_option(),
        bank_account_id: bank.into_option(),
        deposit_to: deposit.into_option(),
        notes: notes.into_option(),
        exchange_rate: rate.into_option(),
    })
}
