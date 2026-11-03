//! Bad debt (books-api `services/accounting-bad-debt.ts`): writing an
//! invoice off and, when the customer pays after all, taking the write-off
//! back.
//!
//! With bad debt VAT relief (`adapter.badDebtVatRelief`: NL art. 29 Wet OB,
//! UK) a write-off splits the open balance: Dr bad debts (net) + Dr output
//! VAT per rate / Cr receivable, with negative sales tax-ledger rows so the
//! next return deducts the VAT. A recovery reinstates that share of the
//! receivable and of the relief, with positive rows. Without relief the
//! write-off stays gross ([`post_invoice_write_off`]). The split is read back
//! from the tax ledger (`write_off` / `write_off_recovery` rows).

use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};

use crate::document_posting::{
    Meta, TaxArgs, ToBase, amount_of, base_converter, breakdown_to_tax_line, fallback, filled,
    label, load_entity, load_tax_rates, mark_uncollectible, number, owned, post_invoice_write_off,
    require_account, tax_account_for, text, write_off_description, write_off_tax_rows,
};
use crate::guards::PostingLockKind;
use crate::http::now;
use crate::js::{round_money, to_fixed};
use crate::jurisdictions::{adapter, has_adapter, js_trim};
use crate::posting::{
    EntityAccounts, PostError, PostJournalEntryInput, PostedEntry, PostingLine, PostingTaxLine,
    account_for_role, load_entity_accounts, post_journal_entry,
};
use crate::tables::TAX_LINES;

/// Tax-ledger source types of a write-off and of the recoveries that take it back.
const WRITE_OFF_SOURCES: [&str; 2] = ["write_off", "write_off_recovery"];

/// `badDebtVatReliefApplies(entity, invoice)`: writing this invoice off
/// recovers (a share of) its VAT.
pub fn bad_debt_vat_relief_applies(entity: &Value, invoice: &Value) -> bool {
    let code = text(entity, "jurisdictionCode").unwrap_or_default();
    text(invoice, "type") != Some("credit_note")
        && filled(invoice, "taxEngine").is_none()
        && has_adapter(code)
        && adapter(code).is_some_and(|a| a.bad_debt_vat_relief)
}

fn bad_debt_account(accounts: &EntityAccounts) -> Option<&Value> {
    account_for_role(accounts, "bad_debt_expense", &[])
        .or_else(|| account_for_role(accounts, "general_expense", fallback::GENERAL_EXPENSE))
}

fn line(
    meta: &Meta,
    account_id: String,
    description: String,
    debit: f64,
    credit: f64,
) -> PostingLine {
    let mut line = meta.line(account_id, description);
    line.debit = debit;
    line.credit = credit;
    line
}

/// Amounts per account in first-seen order, each sum rounded.
fn add_rounded(totals: &mut Vec<(String, f64)>, account_id: String, amount: f64) {
    match totals.iter_mut().find(|(id, _)| *id == account_id) {
        Some(entry) => entry.1 = round_money(entry.1 + amount),
        None => totals.push((account_id, round_money(0.0 + amount))),
    }
}

/// `writeOffInvoice(db, invoice, opts)`: the open balance to bad debts,
/// the VAT share to output VAT where relief applies. Also the VAT
/// recovered, in base currency.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub async fn write_off_invoice(
    db: &PgPool,
    invoice: &Value,
    user_id: Option<String>,
    date: Option<String>,
) -> Result<(PostedEntry, f64), PostError> {
    let entity_id = text(invoice, "entityId").unwrap_or_default();
    let entity = load_entity(db, entity_id).await?;
    if !bad_debt_vat_relief_applies(&entity, invoice) {
        let posted = post_invoice_write_off(db, invoice, user_id, date).await?;
        return Ok((posted, 0.0));
    }

    let accounts = load_entity_accounts(db, entity_id).await?;
    let to_base = base_converter(
        &entity,
        text(invoice, "currency"),
        invoice.get("exchangeRate").unwrap_or(&Value::Null),
    )?;
    let currency = filled(invoice, "currency")
        .or_else(|| text(&entity, "baseCurrency"))
        .unwrap_or_default()
        .to_owned();
    let meta = Meta {
        currency: Some(currency.clone()),
        exchange_rate: Some(owned(invoice, "exchangeRate").unwrap_or_else(|| "1".to_owned())),
        contact_id: owned(invoice, "contactId"),
    };
    let open = to_base.apply(amount_of(invoice, "balanceDue"));
    let date = date.unwrap_or_else(now);
    let bad_debt = bad_debt_account(&accounts);

    // The open share of every taxed row of the invoice, as negative output tax.
    let (rows, _) = write_off_tax_rows(invoice);
    let taxable: Vec<&Value> = rows
        .iter()
        .filter(|r| {
            text(r, "kind") != Some("use")
                && !crate::js::truthy(r.get("selfAssessed"))
                && number(r, "taxAmount") != 0.0
        })
        .collect();
    let rates = load_tax_rates(db, entity_id, taxable.iter().map(|r| text(r, "taxRateId"))).await?;

    let mut vat_by_account: Vec<(String, f64)> = Vec::new();
    let mut tax_lines = Vec::new();
    let args = TaxArgs {
        purchase: false,
        sign: -1.0,
        currency: &currency,
        to_base,
        contact_id: text(invoice, "contactId"),
    };
    for row in taxable {
        let rate = text(row, "taxRateId").and_then(|id| rates.get(id));
        let account_id = tax_account_for(&accounts, row, rate, false)?;
        add_rounded(
            &mut vat_by_account,
            account_id,
            to_base.apply(number(row, "taxAmount")),
        );
        if filled(row, "taxRateId").is_some() {
            tax_lines.push(breakdown_to_tax_line(row, rate, &args));
        }
    }
    let vat_base = open.min(round_money(
        vat_by_account.iter().fold(0.0, |sum, (_, v)| sum + v),
    ));

    let number_of = text(invoice, "invoiceNumber");
    let mut lines = vec![line(
        &meta,
        require_account(
            bad_debt,
            "No bad-debt or general expense account found for this entity.",
        )?,
        label("Bad debt", number_of),
        round_money(open - vat_base),
        0.0,
    )];
    for (account_id, amount) in vat_by_account {
        let mut vat = line(
            &meta,
            account_id,
            label("VAT bad debt relief", number_of),
            amount,
            0.0,
        );
        vat.tax_amount = Some(-amount);
        lines.push(vat);
    }
    lines.push(line(
        &meta,
        require_account(
            account_for_role(
                &accounts,
                "accounts_receivable",
                fallback::ACCOUNTS_RECEIVABLE,
            ),
            "No accounts receivable account found for this entity.",
        )?,
        label("Write-off", number_of),
        0.0,
        open,
    ));

    let id = text(invoice, "id").unwrap_or_default().to_owned();
    let posted = post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: entity_id.to_owned(),
            date,
            description: write_off_description(invoice),
            source_type: "write_off".to_owned(),
            source_id: Some(id.clone()),
            posting_key: Some(format!("invoice:{id}:write_off")),
            lock_kind: Some(PostingLockKind::Sales),
            lines,
            tax_lines,
            created_by: user_id,
            also_write: vec![mark_uncollectible(id)],
            ..PostJournalEntryInput::default()
        },
    )
    .await?;
    Ok((posted, vat_base))
}

/// `writtenOffBalance(invoice)`: what is still written off, in the document
/// currency (total less what was paid, recoveries included).
pub fn written_off_balance(invoice: &Value) -> f64 {
    if text(invoice, "status") != Some("uncollectible") {
        return 0.0;
    }
    round_money((amount_of(invoice, "total") - amount_of(invoice, "amountPaid")).max(0.0))
}

/// The relief still outstanding at one rate (`ReliefGroup`).
#[derive(Debug, Clone, PartialEq)]
pub struct ReliefGroup {
    pub tax_rate_id: Option<String>,
    pub tax_rate_name: Option<String>,
    pub tax_category_code: Option<String>,
    pub rate: f64,
    pub component: Option<String>,
    pub taxable: f64,
    pub tax: f64,
    pub base_taxable: f64,
    pub base_tax: f64,
}

/// `outstandingRelief(db, invoice)`: write-off rows (negative) net of
/// earlier recoveries, per rate, as positive amounts to give back.
async fn outstanding_relief(db: &PgPool, invoice: &Value) -> Result<Vec<ReliefGroup>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(tax_lines),
        " from tax_lines t where t.entity_id = $1 and t.source_id = $2 and t.source_type = any($3)"
    ))
    .bind(text(invoice, "entityId"))
    .bind(text(invoice, "id"))
    .bind(&WRITE_OFF_SOURCES[..])
    .fetch_all(db)
    .await?;
    let mut groups: Vec<(String, ReliefGroup)> = Vec::new();
    for row in rows {
        let row = TAX_LINES.js(row);
        let key = format!(
            "{}|{}|{}|{}",
            text(&row, "taxRateId").unwrap_or_default(),
            text(&row, "rate").unwrap_or_default(),
            text(&row, "component").unwrap_or_default(),
            text(&row, "taxCategoryCode").unwrap_or_default()
        );
        if !groups.iter().any(|(k, _)| *k == key) {
            groups.push((
                key.clone(),
                ReliefGroup {
                    tax_rate_id: owned(&row, "taxRateId"),
                    tax_rate_name: owned(&row, "taxRateName"),
                    tax_category_code: owned(&row, "taxCategoryCode"),
                    rate: number(&row, "rate"),
                    component: owned(&row, "component"),
                    taxable: 0.0,
                    tax: 0.0,
                    base_taxable: 0.0,
                    base_tax: 0.0,
                },
            ));
        }
        let Some((_, group)) = groups.iter_mut().find(|(k, _)| *k == key) else {
            continue;
        };
        group.taxable += number(&row, "taxableAmount");
        group.tax += number(&row, "taxAmount");
        group.base_taxable += number(&row, "baseTaxableAmount");
        group.base_tax += number(&row, "baseTaxAmount");
    }
    Ok(groups
        .into_iter()
        .map(|(_, g)| ReliefGroup {
            taxable: -g.taxable,
            tax: -g.tax,
            base_taxable: -g.base_taxable,
            base_tax: -g.base_tax,
            ..g
        })
        .filter(|g| g.tax > 0.004 || g.base_tax > 0.004)
        .collect())
}

/// `reliefShare(groups, amount, writtenOff)`: the relief that comes back
/// when `amount` of the written-off balance is recovered.
pub fn relief_share(groups: &[ReliefGroup], amount: f64, written_off: f64) -> Vec<ReliefGroup> {
    let share = if written_off > 0.0 {
        (amount / written_off).min(1.0)
    } else {
        0.0
    };
    groups
        .iter()
        .map(|g| ReliefGroup {
            taxable: round_money(g.taxable * share),
            tax: round_money(g.tax * share),
            base_taxable: round_money(g.base_taxable * share),
            base_tax: round_money(g.base_tax * share),
            ..g.clone()
        })
        .collect()
}

/// `postBadDebtRecovery(db, invoice, opts)`: reinstate `amount` (invoice
/// currency) of a written-off invoice's receivable and take back the same
/// share of the bad debt and of the VAT relief. Idempotent per payment. Also
/// the VAT owed again, in base currency.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub async fn post_bad_debt_recovery(
    db: &PgPool,
    invoice: &Value,
    amount: f64,
    payment_id: &str,
    date: String,
    user_id: Option<String>,
) -> Result<(PostedEntry, f64), PostError> {
    let written_off = written_off_balance(invoice);
    let number_of = text(invoice, "invoiceNumber");
    let id = text(invoice, "id").unwrap_or_default().to_owned();
    if amount > written_off + 0.005 {
        return Err(PostError::Posting(format!(
            "The amount ({}) is more than what was written off on invoice {} ({})",
            to_fixed(amount, 2),
            number_of.unwrap_or(&id),
            to_fixed(written_off, 2)
        )));
    }

    let entity_id = text(invoice, "entityId").unwrap_or_default();
    let entity = load_entity(db, entity_id).await?;
    let accounts = load_entity_accounts(db, entity_id).await?;
    let to_base: ToBase = base_converter(
        &entity,
        text(invoice, "currency"),
        invoice.get("exchangeRate").unwrap_or(&Value::Null),
    )?;
    let currency = filled(invoice, "currency")
        .or_else(|| text(&entity, "baseCurrency"))
        .unwrap_or_default()
        .to_owned();
    let meta = Meta {
        currency: Some(currency.clone()),
        exchange_rate: Some(owned(invoice, "exchangeRate").unwrap_or_else(|| "1".to_owned())),
        contact_id: owned(invoice, "contactId"),
    };
    let amount_base = to_base.apply(amount);

    let relief = relief_share(&outstanding_relief(db, invoice).await?, amount, written_off);
    let rates = load_tax_rates(
        db,
        entity_id,
        relief.iter().map(|g| g.tax_rate_id.as_deref()),
    )
    .await?;

    let mut vat_by_account: Vec<(String, f64)> = Vec::new();
    let mut tax_lines = Vec::new();
    for g in &relief {
        let rate = g
            .tax_rate_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .and_then(|id| rates.get(id));
        let row = json!({
            "taxRateId": g.tax_rate_id.clone().unwrap_or_default(),
            "taxRateName": g.tax_rate_name.clone().unwrap_or_default(),
            "taxRate": g.rate,
            "taxableAmount": g.taxable,
            "taxAmount": g.tax,
        });
        let account_id = tax_account_for(&accounts, &row, rate, false)?;
        add_rounded(&mut vat_by_account, account_id, g.base_tax);
        tax_lines.push(PostingTaxLine {
            direction: "sales".to_owned(),
            tax_rate_id: g.tax_rate_id.clone(),
            tax_rate_name: g.tax_rate_name.clone(),
            tax_category_code: g.tax_category_code.clone(),
            rate: g.rate,
            component: g.component.clone(),
            self_assessed: false,
            taxable_amount: g.taxable,
            tax_amount: g.tax,
            currency: currency.clone(),
            base_taxable_amount: g.base_taxable,
            base_tax_amount: g.base_tax,
            contact_id: owned(invoice, "contactId"),
            ..PostingTaxLine::default()
        });
    }
    let vat_base = amount_base.min(round_money(
        vat_by_account.iter().fold(0.0, |sum, (_, v)| sum + v),
    ));

    let mut lines = vec![
        line(
            &meta,
            require_account(
                account_for_role(
                    &accounts,
                    "accounts_receivable",
                    fallback::ACCOUNTS_RECEIVABLE,
                ),
                "No accounts receivable account found for this entity.",
            )?,
            label("Write-off recovered", number_of),
            amount_base,
            0.0,
        ),
        line(
            &meta,
            require_account(
                bad_debt_account(&accounts),
                "No bad-debt or general expense account found for this entity.",
            )?,
            label("Bad debt recovered", number_of),
            0.0,
            round_money(amount_base - vat_base),
        ),
    ];
    for (account_id, amount) in vat_by_account {
        let mut vat = line(
            &meta,
            account_id,
            label("VAT bad debt relief repaid", number_of),
            0.0,
            amount,
        );
        vat.tax_amount = Some(amount);
        lines.push(vat);
    }

    let posted = post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: entity_id.to_owned(),
            date,
            description: js_trim(&format!(
                "Write-off recovered {} - {}",
                number_of.unwrap_or_default(),
                text(invoice, "contactName").unwrap_or_default()
            ))
            .to_owned(),
            source_type: "write_off_recovery".to_owned(),
            source_id: Some(id.clone()),
            posting_key: Some(recovery_posting_key(&id, payment_id)),
            lock_kind: Some(PostingLockKind::Sales),
            lines,
            tax_lines,
            created_by: user_id,
            ..PostJournalEntryInput::default()
        },
    )
    .await?;
    Ok((posted, vat_base))
}

/// `recoveryPostingKey(invoiceId, paymentId)`.
pub fn recovery_posting_key(invoice_id: &str, payment_id: &str) -> String {
    format!("invoice:{invoice_id}:write_off_recovery:{payment_id}")
}

/// `findRecoveryEntries(db, paymentId, invoiceIds)`: the posted recovery
/// entry a payment made per written-off invoice, as `(invoice, entry)`.
pub async fn find_recovery_entries(
    db: &PgPool,
    payment_id: &str,
    invoice_ids: &[String],
) -> Result<Vec<(String, String)>, sqlx::Error> {
    if invoice_ids.is_empty() {
        return Ok(Vec::new());
    }
    let keys: Vec<String> = invoice_ids
        .iter()
        .map(|id| recovery_posting_key(id, payment_id))
        .collect();
    let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select id, posting_key, status from journal_entries where posting_key = any($1)",
    )
    .bind(&keys)
    .fetch_all(db)
    .await?;
    let mut result: Vec<(String, String)> = Vec::new();
    for (entry_id, posting_key, status) in rows {
        if status.as_deref() != Some("posted") {
            continue;
        }
        let Some(invoice_id) = invoice_ids
            .iter()
            .find(|id| Some(recovery_posting_key(id, payment_id)) == posting_key)
        else {
            continue;
        };
        match result.iter_mut().find(|(id, _)| id == invoice_id) {
            Some(entry) => entry.1 = entry_id,
            None => result.push((invoice_id.clone(), entry_id)),
        }
    }
    Ok(result)
}

/// `writtenOffSettlementSet(delta)` as one `UPDATE`: the open balance stays
/// 0, the invoice is paid once everything written off came back and stays
/// `uncollectible` until then.
pub async fn settle_written_off(
    conn: &mut PgConnection,
    id: &str,
    delta: f64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update invoices set \
         amount_paid = (coalesce(amount_paid, '0')::numeric + $1::numeric), \
         balance_due = 0, \
         status = case when (coalesce(total, '0')::numeric - (coalesce(amount_paid, '0')::numeric + $1::numeric)) <= 0.005 \
           then 'paid' else 'uncollectible' end, \
         paid_at = case when (coalesce(total, '0')::numeric - (coalesce(amount_paid, '0')::numeric + $1::numeric)) <= 0.005 \
           then now() else null end, \
         updated_at = $2::timestamp where id = $3",
    )
    .bind(to_fixed(delta, 2))
    .bind(now())
    .bind(id)
    .execute(conn)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn written_off_balance_only_counts_uncollectible_invoices() {
        let invoice =
            json!({ "status": "uncollectible", "total": "121.00", "amountPaid": "21.00" });
        assert!((written_off_balance(&invoice) - 100.0).abs() < 1e-9);
        let paid = json!({ "status": "paid", "total": "121.00", "amountPaid": "0" });
        assert!(written_off_balance(&paid).abs() < 1e-9);
    }

    #[test]
    fn relief_comes_back_in_proportion() {
        let group = ReliefGroup {
            tax_rate_id: Some("txr_high".to_owned()),
            tax_rate_name: None,
            tax_category_code: None,
            rate: 21.0,
            component: None,
            taxable: 100.0,
            tax: 21.0,
            base_taxable: 100.0,
            base_tax: 21.0,
        };
        let half = relief_share(&[group], 60.5, 121.0);
        assert!((half[0].tax - 10.5).abs() < 1e-9);
        assert!((half[0].taxable - 50.0).abs() < 1e-9);
        assert!(relief_share(&half, 1.0, 0.0)[0].tax.abs() < 1e-9);
    }
}
