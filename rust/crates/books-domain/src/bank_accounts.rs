//! Bank account details beyond the name (`services/accounting-bank-accounts.ts`):
//! US routing and account numbers, the account type, and the ledger account
//! behind a bank account. The banking routes and the purchases area's payment
//! runs (check MICR lines, NACHA, Positive Pay) share it.
//!
//! The full account number is stored encrypted (`accountNumberEncrypted`)
//! with only its last four digits in the clear; the encrypted value never
//! leaves the server except through [`reveal_account_number`], which writes
//! the reveal log first.

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_db::{Keyring, decrypt_field, encrypt_field};
use weldsuite_kit::generate_id;

use crate::document_posting::text;
use crate::http::now;
use crate::js::{locale_compare, number_text, slice_utf16};
use crate::posting::{account_for_role, load_entity_accounts};
use crate::tables::{ACCOUNTS, BANK_ACCOUNTS};

/// `BANK_ACCOUNT_TYPES`.
pub const BANK_ACCOUNT_TYPES: [&str; 5] = [
    "checking",
    "savings",
    "credit_card",
    "money_market",
    "line_of_credit",
];

/// `AccountNumberKeyError`'s message: the routes answer it with a 500.
pub const NO_KEY_MESSAGE: &str =
    "Account numbers cannot be stored: the worker has no encryption key";

/// Why a bank-account operation failed.
#[derive(Debug)]
pub enum BankAccountError {
    /// `PostingError`: the routes answer 400 with the message.
    Posting(String),
    /// `AccountNumberKeyError`: 500 with [`NO_KEY_MESSAGE`].
    NoKey,
    /// A stored number that does not open (wrong key, damaged blob): the
    /// route's own 500.
    Unreadable(String),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for BankAccountError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl std::fmt::Display for BankAccountError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Posting(message) | Self::Unreadable(message) => f.write_str(message),
            Self::NoKey => f.write_str(NO_KEY_MESSAGE),
            Self::Database(error) => error.fmt(f),
        }
    }
}

/// `isLiabilityAccountType`: credit cards and lines of credit are
/// liabilities, a charge increases what is owed.
pub fn is_liability_account_type(account_type: Option<&str>) -> bool {
    matches!(account_type, Some("credit_card" | "line_of_credit"))
}

/// `isValidAbaRouting`: nine digits, weights 3-7-1, a sum divisible by 10.
pub fn is_valid_aba_routing(value: &str) -> bool {
    if value.len() != 9 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
    let sum: u32 = value
        .bytes()
        .zip(weights)
        .map(|(digit, weight)| u32::from(digit - b'0') * weight)
        .sum();
    sum.is_multiple_of(10)
}

/// `normalizeAccountNumber`: spaces and dashes dropped (`/[\s-]/g`), then 4
/// to 34 letters, digits or `*`.
pub fn normalize_account_number(value: &str) -> Option<String> {
    let cleaned: String = value
        .chars()
        .filter(|c| !(crate::jurisdictions::is_js_space(*c) || *c == '-'))
        .collect();
    let length = cleaned.chars().count();
    ((4..=34).contains(&length)
        && cleaned
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '*'))
    .then_some(cleaned)
}

/// `lastFour`: the last four UTF-16 units (account numbers are ASCII).
pub fn last_four(account_number: &str) -> String {
    let chars: Vec<char> = account_number.chars().collect();
    chars[chars.len().saturating_sub(4)..].iter().collect()
}

/// `publicBankAccount(row)`: the row for responses and events, without the
/// encrypted number and with `hasAccountNumber`.
pub fn public_bank_account(row: &Value) -> Value {
    let mut out = row.as_object().cloned().unwrap_or_default();
    let encrypted = out.remove("accountNumberEncrypted");
    out.insert(
        "hasAccountNumber".to_owned(),
        Value::Bool(crate::js::truthy(encrypted.as_ref())),
    );
    Value::Object(out)
}

/// `requireKeyring`.
fn require_keyring(keyring: &Keyring) -> Result<&Keyring, BankAccountError> {
    if keyring.is_empty() {
        Err(BankAccountError::NoKey)
    } else {
        Ok(keyring)
    }
}

/// A number sealed for storage: `accountNumberEncrypted` and
/// `accountNumberLast4` (`sealAccountNumber`).
#[derive(Debug, Clone)]
pub struct SealedNumber {
    pub encrypted: String,
    pub last4: String,
}

/// `sealAccountNumber(env, accountNumber)`.
pub fn seal_account_number(
    keyring: &Keyring,
    account_number: &str,
) -> Result<SealedNumber, BankAccountError> {
    let keyring = require_keyring(keyring)?;
    let encrypted = encrypt_field(account_number, keyring)
        .map_err(|error| BankAccountError::Unreadable(format!("{error:?}")))?;
    Ok(SealedNumber {
        encrypted,
        last4: last_four(account_number),
    })
}

/// What [`reveal_account_number`] gives back.
#[derive(Debug, Clone)]
pub struct Revealed {
    pub account_number: String,
    pub routing_number: Option<String>,
}

/// `revealAccountNumber(db, env, { account, userId, reason })`: decrypt a
/// bank account's number for an authorized reveal. The reveal is logged in
/// `tax_id_reveals` before the number is opened; a failed log write refuses
/// the reveal. `account` is the row as Drizzle returns it.
pub async fn reveal_account_number(
    db: &PgPool,
    keyring: &Keyring,
    account: &Value,
    user_id: &str,
    reason: Option<&str>,
) -> Result<Revealed, BankAccountError> {
    let Some(encrypted) = crate::document_posting::filled(account, "accountNumberEncrypted") else {
        return Err(BankAccountError::Posting(
            "This bank account has no account number on file".to_owned(),
        ));
    };
    let keyring = require_keyring(keyring)?;
    sqlx::query(
        "insert into tax_id_reveals (id, entity_id, subject_type, subject_id, field, revealed_by, reason) \
         values ($1, $2, 'bank_account', $3, 'account_number', $4, $5)",
    )
    .bind(generate_id("tir"))
    .bind(text(account, "entityId"))
    .bind(text(account, "id"))
    .bind(user_id)
    .bind(reason.map(|reason| slice_utf16(reason, 255)))
    .execute(db)
    .await?;
    let account_number = decrypt_field(encrypted, keyring)
        .map_err(|error| BankAccountError::Unreadable(format!("{error:?}")))?;
    Ok(Revealed {
        account_number,
        routing_number: text(account, "routingNumber").map(str::to_owned),
    })
}

// ── Ledger account behind a bank account ────────────────────────────────────

/// `numericCode`: an all-digit code as a number.
fn numeric_code(code: &str) -> Option<f64> {
    if code.is_empty() || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    code.parse::<f64>().ok()
}

/// `nextFreeCode`: the first unused numeric code from `start` on.
fn next_free_code(taken: &[&str], start: f64) -> String {
    let mut candidate = start;
    while taken.contains(&number_text(candidate).as_str()) {
        candidate += 1.0;
    }
    number_text(candidate)
}

/// `assertLedgerAccountFits(ledger, accountType)`: cards and lines of credit
/// sit on a liability account, everything else on an asset.
pub fn assert_ledger_account_fits(
    ledger: &Value,
    account_type: Option<&str>,
) -> Result<(), BankAccountError> {
    let Some(account_type) = account_type.filter(|t| !t.is_empty()) else {
        return Ok(());
    };
    let wanted = if is_liability_account_type(Some(account_type)) {
        "liability"
    } else {
        "asset"
    };
    let kind = text(ledger, "type").unwrap_or("undefined");
    if kind == wanted {
        return Ok(());
    }
    let article = if kind == "asset" {
        "an asset".to_owned()
    } else {
        format!("a {kind}")
    };
    Err(BankAccountError::Posting(format!(
        "A {} account needs a {wanted} ledger account, but {} {} is {article} account.",
        account_type.replace('_', " "),
        text(ledger, "code").unwrap_or("undefined"),
        text(ledger, "name").unwrap_or("undefined"),
    )))
}

/// `REUSABLE_NAMES`: the chart account a new bank account of this type may
/// take over when nothing links to it yet (`/check/i`, `/saving/i`, …).
fn reusable_name(account_type: &str) -> Option<&'static str> {
    match account_type {
        "checking" => Some("check"),
        "savings" => Some("saving"),
        "money_market" => Some("money market"),
        "line_of_credit" => Some("line of credit"),
        _ => None,
    }
}

/// `BankLedgerPlan`.
#[derive(Debug, Clone)]
pub enum BankLedgerPlan {
    /// A chart account to reuse, as Drizzle returns it.
    Existing(Value),
    /// The account to insert, as the route's JavaScript object
    /// (`$inferInsert` properties; `createdAt` / `updatedAt` as ISO text).
    New(Map<String, Value>),
}

/// `planBankLedgerAccount(db, { entityId, name, accountType, currency })`:
/// which ledger account a new bank account of this type sits on. A chart
/// that ships a matching, still unlinked account is reused; otherwise a new
/// one (a child of Credit Card Payable for a card, a liability for a line of
/// credit, an asset bank account for the rest), carrying its neighbours'
/// income-tax line.
#[allow(clippy::too_many_lines)] // mirrors planBankLedgerAccount step by step
pub async fn plan_bank_ledger_account(
    db: &PgPool,
    entity_id: &str,
    name: &str,
    account_type: &str,
    currency: &str,
) -> Result<BankLedgerPlan, sqlx::Error> {
    let chart: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(accounts),
        " from accounts t where t.entity_id = $1 and t.deleted_at is null"
    ))
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let chart = ACCOUNTS.js_rows(chart);
    let linked: Vec<Option<String>> = sqlx::query_scalar(
        "select ledger_account_id from bank_accounts where entity_id = $1 and deleted_at is null",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let linked: Vec<String> = linked
        .into_iter()
        .flatten()
        .filter(|id| !id.is_empty())
        .collect();
    let liability = is_liability_account_type(Some(account_type));
    let side = if liability { "liability" } else { "asset" };

    if let Some(reusable) = reusable_name(account_type) {
        let mut sorted: Vec<&Value> = chart.iter().collect();
        sorted.sort_by(|a, b| {
            locale_compare(
                text(a, "code").unwrap_or_default(),
                text(b, "code").unwrap_or_default(),
            )
        });
        let found = sorted.into_iter().find(|a| {
            let id = text(a, "id").unwrap_or_default();
            a.get("isActive") != Some(&Value::Bool(false))
                && !linked.iter().any(|l| l == id)
                && text(a, "type") == Some(side)
                && (liability || text(a, "subtype") == Some("bank"))
                && text(a, "name").is_some_and(|n| n.to_lowercase().contains(reusable))
                && !chart
                    .iter()
                    .any(|child| text(child, "parentAccountId") == Some(id))
        });
        if let Some(existing) = found {
            return Ok(BankLedgerPlan::Existing(existing.clone()));
        }
    }

    let accounts = load_entity_accounts(db, entity_id).await?;
    let parent = (account_type == "credit_card")
        .then(|| account_for_role(&accounts, "credit_card_payable", &[]))
        .flatten();
    let subtype = if liability { account_type } else { "bank" };
    let sibling = parent.or_else(|| {
        chart.iter().find(|a| {
            text(a, "subtype") == Some(subtype)
                && text(a, "type") == Some(side)
                && crate::js::truthy(a.get("taxLine"))
        })
    });

    let parent_code = parent.and_then(|p| numeric_code(text(p, "code").unwrap_or_default()));
    let start = if let Some(code) = parent_code {
        code + 1.0
    } else {
        let same_kind: Vec<f64> = chart
            .iter()
            .filter(|r| {
                if liability {
                    text(r, "type") == Some("liability")
                } else {
                    text(r, "type") == Some("asset")
                        && matches!(text(r, "subtype"), Some("bank" | "cash"))
                }
            })
            .filter_map(|r| numeric_code(text(r, "code").unwrap_or_default()))
            .collect();
        if same_kind.is_empty() {
            if liability { 2000.0 } else { 1000.0 }
        } else {
            same_kind.iter().copied().fold(f64::NEG_INFINITY, f64::max) + 1.0
        }
    };
    let taken: Vec<&str> = chart.iter().filter_map(|r| text(r, "code")).collect();
    let stamp = now();
    let mut row = Map::new();
    row.insert("id".to_owned(), json!(generate_id("acc")));
    row.insert("entityId".to_owned(), json!(entity_id));
    row.insert("code".to_owned(), json!(next_free_code(&taken, start)));
    row.insert("name".to_owned(), json!(name));
    row.insert("type".to_owned(), json!(side));
    row.insert("subtype".to_owned(), json!(subtype));
    row.insert(
        "normalSide".to_owned(),
        json!(if liability { "credit" } else { "debit" }),
    );
    row.insert(
        "parentAccountId".to_owned(),
        parent
            .and_then(|p| p.get("id").cloned())
            .unwrap_or(Value::Null),
    );
    row.insert("currency".to_owned(), json!(currency));
    row.insert(
        "taxLine".to_owned(),
        sibling
            .and_then(|s| s.get("taxLine").cloned())
            .unwrap_or(Value::Null),
    );
    row.insert("isActive".to_owned(), json!(true));
    row.insert("isSystemAccount".to_owned(), json!(false));
    row.insert("currentBalance".to_owned(), json!("0"));
    row.insert("createdAt".to_owned(), json!(stamp));
    row.insert("updatedAt".to_owned(), json!(stamp));
    Ok(BankLedgerPlan::New(row))
}

/// Insert a planned ledger account ([`BankLedgerPlan::New`]).
pub async fn insert_ledger_account<'e>(
    db: impl sqlx::PgExecutor<'e>,
    row: &Map<String, Value>,
) -> Result<(), sqlx::Error> {
    ACCOUNTS.insert_raw(db, ACCOUNTS.values(row)).await?;
    Ok(())
}

/// `createLedgerAccountForBank(db, { entityId, name, accountType, currency })`
/// (`bank-feeds/ledger.ts`): the ledger account for a bank account created
/// from a feed account. Checking and savings sit with the entity's other
/// bank accounts; a card or line of credit goes under Credit Card Payable
/// when the chart has one. Returns the new account's id.
pub async fn create_ledger_account_for_bank(
    db: &PgPool,
    entity_id: &str,
    name: &str,
    account_type: &str,
    currency: &str,
) -> Result<String, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(accounts),
        " from accounts t where t.entity_id = $1 and t.deleted_at is null"
    ))
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let rows = ACCOUNTS.js_rows(rows);
    let taken: Vec<&str> = rows.iter().filter_map(|r| text(r, "code")).collect();
    let liability = is_liability_account_type(Some(account_type));
    let codes_of = |accounts: Vec<&Value>| -> Vec<f64> {
        accounts
            .into_iter()
            .filter_map(|a| numeric_code(text(a, "code").unwrap_or_default()))
            .collect()
    };
    let max_or = |codes: Vec<f64>, fallback: f64| {
        if codes.is_empty() {
            fallback
        } else {
            codes.into_iter().fold(f64::NEG_INFINITY, f64::max) + 1.0
        }
    };

    let mut parent_id: Option<String> = None;
    let start = if liability {
        let parent = rows
            .iter()
            .find(|a| {
                a.get("metadata")
                    .and_then(|m| m.get("systemRole"))
                    .and_then(Value::as_str)
                    == Some("credit_card_payable")
            })
            .or_else(|| {
                rows.iter().find(|a| {
                    text(a, "type") == Some("liability")
                        && text(a, "subtype") == Some("credit_card")
                })
            });
        parent_id = parent.and_then(|p| text(p, "id")).map(str::to_owned);
        let parent_key = parent.and_then(|p| text(p, "id"));
        let siblings = rows
            .iter()
            .filter(|a| {
                text(a, "type") == Some("liability")
                    && (text(a, "subtype") == Some("credit_card")
                        || (parent_key.is_some() && text(a, "parentAccountId") == parent_key))
            })
            .collect();
        max_or(codes_of(siblings), 2150.0)
    } else {
        let bank = rows
            .iter()
            .filter(|a| text(a, "type") == Some("asset") && text(a, "subtype") == Some("bank"))
            .collect();
        max_or(codes_of(bank), 1000.0)
    };

    let id = generate_id("acc");
    let stamp = now();
    let mut row = Map::new();
    row.insert("id".to_owned(), json!(id));
    row.insert("entityId".to_owned(), json!(entity_id));
    row.insert("code".to_owned(), json!(next_free_code(&taken, start)));
    row.insert("name".to_owned(), json!(name));
    row.insert(
        "type".to_owned(),
        json!(if liability { "liability" } else { "asset" }),
    );
    row.insert(
        "subtype".to_owned(),
        json!(if liability { "credit_card" } else { "bank" }),
    );
    row.insert("parentAccountId".to_owned(), json!(parent_id));
    row.insert("currency".to_owned(), json!(currency));
    row.insert("isActive".to_owned(), json!(true));
    row.insert("isSystemAccount".to_owned(), json!(false));
    row.insert("openingBalance".to_owned(), json!("0"));
    row.insert("currentBalance".to_owned(), json!("0"));
    row.insert(
        "normalSide".to_owned(),
        json!(if liability { "credit" } else { "debit" }),
    );
    row.insert("createdAt".to_owned(), json!(stamp));
    row.insert("updatedAt".to_owned(), json!(stamp));
    insert_ledger_account(db, &row).await?;
    Ok(id)
}

/// A live bank account as Drizzle returns it (`deleted_at is null`).
pub async fn find_bank_account(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    BANK_ACCOUNTS.find_live(db, id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aba_routing_numbers() {
        assert!(is_valid_aba_routing("021000021"));
        assert!(is_valid_aba_routing("011000015"));
        assert!(!is_valid_aba_routing("021000022"));
        assert!(!is_valid_aba_routing("02100002"));
        assert!(!is_valid_aba_routing("02100002a"));
    }

    #[test]
    fn account_numbers_as_people_type_them() {
        assert_eq!(
            normalize_account_number("1234-5678 9012").as_deref(),
            Some("123456789012")
        );
        assert_eq!(normalize_account_number("12 3"), None);
        assert_eq!(
            normalize_account_number("****1234").as_deref(),
            Some("****1234")
        );
        assert_eq!(normalize_account_number("12#45"), None);
        assert_eq!(last_four("123456789"), "6789");
        assert_eq!(last_four("12"), "12");
    }

    #[test]
    fn public_rows_hide_the_blob() {
        let row = json!({ "id": "ba_1", "accountNumberEncrypted": "v2:aa:bb", "name": "Checking" });
        let public = public_bank_account(&row);
        assert_eq!(public.get("accountNumberEncrypted"), None);
        assert_eq!(public["hasAccountNumber"], json!(true));
        let none = public_bank_account(&json!({ "id": "ba_2", "accountNumberEncrypted": null }));
        assert_eq!(none["hasAccountNumber"], json!(false));
    }

    #[test]
    fn ledger_fit_messages() {
        let asset = json!({ "type": "asset", "code": "1100", "name": "Bank" });
        let expense = json!({ "type": "expense", "code": "4000", "name": "Rent" });
        assert!(assert_ledger_account_fits(&asset, Some("checking")).is_ok());
        assert!(assert_ledger_account_fits(&asset, None).is_ok());
        let Err(BankAccountError::Posting(message)) =
            assert_ledger_account_fits(&asset, Some("credit_card"))
        else {
            panic!("a card on an asset must be refused");
        };
        assert_eq!(
            message,
            "A credit card account needs a liability ledger account, but 1100 Bank is an asset account."
        );
        let Err(BankAccountError::Posting(message)) =
            assert_ledger_account_fits(&expense, Some("savings"))
        else {
            panic!("savings on an expense must be refused");
        };
        assert_eq!(
            message,
            "A savings account needs a asset ledger account, but 4000 Rent is a expense account."
        );
    }

    #[test]
    fn free_codes_skip_the_taken_ones() {
        assert_eq!(next_free_code(&["1000", "1001"], 1000.0), "1002");
        assert_eq!(next_free_code(&[], 2000.0), "2000");
        assert_eq!(numeric_code("1000"), Some(1000.0));
        assert_eq!(numeric_code("10a"), None);
    }
}
