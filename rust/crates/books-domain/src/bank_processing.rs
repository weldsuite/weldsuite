//! Processing bank lines beyond matching them to documents (edition feature
//! `books-bank-processing`, Rust only):
//!
//! - **Transfers** between the entity's own accounts, booked against the
//!   transfers-in-transit clearing account; the line on the other account,
//!   when it is already there, is booked the same way. Pairing is for display
//!   only, so a transfer that lands a day later still balances.
//! - **One undo** for every kind of processing: a payment match, a deposit
//!   link, a categorisation, a transfer, a private payment, an ignored line.
//! - **Auto-processing** for what is certain: a transfer to an own IBAN, and
//!   (NL) a payment to the Belastingdienst that names a VAT return. Such a
//!   line is `reconciliation_type = 'auto'` and the reason is derived from
//!   the columns it already has ([`automatic_reason`]), so no new column.

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{bank_accounts, bank_transactions};

use crate::bank_matching::{days_apart, unreconcile};
use crate::bank_split::{Split, SplitLine, book_split};
use crate::db_values::to_json_rows;
use crate::document_posting::{load_entity, text};
use crate::http::now;
use crate::js::{js_number_value, parse_float, round_money};
use crate::jurisdictions::nl;
use crate::posting::{PostError, account_for_role, load_entity_accounts};
use crate::reconciliation_rules::{load_active_rules, rule_matches};
use crate::system_accounts::{TRANSFERS_IN_TRANSIT, ensure_role_account};
use crate::tables::BANK_TRANSACTIONS;

/// How far apart (in days) the two lines of a transfer may be dated.
pub const TRANSFER_WINDOW_DAYS: i64 = 5;

fn posting(message: impl Into<String>) -> PostError {
    PostError::Posting(message.into())
}

/// An IBAN without spaces, in capitals.
pub fn normalize_iban(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_uppercase()
}

/// The entity's live bank accounts: id and normalized IBAN (empty when it has
/// none).
pub async fn own_accounts(db: &PgPool, entity_id: &str) -> Result<Vec<(String, String)>, DbErr> {
    let rows: Vec<(String, Option<String>)> = bank_accounts::Entity::find()
        .select_only()
        .columns([bank_accounts::Column::Id, bank_accounts::Column::Iban])
        .filter(bank_accounts::Column::EntityId.eq(entity_id))
        .filter(bank_accounts::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, iban)| (id, iban.as_deref().map(normalize_iban).unwrap_or_default()))
        .collect())
}

/// The other own account a line's counterparty IBAN names, when it is one.
pub fn own_account_of_iban<'a>(
    own: &'a [(String, String)],
    iban: Option<&str>,
    this_account: &str,
) -> Option<&'a str> {
    let wanted = normalize_iban(iban.filter(|i| !i.is_empty())?);
    own.iter()
        .find(|(id, own_iban)| id != this_account && !own_iban.is_empty() && *own_iban == wanted)
        .map(|(id, _)| id.as_str())
}

/// The line on `other_account` that is the other half of the transfer `txn`
/// is one half of: unprocessed, the opposite amount, dated within
/// [`TRANSFER_WINDOW_DAYS`]; the closest date wins.
pub async fn counterpart_line(
    db: &PgPool,
    txn: &Value,
    other_account: &str,
) -> Result<Option<Value>, DbErr> {
    let amount = round_money(parse_float(text(txn, "amount").unwrap_or("0")));
    if amount == 0.0 {
        return Ok(None);
    }
    let rows = bank_transactions::Entity::find()
        .filter(bank_transactions::Column::EntityId.eq(text(txn, "entityId").unwrap_or_default()))
        .filter(bank_transactions::Column::BankAccountId.eq(other_account))
        .filter(bank_transactions::Column::Status.eq("unreconciled"))
        .filter(bank_transactions::Column::DeletedAt.is_null())
        .order_by_desc(bank_transactions::Column::Date)
        .limit(500)
        .all(&orm(db))
        .await?;
    let date = text(txn, "date").unwrap_or_default();
    let mut best: Option<(i64, Value)> = None;
    for row in to_json_rows(rows)? {
        let other = round_money(parse_float(text(&row, "amount").unwrap_or("0")));
        #[allow(clippy::float_cmp)] // both are `roundMoney` values
        if other != -amount {
            continue;
        }
        let apart = days_apart(date, text(&row, "date").unwrap_or_default());
        if apart > TRANSFER_WINDOW_DAYS {
            continue;
        }
        if best.as_ref().is_none_or(|(closest, _)| apart < *closest) {
            best = Some((apart, row));
        }
    }
    Ok(best.map(|(_, row)| row))
}

/// The other half of a transfer already booked: a reconciled line on another
/// own account, booked to the transit account, with the opposite amount,
/// within [`TRANSFER_WINDOW_DAYS`]. For showing a pair.
pub async fn booked_counterpart(
    db: &PgPool,
    txn: &Value,
    transit_account_id: &str,
) -> Result<Option<Value>, DbErr> {
    let amount = round_money(parse_float(text(txn, "amount").unwrap_or("0")));
    let rows = bank_transactions::Entity::find()
        .filter(bank_transactions::Column::EntityId.eq(text(txn, "entityId").unwrap_or_default()))
        .filter(
            bank_transactions::Column::BankAccountId
                .ne(text(txn, "bankAccountId").unwrap_or_default()),
        )
        .filter(bank_transactions::Column::Status.eq("reconciled"))
        .filter(bank_transactions::Column::CategoryAccountId.eq(transit_account_id))
        .filter(bank_transactions::Column::DeletedAt.is_null())
        .order_by_desc(bank_transactions::Column::Date)
        .limit(500)
        .all(&orm(db))
        .await?;
    let date = text(txn, "date").unwrap_or_default();
    let mut best: Option<(i64, Value)> = None;
    for row in to_json_rows(rows)? {
        let other = round_money(parse_float(text(&row, "amount").unwrap_or("0")));
        #[allow(clippy::float_cmp)] // both are `roundMoney` values
        if other != -amount {
            continue;
        }
        let apart = days_apart(date, text(&row, "date").unwrap_or_default());
        if apart <= TRANSFER_WINDOW_DAYS && best.as_ref().is_none_or(|(c, _)| apart < *c) {
            best = Some((apart, row));
        }
    }
    Ok(best.map(|(_, row)| row))
}

/// The other half of a transfer, booked with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Counterpart {
    pub line_id: String,
    pub bank_account_id: String,
    pub journal_entry_id: String,
}

/// What a transfer booked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transferred {
    pub journal_entry_id: String,
    pub transit_account_id: String,
    pub counterpart: Option<Counterpart>,
}

/// One part, the whole line, to `account_id`.
fn whole(txn: &Value, account_id: &str) -> SplitLine {
    SplitLine {
        account_id: account_id.to_owned(),
        amount: round_money(js_number_value(txn.get("amount")).abs()),
        ..SplitLine::default()
    }
}

/// Book a line against the transfers-in-transit account, and the line on the
/// other own account the same way when it is already there. `other_account`
/// names that account; without it a counterparty IBAN of the entity's own
/// identifies it. `kind` is the `reconciliation_type` the line gets
/// (`transfer`, or `auto` when the matcher is sure).
pub async fn book_transfer(
    db: &PgPool,
    txn: &Value,
    other_account: Option<&str>,
    kind: &str,
    user_id: Option<&str>,
) -> Result<Transferred, PostError> {
    let entity_id = text(txn, "entityId").unwrap_or_default();
    let this_account = text(txn, "bankAccountId").unwrap_or_default();
    let own = own_accounts(db, entity_id).await?;
    let other = match other_account.filter(|a| !a.is_empty()) {
        Some(given) => {
            if given == this_account || !own.iter().any(|(id, _)| id == given) {
                return Err(posting(
                    "Pick one of this entity's other bank accounts for the transfer",
                ));
            }
            Some(given.to_owned())
        }
        None => own_account_of_iban(&own, text(txn, "counterpartyIban"), this_account)
            .map(str::to_owned),
    };
    let transit = ensure_role_account(db, entity_id, TRANSFERS_IN_TRANSIT).await?;
    let transit_id = text(&transit, "id").unwrap_or_default().to_owned();
    let booked = book_split(
        db,
        txn,
        Split {
            lines: &[whole(txn, &transit_id)],
            kind,
            user_id,
        },
    )
    .await?;
    let mut counterpart = None;
    if let Some(other) = other
        && let Some(line) = counterpart_line(db, txn, &other).await?
    {
        match book_split(
            db,
            &line,
            Split {
                lines: &[whole(&line, &transit_id)],
                kind,
                user_id,
            },
        )
        .await
        {
            Ok(done) => {
                counterpart = Some(Counterpart {
                    line_id: text(&line, "id").unwrap_or_default().to_owned(),
                    bank_account_id: other,
                    journal_entry_id: done.journal_entry_id,
                });
            }
            Err(error) => tracing::warn!(
                line = text(&line, "id").unwrap_or_default(),
                %error,
                "[transfer] the other half stays to process"
            ),
        }
    }
    Ok(Transferred {
        journal_entry_id: booked.journal_entry_id,
        transit_account_id: transit_id,
        counterpart,
    })
}

/// What an undo took back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Undone {
    /// `payment`, `deposit`, `category`, `transfer`, `private` or `ignore`.
    pub what: &'static str,
    /// The line had been booked by the automatic matcher.
    pub automatic: bool,
    /// The entry that was reversed.
    pub journal_entry_id: Option<String>,
    /// The payment the match had created, now void.
    pub payment_voided_id: Option<String>,
}

impl Undone {
    pub fn to_json(&self, line_id: &str) -> Value {
        json!({
            "id": line_id,
            "status": "unreconciled",
            "undone": self.what,
            "automatic": self.automatic,
            "reversedJournalEntryId": self.journal_entry_id,
            "voidedPaymentId": self.payment_voided_id,
        })
    }
}

fn filled<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    text(row, key).filter(|v| !v.is_empty())
}

/// What a processed line was processed as.
fn processed_as(txn: &Value) -> Undone {
    let kind = text(txn, "reconciliationType");
    let automatic = kind == Some("auto");
    let payment = filled(txn, "reconciledPaymentId");
    let linked = kind == Some(crate::bank_matching::PAYMENT_LINK);
    let what = if text(txn, "status") == Some("excluded") {
        "ignore"
    } else if kind == Some(crate::bank_matching::DEPOSIT_LINK) {
        "deposit"
    } else if payment.is_some() {
        "payment"
    } else if kind == Some("transfer") {
        "transfer"
    } else if kind == Some("private") {
        "private"
    } else {
        "category"
    };
    Undone {
        what,
        automatic,
        // A payment match that created its payment voids it (the entry is
        // the payment's); a link leaves the payment as it was.
        journal_entry_id: filled(txn, "journalEntryId")
            .filter(|_| payment.is_none())
            .map(str::to_owned),
        payment_voided_id: payment.filter(|_| !linked).map(str::to_owned),
    }
}

/// One undo for every kind of processing: a payment match (voiding the
/// payment it created, or only unlinking one that was there), a deposit
/// link, a categorisation, a transfer or a private booking (their entry is
/// reversed), an ignored line (back to unprocessed). Closed periods refuse
/// the reversal as they refuse any posting.
pub async fn undo_line(
    db: &PgPool,
    txn: &Value,
    user_id: Option<String>,
) -> Result<Undone, PostError> {
    match text(txn, "status") {
        Some("unreconciled") | None => Err(posting("Transaction has not been processed")),
        Some("excluded") => {
            let mut set = Map::new();
            set.insert("status".to_owned(), json!("unreconciled"));
            set.insert("updatedAt".to_owned(), json!(now()));
            BANK_TRANSACTIONS
                .patch_raw(
                    db,
                    text(txn, "id").unwrap_or_default(),
                    BANK_TRANSACTIONS.values(&set),
                    false,
                )
                .await?;
            Ok(processed_as(txn))
        }
        Some(_) => {
            let undone = processed_as(txn);
            unreconcile(db, txn, user_id).await?;
            Ok(undone)
        }
    }
}

// ── Auto-processing ─────────────────────────────────────────────────────────

/// What the automatic matcher needs to know about the entity, read once per
/// batch.
#[derive(Debug, Clone, Default)]
pub struct AutoContext {
    /// The entity's bank accounts: id and normalized IBAN.
    pub own: Vec<(String, String)>,
    /// NL: the account payments to the tax authority are booked to (VAT
    /// payable), when the entity is Dutch and has one.
    pub vat_payable_account_id: Option<String>,
}

/// Read the [`AutoContext`] of an entity.
pub async fn auto_context(db: &PgPool, entity_id: &str) -> Result<AutoContext, PostError> {
    let own = own_accounts(db, entity_id).await?;
    let entity = load_entity(db, entity_id).await?;
    let vat_payable_account_id =
        if text(&entity, "jurisdictionCode").is_some_and(|c| c.eq_ignore_ascii_case("NL")) {
            let accounts = load_entity_accounts(db, entity_id).await?;
            account_for_role(&accounts, "tax_payable", &["1700"])
                .and_then(|a| text(a, "id"))
                .map(str::to_owned)
        } else {
            None
        };
    Ok(AutoContext {
        own,
        vat_payable_account_id,
    })
}

/// A transfer to one of the entity's own IBANs is certain: book it against
/// transit, with its other half when that is there. The kind and the
/// transfer's entry, or `None` when the line isn't one or can't be booked.
pub async fn auto_transfer(
    db: &PgPool,
    txn: &Value,
    context: &AutoContext,
    user_id: Option<&str>,
) -> Option<(&'static str, String)> {
    let this_account = text(txn, "bankAccountId").unwrap_or_default();
    own_account_of_iban(&context.own, text(txn, "counterpartyIban"), this_account)?;
    match book_transfer(db, txn, None, "auto", user_id).await {
        Ok(done) => Some(("transfer", done.journal_entry_id)),
        Err(error) => {
            tracing::warn!(
                line = text(txn, "id").unwrap_or_default(),
                %error,
                "[auto-reconcile] transfer left to process"
            );
            None
        }
    }
}

/// A payment out to the Belastingdienst whose description names a VAT return
/// (*aangifte*, *btw*, *omzetbelasting*) is booked to VAT payable. Anything
/// less certain (other tax, no reference) stays to process.
pub async fn auto_tax_authority(
    db: &PgPool,
    txn: &Value,
    context: &AutoContext,
    user_id: Option<&str>,
) -> Option<(&'static str, String)> {
    let account = context.vat_payable_account_id.as_deref()?;
    if js_number_value(txn.get("amount")) >= 0.0 {
        return None;
    }
    if !text(txn, "counterpartyIban").is_some_and(nl::is_tax_authority_iban) {
        return None;
    }
    let described = [
        text(txn, "description"),
        text(txn, "reference"),
        text(txn, "endToEndId"),
    ]
    .into_iter()
    .flatten()
    .any(nl::names_vat_return);
    if !described {
        return None;
    }
    let outcome = book_split(
        db,
        txn,
        Split {
            lines: &[whole(txn, account)],
            kind: "auto",
            user_id,
        },
    )
    .await;
    match outcome {
        Ok(done) => Some(("tax_authority", done.journal_entry_id)),
        Err(error) => {
            tracing::warn!(
                line = text(txn, "id").unwrap_or_default(),
                %error,
                "[auto-reconcile] tax payment left to process"
            );
            None
        }
    }
}

/// Why a line was booked automatically, derived from the columns it has
/// (`reconciliation_type = 'auto'`; no column of its own):
///
/// - `document_match`: it carries a payment (an invoice, bill or payment
///   matched with enough confidence);
/// - `own_account_transfer`: it was booked to the transit account;
/// - `tax_authority`: NL, booked to VAT payable, paid to the Belastingdienst;
/// - `rule`: otherwise, a reconciliation rule categorized it (`ruleId` and
///   `ruleName` when an active rule still matches it).
///
/// `None` when the line was not booked automatically.
pub async fn automatic_reason(db: &PgPool, txn: &Value) -> Result<Option<Value>, PostError> {
    if text(txn, "reconciliationType") != Some("auto") || text(txn, "status") != Some("reconciled")
    {
        return Ok(None);
    }
    let entity_id = text(txn, "entityId").unwrap_or_default();
    if filled(txn, "reconciledPaymentId").is_some() {
        return Ok(Some(json!({ "reason": "document_match" })));
    }
    let category = filled(txn, "categoryAccountId");
    let accounts = load_entity_accounts(db, entity_id).await?;
    let account_id = |role: &str, fallback: &[&str]| {
        account_for_role(&accounts, role, fallback)
            .and_then(|a| text(a, "id"))
            .map(str::to_owned)
    };
    if category.is_some() && category == account_id(TRANSFERS_IN_TRANSIT, &[]).as_deref() {
        return Ok(Some(json!({ "reason": "own_account_transfer" })));
    }
    if category.is_some()
        && text(txn, "counterpartyIban").is_some_and(nl::is_tax_authority_iban)
        && category == account_id("tax_payable", &["1700"]).as_deref()
    {
        return Ok(Some(json!({ "reason": "tax_authority" })));
    }
    let rules = load_active_rules(db, entity_id).await?;
    let rule = rules.iter().find(|rule| {
        rule_matches(txn, rule)
            && crate::reconciliation_rules::action(rule, "categoryAccountId") == category
    });
    Ok(Some(match rule {
        Some(rule) => json!({
            "reason": "rule",
            "ruleId": rule.get("id"),
            "ruleName": rule.get("name"),
        }),
        None => json!({ "reason": "rule" }),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ibans_compare_without_spaces_or_case() {
        assert_eq!(
            normalize_iban("nl91 abna 0417 1643 00"),
            "NL91ABNA0417164300"
        );
        let own = vec![
            ("ba_1".to_owned(), normalize_iban("NL91 ABNA 0417 1643 00")),
            ("ba_2".to_owned(), normalize_iban("NL86 INGB 0002 4455 88")),
            ("ba_3".to_owned(), String::new()),
        ];
        assert_eq!(
            own_account_of_iban(&own, Some("NL86INGB0002445588"), "ba_1"),
            Some("ba_2")
        );
        // The line's own account is not a transfer to another one.
        assert_eq!(
            own_account_of_iban(&own, Some("NL91ABNA0417164300"), "ba_1"),
            None
        );
        assert_eq!(own_account_of_iban(&own, Some(""), "ba_1"), None);
        assert_eq!(own_account_of_iban(&own, None, "ba_1"), None);
        assert_eq!(
            own_account_of_iban(&own, Some("NL00XXXX0000000000"), "ba_1"),
            None
        );
    }

    #[test]
    fn a_processed_line_knows_what_it_was() {
        let line =
            |kind: Option<&str>, payment: Option<&str>, entry: Option<&str>, status: &str| {
                json!({
                    "status": status,
                    "reconciliationType": kind,
                    "reconciledPaymentId": payment,
                    "journalEntryId": entry,
                })
            };
        let undone = processed_as(&line(Some("manual"), None, Some("je_1"), "reconciled"));
        assert_eq!((undone.what, undone.automatic), ("category", false));
        assert_eq!(undone.journal_entry_id.as_deref(), Some("je_1"));
        let undone = processed_as(&line(Some("auto"), None, Some("je_1"), "reconciled"));
        assert_eq!((undone.what, undone.automatic), ("category", true));
        let undone = processed_as(&line(Some("transfer"), None, Some("je_1"), "reconciled"));
        assert_eq!(undone.what, "transfer");
        let undone = processed_as(&line(Some("private"), None, Some("je_1"), "reconciled"));
        assert_eq!(undone.what, "private");
        // A match that created its payment voids it; the entry is the payment's.
        let undone = processed_as(&line(
            Some("manual"),
            Some("pay_1"),
            Some("je_1"),
            "reconciled",
        ));
        assert_eq!(undone.what, "payment");
        assert_eq!(undone.payment_voided_id.as_deref(), Some("pay_1"));
        assert_eq!(undone.journal_entry_id, None);
        // A link to a payment that was there leaves it.
        let undone = processed_as(&line(
            Some("payment_link"),
            Some("pay_1"),
            None,
            "reconciled",
        ));
        assert_eq!((undone.what, undone.payment_voided_id), ("payment", None));
        let undone = processed_as(&line(Some("deposit"), None, None, "reconciled"));
        assert_eq!(undone.what, "deposit");
        let undone = processed_as(&line(None, None, None, "excluded"));
        assert_eq!(undone.what, "ignore");
    }
}
