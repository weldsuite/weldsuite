//! What a supplier's bills usually book to (Rust only, edition feature
//! `books-receipts`): `GET /api/accounting-contacts/:id/booking-defaults`.
//!
//! Worked out from the supplier's last ten posted bills, line by line: the
//! expense account, the VAT rate and the project used most, each with how
//! often. Nothing is stored (no per-contact default column; stored defaults
//! are the optional M5 of the plan): the history is the default. A supplier
//! with no bills yet falls back to its own `default_expense_account_id`.
//! Bills that are drafts, rejected, or have no posting are not history.

use std::collections::HashMap;

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{accounts, bill_items, bills, parties, tax_rates};

/// How many posted bills are looked at.
pub(crate) const HISTORY: u64 = 10;

/// The most used of `values` (ties: the one seen last, so the most recent
/// bill's choice wins) and its count. `values` come newest first.
fn most_used(values: &[String]) -> Option<(String, usize)> {
    let mut counts: HashMap<&str, (usize, usize)> = HashMap::new();
    for (index, value) in values.iter().enumerate() {
        let entry = counts.entry(value.as_str()).or_insert((0, index));
        entry.0 += 1;
    }
    counts
        .into_iter()
        // More lines first; on a tie the one that appears earliest (newest).
        .max_by(|a, b| a.1.0.cmp(&b.1.0).then(b.1.1.cmp(&a.1.1)))
        .map(|(value, (count, _))| (value.to_owned(), count))
}

/// The supplier's booking defaults; `None` when the contact doesn't exist.
#[allow(clippy::too_many_lines)] // the history, then each default with its names
pub(crate) async fn booking_defaults(
    db: &PgPool,
    entity_id: Option<&str>,
    contact_id: &str,
) -> Result<Option<Value>, DbErr> {
    let party = parties::Entity::find_by_id(contact_id.to_owned())
        .filter(parties::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    let Some(party) = party else {
        return Ok(None);
    };
    let mut posted = bills::Entity::find()
        .filter(bills::Column::ContactId.eq(contact_id))
        .filter(bills::Column::DeletedAt.is_null())
        .filter(bills::Column::JournalEntryId.is_not_null())
        .filter(bills::Column::Status.ne("cancelled"))
        .filter(bills::Column::Type.ne("credit_note"));
    if let Some(entity) = entity_id {
        posted = posted.filter(bills::Column::EntityId.eq(entity));
    }
    let history = posted
        .order_by_desc(bills::Column::IssueDate)
        .order_by_desc(bills::Column::Id)
        .limit(HISTORY)
        .all(&orm(db))
        .await?;
    let ids: Vec<String> = history.iter().map(|bill| bill.id.clone()).collect();
    let mut lines = if ids.is_empty() {
        Vec::new()
    } else {
        bill_items::Entity::find()
            .filter(bill_items::Column::BillId.is_in(&ids))
            .filter(bill_items::Column::DeletedAt.is_null())
            .all(&orm(db))
            .await?
    };
    // Newest bill first, as the history is.
    lines.sort_by_key(|line| {
        (
            ids.iter()
                .position(|id| *id == line.bill_id)
                .unwrap_or(usize::MAX),
            line.sort_order.unwrap_or(0),
        )
    });
    let pick = |read: fn(&bill_items::Model) -> Option<&String>| -> Option<(String, usize)> {
        let values: Vec<String> = lines
            .iter()
            .filter_map(|line| read(line).filter(|v| !v.is_empty()).cloned())
            .collect();
        most_used(&values)
    };
    let account = pick(|line| line.account_id.as_ref());
    let tax_rate = pick(|line| line.tax_rate_id.as_ref());
    let project = pick(|line| line.project_id.as_ref());

    let account_view = match account {
        Some((id, count)) => Some((id, count, "history")),
        None => party
            .default_expense_account_id
            .clone()
            .filter(|id| !id.is_empty())
            .map(|id| (id, 0, "contact")),
    };
    let account_json = match account_view {
        Some((id, count, source)) => {
            let row = accounts::Entity::find_by_id(id.clone())
                .filter(accounts::Column::DeletedAt.is_null())
                .one(&orm(db))
                .await?;
            row.map(|row| {
                json!({
                    "accountId": id,
                    "code": row.code,
                    "name": row.name,
                    "count": count,
                    "source": source,
                })
            })
        }
        None => None,
    };
    let tax_json = match tax_rate {
        Some((id, count)) => {
            let row = tax_rates::Entity::find_by_id(id.clone())
                .filter(tax_rates::Column::DeletedAt.is_null())
                .one(&orm(db))
                .await?;
            row.map(|row| {
                json!({
                    "taxRateId": id,
                    "name": row.name,
                    "rate": row.rate.to_string(),
                    "count": count,
                    "source": "history",
                })
            })
        }
        None => None,
    };
    let project_json =
        project.map(|(id, count)| json!({ "projectId": id, "count": count, "source": "history" }));
    let last = history.first().map(|bill| {
        json!({
            "id": bill.id,
            "billNumber": bill.bill_number,
            "issueDate": crate::rows::iso_of(bill.issue_date),
            "currency": bill.currency,
        })
    });
    Ok(Some(json!({
        "contactId": contact_id,
        "basedOnBills": history.len(),
        "basedOnLines": lines.len(),
        "account": account_json,
        "taxRate": tax_json,
        "project": project_json,
        "lastBill": last,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }

    #[test]
    fn the_most_used_wins_with_its_count() {
        assert_eq!(
            most_used(&words(&["a", "b", "b", "c", "b", "a"])),
            Some(("b".to_owned(), 3))
        );
        assert_eq!(most_used(&[]), None);
    }

    #[test]
    fn a_tie_goes_to_the_newest_bill() {
        // Newest first: `new` is the latest bill's choice.
        assert_eq!(
            most_used(&words(&["new", "old", "new", "old"])),
            Some(("new".to_owned(), 2))
        );
        assert_eq!(
            most_used(&words(&["old", "new", "new", "old"])),
            Some(("old".to_owned(), 2))
        );
    }
}
