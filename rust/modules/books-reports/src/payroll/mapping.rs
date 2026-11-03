//! Payroll import mappings (`services/payroll/mapping.ts`): a payroll
//! category to an account (summary CSV and Gusto), and which columns of a CSV
//! export mean what. The entity's saved CSV mapping lives in the
//! `accountMapping` of its `csv` pseudo connection, flattened into string
//! keys (`shape`, `dateFormat`, `col.<column>`, `acc.<category or label>`).

use serde_json::{Map, Value, json};
use weldsuite_books_domain::payroll::PAYROLL_CATEGORIES;
use weldsuite_kit::validation::{Issues, Presence, Text};

/// A refinement settled after the body's synchronous checks: its path from
/// the depth it was found at, and its message.
pub(crate) type Deferred = Vec<(Vec<Value>, String)>;

/// `CsvMapping`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CsvMapping {
    /// `summary` or `gl`.
    pub(crate) shape: &'static str,
    /// Column key to header name, in the schema's order, present keys only.
    pub(crate) columns: Vec<(&'static str, String)>,
    /// Category (summary) or export label (gl) to account id, in the body's order.
    pub(crate) accounts: Vec<(String, String)>,
    pub(crate) date_format: String,
}

const SUMMARY_COLUMNS: [(&str, bool); 12] = [
    ("payDate", true),
    ("grossWages", true),
    ("netPay", true),
    ("employerTaxes", false),
    ("employeeTaxes", false),
    ("employeeDeductions", false),
    ("employerBenefits", false),
    ("reimbursements", false),
    ("ownersDraw", false),
    ("periodStart", false),
    ("periodEnd", false),
    ("reference", false),
];

const GL_COLUMNS: [(&str, bool); 5] = [
    ("date", true),
    ("account", true),
    ("debit", true),
    ("credit", true),
    ("memo", false),
];

const DATE_FORMATS: [&str; 4] = ["auto", "mdy", "dmy", "iso"];

impl CsvMapping {
    pub(crate) fn column(&self, key: &str) -> Option<&str> {
        self.columns
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.as_str())
    }

    /// The mapping as Zod outputs it.
    pub(crate) fn json(&self) -> Value {
        json!({
            "shape": self.shape,
            "columns": Value::Object(self.columns.iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect()),
            "accounts": Value::Object(self.accounts.iter().map(|(k, v)| (k.clone(), json!(v))).collect()),
            "dateFormat": self.date_format,
        })
    }

    /// `flattenCsvMapping(mapping)`.
    pub(crate) fn flatten(&self) -> Value {
        let mut flat = Map::new();
        flat.insert("shape".to_owned(), json!(self.shape));
        flat.insert("dateFormat".to_owned(), json!(self.date_format));
        for (key, value) in &self.columns {
            if !value.is_empty() {
                flat.insert(format!("col.{key}"), json!(value));
            }
        }
        for (key, value) in &self.accounts {
            flat.insert(format!("acc.{key}"), json!(value));
        }
        Value::Object(flat)
    }
}

/// `accountMappingSchema` (or the GL shape's plain record) at `key`: string
/// values, trimmed, 1–30 characters. With `categories`, a key that is not a
/// payroll category is a refinement issue, settled later (`deferred`); Zod
/// runs it only when every value is a string.
pub(crate) fn read_account_record(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    presence: Presence,
    categories: bool,
    deferred: &mut Deferred,
) -> Option<Vec<(String, String)>> {
    let mut unknown: Vec<String> = Vec::new();
    let mut all_strings = true;
    let read = issues.nested(fields, key, presence, |issues, record| {
        let mut out = Vec::new();
        for (name, value) in record {
            if !value.is_string() {
                all_strings = false;
            }
            if let Some(text) = issues
                .text_with(
                    record,
                    name,
                    Presence::Required,
                    Text::trimmed(Some(1), Some(30)),
                )
                .into_option()
            {
                out.push((name.clone(), text));
            }
        }
        if categories {
            unknown = record
                .keys()
                .filter(|k| !PAYROLL_CATEGORIES.iter().any(|(c, _)| c == k))
                .cloned()
                .collect();
        }
        out
    });
    if categories && all_strings && fields.get(key).is_some_and(Value::is_object) {
        for name in unknown {
            deferred.push((
                vec![json!(key), json!(name)],
                format!("Unknown payroll category '{name}'"),
            ));
        }
    }
    read.into_option()
}

/// `csvMappingSchema` (a discriminated union on `shape`) of an object.
pub(crate) fn read_mapping(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    deferred: &mut Deferred,
) -> Option<CsvMapping> {
    let shape: &'static str = match fields.get("shape").and_then(Value::as_str) {
        Some("summary") => "summary",
        Some("gl") => "gl",
        _ => {
            issues.invalid_discriminator("shape", &["summary", "gl"]);
            return None;
        }
    };
    let spec: &[(&str, bool)] = if shape == "summary" {
        &SUMMARY_COLUMNS
    } else {
        &GL_COLUMNS
    };
    let columns = issues
        .nested(fields, "columns", Presence::Required, |issues, cols| {
            let mut out = Vec::new();
            for (name, required) in spec {
                let presence = if *required {
                    Presence::Required
                } else {
                    Presence::Optional
                };
                if let Some(text) = issues
                    .text_with(cols, name, presence, Text::trimmed(Some(1), Some(100)))
                    .into_option()
                {
                    out.push((*name, text));
                }
            }
            out
        })
        .into_option();
    let accounts = if shape == "summary" {
        read_account_record(
            issues,
            fields,
            "accounts",
            Presence::Required,
            true,
            deferred,
        )
    } else if fields.contains_key("accounts") {
        read_account_record(
            issues,
            fields,
            "accounts",
            Presence::Optional,
            false,
            deferred,
        )
    } else {
        Some(Vec::new())
    };
    let date_format = match issues.choice(fields, "dateFormat", Presence::Optional, &DATE_FORMATS) {
        weldsuite_kit::validation::Field::Set(format) => Some(format),
        weldsuite_kit::validation::Field::Absent if !fields.contains_key("dateFormat") => {
            Some("auto".to_owned())
        }
        _ => None,
    };
    Some(CsvMapping {
        shape,
        columns: columns?,
        accounts: accounts?,
        date_format: date_format?,
    })
}

/// `expandCsvMapping(flat)`: the mapping a saved flat record holds, or
/// `None` when it is not a valid one.
pub(crate) fn expand_csv_mapping(flat: Option<&Value>) -> Option<CsvMapping> {
    let flat = flat?.as_object()?;
    if !weldsuite_books_domain::js::truthy(flat.get("shape")) {
        return None;
    }
    let mut columns = Map::new();
    let mut accounts = Map::new();
    for (key, value) in flat {
        if let Some(column) = key.strip_prefix("col.") {
            columns.insert(column.to_owned(), value.clone());
        } else if let Some(label) = key.strip_prefix("acc.") {
            accounts.insert(label.to_owned(), value.clone());
        }
    }
    let mut body = Map::new();
    body.insert("shape".to_owned(), flat["shape"].clone());
    body.insert(
        "dateFormat".to_owned(),
        flat.get("dateFormat")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| json!("auto")),
    );
    body.insert("columns".to_owned(), Value::Object(columns));
    body.insert("accounts".to_owned(), Value::Object(accounts));
    let mut issues = Issues::default();
    let mut deferred = Deferred::new();
    let mapping = read_mapping(&mut issues, &body, &mut deferred);
    for (path, message) in &deferred {
        issues.custom_at(path, message);
    }
    issues.finish().ok()?;
    mapping
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_mapping_round_trips() {
        let body = json!({
            "shape": "summary",
            "columns": { "payDate": " Pay Date ", "grossWages": "Gross", "netPay": "Net" },
            "accounts": { "net_pay": "acc_1" },
        });
        let mut issues = Issues::default();
        let mut deferred = Deferred::new();
        let mapping = read_mapping(
            &mut issues,
            body.as_object().expect("object"),
            &mut deferred,
        )
        .expect("a mapping");
        assert_eq!(deferred.len(), 0);
        assert_eq!(mapping.column("payDate"), Some("Pay Date"));
        assert_eq!(expand_csv_mapping(Some(&mapping.flatten())), Some(mapping));
    }

    #[test]
    fn unknown_categories_are_refinements() {
        let body = json!({
            "shape": "summary",
            "columns": { "payDate": "a", "grossWages": "b", "netPay": "c" },
            "accounts": { "bonus": "acc_1" },
        });
        let mut issues = Issues::default();
        let mut deferred = Deferred::new();
        read_mapping(
            &mut issues,
            body.as_object().expect("object"),
            &mut deferred,
        );
        assert_eq!(deferred.len(), 1);
        assert_eq!(deferred[0].1, "Unknown payroll category 'bonus'");
    }
}
