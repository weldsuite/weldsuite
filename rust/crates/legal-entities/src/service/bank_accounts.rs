//! Core bank accounts of a legal entity, shared by WeldBooks and WeldHR. The
//! full account number is sealed with the field keyring
//! (`DATABASE_ENCRYPTION_KEY` / `_V2`) and only its last four are returned;
//! a reveal is logged in `tax_id_reveals` first.

use std::collections::HashSet;

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value};
use sqlx::PgPool;
use weldsuite_db::{Keyring, decrypt_field, encrypt_field, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Field;
use weldsuite_schema::tenant::{
    accounting_bank_account_settings, accounting_entity_settings, bank_accounts,
    hr_payroll_employers, tax_id_reveals,
};

use super::entities::require_entity_row;
use super::types::{
    BankAccountRow, CreateBankAccountInput, LegalEntityBankAccount, RevealBankAccount,
    RevealedAccountNumber, UpdateBankAccountInput,
};
use super::{LegalEntityError, js_slice_end, js_slice_start, read_model};

fn bank_account_row(model: &bank_accounts::Model) -> Result<BankAccountRow, LegalEntityError> {
    Ok(read_model::<_, BankAccountRow>(model)?.0)
}

/// `update bank_accounts set … where id = $id returning *`; `None` when no
/// row has the id.
async fn update_bank_account_row(
    db: &PgPool,
    id: &str,
    patch: bank_accounts::ActiveModel,
) -> Result<Option<bank_accounts::Model>, DbErr> {
    Ok(bank_accounts::Entity::update_many()
        .set(patch)
        .filter(bank_accounts::Column::Id.eq(id))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next())
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
        accounting_bank_account_settings::Entity::find()
            .select_only()
            .column(accounting_bank_account_settings::Column::BankAccountId)
            .filter(accounting_bank_account_settings::Column::BankAccountId.is_in(ids))
            .into_tuple::<String>()
            .all(&orm(db))
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
    let rows = bank_accounts::Entity::find()
        .filter(bank_accounts::Column::EntityId.eq(entity_id))
        .filter(bank_accounts::Column::DeletedAt.is_null())
        .order_by_desc(bank_accounts::Column::IsDefault)
        .order_by_asc(bank_accounts::Column::Name)
        .all(&orm(db))
        .await?;
    let rows = rows
        .iter()
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
    let row = bank_accounts::Entity::find()
        .filter(bank_accounts::Column::Id.eq(account_id))
        .filter(bank_accounts::Column::EntityId.eq(entity_id))
        .filter(bank_accounts::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    match row {
        Some(row) => bank_account_row(&row),
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
    let employers: Vec<(String, Option<String>)> = hr_payroll_employers::Entity::find()
        .select_only()
        .columns([
            hr_payroll_employers::Column::Id,
            hr_payroll_employers::Column::BankEncrypted,
        ])
        .filter(hr_payroll_employers::Column::BankAccountId.eq(row.id.as_str()))
        .into_tuple()
        .all(&orm(db))
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
        hr_payroll_employers::Entity::update_many()
            .col_expr(
                hr_payroll_employers::Column::BankEncrypted,
                Expr::value(sealed),
            )
            .col_expr(
                hr_payroll_employers::Column::UpdatedAt,
                Expr::value(utc_now()),
            )
            .filter(hr_payroll_employers::Column::Id.eq(id))
            .exec(&orm(db))
            .await?;
    }
    Ok(())
}

/// `clearOtherDefaultAccounts`: one default account per entity.
async fn clear_other_default_accounts(
    db: &PgPool,
    row: &BankAccountRow,
) -> Result<(), LegalEntityError> {
    bank_accounts::Entity::update_many()
        .col_expr(bank_accounts::Column::IsDefault, Expr::value(false))
        .col_expr(bank_accounts::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(bank_accounts::Column::EntityId.eq(row.entity_id.as_str()))
        .filter(bank_accounts::Column::Id.ne(row.id.as_str()))
        .filter(bank_accounts::Column::IsDefault.eq(true))
        .exec(&orm(db))
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
    let mut row = bank_accounts::ActiveModel {
        id: Set(generate_id("ba")),
        entity_id: Set(entity_id.to_owned()),
        name: Set(input.name.clone()),
        account_holder_name: Set(Some(
            input
                .account_holder_name
                .as_set()
                .cloned()
                .or_else(|| entity.legal_name.clone())
                .unwrap_or_else(|| entity.name.clone()),
        )),
        iban: Set(non_empty(&input.iban)),
        bic: Set(non_empty(&input.bic)),
        bank_name: Set(input.bank_name.as_set().cloned()),
        currency: Set(Some(
            input
                .currency
                .clone()
                .unwrap_or_else(|| entity.base_currency.clone()),
        )),
        account_type: Set(input.account_type.as_set().cloned()),
        routing_number: Set(non_empty(&input.routing_number)),
        ach_settings: Set(input.ach_settings.as_set().cloned()),
        is_default: Set(Some(input.is_default.unwrap_or(false))),
        is_active: Set(Some(input.is_active.unwrap_or(true))),
        ..Default::default()
    };
    if let Some(number) = non_empty(&input.account_number) {
        let keyring = require_keyring(keyring)?;
        row.account_number_encrypted = Set(Some(seal(&number, &keyring)?));
        row.account_number_last4 = Set(Some(js_slice_end(&number, 4)));
    }
    let row = bank_accounts::Entity::insert(row)
        .exec_with_returning(&orm(db))
        .await?;
    let row = bank_account_row(&row)?;
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
    let mut patch = bank_accounts::ActiveModel {
        updated_at: Set(utc_now()),
        ..Default::default()
    };
    if let Some(name) = &input.name {
        patch.name = Set(name.clone());
    }
    let text = |slot: &mut sea_orm::ActiveValue<Option<String>>,
                field: &Field<String>,
                empty_is_null: bool| {
        if field.is_absent() {
            return;
        }
        *slot = Set(if empty_is_null {
            non_empty(field)
        } else {
            field.as_set().cloned()
        });
    };
    text(
        &mut patch.account_holder_name,
        &input.account_holder_name,
        false,
    );
    text(&mut patch.iban, &input.iban, true);
    text(&mut patch.bic, &input.bic, true);
    text(&mut patch.bank_name, &input.bank_name, false);
    text(&mut patch.account_type, &input.account_type, false);
    text(&mut patch.routing_number, &input.routing_number, true);
    if let Some(currency) = &input.currency {
        patch.currency = Set(Some(currency.clone()));
    }
    if !input.ach_settings.is_absent() {
        patch.ach_settings = Set(input.ach_settings.as_set().cloned());
    }
    if let Some(is_default) = input.is_default {
        patch.is_default = Set(Some(is_default));
    }
    if let Some(is_active) = input.is_active {
        patch.is_active = Set(Some(is_active));
    }
    if let Some(number) = non_empty(&input.account_number) {
        let keyring = require_keyring(keyring)?;
        patch.account_number_encrypted = Set(Some(seal(&number, &keyring)?));
        patch.account_number_last4 = Set(Some(js_slice_end(&number, 4)));
    } else if !input.account_number.is_absent() {
        // Null or empty clears the number.
        patch.account_number_encrypted = Set(None);
        patch.account_number_last4 = Set(None);
    }
    let row = update_bank_account_row(db, account_id, patch)
        .await?
        .ok_or_else(|| LegalEntityError::not_found("Bank account not found"))?;
    let row = bank_account_row(&row)?;
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
    let in_books: Option<String> = accounting_bank_account_settings::Entity::find()
        .select_only()
        .column(accounting_bank_account_settings::Column::BankAccountId)
        .filter(accounting_bank_account_settings::Column::BankAccountId.eq(row.id.as_str()))
        .into_tuple()
        .one(&orm(db))
        .await?;
    if in_books.is_some() {
        return Err(LegalEntityError::conflict(
            "This account is in WeldBooks; remove it there first",
        ));
    }
    let employer: Option<String> = hr_payroll_employers::Entity::find()
        .select_only()
        .column(hr_payroll_employers::Column::Id)
        .filter(hr_payroll_employers::Column::BankAccountId.eq(row.id.as_str()))
        .filter(hr_payroll_employers::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    if employer.is_some() {
        return Err(LegalEntityError::conflict(
            "WeldHR pays salaries from this account; change the payroll setup first",
        ));
    }
    let invoice_account: Option<String> = accounting_entity_settings::Entity::find()
        .select_only()
        .column(accounting_entity_settings::Column::EntityId)
        .filter(accounting_entity_settings::Column::InvoiceBankAccountId.eq(row.id.as_str()))
        .into_tuple()
        .one(&orm(db))
        .await?;
    if invoice_account.is_some() {
        return Err(LegalEntityError::conflict(
            "WeldBooks prints this account on invoices; pick another one first",
        ));
    }
    let now = utc_now();
    update_bank_account_row(
        db,
        &row.id,
        bank_accounts::ActiveModel {
            deleted_at: Set(Some(now)),
            is_active: Set(Some(false)),
            is_default: Set(Some(false)),
            updated_at: Set(now),
            ..Default::default()
        },
    )
    .await?;
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
    tax_id_reveals::Entity::insert(tax_id_reveals::ActiveModel {
        id: Set(generate_id("tir")),
        entity_id: Set(Some(account.entity_id.clone())),
        subject_type: Set("bank_account".to_owned()),
        subject_id: Set(account.id.clone()),
        field: Set("account_number".to_owned()),
        revealed_by: Set(args.user_id.to_owned()),
        reason: Set(args.reason.map(|reason| js_slice_start(reason, 255))),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(RevealedAccountNumber {
        account_number: open(sealed, &keyring)?,
        routing_number: account.routing_number,
    })
}
