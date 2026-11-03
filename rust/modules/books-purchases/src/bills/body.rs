//! `createBillSchema` (`.partial()` for an update) and its parts: the
//! address shapes, Brazil's fiscal schemas (`lib/br-fiscal-schemas`), the
//! exchange rate (`lib/exchange-rate-schema`) and the line items.

use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};

/// `lineItemSchema` as Zod let it through (defaults filled in).
#[derive(Debug, Clone, Default)]
pub(crate) struct BillLine {
    pub description: String,
    pub quantity: String,
    pub unit_price: String,
    pub unit: Option<String>,
    pub discount_percent: String,
    pub tax_rate_id: Option<String>,
    pub tax_rate: Option<String>,
    pub account_id: Option<String>,
    pub sort_order: Option<f64>,
    pub product_id: Option<String>,
    pub tax_code: Option<String>,
    pub accrue_use_tax: Option<bool>,
    pub form_1099_box: Option<String>,
    pub ncm: Option<String>,
    pub cfop: Option<String>,
    pub fiscal_data: Option<Value>,
    pub class_id: Option<String>,
    pub location_id: Option<String>,
}

/// `createBillSchema` (`.partial()`): what the route reads.
#[derive(Debug, Clone, Default)]
pub(crate) struct BillBody {
    pub entity_id: Option<String>,
    pub bill_number: Option<String>,
    pub contact_id: Option<String>,
    pub contact_name: Option<String>,
    pub issue_date: Option<String>,
    pub due_date: Option<String>,
    pub currency: Option<String>,
    /// `String(value).trim()`; `Null` looks the rate up again.
    pub exchange_rate: Field<String>,
    pub external_reference: Option<String>,
    pub reference: Option<String>,
    pub notes: Option<String>,
    pub internal_notes: Option<String>,
    pub expense_account_id: Option<String>,
    pub vendor_address: Field<Value>,
    pub delivery_address: Field<Value>,
    pub fiscal_data: Field<Value>,
    pub source_document_id: Option<String>,
    /// `[]` on create when left out; `None` on an update that sends none.
    pub items: Option<Vec<BillLine>>,
}

/// A string `.trim().regex(re, message)` (Zod checks the trimmed value).
fn trimmed_pattern(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
    max: Option<usize>,
    matches: impl Fn(&str) -> bool,
    message: &str,
) -> Field<String> {
    match issues.text_with(body, key, presence, Text::trimmed(None, max)) {
        Field::Set(value) if !matches(&value) => {
            issues.issue_at(
                key,
                json!({ "validation": "regex", "code": "invalid_string", "message": message }),
            );
            Field::Absent
        }
        other => other,
    }
}

fn digits(value: &str, n: usize) -> bool {
    value.len() == n && value.bytes().all(|b| b.is_ascii_digit())
}

/// `.strict()`: one `unrecognized_keys` issue at the object's path.
fn strict(issues: &mut Issues, fields: &Map<String, Value>, known: &[&str]) {
    let extra: Vec<&String> = fields
        .keys()
        .filter(|k| !known.contains(&k.as_str()))
        .collect();
    if extra.is_empty() {
        return;
    }
    let mut path = issues.path_of("x");
    if let Value::Array(parts) = &mut path {
        parts.pop();
    }
    let listed = extra
        .iter()
        .map(|k| format!("'{k}'"))
        .collect::<Vec<_>>()
        .join(", ");
    issues.push_raw(json!({
        "code": "unrecognized_keys",
        "keys": extra,
        "path": path,
        "message": format!("Unrecognized key(s) in object: {listed}"),
    }));
}

fn insert<T: Into<Value>>(out: &mut Map<String, Value>, key: &str, field: Field<T>) {
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

fn percent(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    max: f64,
    presence: Presence,
) -> Field<Value> {
    match issues.number(
        fields,
        key,
        presence,
        Number {
            min: Some(0.0),
            max: Some(max),
            ..Number::default()
        },
    ) {
        Field::Set(n) => Field::Set(weldsuite_books_domain::js::number_value(n)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    }
}

/// `brLineFiscalSchema` (`.strict().nullable().optional()`).
fn line_fiscal(issues: &mut Issues, body: &Map<String, Value>) -> Field<Value> {
    const KEYS: [&str; 9] = [
        "cest",
        "origin",
        "icmsRate",
        "ipiRate",
        "issRate",
        "serviceCode",
        "nbs",
        "ibsCbsCst",
        "cClassTrib",
    ];
    issues.nested(body, "fiscalData", Presence::Nullish, |issues, fields| {
        let optional = Presence::Optional;
        let mut out = Map::new();
        let cest = trimmed_pattern(
            issues,
            fields,
            "cest",
            optional,
            None,
            |v| digits(v, 7),
            "CEST must be 7 digits",
        );
        insert(&mut out, "cest", cest);
        let origin = issues.choice(
            fields,
            "origin",
            optional,
            &["0", "1", "2", "3", "4", "5", "6", "7", "8"],
        );
        insert(&mut out, "origin", origin);
        let icms = percent(issues, fields, "icmsRate", 100.0, optional);
        insert(&mut out, "icmsRate", icms);
        let ipi = percent(issues, fields, "ipiRate", 100.0, optional);
        insert(&mut out, "ipiRate", ipi);
        let iss = percent(issues, fields, "issRate", 5.0, optional);
        insert(&mut out, "issRate", iss);
        for (key, max) in [
            ("serviceCode", 10),
            ("nbs", 12),
            ("ibsCbsCst", 3),
            ("cClassTrib", 6),
        ] {
            let value = issues.text_with(fields, key, optional, Text::trimmed(None, Some(max)));
            insert(&mut out, key, value);
        }
        strict(issues, fields, &KEYS);
        Value::Object(out)
    })
}

/// `brDocumentFiscalSchema` (`.strict().nullable().optional()`).
fn document_fiscal(issues: &mut Issues, body: &Map<String, Value>) -> Field<Value> {
    const KEYS: [&str; 6] = [
        "withholdings",
        "finalConsumer",
        "buyerIcmsContributor",
        "counterpartySimples",
        "naturezaOperacao",
        "accessKey",
    ];
    issues.nested(body, "fiscalData", Presence::Nullish, |issues, fields| {
        let optional = Presence::Optional;
        let mut out = Map::new();
        let withholdings = issues.nested(fields, "withholdings", optional, |issues, w| {
            let nullish = Presence::Nullish;
            let mut out = Map::new();
            insert(&mut out, "iss", percent(issues, w, "iss", 5.0, nullish));
            let irrf = percent(issues, w, "irrf", 27.5, nullish);
            insert(&mut out, "irrf", irrf);
            let csrf = issues.boolean(w, "csrf", nullish);
            insert(&mut out, "csrf", csrf);
            insert(&mut out, "inss", percent(issues, w, "inss", 20.0, nullish));
            strict(issues, w, &["iss", "irrf", "csrf", "inss"]);
            Value::Object(out)
        });
        insert(&mut out, "withholdings", withholdings);
        for key in [
            "finalConsumer",
            "buyerIcmsContributor",
            "counterpartySimples",
        ] {
            let flag = issues.boolean(fields, key, optional);
            insert(&mut out, key, flag);
        }
        let natureza = issues.text_with(
            fields,
            "naturezaOperacao",
            optional,
            Text::trimmed(None, Some(60)),
        );
        insert(&mut out, "naturezaOperacao", natureza);
        let key = trimmed_pattern(
            issues,
            fields,
            "accessKey",
            optional,
            None,
            |v| digits(v, 44),
            "The access key has 44 digits",
        );
        insert(&mut out, "accessKey", key);
        strict(issues, fields, &KEYS);
        Value::Object(out)
    })
}

/// `addressSchema`: every field an optional string (`.nullable().optional()` on the bill).
fn address(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Field<Value> {
    issues.nested(body, key, Presence::Nullish, |issues, fields| {
        let mut out = Map::new();
        for name in [
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
            let value = issues.text(fields, name, Presence::Optional, None, None);
            insert(&mut out, name, value);
        }
        Value::Object(out)
    })
}

fn line(issues: &mut Issues, item: &Value) -> Option<BillLine> {
    let fields = issues.object(item)?;
    let optional = Presence::Optional;
    let nullish = Presence::Nullish;
    let text = |issues: &mut Issues, key: &str, presence: Presence, max: Option<usize>| {
        issues.text(fields, key, presence, None, max).into_option()
    };
    let before = issues.count();
    let description = issues.text(fields, "description", Presence::Required, Some(1), None);
    let quantity = text(issues, "quantity", optional, None);
    let unit_price = issues.text(fields, "unitPrice", Presence::Required, None, None);
    let unit = text(issues, "unit", optional, Some(20));
    let discount = text(issues, "discountPercent", optional, None);
    let tax_rate_id = text(issues, "taxRateId", nullish, Some(30));
    let tax_rate = text(issues, "taxRate", optional, None);
    let account_id = text(issues, "accountId", nullish, Some(30));
    let sort_order = issues
        .number(fields, "sortOrder", optional, Number::default())
        .into_option();
    let product_id = text(issues, "productId", nullish, Some(30));
    let tax_code = text(issues, "taxCode", nullish, Some(30));
    let accrue = issues
        .boolean(fields, "accrueUseTax", optional)
        .into_option();
    let box_code = text(issues, "form1099Box", nullish, Some(20));
    let ncm = trimmed_pattern(
        issues,
        fields,
        "ncm",
        nullish,
        None,
        |v| v.is_empty() || digits(v, 8),
        "NCM must be 8 digits",
    )
    .into_option();
    let cfop = trimmed_pattern(
        issues,
        fields,
        "cfop",
        nullish,
        None,
        |v| v.is_empty() || (digits(v, 4) && (b'1'..=b'7').contains(&v.as_bytes()[0])),
        "CFOP must be 4 digits",
    )
    .into_option();
    let fiscal = line_fiscal(issues, fields).into_option();
    let class_id = text(issues, "classId", nullish, Some(30));
    let location_id = text(issues, "locationId", nullish, Some(30));
    if issues.count() > before {
        return None;
    }
    Some(BillLine {
        description: description.into_option()?,
        quantity: quantity.unwrap_or_else(|| "1".to_owned()),
        unit_price: unit_price.into_option()?,
        unit,
        discount_percent: discount.unwrap_or_else(|| "0".to_owned()),
        tax_rate_id,
        tax_rate,
        account_id,
        sort_order,
        product_id,
        tax_code,
        accrue_use_tax: accrue,
        form_1099_box: box_code,
        ncm,
        cfop,
        fiscal_data: fiscal,
        class_id,
        location_id,
    })
}

/// `createBillSchema`, or its `.partial()`.
pub(crate) fn read_bill(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> BillBody {
    let optional = Presence::Optional;
    let required = if partial {
        optional
    } else {
        Presence::Required
    };
    let text =
        |issues: &mut Issues,
         key: &str,
         presence: Presence,
         min: Option<usize>,
         max: Option<usize>| { issues.text(body, key, presence, min, max).into_option() };
    let mut bill = BillBody {
        entity_id: text(issues, "entityId", optional, None, Some(30)),
        bill_number: text(issues, "billNumber", optional, None, Some(50)),
        contact_id: text(issues, "contactId", required, Some(1), None),
        contact_name: text(issues, "contactName", optional, None, None),
        issue_date: text(issues, "issueDate", required, None, None),
        due_date: text(issues, "dueDate", required, None, None),
        ..BillBody::default()
    };
    bill.currency = match issues.text(body, "currency", optional, None, None) {
        Field::Set(code) => {
            let length = code.encode_utf16().count();
            issues.string_length("currency", 3, length);
            (length == 3).then_some(code)
        }
        _ => None,
    };
    // `z.union([z.string(), z.number()]).transform(trim).refine(...)`: the
    // refinement settles after every synchronous check.
    let mut rate_refused = false;
    bill.exchange_rate = match issues.string_or_number(body, "exchangeRate", Presence::Nullish) {
        Field::Set(value) => {
            let text = match &value {
                Value::Number(n) => {
                    weldsuite_books_domain::js::number_text(n.as_f64().unwrap_or(f64::NAN))
                }
                other => weldsuite_books_domain::jurisdictions::js_trim(
                    other.as_str().unwrap_or_default(),
                )
                .to_owned(),
            };
            let n = weldsuite_kit::validation::js_number(&text);
            if text.is_empty() || !n.is_finite() || n <= 0.0 {
                rate_refused = true;
                Field::Absent
            } else {
                Field::Set(text)
            }
        }
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    };
    bill.external_reference = text(issues, "externalReference", optional, None, Some(255));
    bill.reference = text(issues, "reference", optional, None, Some(255));
    bill.notes = text(issues, "notes", optional, None, None);
    bill.internal_notes = text(issues, "internalNotes", optional, None, None);
    bill.expense_account_id = text(issues, "expenseAccountId", optional, None, Some(30));
    bill.vendor_address = address(issues, body, "vendorAddress");
    bill.delivery_address = address(issues, body, "deliveryAddress");
    bill.fiscal_data = document_fiscal(issues, body);
    bill.source_document_id = text(issues, "sourceDocumentId", optional, None, Some(30));
    bill.items = match issues.list(body, "items", optional, None, None, line) {
        Field::Set(items) => Some(items),
        _ if !partial && !body.contains_key("items") => Some(Vec::new()),
        _ => None,
    };
    if rate_refused {
        issues.custom(
            "exchangeRate",
            "The exchange rate must be a number above zero",
        );
    }
    bill
}
