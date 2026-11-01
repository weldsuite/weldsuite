//! What the yearly 1099 computation reads (`services/form-1099/load.ts`) and
//! the review built on it (`summary.ts`): per-vendor rows with the reasons
//! behind each status, warnings by vendor name, the drill-down to the
//! payments, and the Form 945 view of backup withholding. Only `tin_last4`
//! ever leaves here.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::address::normalize_postal_address;
use weldsuite_books_domain::form_1099::compute::{
    self, Adjustment, BankTransaction, Bill, BillLine, ComputeResult, Payment, Source, Vendor,
    VendorResult, boxes_json, compute_1099_totals,
};
use weldsuite_books_domain::form_1099::{
    Form945Payment, form_945_summary, form_1099_deadlines, form_of_box, usd,
};
use weldsuite_books_domain::js::{locale_compare, math_round, number_value};
use weldsuite_books_domain::jurisdictions::us::mask_tin;
use weldsuite_books_domain::tables::{
    BANK_TRANSACTIONS, BILL_ITEMS, BILLS, ENTITIES, PARTIES, PAYMENT_ALLOCATIONS, PAYMENTS,
};
use weldsuite_books_domain::vendor_tax::is_tin_type;

use super::Fail;

/// `TIN_MATCH_PROBLEMS`.
pub(crate) const TIN_MATCH_PROBLEMS: [&str; 3] = ["mismatch", "not_issued", "invalid"];

pub(crate) fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

pub(crate) fn opt<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

fn num(row: &Value, key: &str) -> f64 {
    weldsuite_books_domain::js::numeric(row.get(key).unwrap_or(&Value::Null))
}

fn truthy(row: &Value, key: &str) -> bool {
    weldsuite_books_domain::js::truthy(row.get(key))
}

fn day(row: &Value, key: &str) -> String {
    text(row, key).chars().take(10).collect()
}

fn cents(value: f64) -> f64 {
    math_round(value * 100.0) / 100.0
}

/// `yearBounds(taxYear)` as timestamps.
pub(crate) fn year_bounds(tax_year: i64) -> (String, String) {
    (
        format!("{tax_year:04}-01-01T00:00:00.000Z"),
        format!("{:04}-01-01T00:00:00.000Z", tax_year + 1),
    )
}

/// `isAddressComplete(address)`.
pub(crate) fn is_address_complete(address: Option<&Value>) -> bool {
    let Some(normalized) = normalize_postal_address(address) else {
        return false;
    };
    let filled = |key: &str| {
        normalized
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty())
    };
    if !filled("line1") || !filled("city") || !filled("postalCode") {
        return false;
    }
    let foreign = normalized
        .get("country")
        .and_then(Value::as_str)
        .is_some_and(|c| !c.is_empty() && c != "US");
    foreign || filled("state")
}

/// The W-9 object of a party (`party.w9`).
pub(crate) fn w9_of(party: &Value) -> Option<&Value> {
    party.get("w9").filter(|w| w.is_object())
}

pub(crate) fn w9_text<'a>(party: &'a Value, key: &str) -> Option<&'a str> {
    w9_of(party)
        .and_then(|w| w.get(key))
        .and_then(Value::as_str)
}

fn to_vendor(party: &Value) -> Vendor {
    Vendor {
        party_id: text(party, "id").to_owned(),
        name: opt(party, "displayName").map(str::to_owned),
        is_1099_vendor: truthy(party, "is1099Vendor"),
        default_form: opt(party, "default1099Form").map(str::to_owned),
        default_box: opt(party, "default1099Box").map(str::to_owned),
        tin_last4: opt(party, "tinLast4").map(str::to_owned),
        federal_tax_classification: w9_text(party, "federalTaxClassification").map(str::to_owned),
        llc_tax_classification: w9_text(party, "llcTaxClassification").map(str::to_owned),
        is_attorney: w9_of(party)
            .is_some_and(|w| weldsuite_books_domain::js::truthy(w.get("isAttorney"))),
        address_complete: is_address_complete(party.get("billingAddress")),
        backup_withholding: truthy(party, "backupWithholding"),
    }
}

/// `Loaded1099`: the input, the parties (in the order the computation lists
/// them) and the documents for the drill-down.
pub(crate) struct Loaded {
    pub(crate) entity: Value,
    pub(crate) input: compute::Input,
    pub(crate) parties: Vec<(String, Value)>,
    pub(crate) payments: HashMap<String, Value>,
    pub(crate) bills: HashMap<String, Value>,
    pub(crate) bill_lines: HashMap<String, Value>,
    pub(crate) bank_transactions: HashMap<String, Value>,
    pub(crate) accounts: HashMap<String, Value>,
}

impl Loaded {
    pub(crate) fn party(&self, id: &str) -> Option<&Value> {
        self.parties.iter().find(|(p, _)| p == id).map(|(_, v)| v)
    }
}

/// `loadEntityOrThrow(db, entityId)`.
pub(crate) async fn load_entity(db: &PgPool, entity_id: &str) -> Result<Value, Fail> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(entities),
        " from entities t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    row.map(|r| ENTITIES.js(r))
        .ok_or_else(|| Fail::not_found(format!("Accounting entity {entity_id} not found")))
}

fn line_amount(item: &Value) -> f64 {
    if !item["lineTotal"].is_null() {
        return num(item, "lineTotal");
    }
    let quantity = if item["quantity"].is_null() {
        1.0
    } else {
        num(item, "quantity")
    };
    let discount = num(item, "discountPercent");
    cents(quantity * num(item, "unitPrice") * (1.0 - discount / 100.0))
}

/// `load1099Input(db, entityId, taxYear, { partyIds, adjustments })`.
#[allow(clippy::too_many_lines)] // one query per source, as TypeScript
pub(crate) async fn load_1099_input(
    db: &PgPool,
    entity_id: &str,
    tax_year: i64,
    only: Option<&[String]>,
    adjustments: Vec<Adjustment>,
) -> Result<Loaded, Fail> {
    let entity = load_entity(db, entity_id).await?;
    let (start, end) = year_bounds(tax_year);
    let only: Option<Vec<String>> = only.filter(|o| !o.is_empty()).map(<[String]>::to_vec);

    let payment_rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payments),
        " from payments t where t.entity_id = $1 and t.type = 'sent' and t.deleted_at is null \
         and t.date >= $2::timestamp and t.date < $3::timestamp \
         and ($4::text[] is null or t.contact_id = any($4))"
    ))
    .bind(entity_id)
    .bind(&start)
    .bind(&end)
    .bind(&only)
    .fetch_all(db)
    .await?;
    let payment_rows = PAYMENTS.js_rows(payment_rows);

    let bank_accounts: Vec<(String, Option<String>)> =
        sqlx::query_as("select id, account_type from bank_accounts where entity_id = $1")
            .bind(entity_id)
            .fetch_all(db)
            .await?;
    let credit_cards: Vec<String> = bank_accounts
        .into_iter()
        .filter(|(_, kind)| kind.as_deref() == Some("credit_card"))
        .map(|(id, _)| id)
        .collect();

    let bank_rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(bank_transactions),
        " from bank_transactions t where t.entity_id = $1 and t.deleted_at is null \
         and t.status = 'reconciled' and t.date >= $2::timestamp and t.date < $3::timestamp \
         and t.contact_id is not null and t.category_account_id is not null \
         and t.reconciled_payment_id is null and t.reconciled_bill_id is null \
         and t.reconciled_invoice_id is null and t.amount < 0 \
         and ($4::text[] is null or t.contact_id = any($4))"
    ))
    .bind(entity_id)
    .bind(&start)
    .bind(&end)
    .bind(&only)
    .fetch_all(db)
    .await?;
    let bank_rows = BANK_TRANSACTIONS.js_rows(bank_rows);

    let payment_ids: Vec<String> = payment_rows
        .iter()
        .map(|p| text(p, "id").to_owned())
        .collect();
    let allocation_rows: Vec<Value> = if payment_ids.is_empty() {
        Vec::new()
    } else {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(payment_allocations),
            " from payment_allocations t where t.payment_id = any($1) and t.deleted_at is null \
             and t.bill_id is not null"
        ))
        .bind(&payment_ids)
        .fetch_all(db)
        .await?;
        PAYMENT_ALLOCATIONS.js_rows(rows)
    };
    let mut bill_ids: Vec<String> = Vec::new();
    for allocation in &allocation_rows {
        let id = text(allocation, "billId").to_owned();
        if !bill_ids.contains(&id) {
            bill_ids.push(id);
        }
    }
    let (bill_rows, item_rows) = if bill_ids.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        let bills: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(bills),
            " from bills t where t.id = any($1)"
        ))
        .bind(&bill_ids)
        .fetch_all(db)
        .await?;
        let items: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(bill_items),
            " from bill_items t where t.bill_id = any($1) and t.deleted_at is null order by t.sort_order"
        ))
        .bind(&bill_ids)
        .fetch_all(db)
        .await?;
        (BILLS.js_rows(bills), BILL_ITEMS.js_rows(items))
    };

    let account_rows: Vec<(String, String, String, Option<String>)> =
        sqlx::query_as("select id, code, name, form_1099_box from accounts where entity_id = $1")
            .bind(entity_id)
            .fetch_all(db)
            .await?;

    // Vendors: everyone paid in the year, plus every 1099 vendor.
    let mut paid: Vec<String> = Vec::new();
    for row in payment_rows.iter().chain(&bank_rows) {
        if let Some(id) = opt(row, "contactId")
            && !paid.iter().any(|p| p == id)
        {
            paid.push(id.to_owned());
        }
    }
    let mut parties: Vec<(String, Value)> = Vec::new();
    if !paid.is_empty() {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(parties),
            " from parties t where t.id = any($1)"
        ))
        .bind(&paid)
        .fetch_all(db)
        .await?;
        for row in PARTIES.js_rows(rows) {
            parties.push((text(&row, "id").to_owned(), row));
        }
    }
    let flagged: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(parties),
        " from parties t where t.is_1099_vendor = true and t.deleted_at is null \
         and ($1::text[] is null or t.id = any($1))"
    ))
    .bind(&only)
    .fetch_all(db)
    .await?;
    for row in PARTIES.js_rows(flagged) {
        let id = text(&row, "id").to_owned();
        if let Some(slot) = parties.iter_mut().find(|(p, _)| *p == id) {
            slot.1 = row;
        } else {
            parties.push((id, row));
        }
    }

    let base_currency = opt(&entity, "baseCurrency").map(str::to_owned);
    let rate_of =
        |currency: Option<&str>, rate: Option<&str>| match currency.filter(|c| !c.is_empty()) {
            None => 1.0,
            Some(c) if Some(c) == base_currency.as_deref() => 1.0,
            Some(_) => {
                let value = rate.map_or(1.0, |r| weldsuite_books_domain::js::numeric(&json!(r)));
                if value.is_finite() && value > 0.0 {
                    value
                } else {
                    1.0
                }
            }
        };
    let payments: Vec<Payment> = payment_rows
        .iter()
        .map(|p| {
            let rate = rate_of(opt(p, "currency"), opt(p, "exchangeRate"));
            let id = text(p, "id").to_owned();
            Payment {
                party_id: text(p, "contactId").to_owned(),
                date: day(p, "date"),
                amount: cents(num(p, "amount") * rate),
                payment_method: opt(p, "paymentMethod").map(str::to_owned),
                from_credit_card_account: opt(p, "bankAccountId")
                    .filter(|b| !b.is_empty())
                    .is_some_and(|b| credit_cards.iter().any(|c| c == b)),
                paid_through_payroll: truthy(p, "paidThroughPayroll"),
                voided: opt(p, "checkStatus") == Some("voided"),
                backup_withholding_amount: cents(num(p, "backupWithholdingAmount") * rate),
                allocations: allocation_rows
                    .iter()
                    .filter(|a| text(a, "paymentId") == id)
                    .map(|a| (text(a, "billId").to_owned(), cents(num(a, "amount") * rate)))
                    .collect(),
                id,
            }
        })
        .collect();
    let bills: Vec<Bill> = bill_rows
        .iter()
        .map(|bill| Bill {
            id: text(bill, "id").to_owned(),
            lines: item_rows
                .iter()
                .filter(|i| text(i, "billId") == text(bill, "id"))
                .map(|i| BillLine {
                    id: text(i, "id").to_owned(),
                    amount: line_amount(i),
                    tax_amount: num(i, "taxAmount"),
                    account_id: opt(i, "accountId").map(str::to_owned),
                    form_1099_box: opt(i, "form1099Box").map(str::to_owned),
                })
                .collect(),
        })
        .collect();
    let bank_transactions: Vec<BankTransaction> = bank_rows
        .iter()
        .map(|t| BankTransaction {
            id: text(t, "id").to_owned(),
            party_id: text(t, "contactId").to_owned(),
            date: day(t, "date"),
            amount: num(t, "amount").abs(),
            account_id: opt(t, "categoryAccountId").map(str::to_owned),
            from_credit_card_account: credit_cards.iter().any(|c| c == text(t, "bankAccountId")),
            matched_payment_id: opt(t, "reconciledPaymentId").map(str::to_owned),
        })
        .collect();
    let account_boxes: Vec<(String, String)> = account_rows
        .iter()
        .filter_map(|(id, _, _, b)| b.clone().filter(|b| !b.is_empty()).map(|b| (id.clone(), b)))
        .collect();

    let input = compute::Input {
        tax_year,
        vendors: parties.iter().map(|(_, p)| to_vendor(p)).collect(),
        payments,
        bills,
        bank_transactions,
        account_boxes,
        adjustments,
    };
    Ok(Loaded {
        input,
        payments: payment_rows
            .iter()
            .map(|p| {
                (
                    text(p, "id").to_owned(),
                    json!({
                        "id": p["id"],
                        "date": day(p, "date"),
                        "method": p["paymentMethod"],
                        "checkNumber": p["checkNumber"],
                        "reference": p["reference"],
                        "amount": number_value(num(p, "amount")),
                        "backupWithholdingAmount": number_value(num(p, "backupWithholdingAmount")),
                    }),
                )
            })
            .collect(),
        bills: bill_rows
            .iter()
            .map(|b| {
                let reference = if b["externalReference"].is_null() { b["reference"].clone() } else { b["externalReference"].clone() };
                (
                    text(b, "id").to_owned(),
                    json!({ "id": b["id"], "number": b["billNumber"], "issueDate": day(b, "issueDate"), "reference": reference }),
                )
            })
            .collect(),
        bill_lines: item_rows
            .iter()
            .map(|i| (text(i, "id").to_owned(), i.clone()))
            .collect(),
        bank_transactions: bank_rows
            .iter()
            .map(|t| {
                (
                    text(t, "id").to_owned(),
                    json!({
                        "id": t["id"],
                        "date": day(t, "date"),
                        "description": t["description"],
                        "counterpartyName": t["counterpartyName"],
                        "checkNumber": t["checkNumber"],
                        "amount": number_value(num(t, "amount").abs()),
                    }),
                )
            })
            .collect(),
        accounts: account_rows
            .iter()
            .map(|(id, code, name, _)| (id.clone(), json!({ "id": id, "code": code, "name": name })))
            .collect(),
        parties,
        entity,
    })
}

/// `compute1099ForEntity(db, entityId, taxYear, options)`.
pub(crate) async fn compute_for_entity(
    db: &PgPool,
    entity_id: &str,
    tax_year: i64,
    only: Option<&[String]>,
    adjustments: Vec<Adjustment>,
) -> Result<(Loaded, ComputeResult), Fail> {
    let loaded = load_1099_input(db, entity_id, tax_year, only, adjustments).await?;
    let result = compute_1099_totals(&loaded.input).ok_or_else(|| {
        Fail::Internal(format!(
            "1099 thresholds start at tax year 2020; got {tax_year}"
        ))
    })?;
    Ok((loaded, result))
}

fn sum2(values: impl Iterator<Item = f64>) -> f64 {
    math_round(values.fold(0.0, |acc, v| acc + v) * 100.0) / 100.0
}

/// `buildVendorRow(result, party)`.
pub(crate) fn build_vendor_row(result: &VendorResult, party: &Value) -> Value {
    let tin_type = opt(party, "tinType");
    let match_status = opt(party, "tinMatchStatus").unwrap_or_default();
    let mismatch = TIN_MATCH_PROBLEMS.contains(&match_status);
    let backup = truthy(party, "backupWithholding");
    let mut reasons = result.reasons.clone();
    if mismatch {
        reasons.push(if backup {
            "The IRS could not match the name and TIN; backup withholding is on.".to_owned()
        } else {
            "The IRS could not match the name and TIN. Send a first B notice and ask for a new W-9; turn on backup withholding if none arrives within 30 business days.".to_owned()
        });
    }
    let exclusion_total = |reason: &str| {
        number_value(sum2(
            result
                .exclusions
                .iter()
                .filter(|e| e.reason == reason)
                .map(|e| e.amount),
        ))
    };
    let display = opt(party, "displayName").unwrap_or_default();
    let legal = w9_text(party, "legalName")
        .map(|l| weldsuite_kit::validation::js_trim(l).to_owned())
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| display.to_owned());
    let tin_last4 = opt(party, "tinLast4").filter(|t| !t.is_empty());
    let w9 = w9_of(party);
    json!({
        "partyId": party["id"],
        "name": display,
        "legalName": legal,
        "status": result.status,
        "reasons": reasons,
        "forms": result.forms,
        "boxes": boxes_json(&result.boxes),
        "totals": boxes_json(&result.totals),
        "aboveThreshold": result.above_threshold,
        "isCorporation": result.is_corporation,
        "isAttorney": w9.is_some_and(|w| weldsuite_books_domain::js::truthy(w.get("isAttorney"))),
        "tinType": party["tinType"],
        "tinLast4": party["tinLast4"],
        "tinMasked": tin_last4.map(|t| mask_tin(t, tin_type.filter(|k| is_tin_type(Some(k))))),
        "hasTin": tin_last4.is_some(),
        "tinMatchStatus": party["tinMatchStatus"],
        "tinMatchedAt": party["tinMatchedAt"],
        "backupWithholding": backup,
        "suggestBackupWithholding": mismatch && !backup,
        "addressComplete": is_address_complete(party.get("billingAddress")),
        "address": normalize_postal_address(party.get("billingAddress")),
        "hasW9": w9.is_some_and(|w| weldsuite_books_domain::js::truthy(w.get("receivedAt")) || weldsuite_books_domain::js::truthy(w.get("legalName"))),
        "eDeliveryConsent": truthy(party, "form1099EDeliveryConsentAt"),
        "excluded": {
            "cardOrNetwork": exclusion_total("card_or_network_method"),
            "creditCardAccount": exclusion_total("credit_card_account"),
            "payroll": exclusion_total("paid_through_payroll"),
            "omittedBox": exclusion_total("omitted_box"),
        },
        "unmappedAmount": number_value(sum2(result.unmapped.iter().map(|u| u.amount))),
        "adjustmentCount": result.adjustments.len(),
        "paymentCount": result.payment_ids.len(),
        "bankTransactionCount": result.bank_transaction_ids.len(),
    })
}

/// `buildSummary(computed)`.
pub(crate) fn build_summary(loaded: &Loaded, result: &ComputeResult) -> Value {
    let mut rows: Vec<(String, Value, &VendorResult)> = Vec::new();
    for vendor in &result.vendors {
        let Some(party) = loaded.party(&vendor.party_id) else {
            continue;
        };
        if vendor.status == "not_1099_vendor" && !vendor.above_threshold {
            continue;
        }
        let row = build_vendor_row(vendor, party);
        rows.push((text(&row, "name").to_owned(), row, vendor));
    }
    rows.sort_by(|a, b| locale_compare(&a.0, &b.0));

    let mut warnings = Vec::new();
    for (name, row, vendor) in &rows {
        let status = vendor.status;
        if status == "not_1099_vendor" {
            #[allow(clippy::cast_precision_loss)] // cents of real payments
            let total = sum2(vendor.totals.iter().map(|(_, c)| *c as f64 / 100.0));
            warnings.push(format!(
                "{name} was paid {} in reportable boxes but is not marked as a 1099 vendor.",
                usd(total)
            ));
        }
        if status == "needs_tin" {
            warnings.push(format!("{name} needs a TIN: collect a W-9 before filing."));
        }
        if status == "needs_address" {
            warnings.push(format!("{name} needs a complete mailing address."));
        }
        let unmapped = row["unmappedAmount"].as_f64().unwrap_or(0.0);
        if unmapped > 0.0 {
            warnings.push(format!(
                "{} paid to {name} has no 1099 box; set a default box on the vendor, the account or the bill line.",
                usd(unmapped)
            ));
        }
        if row["suggestBackupWithholding"] == json!(true) {
            warnings.push(format!(
                "{name}: the IRS TIN match failed. Send a B notice and consider backup withholding."
            ));
        } else if TIN_MATCH_PROBLEMS.contains(&opt(row, "tinMatchStatus").unwrap_or_default()) {
            warnings.push(format!(
                "{name}: the IRS TIN match failed; backup withholding is on."
            ));
        }
        let withheld = vendor
            .boxes
            .iter()
            .any(|(c, v)| (*c == "nec_4" || *c == "misc_4") && *v != 0);
        if row["backupWithholding"] == json!(true) && status == "included" && !withheld {
            warnings.push(format!(
                "{name} is subject to backup withholding but no tax was withheld on the payments."
            ));
        }
    }
    warnings.extend(result.warnings.iter().cloned());

    let (mut nec, mut misc, mut withheld) = (0.0, 0.0, 0.0);
    for (_, _, vendor) in &rows {
        if !matches!(vendor.status, "included" | "needs_tin" | "needs_address") {
            continue;
        }
        for (code, value) in &vendor.boxes {
            #[allow(clippy::cast_precision_loss)]
            let amount = *value as f64 / 100.0;
            if *code == "nec_4" || *code == "misc_4" {
                withheld += amount;
            } else if form_of_box(code) == "nec" {
                nec += amount;
            } else {
                misc += amount;
            }
        }
    }
    let thresholds = &result.thresholds;
    let group = |name: &str| thresholds.group(name).map_or(Value::Null, number_value);
    json!({
        "taxYear": result.tax_year,
        "entityId": loaded.entity["id"],
        "thresholds": {
            "published": thresholds.published,
            "general": group("general"),
            "royalty": group("royalty"),
            "fixed600": group("fixed_600"),
            "boxes": thresholds.boxes_json(),
        },
        "deadlines": form_1099_deadlines(result.tax_year),
        "summary": result.summary_json(),
        "totals": {
            "nec": number_value(sum2(std::iter::once(nec))),
            "misc": number_value(sum2(std::iter::once(misc))),
            "withheld": number_value(sum2(std::iter::once(withheld))),
        },
        "vendors": rows.into_iter().map(|(_, row, _)| row).collect::<Vec<_>>(),
        "warnings": warnings,
    })
}

fn source_view(loaded: &Loaded, source: &Source) -> Map<String, Value> {
    let account = |id: Option<&str>| {
        id.and_then(|id| loaded.accounts.get(id))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let mut out = Map::new();
    out.insert(
        "payment".into(),
        source
            .payment_id
            .as_ref()
            .and_then(|id| loaded.payments.get(id))
            .cloned()
            .unwrap_or(Value::Null),
    );
    out.insert(
        "bill".into(),
        source
            .bill_id
            .as_ref()
            .and_then(|id| loaded.bills.get(id))
            .cloned()
            .unwrap_or(Value::Null),
    );
    out.insert(
        "billLine".into(),
        source
            .bill_line_id
            .as_ref()
            .and_then(|id| loaded.bill_lines.get(id))
            .map_or(Value::Null, |line| {
                json!({ "id": line["id"], "description": line["description"], "account": account(opt(line, "accountId")) })
            }),
    );
    out.insert(
        "bankTransaction".into(),
        source
            .bank_transaction_id
            .as_ref()
            .and_then(|id| loaded.bank_transactions.get(id))
            .cloned()
            .unwrap_or(Value::Null),
    );
    out
}

/// An applied adjustment as the drill-down shows it.
pub(crate) fn adjustment_json(a: &Adjustment) -> Value {
    let mut out = json!({
        "partyId": a.party_id,
        "box": a.box_code,
        "amount": number_value(a.amount),
        "reason": a.reason,
        "applied": true,
    });
    if let Some(by) = &a.by {
        out["by"] = json!(by);
    }
    out
}

/// `vendorDrillDown(db, entityId, taxYear, partyId)`; `None` when the vendor
/// doesn't exist.
pub(crate) async fn vendor_drill_down(
    db: &PgPool,
    entity_id: &str,
    tax_year: i64,
    party_id: &str,
) -> Result<Option<Value>, Fail> {
    let only = [party_id.to_owned()];
    let (loaded, result) =
        compute_for_entity(db, entity_id, tax_year, Some(&only), Vec::new()).await?;
    let Some(party) = loaded.party(party_id) else {
        return Ok(None);
    };
    let vendor = result.vendors.iter().find(|v| v.party_id == party_id);
    let empty;
    let row_source = if let Some(v) = vendor {
        v
    } else {
        empty = VendorResult::empty(
            party_id,
            opt(party, "displayName").map(str::to_owned),
            truthy(party, "is1099Vendor"),
        );
        &empty
    };
    let contributions: Vec<Value> = vendor.map_or_else(Vec::new, |v| {
        v.contributions
            .iter()
            .map(|c| {
                let mut out = Map::new();
                out.insert("box".into(), json!(c.box_code));
                out.insert("amount".into(), number_value(c.amount));
                out.insert("boxSource".into(), json!(c.box_source));
                out.insert("unapplied".into(), json!(c.unapplied));
                out.extend(source_view(&loaded, &c.source));
                Value::Object(out)
            })
            .collect()
    });
    let exclusions: Vec<Value> = vendor.map_or_else(Vec::new, |v| {
        v.exclusions
            .iter()
            .map(|e| {
                let mut out = Map::new();
                out.insert("reason".into(), json!(e.reason));
                out.insert("amount".into(), number_value(e.amount));
                out.insert("paymentMethod".into(), json!(e.payment_method));
                out.extend(source_view(&loaded, &e.source));
                Value::Object(out)
            })
            .collect()
    });
    let unmapped: Vec<Value> = vendor.map_or_else(Vec::new, |v| {
        v.unmapped
            .iter()
            .map(|u| {
                let mut out = Map::new();
                out.insert("reason".into(), json!(u.reason));
                out.insert("amount".into(), number_value(u.amount));
                out.extend(source_view(&loaded, &u.source));
                Value::Object(out)
            })
            .collect()
    });
    Ok(Some(json!({
        "taxYear": tax_year,
        "vendor": build_vendor_row(row_source, party),
        "contributions": contributions,
        "exclusions": exclusions,
        "unmapped": unmapped,
        "adjustments": vendor.map_or_else(Vec::new, |v| v.adjustments.iter().map(adjustment_json).collect()),
        "warnings": result.warnings,
    })))
}

/// A payment with backup withholding: id, party, day, amount, check status.
type Withheld = (String, String, String, Option<String>, Option<String>);

/// `backupWithholdingFor945(db, entityId, taxYear)`.
pub(crate) async fn backup_withholding_for_945(
    db: &PgPool,
    entity_id: &str,
    tax_year: i64,
) -> Result<Value, Fail> {
    let (start, end) = year_bounds(tax_year);
    let rows: Vec<Withheld> = sqlx::query_as(
        "select id, contact_id, to_char(date, 'YYYY-MM-DD'), backup_withholding_amount::text, check_status \
         from payments where entity_id = $1 and deleted_at is null and date >= $2::timestamp \
         and date < $3::timestamp and coalesce(backup_withholding_amount, 0) > 0",
    )
    .bind(entity_id)
    .bind(&start)
    .bind(&end)
    .fetch_all(db)
    .await?;
    let payments: Vec<Form945Payment> = rows
        .into_iter()
        .map(|(id, party_id, date, amount, status)| Form945Payment {
            id,
            party_id,
            date,
            backup_withholding_amount: amount
                .map_or(0.0, |a| weldsuite_books_domain::js::numeric(&json!(a))),
            voided: status.as_deref() == Some("voided"),
        })
        .collect();
    let mut summary = form_945_summary(tax_year, &payments);
    let party_ids: Vec<String> = summary["byVendor"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|v| v["partyId"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let mut names: HashMap<String, String> = HashMap::new();
    if !party_ids.is_empty() {
        let rows: Vec<(String, Option<String>)> =
            sqlx::query_as("select id, display_name from parties where id = any($1)")
                .bind(&party_ids)
                .fetch_all(db)
                .await?;
        for (id, name) in rows {
            names.insert(id, name.unwrap_or_default());
        }
    }
    if let Some(list) = summary["byVendor"].as_array_mut() {
        for vendor in list {
            let name = vendor["partyId"]
                .as_str()
                .and_then(|id| names.get(id))
                .cloned();
            vendor["name"] = json!(name);
        }
    }
    Ok(summary)
}
