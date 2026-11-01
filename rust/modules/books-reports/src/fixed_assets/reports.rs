//! Fixed asset reports (`services/fixed-assets/reports.ts`): the register,
//! the mid-quarter test, a Form 4562-style tax depreciation summary and the
//! de minimis safe harbor check, computed from the stored assets and books.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::dates::{diff_days, parse_iso};
use weldsuite_books_domain::depreciation::{
    DepreciationRow, FiscalPeriod, MidQuarterTestAsset, de_minimis_applies, de_minimis_threshold,
    en_us, mid_quarter_test, section_179_allowance,
};
use weldsuite_books_domain::fiscal_year::{FiscalYearConfig, fiscal_year_for};
use weldsuite_books_domain::js::{locale_compare, number_value};
use weldsuite_books_domain::reports_basis::periods::fiscal_config_of;

use super::assets::{load_entity, load_entity_book_rows};
use super::schedules::{
    AssetWithBook, ScheduleContext, annual_schedule, business_use, ledger_rows,
    macrs_convention_map, mid_quarter_basis_of,
};
use super::shared::{
    Fail, as_number, bad, effective_convention, fiscal_year_label, from_cents, is_macrs_book,
    is_real_property_book, num, opt, text, to_cents,
};

/// `looksLikeListedProperty(asset, book)`.
fn looks_like_listed_property(asset: &Value, book: &Value) -> bool {
    text(book, "method") == "macrs_ads" && business_use(asset) <= 50.0
}

// ---------------------------------------------------------------------------
// De minimis

/// `deMinimisCheck({ amount, hasAfs, date })`.
pub(crate) fn de_minimis_check(amount: f64, has_afs: bool, date: &str) -> Value {
    let threshold = de_minimis_threshold(date, has_afs);
    let applies = de_minimis_applies(amount, date, has_afs);
    let dollars = |value: f64| format!("${}", en_us(value));
    let explanation = if applies {
        format!(
            "At {} the item is within the {} per invoice or item safe harbor{}, so it can be expensed instead of capitalized. The election is made for the whole year with a statement on the tax return and covers every qualifying purchase; with an applicable financial statement the books must expense it too.",
            dollars(amount),
            dollars(threshold.unwrap_or(0.0)),
            if has_afs {
                " (business with an applicable financial statement)"
            } else {
                ""
            }
        )
    } else if let Some(threshold) = threshold {
        format!(
            "At {} the item is over the {} per invoice or item safe harbor{}, so capitalize it and depreciate it. Section 179 or bonus depreciation can still bring the deduction into the first year.",
            dollars(amount),
            dollars(threshold),
            if has_afs {
                ""
            } else {
                " (without an applicable financial statement)"
            }
        )
    } else {
        "The de minimis safe harbor does not cover this date; capitalize the item and depreciate it."
            .to_owned()
    };
    json!({
        "amount": number_value(amount),
        "date": date,
        "hasAfs": has_afs,
        "threshold": threshold.map(number_value),
        "applies": applies,
        "advice": if applies { "expense" } else { "capitalize" },
        "explanation": explanation,
    })
}

// ---------------------------------------------------------------------------
// Mid-quarter test

#[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
fn quarter_of(config: &FiscalYearConfig, period: &FiscalPeriod, date: &str) -> i64 {
    let month = if matches!(config, FiscalYearConfig::Month { .. }) {
        match (parse_iso(&period.start), parse_iso(date)) {
            (Some(start), Some(day)) => day.y * 12 + day.m - (start.y * 12 + start.m),
            _ => 0,
        }
    } else {
        let total = diff_days(&period.start, &period.end).unwrap_or(0) + 1;
        let offset = diff_days(&period.start, date).unwrap_or(0);
        ((offset as f64 / total as f64) * 12.0).floor().min(11.0) as i64
    };
    month.div_euclid(3) + 1
}

fn disposed_in(asset: &Value, start: &str, end: &str) -> bool {
    opt(asset, "disposalDate").is_some_and(|d| !d.is_empty() && d >= start && d <= end)
}

/// `midQuarterReport(config, rows, taxYear)`.
pub(crate) fn mid_quarter_report(
    config: &FiscalYearConfig,
    rows: &[AssetWithBook],
    tax_year: i64,
) -> Value {
    let Some(year) = fiscal_year_for(config, tax_year) else {
        return Value::Null;
    };
    let period = FiscalPeriod {
        label: fiscal_year_label(config, year.year),
        start: year.start.clone(),
        end: year.end.clone(),
    };
    let conventions = macrs_convention_map(config, rows);
    let federal: Vec<&AssetWithBook> = rows
        .iter()
        .filter(|(asset, book)| {
            let pis = text(asset, "placedInServiceDate");
            text(book, "book") == "federal"
                && is_macrs_book(book)
                && pis >= year.start.as_str()
                && pis <= year.end.as_str()
        })
        .collect();

    let lines: Vec<Value> = federal
        .iter()
        .map(|(asset, book)| {
            let real_property = is_real_property_book(book);
            let same_year = disposed_in(asset, &year.start, &year.end);
            json!({
                "assetId": asset["id"],
                "assetNumber": asset["assetNumber"],
                "name": asset["name"],
                "placedInServiceDate": asset["placedInServiceDate"],
                "quarter": quarter_of(config, &period, text(asset, "placedInServiceDate")),
                "basis": number_value(mid_quarter_basis_of(asset, book)),
                "counted": !real_property && !same_year,
                "excludedReason": if real_property {
                    json!("real_property")
                } else if same_year {
                    json!("disposed_in_same_year")
                } else {
                    Value::Null
                },
                "convention": effective_convention(book, text(asset, "id"), &conventions),
            })
        })
        .collect();

    let tested: Vec<MidQuarterTestAsset> = federal
        .iter()
        .map(|(asset, book)| MidQuarterTestAsset {
            id: text(asset, "id").to_owned(),
            placed_in_service_date: text(asset, "placedInServiceDate").to_owned(),
            basis: mid_quarter_basis_of(asset, book),
            real_property: is_real_property_book(book),
            disposed_in_same_year: disposed_in(asset, &year.start, &year.end),
        })
        .collect();
    let result = mid_quarter_test(&tested, &period);
    json!({
        "applies": result.applies,
        "totalBasis": number_value(result.total_basis),
        "lastQuarterBasis": number_value(result.last_quarter_basis),
        "lastQuarterShare": number_value(result.last_quarter_share),
        "quarterBasis": result.quarter_basis.iter().map(|b| number_value(*b)).collect::<Vec<_>>(),
        "taxYear": tax_year,
        "start": year.start,
        "end": year.end,
        "threshold": 0.4,
        "assets": lines,
    })
}

/// `midQuarterTestFor(db, entityId, taxYear)`.
pub(crate) async fn mid_quarter_test_for(
    db: &PgPool,
    entity_id: &str,
    tax_year: i64,
) -> Result<Value, Fail> {
    let entity = load_entity(db, entity_id).await?;
    let rows = load_entity_book_rows(db, entity_id).await?;
    Ok(mid_quarter_report(
        &fiscal_config_of(&entity),
        &rows,
        tax_year,
    ))
}

// ---------------------------------------------------------------------------
// Register

/// `fixedAssetRegister(db, args)`.
#[allow(clippy::too_many_lines)] // the lines, the totals, as TypeScript
pub(crate) async fn fixed_asset_register(
    db: &PgPool,
    entity_id: &str,
    as_of: &str,
    book_kind: &str,
    state_code: Option<&str>,
    include_disposed: bool,
) -> Result<Value, Fail> {
    let entity = load_entity(db, entity_id).await?;
    let config = fiscal_config_of(&entity);
    let rows = load_entity_book_rows(db, entity_id).await?;
    let context = ScheduleContext {
        conventions: macrs_convention_map(&config, &rows),
        config,
    };
    let state = if book_kind == "state" {
        state_code.unwrap_or_default().to_uppercase()
    } else {
        String::new()
    };
    let mut wanted: Vec<&AssetWithBook> = rows
        .iter()
        .filter(|(asset, book)| {
            text(book, "book") == book_kind
                && opt(book, "stateCode").unwrap_or_default() == state
                && text(asset, "placedInServiceDate") <= as_of
        })
        .collect();

    let mut posted: HashMap<String, i64> = HashMap::new();
    let ledger_ids: Vec<String> = wanted
        .iter()
        .filter(|(_, book)| book["postsToLedger"] == json!(true))
        .map(|(asset, _)| text(asset, "id").to_owned())
        .collect();
    if !ledger_ids.is_empty() {
        let sums: Vec<(String, String)> = sqlx::query_as(
            "select asset_id, coalesce(sum(amount), 0)::text from fixed_asset_depreciation \
             where asset_id = any($1) and journal_entry_id is not null and period_end <= $2::date \
             group by asset_id",
        )
        .bind(&ledger_ids)
        .bind(as_of)
        .fetch_all(db)
        .await?;
        for (id, total) in sums {
            posted.insert(id, to_cents(as_number(Some(&json!(total)), 0.0)));
        }
    }

    let label = |asset: &Value| {
        opt(asset, "assetNumber")
            .unwrap_or_else(|| text(asset, "name"))
            .to_owned()
    };
    wanted.sort_by(|(a, _), (b, _)| locale_compare(&label(a), &label(b)));

    let mut lines = Vec::new();
    let (mut total_cost, mut total_accumulated, mut total_posted) = (0_i64, 0_i64, 0_i64);
    let mut any_ledger = false;
    for (asset, book) in wanted {
        let disposed = opt(asset, "disposalDate").is_some_and(|d| !d.is_empty() && d <= as_of);
        if disposed && !include_disposed {
            continue;
        }
        let ledger = book["postsToLedger"] == json!(true);
        let mut accumulated = 0;
        if ledger {
            for row in ledger_rows(asset, book, &context.config, None).rows {
                if row.period_end.as_str() <= as_of {
                    accumulated = to_cents(row.accumulated);
                }
            }
        } else {
            let mut last: Option<DepreciationRow> = None;
            for row in annual_schedule(asset, book, &context).rows {
                if row.period_end.as_str() <= as_of {
                    last = Some(row);
                }
            }
            accumulated = last.map_or(0, |row| to_cents(row.accumulated));
        }
        let cost = to_cents(num(asset, "cost"));
        let asset_id = text(asset, "id");
        let mut line = json!({
            "assetId": asset_id,
            "assetNumber": asset["assetNumber"],
            "name": asset["name"],
            "assetClass": asset["assetClass"],
            "status": asset["status"],
            "placedInServiceDate": asset["placedInServiceDate"],
            "disposalDate": asset["disposalDate"],
            "disposed": disposed,
            "cost": number_value(from_cents(cost)),
            "method": book["method"],
            "convention": effective_convention(book, asset_id, &context.conventions),
            "recoveryYears": number_value(num(book, "recoveryYears")),
            "accumulatedDepreciation": number_value(from_cents(accumulated)),
            "netBookValue": number_value(from_cents(cost - accumulated)),
        });
        let posted_cents = posted.get(asset_id).copied().unwrap_or(0);
        if ledger {
            any_ledger = true;
            line["accumulatedPosted"] = number_value(from_cents(posted_cents));
        }
        lines.push(line);
        if !disposed {
            total_cost += cost;
            total_accumulated += accumulated;
            total_posted += posted_cents;
        }
    }

    let mut totals = Map::new();
    totals.insert("cost".to_owned(), number_value(from_cents(total_cost)));
    totals.insert(
        "accumulatedDepreciation".to_owned(),
        number_value(from_cents(total_accumulated)),
    );
    totals.insert(
        "netBookValue".to_owned(),
        number_value(from_cents(total_cost - total_accumulated)),
    );
    if any_ledger {
        totals.insert(
            "accumulatedPosted".to_owned(),
            number_value(from_cents(total_posted)),
        );
    }
    Ok(json!({
        "asOf": as_of,
        "book": book_kind,
        "stateCode": (!state.is_empty()).then_some(state),
        "accumulatedThrough": if book_kind == "book" { "month_end" } else { "fiscal_year_end" },
        "lines": lines,
        "totals": totals,
    }))
}

// ---------------------------------------------------------------------------
// Tax depreciation (Form 4562 style)

struct TaxLine {
    json: Value,
    placed_this_year: bool,
    method: String,
    recovery_years: f64,
    convention: String,
    cost: f64,
    business_use_percent: f64,
    depreciable_basis: f64,
    section179: f64,
    bonus: f64,
    macrs: f64,
    total: f64,
    listed_property: bool,
    placed_in_service_date: String,
    name: String,
    asset_id: String,
}

/// `taxDepreciationReport(db, { entityId, taxYear, book, stateCode })`.
#[allow(clippy::too_many_lines)] // the report's parts, in order
pub(crate) async fn tax_depreciation_report(
    db: &PgPool,
    entity_id: &str,
    tax_year: i64,
    book_kind: &str,
    state_code: Option<&str>,
) -> Result<Value, Fail> {
    let entity = load_entity(db, entity_id).await?;
    let config = fiscal_config_of(&entity);
    let rows = load_entity_book_rows(db, entity_id).await?;
    let conventions = macrs_convention_map(&config, &rows);
    let Some(year) = fiscal_year_for(&config, tax_year) else {
        return Err(Fail::Internal("no fiscal year".to_owned()));
    };
    let label = fiscal_year_label(&config, year.year);
    let state = if book_kind == "state" {
        state_code.unwrap_or_default().to_uppercase()
    } else {
        String::new()
    };
    if book_kind == "state" && state.is_empty() {
        return Err(bad("A state tax depreciation report needs a stateCode"));
    }
    let context = ScheduleContext {
        config,
        conventions,
    };

    let mut lines: Vec<TaxLine> = Vec::new();
    for (asset, book) in &rows {
        if text(book, "book") != book_kind || opt(book, "stateCode").unwrap_or_default() != state {
            continue;
        }
        let pis = text(asset, "placedInServiceDate");
        if pis > year.end.as_str() {
            continue;
        }
        let schedule = annual_schedule(asset, book, &context);
        let row = schedule.rows.iter().find(|r| r.label == label);
        let placed_this_year = pis >= year.start.as_str() && pis <= year.end.as_str();
        if row.is_none() && !placed_this_year {
            continue;
        }
        let section179 = row.map_or(0.0, |r| r.section179);
        let bonus = row.map_or(0.0, |r| r.bonus);
        let macrs = row.map_or(0.0, |r| r.regular);
        let total = row.map_or(0.0, |r| r.amount);
        let accumulated = row.map_or(0.0, |r| r.accumulated);
        let cost = num(asset, "cost");
        let business = as_number(asset.get("businessUsePercent"), 100.0);
        let listed = looks_like_listed_property(asset, book);
        let json = json!({
            "assetId": asset["id"],
            "assetNumber": asset["assetNumber"],
            "name": asset["name"],
            "assetClass": asset["assetClass"],
            "acquisitionDate": asset["acquisitionDate"],
            "placedInServiceDate": asset["placedInServiceDate"],
            "disposalDate": asset["disposalDate"],
            "placedInServiceThisYear": placed_this_year,
            "cost": number_value(cost),
            "businessUsePercent": number_value(business),
            "method": schedule.method,
            "convention": schedule.convention,
            "recoveryYears": number_value(schedule.recovery_years),
            "depreciableBasis": number_value(schedule.basis.depreciable_basis),
            "section179": number_value(section179),
            "bonus": number_value(bonus),
            "macrs": number_value(macrs),
            "total": number_value(total),
            "accumulated": number_value(accumulated),
            "listedProperty": listed,
            "issues": schedule.issues.iter().map(|i| i.message.clone()).collect::<Vec<_>>(),
        });
        lines.push(TaxLine {
            json,
            placed_this_year,
            method: schedule.method.clone(),
            recovery_years: schedule.recovery_years,
            convention: schedule.convention.clone(),
            cost,
            business_use_percent: business,
            depreciable_basis: schedule.basis.depreciable_basis,
            section179,
            bonus,
            macrs,
            total,
            listed_property: listed,
            placed_in_service_date: pis.to_owned(),
            name: text(asset, "name").to_owned(),
            asset_id: text(asset, "id").to_owned(),
        });
    }
    lines.sort_by(|a, b| {
        locale_compare(&a.placed_in_service_date, &b.placed_in_service_date)
            .then_with(|| locale_compare(&a.name, &b.name))
    });

    let cents = |pick: &dyn Fn(&TaxLine) -> f64, filter: &dyn Fn(&TaxLine) -> bool| -> i64 {
        lines
            .iter()
            .filter(|l| filter(l))
            .map(|l| to_cents(pick(l)))
            .sum()
    };
    let section179_property = cents(&|l| (l.cost * l.business_use_percent) / 100.0, &|l| {
        l.placed_this_year && l.method == "macrs_gds" && l.recovery_years <= 20.0
    });
    let allowance = section_179_allowance(tax_year, from_cents(section179_property), None);
    let section179_total = cents(&|l| l.section179, &|_| true);

    // (recoveryYears, convention, method, count, basis, depreciation)
    let mut classes: Vec<(f64, String, String, i64, i64, i64)> = Vec::new();
    for line in lines.iter().filter(|l| l.placed_this_year) {
        #[allow(clippy::float_cmp)] // the same number, as the key's string
        let found = classes
            .iter_mut()
            .find(|c| c.0 == line.recovery_years && c.1 == line.convention && c.2 == line.method);
        let entry = if let Some(entry) = found {
            entry
        } else {
            classes.push((
                line.recovery_years,
                line.convention.clone(),
                line.method.clone(),
                0,
                0,
                0,
            ));
            classes.last_mut().expect("just pushed")
        };
        entry.3 += 1;
        entry.4 += to_cents(line.depreciable_basis);
        entry.5 += to_cents(line.macrs);
    }
    classes.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| locale_compare(&a.1, &b.1))
    });
    let current_year_assets: Vec<Value> = classes
        .iter()
        .map(|(years, convention, method, count, basis, depreciation)| {
            json!({
                "recoveryYears": number_value(*years),
                "convention": convention,
                "method": method,
                "count": count,
                "basis": number_value(from_cents(*basis)),
                "depreciation": number_value(from_cents(*depreciation)),
            })
        })
        .collect();
    let prior_year_assets = cents(&|l| l.macrs, &|l| !l.placed_this_year);
    let current_year_total = cents(&|l| l.macrs, &|l| l.placed_this_year);
    let bonus_total = cents(&|l| l.bonus, &|_| true);

    let listed: Vec<Value> = lines
        .iter()
        .filter(|l| l.listed_property)
        .map(|l| {
            json!({
                "assetId": l.asset_id,
                "name": l.name,
                "businessUsePercent": number_value(l.business_use_percent),
                "total": number_value(l.total),
            })
        })
        .collect();
    let part1 = json!({
        "totalCostOfSection179Property": number_value(from_cents(section179_property)),
        "limit": allowance.map(|a| number_value(a.parameters.limit)),
        "phaseOutThreshold": allowance.map(|a| number_value(a.parameters.phase_out_threshold)),
        "reduction": number_value(allowance.map_or(0.0, |a| a.phase_out_reduction)),
        "dollarLimit": allowance.map(|a| number_value(a.dollar_limit)),
        "elected": number_value(from_cents(section179_total)),
        "deduction": number_value(from_cents(section179_total)),
    });
    let total = from_cents(section179_total + bonus_total + prior_year_assets + current_year_total);
    Ok(json!({
        "taxYear": tax_year,
        "start": year.start,
        "end": year.end,
        "book": book_kind,
        "stateCode": (!state.is_empty()).then_some(&state),
        "lines": lines.iter().map(|l| l.json.clone()).collect::<Vec<_>>(),
        "form4562": {
            "part1": part1,
            "part2": { "bonus": number_value(from_cents(bonus_total)) },
            "part3": {
                "priorYearAssets": number_value(from_cents(prior_year_assets)),
                "currentYearAssets": current_year_assets,
                "currentYearTotal": number_value(from_cents(current_year_total)),
            },
            "listedProperty": listed,
            "total": number_value(total),
        },
        "midQuarter": mid_quarter_report(&context.config, &rows, tax_year),
    }))
}
