//! Reconciliation rules built from how bank lines were booked (Rust only,
//! edition feature `books-bank-processing`):
//!
//! - `GET /api/bank-transactions/:id/rule-suggestion`: when the same
//!   counterparty (its IBAN, else its normalised name) was categorized to the
//!   same account at least twice before in this entity, a pre-filled rule
//!   `{ name, conditions, actions }` the screen can save with
//!   `POST /api/reconciliation-rules`; otherwise `{ data: null }`.
//! - `POST /api/reconciliation-rules/from-transaction/:id`: the same
//!   pre-fill, from how this one line was booked ("Make this a rule").
//!
//! Nothing is saved here: the rule is the screen's to create.

use axum::extract::Path;
use axum::response::Response;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::bank_matching::name_tokens;
use weldsuite_books_domain::bank_processing::normalize_iban;
use weldsuite_books_domain::http::{Caller, Refusal, ok, reply};
use weldsuite_books_domain::js::parse_float;
use weldsuite_books_domain::reconciliation_rules::{action, load_active_rules, rule_matches};
use weldsuite_db::orm;
use weldsuite_schema::tenant::{accounts, bank_transactions};

use crate::bank_links::json_error;
use crate::bank_transactions::find_line;
use crate::common::text;

/// How many categorized lines of the entity are read to find a pattern.
const HISTORY: u64 = 1000;
/// How many times a counterparty is booked the same way before a rule is
/// suggested.
const TIMES: usize = 2;

fn filled<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    text(row, key).map(str::trim).filter(|v| !v.is_empty())
}

/// `in` or `out`; `None` for an amount of nothing.
fn direction_of(row: &Value) -> Option<&'static str> {
    let amount = parse_float(text(row, "amount").unwrap_or("0"));
    if amount > 0.0 {
        Some("in")
    } else if amount < 0.0 {
        Some("out")
    } else {
        None
    }
}

/// Who the counterparty is, for comparing lines: the IBAN, else the
/// normalised name (its tokens without legal suffixes or bank words).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Who {
    Iban(String),
    Name(String),
}

fn who(row: &Value) -> Option<Who> {
    if let Some(iban) = filled(row, "counterpartyIban") {
        return Some(Who::Iban(normalize_iban(iban)));
    }
    let name = filled(row, "counterpartyName")?;
    let mut tokens = name_tokens(Some(name), true);
    if tokens.is_empty() {
        return None;
    }
    tokens.sort();
    Some(Who::Name(tokens.join(" ")))
}

/// The condition that finds the same counterparty again: its IBAN, else its
/// name (the line's own spelling; rules compare case-insensitively).
fn counterparty_condition(row: &Value) -> Option<(Value, String)> {
    if let Some(iban) = filled(row, "counterpartyIban") {
        return Some((
            json!({ "field": "counterpartyIban", "operator": "equals", "value": normalize_iban(iban) }),
            iban.to_owned(),
        ));
    }
    let name = filled(row, "counterpartyName")?;
    Some((
        json!({ "field": "counterpartyName", "operator": "equals", "value": name }),
        name.to_owned(),
    ))
}

/// The pre-filled rule.
async fn prefill(
    db: &PgPool,
    row: &Value,
    category_account_id: &str,
    tax_rate_id: Option<&str>,
    contact_id: Option<&str>,
) -> Result<Option<Value>, DbErr> {
    let Some((counterparty, label)) = counterparty_condition(row) else {
        return Ok(None);
    };
    let mut conditions = vec![counterparty];
    if let Some(direction) = direction_of(row) {
        conditions.push(json!({ "field": "direction", "operator": "equals", "value": direction }));
    }
    let account = accounts::Entity::find()
        .filter(accounts::Column::EntityId.eq(text(row, "entityId").unwrap_or_default()))
        .filter(accounts::Column::Id.eq(category_account_id))
        .one(&orm(db))
        .await?
        .map(|model| serde_json::to_value(model).map_err(json_error))
        .transpose()?;
    let account_name = account.as_ref().map_or_else(String::new, |a| {
        format!(
            " → {} {}",
            text(a, "code").unwrap_or_default(),
            text(a, "name").unwrap_or_default()
        )
    });
    let name: String = format!("{label}{account_name}").chars().take(255).collect();
    let mut actions = json!({ "categoryAccountId": category_account_id });
    if let Some(rate) = tax_rate_id.filter(|r| !r.is_empty()) {
        actions["taxRateId"] = json!(rate);
    }
    if let Some(contact) = contact_id.filter(|c| !c.is_empty()) {
        actions["contactId"] = json!(contact);
    }
    Ok(Some(json!({
        "name": name,
        "matchMode": "all",
        "conditions": conditions,
        "actions": actions,
    })))
}

/// The category `row` was booked to by hand or by a rule, when it was.
fn booked_category(row: &Value) -> Option<&str> {
    let by_category = matches!(text(row, "reconciliationType"), Some("manual" | "auto"))
        && filled(row, "reconciledPaymentId").is_none()
        && filled(row, "journalEntryId").is_some();
    (text(row, "status") == Some("reconciled") && by_category)
        .then(|| filled(row, "categoryAccountId"))
        .flatten()
}

/// The most frequent value, the most recent first on a tie (`values` come
/// newest first).
fn most_common<'a>(values: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for value in values {
        match counts.iter_mut().find(|(known, _)| *known == value) {
            Some((_, count)) => *count += 1,
            None => counts.push((value, 1)),
        }
    }
    let top = counts.iter().map(|(_, count)| *count).max()?;
    counts
        .into_iter()
        .find(|(_, count)| *count == top)
        .map(|(value, _)| value)
}

/// The suggestion for `txn`: when its counterparty was booked to one account
/// at least twice before (in the same direction), a pre-filled rule, unless
/// an active rule already does it.
pub(crate) async fn suggest(db: &PgPool, txn: &Value) -> Result<Option<Value>, DbErr> {
    let Some(identity) = who(txn) else {
        return Ok(None);
    };
    let entity_id = text(txn, "entityId").unwrap_or_default();
    let this_id = text(txn, "id").unwrap_or_default();
    let direction = direction_of(txn);
    let rows = bank_transactions::Entity::find()
        .filter(bank_transactions::Column::EntityId.eq(entity_id))
        .filter(bank_transactions::Column::Status.eq("reconciled"))
        .filter(bank_transactions::Column::ReconciliationType.is_in(["manual", "auto"]))
        .filter(bank_transactions::Column::ReconciledPaymentId.is_null())
        .filter(bank_transactions::Column::JournalEntryId.is_not_null())
        .filter(bank_transactions::Column::CategoryAccountId.is_not_null())
        .filter(bank_transactions::Column::DeletedAt.is_null())
        .filter(bank_transactions::Column::Id.ne(this_id))
        .order_by_desc(bank_transactions::Column::Date)
        .limit(HISTORY)
        .all(&orm(db))
        .await?;
    let mut history: Vec<Value> = Vec::new();
    for row in rows {
        let row = serde_json::to_value(row).map_err(json_error)?;
        if who(&row).as_ref() == Some(&identity) && direction_of(&row) == direction {
            history.push(row);
        }
    }
    // What the line itself was booked to, else the most frequent category.
    let category = match booked_category(txn) {
        Some(own) => own.to_owned(),
        None => match most_common(history.iter().filter_map(booked_category)) {
            Some(top) => top.to_owned(),
            None => return Ok(None),
        },
    };
    let same: Vec<&Value> = history
        .iter()
        .filter(|row| booked_category(row) == Some(category.as_str()))
        .collect();
    if same.len() < TIMES {
        return Ok(None);
    }
    // A rule that already books it that way makes the suggestion moot.
    let rules = load_active_rules(db, entity_id).await?;
    if rules.iter().any(|rule| {
        rule_matches(txn, rule) && action(rule, "categoryAccountId") == Some(category.as_str())
    }) {
        return Ok(None);
    }
    let tax_rate = most_common(same.iter().filter_map(|row| filled(row, "taxRateId")));
    let contact = filled(txn, "contactId")
        .or_else(|| most_common(same.iter().filter_map(|row| filled(row, "contactId"))));
    let Some(mut rule) = prefill(db, txn, &category, tax_rate, contact).await? else {
        return Ok(None);
    };
    rule["evidence"] = json!({ "times": same.len(), "categoryAccountId": category });
    Ok(Some(rule))
}

/// `GET /api/bank-transactions/:id/rule-suggestion`.
pub(crate) async fn rule_suggestion(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(txn) = find_line(&caller, &id).await? else {
                return Err(Refusal::not_found("Bank transaction", &id));
            };
            Ok(ok(suggest(&caller.db, &txn).await?.unwrap_or(Value::Null)))
        }
        .await,
        "Failed to build a rule suggestion",
    )
}

/// `POST /api/reconciliation-rules/from-transaction/:id`: a rule from how
/// this line was booked.
pub(crate) async fn from_transaction(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(txn) = find_line(&caller, &id).await? else {
                return Err(Refusal::not_found("Bank transaction", &id));
            };
            let Some(category) = booked_category(&txn) else {
                return Err(Refusal::bad_request(
                    "Book this line to a category first, then make it a rule",
                ));
            };
            let rule = prefill(
                &caller.db,
                &txn,
                category,
                filled(&txn, "taxRateId"),
                filled(&txn, "contactId"),
            )
            .await?;
            match rule {
                Some(rule) => Ok(ok(rule)),
                None => Err(Refusal::bad_request(
                    "This line has no counterparty to make a rule from",
                )),
            }
        }
        .await,
        "Failed to build a rule from the bank transaction",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counterparties_compare_by_iban_else_normalised_name() {
        let line = |iban: Option<&str>, name: Option<&str>| json!({ "counterpartyIban": iban, "counterpartyName": name });
        assert_eq!(
            who(&line(Some("nl91 abna 0417 1643 00"), Some("X"))),
            who(&line(Some("NL91ABNA0417164300"), None))
        );
        assert_eq!(
            who(&line(None, Some("Acme Corp"))),
            who(&line(None, Some("ACME corp")))
        );
        assert_ne!(
            who(&line(None, Some("Acme"))),
            who(&line(None, Some("Beta")))
        );
        assert_eq!(who(&line(None, None)), None);
        assert_eq!(who(&line(Some("  "), Some("  "))), None);
    }

    #[test]
    fn only_a_category_booking_counts() {
        let row = |kind: &str, payment: Option<&str>, entry: Option<&str>, status: &str| {
            json!({
                "status": status,
                "reconciliationType": kind,
                "reconciledPaymentId": payment,
                "journalEntryId": entry,
                "categoryAccountId": "acc_1",
            })
        };
        assert_eq!(
            booked_category(&row("manual", None, Some("je"), "reconciled")),
            Some("acc_1")
        );
        assert_eq!(
            booked_category(&row("auto", None, Some("je"), "reconciled")),
            Some("acc_1")
        );
        assert_eq!(
            booked_category(&row("transfer", None, Some("je"), "reconciled")),
            None
        );
        assert_eq!(
            booked_category(&row("manual", Some("p"), Some("je"), "reconciled")),
            None
        );
        assert_eq!(
            booked_category(&row("manual", None, Some("je"), "unreconciled")),
            None
        );
    }

    #[test]
    fn the_most_common_wins_and_the_newest_breaks_a_tie() {
        assert_eq!(most_common(["a", "b", "b"].into_iter()), Some("b"));
        assert_eq!(most_common(["a", "b"].into_iter()), Some("a"));
        assert_eq!(most_common(std::iter::empty()), None);
    }

    #[test]
    fn the_condition_prefers_the_iban() {
        let both =
            json!({ "counterpartyIban": "nl91 abna 0417 1643 00", "counterpartyName": "Acme" });
        let (condition, label) = counterparty_condition(&both).unwrap_or_default();
        assert_eq!(condition["field"], json!("counterpartyIban"));
        assert_eq!(condition["value"], json!("NL91ABNA0417164300"));
        assert_eq!(label, "nl91 abna 0417 1643 00");
        let name = json!({ "counterpartyName": " Acme " });
        let (condition, _) = counterparty_condition(&name).unwrap_or_default();
        assert_eq!(condition["field"], json!("counterpartyName"));
        assert_eq!(condition["value"], json!("Acme"));
        assert!(counterparty_condition(&json!({})).is_none());
    }

    #[test]
    fn direction_follows_the_sign() {
        assert_eq!(direction_of(&json!({ "amount": "-10.00" })), Some("out"));
        assert_eq!(direction_of(&json!({ "amount": "10.00" })), Some("in"));
        assert_eq!(direction_of(&json!({ "amount": "0" })), None);
    }
}
