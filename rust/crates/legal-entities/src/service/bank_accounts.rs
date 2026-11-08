//! Core bank accounts of a legal entity, shared by WeldBooks and WeldHR. The
//! full account number is sealed with the field keyring
//! (`DATABASE_ENCRYPTION_KEY` / `_V2`) and only its last four are returned;
//! a reveal is logged in `tax_id_reveals` first.

use std::collections::HashSet;

use serde_json::{Map, Value};
use sqlx::PgPool;
use weldsuite_db::{Keyring, decrypt_field, encrypt_field};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Field;

use super::entities::require_entity_row;
use super::types::{
    BankAccountRow, CreateBankAccountInput, LegalEntityBankAccount, RevealBankAccount,
    RevealedAccountNumber, UpdateBankAccountInput,
};
use super::{
    Columns, LegalEntityError, Param, insert_returning, js_slice_end, js_slice_start, now_iso,
    read_row, update_returning,
};

fn bank_account_row(value: Value) -> Result<BankAccountRow, LegalEntityError> {
    Ok(read_row::<BankAccountRow>(value)?.0)
}

/// `requireKeyring(env)`: the keys that are set (an empty value counts as
/// unset, as in `keyringFromEnv`), else `NO_ENCRYPTION_KEY`.
fn require_keyring(keyring: &Keyring) -> Result<Keyring, LegalEntityError> {
    let usable = Keyring {
        v1: keyring.v1.clone().filter(|key| !key.is_empty()),
        v2: keyring.v2.clone().filter(|key| !key.is_empty()),
    };
    if usable.is_empty() {
        return Err(LegalEntityError::no_encryption_key(
            "Account numbers cannot be stored: the worker has no encryption key",
        ));
    }
    Ok(usable)
}

fn seal(plaintext: &str, keyring: &Keyring) -> Result<String, LegalEntityError> {
    encrypt_field(plaintext, keyring)
        .map_err(|error| LegalEntityError::Internal(format!("encryptField: {error}")))
}

fn open(sealed: &str, keyring: &Keyring) -> Result<String, LegalEntityError> {
    decrypt_field(sealed, keyring)
        .map_err(|error| LegalEntityError::Internal(format!("decryptField: {error:?}")))
}

/// `toBankAccounts`: the public shape, with whether WeldBooks has the account.
async fn to_bank_accounts(
    db: &PgPool,
    rows: Vec<BankAccountRow>,
) -> Result<Vec<LegalEntityBankAccount>, LegalEntityError> {
    let ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
    let in_books: HashSet<String> = if ids.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar::<_, String>(
            "select bank_account_id from accounting_bank_account_settings
             where bank_account_id = any($1)",
        )
        .bind(&ids)
        .fetch_all(db)
        .await?
        .into_iter()
        .collect()
    };
    Ok(rows
        .into_iter()
        .map(|row| LegalEntityBankAccount {
            in_weldbooks: in_books.contains(&row.id),
            has_account_number: row
                .account_number_encrypted
                .as_deref()
                .is_some_and(|sealed| !sealed.is_empty()),
            is_default: row.is_default == Some(true),
            is_active: row.is_active != Some(false),
            id: row.id,
            entity_id: row.entity_id,
            name: row.name,
            account_holder_name: row.account_holder_name,
            iban: row.iban,
            bic: row.bic,
            bank_name: row.bank_name,
            currency: row.currency,
            account_type: row.account_type,
            routing_number: row.routing_number,
            account_number_last4: row.account_number_last4,
            ach_settings: row.ach_settings,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
        .collect())
}

async fn to_bank_account(
    db: &PgPool,
    row: BankAccountRow,
) -> Result<LegalEntityBankAccount, LegalEntityError> {
    to_bank_accounts(db, vec![row])
        .await?
        .pop()
        .ok_or_else(|| LegalEntityError::Internal("legal entities: no bank account".to_owned()))
}

/// `listBankAccounts`: the default first, then by name.
pub async fn list_bank_accounts(
    db: &PgPool,
    entity_id: &str,
) -> Result<Vec<LegalEntityBankAccount>, LegalEntityError> {
    require_entity_row(db, entity_id).await?;
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from bank_accounts t
         where t.entity_id = $1 and t.deleted_at is null
         order by t.is_default desc, t.name asc",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let rows = rows
        .into_iter()
        .map(bank_account_row)
        .collect::<Result<Vec<_>, _>>()?;
    to_bank_accounts(db, rows).await
}

/// `requireBankAccount`: a live account of the entity, else `NOT_FOUND`
/// "Bank account not found".
async fn require_bank_account(
    db: &PgPool,
    entity_id: &str,
    account_id: &str,
) -> Result<BankAccountRow, LegalEntityError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from bank_accounts t
         where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1",
    )
    .bind(account_id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    match row {
        Some(row) => bank_account_row(row),
        None => Err(LegalEntityError::not_found("Bank account not found")),
    }
}

/// Release 1 mirror: re-seal `hr_payroll_employers.bank_encrypted`
/// (`HrPayrollEmployerBank`) for the employers paying from this account
/// (`mirrorBankAccountToEmployers`).
async fn mirror_bank_account_to_employers(
    db: &PgPool,
    keyring: &Keyring,
    row: &BankAccountRow,
) -> Result<(), LegalEntityError> {
    let employers: Vec<(String, Option<String>)> = sqlx::query_as(
        "select id, bank_encrypted from hr_payroll_employers where bank_account_id = $1",
    )
    .bind(&row.id)
    .fetch_all(db)
    .await?;
    if employers.is_empty() {
        return Ok(());
    }
    let keyring = require_keyring(keyring)?;
    let account_number = match row
        .account_number_encrypted
        .as_deref()
        .filter(|s| !s.is_empty())
    {
        Some(sealed) => Some(open(sealed, &keyring)?),
        None => None,
    };
    let ach = match &row.ach_settings {
        Value::Object(fields) => fields.clone(),
        _ => Map::new(),
    };
    let text = |value: &Option<String>| value.clone().map_or(Value::Null, Value::String);
    for (id, bank_encrypted) in employers {
        let previous: Map<String, Value> = bank_encrypted
            .as_deref()
            .filter(|sealed| !sealed.is_empty())
            .and_then(|sealed| decrypt_field(sealed, &keyring).ok())
            .and_then(|plain| serde_json::from_str::<Value>(&plain).ok())
            .and_then(|value| match value {
                Value::Object(fields) => Some(fields),
                _ => None,
            })
            .unwrap_or_default();
        let account_type = match row.account_type.as_deref() {
            Some(kind @ ("savings" | "checking")) => Value::String(kind.to_owned()),
            _ => previous.get("accountType").cloned().unwrap_or(Value::Null),
        };
        let nacha = match ach.get("companyIdentification") {
            Some(Value::String(id)) => Value::String(id.clone()),
            _ => previous
                .get("nachaCompanyId")
                .cloned()
                .unwrap_or(Value::Null),
        };
        let mut next = previous;
        next.insert("accountHolder".to_owned(), text(&row.account_holder_name));
        next.insert("iban".to_owned(), text(&row.iban));
        next.insert("bic".to_owned(), text(&row.bic));
        next.insert("routingNumber".to_owned(), text(&row.routing_number));
        next.insert("accountNumber".to_owned(), text(&account_number));
        next.insert("accountType".to_owned(), account_type);
        next.insert("bankName".to_owned(), text(&row.bank_name));
        next.insert("nachaCompanyId".to_owned(), nacha);
        let sealed = seal(&Value::Object(next).to_string(), &keyring)?;
        sqlx::query(
            "update hr_payroll_employers set bank_encrypted = $1, updated_at = $2::timestamp where id = $3",
        )
        .bind(sealed)
        .bind(now_iso())
        .bind(&id)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// `clearOtherDefaultAccounts`: one default account per entity.
async fn clear_other_default_accounts(
    db: &PgPool,
    row: &BankAccountRow,
) -> Result<(), LegalEntityError> {
    sqlx::query(
        "update bank_accounts set is_default = false, updated_at = $1::timestamp
         where entity_id = $2 and id <> $3 and is_default = true",
    )
    .bind(now_iso())
    .bind(&row.entity_id)
    .bind(&row.id)
    .execute(db)
    .await?;
    Ok(())
}

/// `value || null`.
fn non_empty(field: &Field<String>) -> Option<String> {
    field.as_set().filter(|value| !value.is_empty()).cloned()
}

/// `createBankAccount`: the holder defaults to the entity's legal name (else
/// its name), the currency to its base currency.
pub async fn create_bank_account(
    db: &PgPool,
    keyring: &Keyring,
    entity_id: &str,
    input: &CreateBankAccountInput,
) -> Result<LegalEntityBankAccount, LegalEntityError> {
    let entity = require_entity_row(db, entity_id).await?;
    let mut columns = Columns::default();
    columns.set("id", Param::Text(Some(generate_id("ba"))));
    columns.set("entity_id", Param::Text(Some(entity_id.to_owned())));
    columns.set("name", Param::Text(Some(input.name.clone())));
    columns.set(
        "account_holder_name",
        Param::Text(Some(
            input
                .account_holder_name
                .as_set()
                .cloned()
                .or_else(|| entity.legal_name.clone())
                .unwrap_or_else(|| entity.name.clone()),
        )),
    );
    columns.set("iban", Param::Text(non_empty(&input.iban)));
    columns.set("bic", Param::Text(non_empty(&input.bic)));
    columns.set("bank_name", Param::Text(input.bank_name.as_set().cloned()));
    columns.set(
        "currency",
        Param::Text(Some(
            input
                .currency
                .clone()
                .unwrap_or_else(|| entity.base_currency.clone()),
        )),
    );
    columns.set(
        "account_type",
        Param::Text(input.account_type.as_set().cloned()),
    );
    columns.set(
        "routing_number",
        Param::Text(non_empty(&input.routing_number)),
    );
    columns.set(
        "ach_settings",
        Param::Json(input.ach_settings.as_set().cloned()),
    );
    columns.set(
        "is_default",
        Param::Bool(Some(input.is_default.unwrap_or(false))),
    );
    columns.set(
        "is_active",
        Param::Bool(Some(input.is_active.unwrap_or(true))),
    );
    if let Some(number) = non_empty(&input.account_number) {
        let keyring = require_keyring(keyring)?;
        columns.set(
            "account_number_encrypted",
            Param::Text(Some(seal(&number, &keyring)?)),
        );
        columns.set(
            "account_number_last4",
            Param::Text(Some(js_slice_end(&number, 4))),
        );
    }
    let row = bank_account_row(insert_returning(db, "bank_accounts", columns).await?)?;
    if row.is_default == Some(true) {
        clear_other_default_accounts(db, &row).await?;
    }
    to_bank_account(db, row).await
}

/// `updateBankAccount`: an empty or null account number clears it; the
/// change is mirrored into the WeldHR employers paying from the account.
pub async fn update_bank_account(
    db: &PgPool,
    keyring: &Keyring,
    entity_id: &str,
    account_id: &str,
    input: &UpdateBankAccountInput,
) -> Result<LegalEntityBankAccount, LegalEntityError> {
    require_bank_account(db, entity_id, account_id).await?;
    let mut patch = Columns::default();
    patch.set("updated_at", Param::Timestamp(Some(now_iso())));
    if let Some(name) = &input.name {
        patch.set("name", Param::Text(Some(name.clone())));
    }
    let mut text = |column: &'static str, field: &Field<String>, empty_is_null: bool| {
        if field.is_absent() {
            return;
        }
        let value = if empty_is_null {
            non_empty(field)
        } else {
            field.as_set().cloned()
        };
        patch.set(column, Param::Text(value));
    };
    text("account_holder_name", &input.account_holder_name, false);
    text("iban", &input.iban, true);
    text("bic", &input.bic, true);
    text("bank_name", &input.bank_name, false);
    text("account_type", &input.account_type, false);
    text("routing_number", &input.routing_number, true);
    if let Some(currency) = &input.currency {
        patch.set("currency", Param::Text(Some(currency.clone())));
    }
    if !input.ach_settings.is_absent() {
        patch.set(
            "ach_settings",
            Param::Json(input.ach_settings.as_set().cloned()),
        );
    }
    if let Some(is_default) = input.is_default {
        patch.set("is_default", Param::Bool(Some(is_default)));
    }
    if let Some(is_active) = input.is_active {
        patch.set("is_active", Param::Bool(Some(is_active)));
    }
    if let Some(number) = non_empty(&input.account_number) {
        let keyring = require_keyring(keyring)?;
        patch.set(
            "account_number_encrypted",
            Param::Text(Some(seal(&number, &keyring)?)),
        );
        patch.set(
            "account_number_last4",
            Param::Text(Some(js_slice_end(&number, 4))),
        );
    } else if !input.account_number.is_absent() {
        // Null or empty clears the number.
        patch.set("account_number_encrypted", Param::Text(None));
        patch.set("account_number_last4", Param::Text(None));
    }
    let row = update_returning(db, "bank_accounts", patch, account_id)
        .await?
        .ok_or_else(|| LegalEntityError::not_found("Bank account not found"))?;
    let row = bank_account_row(row)?;
    if row.is_default == Some(true) {
        clear_other_default_accounts(db, &row).await?;
    }
    mirror_bank_account_to_employers(db, keyring, &row).await?;
    to_bank_account(db, row).await
}

/// `deleteBankAccount`: soft delete. Refused while WeldBooks or WeldHR uses
/// the account.
pub async fn delete_bank_account(
    db: &PgPool,
    entity_id: &str,
    account_id: &str,
) -> Result<(), LegalEntityError> {
    let row = require_bank_account(db, entity_id, account_id).await?;
    let in_books: Option<String> = sqlx::query_scalar(
        "select bank_account_id from accounting_bank_account_settings
         where bank_account_id = $1 limit 1",
    )
    .bind(&row.id)
    .fetch_optional(db)
    .await?;
    if in_books.is_some() {
        return Err(LegalEntityError::conflict(
            "This account is in WeldBooks; remove it there first",
        ));
    }
    let employer: Option<String> = sqlx::query_scalar(
        "select id from hr_payroll_employers
         where bank_account_id = $1 and deleted_at is null limit 1",
    )
    .bind(&row.id)
    .fetch_optional(db)
    .await?;
    if employer.is_some() {
        return Err(LegalEntityError::conflict(
            "WeldHR pays salaries from this account; change the payroll setup first",
        ));
    }
    let invoice_account: Option<String> = sqlx::query_scalar(
        "select entity_id from accounting_entity_settings
         where invoice_bank_account_id = $1 limit 1",
    )
    .bind(&row.id)
    .fetch_optional(db)
    .await?;
    if invoice_account.is_some() {
        return Err(LegalEntityError::conflict(
            "WeldBooks prints this account on invoices; pick another one first",
        ));
    }
    let now = now_iso();
    let mut columns = Columns::default();
    columns.set("deleted_at", Param::Timestamp(Some(now.clone())));
    columns.set("is_active", Param::Bool(Some(false)));
    columns.set("is_default", Param::Bool(Some(false)));
    columns.set("updated_at", Param::Timestamp(Some(now)));
    update_returning(db, "bank_accounts", columns, &row.id).await?;
    Ok(())
}

/// `revealBankAccountNumber`: decrypt the full number for an authorised
/// reveal, logged in `tax_id_reveals` first (a failed log refuses the reveal).
pub async fn reveal_bank_account_number(
    db: &PgPool,
    keyring: &Keyring,
    args: RevealBankAccount<'_>,
) -> Result<RevealedAccountNumber, LegalEntityError> {
    let account = require_bank_account(db, args.entity_id, args.account_id).await?;
    let Some(sealed) = account
        .account_number_encrypted
        .as_deref()
        .filter(|sealed| !sealed.is_empty())
    else {
        return Err(LegalEntityError::bad_request(
            "This bank account has no account number on file",
        ));
    };
    let keyring = require_keyring(keyring)?;
    sqlx::query(
        "insert into tax_id_reveals (id, entity_id, subject_type, subject_id, field, revealed_by, reason)
         values ($1, $2, 'bank_account', $3, 'account_number', $4, $5)",
    )
    .bind(generate_id("tir"))
    .bind(&account.entity_id)
    .bind(&account.id)
    .bind(args.user_id)
    .bind(args.reason.map(|reason| js_slice_start(reason, 255)))
    .execute(db)
    .await?;
    Ok(RevealedAccountNumber {
        account_number: open(sealed, &keyring)?,
        routing_number: account.routing_number,
    })
}
