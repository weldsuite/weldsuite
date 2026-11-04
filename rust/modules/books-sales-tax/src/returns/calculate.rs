//! Calculating a return (`services/sales-tax-returns/calculate.ts`): the
//! worksheet from the agency's tax-ledger rows, the vendor discount proposal
//! and the total due. Nothing is written here.

use serde_json::{Map, Value, json};
use weldsuite_books_domain::jurisdictions::us;
use weldsuite_books_domain::sales_tax::worksheet::{
    WorksheetOptions, build_us_sales_tax_worksheet,
};
use weldsuite_books_domain::tables::TAX_RETURNS;
use weldsuite_db::PgPool;

use super::common::{
    ADJUSTMENT_TYPES, adjustments_of, compute_total_due, n, num, num_at, reporting_basis_of,
    round2, s, sum_money,
};
use super::rows::{LoadRowsOptions, LoadedRows, load_worksheet_rows};
use crate::common::text;

/// `CASH_BASIS_NOTE`.
pub(crate) const CASH_BASIS_NOTE: &str = "Cash basis: an invoice counts in the period its payments are dated, in proportion to the payments; credit memos and write-offs count when issued, in proportion to the share of the original invoice paid; other rows count on their tax date.";

/// `vendorDiscountFor(rule, taxDue)`: dollars kept for timely filing.
pub(crate) fn vendor_discount_for(rule: Option<&Value>, tax_due: f64) -> f64 {
    let Some(rule) = rule else {
        return 0.0;
    };
    if tax_due <= 0.0 {
        return 0.0;
    }
    let percent = num_at(rule, "percent");
    let mut amount;
    match rule["tiers"].as_array().filter(|t| !t.is_empty()) {
        Some(tiers) => {
            let mut remaining = tax_due;
            let mut floor = 0.0;
            amount = 0.0;
            for tier in tiers {
                let up_to = tier["upTo"].as_f64();
                let band = match up_to {
                    None => remaining,
                    Some(up) => remaining.min((up - floor).max(0.0)),
                };
                amount += (band * num_at(tier, "percent")) / 100.0;
                remaining -= band;
                if let Some(up) = up_to {
                    floor = up;
                }
                if remaining <= 0.0 {
                    break;
                }
            }
        }
        None => amount = (tax_due * percent) / 100.0,
    }
    if let Some(cap) = rule["capPerReturn"].as_f64() {
        amount = amount.min(cap);
    }
    round2(amount)
}

/// `proposeVendorDiscount(...)`: `VendorDiscountProposal` as JSON.
pub(crate) fn propose_vendor_discount(
    state_code: &str,
    sales_tax_due: f64,
    due_date: Option<&str>,
    today: &str,
) -> Value {
    let rule = us::state(Some(state_code))
        .map(|st| &st["vendorDiscount"])
        .filter(|r| r.is_object());
    let Some(rule) = rule else {
        return json!({
            "available": false,
            "amount": 0,
            "requiresTimelyFilingBy": null,
            "late": false,
            "note": null,
        });
    };
    let late = due_date.is_some_and(|d| !d.is_empty() && today > d);
    json!({
        "available": true,
        "amount": n(vendor_discount_for(Some(rule), sales_tax_due)),
        "requiresTimelyFilingBy": due_date,
        "late": late,
        "note": rule.get("note").cloned().unwrap_or(Value::Null),
    })
}

/// `amendmentChain(db, entityId, ret)`: the returns an amendment builds on,
/// oldest first.
pub(crate) async fn amendment_chain(
    db: &PgPool,
    entity_id: &str,
    ret: &Value,
) -> Result<Vec<Value>, sqlx::Error> {
    let mut chain: Vec<Value> = Vec::new();
    let mut cursor = text(ret, "amendsReturnId").map(str::to_owned);
    let mut seen: Vec<String> = vec![s(ret, "id").to_owned()];
    while let Some(id) = cursor.filter(|c| !c.is_empty() && !seen.contains(c)) {
        seen.push(id.clone());
        let row: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(tax_returns),
            " from tax_returns t where t.id = $1 and t.entity_id = $2 limit 1"
        ))
        .bind(&id)
        .bind(entity_id)
        .fetch_optional(db)
        .await?;
        let Some(prev) = row.map(|r| TAX_RETURNS.js(r)) else {
            break;
        };
        cursor = text(&prev, "amendsReturnId").map(str::to_owned);
        chain.insert(0, prev);
    }
    Ok(chain)
}

/// `carriedForwardRowIds(db, entityId, agencyId, periodStart)`.
pub(crate) async fn carried_forward_row_ids(
    db: &PgPool,
    entity_id: &str,
    agency_id: &str,
    period_start: &str,
) -> Result<(Vec<String>, Vec<String>), sqlx::Error> {
    let earlier: Vec<(String, Option<Value>)> = sqlx::query_as(
        "select id, exceptions from tax_returns where entity_id = $1 and agency_id = $2 \
         and deleted_at is null and period_end < $3::date",
    )
    .bind(entity_id)
    .bind(agency_id)
    .bind(period_start)
    .fetch_all(db)
    .await?;
    let mut ids: Vec<String> = Vec::new();
    let mut return_ids: Vec<String> = Vec::new();
    for (id, exceptions) in earlier {
        for item in exceptions
            .as_ref()
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if text(item, "type") == Some("late_entry")
                && text(item, "resolution") == Some("carried_forward")
                && let Some(line) = text(item, "taxLineId")
            {
                ids.push(line.to_owned());
                if !return_ids.contains(&id) {
                    return_ids.push(id.clone());
                }
            }
        }
    }
    Ok((ids, return_ids))
}

/// `Calculation`.
pub(crate) struct Calculation {
    pub rows: LoadedRows,
    /// `ReturnSummary` as stored on the return.
    pub summary: Value,
    pub lines: Vec<Value>,
    pub adjustments: Vec<Value>,
    pub total_due: f64,
}

/// What a calculation needs besides the database.
pub(crate) struct CalculationInput<'a> {
    pub entity: &'a Value,
    pub agency: &'a Value,
    pub ret: &'a Value,
    /// `now.toISOString()`.
    pub now: &'a str,
    /// `todayIn(entity.timezone, now)`.
    pub today: &'a str,
    pub created_not_after: Option<&'a str>,
}

/// `calculateReturn(db, input)`.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors calculate.ts's calculateReturn()"
)]
pub(crate) async fn calculate_return(
    db: &PgPool,
    input: &CalculationInput<'_>,
) -> Result<Calculation, sqlx::Error> {
    let CalculationInput {
        entity,
        agency,
        ret,
        now,
        today,
        ..
    } = *input;
    let entity_id = s(ret, "entityId");
    let basis = reporting_basis_of(agency);
    let chain = amendment_chain(db, entity_id, ret).await?;
    let amends = text(ret, "amendsReturnId").is_some_and(|a| !a.is_empty());
    let (carried_ids, carried_return_ids) = if amends {
        (Vec::new(), Vec::new())
    } else {
        carried_forward_row_ids(db, entity_id, s(agency, "id"), s(ret, "periodStart")).await?
    };
    let mut include = vec![s(ret, "id").to_owned()];
    include.extend(chain.iter().map(|r| s(r, "id").to_owned()));
    let rows = load_worksheet_rows(
        db,
        &LoadRowsOptions {
            entity_id: entity_id.to_owned(),
            agency_id: s(agency, "id").to_owned(),
            period_start: s(ret, "periodStart").to_owned(),
            period_end: s(ret, "periodEnd").to_owned(),
            cash: basis == "cash",
            include_stamped_by: include,
            carried_ids: carried_ids.clone(),
            created_not_after: input.created_not_after.map(str::to_owned),
            created_after: None,
        },
    )
    .await?;
    let worksheet = build_us_sales_tax_worksheet(
        &rows.lines(),
        &WorksheetOptions {
            agency_id: s(agency, "id"),
            state_code: s(agency, "stateCode"),
            period_start: s(ret, "periodStart"),
            period_end: s(ret, "periodEnd"),
            reporting_basis: basis,
            as_of: Some(today),
        },
    );

    let mut warnings: Vec<String> = Vec::new();
    let previous = chain.last();
    let previously = previous.map(|p| {
        let summary = &p["summary"];
        (
            s(p, "id").to_owned(),
            num(summary.get("salesTaxDue").unwrap_or(&Value::Null)),
            num(summary.get("useTaxDue").unwrap_or(&Value::Null)),
            num(summary
                .get("uncuredExempt")
                .and_then(|u| u.get("tax"))
                .unwrap_or(&Value::Null)),
        )
    });
    let uncured = worksheet.uncured_exempt.tax;
    let (prev_sales, prev_use, prev_uncured) = previously
        .as_ref()
        .map_or((0.0, 0.0, 0.0), |(_, a, b, c)| (*a, *b, *c));
    let sales_tax_payable = round2(worksheet.sales_tax_due - prev_sales);
    let use_tax_payable = round2(worksheet.use_tax_due - prev_use);
    let uncured_tax_payable = round2(uncured - prev_uncured);

    if worksheet.uncured_exempt.lines > 0 {
        warnings.push(format!(
            "{} exempt sale line(s) have no certificate after the 90-day cure period and are counted as taxable.",
            worksheet.uncured_exempt.lines
        ));
    }
    if worksheet.total_tax_due < 0.0 {
        warnings.push("The return shows a credit (negative tax due).".to_owned());
    }
    let base_currency = text(entity, "baseCurrency");
    let foreign_rows = rows
        .entries
        .iter()
        .filter(|e| text(&e.row, "currency") != base_currency)
        .count();
    if foreign_rows > 0 {
        warnings.push(format!(
            "{foreign_rows} ledger row(s) are in a foreign currency and are reported at their document amounts."
        ));
    }
    if !rows.carried_ids.is_empty() && !carried_ids.is_empty() {
        warnings.push(format!(
            "{} row(s) carried forward from an earlier, filed period are included.",
            rows.carried_ids.len()
        ));
    }
    let carried_tax = sum_money(
        rows.entries
            .iter()
            .filter(|e| e.carried)
            .map(|e| num_at(&e.row, "taxAmount")),
    );
    let vendor_discount = propose_vendor_discount(
        s(agency, "stateCode"),
        if amends {
            0.0
        } else {
            round2(worksheet.sales_tax_due - uncured)
        },
        text(ret, "dueDate"),
        today,
    );

    let mut summary = Map::new();
    summary.insert("reportingBasis".into(), json!(basis));
    summary.insert(
        "method".into(),
        json!(if basis == "cash" {
            CASH_BASIS_NOTE
        } else {
            "Accrual basis: every row counts on its tax date."
        }),
    );
    summary.insert("grossSales".into(), n(worksheet.gross_sales));
    summary.insert("deductions".into(), worksheet.deductions_json());
    summary.insert("totalDeductions".into(), n(worksheet.total_deductions));
    summary.insert("taxableSales".into(), n(worksheet.taxable_sales));
    summary.insert("salesTaxDue".into(), n(worksheet.sales_tax_due));
    summary.insert("useTaxDue".into(), n(worksheet.use_tax_due));
    summary.insert("totalTaxDue".into(), n(worksheet.total_tax_due));
    summary.insert("documentCount".into(), json!(worksheet.document_count));
    summary.insert("rowCount".into(), json!(rows.entries.len()));
    summary.insert("uncuredExempt".into(), worksheet.uncured_json());
    summary.insert("salesTaxPayable".into(), n(sales_tax_payable));
    summary.insert("useTaxPayable".into(), n(use_tax_payable));
    summary.insert("uncuredTaxPayable".into(), n(uncured_tax_payable));
    summary.insert("vendorDiscount".into(), vendor_discount);
    summary.insert("warnings".into(), json!(warnings));
    summary.insert("calculatedAt".into(), json!(now));
    summary.insert("foreignCurrencyRows".into(), json!(foreign_rows));
    if !rows.carried_ids.is_empty() {
        summary.insert(
            "carriedForward".into(),
            json!({
                "returnIds": carried_return_ids,
                "rowCount": rows.carried_ids.len(),
                "taxAmount": n(carried_tax),
            }),
        );
    }
    if let Some((id, sales, use_tax, uncured_tax)) = &previously {
        summary.insert(
            "previouslyReported".into(),
            json!({
                "returnId": id,
                "salesTaxDue": n(*sales),
                "useTaxDue": n(*use_tax),
                "uncuredTax": n(*uncured_tax),
            }),
        );
    }
    let summary = Value::Object(summary);
    let adjustments = refresh_adjustments(&adjustments_of(ret), &summary, amends);
    let mut lines: Vec<Value> = worksheet
        .by_location
        .iter()
        .map(|l| l.to_json(Some(("kind", "sales"))))
        .collect();
    lines.extend(
        worksheet
            .use_tax_by_location
            .iter()
            .map(|l| l.to_json(Some(("kind", "use")))),
    );
    let total_due = compute_total_due(&summary, &adjustments);
    Ok(Calculation {
        rows,
        summary,
        lines,
        adjustments,
        total_due,
    })
}

/// `refreshAdjustments(existing, summary, amendment)`: keeps the user's
/// adjustments, refreshes an automatic vendor discount, proposes one.
pub(crate) fn refresh_adjustments(
    existing: &[Value],
    summary: &Value,
    amendment: bool,
) -> Vec<Value> {
    let discount = &summary["vendorDiscount"];
    let available = discount["available"].as_bool().unwrap_or(false);
    let amount = num_at(discount, "amount");
    let late = discount["late"].as_bool().unwrap_or(false);
    let note_for = || {
        format!(
            "Proposed vendor discount{}; only valid if filed and paid by {}.",
            text(discount, "note")
                .filter(|n| !n.is_empty())
                .map(|n| format!(" ({n})"))
                .unwrap_or_default(),
            text(discount, "requiresTimelyFilingBy").unwrap_or("the due date")
        )
    };
    let mut next: Vec<Value> = existing.to_vec();
    let index = next
        .iter()
        .position(|a| text(a, "type") == Some("vendor_discount"));
    match index {
        Some(i) if next[i]["auto"].as_bool() == Some(true) => {
            if !available || amount <= 0.0 || late || amendment {
                next.remove(i);
            } else if let Value::Object(entry) = &mut next[i] {
                entry.insert("amount".into(), n(-amount));
                entry.insert("note".into(), json!(note_for()));
            }
        }
        None if !amendment && available && amount > 0.0 && !late => {
            next.push(json!({
                "type": "vendor_discount",
                "amount": n(-amount),
                "note": note_for(),
                "auto": true,
            }));
        }
        _ => {}
    }
    next
}

/// `validAdjustmentType(type)`.
#[allow(
    dead_code,
    reason = "kept with the adjustment types, as calculate.ts exports it"
)]
pub(crate) fn valid_adjustment_type(kind: &str) -> bool {
    ADJUSTMENT_TYPES.contains(&kind)
}

/// `sameWorksheet(a, b)`: is the stored worksheet still what is calculated?
#[allow(clippy::float_cmp, reason = "`===` on rounded money, as TypeScript")]
pub(crate) fn same_worksheet(stored: &Value, calculated: &Value) -> bool {
    if !stored.is_object() {
        return false;
    }
    let a = |key: &str| num(stored.get(key).unwrap_or(&Value::Null));
    let b = |key: &str| num(calculated.get(key).unwrap_or(&Value::Null));
    a("rowCount") == b("rowCount")
        && round2(a("grossSales")) == b("grossSales")
        && round2(a("taxableSales")) == b("taxableSales")
        && round2(a("salesTaxDue")) == b("salesTaxDue")
        && round2(a("useTaxDue")) == b("useTaxDue")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendor_discounts() {
        // Georgia: 3% of the first $3,000 of tax, 0.5% above.
        let ga = propose_vendor_discount("GA", 4000.0, Some("2026-10-20"), "2026-10-08");
        assert_eq!(ga["available"], json!(true));
        assert!((num_at(&ga, "amount") - 95.0).abs() < 1e-9);
        assert_eq!(ga["late"], json!(false));
        let late = propose_vendor_discount("GA", 100.0, Some("2026-10-20"), "2026-10-21");
        assert_eq!(late["late"], json!(true));
        let none = propose_vendor_discount("OR", 100.0, None, "2026-10-08");
        assert_eq!(none["available"], json!(false));
    }

    #[test]
    fn adjustments_refresh() {
        let summary = json!({ "vendorDiscount": {
            "available": true, "amount": 2.5, "late": false,
            "requiresTimelyFilingBy": "2026-10-20", "note": null,
        } });
        let proposed = refresh_adjustments(&[], &summary, false);
        assert_eq!(proposed.len(), 1);
        assert_eq!(proposed[0]["amount"], json!(-2.5));
        assert_eq!(
            proposed[0]["note"],
            json!("Proposed vendor discount; only valid if filed and paid by 2026-10-20.")
        );
        assert_eq!(
            refresh_adjustments(&proposed, &summary, true),
            Vec::<Value>::new()
        );
        let manual = vec![json!({ "type": "vendor_discount", "amount": -1 })];
        assert_eq!(refresh_adjustments(&manual, &summary, false), manual);
        assert!(same_worksheet(
            &json!({ "rowCount": 2, "grossSales": "10.00", "taxableSales": 10, "salesTaxDue": 1, "useTaxDue": 0 }),
            &json!({ "rowCount": 2, "grossSales": 10, "taxableSales": 10, "salesTaxDue": 1, "useTaxDue": 0 }),
        ));
        assert!(!same_worksheet(&Value::Null, &json!({})));
    }
}
