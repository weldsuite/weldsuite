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

use sea_orm::ActiveValue::Set;
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Query};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use time::PrimitiveDateTime;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    commerce_buyers, commerce_company_settings, invoices, order_approvals, orders, parties, people,
};

use crate::db;
use crate::error::Error;
use crate::money::{self, Cents};
use crate::orders::write;
use crate::prices::parse_numeric;

/// `to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`: milliseconds, truncated.
fn iso(at: PrimitiveDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    )
}

/// Whether `total` is past a limit in `currency` (a limit in another
/// currency is not applied).
fn exceeds(
    limit: Option<(Option<BigDecimal>, Option<String>)>,
    total: Cents,
    currency: &str,
) -> bool {
    matches!(
        limit,
        Some((Some(amount), Some(code)))
            if code.eq_ignore_ascii_case(currency)
                && parse_numeric(&amount).is_some_and(|limit| total > limit)
    )
}

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
) -> Result<Option<&'static str>, DbErr> {
    let limit = commerce_buyers::Entity::find_by_id(buyer_id.to_owned())
        .select_only()
        .column(commerce_buyers::Column::SpendLimit)
        .column(commerce_buyers::Column::SpendLimitCurrency)
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    if exceeds(limit, total, currency) {
        return Ok(Some("buyer_limit"));
    }
    let threshold = commerce_company_settings::Entity::find()
        .select_only()
        .column(commerce_company_settings::Column::ApprovalThreshold)
        .column(commerce_company_settings::Column::ApprovalThresholdCurrency)
        .filter(commerce_company_settings::Column::CompanyId.eq(company_id))
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    if exceeds(threshold, total, currency) {
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
) -> Result<(), DbErr> {
    orders::Entity::update_many()
        .col_expr(orders::Column::ApprovalStatus, Expr::value("pending"))
        .col_expr(orders::Column::UpdatedAt, Expr::value(db::now()))
        .filter(orders::Column::Id.eq(order_id))
        .exec(&db::on(conn))
        .await?;
    order_approvals::ActiveModel {
        id: Set(generate_id("oapr")),
        order_id: Set(order_id.to_owned()),
        reason: Set(reason.to_owned()),
        requested_by_person_id: Set(requested_by_person_id.map(str::to_owned)),
        decision: Set("pending".to_owned()),
        ..Default::default()
    }
    .insert(&db::on(conn))
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

/// `sum(orders.total)`.
fn sum_of_totals() -> Expr {
    // Scoped: `ExprTrait` is implemented for numbers too, and would make
    // their `max` ambiguous elsewhere in this module.
    use sea_orm::sea_query::ExprTrait;
    Expr::col((orders::Entity, orders::Column::Total)).sum()
}

/// The order has no invoice that counts yet: none live, or only cancelled,
/// void or written-off ones.
fn not_invoiced() -> Expr {
    use sea_orm::sea_query::ExprTrait;
    Expr::not_exists(
        Query::select()
            .expr(Expr::val(1))
            .from(invoices::Entity)
            .and_where(
                Expr::col((invoices::Entity, invoices::Column::CommerceOrderId))
                    .equals((orders::Entity, orders::Column::Id)),
            )
            .and_where(Expr::col((invoices::Entity, invoices::Column::DeletedAt)).is_null())
            .and_where(
                Expr::col((invoices::Entity, invoices::Column::Status)).is_not_in([
                    "cancelled",
                    "void",
                    "written_off",
                ]),
            )
            .to_owned(),
    )
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
    let party: Option<(Option<String>, Option<Value>, Option<BigDecimal>)> =
        parties::Entity::find_by_id(party_id.to_owned())
            .filter(parties::Column::DeletedAt.is_null())
            .select_only()
            .column(parties::Column::PaymentTerms)
            .column(parties::Column::CreditLimit)
            .column(parties::Column::OutstandingBalance)
            .into_tuple()
            .one(&db::on(conn))
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
    let open: Option<Option<BigDecimal>> = orders::Entity::find()
        .select_only()
        .column_as(sum_of_totals(), "open")
        .filter(orders::Column::CounterpartyId.eq(party_id))
        .filter(orders::Column::Id.ne(order_id))
        .filter(orders::Column::DeletedAt.is_null())
        .filter(orders::Column::PaymentStatus.eq("on_invoice"))
        .filter(orders::Column::Status.ne("cancelled"))
        .filter(not_invoiced())
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    // `coalesce(sum(total), 0)`.
    let open = open.flatten().as_ref().map_or(Some(0), parse_numeric);
    let taken = balance.as_ref().and_then(parse_numeric).unwrap_or(0) + open.unwrap_or(0);
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
    let now = db::now();
    let changed = order_approvals::Entity::update_many()
        .col_expr(order_approvals::Column::Decision, Expr::value(decision))
        .col_expr(
            order_approvals::Column::Comment,
            Expr::value(comment.map(str::to_owned)),
        )
        .col_expr(
            order_approvals::Column::ApproverPersonId,
            Expr::value(by.person_id.map(str::to_owned)),
        )
        .col_expr(order_approvals::Column::DecidedAt, Expr::value(now))
        .col_expr(order_approvals::Column::UpdatedAt, Expr::value(now))
        .filter(order_approvals::Column::OrderId.eq(order_id))
        .filter(order_approvals::Column::Decision.eq("pending"))
        .exec(&db::on(conn))
        .await?
        .rows_affected;
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
    orders::Entity::update_many()
        .col_expr(orders::Column::ApprovalStatus, Expr::value(decision))
        .col_expr(
            orders::Column::Metadata,
            Expr::value(Value::Object(metadata.clone())),
        )
        .col_expr(orders::Column::UpdatedAt, Expr::value(db::now()))
        .filter(orders::Column::Id.eq(order_id))
        .exec(&db::on(conn))
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
    let requested: Option<String> = order_approvals::Entity::find()
        .select_only()
        .column(order_approvals::Column::RequestedByPersonId)
        .filter(order_approvals::Column::OrderId.eq(order_id))
        .order_by_desc(order_approvals::Column::CreatedAt)
        .order_by_desc(order_approvals::Column::Id)
        .into_tuple::<Option<String>>()
        .one(&db::on(conn))
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

/// A person as an actor: id, name and e-mail (deleted or not).
pub(crate) async fn person_actor(
    conn: &mut PgConnection,
    id: Option<&str>,
) -> Result<Option<(String, Option<String>, Option<String>)>, DbErr> {
    let Some(id) = id else {
        return Ok(None);
    };
    let found: Option<(String, String, Option<String>)> = people::Entity::find_by_id(id.to_owned())
        .select_only()
        .column(people::Column::Id)
        .column(people::Column::DisplayName)
        .column(people::Column::Email)
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    Ok(found.map(|(id, name, email)| (id, Some(name), email)))
}

/// The order's approval for the staff API (`Order.approval`), or null.
///
/// # Errors
/// A failed statement.
pub async fn approval_view(
    conn: &mut PgConnection,
    order_id: &str,
    metadata: Option<&Value>,
) -> Result<Value, DbErr> {
    let row = order_approvals::Entity::find()
        .filter(order_approvals::Column::OrderId.eq(order_id))
        .order_by_desc(order_approvals::Column::CreatedAt)
        .order_by_desc(order_approvals::Column::Id)
        .one(&db::on(conn))
        .await?;
    let Some(row) = row else {
        return Ok(Value::Null);
    };
    let (reason, decision, comment) = (row.reason, row.decision, row.comment);
    let decided_at = row.decided_at.map(iso);
    let (requested, approver) = (row.requested_by_person_id, row.approver_person_id);
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
