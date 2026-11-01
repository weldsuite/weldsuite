//! The contact create and update bodies: `normalizeContactPayload` (the
//! platform's field names and blank inputs) and `createContactSchema`
//! (`.partial()` for an update), read in the schema's order, failures in
//! the route's own `{ error: { code, message } }` shape.

use serde_json::{Map, Value};
use weldsuite_books_domain::vendor_tax::{DEFAULT_BOX_MESSAGE, VendorTaxInput, read_vendor_tax};
use weldsuite_kit::validation::{Field, Format, Invalid, Issues, Number, Presence, Text};

/// Fields a blank string clears on update (sent as null).
const CLEARABLE_FIELDS: [&str; 16] = [
    "email",
    "phone",
    "vatNumber",
    "taxNumber",
    "registrationNumber",
    "kvkNumber",
    "iban",
    "bic",
    "notes",
    "defaultRevenueAccountId",
    "defaultExpenseAccountId",
    "achRoutingNumber",
    "default1099Box",
    "default1099Form",
    "taxUse",
    "achAccountType",
];

/// `[alias, field]`: the platform's names onto the schema's.
const FIELD_ALIASES: [(&str, &str); 3] = [
    ("name", "fullName"),
    ("taxNumber", "vatNumber"),
    ("kvkNumber", "registrationNumber"),
];

fn is_blank(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| weldsuite_books_domain::jurisdictions::js_trim(s).is_empty())
}

/// `blanksToNull(contactPerson)`: blank inputs are cleared values, a blank
/// `personId` means a new person.
fn blanks_to_null(input: &Map<String, Value>) -> Map<String, Value> {
    let mut body = Map::new();
    for (key, value) in input {
        let blank = is_blank(value);
        if blank && key == "personId" {
            continue;
        }
        body.insert(key.clone(), if blank { Value::Null } else { value.clone() });
    }
    body
}

/// `normalizeContactPayload(input, mode)`.
pub(crate) fn normalize(input: &Value, update: bool) -> Value {
    let Value::Object(fields) = input else {
        return input.clone();
    };
    let mut body = Map::new();
    for (key, value) in fields {
        if key == "contactPerson"
            && let Value::Object(person) = value
        {
            body.insert(key.clone(), Value::Object(blanks_to_null(person)));
            continue;
        }
        if is_blank(value) {
            if update && CLEARABLE_FIELDS.contains(&key.as_str()) {
                body.insert(key.clone(), Value::Null);
            }
            continue;
        }
        body.insert(key.clone(), value.clone());
    }
    for (alias, field) in FIELD_ALIASES {
        if !body.contains_key(field)
            && let Some(value) = body.get(alias).cloned()
        {
            body.insert(field.to_owned(), value);
        }
        body.remove(alias);
    }
    Value::Object(body)
}

/// `contactPersonSchema`.
#[derive(Debug, Clone, Default)]
pub(crate) struct ContactPersonInput {
    pub person_id: Option<String>,
    pub first_name: Field<String>,
    pub last_name: Field<String>,
    pub email: Field<String>,
    pub phone: Field<String>,
}

/// `z.infer<typeof updateContactBody>`: what the schema let through.
#[derive(Debug, Clone, Default)]
pub(crate) struct ContactPayload {
    pub role: Option<String>,
    pub kind: Option<String>,
    pub company_id: Option<String>,
    pub person_id: Option<String>,
    pub contact_person: Field<ContactPersonInput>,
    pub full_name: Option<String>,
    pub company_name: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub email: Field<String>,
    pub phone: Field<String>,
    pub vat_number: Field<String>,
    pub registration_number: Field<String>,
    pub iban: Field<String>,
    pub bic: Field<String>,
    pub billing_address: Field<Value>,
    pub shipping_address: Field<Value>,
    pub payment_terms_days: Field<i64>,
    pub currency: Option<String>,
    pub default_revenue_account_id: Field<String>,
    pub default_expense_account_id: Field<String>,
    pub crm_customer_id: Option<String>,
    pub crm_contact_id: Option<String>,
    pub credit_limit: Option<String>,
    pub notes: Field<String>,
    pub tags: Option<Vec<String>>,
    pub sepa_mandate: Field<Value>,
    pub metadata: Option<Value>,
    pub br_fiscal: Field<Map<String, Value>>,
    pub link_person_id: Option<String>,
    pub create_separate_person: Option<bool>,
    pub tax: VendorTaxInput,
}

/// A field's value as the route reads `data[key]`: `None` is `undefined`.
fn defined<T: Clone + Into<Value>>(field: &Field<T>) -> Option<Value> {
    match field {
        Field::Absent => None,
        Field::Null => Some(Value::Null),
        Field::Set(value) => Some(value.clone().into()),
    }
}

impl ContactPayload {
    /// `data[key] !== undefined`, for the identity fields and the audit.
    pub(crate) fn value_of(&self, key: &str) -> Option<Value> {
        let text = |v: &Option<String>| v.clone().map(Value::String);
        let tax = &self.tax;
        match key {
            "role" => text(&self.role),
            "kind" => text(&self.kind),
            "companyId" => text(&self.company_id),
            "personId" => text(&self.person_id),
            "contactPerson" => match &self.contact_person {
                Field::Absent => None,
                Field::Null => Some(Value::Null),
                Field::Set(_) => Some(Value::Bool(true)),
            },
            "fullName" => text(&self.full_name),
            "companyName" => text(&self.company_name),
            "firstName" => text(&self.first_name),
            "lastName" => text(&self.last_name),
            "email" => defined(&self.email),
            "phone" => defined(&self.phone),
            "vatNumber" => defined(&self.vat_number),
            "registrationNumber" => defined(&self.registration_number),
            "iban" => defined(&self.iban),
            "bic" => defined(&self.bic),
            "billingAddress" => defined(&self.billing_address),
            "shippingAddress" => defined(&self.shipping_address),
            "paymentTermsDays" => defined(&self.payment_terms_days),
            "currency" => text(&self.currency),
            "defaultRevenueAccountId" => defined(&self.default_revenue_account_id),
            "defaultExpenseAccountId" => defined(&self.default_expense_account_id),
            "crmCustomerId" => text(&self.crm_customer_id),
            "crmContactId" => text(&self.crm_contact_id),
            "creditLimit" => text(&self.credit_limit),
            "notes" => defined(&self.notes),
            "tags" => self
                .tags
                .clone()
                .map(|tags| Value::Array(tags.into_iter().map(Value::String).collect())),
            "sepaMandate" => defined(&self.sepa_mandate),
            "metadata" => self.metadata.clone(),
            "brFiscal" => defined(&self.br_fiscal.clone().map_set(Value::Object)),
            "linkPersonId" => text(&self.link_person_id),
            "createSeparatePerson" => self.create_separate_person.map(Value::Bool),
            "taxUse" => defined(&tax.tax_use),
            "is1099Vendor" => defined(&tax.is_1099_vendor),
            "default1099Form" => defined(&tax.default_1099_form),
            "default1099Box" => defined(&tax.default_1099_box),
            "tinType" => defined(&tax.tin_type),
            "tin" => defined(&tax.tin),
            "w9" => defined(&tax.w9.clone().map_set(Value::Object)),
            "backupWithholding" => defined(&tax.backup_withholding),
            "form1099EDeliveryConsentAt" => defined(&tax.form_1099_e_delivery_consent_at),
            "achRoutingNumber" => defined(&tax.ach_routing_number),
            "achAccountNumber" => defined(&tax.ach_account_number),
            "achAccountType" => defined(&tax.ach_account_type),
            _ => None,
        }
    }
}

/// The schema's keys, in its order (`Object.keys(data)` keeps it).
pub(crate) const PAYLOAD_KEYS: [&str; 43] = [
    "role",
    "kind",
    "companyId",
    "personId",
    "contactPerson",
    "fullName",
    "companyName",
    "firstName",
    "lastName",
    "email",
    "phone",
    "vatNumber",
    "registrationNumber",
    "iban",
    "bic",
    "billingAddress",
    "shippingAddress",
    "paymentTermsDays",
    "currency",
    "defaultRevenueAccountId",
    "defaultExpenseAccountId",
    "crmCustomerId",
    "crmContactId",
    "creditLimit",
    "notes",
    "tags",
    "sepaMandate",
    "metadata",
    "brFiscal",
    "linkPersonId",
    "createSeparatePerson",
    "taxUse",
    "is1099Vendor",
    "default1099Form",
    "default1099Box",
    "tinType",
    "tin",
    "w9",
    "backupWithholding",
    "form1099EDeliveryConsentAt",
    "achRoutingNumber",
    "achAccountNumber",
    "achAccountType",
];

trait MapSet<T> {
    fn map_set<U>(self, f: impl FnOnce(T) -> U) -> Field<U>;
}

impl<T> MapSet<T> for Field<T> {
    fn map_set<U>(self, f: impl FnOnce(T) -> U) -> Field<U> {
        match self {
            Field::Absent => Field::Absent,
            Field::Null => Field::Null,
            Field::Set(value) => Field::Set(f(value)),
        }
    }
}

const ADDRESS_FIELDS: [(&str, usize); 10] = [
    ("line1", 255),
    ("line2", 255),
    ("city", 100),
    ("state", 100),
    ("postalCode", 20),
    ("country", 100),
    ("county", 100),
    ("street", 255),
    ("houseNumber", 20),
    ("province", 100),
];

/// `addressSchema` (`.partial().nullable().optional()`): the keys present.
fn read_address(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Field<Value> {
    issues
        .nested(body, key, Presence::Nullish, |issues, fields| {
            let mut out = Map::new();
            for (name, max) in ADDRESS_FIELDS {
                if let Field::Set(value) =
                    issues.text(fields, name, Presence::Optional, None, Some(max))
                {
                    out.insert(name.to_owned(), Value::String(value));
                }
            }
            out
        })
        .map_set(Value::Object)
}

fn read_contact_person(issues: &mut Issues, fields: &Map<String, Value>) -> ContactPersonInput {
    let nullish = Presence::Nullish;
    ContactPersonInput {
        person_id: issues
            .text(fields, "personId", Presence::Optional, None, Some(30))
            .into_option(),
        first_name: issues.text(fields, "firstName", nullish, None, Some(100)),
        last_name: issues.text(fields, "lastName", nullish, None, Some(100)),
        email: issues.text_with(
            fields,
            "email",
            nullish,
            Text {
                format: Some(Format::Email),
                max: Some(255),
                ..Text::default()
            },
        ),
        phone: issues.text(fields, "phone", nullish, None, Some(50)),
    }
}

/// `sepaMandate`: `{ mandateId?, signatureDate?, type? }`.
fn read_sepa(issues: &mut Issues, body: &Map<String, Value>) -> Field<Value> {
    issues
        .nested(body, "sepaMandate", Presence::Nullish, |issues, fields| {
            let mut out = Map::new();
            for key in ["mandateId", "signatureDate"] {
                if let Field::Set(value) = issues.text(fields, key, Presence::Optional, None, None)
                {
                    out.insert(key.to_owned(), Value::String(value));
                }
            }
            if let Field::Set(value) = issues.choice(
                fields,
                "type",
                Presence::Optional,
                &["one-off", "recurring"],
            ) {
                out.insert("type".to_owned(), Value::String(value));
            }
            out
        })
        .map_set(Value::Object)
}

/// `brFiscal` (`.strict()`).
fn read_br_fiscal(issues: &mut Issues, body: &Map<String, Value>) -> Field<Map<String, Value>> {
    const KEYS: [&str; 5] = [
        "inscricaoMunicipal",
        "icmsContributor",
        "simplesNacional",
        "municipalityCode",
        "taxId",
    ];
    issues.nested(body, "brFiscal", Presence::Nullish, |issues, fields| {
        let mut out = Map::new();
        if let Field::Set(value) = issues.text_with(
            fields,
            "inscricaoMunicipal",
            Presence::Optional,
            Text::trimmed(None, Some(20)),
        ) {
            out.insert("inscricaoMunicipal".to_owned(), Value::String(value));
        }
        for key in ["icmsContributor", "simplesNacional"] {
            if let Field::Set(value) = issues.boolean(fields, key, Presence::Optional) {
                out.insert(key.to_owned(), Value::Bool(value));
            }
        }
        if let Field::Set(value) = issues.pattern(
            fields,
            "municipalityCode",
            Presence::Optional,
            None,
            None,
            |s| s.len() == 7 && s.bytes().all(|b| b.is_ascii_digit()),
            "The IBGE municipality code has 7 digits",
        ) {
            out.insert("municipalityCode".to_owned(), Value::String(value));
        }
        if let Field::Set(value) = issues.text_with(
            fields,
            "taxId",
            Presence::Optional,
            Text::trimmed(None, Some(18)),
        ) {
            out.insert("taxId".to_owned(), Value::String(value));
        }
        let extra: Vec<&String> = fields
            .keys()
            .filter(|k| !KEYS.contains(&k.as_str()))
            .collect();
        if !extra.is_empty() {
            let mut path = issues.path_of("x");
            if let Value::Array(parts) = &mut path {
                parts.pop();
            }
            let listed = extra
                .iter()
                .map(|k| format!("'{k}'"))
                .collect::<Vec<_>>()
                .join(", ");
            issues.push_raw(serde_json::json!({
                "code": "unrecognized_keys",
                "keys": extra,
                "path": path,
                "message": format!("Unrecognized key(s) in object: {listed}"),
            }));
        }
        out
    })
}

/// `createContactSchema` (`partial` for an update) over a normalized body.
#[allow(clippy::too_many_lines)] // the schema, field by field in its order
pub(crate) fn read_payload(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> ContactPayload {
    let optional = Presence::Optional;
    let nullish = Presence::Nullish;
    let mut data = ContactPayload {
        role: issues
            .choice(
                body,
                "role",
                optional,
                &["customer", "supplier", "both", "none"],
            )
            .into_option(),
        kind: issues
            .choice(body, "kind", optional, &["company", "person"])
            .into_option(),
        company_id: issues
            .text(body, "companyId", optional, None, Some(30))
            .into_option(),
        person_id: issues
            .text(body, "personId", optional, None, Some(30))
            .into_option(),
        contact_person: issues.nested(body, "contactPerson", nullish, read_contact_person),
        full_name: issues
            .text(
                body,
                "fullName",
                if partial {
                    optional
                } else {
                    Presence::Required
                },
                Some(1),
                Some(255),
            )
            .into_option(),
        company_name: issues
            .text(body, "companyName", optional, None, Some(255))
            .into_option(),
        first_name: issues
            .text(body, "firstName", optional, None, Some(100))
            .into_option(),
        last_name: issues
            .text(body, "lastName", optional, None, Some(100))
            .into_option(),
        email: issues.text_with(
            body,
            "email",
            nullish,
            Text {
                format: Some(Format::Email),
                max: Some(255),
                ..Text::default()
            },
        ),
        phone: issues.text(body, "phone", nullish, None, Some(50)),
        vat_number: issues.text(body, "vatNumber", nullish, None, Some(50)),
        registration_number: issues.text(body, "registrationNumber", nullish, None, Some(100)),
        iban: issues.text(body, "iban", nullish, None, Some(34)),
        bic: issues.text(body, "bic", nullish, None, Some(11)),
        ..ContactPayload::default()
    };
    data.billing_address = read_address(issues, body, "billingAddress");
    data.shipping_address = read_address(issues, body, "shippingAddress");
    data.payment_terms_days = issues.whole_number(
        body,
        "paymentTermsDays",
        nullish,
        Number {
            min: Some(0.0),
            max: Some(3650.0),
            ..Number::default()
        },
    );
    data.currency = match issues.text(body, "currency", optional, None, None) {
        Field::Set(code) => {
            let length = code.encode_utf16().count();
            if length == 3 {
                Some(code)
            } else {
                issues.string_length("currency", 3, length);
                None
            }
        }
        _ => None,
    };
    data.default_revenue_account_id =
        issues.text(body, "defaultRevenueAccountId", nullish, None, Some(30));
    data.default_expense_account_id =
        issues.text(body, "defaultExpenseAccountId", nullish, None, Some(30));
    data.crm_customer_id = issues
        .text(body, "crmCustomerId", optional, None, Some(30))
        .into_option();
    data.crm_contact_id = issues
        .text(body, "crmContactId", optional, None, Some(30))
        .into_option();
    data.credit_limit = issues
        .text(body, "creditLimit", optional, None, None)
        .into_option();
    data.notes = issues.text(body, "notes", nullish, None, Some(10000));
    data.tags = issues
        .list(body, "tags", optional, None, None, |issues, item| {
            issues.item_text(item, Text::default())
        })
        .into_option();
    data.sepa_mandate = read_sepa(issues, body);
    data.metadata = issues
        .nested(body, "metadata", optional, |_, fields| {
            Value::Object(fields.clone())
        })
        .into_option();
    data.br_fiscal = read_br_fiscal(issues, body);
    data.link_person_id = issues
        .text(body, "linkPersonId", optional, None, Some(30))
        .into_option();
    data.create_separate_person = issues
        .boolean(body, "createSeparatePerson", optional)
        .into_option();
    let tax = read_vendor_tax(issues, body);
    data.tax = tax.input;
    if tax.box_refine_failed {
        issues.custom("default1099Box", DEFAULT_BOX_MESSAGE);
    }
    data
}

/// `contactValidationHook`: `path.join('.') + ': ' + message`, joined.
pub(crate) fn hook_message(invalid: &Invalid) -> String {
    let message = invalid
        .issues()
        .iter()
        .map(|issue| {
            let path = issue["path"]
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .map(|p| p.as_str().map_or_else(|| p.to_string(), str::to_owned))
                        .collect::<Vec<_>>()
                        .join(".")
                })
                .unwrap_or_default();
            format!("{path}: {}", issue["message"].as_str().unwrap_or_default())
        })
        .collect::<Vec<_>>()
        .join("; ");
    if message.is_empty() {
        "Invalid request body".to_owned()
    } else {
        message
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_the_platform_payload() {
        let body = normalize(
            &json!({ "name": "Acme", "taxNumber": "", "email": " ", "contactPerson": { "personId": "", "email": "" } }),
            true,
        );
        assert_eq!(
            body,
            json!({ "fullName": "Acme", "vatNumber": null, "email": null, "contactPerson": { "email": null } })
        );
        let created = normalize(
            &json!({ "name": "Acme", "fullName": "Own", "email": "" }),
            false,
        );
        assert_eq!(created, json!({ "fullName": "Own" }));
    }

    #[test]
    fn reads_the_schema_in_order() {
        let mut issues = Issues::default();
        let body =
            json!({ "fullName": "", "currency": "EURO", "default1099Box": "zz", "email": "nope" });
        let data = read_payload(&mut issues, body.as_object().expect("object"), false);
        assert!(data.full_name.is_none());
        let invalid = issues.finish().expect_err("invalid");
        assert_eq!(
            hook_message(&invalid),
            "fullName: String must contain at least 1 character(s); email: Invalid email; currency: String must contain exactly 3 character(s); default1099Box: Not a 1099 box code (for example nec_1 or misc_1)"
        );
    }
}
