//! Posting a bank line straight to an account (`accounting-bank-categorize`):
//! money that is not a customer payment or a supplier bill (fee refunds,
//! settlements, interest, owner deposits, bank charges).
//!
//! money in:  Dr bank ledger (gross) / Cr category (net), Cr tax payable (tax)
//! money out: Dr category (net), Dr input tax (tax) / Cr bank ledger (gross)
//!
//! The bank amount is tax-inclusive when a rate is chosen. Under the Dutch
//! KOR, and on a US entity, purchase tax is not deductible and stays in the
//! category amount; a US entity's 0% rate writes no tax-ledger row.

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::document_posting::{load_entity, update_with_entry};
use weldsuite_books_domain::guards::{PostingLockKind, is_kor_active};
use weldsuite_books_domain::http::now;
use weldsuite_books_domain::js::{millis_of, round_money};
use weldsuite_books_domain::jurisdictions;
use weldsuite_books_domain::posting::{
    PostError, PostJournalEntryInput, PostingLine, PostingTaxLine, account_for_role,
    load_entity_accounts, post_journal_entry,
};
use weldsuite_books_domain::tables::{BANK_ACCOUNTS, BANK_TRANSACTIONS, TAX_RATES};

use crate::common::text;

fn refuse(message: &str) -> PostError {
    PostError::Posting(message.to_owned())
}

/// What a categorization posted.
pub(crate) struct Categorized {
    pub(crate) journal_entry_id: String,
}

/// `categorizeBankTransaction(db, { txn, categoryAccountId, contactId,
/// taxRateId, userId })`.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub(crate) async fn categorize(
    db: &PgPool,
    txn: &Value,
    category_account_id: &str,
    contact_id: Option<&str>,
    tax_rate_id: Option<&str>,
    user_id: Option<&str>,
) -> Result<Categorized, PostError> {
    if text(txn, "status") != Some("unreconciled") {
        return Err(refuse("Transaction is already reconciled or excluded"));
    }
    if text(txn, "journalEntryId").is_some_and(|v| !v.is_empty()) {
        return Err(refuse("Transaction already has a journal entry"));
    }
    let amount = weldsuite_books_domain::js::js_number_value(txn.get("amount"));
    let gross = round_money(amount.abs());
    if !gross.is_finite() || gross == 0.0 {
        return Err(refuse("Transaction amount must be non-zero"));
    }
    let money_in = amount > 0.0;
    let entity_id = text(txn, "entityId").unwrap_or_default();

    let bank: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(bank_accounts),
        " from bank_accounts t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(text(txn, "bankAccountId"))
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let Some(bank) = bank.map(|row| BANK_ACCOUNTS.js(row)) else {
        return Err(refuse("Bank account not found"));
    };
    let accounts = load_entity_accounts(db, entity_id).await?;
    let ledger_id = text(&bank, "ledgerAccountId").filter(|v| !v.is_empty());
    let ledger = accounts.by_id(ledger_id);
    if ledger_id.is_none() {
        return Err(refuse(
            "This bank account is not linked to a ledger account. Edit the bank account and choose a GL account first.",
        ));
    }
    let Some(ledger) = ledger else {
        return Err(refuse("Linked ledger account was not found"));
    };
    let Some(category) = accounts.by_id(Some(category_account_id)) else {
        return Err(refuse("Category account not found"));
    };
    let ledger_id = text(ledger, "id").unwrap_or_default().to_owned();
    let category_id = text(category, "id").unwrap_or_default().to_owned();
    if category_id == ledger_id {
        return Err(refuse(
            "Pick an income or expense account, not the bank ledger account itself",
        ));
    }

    let entity = load_entity(db, entity_id).await?;
    let contact = contact_id
        .filter(|c| !c.is_empty())
        .or_else(|| text(txn, "contactId").filter(|c| !c.is_empty()))
        .map(str::to_owned);
    let currency = text(&bank, "currency")
        .filter(|c| !c.is_empty())
        .or_else(|| text(&entity, "baseCurrency"))
        .map(str::to_owned);
    let counterparty = text(txn, "counterpartyName")
        .filter(|c| !c.is_empty())
        .map(|name| format!(" — {name}"))
        .unwrap_or_default();
    let description = match text(txn, "description").filter(|d| !d.is_empty()) {
        Some(text) => format!("Bank: {text}{counterparty}"),
        None if money_in => format!("Bank receipt{counterparty}"),
        None => format!("Bank payment{counterparty}"),
    };
    let line = |account_id: &str, debit: f64, credit: f64| PostingLine {
        account_id: account_id.to_owned(),
        debit,
        credit,
        description: Some(description.clone()),
        contact_id: contact.clone(),
        currency: currency.clone(),
        ..PostingLine::default()
    };

    let mut tax = 0.0;
    let mut tax_lines: Vec<PostingTaxLine> = Vec::new();
    let mut tax_account_id: Option<String> = None;
    let tax_rate_id = tax_rate_id.filter(|t| !t.is_empty());
    if let Some(rate_id) = tax_rate_id {
        let rate: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(tax_rates),
            " from tax_rates t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
        ))
        .bind(rate_id)
        .bind(entity_id)
        .fetch_optional(db)
        .await?;
        let Some(rate) = rate.map(|row| TAX_RATES.js(row)) else {
            return Err(refuse("Tax rate not found for this accounting entity"));
        };
        let percent = weldsuite_books_domain::js::js_number_value(rate.get("rate"));
        let code = text(&entity, "jurisdictionCode").unwrap_or_default();
        let known = jurisdictions::has_adapter(code);
        let sales_tax_entity = known && jurisdictions::features(Some(code))["salesTax"] == json!(true);
        let purchase_is_cost = known
            && jurisdictions::adapter(code).and_then(|a| a.purchase_tax) == Some("cost");
        let at = text(txn, "date").and_then(millis_of).unwrap_or(0);
        let deductible = money_in
            || (!is_kor_active(code, entity.get("jurisdictionSettings"), at) && !purchase_is_cost);
        tax = round_money((gross * percent) / (100.0 + percent));
        if deductible {
            let direction = if money_in { "sales" } else { "purchase" };
            let tax_account = accounts
                .by_id(text(&rate, "ledgerAccountId"))
                .or_else(|| {
                    (direction == "purchase")
                        .then(|| account_for_role(&accounts, "tax_input", &["1730"]))
                        .flatten()
                })
                .or_else(|| account_for_role(&accounts, "tax_payable", &["1700"]))
                .or_else(|| account_for_role(&accounts, "sales_tax_payable", &[]));
            if tax_account.is_none() && tax > 0.0 {
                return Err(refuse(
                    "No tax account found. Link the tax rate to a ledger account.",
                ));
            }
            tax_account_id = tax_account.and_then(|a| text(a, "id")).map(str::to_owned);
            #[allow(clippy::float_cmp)] // `tax === 0`
            let nothing = sales_tax_entity && tax == 0.0;
            if !nothing {
                tax_lines.push(PostingTaxLine {
                    direction: direction.to_owned(),
                    tax_rate_id: text(&rate, "id").map(str::to_owned),
                    tax_rate_name: text(&rate, "name").map(str::to_owned),
                    tax_category_code: text(&rate, "taxCategoryCode").map(str::to_owned),
                    rate: percent,
                    taxable_amount: round_money(gross - tax),
                    tax_amount: tax,
                    currency: currency.clone().unwrap_or_default(),
                    base_taxable_amount: round_money(gross - tax),
                    base_tax_amount: tax,
                    contact_id: contact.clone(),
                    ..PostingTaxLine::default()
                });
            }
        } else {
            tax = 0.0;
        }
    }
    let net = round_money(gross - tax);
    let tax_line = |debit: bool| {
        tax_account_id.as_deref().filter(|_| tax > 0.0).map(|account| PostingLine {
            tax_rate_id: tax_rate_id.map(str::to_owned),
            tax_amount: Some(tax),
            ..if debit {
                line(account, tax, 0.0)
            } else {
                line(account, 0.0, tax)
            }
        })
    };
    let lines: Vec<PostingLine> = if money_in {
        [Some(line(&ledger_id, gross, 0.0)), Some(line(&category_id, 0.0, net)), tax_line(false)]
            .into_iter()
            .flatten()
            .collect()
    } else {
        [Some(line(&category_id, net, 0.0)), tax_line(true), Some(line(&ledger_id, 0.0, gross))]
            .into_iter()
            .flatten()
            .collect()
    };

    let txn_id = text(txn, "id").unwrap_or_default().to_owned();
    let version = text(txn, "updatedAt").and_then(millis_of).unwrap_or(0);
    let mut set = Map::new();
    set.insert("status".to_owned(), json!("reconciled"));
    set.insert("reconciliationType".to_owned(), json!("manual"));
    set.insert("categoryAccountId".to_owned(), json!(category_account_id));
    set.insert("taxRateId".to_owned(), json!(tax_rate_id));
    set.insert("contactId".to_owned(), json!(contact));
    set.insert("updatedAt".to_owned(), json!(now()));
    let posted = post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: entity_id.to_owned(),
            date: text(txn, "date").unwrap_or_default().to_owned(),
            description: description.clone(),
            reference: text(txn, "reference").filter(|r| !r.is_empty()).map(str::to_owned),
            source_type: "bank_transaction".to_owned(),
            source_id: Some(txn_id.clone()),
            posting_key: Some(format!("bank_transaction:{txn_id}:categorize:{version}")),
            lock_kind: Some(PostingLockKind::General),
            lines,
            tax_lines,
            created_by: user_id.map(str::to_owned),
            also_write: vec![update_with_entry(
                &BANK_TRANSACTIONS,
                txn_id,
                set,
                Some("journalEntryId"),
            )],
            ..PostJournalEntryInput::default()
        },
    )
    .await?;
    match (posted.journal_entry_id, posted.entry_number) {
        (Some(journal_entry_id), Some(_)) => Ok(Categorized { journal_entry_id }),
        _ => Err(refuse("Nothing to post for this transaction")),
    }
}
