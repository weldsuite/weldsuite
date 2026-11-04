//! Creating, calculating, adjusting, reviewing, listing and deleting returns
//! (`services/sales-tax-returns/lifecycle.ts`), the Sales Tax Center's
//! periods and overview (`overview.ts`) and the CSV export (`export.ts`).

use serde_json::{Map, Value, json};
use weldsuite_books_domain::http::Refusal;
use weldsuite_books_domain::js::to_fixed;
use weldsuite_books_domain::sales_tax::dates::add_days as tax_add_days;
use weldsuite_books_domain::sales_tax::dates::iso_day;
use weldsuite_books_domain::sales_tax::worksheet::{
    WorksheetLine, build_us_sales_tax_return, csv_cell, csv_cell_number,
};
use weldsuite_books_domain::sales_tax::{from_cents, to_cents};
use weldsuite_books_domain::tables::TAX_RETURNS;
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use super::calculate::{Calculation, CalculationInput, calculate_return};
use super::common::{
    FILED_STATUSES, add_months, adjustments_of, bad, compute_total_due, conflict, is_editable,
    is_filed, load_agencies, load_agency_returns, n, num, num_at, reporting_basis_of, return_by_id,
    s,
};
use super::filing::release_amended_exceptions;
use super::periods::{PeriodRow, build_period_rows, match_period, next_period_to_open};
use super::rows::load_filed_rows;
use crate::common::text;

/// `createReturn(db, input)`: an open return for a period of the agency's
/// grid (the next one without a return when no dates are given).
pub(crate) async fn create_return(
    db: &PgPool,
    entity: &Value,
    agency: &Value,
    period_start: Option<&str>,
    period_end: Option<&str>,
    now: &str,
    today: &str,
) -> Result<Value, Refusal> {
    if s(agency, "status") == "monitoring" {
        return Err(bad(
            "The agency is only being monitored for nexus; register it before preparing a return",
        ));
    }
    let returns = load_agency_returns(db, s(entity, "id"), s(agency, "id")).await?;
    let period = match (period_start, period_end) {
        (Some(start), Some(end)) => match_period(agency, start, end).ok_or_else(|| {
            bad(format!(
                "{start} to {end} is not a {} period of this agency. Check its filing frequency and first period start.",
                s(agency, "filingFrequency")
            ))
        })?,
        (None, None) => next_period_to_open(agency, &returns, today)?,
        _ => {
            return Err(bad(
                "Give both periodStart and periodEnd, or neither to open the next period",
            ));
        }
    };
    if let Some(clash) = returns.iter().find(|r| {
        text(r, "amendsReturnId").is_none_or(str::is_empty)
            && s(r, "periodStart") <= period.period_end.as_str()
            && s(r, "periodEnd") >= period.period_start.as_str()
    }) {
        return Err(Refusal::conflict_with(
            format!(
                "This period already has a return ({}, {})",
                s(clash, "id"),
                s(clash, "status")
            ),
            json!({ "returnId": clash["id"] }),
        ));
    }
    let id = generate_id("txr");
    let mut values = Map::new();
    for (key, value) in [
        ("id", json!(id)),
        ("entity_id", entity["id"].clone()),
        ("jurisdiction_code", json!("US")),
        ("agency_id", agency["id"].clone()),
        ("state_code", agency["stateCode"].clone()),
        ("period_start", json!(period.period_start)),
        ("period_end", json!(period.period_end)),
        ("due_date", json!(period.due_date)),
        ("status", json!("open")),
        ("reporting_basis", json!(reporting_basis_of(agency))),
        ("adjustments", json!([])),
        ("total_due", json!("0")),
        ("created_at", json!(now)),
        ("updated_at", json!(now)),
    ] {
        values.insert(key.to_owned(), value);
    }
    TAX_RETURNS.insert_raw(db, values).await?;
    Ok(return_by_id(db, &id).await?.unwrap_or(Value::Null))
}

/// `calculateAndStore(db, { entity, agency, ret })`.
pub(crate) async fn calculate_and_store(
    db: &PgPool,
    entity: &Value,
    agency: &Value,
    ret: &Value,
    now: &str,
    today: &str,
) -> Result<Value, Refusal> {
    if !is_editable(ret) {
        return Err(conflict(format!(
            "A {} return cannot be recalculated; amend it instead",
            s(ret, "status")
        )));
    }
    let calc = calculate_return(
        db,
        &CalculationInput {
            entity,
            agency,
            ret,
            now,
            today,
            created_not_after: None,
        },
    )
    .await?;
    sqlx::query(
        "update tax_returns set status = 'calculated', summary = $3, lines = $4, adjustments = $5, \
         total_due = $6::numeric, updated_at = $7::timestamp where id = $1 and status = $2",
    )
    .bind(s(ret, "id"))
    .bind(s(ret, "status"))
    .bind(&calc.summary)
    .bind(Value::Array(calc.lines))
    .bind(Value::Array(calc.adjustments))
    .bind(to_fixed(calc.total_due, 2))
    .bind(now)
    .execute(db)
    .await?;
    let updated = return_by_id(db, s(ret, "id")).await?;
    updated
        .filter(|u| s(u, "status") == "calculated")
        .ok_or_else(|| conflict("This return was changed meanwhile; reload it and try again"))
}

/// `patchReturn(db, ret, patch)`: adjustments (before filing) and notes.
pub(crate) async fn patch_return(
    db: &PgPool,
    ret: &Value,
    adjustments: Option<&Vec<Value>>,
    notes: Option<&Value>,
    now: &str,
) -> Result<Value, Refusal> {
    let mut set = Map::new();
    set.insert("updated_at".into(), json!(now));
    if let Some(adjustments) = adjustments {
        if !is_editable(ret) {
            return Err(conflict(
                "A filed return cannot be adjusted; amend it instead",
            ));
        }
        set.insert("adjustments".into(), Value::Array(adjustments.clone()));
        set.insert(
            "total_due".into(),
            json!(to_fixed(compute_total_due(&ret["summary"], adjustments), 2)),
        );
        if s(ret, "status") == "reviewed" {
            set.insert("status".into(), json!("calculated"));
        }
    }
    if let Some(notes) = notes {
        set.insert("notes".into(), notes.clone());
    }
    Ok(TAX_RETURNS
        .patch_raw(db, s(ret, "id"), set, false)
        .await?
        .unwrap_or(Value::Null))
}

/// `reviewReturn(db, ret)`.
pub(crate) async fn review_return(db: &PgPool, ret: &Value, now: &str) -> Result<Value, Refusal> {
    match s(ret, "status") {
        "reviewed" => return Ok(ret.clone()),
        "calculated" => {}
        "open" => return Err(bad("Calculate the return before reviewing it")),
        other => return Err(bad(format!("A {other} return cannot be reviewed"))),
    }
    sqlx::query(
        "update tax_returns set status = 'reviewed', updated_at = $2::timestamp \
         where id = $1 and status = 'calculated'",
    )
    .bind(s(ret, "id"))
    .bind(now)
    .execute(db)
    .await?;
    Ok(return_by_id(db, s(ret, "id")).await?.unwrap_or(Value::Null))
}

/// `deleteReturn(db, ret)`: soft-deletes a return that is not filed.
pub(crate) async fn delete_return(db: &PgPool, ret: &Value, now: &str) -> Result<(), Refusal> {
    if !is_editable(ret) {
        return Err(conflict(
            "Only an open, calculated or reviewed return can be deleted",
        ));
    }
    sqlx::query(
        "update tax_returns set deleted_at = $2::timestamp, updated_at = $2::timestamp \
         where id = $1 and deleted_at is null",
    )
    .bind(s(ret, "id"))
    .bind(now)
    .execute(db)
    .await?;
    release_amended_exceptions(db, ret, now).await?;
    Ok(())
}

fn encode_cursor(row: &Value) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!(
        "{}|{}",
        s(row, "periodEnd"),
        s(row, "id")
    ))
}

fn decode_cursor(cursor: &str) -> Option<(String, String)> {
    use base64::Engine as _;
    // `atob` of the url-safe form: padding is optional.
    let standard = cursor.replace('-', "+").replace('_', "/");
    let trimmed = standard.trim_end_matches('=');
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(trimmed)
        .ok()?;
    // `atob` yields Latin-1 characters, one per byte.
    let text: String = bytes.iter().map(|b| char::from(*b)).collect();
    let mut parts = text.split('|');
    let period_end = parts.next()?.to_owned();
    let id = parts.next()?.to_owned();
    (!period_end.is_empty() && !id.is_empty() && crate::common::is_iso_date_text(&period_end))
        .then_some((period_end, id))
}

/// `ListFilter`.
pub(crate) struct ListFilter<'a> {
    pub agency_id: Option<&'a str>,
    pub status: Option<&'a str>,
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
    pub limit: i64,
    pub cursor: Option<&'a str>,
}

/// `listReturns(db, entityId, filter)`: newest period first, with a keyset
/// cursor over (period end, id).
pub(crate) async fn list_returns(
    db: &PgPool,
    entity_id: &str,
    filter: &ListFilter<'_>,
) -> Result<(Vec<Value>, i64, bool, Option<String>), Refusal> {
    let after = filter.cursor.and_then(decode_cursor);
    if filter.cursor.is_some() && after.is_none() {
        return Err(bad("Invalid cursor"));
    }
    macro_rules! base {
        () => {
            " from tax_returns t where t.entity_id = $1 and t.deleted_at is null              and ($2::text is null or t.agency_id = $2) and ($3::text is null or t.status = $3)              and ($4::date is null or t.period_end >= $4::date)              and ($5::date is null or t.period_start <= $5::date)"
        };
    }
    let (after_end, after_id) = after.unzip();
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(tax_returns),
        base!(),
        " and ($6::date is null or t.period_end < $6::date or (t.period_end = $6::date and t.id < $7))          order by t.period_end desc, t.id desc limit $8"
    ))
    .bind(entity_id)
    .bind(filter.agency_id)
    .bind(filter.status)
    .bind(filter.from)
    .bind(filter.to)
    .bind(&after_end)
    .bind(&after_id)
    .bind(filter.limit + 1)
    .fetch_all(db)
    .await?;
    let count: i64 = sqlx::query_scalar(concat!("select count(*)::bigint", base!()))
        .bind(entity_id)
        .bind(filter.agency_id)
        .bind(filter.status)
        .bind(filter.from)
        .bind(filter.to)
        .fetch_one(db)
        .await?;
    let mut rows = TAX_RETURNS.js_rows(rows);
    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > filter.limit;
    if has_more {
        rows.truncate(usize::try_from(filter.limit).unwrap_or(0));
    }
    let cursor = if has_more {
        rows.last().map(encode_cursor)
    } else {
        None
    };
    Ok((rows, count, has_more, cursor))
}

// ── Periods and the overview (`overview.ts`) ────────────────────────────────

/// `listPeriods(db, entity, query)`.
pub(crate) async fn list_periods(
    db: &PgPool,
    entity: &Value,
    agency_id: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
    today: &str,
) -> Result<Value, sqlx::Error> {
    let from = from.map_or_else(|| add_months(today, -12), str::to_owned);
    let to = to.map_or_else(|| add_months(today, 3), str::to_owned);
    let agencies: Vec<Value> = load_agencies(db, s(entity, "id"))
        .await?
        .into_iter()
        .filter(|a| {
            agency_id.is_none_or(|id| id.is_empty() || s(a, "id") == id)
                && s(a, "status") != "monitoring"
        })
        .collect();
    let mut out: Vec<Value> = Vec::new();
    for agency in &agencies {
        let returns = load_agency_returns(db, s(entity, "id"), s(agency, "id")).await?;
        let periods: Vec<Value> = build_period_rows(agency, &returns, &from, &to, today)
            .iter()
            .map(PeriodRow::to_json)
            .collect();
        out.push(json!({
            "agencyId": agency["id"],
            "agencyName": agency["name"],
            "stateCode": agency["stateCode"],
            "status": agency["status"],
            "filingFrequency": agency["filingFrequency"],
            "dueDay": agency["dueDay"],
            "reportingBasis": agency["reportingBasis"],
            "periods": periods,
        }));
    }
    Ok(json!({ "today": today, "from": from, "to": to, "agencies": out }))
}

/// A return that does not exist yet, for an estimate.
fn estimate_return(entity: &Value, agency: &Value, period: &PeriodRow, now: &str) -> Value {
    json!({
        "id": "estimate",
        "createdAt": now,
        "updatedAt": now,
        "deletedAt": null,
        "entityId": entity["id"],
        "jurisdictionCode": "US",
        "agencyId": agency["id"],
        "stateCode": agency["stateCode"],
        "periodStart": period.period.period_start,
        "periodEnd": period.period.period_end,
        "dueDate": period.period.due_date,
        "status": "open",
        "reportingBasis": reporting_basis_of(agency),
        "summary": null,
        "lines": null,
        "adjustments": null,
        "exceptions": null,
        "totalDue": "0",
        "filedAt": null,
        "filedBy": null,
        "confirmationNumber": null,
        "paidAt": null,
        "paymentAmount": null,
        "paymentBankAccountId": null,
        "paymentJournalEntryId": null,
        "amendsReturnId": null,
        "notes": null,
    })
}

/// `salesTaxOverview(db, entity)`.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors overview.ts's salesTaxOverview()"
)]
pub(crate) async fn sales_tax_overview(
    db: &PgPool,
    entity: &Value,
    now: &str,
    today: &str,
) -> Result<Value, sqlx::Error> {
    let agencies: Vec<Value> = load_agencies(db, s(entity, "id"))
        .await?
        .into_iter()
        .filter(|a| matches!(s(a, "status"), "registered" | "pending"))
        .collect();
    let mut rows: Vec<Value> = Vec::new();
    let mut estimated_total = 0.0;
    let mut overdue_total = 0;
    let mut due_soon = 0;
    for agency in &agencies {
        let returns = load_agency_returns(db, s(entity, "id"), s(agency, "id")).await?;
        let start = text(agency, "firstPeriodStart").or_else(|| text(agency, "registeredFrom"));
        let periods = match start.filter(|s| !s.is_empty()) {
            Some(start) => {
                build_period_rows(agency, &returns, start, &add_months(today, 13), today)
            }
            None => Vec::new(),
        };
        let open: Vec<&PeriodRow> = periods
            .iter()
            .filter(|p| {
                p.return_status()
                    .is_none_or(|st| !FILED_STATUSES.contains(&st))
            })
            .collect();
        let next = open
            .iter()
            .find(|p| p.period.period_start.as_str() <= today)
            .or_else(|| open.first())
            .copied();
        let mut next_period = Value::Null;
        if let Some(next) = next {
            let existing = next
                .own
                .as_ref()
                .and_then(|own| returns.iter().find(|r| s(r, "id") == s(own, "id")));
            let estimate = existing
                .cloned()
                .unwrap_or_else(|| estimate_return(entity, agency, next, now));
            let calc: Calculation = calculate_return(
                db,
                &CalculationInput {
                    entity,
                    agency,
                    ret: &estimate,
                    now,
                    today,
                    created_not_after: None,
                },
            )
            .await?;
            let estimated = num_at(&calc.summary, "totalTaxDue");
            estimated_total += estimated;
            let return_status = next.return_status().map(str::to_owned);
            if !return_status
                .as_deref()
                .is_some_and(|st| st.contains("filed") || st.contains("paid"))
                && next.days_until_due >= 0
                && next.days_until_due <= 14
            {
                due_soon += 1;
            }
            next_period = json!({
                "periodStart": next.period.period_start,
                "periodEnd": next.period.period_end,
                "dueDate": next.period.due_date,
                "daysUntilDue": next.days_until_due,
                "overdue": next.overdue,
                "state": next.state,
                "returnId": next.own.as_ref().map_or(Value::Null, |r| r["id"].clone()),
                "returnStatus": return_status,
                "estimatedTaxDue": calc.summary["totalTaxDue"],
                "estimatedSalesTax": calc.summary["salesTaxDue"],
                "estimatedUseTax": calc.summary["useTaxDue"],
            });
        }
        let mut filed: Vec<&Value> = returns
            .iter()
            .filter(|r| text(r, "amendsReturnId").is_none_or(str::is_empty) && is_filed(r))
            .collect();
        filed.sort_by(|a, b| s(b, "periodEnd").cmp(s(a, "periodEnd")));
        let last_filed = filed.first().map_or(Value::Null, |f| {
            json!({
                "returnId": f["id"],
                "periodEnd": f["periodEnd"],
                "filedAt": f["filedAt"],
                "totalDue": n(num_at(f, "totalDue")),
                "status": f["status"],
            })
        });
        let overdue = periods.iter().filter(|p| p.overdue).count();
        overdue_total += overdue;
        rows.push(json!({
            "agencyId": agency["id"],
            "agencyName": agency["name"],
            "stateCode": agency["stateCode"],
            "filingFrequency": agency["filingFrequency"],
            "reportingBasis": agency["reportingBasis"],
            "nextPeriod": next_period,
            "overduePeriods": overdue,
            "lastFiled": last_filed,
        }));
    }
    let estimated = weldsuite_books_domain::js::math_round(estimated_total * 100.0) / 100.0;
    Ok(json!({
        "today": today,
        "agencies": rows,
        "totals": {
            "estimatedTaxDue": n(estimated),
            "overduePeriods": overdue_total,
            "dueWithin14Days": due_soon,
        },
    }))
}

// ── Export (`export.ts`) ────────────────────────────────────────────────────

fn adjustment_label(kind: &str) -> &str {
    match kind {
        "vendor_discount" => "Vendor discount",
        "prepayment" => "Prepayment credit",
        "penalty" => "Penalty",
        "interest" => "Interest",
        "rounding" => "Rounding",
        "other" => "Other",
        other => other,
    }
}

/// `applyCureRule(lines, asOf)`: exempt sales with no certificate past the
/// 90-day cure period as taxable rows, so the artifact matches the return.
pub(crate) fn apply_cure_rule(lines: Vec<WorksheetLine>, as_of: &str) -> Vec<WorksheetLine> {
    lines
        .into_iter()
        .map(|line| {
            let exempt = line.exempt_amount.unwrap_or(0.0);
            if line.kind == "use"
                || exempt <= 0.0
                || line
                    .certificate_id
                    .as_deref()
                    .is_some_and(|c| !c.is_empty())
                || line.marketplace_facilitated
                || line.tax_date.is_empty()
            {
                return line;
            }
            if tax_add_days(&iso_day(&line.tax_date), 90).is_none_or(|cure| cure.as_str() >= as_of)
            {
                return line;
            }
            let extra_tax = from_cents(to_cents(exempt * (line.rate / 100.0)));
            WorksheetLine {
                taxable_amount: from_cents(to_cents(line.taxable_amount) + to_cents(exempt)),
                tax_amount: from_cents(to_cents(line.tax_amount) + to_cents(extra_tax)),
                exempt_amount: Some(0.0),
                exempt_reason: None,
                ..line
            }
        })
        .collect()
}

/// `exportReturn(db, { entity, agency, ret })`: the artifact as JSON
/// (`filename`, `mimeType`, `content`, `summary`).
pub(crate) async fn export_return(
    db: &PgPool,
    entity: &Value,
    agency: &Value,
    ret: &Value,
    now: &str,
    today: &str,
) -> Result<Value, sqlx::Error> {
    let adjustments = adjustments_of(ret);
    let mut total_due = num_at(ret, "totalDue");
    let summary: Value;
    let lines = if FILED_STATUSES.contains(&s(ret, "status")) {
        summary = ret["summary"].clone();
        let rows = load_filed_rows(db, s(entity, "id"), agency, ret).await?;
        let filed_at = text(ret, "filedAt").unwrap_or(now);
        apply_cure_rule(rows.lines(), filed_at.get(..10).unwrap_or(filed_at))
    } else {
        let calc = calculate_return(
            db,
            &CalculationInput {
                entity,
                agency,
                ret,
                now,
                today,
                created_not_after: None,
            },
        )
        .await?;
        total_due = compute_total_due(&calc.summary, &adjustments);
        summary = calc.summary.clone();
        apply_cure_rule(calc.rows.lines(), today)
    };
    let artifact = build_us_sales_tax_return(
        s(entity, "name"),
        reporting_basis_of(agency),
        s(ret, "periodStart"),
        s(ret, "periodEnd"),
        &lines,
    );
    let mut extra: Vec<String> = vec![String::new()];
    let uncured = &summary["uncuredExempt"];
    if uncured.is_object() && num_at(uncured, "lines") > 0.0 {
        extra.push(
            [
                csv_cell("Includes exempt sales without a certificate after the 90-day cure period, counted as taxable"),
                csv_cell_number(num_at(uncured, "sales")),
            ]
            .join(","),
        );
        extra.push(
            [
                csv_cell("Tax on those sales"),
                csv_cell_number(num_at(uncured, "tax")),
            ]
            .join(","),
        );
    }
    extra.push(csv_cell("Adjustments"));
    if adjustments.is_empty() {
        extra.push([csv_cell("None"), csv_cell_number(0.0)].join(","));
    }
    for adj in &adjustments {
        extra.push(
            [
                csv_cell(adjustment_label(s(adj, "type"))),
                csv_cell_number(num(adj.get("amount").unwrap_or(&Value::Null))),
                csv_cell(s(adj, "note")),
            ]
            .join(","),
        );
    }
    let previously = &summary["previouslyReported"];
    if previously.is_object() {
        extra.push(
            [
                csv_cell("Reported on the return this one amends"),
                csv_cell_number(
                    -(num_at(previously, "salesTaxDue") + num_at(previously, "useTaxDue")),
                ),
            ]
            .join(","),
        );
    }
    extra.push([csv_cell("Total due"), csv_cell_number(total_due)].join(","));
    let mut out = artifact.to_json();
    out["content"] = json!(format!("{}\n{}", artifact.content, extra.join("\n")));
    Ok(out)
}

/// The cure deadline of a sale (`addDays(isoDay(taxDate), 90)`), for tests.
#[allow(dead_code, reason = "used by the unit tests")]
pub(crate) fn cure_of(tax_date: &str) -> Option<String> {
    tax_add_days(&iso_day(tax_date), 90)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursors_round_trip() {
        let row = json!({ "periodEnd": "2026-09-30", "id": "txr_1" });
        let cursor = encode_cursor(&row);
        assert_eq!(
            decode_cursor(&cursor),
            Some(("2026-09-30".to_owned(), "txr_1".to_owned()))
        );
        assert_eq!(decode_cursor("nope"), None);
    }

    #[test]
    fn cure_rule() {
        let line = WorksheetLine {
            kind: "sales".into(),
            exempt_amount: Some(100.0),
            rate: 6.25,
            tax_date: "2026-07-05".into(),
            ..WorksheetLine::default()
        };
        let cured = apply_cure_rule(vec![line], "2026-10-08");
        assert!((cured[0].taxable_amount - 100.0).abs() < 1e-9);
        assert!((cured[0].tax_amount - 6.25).abs() < 1e-9);
        assert_eq!(cure_of("2026-07-05").as_deref(), Some("2026-10-03"));
    }
}
