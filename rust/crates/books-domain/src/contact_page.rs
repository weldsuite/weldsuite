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
//! A contact's reminders are held per legal entity: the entity's
//! `jurisdiction_settings.reminders.pausedContactIds` lists the parties
//! (`parties.id`) whose reminders that entity does not send. Nothing else in
//! the settings is touched.
//!
//! Phase 5 first kept the pause in `parties.average_deal_size` (a relic of the
//! CRM's old customers table, nothing else reads it), under
//! `{ "weldbooks": { "remindersPaused": true } }`. Those values move lazily:
//! whenever a pause is read or written for a contact, a contact that still
//! carries the old key is added to the default entity's list and the old key
//! is cleared (the rest of the column stays). No migration is needed.

use std::collections::HashSet;

use sea_orm::sea_query::{Expr, Query, SelectStatement};
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_db::{OrmConn, PgPool, atomically_with, orm, utc_now};
use weldsuite_legal_entities::{LegalEntityApp, default_entity_id_for};
use weldsuite_schema::tenant::{
    bank_transactions, bills, entities, invoices, parties, payment_allocations, payments,
};

use crate::posting::PostError;
use crate::reminders::KEY as REMINDERS_KEY;

/// The key of the books' own facts in the party column that carried the pause.
const LEGACY_BOOKS_KEY: &str = "weldbooks";
const LEGACY_PAUSED_KEY: &str = "remindersPaused";
/// The list inside `jurisdiction_settings.reminders`.
pub const PAUSED_IDS_KEY: &str = "pausedContactIds";

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

/// Whether the party's column still carries the old pause (see the module).
fn legacy_paused(column: Option<&Value>) -> bool {
    column
        .and_then(|value| value.get(LEGACY_BOOKS_KEY))
        .and_then(|books| books.get(LEGACY_PAUSED_KEY))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// The column without the old pause; everything else in it stays.
fn without_legacy_pause(column: Option<&Value>) -> Value {
    let mut root: Map<String, Value> = column
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut books: Map<String, Value> = root
        .get(LEGACY_BOOKS_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    books.remove(LEGACY_PAUSED_KEY);
    if books.is_empty() {
        root.remove(LEGACY_BOOKS_KEY);
    } else {
        root.insert(LEGACY_BOOKS_KEY.to_owned(), Value::Object(books));
    }
    Value::Object(root)
}

/// The contacts an entity's `jurisdictionSettings` holds as paused.
pub fn paused_ids_of(settings: Option<&Value>) -> Vec<String> {
    settings
        .and_then(|s| s.get(REMINDERS_KEY))
        .and_then(|r| r.get(PAUSED_IDS_KEY))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// `settings` with `contact_id` in (`paused`) or out of the entity's list;
/// every other key, in the settings and in `reminders`, stays.
pub fn with_contact_paused(settings: Option<&Value>, contact_id: &str, paused: bool) -> Value {
    let mut all: Map<String, Value> = settings
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut reminders: Map<String, Value> = all
        .get(REMINDERS_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut ids = paused_ids_of(settings);
    ids.retain(|id| id != contact_id);
    if paused {
        ids.push(contact_id.to_owned());
    }
    if ids.is_empty() {
        reminders.remove(PAUSED_IDS_KEY);
    } else {
        reminders.insert(PAUSED_IDS_KEY.to_owned(), json!(ids));
    }
    if reminders.is_empty() {
        all.remove(REMINDERS_KEY);
    } else {
        all.insert(REMINDERS_KEY.to_owned(), Value::Object(reminders));
    }
    Value::Object(all)
}

fn post_error(error: PostError) -> DbErr {
    match error {
        PostError::Database(error) => error,
        other => DbErr::Custom(other.to_string()),
    }
}

/// Add `contact_ids` to (`paused`) or take them out of the entity's list,
/// under a lock on the entity row. The ids that were not already so.
async fn edit_pause_list(
    db: &PgPool,
    entity_id: &str,
    contact_ids: Vec<String>,
    paused: bool,
    clear_legacy: Vec<(String, Value)>,
) -> Result<Vec<String>, DbErr> {
    let entity_id = entity_id.to_owned();
    atomically_with::<_, Vec<String>, PostError, _>(db, move |conn| {
        Box::pin(async move {
            let tx = OrmConn::new(&mut *conn);
            let Some(entity) = entities::Entity::find_by_id(entity_id.clone())
                .filter(entities::Column::DeletedAt.is_null())
                .lock_exclusive()
                .one(&tx)
                .await?
            else {
                return Err(PostError::Database(DbErr::RecordNotFound(format!(
                    "Accounting entity {entity_id}"
                ))));
            };
            let mut settings = entity.jurisdiction_settings.clone();
            let mut changed = Vec::new();
            for id in &contact_ids {
                let held = paused_ids_of(settings.as_ref()).contains(id);
                if held != paused {
                    changed.push(id.clone());
                }
                settings = Some(with_contact_paused(settings.as_ref(), id, paused));
            }
            if !changed.is_empty() {
                entities::Entity::update_many()
                    .col_expr(
                        entities::Column::JurisdictionSettings,
                        Expr::value(settings),
                    )
                    .col_expr(entities::Column::UpdatedAt, Expr::value(utc_now()))
                    .filter(entities::Column::Id.eq(entity_id.as_str()))
                    .exec(&tx)
                    .await?;
            }
            for (party_id, column) in clear_legacy {
                parties::Entity::update_many()
                    .col_expr(
                        parties::Column::AverageDealSize,
                        Expr::value(Some(without_legacy_pause(Some(&column)))),
                    )
                    .filter(parties::Column::Id.eq(party_id))
                    .exec(&tx)
                    .await?;
            }
            Ok(changed)
        })
    })
    .await
    .map_err(post_error)
}

/// The contacts among `ids` that still carry the old pause, with their column.
async fn legacy_pauses(db: &PgPool, ids: &[String]) -> Result<Vec<(String, Value)>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
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
        .filter_map(|(id, column)| {
            let column = column?;
            legacy_paused(Some(&column)).then_some((id, column))
        })
        .collect())
}

/// Move the old pauses of `ids` into the default entity's list (see the
/// module), or into `fallback_entity` (the request's) when the workspace has
/// no default entity. Nothing happens for a contact without one.
async fn adopt_legacy_pauses(
    db: &PgPool,
    ids: &[String],
    fallback_entity: &str,
) -> Result<(), DbErr> {
    let legacy = legacy_pauses(db, ids).await?;
    if legacy.is_empty() {
        return Ok(());
    }
    let destination = default_entity_id_for(db, Some(LegalEntityApp::Weldbooks))
        .await?
        .unwrap_or_else(|| fallback_entity.to_owned());
    let moved: Vec<String> = legacy.iter().map(|(id, _)| id.clone()).collect();
    edit_pause_list(db, &destination, moved, true, legacy).await?;
    Ok(())
}

/// The contacts among `ids` whose reminders `entity_id` holds. Old pauses
/// among them move first.
///
/// # Errors
///
/// The database's.
pub async fn paused_contacts(
    db: &PgPool,
    entity_id: &str,
    ids: &[String],
) -> Result<HashSet<String>, DbErr> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    adopt_legacy_pauses(db, ids, entity_id).await?;
    let settings: Option<Option<Value>> = entities::Entity::find()
        .select_only()
        .column(entities::Column::JurisdictionSettings)
        .filter(entities::Column::Id.eq(entity_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    let held = paused_ids_of(settings.flatten().as_ref());
    Ok(ids.iter().filter(|id| held.contains(id)).cloned().collect())
}

/// Whether `entity_id` holds the reminders of `contact_id`.
///
/// # Errors
///
/// The database's.
pub async fn contact_paused(db: &PgPool, entity_id: &str, contact_id: &str) -> Result<bool, DbErr> {
    Ok(paused_contacts(db, entity_id, &[contact_id.to_owned()])
        .await?
        .contains(contact_id))
}

/// Hold (`paused`) or release the reminders of `contact_id` in `entity_id`;
/// whether they were held before. An old pause of the contact moves first.
///
/// # Errors
///
/// The database's; `RecordNotFound` for an entity that is not there.
pub async fn set_contact_paused(
    db: &PgPool,
    entity_id: &str,
    contact_id: &str,
    paused: bool,
) -> Result<bool, DbErr> {
    // Reading moves an old pause first, so none is left to clear.
    let was = contact_paused(db, entity_id, contact_id).await?;
    edit_pause_list(
        db,
        entity_id,
        vec![contact_id.to_owned()],
        paused,
        Vec::new(),
    )
    .await?;
    Ok(was)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pause_list_keeps_every_other_key() {
        assert_eq!(paused_ids_of(None), Vec::<String>::new());
        let settings = json!({
            "somethingElse": 1,
            "reminders": { "enabled": true, "steps": [] }
        });
        let set = with_contact_paused(Some(&settings), "pty_a", true);
        assert_eq!(
            set,
            json!({
                "somethingElse": 1,
                "reminders": { "enabled": true, "steps": [], "pausedContactIds": ["pty_a"] }
            })
        );
        let two = with_contact_paused(Some(&set), "pty_b", true);
        assert_eq!(paused_ids_of(Some(&two)), ["pty_a", "pty_b"]);
        // Twice is once.
        let again = with_contact_paused(Some(&two), "pty_b", true);
        assert_eq!(paused_ids_of(Some(&again)), ["pty_a", "pty_b"]);
        let released = with_contact_paused(Some(&again), "pty_a", false);
        assert_eq!(paused_ids_of(Some(&released)), ["pty_b"]);
        let empty = with_contact_paused(Some(&released), "pty_b", false);
        assert_eq!(
            empty,
            json!({ "somethingElse": 1, "reminders": { "enabled": true, "steps": [] } })
        );
        // A list alone leaves nothing behind when it empties.
        let alone = with_contact_paused(None, "pty_a", true);
        assert_eq!(
            alone,
            json!({ "reminders": { "pausedContactIds": ["pty_a"] } })
        );
        assert_eq!(with_contact_paused(Some(&alone), "pty_a", false), json!({}));
    }

    #[test]
    fn the_old_pause_is_read_and_cleared_leaving_the_rest() {
        assert!(!legacy_paused(None));
        assert!(!legacy_paused(Some(&json!({ "amount": 5 }))));
        let old = json!({ "amount": 5, "weldbooks": { "remindersPaused": true } });
        assert!(legacy_paused(Some(&old)));
        assert_eq!(without_legacy_pause(Some(&old)), json!({ "amount": 5 }));
        let more = json!({ "weldbooks": { "remindersPaused": true, "other": 1 } });
        assert_eq!(
            without_legacy_pause(Some(&more)),
            json!({ "weldbooks": { "other": 1 } })
        );
        assert_eq!(without_legacy_pause(None), json!({}));
    }
}
