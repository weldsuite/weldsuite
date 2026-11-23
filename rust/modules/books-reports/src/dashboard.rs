//! `/api/accounting-dashboard` (`routes/accounting-dashboard/index.ts`): the
//! WeldBooks dashboard's figures for one entity, in its base currency.
//! Revenue, expenses and profit (and the 12- and 24-month trends) are the
//! ledger's profit and loss on the entity's basis; receivables and payables
//! are the aged documents. Read-only.

use std::sync::Arc;

use axum::Router;
use axum::response::Response;
use axum::routing::get;
use sea_orm::sea_query::Condition;
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use weldsuite_books_domain::dates::last_day_of_month;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, reply};
use weldsuite_books_domain::js::{days_from_civil, parse_float};
use weldsuite_books_domain::reports_basis::{
    AggregateOptions, DateRange, LedgerFilters, LedgerRange, ReportColumn, create_ledger, money,
    resolve_basis, today_for,
};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{bank_accounts, documents, entities, invoices, payments};

use crate::ordered::Json;
use crate::reports::build::{self, BuildError, balance_in_base};
use crate::rows::{js, js_rows, money_text, timestamp_of_millis};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/",
            get(dashboard).route_layer(gate.require(["reports:read".to_owned()])),
        )
        .with_state(state)
}

/// `monthColumns(today, count)`: `YYYY-MM` columns for the last `count`
/// calendar months, ending with the month of `today`.
fn month_columns(today: &str, count: i64) -> Vec<ReportColumn> {
    let year: i64 = today.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(1970);
    let month: i64 = today.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1);
    (0..count)
        .rev()
        .map(|i| {
            let index = year * 12 + (month - 1 - i);
            let (y, m) = (index.div_euclid(12), index.rem_euclid(12) + 1);
            let key = format!("{y:04}-{m:02}");
            ReportColumn {
                label: key.clone(),
                from: Some(format!("{key}-01")),
                to: last_day_of_month(y, m),
                key,
            }
        })
        .collect()
}

/// `{ id, name, iban, currentBalance, currency }` of a bank account, and the
/// ledger account it is linked to.
type BankAccountRow = (
    String,
    String,
    Option<String>,
    Option<sea_orm::prelude::BigDecimal>,
    Option<String>,
    Option<String>,
);

fn refusal(error: BuildError) -> Refusal {
    match error {
        BuildError::Input(error) => Refusal::Internal(error.0),
        BuildError::Database(error) => Refusal::Database(error),
        BuildError::Internal(error) => Refusal::Internal(error),
    }
}

async fn dashboard(caller: Caller) -> Response {
    reply(
        build_dashboard(&caller).await,
        "Failed to fetch dashboard data",
    )
}

#[allow(clippy::too_many_lines)] // the route's one handler
async fn build_dashboard(caller: &Caller) -> Reply {
    let db = &caller.db;
    let orm = weldsuite_db::orm(db);
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let entity = entities::Entity::find_by_id(entity_id.clone())
        .filter(entities::Column::DeletedAt.is_null())
        .one(&orm)
        .await?;
    let Some(entity) = entity.map(|row| js!(row)).transpose()? else {
        return Err(Refusal::not_found("Accounting entity", &entity_id));
    };
    let base_currency = entity
        .get("baseCurrency")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let now = caller.now_ms();
    let today = today_for(entity.get("timezone").and_then(Value::as_str), now);
    let year: i64 = today.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(1970);
    let month: i64 = today.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1);
    let month_start = days_from_civil(year, month, 1) * 86_400_000;

    // Revenue, expenses and profit: the ledger's profit and loss. The trend
    // runs 24 months so the dashboard can compare any range with the one
    // before it.
    let trend = month_columns(&today, 24);
    let year_column = ReportColumn {
        key: "year".to_owned(),
        label: year.to_string(),
        from: Some(format!("{year}-01-01")),
        to: format!("{year}-12-31"),
    };
    let basis = resolve_basis(
        db,
        entity.get("accountingMethod").and_then(Value::as_str),
        None,
    )
    .await?;
    let year_end = days_from_civil(year, 12, 31) * 86_400_000 + 86_399_999;
    let ledger = create_ledger(db, &entity_id, basis, LedgerFilters::default(), year_end).await?;
    let mut columns = trend.clone();
    columns.push(year_column.clone());
    let profit_loss = build::build_profit_loss(
        &ledger,
        &columns,
        &DateRange {
            from: trend[0].from.clone().unwrap_or_default(),
            to: year_column.to.clone(),
        },
    )
    .await
    .map_err(refusal)?;
    let revenue = profit_loss.total("totalRevenue");
    let expenses = profit_loss.total("totalExpenses");
    let profit = profit_loss.total("netProfit");
    let current_month = &trend[trend.len() - 1].key;

    // Posted standard invoices issued this month.
    let issued_this_month = invoices::Entity::find()
        .filter(invoices::Column::EntityId.eq(&entity_id))
        .filter(invoices::Column::DeletedAt.is_null())
        .filter(invoices::Column::IssueDate.gte(timestamp_of_millis(month_start)?))
        .filter(invoices::Column::Type.eq("standard"))
        .filter(invoices::Column::Status.is_not_in(["draft", "cancelled", "void"]))
        .count(&orm)
        .await?;
    // `count(*)::int`.
    let issued_this_month = i32::try_from(issued_this_month).unwrap_or(i32::MAX);

    // Receivables and payables: the aged reports' documents, in base currency.
    let aged_receivables = build::build_aged_report(db, &entity_id, true, &today)
        .await
        .map_err(refusal)?;
    let aged_payables = build::build_aged_report(db, &entity_id, false, &today)
        .await
        .map_err(refusal)?;
    let summarize = |report: &build::AgedReport| {
        let overdue: Vec<&build::AgedDocument> = report
            .documents
            .iter()
            .filter(|d| d.days_past_due > 0 && parse_float(&d.balance) > 0.0)
            .collect();
        Json::object([
            ("outstanding", Json::from(json!(report.total))),
            (
                "outstandingCount",
                Json::from(json!(report.documents.len())),
            ),
            (
                "overdue",
                Json::from(json!(money(
                    overdue.iter().fold(0.0, |t, d| t + parse_float(&d.balance))
                ))),
            ),
            ("overdueCount", Json::from(json!(overdue.len()))),
            ("aging", report.aging()),
        ])
    };

    // Bank balances (entity-scoped).
    let bank_accounts: Vec<BankAccountRow> = bank_accounts::Entity::find()
        .select_only()
        .columns([
            bank_accounts::Column::Id,
            bank_accounts::Column::Name,
            bank_accounts::Column::Iban,
            bank_accounts::Column::CurrentBalance,
            bank_accounts::Column::Currency,
            bank_accounts::Column::LedgerAccountId,
        ])
        .filter(bank_accounts::Column::EntityId.eq(&entity_id))
        .filter(bank_accounts::Column::DeletedAt.is_null())
        .filter(bank_accounts::Column::IsActive.eq(true))
        .into_tuple()
        .all(&orm)
        .await?;

    // Cash: the ledger balance of the money accounts. `currentBalance` above
    // moves only with bank transactions, so a payment recorded without a
    // statement line would not show in it.
    let mut money_account_ids: Vec<String> = Vec::new();
    for (.., ledger_account_id) in &bank_accounts {
        if let Some(id) = ledger_account_id.as_ref().filter(|id| !id.is_empty())
            && !money_account_ids.contains(id)
        {
            money_account_ids.push(id.clone());
        }
    }
    let any_linked_bank: Option<String> = bank_accounts::Entity::find()
        .select_only()
        .column(bank_accounts::Column::Id)
        .filter(bank_accounts::Column::EntityId.eq(&entity_id))
        .filter(bank_accounts::Column::DeletedAt.is_null())
        .filter(bank_accounts::Column::LedgerAccountId.is_not_null())
        .into_tuple()
        .one(&orm)
        .await?;
    if any_linked_bank.is_none() {
        // No bank account is linked to the ledger: payments post to the
        // chart's bank account (see `resolve_money_account`).
        let template_code = if entity.get("jurisdictionCode").and_then(Value::as_str) == Some("IN")
        {
            "1200"
        } else {
            "1100"
        };
        let chart = || ledger.accounts().iter().filter(|a| !a.virtual_account);
        let fallback = chart()
            .find(|a| a.code == template_code && a.subtype.as_deref() == Some("bank"))
            .or_else(|| chart().find(|a| a.subtype.as_deref() == Some("bank")));
        if let Some(fallback) = fallback
            && !money_account_ids.contains(&fallback.id)
        {
            money_account_ids.push(fallback.id.clone());
        }
    }
    let cash_balance = if money_account_ids.is_empty() {
        0.0
    } else {
        let ids: Vec<&str> = money_account_ids.iter().map(String::as_str).collect();
        let today_end = days_from_civil(
            year,
            month,
            today.get(8..10).and_then(|d| d.parse().ok()).unwrap_or(1),
        ) * 86_400_000
            + 86_399_999;
        ledger
            .aggregate(
                LedgerRange {
                    from: None,
                    to: today_end,
                },
                AggregateOptions {
                    account_ids: &ids,
                    ..AggregateOptions::default()
                },
            )
            .await?
            .iter()
            .fold(0.0, |total, row| {
                let credit_side = ledger
                    .account(&row.account_id)
                    .is_some_and(|a| a.normal_side == "credit");
                total
                    + if credit_side {
                        row.credit - row.debit
                    } else {
                        row.debit - row.credit
                    }
            })
    };

    // Recent payments (last 10).
    let recent_payments = payments::Entity::find()
        .filter(payments::Column::EntityId.eq(&entity_id))
        .filter(payments::Column::DeletedAt.is_null())
        .order_by_desc(payments::Column::Date)
        .limit(10)
        .all(&orm)
        .await?;
    let recent_payments = js_rows!(recent_payments)?;

    // Upcoming due invoices (next 30 days): posted, no credit notes, in base
    // currency.
    let upcoming = invoices::Entity::find()
        .filter(invoices::Column::EntityId.eq(&entity_id))
        .filter(invoices::Column::DeletedAt.is_null())
        .filter(invoices::Column::BalanceDue.gt(0))
        .filter(invoices::Column::Status.is_not_in([
            "draft",
            "cancelled",
            "void",
            "paid",
            "uncollectible",
            "written_off",
        ]))
        .filter(invoices::Column::Type.is_not_in(["credit_note", "proforma"]))
        .filter(
            invoices::Column::DueDate
                .lte(timestamp_of_millis(now + 30 * 24 * 60 * 60 * 1000)?),
        )
        .filter(invoices::Column::DueDate.gte(timestamp_of_millis(now)?))
        .order_by_asc(invoices::Column::DueDate)
        .limit(10)
        .all(&orm)
        .await?;
    let upcoming = js_rows!(upcoming)?;
    let upcoming_due: Vec<Value> = upcoming
        .into_iter()
        .map(|row| {
            let balance = weldsuite_books_domain::js::numeric(&row["balanceDue"]);
            json!({
                "id": row["id"],
                "invoiceNumber": row["invoiceNumber"],
                "contactName": row["contactName"],
                "dueDate": row["dueDate"],
                "balanceDue": money(balance_in_base(
                    balance,
                    row["currency"].as_str(),
                    row["exchangeRate"].as_str(),
                    &base_currency,
                )),
            })
        })
        .collect();

    // Documents to process: the entity's, and the ones that name no entity (an upload or an
    // emailed document is not filed under one), as the documents inbox lists them.
    let pending_documents = documents::Entity::find()
        .filter(
            Condition::any()
                .add(documents::Column::EntityId.eq(&entity_id))
                .add(documents::Column::EntityId.is_null()),
        )
        .filter(documents::Column::DeletedAt.is_null())
        .filter(documents::Column::Status.is_in(["pending", "processing", "processed"]))
        .count(&orm)
        .await?;
    // `count(*)::int`.
    let pending_documents = i32::try_from(pending_documents).unwrap_or(i32::MAX);

    let value = |set: &build::ValueSet, key: &str| set.value(key).map_or(Value::Null, |v| json!(v));
    let last_twelve = &trend[trend.len() - 12..];
    let mut data = Json::from(json!({
        "currency": base_currency,
        "revenue": {
            "month": value(revenue, current_month),
            "year": value(revenue, "year"),
            "invoiceCount": issued_this_month,
        },
        "expenses": {
            "month": value(expenses, current_month),
            "year": value(expenses, "year"),
        },
        "profit": {
            "month": value(profit, current_month),
            "year": value(profit, "year"),
        },
        "cashBalance": money(cash_balance),
        "bankAccounts": bank_accounts.into_iter().map(|(id, name, iban, balance, currency, _)| json!({
            "id": id,
            "name": name,
            "iban": iban,
            "currentBalance": balance.as_ref().map(money_text),
            "currency": currency,
        })).collect::<Vec<_>>(),
        "recentPayments": recent_payments,
        "upcomingDue": upcoming_due,
        "pendingDocuments": pending_documents,
        "monthlyRevenue": last_twelve.iter().map(|c| json!({
            "month": c.key,
            "total": value(revenue, &c.key),
        })).collect::<Vec<_>>(),
        "monthlyTrend": trend.iter().map(|c| json!({
            "month": c.key,
            "revenue": value(revenue, &c.key),
            "expenses": value(expenses, &c.key),
            "profit": value(profit, &c.key),
        })).collect::<Vec<_>>(),
    }));
    data.set("receivables", summarize(&aged_receivables));
    data.set("payables", summarize(&aged_payables));
    Ok(crate::ordered::ok(&data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn month_columns_end_with_this_month() {
        let columns = month_columns("2026-02-14", 3);
        let keys: Vec<&str> = columns.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(keys, ["2025-12", "2026-01", "2026-02"]);
        assert_eq!(columns[2].to, "2026-02-28");
    }
}
