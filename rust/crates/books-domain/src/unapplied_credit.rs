//! Unapplied credit: what a payment brought in beyond the documents it was
//! allocated to (a customer paid more than the invoice, or paid before there
//! was one). The credit stays on the contact: the payment's entry already
//! credited (debited, for a payment sent) the receivable (payable) account
//! for the whole amount, so applying part of it to an open document of the
//! same contact needs **no new journal entry**. The ledger already nets the
//! two; what changes is the sub-ledger: an allocation row, and the
//! document's paid amount, balance and status.
//!
//! The remainder is read from the books, not stored: what the payment's own
//! entry put on the contact's receivable (payable) account, minus what is
//! allocated now. Only payments in the entity's own currency are offered
//! (a foreign payment's remainder is a currency question).

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Map, Value, json};
use weldsuite_db::{OrmConn, PgPool, atomically_with, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{bills, invoices, journal_lines, payment_allocations, payments};

use crate::db_values::{to_json, to_json_rows};
use crate::document_posting::{fallback, load_entity, settle, text};
use crate::http::now;
use crate::js::{parse_float, round_money, to_fixed};
use crate::posting::{PostError, account_for_role, load_entity_accounts};
use crate::tables::{PAYMENT_ALLOCATIONS, PAYMENTS};

/// Invoice statuses that still take money.
const OPEN_INVOICE: [&str; 4] = ["sent", "finalized", "partial", "overdue"];
/// Bill statuses that can be paid.
const OPEN_BILL: [&str; 3] = ["approved", "partial", "overdue"];

fn refuse(message: impl Into<String>) -> PostError {
    PostError::Posting(message.into())
}

fn amount_of(row: &Value, key: &str) -> f64 {
    parse_float(text(row, key).unwrap_or("0"))
}

/// What the payment put on the contact's receivable (payable) account, in
/// its own entry: the documents it settled and the part left over. A payment
/// without an entry (recorded before payments were posted) put its amount.
async fn counter_total(
    db: &PgPool,
    payment: &Value,
    received: bool,
    counter_account_id: Option<&str>,
) -> Result<f64, DbErr> {
    let Some(entry) = text(payment, "journalEntryId").filter(|e| !e.is_empty()) else {
        return Ok(amount_of(payment, "amount"));
    };
    let Some(account) = counter_account_id else {
        return Ok(amount_of(payment, "amount"));
    };
    let lines = journal_lines::Entity::find()
        .filter(journal_lines::Column::JournalEntryId.eq(entry))
        .filter(journal_lines::Column::AccountId.eq(account))
        .filter(journal_lines::Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?;
    let mut total = 0.0;
    for line in to_json_rows(lines)? {
        let debit = amount_of(&line, "debit");
        let credit = amount_of(&line, "credit");
        total = round_money(
            total
                + if received {
                    credit - debit
                } else {
                    debit - credit
                },
        );
    }
    Ok(total)
}

/// What a payment's live allocations add up to; a payment from before
/// allocations existed settled one document with its whole amount.
async fn allocated_total(db: &PgPool, payment: &Value) -> Result<f64, DbErr> {
    let rows = payment_allocations::Entity::find()
        .filter(payment_allocations::Column::PaymentId.eq(text(payment, "id").unwrap_or_default()))
        .filter(payment_allocations::Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?;
    if rows.is_empty() {
        let single = text(payment, "invoiceId").is_some_and(|d| !d.is_empty())
            || text(payment, "billId").is_some_and(|d| !d.is_empty());
        return Ok(if single {
            amount_of(payment, "amount")
        } else {
            0.0
        });
    }
    Ok(to_json_rows(rows)?
        .iter()
        .fold(0.0, |sum, row| round_money(sum + amount_of(row, "amount"))))
}

/// The unallocated remainder of a payment, in the entity's currency; zero
/// for a payment in another currency.
pub async fn remaining_of(db: &PgPool, payment: &Value) -> Result<f64, PostError> {
    let entity_id = text(payment, "entityId").unwrap_or_default();
    let entity = load_entity(db, entity_id).await?;
    let currency = text(payment, "currency").filter(|c| !c.is_empty());
    if currency.is_some_and(|c| Some(c) != text(&entity, "baseCurrency")) {
        return Ok(0.0);
    }
    let received = text(payment, "type") == Some("received");
    let accounts = load_entity_accounts(db, entity_id).await?;
    let counter = account_for_role(
        &accounts,
        if received {
            "accounts_receivable"
        } else {
            "accounts_payable"
        },
        if received {
            fallback::ACCOUNTS_RECEIVABLE
        } else {
            fallback::ACCOUNTS_PAYABLE
        },
    )
    .and_then(|a| text(a, "id"))
    .map(str::to_owned);
    let total = counter_total(db, payment, received, counter.as_deref()).await?;
    let allocated = allocated_total(db, payment).await?;
    Ok(round_money((total - allocated).max(0.0)))
}

/// A payment of the contact with credit left, as `GET
/// /accounting-contacts/:id/credits` lists it.
fn credit_view(payment: &Value, remaining: f64) -> Value {
    json!({
        "paymentId": payment.get("id"),
        "type": payment.get("type"),
        "date": payment.get("date"),
        "currency": payment.get("currency"),
        "reference": payment.get("reference"),
        "amount": text(payment, "amount").unwrap_or("0"),
        "unallocatedAmount": to_fixed(remaining, 2),
        "bankTransactionId": payment.get("bankTransactionId"),
    })
}

/// The payments of `contact_id` (in `entity_id`) with an unallocated
/// remainder, newest first.
pub async fn credits_of_contact(
    db: &PgPool,
    entity_id: &str,
    contact_id: &str,
) -> Result<Vec<Value>, PostError> {
    let rows = payments::Entity::find()
        .filter(payments::Column::EntityId.eq(entity_id))
        .filter(payments::Column::ContactId.eq(contact_id))
        .filter(payments::Column::DeletedAt.is_null())
        .order_by_desc(payments::Column::Date)
        .all(&orm(db))
        .await?;
    let mut credits = Vec::new();
    for payment in to_json_rows(rows)? {
        let remaining = remaining_of(db, &payment).await?;
        if remaining >= 0.01 {
            credits.push(credit_view(&payment, remaining));
        }
    }
    Ok(credits)
}

/// The open document credit is applied to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Invoice(String),
    Bill(String),
}

/// What an application did.
#[derive(Debug, Clone, PartialEq)]
pub struct Applied {
    pub payment: Value,
    pub invoice: bool,
    pub document_id: String,
    pub amount: f64,
    /// What is left of the credit.
    pub remaining: f64,
}

/// Allocate `amount` of the payment's unallocated remainder to an open
/// document of the same contact: a received payment to an invoice, a sent one
/// to a bill. One transaction writes the allocation and settles the document;
/// no journal entry is posted (see the module).
#[allow(clippy::too_many_lines)] // the checks, in their order, then one transaction
pub async fn apply_credit(
    db: &PgPool,
    payment_id: &str,
    target: &Target,
    amount: f64,
) -> Result<Applied, PostError> {
    let amount = round_money(amount);
    if !amount.is_finite() || amount <= 0.0 {
        return Err(refuse("The amount must be greater than zero"));
    }
    let payment = payments::Entity::find_by_id(payment_id.to_owned())
        .filter(payments::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    let Some(payment) = payment.map(to_json).transpose()? else {
        return Err(refuse("Payment not found"));
    };
    let entity_id = text(&payment, "entityId").unwrap_or_default().to_owned();
    let received = text(&payment, "type") == Some("received");
    let (invoice, document_id) = match target {
        Target::Invoice(id) => (true, id.as_str()),
        Target::Bill(id) => (false, id.as_str()),
    };
    if invoice != received {
        return Err(refuse(if received {
            "A payment received settles an invoice, not a bill"
        } else {
            "A payment sent settles a bill, not an invoice"
        }));
    }
    if text(&payment, "depositId").is_some_and(|d| !d.is_empty()) {
        return Err(refuse(
            "This payment is part of a bank deposit and can't take another allocation",
        ));
    }

    // The document: the same entity and contact, open, with room for the amount.
    let (contact, status, balance, currency, kind) = if invoice {
        let row = invoices::Entity::find_by_id(document_id.to_owned())
            .filter(invoices::Column::DeletedAt.is_null())
            .one(&orm(db))
            .await?;
        let Some(row) = row.map(to_json).transpose()? else {
            return Err(refuse("Invoice not found"));
        };
        (
            text(&row, "contactId").map(str::to_owned),
            text(&row, "status").map(str::to_owned),
            amount_of(&row, "balanceDue"),
            text(&row, "currency").map(str::to_owned),
            (
                text(&row, "entityId").map(str::to_owned),
                text(&row, "type") == Some("credit_note"),
            ),
        )
    } else {
        let row = bills::Entity::find_by_id(document_id.to_owned())
            .filter(bills::Column::DeletedAt.is_null())
            .one(&orm(db))
            .await?;
        let Some(row) = row.map(to_json).transpose()? else {
            return Err(refuse("Bill not found"));
        };
        (
            text(&row, "contactId").map(str::to_owned),
            text(&row, "status").map(str::to_owned),
            amount_of(&row, "balanceDue"),
            text(&row, "currency").map(str::to_owned),
            (text(&row, "entityId").map(str::to_owned), false),
        )
    };
    if kind.0.as_deref() != Some(entity_id.as_str()) {
        return Err(refuse(if invoice {
            "Invoice not found"
        } else {
            "Bill not found"
        }));
    }
    if kind.1 {
        return Err(refuse("Credit can't be applied to a credit note"));
    }
    if contact.as_deref() != text(&payment, "contactId") {
        return Err(refuse(
            "The credit can only be applied to a document of the same contact",
        ));
    }
    let open = status.as_deref().is_some_and(|s| {
        if invoice {
            OPEN_INVOICE.contains(&s)
        } else {
            OPEN_BILL.contains(&s)
        }
    });
    if !open {
        return Err(refuse(if invoice {
            "This invoice is not open"
        } else {
            "This bill is not open"
        }));
    }
    let payment_currency = text(&payment, "currency").filter(|c| !c.is_empty());
    if let (Some(payment_currency), Some(document_currency)) = (
        payment_currency,
        currency.as_deref().filter(|c| !c.is_empty()),
    ) && payment_currency != document_currency
    {
        return Err(refuse(
            "The payment and the document are in different currencies",
        ));
    }
    if amount > round_money(balance) + 0.004 {
        return Err(refuse(format!(
            "The amount is more than the {} still open on the document",
            to_fixed(balance, 2)
        )));
    }
    let remaining = remaining_of(db, &payment).await?;
    if amount > remaining + 0.004 {
        return Err(refuse(format!(
            "The amount is more than the {} of unapplied credit on this payment",
            to_fixed(remaining, 2)
        )));
    }

    let stamp = now();
    let left = round_money(remaining - amount);
    let payment_key = payment_id.to_owned();
    let document = document_id.to_owned();
    let entity = entity_id.clone();
    atomically_with::<_, (), PostError, _>(db, move |conn| {
        Box::pin(async move {
            let mut allocation = Map::new();
            for (key, value) in [
                ("id", json!(generate_id("pal"))),
                ("entityId", json!(entity)),
                ("paymentId", json!(payment_key)),
                (
                    "invoiceId",
                    if invoice {
                        json!(document)
                    } else {
                        Value::Null
                    },
                ),
                (
                    "billId",
                    if invoice {
                        Value::Null
                    } else {
                        json!(document)
                    },
                ),
                ("amount", json!(to_fixed(amount, 2))),
                ("createdAt", json!(stamp)),
                ("updatedAt", json!(stamp)),
            ] {
                allocation.insert(key.to_owned(), value);
            }
            PAYMENT_ALLOCATIONS
                .insert_raw_on(
                    &OrmConn::new(&mut *conn),
                    PAYMENT_ALLOCATIONS.values(&allocation),
                )
                .await?;
            settle(&mut *conn, invoice, &document, amount).await?;
            let mut set = Map::new();
            set.insert("isPartial".to_owned(), json!(left >= 0.01));
            set.insert("updatedAt".to_owned(), json!(stamp));
            PAYMENTS
                .patch_raw_on(
                    &OrmConn::new(&mut *conn),
                    &payment_key,
                    PAYMENTS.values(&set),
                    true,
                )
                .await?;
            Ok(())
        })
    })
    .await?;
    Ok(Applied {
        payment,
        invoice,
        document_id: document_id.to_owned(),
        amount,
        remaining: left,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_credit_shows_what_is_left() {
        let payment = json!({
            "id": "pay_1", "type": "received", "date": "2026-11-02T00:00:00.000Z",
            "currency": "EUR", "reference": "INV-1", "amount": "150.00",
            "bankTransactionId": "bt_1",
        });
        let view = credit_view(&payment, 50.0);
        assert_eq!(view["paymentId"], json!("pay_1"));
        assert_eq!(view["amount"], json!("150.00"));
        assert_eq!(view["unallocatedAmount"], json!("50.00"));
        assert_eq!(view["bankTransactionId"], json!("bt_1"));
    }
}
