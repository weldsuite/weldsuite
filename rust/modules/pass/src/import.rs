//! CSV import from other password managers (`password-import.ts`): columns
//! resolved by name against synonyms, plus the few quirks a column name
//! cannot express. Pure: text in, item documents out.

use serde_json::{Value, json};
use weldsuite_kit::validation::Issues;

use crate::js;
use crate::schemas::{ItemDocument, host_of, issue_text, read_item};

pub(crate) const MAX_IMPORT_ITEMS: usize = 2000;

/// `ImportNote`: a 1-based line (the header is line 1) and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ImportNote {
    pub(crate) line: usize,
    pub(crate) reason: String,
}

impl ImportNote {
    pub(crate) fn to_json(&self) -> Value {
        json!({ "line": self.line, "reason": self.reason })
    }
}

/// `ParsedImport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ParsedImport {
    pub(crate) format: String,
    pub(crate) documents: Vec<ItemDocument>,
    pub(crate) skipped: Vec<ImportNote>,
    pub(crate) warnings: Vec<ImportNote>,
}

/// `ImportError`: answered as a 400 with this message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ImportError(pub(crate) &'static str);

/// One CSV record and the line it starts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CsvRecord {
    pub(crate) line: usize,
    pub(crate) cells: Vec<String>,
}

/// `parseCsv`: RFC 4180 (quoted fields, doubled quotes, line breaks inside
/// quotes), a leading BOM dropped, blank lines skipped.
pub(crate) fn parse_csv(text: &str) -> Vec<CsvRecord> {
    let input = text.strip_prefix('\u{feff}').unwrap_or(text);
    let chars: Vec<char> = input.chars().collect();
    let mut records = Vec::new();
    let mut cells: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut line = 1;
    let mut record_line = 1;

    let end_record = |cells: &mut Vec<String>, cell: &mut String, records: &mut Vec<CsvRecord>, at: usize| {
        cells.push(std::mem::take(cell));
        // A blank line is not a record.
        if cells.len() > 1 || !cells[0].is_empty() {
            records.push(CsvRecord {
                line: at,
                cells: std::mem::take(cells),
            });
        } else {
            cells.clear();
        }
    };

    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if quoted {
            if c == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    cell.push('"');
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                if c == '\n' {
                    line += 1;
                }
                cell.push(c);
            }
            i += 1;
            continue;
        }
        if c == '"' && cell.is_empty() {
            quoted = true;
        } else if c == ',' {
            cells.push(std::mem::take(&mut cell));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            end_record(&mut cells, &mut cell, &mut records, record_line);
            line += 1;
            record_line = line;
        } else {
            cell.push(c);
        }
        i += 1;
    }
    if !cell.is_empty() || !cells.is_empty() {
        end_record(&mut cells, &mut cell, &mut records, record_line);
    }
    records
}

/// The column names each field goes by.
const COLUMNS: [(Column, &[&str]); 11] = [
    (Column::Title, &["name", "title", "account", "item name"]),
    (
        Column::Url,
        &["url", "login_uri", "website", "web site", "uri", "login url"],
    ),
    (
        Column::Username,
        &["username", "login_username", "login", "user", "email", "login name"],
    ),
    (Column::Password, &["password", "login_password"]),
    (
        Column::Totp,
        &["totp", "otpauth", "login_totp", "otp", "two factor", "authenticator"],
    ),
    (Column::Notes, &["notes", "note", "extra", "comments"]),
    (Column::Type, &["type"]),
    (Column::Cardholder, &["cardholdername", "cardholder"]),
    (Column::CardNumber, &["cardnumber", "card number"]),
    (Column::Cvc, &["cvc", "cvv"]),
    (Column::Expiry, &["expirydate", "expiry", "expiration"]),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Column {
    Title,
    Url,
    Username,
    Password,
    Totp,
    Notes,
    Type,
    Cardholder,
    CardNumber,
    Cvc,
    Expiry,
}

fn detect_format(headers: &[String]) -> &'static str {
    let has = |name: &str| headers.iter().any(|header| header == name);
    if has("login_uri") || has("login_password") {
        "bitwarden"
    } else if has("grouping") && has("extra") {
        "lastpass"
    } else if has("cardholdername") || has("additional_urls") {
        "nordpass"
    } else if has("otpauth") {
        "1password"
    } else if has("name") && has("url") && has("username") && has("password") {
        "chrome"
    } else {
        "generic"
    }
}

/// `parseImport(text, format)`.
pub(crate) fn parse_import(text: &str, format: &str) -> Result<ParsedImport, ImportError> {
    let records = parse_csv(text);
    let Some(header) = records.first() else {
        return Err(ImportError("That file is empty."));
    };
    let headers: Vec<String> = header
        .cells
        .iter()
        .map(|cell| js::trim(cell).to_lowercase())
        .collect();
    let index = |column: Column| -> Option<usize> {
        let names = COLUMNS
            .iter()
            .find(|(c, _)| *c == column)
            .map_or(&[][..], |(_, names)| *names);
        headers.iter().position(|header| names.contains(&header.as_str()))
    };
    let indexes: Vec<(Column, Option<usize>)> =
        COLUMNS.iter().map(|(column, _)| (*column, index(*column))).collect();
    let column_index = |column: Column| {
        indexes
            .iter()
            .find(|(c, _)| *c == column)
            .and_then(|(_, index)| *index)
    };
    if column_index(Column::Password).is_none() && column_index(Column::Notes).is_none() {
        return Err(ImportError(
            "No password or notes column found. Export a CSV from your password manager and try again.",
        ));
    }

    let detected = if format == "auto" {
        detect_format(&headers)
    } else {
        format
    };
    let mut result = ParsedImport {
        format: detected.to_owned(),
        documents: Vec::new(),
        skipped: Vec::new(),
        warnings: Vec::new(),
    };

    for record in &records[1..] {
        let get = |column: Column| -> String {
            column_index(column)
                .and_then(|index| record.cells.get(index))
                .map_or_else(String::new, |cell| js::trim(cell).to_owned())
        };

        if result.documents.len() >= MAX_IMPORT_ITEMS {
            result.skipped.push(ImportNote {
                line: record.line,
                reason: format!("Only the first {MAX_IMPORT_ITEMS} items are imported at a time."),
            });
            continue;
        }

        let kind = classify(detected, &get);
        if kind == "unsupported" {
            result.skipped.push(ImportNote {
                line: record.line,
                reason: "This kind of item is not supported.".to_owned(),
            });
            continue;
        }

        let or = |first: String, rest: &[String], fallback: &str| -> String {
            std::iter::once(first)
                .chain(rest.iter().cloned())
                .find(|value| !value.is_empty())
                .unwrap_or_else(|| fallback.to_owned())
        };
        let candidate = match kind {
            "card" => json!({
                "type": "card",
                "title": or(get(Column::Title), &[get(Column::Cardholder)], "Card"),
                "fields": {
                    "cardholder": get(Column::Cardholder),
                    "number": get(Column::CardNumber),
                    "expiry": get(Column::Expiry),
                    "cvc": get(Column::Cvc),
                    "notes": get(Column::Notes),
                },
            }),
            "note" => {
                if get(Column::Notes).is_empty() && get(Column::Title).is_empty() {
                    continue;
                }
                json!({
                    "type": "note",
                    "title": or(get(Column::Title), &[], "Note"),
                    "fields": { "content": get(Column::Notes) },
                })
            }
            _ => {
                let url = get(Column::Url);
                let username = get(Column::Username);
                // The password cell is taken as it is, not trimmed.
                let password = column_index(Column::Password)
                    .and_then(|index| record.cells.get(index))
                    .cloned()
                    .unwrap_or_default();
                if username.is_empty() && password.is_empty() && url.is_empty() {
                    continue;
                }
                let mut totp = get(Column::Totp);
                if !totp.is_empty() && crate::totp::parse_totp(&totp).is_err() {
                    totp = String::new();
                    result.warnings.push(ImportNote {
                        line: record.line,
                        reason: "The two-factor secret could not be read and was left out."
                            .to_owned(),
                    });
                }
                let host = host_of(Some(&url)).unwrap_or_default();
                json!({
                    "type": "login",
                    "title": or(get(Column::Title), &[host, username.clone()], "Login"),
                    "url": if url.is_empty() { Value::Null } else { Value::String(url) },
                    "fields": {
                        "username": username,
                        "password": password,
                        "totp": totp,
                        "notes": get(Column::Notes),
                    },
                })
            }
        };

        let mut issues = Issues::default();
        let document = read_item(&mut issues, &candidate);
        match (issues.finish(), document) {
            (Ok(()), Some(document)) => result.documents.push(document),
            (Err(invalid), _) => result.skipped.push(ImportNote {
                line: record.line,
                reason: invalid
                    .issues()
                    .first()
                    .map_or_else(|| "Invalid row.".to_owned(), issue_text),
            }),
            (Ok(()), None) => result.skipped.push(ImportNote {
                line: record.line,
                reason: "Invalid row.".to_owned(),
            }),
        }
    }
    Ok(result)
}

fn classify(format: &str, get: &dyn Fn(Column) -> String) -> &'static str {
    let kind = get(Column::Type).to_lowercase();
    match format {
        "nordpass" => match kind.as_str() {
            "credit_card" => "card",
            "note" => "note",
            "identity" | "folder" => "unsupported",
            _ => "login",
        },
        "bitwarden" => match kind.as_str() {
            "note" => "note",
            "card" | "identity" => "unsupported",
            _ => "login",
        },
        _ => {
            // LastPass exports a secure note as a login at "http://sn".
            if format == "lastpass" && get(Column::Url) == "http://sn" {
                "note"
            } else if !get(Column::CardNumber).is_empty() {
                "card"
            } else {
                "login"
            }
        }
    }
}
