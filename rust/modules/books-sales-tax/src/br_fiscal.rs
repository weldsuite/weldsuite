//! Brazil's fiscal fields of a document and its lines (`lib/br-fiscal-schemas.ts`),
//! as the calculation preview reads them: the same reading as books-sales's
//! `body.rs` (module crates don't share code; this is a copy of those few
//! schemas).

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
