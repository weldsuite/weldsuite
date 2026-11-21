//! B2B approvals and pay on invoice (ADR COM-012).
//!
//! - **Approval.** An order above the buyer's spend limit, or above the
//!   company's approval threshold, is placed with `approval_status =
//!   'pending'` and an `order_approvals` row. It cannot move to confirmed or
//!   processing, is not released to WeldStash and is not invoiced until an
//!   approver (a company approver or admin, or staff) decides. A limit in
//!   another currency than the order's is not applied: there is no rate to
//!   compare with.
//! - **Pay on invoice.** Allowed when the company's party has payment terms
//!   and the order stays within the party's credit limit: its
//!   `outstanding_balance` (invoices WeldBooks keeps) plus the orders on
//!   invoice that have no invoice yet (pending approval, or invoicing that
//!   failed) plus this order.
//!
//! Every function runs on the caller's connection, inside its transaction.

use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use weldsuite_kit::generate_id;

use crate::error::Error;
use crate::money::{self, Cents};
use crate::orders::write;

const TS: &str = "'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'";

/// Why the order needs an approval, when it does: `buyer_limit` (above the
/// buyer's spend limit) before `company_threshold`.
///
/// # Errors
/// A failed statement.
pub async fn reason_for(
    conn: &mut PgConnection,
    buyer_id: &str,
    company_id: &str,
    total: Cents,
    currency: &str,
) -> Result<Option<&'static str>, sqlx::Error> {
    let limit: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "select spend_limit::text, spend_limit_currency from commerce_buyers where id = $1",
    )
    .bind(buyer_id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some((Some(amount), Some(code))) = limit
        && code.eq_ignore_ascii_case(currency)
        && money::parse(&amount).is_some_and(|limit| total > limit)
    {
        return Ok(Some("buyer_limit"));
    }
    let threshold: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "select approval_threshold::text, approval_threshold_currency \
         from commerce_company_settings where company_id = $1",
    )
    .bind(company_id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some((Some(amount), Some(code))) = threshold
        && code.eq_ignore_ascii_case(currency)
        && money::parse(&amount).is_some_and(|limit| total > limit)
    {
        return Ok(Some("company_threshold"));
    }
    Ok(None)
}

/// Put the order to approval: `approval_status = 'pending'` and the request.
///
/// # Errors
/// A failed statement.
pub async fn request(
    conn: &mut PgConnection,
    order_id: &str,
    reason: &str,
    requested_by_person_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update orders set approval_status = 'pending', updated_at = now() at time zone 'utc' \
         where id = $1",
    )
    .bind(order_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "insert into order_approvals (id, order_id, reason, requested_by_person_id, decision) \
         values ($1, $2, $3, $4, 'pending')",
    )
    .bind(generate_id("oapr"))
    .bind(order_id)
    .bind(reason)
    .bind(requested_by_person_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// A Money amount stored by JavaScript (`{ amount: number, currency }`).
fn money_of(value: &Value) -> Option<(Cents, String)> {
    let amount = match value.get("amount")? {
        Value::Number(n) => money::parse(&format!("{:.2}", n.as_f64()?))?,
        Value::String(s) => money::parse(s)?,
        _ => return None,
    };
    Some((
        amount,
        value.get("currency")?.as_str()?.to_ascii_uppercase(),
    ))
}

/// Pay on invoice: the company's party has payment terms, and the order
/// stays within its credit limit.
///
/// # Errors
/// [`Error::NoPaymentTerms`], [`Error::CreditLimitExceeded`] with what is
/// left.
pub async fn check_invoice_terms(
    conn: &mut PgConnection,
    party_id: &str,
    order_id: &str,
    total: Cents,
    currency: &str,
) -> Result<(), Error> {
    let party: Option<(Option<String>, Option<Value>, Option<String>)> = sqlx::query_as(
        "select payment_terms, credit_limit, outstanding_balance::text from parties \
         where id = $1 and deleted_at is null",
    )
    .bind(party_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((terms, limit, balance)) = party else {
        return Err(Error::NoPaymentTerms);
    };
    if terms.as_deref().is_none_or(|t| t.trim().is_empty()) {
        return Err(Error::NoPaymentTerms);
    }
    let Some((limit, limit_currency)) = limit.as_ref().and_then(money_of) else {
        return Ok(());
    };
    if !limit_currency.eq_ignore_ascii_case(currency) {
        return Ok(());
    }
    let open: String = sqlx::query_scalar(
        "select coalesce(sum(o.total), 0)::text from orders o \
         where o.counterparty_id = $1 and o.id <> $2 and o.deleted_at is null \
           and o.payment_status = 'on_invoice' and o.status <> 'cancelled' \
           and not exists (select 1 from invoices i where i.commerce_order_id = o.id \
             and i.deleted_at is null and i.status not in ('cancelled', 'void', 'written_off'))",
    )
    .bind(party_id)
    .bind(order_id)
    .fetch_one(&mut *conn)
    .await?;
    let taken =
        balance.as_deref().and_then(money::parse).unwrap_or(0) + money::parse(&open).unwrap_or(0);
    if taken + total > limit {
        return Err(Error::CreditLimitExceeded {
            available: (limit - taken).max(0),
        });
    }
    Ok(())
}

/// Who decides.
#[derive(Debug, Clone, Default)]
pub struct Decider<'a> {
    /// A shopper: their person id.
    pub person_id: Option<&'a str>,
    /// Staff: `{ userId, name, email }`, kept on the order.
    pub staff: Option<Value>,
}

/// What a decision changed, for what follows it after the commit.
#[derive(Debug, Clone)]
pub struct Decided {
    pub order_id: String,
    pub approved: bool,
    pub order_number: String,
    pub payment_method: Option<String>,
    /// The buyer who placed the order.
    pub requested_by_person_id: Option<String>,
    /// Where a Mollie payment sends the shopper back to.
    pub redirect_url: Option<String>,
}

/// Approve or reject a pending order, with the comment.
///
/// Approved: an order on invoice is confirmed (the caller invoices it after
/// the commit); a Mollie order stays `pending` until it is paid (the caller
/// starts the payment). Rejected: the order is cancelled and its discount
/// redemption given back.
///
/// # Errors
/// [`Error::NotFound`], [`Error::NotPending`].
pub async fn decide(
    conn: &mut PgConnection,
    order_id: &str,
    approve: bool,
    comment: Option<&str>,
    by: &Decider<'_>,
) -> Result<Decided, Error> {
    let stored = crate::orders::load(conn, order_id, true)
        .await?
        .ok_or_else(|| Error::not_found("Order", order_id))?;
    if stored.text("approvalStatus") != Some("pending") {
        return Err(Error::NotPending);
    }
    let decision = if approve { "approved" } else { "rejected" };
    let changed = sqlx::query(
        "update order_approvals set decision = $2, comment = $3, approver_person_id = $4, \
           decided_at = now() at time zone 'utc', updated_at = now() at time zone 'utc' \
         where order_id = $1 and decision = 'pending'",
    )
    .bind(order_id)
    .bind(decision)
    .bind(comment)
    .bind(by.person_id)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if changed == 0 {
        return Err(Error::NotPending);
    }
    let mut metadata = stored
        .order
        .get("metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(staff) = &by.staff {
        metadata.insert("approvalDecidedBy".to_owned(), staff.clone());
    }
    sqlx::query(
        "update orders set approval_status = $2, metadata = $3, \
           updated_at = now() at time zone 'utc' where id = $1",
    )
    .bind(order_id)
    .bind(decision)
    .bind(Value::Object(metadata.clone()))
    .execute(&mut *conn)
    .await?;
    let method = stored.text("paymentMethod").map(str::to_owned);
    if approve {
        if stored.text("paymentStatus") == Some("on_invoice") {
            write::confirm(conn, order_id).await?;
        }
    } else {
        write::cancel(
            conn,
            order_id,
            Some(comment.unwrap_or("Rejected by an approver")),
        )
        .await?;
    }
    let requested: Option<String> = sqlx::query_scalar(
        "select requested_by_person_id from order_approvals where order_id = $1 \
         order by created_at desc, id desc limit 1",
    )
    .bind(order_id)
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    Ok(Decided {
        order_id: order_id.to_owned(),
        approved: approve,
        order_number: stored.text("orderNumber").unwrap_or_default().to_owned(),
        payment_method: method,
        requested_by_person_id: requested,
        redirect_url: metadata
            .get("redirectUrl")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// A person or staff member as the staff API shows an actor.
fn actor(person: Option<(String, Option<String>, Option<String>)>, staff: Option<&Value>) -> Value {
    if let Some((id, name, email)) = person {
        return json!({
            "personId": id,
            "name": name.clone().or_else(|| email.clone()),
            "email": email,
        });
    }
    match staff {
        Some(staff) => {
            let name = staff
                .get("name")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
                .or_else(|| staff.get("email").and_then(Value::as_str))
                .or_else(|| staff.get("userId").and_then(Value::as_str));
            json!({
                "userId": staff.get("userId"),
                "name": name,
                "email": staff.get("email"),
            })
        }
        None => Value::Null,
    }
}

async fn person_actor(
    conn: &mut PgConnection,
    id: Option<&str>,
) -> Result<Option<(String, Option<String>, Option<String>)>, sqlx::Error> {
    let Some(id) = id else {
        return Ok(None);
    };
    sqlx::query_as("select id, display_name, email from people where id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
}

/// The order's approval for the staff API (`Order.approval`), or null.
///
/// # Errors
/// A failed statement.
pub async fn approval_view(
    conn: &mut PgConnection,
    order_id: &str,
    metadata: Option<&Value>,
) -> Result<Value, sqlx::Error> {
    #[allow(clippy::type_complexity)]
    let row: Option<(
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select reason, decision, comment, to_char(decided_at, {TS}), \
               requested_by_person_id, approver_person_id \
             from order_approvals where order_id = $1 order by created_at desc, id desc limit 1"
    )))
    .bind(order_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((reason, decision, comment, decided_at, requested, approver)) = row else {
        return Ok(Value::Null);
    };
    let requested_by = person_actor(conn, requested.as_deref()).await?;
    let decided_by = person_actor(conn, approver.as_deref()).await?;
    let staff = metadata.and_then(|m| m.get("approvalDecidedBy"));
    let mut out = Map::new();
    out.insert("status".to_owned(), json!(decision));
    out.insert("reason".to_owned(), json!(reason));
    out.insert("requestedBy".to_owned(), actor(requested_by, None));
    out.insert(
        "decidedBy".to_owned(),
        if decision == "pending" {
            Value::Null
        } else {
            actor(decided_by, staff)
        },
    );
    out.insert("decidedAt".to_owned(), json!(decided_at));
    out.insert("comment".to_owned(), json!(comment));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn money_is_read_as_javascript_stores_it() {
        assert_eq!(
            money_of(&json!({ "amount": 1500, "currency": "eur" })),
            Some((150_000, "EUR".to_owned()))
        );
        assert_eq!(
            money_of(&json!({ "amount": "20.50", "currency": "EUR" })),
            Some((2050, "EUR".to_owned()))
        );
        assert_eq!(money_of(&json!({ "currency": "EUR" })), None);
        assert_eq!(
            money_of(&json!({ "amount": null, "currency": "EUR" })),
            None
        );
    }

    #[test]
    fn an_actor_always_has_a_name() {
        let person = actor(Some(("per_1".into(), None, Some("a@b.test".into()))), None);
        assert_eq!(person["name"], "a@b.test");
        let staff = actor(None, Some(&json!({ "userId": "user_1", "name": null })));
        assert_eq!(staff["name"], "user_1");
        assert_eq!(actor(None, None), Value::Null);
    }
}
