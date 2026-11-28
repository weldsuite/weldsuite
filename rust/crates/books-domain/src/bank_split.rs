//! Booking a bank line to several categories at once
//! (`POST /api/bank-transactions/:id/categorize`), and the transfer and
//! private bookings that are one part without tax. The single-account
//! [`crate::bank_categorize::categorize`] stays as it is (it is a ported,
//! conformance-covered route); this is its generalisation for Rust-only
//! routes (edition feature `books-bank-processing`).
//!
//! money in:  Dr bank ledger (gross) / Cr each category (net), Cr tax payable
//! money out: Dr each category (net), Dr input tax / Cr bank ledger (gross)
//!
//! Every part's amount is tax-inclusive and the parts add up to the line.

use std::collections::HashMap;

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{bank_accounts, tax_rates};

use crate::document_posting::{load_entity, text, update_with_entry};
use crate::guards::{PostingLockKind, is_kor_active};
use crate::http::now;
use crate::js::{millis_of, round_money, to_fixed};
use crate::jurisdictions;
use crate::posting::{
    EntityAccounts, PostError, PostJournalEntryInput, PostingLine, PostingTaxLine,
    account_for_role, assert_projects_exist, load_entity_accounts, post_journal_entry,
};
use crate::tables::BANK_TRANSACTIONS;

fn refuse(message: impl Into<String>) -> PostError {
    PostError::Posting(message.into())
}

/// A row as Drizzle returns it.
fn js<M: serde::Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// What a booking posted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Booked {
    pub journal_entry_id: String,
}

/// One part of a split line.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SplitLine {
    pub account_id: String,
    pub tax_rate_id: Option<String>,
    pub contact_id: Option<String>,
    /// The `WeldFlow` project the cost belongs to.
    pub project_id: Option<String>,
    /// Tax-inclusive, positive, in the bank line's currency.
    pub amount: f64,
    pub description: Option<String>,
}

/// How a line is booked to its categories.
#[derive(Debug, Clone, Copy)]
pub struct Split<'a> {
    pub lines: &'a [SplitLine],
    /// The `reconciliation_type` the line gets: `manual` (by hand), `auto`,
    /// `transfer`, `private`.
    pub kind: &'a str,
    pub user_id: Option<&'a str>,
}

/// What one part books.
struct PartTax {
    tax: f64,
    tax_account_id: Option<String>,
    tax_line: Option<PostingTaxLine>,
}

/// The tax inside a tax-inclusive `gross` at `rate`, as the single-account
/// categorization books it: a sale's tax is always due, a purchase's only
/// when it is deductible (not under the Dutch KOR, not where purchase tax is
/// a cost, not on a US entity).
struct TaxFacts<'a> {
    gross: f64,
    money_in: bool,
    entity: &'a Value,
    txn: &'a Value,
    accounts: &'a EntityAccounts,
    currency: Option<&'a str>,
    contact: Option<&'a str>,
}

fn part_tax(rate: &Value, facts: &TaxFacts<'_>) -> Result<PartTax, PostError> {
    let TaxFacts {
        gross,
        money_in,
        entity,
        txn,
        accounts,
        currency,
        contact,
    } = *facts;
    let percent = crate::js::js_number_value(rate.get("rate"));
    let code = text(entity, "jurisdictionCode").unwrap_or_default();
    let known = jurisdictions::has_adapter(code);
    let sales_tax_entity = known && jurisdictions::features(Some(code))["salesTax"] == json!(true);
    let purchase_is_cost =
        known && jurisdictions::adapter(code).and_then(|a| a.purchase_tax) == Some("cost");
    let at = text(txn, "date").and_then(millis_of).unwrap_or(0);
    let deductible = money_in
        || (!is_kor_active(code, entity.get("jurisdictionSettings"), at) && !purchase_is_cost);
    if !deductible {
        return Ok(PartTax {
            tax: 0.0,
            tax_account_id: None,
            tax_line: None,
        });
    }
    let tax = round_money((gross * percent) / (100.0 + percent));
    let direction = if money_in { "sales" } else { "purchase" };
    let tax_account = accounts
        .by_id(text(rate, "ledgerAccountId"))
        .or_else(|| {
            (direction == "purchase")
                .then(|| account_for_role(accounts, "tax_input", &["1730"]))
                .flatten()
        })
        .or_else(|| account_for_role(accounts, "tax_payable", &["1700"]))
        .or_else(|| account_for_role(accounts, "sales_tax_payable", &[]));
    if tax_account.is_none() && tax > 0.0 {
        return Err(refuse(
            "No tax account found. Link the tax rate to a ledger account.",
        ));
    }
    #[allow(clippy::float_cmp)] // `tax === 0`
    let nothing = sales_tax_entity && tax == 0.0;
    let tax_line = (!nothing).then(|| PostingTaxLine {
        direction: direction.to_owned(),
        tax_rate_id: text(rate, "id").map(str::to_owned),
        tax_rate_name: text(rate, "name").map(str::to_owned),
        tax_category_code: text(rate, "taxCategoryCode").map(str::to_owned),
        rate: percent,
        taxable_amount: round_money(gross - tax),
        tax_amount: tax,
        currency: currency.unwrap_or_default().to_owned(),
        base_taxable_amount: round_money(gross - tax),
        base_tax_amount: tax,
        contact_id: contact.map(str::to_owned),
        ..PostingTaxLine::default()
    });
    Ok(PartTax {
        tax,
        tax_account_id: tax_account.and_then(|a| text(a, "id")).map(str::to_owned),
        tax_line,
    })
}

/// Book a bank line to one or more categories as **one** journal entry,
/// through the posting service (BOOKS-001). Each part's tax is split off by
/// its own rate and the tax-ledger rows are written as for a document.
///
/// The line becomes `reconciled` with `reconciliation_type = split.kind`, its
/// journal entry, and `category_account_id` of the first part. The parts must
/// add up to the line's absolute amount.
#[allow(clippy::too_many_lines)] // the checks, the lines, the write
pub async fn book_split(db: &PgPool, txn: &Value, split: Split<'_>) -> Result<Booked, PostError> {
    let Split {
        lines: parts,
        kind,
        user_id,
    } = split;
    if text(txn, "status") != Some("unreconciled") {
        return Err(refuse("Transaction is already reconciled or excluded"));
    }
    if text(txn, "journalEntryId").is_some_and(|v| !v.is_empty()) {
        return Err(refuse("Transaction already has a journal entry"));
    }
    let amount = crate::js::js_number_value(txn.get("amount"));
    let gross = round_money(amount.abs());
    if !gross.is_finite() || gross == 0.0 {
        return Err(refuse("Transaction amount must be non-zero"));
    }
    let money_in = amount > 0.0;
    if parts.is_empty() {
        return Err(refuse("Pick at least one category"));
    }
    let mut total = 0.0;
    for part in parts {
        let part_amount = round_money(part.amount);
        if !part_amount.is_finite() || part_amount <= 0.0 {
            return Err(refuse("Every amount must be greater than zero"));
        }
        total = round_money(total + part_amount);
    }
    #[allow(clippy::float_cmp)] // both are `roundMoney` values
    if total != gross {
        return Err(refuse(format!(
            "The lines add up to {} but the bank line is {}",
            to_fixed(total, 2),
            to_fixed(gross, 2)
        )));
    }
    let entity_id = text(txn, "entityId").unwrap_or_default();

    let bank = bank_accounts::Entity::find()
        .filter(bank_accounts::Column::Id.eq(text(txn, "bankAccountId")))
        .filter(bank_accounts::Column::EntityId.eq(entity_id))
        .filter(bank_accounts::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    let Some(bank) = bank.map(js).transpose()? else {
        return Err(refuse("Bank account not found"));
    };
    let accounts = load_entity_accounts(db, entity_id).await?;
    let ledger_id = text(&bank, "ledgerAccountId").filter(|v| !v.is_empty());
    if ledger_id.is_none() {
        return Err(refuse(
            "This bank account is not linked to a ledger account. Edit the bank account and choose a GL account first.",
        ));
    }
    let Some(ledger) = accounts.by_id(ledger_id) else {
        return Err(refuse("Linked ledger account was not found"));
    };
    let ledger_id = text(ledger, "id").unwrap_or_default().to_owned();
    for part in parts {
        let Some(category) = accounts.by_id(Some(part.account_id.as_str())) else {
            return Err(refuse("Category account not found"));
        };
        if text(category, "id") == Some(ledger_id.as_str()) {
            return Err(refuse(
                "Pick an income or expense account, not the bank ledger account itself",
            ));
        }
    }
    assert_projects_exist(db, parts.iter().map(|p| p.project_id.clone())).await?;

    let entity = load_entity(db, entity_id).await?;
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
    let line_contact = |part: &SplitLine| {
        part.contact_id
            .clone()
            .filter(|c| !c.is_empty())
            .or_else(|| {
                text(txn, "contactId")
                    .filter(|c| !c.is_empty())
                    .map(str::to_owned)
            })
    };

    let mut rates: HashMap<String, Value> = HashMap::new();
    for rate_id in parts
        .iter()
        .filter_map(|p| p.tax_rate_id.as_deref().filter(|t| !t.is_empty()))
    {
        if rates.contains_key(rate_id) {
            continue;
        }
        let rate = tax_rates::Entity::find()
            .filter(tax_rates::Column::Id.eq(rate_id))
            .filter(tax_rates::Column::EntityId.eq(entity_id))
            .filter(tax_rates::Column::DeletedAt.is_null())
            .one(&orm(db))
            .await?;
        let Some(rate) = rate.map(js).transpose()? else {
            return Err(refuse("Tax rate not found for this accounting entity"));
        };
        rates.insert(rate_id.to_owned(), rate);
    }

    let mut posting_lines: Vec<PostingLine> = Vec::new();
    let mut tax_lines: Vec<PostingTaxLine> = Vec::new();
    let mut bank_line = PostingLine {
        account_id: ledger_id.clone(),
        description: Some(description.clone()),
        currency: currency.clone(),
        contact_id: parts.first().and_then(line_contact),
        ..PostingLine::default()
    };
    if money_in {
        bank_line.debit = gross;
        posting_lines.push(bank_line.clone());
    } else {
        bank_line.credit = gross;
    }
    for part in parts {
        let part_gross = round_money(part.amount);
        let contact = line_contact(part);
        let rate_id = part.tax_rate_id.as_deref().filter(|t| !t.is_empty());
        let tax = match rate_id.and_then(|id| rates.get(id)) {
            Some(rate) => part_tax(
                rate,
                &TaxFacts {
                    gross: part_gross,
                    money_in,
                    entity: &entity,
                    txn,
                    accounts: &accounts,
                    currency: currency.as_deref(),
                    contact: contact.as_deref(),
                },
            )?,
            None => PartTax {
                tax: 0.0,
                tax_account_id: None,
                tax_line: None,
            },
        };
        let net = round_money(part_gross - tax.tax);
        let line_text = part
            .description
            .clone()
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| description.clone());
        let line = |account_id: &str, debit: f64, credit: f64| PostingLine {
            account_id: account_id.to_owned(),
            debit,
            credit,
            description: Some(line_text.clone()),
            contact_id: contact.clone(),
            currency: currency.clone(),
            ..PostingLine::default()
        };
        let mut category = if money_in {
            line(&part.account_id, 0.0, net)
        } else {
            line(&part.account_id, net, 0.0)
        };
        category.project_id = part.project_id.clone().filter(|p| !p.is_empty());
        posting_lines.push(category);
        if let Some(tax_account) = tax.tax_account_id.as_deref().filter(|_| tax.tax > 0.0) {
            let mut tax_posting = if money_in {
                line(tax_account, 0.0, tax.tax)
            } else {
                line(tax_account, tax.tax, 0.0)
            };
            tax_posting.tax_rate_id = rate_id.map(str::to_owned);
            tax_posting.tax_amount = Some(tax.tax);
            posting_lines.push(tax_posting);
        }
        tax_lines.extend(tax.tax_line);
    }
    if !money_in {
        posting_lines.push(bank_line);
    }

    let first = &parts[0];
    let txn_id = text(txn, "id").unwrap_or_default().to_owned();
    let version = text(txn, "updatedAt").and_then(millis_of).unwrap_or(0);
    let mut set = Map::new();
    set.insert("status".to_owned(), json!("reconciled"));
    set.insert("reconciliationType".to_owned(), json!(kind));
    set.insert("categoryAccountId".to_owned(), json!(first.account_id));
    set.insert(
        "taxRateId".to_owned(),
        json!(first.tax_rate_id.as_deref().filter(|t| !t.is_empty())),
    );
    set.insert("contactId".to_owned(), json!(line_contact(first)));
    set.insert("updatedAt".to_owned(), json!(now()));
    let posted = post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: entity_id.to_owned(),
            date: text(txn, "date").unwrap_or_default().to_owned(),
            description: description.clone(),
            reference: text(txn, "reference")
                .filter(|r| !r.is_empty())
                .map(str::to_owned),
            source_type: "bank_transaction".to_owned(),
            source_id: Some(txn_id.clone()),
            posting_key: Some(format!("bank_transaction:{txn_id}:{kind}:{version}")),
            lock_kind: Some(PostingLockKind::General),
            lines: posting_lines,
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
        (Some(journal_entry_id), Some(_)) => Ok(Booked { journal_entry_id }),
        _ => Err(refuse("Nothing to post for this transaction")),
    }
}
