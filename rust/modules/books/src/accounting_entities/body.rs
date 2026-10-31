//! The bodies of `POST /api/accounting-entities` (`createEntitySchema`) and
//! `PATCH /:id` (`.partial().omit({ seedDefaults })`), read as Zod outputs
//! them: unknown keys stripped (the schemas are not passthrough), nested
//! objects reduced to their own keys, in the schema's order.

use serde_json::{Map, Value, json};
use weldsuite_books_domain::identifiers::is_valid_iban;
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};

/// The parsed body: `data`, the Zod output by key, in the schema's order.
#[derive(Debug, Clone, Default)]
pub(crate) struct EntityBody {
    pub(crate) data: Map<String, Value>,
    /// `seedDefaults` (`.default(true)`), create only.
    pub(crate) seed_defaults: bool,
}

impl EntityBody {
    /// `data[key]`: `None` when the body left it out (`undefined`).
    pub(crate) fn get(&self, key: &str) -> Option<&Value> {
        self.data.get(key)
    }

    /// A string field: `Some(text)` when set to a string.
    pub(crate) fn text(&self, key: &str) -> Option<&str> {
        self.data.get(key).and_then(Value::as_str)
    }
}

fn keep<T: serde::Serialize>(out: &mut Map<String, Value>, key: &str, field: Field<T>) {
    match field {
        Field::Set(value) => {
            out.insert(key.to_owned(), json!(value));
        }
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
}

fn opt(partial: bool, presence: Presence) -> Presence {
    if partial && presence == Presence::Required {
        Presence::Optional
    } else {
        presence
    }
}

fn string(
    issues: &mut Issues,
    body: &Map<String, Value>,
    out: &mut Map<String, Value>,
    key: &str,
    presence: Presence,
    min: Option<usize>,
    max: Option<usize>,
) {
    let field = issues.text(body, key, presence, min, max);
    keep(out, key, field);
}

/// Every key of `object` as a string (`.partial()` of an all-string object).
fn strings(
    issues: &mut Issues,
    object: &Map<String, Value>,
    fields: &[(&str, Text)],
) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, rules) in fields {
        let field = issues.text_with(object, key, Presence::Optional, *rules);
        keep(&mut out, key, field);
    }
    out
}

const fn max(n: usize) -> Text {
    Text::length(None, Some(n))
}

const fn any() -> Text {
    Text::length(None, None)
}

/// Read the body. `partial` is the PATCH schema. A failed `bankDetails.iban`
/// refinement is reported after every other check, as Zod settles
/// refinements last.
#[allow(clippy::too_many_lines)] // one block per schema field, in order
pub(crate) fn read(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> EntityBody {
    let mut out = Map::new();
    string(
        issues,
        body,
        &mut out,
        "name",
        opt(partial, Presence::Required),
        Some(1),
        Some(255),
    );
    string(
        issues,
        body,
        &mut out,
        "legalName",
        Presence::Optional,
        None,
        Some(255),
    );
    string(
        issues,
        body,
        &mut out,
        "entityType",
        Presence::Optional,
        None,
        Some(20),
    );
    string(
        issues,
        body,
        &mut out,
        "taxClassification",
        Presence::Optional,
        None,
        Some(20),
    );
    string(
        issues,
        body,
        &mut out,
        "dba",
        Presence::Nullish,
        None,
        Some(255),
    );
    let method = issues.choice(
        body,
        "accountingMethod",
        Presence::Nullish,
        &["accrual", "cash"],
    );
    keep(&mut out, "accountingMethod", method);
    string(
        issues,
        body,
        &mut out,
        "jurisdictionCode",
        Presence::Optional,
        Some(2),
        Some(5),
    );
    string(
        issues,
        body,
        &mut out,
        "jurisdiction",
        Presence::Optional,
        Some(2),
        Some(5),
    );
    string(
        issues,
        body,
        &mut out,
        "vatNumber",
        Presence::Optional,
        None,
        Some(50),
    );
    if let Field::Set(currency) = issues.text(body, "baseCurrency", Presence::Optional, None, None)
    {
        issues.string_length("baseCurrency", 3, currency.encode_utf16().count());
        out.insert("baseCurrency".to_owned(), json!(currency));
    }
    string(
        issues,
        body,
        &mut out,
        "locale",
        Presence::Optional,
        None,
        Some(10),
    );
    string(
        issues,
        body,
        &mut out,
        "timezone",
        Presence::Optional,
        None,
        Some(50),
    );
    let ids = issues.nested(
        body,
        "taxIdentifiers",
        Presence::Optional,
        |issues, object| {
            let mut ids = strings(
                issues,
                object,
                &[
                    ("vatNumber", any()),
                    ("registrationNumber", any()),
                    ("einOrSsn", any()),
                ],
            );
            let other = issues.nested(object, "other", Presence::Optional, |issues, other| {
                let mut out = Map::new();
                for key in other.keys() {
                    let field = issues.text(other, key, Presence::Required, None, None);
                    keep(&mut out, key, field);
                }
                out
            });
            keep(&mut ids, "other", other);
            ids
        },
    );
    keep(&mut out, "taxIdentifiers", ids);
    string(
        issues,
        body,
        &mut out,
        "ssn",
        Presence::Nullish,
        None,
        Some(20),
    );
    let address = issues.nested(body, "address", Presence::Nullish, |issues, object| {
        strings(
            issues,
            object,
            &[
                ("line1", max(255)),
                ("line2", max(255)),
                ("city", max(100)),
                ("state", max(100)),
                ("postalCode", max(20)),
                ("country", max(100)),
                ("county", max(100)),
                ("street", max(255)),
                ("houseNumber", max(20)),
                ("province", max(100)),
            ],
        )
    });
    keep(&mut out, "address", address);
    let contact = issues.nested(body, "contact", Presence::Optional, |issues, object| {
        let email = Text {
            format: Some(Format::Email),
            ..Text::default()
        };
        strings(
            issues,
            object,
            &[("email", email), ("phone", any()), ("website", any())],
        )
    });
    keep(&mut out, "contact", contact);
    let mut iban_refused = false;
    let bank = issues.nested(body, "bankDetails", Presence::Optional, |issues, object| {
        let details = strings(
            issues,
            object,
            &[
                ("iban", any()),
                ("bic", any()),
                ("accountNumber", any()),
                ("routingNumber", any()),
                ("bankName", any()),
            ],
        );
        if let Some(iban) = details.get("iban").and_then(Value::as_str)
            && !weldsuite_books_domain::jurisdictions::js_trim(iban).is_empty()
            && !is_valid_iban(iban)
        {
            iban_refused = true;
        }
        details
    });
    keep(&mut out, "bankDetails", bank);
    let branding = issues.nested(body, "branding", Presence::Optional, |issues, object| {
        strings(
            issues,
            object,
            &[
                ("logoUrl", any()),
                ("primaryColor", any()),
                ("accentColor", any()),
                ("footerText", any()),
                ("paymentInstructions", any()),
                ("termsAndConditions", any()),
            ],
        )
    });
    keep(&mut out, "branding", branding);
    let start = issues.whole_number(
        body,
        "fiscalYearStart",
        Presence::Optional,
        Number {
            min: Some(1.0),
            max: Some(12.0),
            ..Number::default()
        },
    );
    keep(&mut out, "fiscalYearStart", start);
    let config = issues.nested(
        body,
        "fiscalYearConfig",
        Presence::Nullish,
        |issues, object| {
            let mut config = Map::new();
            match object.get("type") {
                Some(Value::String(t)) if t == "fifty_two_fifty_three" => {
                    config.insert("type".to_owned(), json!(t));
                }
                other => {
                    let mut issue = Map::new();
                    if let Some(received) = other {
                        issue.insert("received".to_owned(), received.clone());
                    }
                    issue.insert("code".to_owned(), json!("invalid_literal"));
                    issue.insert("expected".to_owned(), json!("fifty_two_fifty_three"));
                    issue.insert(
                        "message".to_owned(),
                        json!("Invalid literal value, expected \"fifty_two_fifty_three\""),
                    );
                    issues.issue_at("type", Value::Object(issue));
                }
            }
            let end = issues.whole_number(
                object,
                "endMonth",
                Presence::Required,
                Number {
                    min: Some(1.0),
                    max: Some(12.0),
                    ..Number::default()
                },
            );
            keep(&mut config, "endMonth", end);
            let weekday = issues.whole_number(
                object,
                "weekday",
                Presence::Required,
                Number {
                    min: Some(0.0),
                    max: Some(6.0),
                    ..Number::default()
                },
            );
            keep(&mut config, "weekday", weekday);
            let rule = issues.choice(object, "rule", Presence::Required, &["last", "nearest"]);
            keep(&mut config, "rule", rule);
            config
        },
    );
    keep(&mut out, "fiscalYearConfig", config);
    let default = issues.boolean(body, "isDefault", Presence::Optional);
    keep(&mut out, "isDefault", default);
    let settings = issues.nested(
        body,
        "jurisdictionSettings",
        Presence::Optional,
        |_, object| object.clone(),
    );
    keep(&mut out, "jurisdictionSettings", settings);
    let seed = if partial {
        Field::Absent
    } else {
        issues.boolean(body, "seedDefaults", Presence::Optional)
    };
    if iban_refused {
        issues.custom_at(
            &[json!("bankDetails"), json!("iban")],
            "Not a valid IBAN (length for the country and check digits)",
        );
    }
    EntityBody {
        data: out,
        seed_defaults: !matches!(seed, Field::Set(false)),
    }
}
