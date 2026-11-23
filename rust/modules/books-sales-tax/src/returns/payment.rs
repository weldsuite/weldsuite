//! Recording the payment of a filed return (`services/sales-tax-returns/payment.ts`):
//! one journal entry settles the return (the agency's payables, tax on
//! uncured exempt sales as an expense, each adjustment on its own account,
//! the bank), posted once per return; the return becomes `paid` with it.

use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect, UpdateMany};
use serde_json::{Value, json};
use weldsuite_books_domain::guards::PostingLockKind;
use weldsuite_books_domain::js::to_fixed;
use weldsuite_books_domain::posting::{
    EntityAccounts, PostJournalEntryInput, PostingLine, account_for_role, load_entity_accounts,
    post_journal_entry,
};
use weldsuite_db::{OrmConn, PgPool, orm};
use weldsuite_schema::tenant::{bank_accounts, tax_returns};

use super::common::{
    adjustments_of, bad, bad_with, compute_total_due, conflict, decimal, n, not_found, num, num_at,
    parse_instant, return_by_id, round2, s, sum_money,
};
use crate::common::text;

fn adjustment_label(kind: &str) -> &str {
    match kind {
        "vendor_discount" => "Vendor discount",
        "prepayment" => "Prepayment credit",
        "penalty" => "Penalty",
        "interest" => "Interest",
        "rounding" => "Rounding",
        "other" => "Other adjustment",
        other => other,
    }
}

/// Why a payment can't be posted (`TaxReturnError`) or the posting failed.
pub(crate) enum PaymentFailure {
    Refused(weldsuite_books_domain::http::Refusal),
    Post(weldsuite_books_domain::posting::PostError),
}

impl From<sqlx::Error> for PaymentFailure {
    fn from(error: sqlx::Error) -> Self {
        Self::Refused(error.into())
    }
}

impl From<DbErr> for PaymentFailure {
    fn from(error: DbErr) -> Self {
        Self::Refused(weldsuite_books_domain::http::Refusal::Database(error))
    }
}

impl From<weldsuite_books_domain::http::Refusal> for PaymentFailure {
    fn from(refusal: weldsuite_books_domain::http::Refusal) -> Self {
        Self::Refused(refusal)
    }
}

fn required(account: Option<&Value>, what: &str) -> Result<String, PaymentFailure> {
    account.map(|a| s(a, "id").to_owned()).ok_or_else(|| {
        PaymentFailure::Refused(bad(format!(
            "No {what} account found for this accounting entity"
        )))
    })
}

/// `paymentLines(...)`: the ledger lines of a return's payment (no bank
/// line) and what they debit on the agency's payables.
#[allow(clippy::too_many_lines, reason = "mirrors payment.ts's paymentLines()")]
fn payment_lines(
    accounts: &EntityAccounts,
    agency: &Value,
    ret: &Value,
    difference: f64,
    difference_reason: Option<&str>,
) -> Result<(Vec<PostingLine>, f64), PaymentFailure> {
    let summary = &ret["summary"];
    let liability = accounts
        .by_id(text(agency, "liabilityAccountId"))
        .or_else(|| account_for_role(accounts, "sales_tax_payable", &["2200"]));
    let use_tax = accounts
        .by_id(text(agency, "useTaxAccountId"))
        .or_else(|| account_for_role(accounts, "use_tax_payable", &["2210"]));
    let period = format!("{} to {}", s(ret, "periodStart"), s(ret, "periodEnd"));
    let name = s(agency, "name");
    let mut lines: Vec<PostingLine> = Vec::new();
    let mut liability_debit = 0.0;
    let line = |account_id: String, debit: f64, description: String| PostingLine {
        account_id,
        debit,
        description: Some(description),
        ..PostingLine::default()
    };

    let sales = num(summary.get("salesTaxPayable").unwrap_or(&Value::Null));
    let uncured = num(summary.get("uncuredTaxPayable").unwrap_or(&Value::Null));
    let use_payable = num(summary.get("useTaxPayable").unwrap_or(&Value::Null));
    #[allow(clippy::float_cmp, reason = "`!== 0`, as TypeScript")]
    if sales - uncured != 0.0 {
        lines.push(line(
            required(liability, "sales tax payable")?,
            round2(sales - uncured),
            format!("Sales tax {name} {period}"),
        ));
        liability_debit += sales - uncured;
    }
    if uncured != 0.0 {
        let expense = required(
            account_for_role(accounts, "tax_penalties_interest", &["7040"]),
            "tax penalties and interest",
        )?;
        lines.push(line(
            expense,
            round2(uncured),
            format!("Sales tax on exempt sales without a certificate {name} {period}"),
        ));
    }
    if use_payable != 0.0 {
        lines.push(line(
            required(use_tax, "use tax payable")?,
            round2(use_payable),
            format!("Use tax {name} {period}"),
        ));
        liability_debit += use_payable;
    }

    for adj in adjustments_of(ret) {
        let amount = num_at(&adj, "amount");
        if amount == 0.0 {
            continue;
        }
        let kind = s(&adj, "type");
        let account = match kind {
            "vendor_discount" => required(
                account_for_role(accounts, "sales_tax_vendor_discount", &["4110"]),
                "sales tax vendor discount",
            )?,
            "penalty" | "interest" => required(
                account_for_role(accounts, "tax_penalties_interest", &["7040"]),
                "tax penalties and interest",
            )?,
            "rounding" => required(
                account_for_role(accounts, "rounding", &["7110"]),
                "rounding",
            )?,
            "prepayment" => required(liability, "sales tax payable")?,
            _ => {
                let chosen_id = text(&adj, "accountId").filter(|a| !a.is_empty());
                let chosen = chosen_id.and_then(|id| accounts.by_id(Some(id)));
                if let Some(id) = chosen_id
                    && chosen.is_none()
                {
                    return Err(PaymentFailure::Refused(bad(format!(
                        "Adjustment account {id} does not belong to this accounting entity"
                    ))));
                }
                match chosen {
                    Some(a) => s(a, "id").to_owned(),
                    None => required(liability, "sales tax payable")?,
                }
            }
        };
        let note = text(&adj, "note")
            .filter(|n| !n.is_empty())
            .map(|n| format!(": {n}"))
            .unwrap_or_default();
        let on_payable = liability.is_some_and(|l| s(l, "id") == account)
            || use_tax.is_some_and(|u| s(u, "id") == account);
        lines.push(line(
            account,
            round2(amount),
            format!("{} {name} {period}{note}", adjustment_label(kind)),
        ));
        if on_payable {
            liability_debit += amount;
        }
    }

    if difference != 0.0 {
        let rounding = required(
            account_for_role(accounts, "rounding", &["7110"]),
            "rounding",
        )?;
        lines.push(line(
            rounding,
            round2(difference),
            format!(
                "Payment difference {name} {period}: {}",
                difference_reason.unwrap_or("")
            )
            .trim()
            .to_owned(),
        ));
    }
    Ok((lines, round2(liability_debit)))
}

/// `PaymentInput`.
pub(crate) struct PaymentInput<'a> {
    pub entity: &'a Value,
    pub agency: &'a Value,
    pub ret: &'a Value,
    pub bank_account_id: &'a str,
    pub amount: f64,
    pub date: &'a str,
    pub reference: Option<&'a str>,
    pub difference_reason: Option<&'a str>,
    pub user_id: Option<&'a str>,
    pub now: &'a str,
}

/// `PaymentResult`.
pub(crate) struct PaymentResult {
    pub ret: Value,
    pub journal_entry_id: Option<String>,
    pub total_due: f64,
    pub difference: f64,
    pub lines: Vec<Value>,
}

/// What marking a return paid writes.
struct PaidMark<'a> {
    paid_at: &'a str,
    amount: f64,
    bank_id: &'a str,
    journal_entry_id: Option<&'a str>,
    payment: &'a Value,
    total_due: f64,
    now: &'a str,
}

/// The return marked paid, as long as it is still filed: its status, the
/// payment's day, amount (`toFixed(2)`), bank account and journal entry, the
/// summary with the payment, the total due (`toFixed(2)`) and `updated_at`.
fn mark_paid(ret: &Value, mark: &PaidMark<'_>) -> Result<UpdateMany<tax_returns::Entity>, DbErr> {
    use tax_returns::Column;
    let PaidMark {
        paid_at,
        amount,
        bank_id,
        journal_entry_id,
        payment,
        total_due,
        now,
    } = *mark;
    let mut summary = ret["summary"].as_object().cloned().unwrap_or_default();
    let mut payment = payment.clone();
    payment["journalEntryId"] = json!(journal_entry_id);
    summary.insert("payment".into(), payment);
    Ok(tax_returns::Entity::update_many()
        .col_expr(Column::Status, Expr::value("paid"))
        .col_expr(Column::PaidAt, Expr::value(parse_instant(paid_at)?))
        .col_expr(
            Column::PaymentAmount,
            Expr::value(decimal(&to_fixed(amount, 2))?),
        )
        .col_expr(Column::PaymentBankAccountId, Expr::value(bank_id))
        .col_expr(
            Column::PaymentJournalEntryId,
            Expr::value(journal_entry_id.map(str::to_owned)),
        )
        .col_expr(Column::Summary, Expr::value(Value::Object(summary)))
        .col_expr(
            Column::TotalDue,
            Expr::value(decimal(&to_fixed(total_due, 2))?),
        )
        .col_expr(Column::UpdatedAt, Expr::value(parse_instant(now)?))
        .filter(Column::Id.eq(s(ret, "id")))
        .filter(Column::Status.eq("filed")))
}

/// `id, ledger_account_id, name` of the entity's bank account `id`.
async fn bank_account(
    db: &PgPool,
    entity_id: &str,
    id: &str,
) -> Result<Option<(String, Option<String>, String)>, DbErr> {
    use bank_accounts::Column;
    bank_accounts::Entity::find()
        .select_only()
        .columns([Column::Id, Column::LedgerAccountId, Column::Name])
        .filter(Column::Id.eq(id))
        .filter(Column::EntityId.eq(entity_id))
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `recordReturnPayment(db, input)`.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors payment.ts's recordReturnPayment()"
)]
pub(crate) async fn record_return_payment(
    db: &PgPool,
    input: PaymentInput<'_>,
) -> Result<PaymentResult, PaymentFailure> {
    let PaymentInput {
        entity,
        agency,
        ret,
        ..
    } = input;
    match s(ret, "status") {
        "paid" => return Err(conflict("This return has already been paid").into()),
        "filed" => {}
        _ => return Err(bad("File the return before recording its payment").into()),
    }
    let summary = &ret["summary"];
    let adjustments = adjustments_of(ret);
    let total_due = compute_total_due(summary, &adjustments);
    let amount = round2(input.amount);
    if total_due > 0.0 && amount < 0.0 {
        return Err(bad("The amount paid cannot be negative for a return with tax due").into());
    }
    if total_due < 0.0 && amount > 0.0 {
        return Err(bad(
            "A return with a credit is refunded, not paid: enter the refund as a negative amount",
        )
        .into());
    }
    let difference = round2(amount - total_due);
    let reason = input
        .difference_reason
        .map(weldsuite_kit::validation::js_trim)
        .filter(|r| !r.is_empty());
    if difference != 0.0 && reason.is_none() {
        return Err(bad_with(
            format!(
                "The amount paid ({}) differs from the total due ({}). Give a reason for the difference.",
                to_fixed(amount, 2),
                to_fixed(total_due, 2)
            ),
            json!({ "totalDue": n(total_due), "amount": n(amount), "difference": n(difference) }),
        )
        .into());
    }

    let bank = bank_account(db, s(entity, "id"), input.bank_account_id).await?;
    let Some((bank_id, ledger_account_id, bank_name)) = bank else {
        return Err(not_found(format!("Bank account {} not found", input.bank_account_id)).into());
    };
    let Some(ledger_account_id) = ledger_account_id.filter(|l| !l.is_empty()) else {
        return Err(bad(format!(
            "Bank account {bank_name} is not linked to a ledger account"
        ))
        .into());
    };

    let accounts = load_entity_accounts(db, s(entity, "id")).await?;
    let (mut lines, liability_debit) = payment_lines(&accounts, agency, ret, difference, reason)?;
    let period = format!("{} to {}", s(ret, "periodStart"), s(ret, "periodEnd"));
    let name = s(agency, "name");
    if amount != 0.0 {
        lines.push(PostingLine {
            account_id: ledger_account_id,
            credit: amount,
            description: Some(format!(
                "Sales tax payment {name} {period}{}",
                input
                    .reference
                    .filter(|r| !r.is_empty())
                    .map(|r| format!(" ({r})"))
                    .unwrap_or_default()
            )),
            ..PostingLine::default()
        });
    }

    let paid_at = format!("{}T00:00:00.000Z", input.date);
    let payment = json!({
        "date": input.date,
        "amount": n(amount),
        "reference": input.reference,
        "difference": n(difference),
        "differenceReason": reason,
        "liabilityDebit": n(liability_debit),
        "taxSettled": n(round2(
            num(summary.get("salesTaxPayable").unwrap_or(&Value::Null))
                - num(summary.get("uncuredTaxPayable").unwrap_or(&Value::Null))
                + num(summary.get("useTaxPayable").unwrap_or(&Value::Null))
        )),
        "bankAccountId": bank_id,
    });
    let result_lines: Vec<Value> = lines
        .iter()
        .map(|l| {
            json!({
                "accountId": l.account_id,
                "debit": n(round2(l.debit)),
                "credit": n(round2(l.credit)),
                "description": l.description,
            })
        })
        .collect();

    let return_id = s(ret, "id").to_owned();
    let also: weldsuite_books_domain::posting::AlsoWrite = {
        let ret = ret.clone();
        let paid_at = paid_at.clone();
        let bank_id = bank_id.clone();
        let payment = payment.clone();
        let now = input.now.to_owned();
        Box::new(move |conn, posted| {
            let update = mark_paid(
                &ret,
                &PaidMark {
                    paid_at: &paid_at,
                    amount,
                    bank_id: &bank_id,
                    journal_entry_id: Some(&posted.journal_entry_id),
                    payment: &payment,
                    total_due,
                    now: &now,
                },
            );
            Box::pin(async move {
                let conn = OrmConn::new(conn);
                update?
                    .exec(&conn)
                    .await?;
                Ok(())
            })
        })
    };
    let posted = post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: s(entity, "id").to_owned(),
            date: paid_at.clone(),
            description: format!("Sales tax payment {name} {period}"),
            reference: input
                .reference
                .map(str::to_owned)
                .or_else(|| text(ret, "confirmationNumber").map(str::to_owned)),
            source_type: "tax_return".to_owned(),
            source_id: Some(return_id.clone()),
            posting_key: Some(format!("tax_return:{return_id}:payment")),
            lock_kind: Some(PostingLockKind::General),
            lines,
            created_by: input.user_id.map(str::to_owned),
            is_automatic: Some(false),
            also_write: vec![also],
            ..PostJournalEntryInput::default()
        },
    )
    .await
    .map_err(PaymentFailure::Post)?;

    let current = return_by_id(db, &return_id).await?;
    if current.as_ref().is_some_and(|c| s(c, "status") == "filed") {
        mark_paid(
            ret,
            &PaidMark {
                paid_at: &paid_at,
                amount,
                bank_id: &bank_id,
                journal_entry_id: posted.journal_entry_id.as_deref(),
                payment: &payment,
                total_due,
                now: input.now,
            },
        )?
        .exec(&orm(db))
        .await?;
    }
    let updated = return_by_id(db, &return_id).await?.unwrap_or(Value::Null);
    Ok(PaymentResult {
        ret: updated,
        journal_entry_id: posted.journal_entry_id,
        total_due,
        difference,
        lines: result_lines,
    })
}

/// `settledAgainstPayable(ret)`: the tax a paid return settled against the
/// agency's payables.
pub(crate) fn settled_against_payable(ret: &Value) -> f64 {
    if s(ret, "status") != "paid" {
        return 0.0;
    }
    let payment = &ret["summary"]["payment"];
    let value = match payment.get("taxSettled") {
        Some(v) if !v.is_null() => v,
        _ => payment.get("liabilityDebit").unwrap_or(&Value::Null),
    };
    round2(num(value))
}

/// `owedByFiledReturn(ret)`: the tax a filed, unpaid return still holds on
/// the payables.
pub(crate) fn owed_by_filed_return(ret: &Value) -> f64 {
    if s(ret, "status") != "filed" {
        return 0.0;
    }
    let summary = &ret["summary"];
    let get = |key: &str| num(summary.get(key).unwrap_or(&Value::Null));
    sum_money([
        get("salesTaxPayable") - get("uncuredTaxPayable"),
        get("useTaxPayable"),
    ])
}
