//! The accounting view of a legal entity
//! (`@weldsuite/books-domain/accounting-entity`, weldsuite-documentation/plans/legal-entities.md).
//!
//! Release 1 keeps the WeldBooks columns on `entities` AND on the extension
//! (`accounting_entity_settings`), and every writer mirrors to both. Readers
//! that load the entity centrally go through here: the result has today's
//! `Entity` shape (the row of `entities` as Drizzle returns it), with the
//! extension's values preferred over the old columns, the document texts from
//! `document_texts`, and the tax identifiers from the primary registrations,
//! plus `invoiceBankAccountId` and `weldbooksEnabled`. Release 2 drops the old
//! columns; the shape stays.
//!
//! Entities are JSON objects ([`serde_json::Value`]), as every books reader
//! of `entities` already handles them ([`ENTITIES`]`.js(row)`).

use serde_json::{Map, Value};
use sqlx::PgPool;
use weldsuite_db::{Keyring, decrypt_field};

use crate::books_row;
use crate::tables::{
    ACCOUNTING_ENTITY_SETTINGS, BANK_ACCOUNTS, ENTITIES, LEGAL_ENTITY_REGISTRATIONS,
};

/// The five lock dates of an entity (`EntityLockDates`): `YYYY-MM-DD` or
/// `None`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EntityLockDates {
    pub sales_lock_date: Option<String>,
    pub purchase_lock_date: Option<String>,
    pub tax_lock_date: Option<String>,
    pub period_lock_date: Option<String>,
    pub hard_lock_date: Option<String>,
}

/// The sales tax engine columns of an entity (`loadSalesTaxEngineSettings`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SalesTaxEngineSettings {
    /// `manual` | `stripe_tax` | `avalara`; `None` reads as manual.
    pub engine: Option<String>,
    pub config: Option<Value>,
    /// The sealed provider credentials.
    pub credentials: Option<String>,
}

/// Why [`load_invoice_entity`] failed: a statement, or an account number
/// that does not decrypt (`decryptField` throws). Both are the route's 500.
#[derive(Debug)]
pub enum InvoiceEntityError {
    Database(sqlx::Error),
    Decrypt(String),
}

impl std::fmt::Display for InvoiceEntityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => write!(f, "{error}"),
            Self::Decrypt(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for InvoiceEntityError {}

impl From<sqlx::Error> for InvoiceEntityError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<InvoiceEntityError> for crate::http::Refusal {
    fn from(error: InvoiceEntityError) -> Self {
        match error {
            InvoiceEntityError::Database(error) => Self::Database(error),
            InvoiceEntityError::Decrypt(message) => Self::Internal(message),
        }
    }
}

/// `extension ?? legacy ?? null`.
fn prefer(extension: Option<&Value>, legacy: Option<&Value>) -> Value {
    extension
        .filter(|value| !value.is_null())
        .or_else(|| legacy.filter(|value| !value.is_null()))
        .cloned()
        .unwrap_or(Value::Null)
}

/// `prefer` for a text column, as `Option<String>`.
fn prefer_text(extension: Option<String>, legacy: Option<String>) -> Option<String> {
    extension.or(legacy)
}

/// The primary registration of the first of `types` that has one: the number
/// invoices and returns print (`primaryNumber`).
fn primary_number<'a>(registrations: &'a [Map<String, Value>], types: &[&str]) -> Option<&'a str> {
    types.iter().find_map(|kind| {
        registrations
            .iter()
            .find(|row| {
                row.get("type").and_then(Value::as_str) == Some(*kind)
                    && row.get("isPrimary").and_then(Value::as_bool) == Some(true)
            })
            .map(|row| {
                row.get("number")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            })
    })
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    crate::js::truthy(Some(value))
}

/// `mergeAccountingEntity(row, settings, registrations)`: today's `Entity`
/// from the core row (`entities` as Drizzle returns it), the extension row
/// (`accounting_entity_settings`, `None` when WeldBooks is not enabled) and
/// the entity's primary registrations (`legal_entity_registrations` rows).
pub fn merge_accounting_entity(
    row: &Map<String, Value>,
    settings: Option<&Map<String, Value>>,
    registrations: &[Map<String, Value>],
) -> Value {
    let ext = |key: &str| settings.and_then(|settings| settings.get(key));
    let mut out = row.clone();

    // The tax identifiers: the old column, with the primary registrations over it.
    let jurisdiction = row
        .get("jurisdictionCode")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_uppercase();
    let vat_type = if jurisdiction.starts_with("IN") {
        "gstin"
    } else {
        "vat"
    };
    let mut ids = match row.get("taxIdentifiers") {
        Some(Value::Object(legacy)) => legacy.clone(),
        _ => Map::new(),
    };
    for (key, kind) in [
        ("vatNumber", vat_type),
        ("registrationNumber", "company_registration"),
        ("einOrSsn", "ein"),
    ] {
        if let Some(number) = primary_number(registrations, &[kind]).filter(|n| !n.is_empty()) {
            ids.insert(key.to_owned(), Value::String(number.to_owned()));
        }
    }
    if !ids.is_empty() {
        out.insert("taxIdentifiers".to_owned(), Value::Object(ids));
    }

    // The document texts live on the extension; logo and colours stay core.
    let texts = match ext("documentTexts") {
        Some(Value::Object(texts)) => texts.clone(),
        _ => Map::new(),
    };
    let branding = row.get("branding").cloned().unwrap_or(Value::Null);
    let merged_branding = if truthy(&branding) || !texts.is_empty() {
        let mut merged = match branding {
            Value::Object(fields) => fields,
            _ => Map::new(),
        };
        merged.extend(texts);
        Value::Object(merged)
    } else {
        branding
    };
    out.insert("branding".to_owned(), merged_branding);

    for key in [
        "salesLockDate",
        "purchaseLockDate",
        "taxLockDate",
        "periodLockDate",
        "hardLockDate",
        "accountingMethod",
        "salesTaxEngine",
        "salesTaxEngineConfig",
        "salesTaxCredentialsEncrypted",
        "fiscalCredentialsEncrypted",
        "ssnEncrypted",
        "ssnLast4",
        "jurisdictionSettings",
    ] {
        out.insert(key.to_owned(), prefer(ext(key), row.get(key)));
    }
    out.insert(
        "invoiceBankAccountId".to_owned(),
        ext("invoiceBankAccountId").cloned().unwrap_or(Value::Null),
    );
    out.insert(
        "weldbooksEnabled".to_owned(),
        Value::Bool(settings.is_some()),
    );
    Value::Object(out)
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `loadAccountingEntities(db, ids, { includeDeleted })`: entities by id
/// (deleted ones only with `include_deleted`), merged. Order follows `ids`;
/// unknown ids are left out.
pub async fn load_accounting_entities(
    db: &PgPool,
    ids: &[String],
    include_deleted: bool,
) -> Result<Vec<Value>, sqlx::Error> {
    let mut unique: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids {
        if !unique.contains(id) {
            unique.push(id.clone());
        }
    }
    if unique.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(entities),
        " from entities t where t.id = any($1) and ($2 or t.deleted_at is null)"
    ))
    .bind(&unique)
    .bind(include_deleted)
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Map<String, Value>> = rows
        .into_iter()
        .map(|row| object(ENTITIES.js(row)))
        .collect();
    let found: Vec<String> = rows
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let settings: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(accounting_entity_settings),
        " from accounting_entity_settings t where t.entity_id = any($1)"
    ))
    .bind(&found)
    .fetch_all(db)
    .await?;
    let settings: Vec<Map<String, Value>> = settings
        .into_iter()
        .map(|row| object(ACCOUNTING_ENTITY_SETTINGS.js(row)))
        .collect();
    let registrations: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(legal_entity_registrations),
        " from legal_entity_registrations t where t.entity_id = any($1) \
         and t.is_primary = true and t.deleted_at is null order by t.created_at, t.id"
    ))
    .bind(&found)
    .fetch_all(db)
    .await?;
    let registrations: Vec<Map<String, Value>> = registrations
        .into_iter()
        .map(|row| object(LEGAL_ENTITY_REGISTRATIONS.js(row)))
        .collect();
    let entity_of = |row: &Map<String, Value>, key: &str| {
        row.get(key).and_then(Value::as_str).map(str::to_owned)
    };
    let merged: Vec<(String, Value)> = rows
        .iter()
        .map(|row| {
            let id = entity_of(row, "id").unwrap_or_default();
            let ext = settings
                .iter()
                .find(|s| entity_of(s, "entityId").as_deref() == Some(id.as_str()));
            let own: Vec<Map<String, Value>> = registrations
                .iter()
                .filter(|r| entity_of(r, "entityId").as_deref() == Some(id.as_str()))
                .cloned()
                .collect();
            let entity = merge_accounting_entity(row, ext, &own);
            (id, entity)
        })
        .collect();
    Ok(unique
        .iter()
        .filter_map(|id| {
            merged
                .iter()
                .find(|(found, _)| found == id)
                .map(|(_, entity)| entity.clone())
        })
        .collect())
}

/// `loadAccountingEntity(db, id)`: one entity in today's shape, or `None`
/// when it is unknown or deleted.
pub async fn load_accounting_entity(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    Ok(load_accounting_entities(db, &[id.to_owned()], false)
        .await?
        .into_iter()
        .next())
}

/// `loadEntityLockDates(db, entityId)`: the lock dates, extension values
/// first, in one query. `None` when the entity does not exist (deleted ones
/// included, as the posting guards always read them).
pub async fn load_entity_lock_dates(
    db: &PgPool,
    entity_id: &str,
) -> Result<Option<EntityLockDates>, sqlx::Error> {
    type Row = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<Row> = sqlx::query_as(
        "select e.sales_lock_date::text, e.purchase_lock_date::text, e.tax_lock_date::text, \
           e.period_lock_date::text, e.hard_lock_date::text, \
           s.sales_lock_date::text, s.purchase_lock_date::text, s.tax_lock_date::text, \
           s.period_lock_date::text, s.hard_lock_date::text \
         from entities e left join accounting_entity_settings s on s.entity_id = e.id \
         where e.id = $1 limit 1",
    )
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(
        |(sales, purchase, tax, period, hard, x_sales, x_purchase, x_tax, x_period, x_hard)| {
            EntityLockDates {
                sales_lock_date: prefer_text(x_sales, sales),
                purchase_lock_date: prefer_text(x_purchase, purchase),
                tax_lock_date: prefer_text(x_tax, tax),
                period_lock_date: prefer_text(x_period, period),
                hard_lock_date: prefer_text(x_hard, hard),
            }
        },
    ))
}

/// `loadSalesTaxEngineSettings(db, entityId)`: the sales tax engine columns,
/// extension values first, in one query. `None` when the entity does not
/// exist.
pub async fn load_sales_tax_engine_settings(
    db: &PgPool,
    entity_id: &str,
) -> Result<Option<SalesTaxEngineSettings>, sqlx::Error> {
    type Row = (
        Option<String>,
        Option<Value>,
        Option<String>,
        Option<String>,
        Option<Value>,
        Option<String>,
    );
    let row: Option<Row> = sqlx::query_as(
        "select e.sales_tax_engine, e.sales_tax_engine_config, e.sales_tax_credentials_encrypted, \
           s.sales_tax_engine, s.sales_tax_engine_config, s.sales_tax_credentials_encrypted \
         from entities e left join accounting_entity_settings s on s.entity_id = e.id \
         where e.id = $1 limit 1",
    )
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(
        |(engine, config, credentials, x_engine, x_config, x_credentials)| {
            SalesTaxEngineSettings {
                engine: prefer_text(x_engine, engine),
                // A jsonb `null` reads as absent, as Drizzle reads it as null.
                config: x_config
                    .filter(|value| !value.is_null())
                    .or(config)
                    .filter(|value| !value.is_null()),
                credentials: prefer_text(x_credentials, credentials),
            }
        },
    ))
}

/// The columns of `accounting_entity_settings` besides the key and the
/// timestamps, as `upsertAccountingEntitySettings` may set them.
const SETTINGS_COLUMNS: [&str; 15] = [
    "sales_lock_date",
    "purchase_lock_date",
    "tax_lock_date",
    "period_lock_date",
    "hard_lock_date",
    "accounting_method",
    "sales_tax_engine",
    "sales_tax_engine_config",
    "sales_tax_credentials_encrypted",
    "fiscal_credentials_encrypted",
    "ssn_encrypted",
    "ssn_last4",
    "jurisdiction_settings",
    "invoice_bank_account_id",
    "document_texts",
];

/// The upsert: a property `values` leaves out gets null on insert and keeps
/// its value on update, as Drizzle leaves it out of the statement.
static UPSERT_SQL: std::sync::LazyLock<String> = std::sync::LazyLock::new(upsert_sql);

fn upsert_sql() -> String {
    let columns = SETTINGS_COLUMNS.join(", ");
    let selected: Vec<String> = SETTINGS_COLUMNS.iter().map(|c| format!("r.{c}")).collect();
    let sets: Vec<String> = SETTINGS_COLUMNS
        .iter()
        .map(|c| format!("{c} = case when $1::jsonb ? '{c}' then excluded.{c} else t.{c} end"))
        .collect();
    format!(
        "insert into accounting_entity_settings as t (entity_id, {columns}, created_at, updated_at) \
         select r.entity_id, {}, r.created_at, r.updated_at \
         from jsonb_populate_record(null::accounting_entity_settings, $1::jsonb) r \
         on conflict (entity_id) do update set {}, updated_at = excluded.updated_at",
        selected.join(", "),
        sets.join(", "),
    )
}

/// `upsertAccountingEntitySettings(db, entityId, values)`, the release 1
/// write side: insert or update the extension row with `values` (keyed by
/// property, `accountingMethod`, `salesLockDate`, …; a null clears the
/// column). The caller writes the same values to the old `entities` columns
/// (the mirror).
pub async fn upsert_accounting_entity_settings<'e>(
    db: impl sqlx::PgExecutor<'e>,
    entity_id: &str,
    values: &Map<String, Value>,
) -> Result<(), sqlx::Error> {
    let now = crate::http::now();
    let mut row = ACCOUNTING_ENTITY_SETTINGS.values(values);
    row.remove("created_at");
    row.remove("updated_at");
    row.insert("entity_id".to_owned(), Value::String(entity_id.to_owned()));
    row.insert("created_at".to_owned(), Value::String(now.clone()));
    row.insert("updated_at".to_owned(), Value::String(now));
    sqlx::query(sqlx::AssertSqlSafe(UPSERT_SQL.as_str()))
        .bind(Value::Object(row))
        .execute(db)
        .await?;
    Ok(())
}

/// `loadInvoiceEntity(db, id, keyEnv)`: the entity as invoices render it,
/// [`load_accounting_entity`] with the bank details taken from the core
/// account at `invoiceBankAccountId` when one is set (else today's
/// `bankDetails`). The account number is only printed when `keyring` can
/// decrypt it (no keyring, or an empty one, leaves it out).
pub async fn load_invoice_entity(
    db: &PgPool,
    id: &str,
    keyring: Option<&Keyring>,
) -> Result<Option<Value>, InvoiceEntityError> {
    let Some(mut entity) = load_accounting_entity(db, id).await? else {
        return Ok(None);
    };
    let Some(account_id) = entity
        .get("invoiceBankAccountId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
    else {
        return Ok(Some(entity));
    };
    let account: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(bank_accounts),
        " from bank_accounts t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(&account_id)
    .fetch_optional(db)
    .await?;
    let Some(account) = account.map(|row| BANK_ACCOUNTS.js(row)) else {
        return Ok(Some(entity));
    };
    let mut account_number: Option<String> = None;
    if let (Some(sealed), Some(keyring)) = (
        account["accountNumberEncrypted"]
            .as_str()
            .filter(|s| !s.is_empty()),
        keyring,
    ) && (keyring.v1.is_some() || keyring.v2.is_some())
    {
        account_number = Some(
            decrypt_field(sealed, keyring)
                .map_err(|error| InvoiceEntityError::Decrypt(error.to_string()))?,
        );
    }
    let mut details = Map::new();
    for (key, value) in [
        ("iban", account["iban"].as_str()),
        ("bic", account["bic"].as_str()),
        ("bankName", account["bankName"].as_str()),
        ("routingNumber", account["routingNumber"].as_str()),
        ("accountNumber", account_number.as_deref()),
    ] {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            details.insert(key.to_owned(), Value::String(value.to_owned()));
        }
    }
    entity["bankDetails"] = Value::Object(details);
    Ok(Some(entity))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn map(value: Value) -> Map<String, Value> {
        object(value)
    }

    #[test]
    fn the_extension_wins_over_the_old_columns() {
        let row = map(json!({
            "id": "ent_1",
            "jurisdictionCode": "NL",
            "taxIdentifiers": { "vatNumber": "NL000", "other": { "x": "y" } },
            "branding": { "logoUrl": "l", "footerText": "old" },
            "salesLockDate": "2026-01-31",
            "hardLockDate": "2025-12-31",
            "accountingMethod": "cash",
            "salesTaxEngine": null,
        }));
        let settings = map(json!({
            "entityId": "ent_1",
            "salesLockDate": "2026-02-28",
            "hardLockDate": null,
            "documentTexts": { "footerText": "new" },
            "invoiceBankAccountId": "ba_1",
        }));
        let registrations = vec![
            map(json!({ "type": "vat", "number": "NL123456789B01", "isPrimary": true })),
            map(json!({ "type": "company_registration", "number": "123", "isPrimary": false })),
        ];
        let merged = merge_accounting_entity(&row, Some(&settings), &registrations);
        assert_eq!(merged["salesLockDate"], "2026-02-28");
        assert_eq!(merged["hardLockDate"], "2025-12-31");
        assert_eq!(merged["accountingMethod"], "cash");
        assert_eq!(merged["salesTaxEngine"], Value::Null);
        assert_eq!(
            merged["taxIdentifiers"],
            json!({ "vatNumber": "NL123456789B01", "other": { "x": "y" } })
        );
        assert_eq!(
            merged["branding"],
            json!({ "logoUrl": "l", "footerText": "new" })
        );
        assert_eq!(merged["invoiceBankAccountId"], "ba_1");
        assert_eq!(merged["weldbooksEnabled"], true);
    }

    #[test]
    fn without_an_extension_the_row_stays_as_it_is() {
        let row = map(json!({
            "id": "ent_1",
            "jurisdictionCode": "IN",
            "taxIdentifiers": null,
            "branding": null,
            "jurisdictionSettings": { "stateCode": "27" },
        }));
        let registrations = vec![map(
            json!({ "type": "gstin", "number": "27AAAAA0000A1Z5", "isPrimary": true }),
        )];
        let merged = merge_accounting_entity(&row, None, &registrations);
        assert_eq!(
            merged["taxIdentifiers"],
            json!({ "vatNumber": "27AAAAA0000A1Z5" })
        );
        assert_eq!(merged["branding"], Value::Null);
        assert_eq!(merged["jurisdictionSettings"], json!({ "stateCode": "27" }));
        assert_eq!(merged["invoiceBankAccountId"], Value::Null);
        assert_eq!(merged["weldbooksEnabled"], false);

        let bare = merge_accounting_entity(
            &map(json!({ "id": "e", "jurisdictionCode": "NL", "taxIdentifiers": null })),
            None,
            &[],
        );
        assert_eq!(bare["taxIdentifiers"], Value::Null);
    }

    #[test]
    fn the_upsert_sets_only_what_it_is_given() {
        let sql = upsert_sql();
        assert!(sql.contains("on conflict (entity_id) do update set sales_lock_date = case when $1::jsonb ? 'sales_lock_date' then excluded.sales_lock_date else t.sales_lock_date end"));
        assert!(sql.ends_with("updated_at = excluded.updated_at"));
    }
}
