//! What the contact page (Rust only, edition feature `books-contact-page`,
//! plan weldbooks-connected-ux phase 5) and the routes around it share: which
//! bank lines belong to a contact, and the contact's reminder pause.
//!
//! # A contact's bank lines
//!
//! A bank line belongs to a contact when any of these holds:
//!
//! - the line's own `contact_id` is the contact;
//! - the payment it was reconciled to (`reconciled_payment_id`), or a payment
//!   recorded against it (`payments.bank_transaction_id`), is the contact's;
//! - the invoice or bill it was reconciled to (`reconciled_invoice_id`,
//!   `reconciled_bill_id`) is the contact's;
//! - its payment was allocated to an invoice or bill of the contact.
//!
//! # The reminder pause
//!
//! `parties` has no column for it and a migration was not approved for it, so
//! it is kept in a party jsonb column nothing else reads or writes,
//! `average_deal_size` (a relic of the CRM's old customers table), under the
//! key `weldbooks`: `{ "weldbooks": { "remindersPaused": true } }`. Setting it
//! merges, so anything else in the column stays.

use std::collections::HashSet;

use sea_orm::sea_query::{Query, SelectStatement};
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{
    bank_transactions, bills, invoices, parties, payment_allocations, payments,
};

/// The key of the books' own facts in the party column that carries them.
const BOOKS_KEY: &str = "weldbooks";
const PAUSED_KEY: &str = "remindersPaused";

fn ids_of<E: EntityTrait>(
    id: impl ColumnTrait,
    contact: impl ColumnTrait,
    deleted: impl ColumnTrait,
    contact_id: &str,
) -> SelectStatement {
    Query::select()
        .column(id)
        .from(E::default())
        .and_where(contact.eq(contact_id))
        .and_where(deleted.is_null())
        .to_owned()
}

/// The condition on `bank_transactions` that picks a contact's lines (see the
/// module's rule). Combine it with the entity and `deleted_at` filters.
pub fn bank_line_condition(contact_id: &str) -> Condition {
    use bank_transactions::Column as Line;
    let payments_of = || {
        ids_of::<payments::Entity>(
            payments::Column::Id,
            payments::Column::ContactId,
            payments::Column::DeletedAt,
            contact_id,
        )
    };
    let invoices_of = || {
        ids_of::<invoices::Entity>(
            invoices::Column::Id,
            invoices::Column::ContactId,
            invoices::Column::DeletedAt,
            contact_id,
        )
    };
    let bills_of = || {
        ids_of::<bills::Entity>(
            bills::Column::Id,
            bills::Column::ContactId,
            bills::Column::DeletedAt,
            contact_id,
        )
    };
    let recorded_against = Query::select()
        .column(payments::Column::BankTransactionId)
        .from(payments::Entity)
        .and_where(payments::Column::ContactId.eq(contact_id))
        .and_where(payments::Column::DeletedAt.is_null())
        .and_where(payments::Column::BankTransactionId.is_not_null())
        .to_owned();
    let allocated = Query::select()
        .column(payment_allocations::Column::PaymentId)
        .from(payment_allocations::Entity)
        .and_where(payment_allocations::Column::DeletedAt.is_null())
        .cond_where(
            Condition::any()
                .add(payment_allocations::Column::InvoiceId.in_subquery(invoices_of()))
                .add(payment_allocations::Column::BillId.in_subquery(bills_of())),
        )
        .to_owned();
    Condition::any()
        .add(Line::ContactId.eq(contact_id))
        .add(Line::ReconciledPaymentId.in_subquery(payments_of()))
        .add(Line::Id.in_subquery(recorded_against))
        .add(Line::ReconciledInvoiceId.in_subquery(invoices_of()))
        .add(Line::ReconciledBillId.in_subquery(bills_of()))
        .add(Line::ReconciledPaymentId.in_subquery(allocated))
}

/// Whether the party's column says reminders are held for it.
pub fn reminders_paused(column: Option<&Value>) -> bool {
    column
        .and_then(|value| value.get(BOOKS_KEY))
        .and_then(|books| books.get(PAUSED_KEY))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// The column's new value with the pause set or cleared; everything else in
/// it stays.
pub fn with_reminders_paused(column: Option<&Value>, paused: bool) -> Value {
    let mut root: Map<String, Value> = column
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut books: Map<String, Value> = root
        .get(BOOKS_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if paused {
        books.insert(PAUSED_KEY.to_owned(), json!(true));
    } else {
        books.remove(PAUSED_KEY);
    }
    if books.is_empty() {
        root.remove(BOOKS_KEY);
    } else {
        root.insert(BOOKS_KEY.to_owned(), Value::Object(books));
    }
    Value::Object(root)
}

/// The contacts among `ids` whose reminders are held.
///
/// # Errors
///
/// The database's.
pub async fn paused_contacts(db: &PgPool, ids: &[String]) -> Result<HashSet<String>, DbErr> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<(String, Option<Value>)> = parties::Entity::find()
        .select_only()
        .columns([parties::Column::Id, parties::Column::AverageDealSize])
        .filter(parties::Column::Id.is_in(ids.to_vec()))
        .filter(parties::Column::AverageDealSize.is_not_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .filter(|(_, column)| reminders_paused(column.as_ref()))
        .map(|(id, _)| id)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pause_is_read_and_merged() {
        assert!(!reminders_paused(None));
        assert!(!reminders_paused(Some(&json!({ "amount": 5 }))));
        let set = with_reminders_paused(Some(&json!({ "amount": 5 })), true);
        assert_eq!(
            set,
            json!({ "amount": 5, "weldbooks": { "remindersPaused": true } })
        );
        assert!(reminders_paused(Some(&set)));
        let cleared = with_reminders_paused(Some(&set), false);
        assert_eq!(cleared, json!({ "amount": 5 }));
        assert!(!reminders_paused(Some(&cleared)));
    }
}
