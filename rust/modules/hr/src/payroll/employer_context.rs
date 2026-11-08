//! The employer as the payroll engines see it, built from a legal entity and
//! the registration and bank account payroll runs under
//! (`services/weldhr/payroll/employer-context.ts`; docs/plans/legal-entities.md,
//! WeldHR).
//!
//! [`load_employer_for_payroll`] merges the entity (name, legal name,
//! country, currency, address), the registration (loonheffingennummer / EIN)
//! and the core bank account into the row shape every payroll service and
//! engine already takes (the employer row, plus the resolved salary account
//! under `linkedBank`, which [`read_employer_bank`](super::employers::read_employer_bank)
//! reads first). Release 1: an employer without a link (or whose link no
//! longer resolves) keeps its deprecated copied columns, so a workspace
//! without legal entities, and every existing output (loonaangifte XML,
//! SEPA, NACHA, 941/W-2), is unchanged.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use weldsuite_db::{Keyring, PgPool, decrypt_field, js_row};
use weldsuite_legal_entities::LegalEntityApp;

use crate::{HrError, js_trim};

/// The key of the merged row that holds the linked core bank account's
/// salary account (`PayrollEmployer.linkedBank`); absent when the employer
/// has no such link (the deprecated `bank_encrypted` is then the account).
pub(crate) const LINKED_BANK: &str = "linkedBank";

/// `EmployerLinks`: what the employer's links resolved to.
#[derive(Debug, Clone, Default)]
pub(crate) struct EmployerLinks {
    /// The live legal entity (a `to_jsonb` row, Drizzle-shaped).
    pub(crate) entity: Option<Value>,
    /// The registration, when it belongs to that entity.
    pub(crate) registration: Option<Value>,
    /// The core bank account, when it belongs to that entity.
    pub(crate) bank_account: Option<Value>,
    /// WeldBooks is enabled for the entity (it has an
    /// `accounting_entity_settings` row).
    pub(crate) books_enabled: bool,
}

/// `PayrollEmployer`: the employer row with the entity facts merged in, and
/// its links.
#[derive(Debug, Clone)]
pub(crate) struct PayrollEmployer {
    pub(crate) row: Value,
    pub(crate) links: EmployerLinks,
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// A non-empty string column.
fn id_of(row: &Value, key: &str) -> Option<String> {
    text(row, key)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

fn unique(rows: &[Value], key: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    rows.iter()
        .filter_map(|row| id_of(row, key))
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

/// `value ?? null`: a JSON null for a missing or null value.
fn or_null(value: Option<&Value>) -> Value {
    value
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(Value::Null)
}

/// `a ?? b`.
fn nullish_or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    a.filter(|v| !v.is_null()).or(b)
}

/// `addressOf(entity, fallback)`: the entity's address in the payroll shape;
/// only what the entity actually has overrides the copied address.
fn address_of(entity: &Value, fallback: &Value) -> Value {
    let a = match entity.get("address") {
        Some(Value::Object(a)) => a,
        // `if (!a) return fallback`: null; JSON has no other falsy object.
        None | Some(Value::Null) => return fallback.clone(),
        Some(_) => &Map::new(),
    };
    let mapped: [(&str, Option<&Value>); 8] = [
        ("line1", nullish_or(a.get("line1"), a.get("street"))),
        ("line2", a.get("line2")),
        ("houseNumber", a.get("houseNumber")),
        ("houseNumberAddition", a.get("houseNumberAddition")),
        ("postalCode", a.get("postalCode")),
        ("city", a.get("city")),
        ("region", nullish_or(a.get("state"), a.get("province"))),
        ("country", a.get("country")),
    ];
    let mut out = match fallback {
        Value::Object(fields) => fields.clone(),
        _ => Map::new(),
    };
    for (key, value) in mapped {
        let Some(value) = value else { continue };
        if value.is_null() || value.as_str() == Some("") {
            continue;
        }
        out.insert(key.to_owned(), value.clone());
    }
    Value::Object(out)
}

/// `previousBank(row, keyring)`: the sealed copy, `{}` when there is none or
/// it does not open.
fn previous_bank(row: &Value, keyring: &Keyring) -> Map<String, Value> {
    let Some(sealed) = text(row, "bankEncrypted").filter(|s| !s.is_empty()) else {
        return Map::new();
    };
    decrypt_field(sealed, keyring)
        .ok()
        .and_then(|plain| serde_json::from_str::<Value>(&plain).ok())
        .and_then(|value| match value {
            Value::Object(fields) => Some(fields),
            _ => None,
        })
        .unwrap_or_default()
}

/// `bankFromAccount(account, row, keyring)`: the salary account of a core
/// bank account; fields it does not hold (NACHA company id, account type)
/// keep the copied account's.
fn bank_from_account(account: &Value, row: &Value, keyring: &Keyring) -> Value {
    let previous = previous_bank(row, keyring);
    let account_number = match text(account, "accountNumberEncrypted").filter(|s| !s.is_empty()) {
        Some(sealed) => match decrypt_field(sealed, keyring) {
            Ok(number) => Value::String(number),
            Err(_) => or_null(previous.get("accountNumber")),
        },
        None => Value::Null,
    };
    let account_type = match text(account, "accountType") {
        Some(kind @ ("savings" | "checking")) => Value::String(kind.to_owned()),
        _ => or_null(previous.get("accountType")),
    };
    let nacha = match account["achSettings"].get("companyIdentification") {
        Some(Value::String(id)) => Value::String(id.clone()),
        _ => or_null(previous.get("nachaCompanyId")),
    };
    let mut out = previous;
    out.insert(
        "accountHolder".to_owned(),
        or_null(account.get("accountHolderName")),
    );
    out.insert("iban".to_owned(), or_null(account.get("iban")));
    out.insert("bic".to_owned(), or_null(account.get("bic")));
    out.insert(
        "routingNumber".to_owned(),
        or_null(account.get("routingNumber")),
    );
    out.insert("accountNumber".to_owned(), account_number);
    out.insert("accountType".to_owned(), account_type);
    out.insert("bankName".to_owned(), or_null(account.get("bankName")));
    out.insert("nachaCompanyId".to_owned(), nacha);
    Value::Object(out)
}

/// The live rows of `table` with these ids, by id.
async fn rows_by_id(
    db: &PgPool,
    sql: &'static str,
    ids: &[String],
) -> Result<HashMap<String, Value>, HrError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(sql).bind(ids).fetch_all(db).await?;
    Ok(rows
        .into_iter()
        .map(js_row)
        .filter_map(|row| id_of(&row, "id").map(|id| (id, row)))
        .collect())
}

/// `{ ...settings, [key]: number }`.
fn with_number(settings: &Value, key: &str, number: &Value) -> Value {
    let mut out = match settings {
        Value::Object(fields) => fields.clone(),
        _ => Map::new(),
    };
    out.insert(key.to_owned(), number.clone());
    Value::Object(out)
}

/// `resolveEmployers(db, rows, keyring)`: entity, registration and bank
/// account merged into each row. Four queries at most, whatever the number
/// of rows.
pub(crate) async fn resolve_employers(
    db: &PgPool,
    rows: Vec<Value>,
    keyring: &Keyring,
) -> Result<Vec<PayrollEmployer>, HrError> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let entity_ids = unique(&rows, "legalEntityId");
    let entities = rows_by_id(
        db,
        "select to_jsonb(t) from entities t where t.id = any($1) and t.deleted_at is null",
        &entity_ids,
    )
    .await?;
    let registrations = rows_by_id(
        db,
        "select to_jsonb(t) from legal_entity_registrations t
         where t.id = any($1) and t.deleted_at is null",
        &unique(&rows, "registrationId"),
    )
    .await?;
    let banks = rows_by_id(
        db,
        "select to_jsonb(t) from bank_accounts t where t.id = any($1) and t.deleted_at is null",
        &unique(&rows, "bankAccountId"),
    )
    .await?;
    let books = if entity_ids.is_empty() {
        HashSet::new()
    } else {
        LegalEntityApp::Weldbooks
            .enabled_for(db, &entity_ids)
            .await?
    };

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let entity = text(&row, "legalEntityId").and_then(|id| entities.get(id).cloned());
        let entity_id = entity.as_ref().and_then(|e| id_of(e, "id"));
        // A link only counts when it belongs to the employer's entity.
        let belongs = |linked: &Value| {
            entity_id.is_some() && text(linked, "entityId") == entity_id.as_deref()
        };
        let registration = text(&row, "registrationId")
            .and_then(|id| registrations.get(id))
            .filter(|linked| belongs(linked))
            .cloned();
        let bank_account = text(&row, "bankAccountId")
            .and_then(|id| banks.get(id))
            .filter(|linked| belongs(linked))
            .cloned();
        let books_enabled = entity_id.as_ref().is_some_and(|id| books.contains(id));

        let mut merged = row.clone();
        if let (Some(entity), Some(fields)) = (&entity, merged.as_object_mut()) {
            let entity_name = entity["name"].clone();
            let trimmed = |value: Option<&str>| {
                value
                    .map(js_trim)
                    .filter(|v| !v.is_empty())
                    .map(|v| Value::String(v.to_owned()))
            };
            fields.insert(
                "name".to_owned(),
                trimmed(text(&row, "label")).unwrap_or_else(|| entity_name.clone()),
            );
            fields.insert(
                "legalName".to_owned(),
                trimmed(text(entity, "legalName")).unwrap_or(entity_name),
            );
            let country: String = text(entity, "jurisdictionCode")
                .unwrap_or_default()
                .chars()
                .take(2)
                .collect::<String>()
                .to_uppercase();
            // Payroll runs in NL and US; an entity elsewhere keeps the employer's own country.
            if country == "NL" || country == "US" {
                fields.insert("country".to_owned(), json!(country));
            }
            fields.insert("currency".to_owned(), entity["baseCurrency"].clone());
            fields.insert("address".to_owned(), address_of(entity, &row["address"]));
        }
        if let (Some(registration), Some(fields)) = (&registration, merged.as_object_mut()) {
            match text(registration, "type") {
                Some("nl_payroll_tax") => {
                    fields.insert(
                        "nlSettings".to_owned(),
                        with_number(
                            &row["nlSettings"],
                            "loonheffingennummer",
                            &registration["number"],
                        ),
                    );
                }
                Some("ein") => {
                    fields.insert(
                        "usSettings".to_owned(),
                        with_number(&row["usSettings"], "ein", &registration["number"]),
                    );
                }
                _ => {}
            }
        }
        if let (Some(account), Some(fields)) = (&bank_account, merged.as_object_mut()) {
            fields.insert(
                LINKED_BANK.to_owned(),
                bank_from_account(account, &row, keyring),
            );
        }
        out.push(PayrollEmployer {
            row: merged,
            links: EmployerLinks {
                entity,
                registration,
                bank_account,
                books_enabled,
            },
        });
    }
    Ok(out)
}

/// `findEmployerForPayroll(db, employerId, keys)`: the employer for the
/// payroll engines, or `None` when there is none. Soft-deleted employers
/// still resolve (their runs and filings exist).
pub(crate) async fn find_employer_for_payroll(
    db: &PgPool,
    employer_id: &str,
    keyring: &Keyring,
) -> Result<Option<PayrollEmployer>, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_payroll_employers t where t.id = $1 limit 1",
    )
    .bind(employer_id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row.map(js_row) else {
        return Ok(None);
    };
    Ok(resolve_employers(db, vec![row], keyring).await?.pop())
}

/// `loadEmployerForPayroll(db, employerId, keys)`: the employer, or a
/// `Payroll employer` 404.
pub(crate) async fn load_employer_for_payroll(
    db: &PgPool,
    employer_id: &str,
    keyring: &Keyring,
) -> Result<PayrollEmployer, HrError> {
    find_employer_for_payroll(db, employer_id, keyring)
        .await?
        .ok_or_else(|| HrError::not_found("Payroll employer", employer_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_entity_address_overrides_only_what_it_has() {
        let fallback = json!({ "line1": "Old 1", "city": "Utrecht", "postalCode": "1234AB" });
        let entity = json!({ "address": {
            "street": "Damrak 1", "city": "", "state": null, "province": "NH", "country": "NL"
        } });
        assert_eq!(
            address_of(&entity, &fallback),
            json!({ "line1": "Damrak 1", "city": "Utrecht", "postalCode": "1234AB",
                    "region": "NH", "country": "NL" })
        );
        // `line1 ?? street`: an empty line1 wins over the street, then is left out.
        let empty_line = json!({ "address": { "line1": "", "street": "Damrak 1" } });
        assert_eq!(address_of(&empty_line, &fallback)["line1"], "Old 1");
        assert_eq!(address_of(&json!({ "address": null }), &fallback), fallback);
    }

    #[test]
    fn a_core_account_keeps_what_it_does_not_hold() {
        let keyring = Keyring::default();
        let account = json!({
            "accountHolderName": "Acme", "iban": "NL91ABNA0417164300", "bic": null,
            "accountType": "business", "achSettings": { "companyIdentification": "1234567890" },
        });
        let bank = bank_from_account(&account, &json!({}), &keyring);
        assert_eq!(bank["accountHolder"], "Acme");
        assert_eq!(bank["iban"], "NL91ABNA0417164300");
        assert_eq!(bank["accountType"], Value::Null);
        assert_eq!(bank["accountNumber"], Value::Null);
        assert_eq!(bank["nachaCompanyId"], "1234567890");
        assert_eq!(bank["routingNumber"], Value::Null);
    }
}
