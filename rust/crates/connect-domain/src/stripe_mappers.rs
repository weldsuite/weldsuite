//! Stripe records → WeldSuite entities (`connectors/stripe-mappers.ts`):
//! invoices (all lines, tax rates expanded), one balance row per currency,
//! and the synthetic payout lines. Amounts arrive in minor units.

use serde_json::{Map, Value, json};

use crate::js::{number_text, number_value, to_fixed};
use crate::mappers::{DocumentLine, Mapped, slice_units};
use crate::stripe::{amount_to_decimal, balance_account_id};

fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn records(value: Option<&Value>) -> Vec<&Map<String, Value>> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default()
}

/// `str(value, max)`: a trimmed non-empty string.
fn text(value: Option<&Value>, max: Option<usize>) -> Option<String> {
    let trimmed = weldsuite_kit::validation::js_trim(value?.as_str()?);
    if trimmed.is_empty() {
        return None;
    }
    Some(match max {
        Some(max) => slice_units(trimmed, max),
        None => trimmed.to_owned(),
    })
}

fn s(value: Option<&Value>) -> Option<String> {
    text(value, None)
}

/// `num(value)`: a finite number.
fn num(value: Option<&Value>) -> Option<f64> {
    value
        .filter(|v| v.is_number())
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
}

/// `idOf(value)`.
fn id_of(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        other => text(record(other).and_then(|r| r.get("id")), None),
    }
}

fn iso(ms: f64) -> Option<String> {
    weldsuite_kit::validation::js_iso_from_millis(ms)
}

fn date_from_unix(value: Option<&Value>) -> Option<String> {
    num(value).and_then(|s| iso(s * 1000.0))
}

fn date_from_iso(value: Option<&Value>) -> Option<String> {
    crate::mappers::js_date_loose(&s(value)?).and_then(iso)
}

fn opt(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::String)
}

fn compact(pairs: Vec<(&str, Value)>) -> Map<String, Value> {
    pairs
        .into_iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| (k.to_owned(), v))
        .collect()
}

fn money(minor: f64, currency: &str) -> String {
    amount_to_decimal(Some(&number_value(minor)), Some(currency), 2)
}

/// `Number(money(...))`.
fn money_number(minor: f64, currency: &str) -> Value {
    number_value(weldsuite_kit::validation::js_number(&money(
        minor, currency,
    )))
}

fn stripe_address(source: Option<&Value>) -> Value {
    let Some(address) = record(source) else {
        return Value::Null;
    };
    let mapped = compact(vec![
        ("line1", opt(s(address.get("line1")))),
        ("line2", opt(s(address.get("line2")))),
        ("city", opt(s(address.get("city")))),
        ("state", opt(s(address.get("state")))),
        ("postalCode", opt(s(address.get("postal_code")))),
        (
            "country",
            opt(s(address.get("country")).map(|c| c.to_uppercase())),
        ),
    ]);
    if mapped.is_empty() {
        Value::Null
    } else {
        Value::Object(mapped)
    }
}

/// `primaryTaxId(taxIds)`: the EU VAT id, else the first.
fn primary_tax_id(tax_ids: Option<&Value>) -> Option<String> {
    let ids = records(tax_ids);
    let chosen = ids
        .iter()
        .find(|row| row.get("type").and_then(Value::as_str) == Some("eu_vat"))
        .or_else(|| ids.first())?;
    text(chosen.get("value"), Some(50))
}

/// `stripeCustomerSnapshot(invoice)`: the customer as the invoice saw it.
pub fn customer_snapshot(invoice: &Value) -> Option<Value> {
    let id = id_of(invoice.get("customer"))?;
    let or_null = |key: &str| {
        invoice
            .get(key)
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(Value::Null)
    };
    Some(json!({
        "id": id,
        "object": "stripe_customer",
        "name": or_null("customer_name"),
        "email": or_null("customer_email"),
        "phone": or_null("customer_phone"),
        "address": or_null("customer_address"),
        "tax_ids": invoice.get("customer_tax_ids").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!([])),
        "tax_exempt": or_null("customer_tax_exempt"),
    }))
}

fn split_name(name: &str) -> (Option<String>, Option<String>) {
    let trimmed = weldsuite_kit::validation::js_trim(name);
    let parts: Vec<&str> = trimmed
        .split(|c: char| c.is_whitespace() || c == '\u{feff}')
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() < 2 {
        return ((!trimmed.is_empty()).then(|| trimmed.to_owned()), None);
    }
    (Some(parts[0].to_owned()), Some(parts[1..].join(" ")))
}

/// `mapStripeCustomer(record, externalId)`: a customer with a tax id is a
/// company, everyone else a person.
fn map_customer(record: &Value, external_id: &str) -> Option<Mapped> {
    let email = text(record.get("email"), Some(255));
    let name = text(record.get("name"), Some(255)).or_else(|| email.clone())?;
    let vat = primary_tax_id(record.get("tax_ids"));
    let address = stripe_address(record.get("address"));
    let phone = text(record.get("phone"), Some(50));
    let kind = if vat.is_some() { "company" } else { "person" };
    let (first, last) = split_name(&name);
    let identity = if kind == "company" {
        compact(vec![
            ("name", json!(name)),
            ("displayName", json!(name)),
            ("email", opt(email)),
            ("phone", opt(phone)),
            ("vatNumber", opt(vat)),
            ("primaryAddress", address.clone()),
            ("source", json!("stripe")),
            ("status", json!("active")),
            ("ownerId", Value::Null),
        ])
    } else {
        compact(vec![
            ("firstName", opt(first)),
            ("lastName", opt(last)),
            ("fullName", json!(name)),
            ("displayName", json!(name)),
            ("email", opt(email)),
            ("directPhone", opt(phone)),
            ("primaryAddress", address.clone()),
            ("source", json!("stripe")),
            ("status", json!("active")),
            ("inCrm", json!(false)),
        ])
    };
    Some(Mapped::Party {
        external_id: external_id.to_owned(),
        kind,
        identity,
        values: compact(vec![
            ("kind", json!(kind)),
            ("displayName", json!(name)),
            ("billingAddress", address),
            ("status", json!("active")),
            ("role", json!("none")),
        ]),
    })
}

struct TaxRateInfo {
    id: String,
    percentage: f64,
    name: String,
    country: Option<String>,
}

fn invoice_tax_rates(invoice: &Value) -> Vec<TaxRateInfo> {
    let mut rates: Vec<TaxRateInfo> = Vec::new();
    for row in records(invoice.get("total_tax_amounts")) {
        let rate = record(row.get("tax_rate"));
        let Some(id) = id_of(row.get("tax_rate")) else {
            continue;
        };
        let percentage = num(rate.and_then(|r| r.get("effective_percentage")))
            .or_else(|| num(rate.and_then(|r| r.get("percentage"))))
            .unwrap_or(0.0);
        let info = TaxRateInfo {
            name: s(rate.and_then(|r| r.get("display_name")))
                .unwrap_or_else(|| format!("{}%", number_text(percentage))),
            country: s(rate.and_then(|r| r.get("country"))),
            percentage,
            id: id.clone(),
        };
        match rates.iter_mut().find(|r| r.id == id) {
            Some(existing) => *existing = info,
            None => rates.push(info),
        }
    }
    rates
}

const ZERO_RATE_REASONS: [&str; 10] = [
    "reverse_charge",
    "not_collecting",
    "not_subject_to_tax",
    "excluded_territory",
    "jurisdiction_unsupported",
    "customer_exempt",
    "product_exempt",
    "vat_exempt",
    "zero_rated",
    "not_supported",
];

fn tax_breakdown(invoice: &Value, rates: &[TaxRateInfo]) -> Value {
    let currency = s(invoice.get("currency")).unwrap_or_else(|| "eur".to_owned());
    Value::Array(
        records(invoice.get("total_tax_amounts"))
            .iter()
            .map(|row| {
                let id = id_of(row.get("tax_rate")).unwrap_or_else(|| "stripe".to_owned());
                let rate = rates.iter().find(|r| r.id == id);
                let reason = s(row.get("taxability_reason"));
                let mut out = Map::new();
                out.insert("taxRateId".to_owned(), json!(id));
                out.insert(
                    "taxRateName".to_owned(),
                    json!(rate.map_or_else(|| id.clone(), |r| r.name.clone())),
                );
                out.insert(
                    "taxRate".to_owned(),
                    number_value(rate.map_or(0.0, |r| r.percentage)),
                );
                out.insert(
                    "taxableAmount".to_owned(),
                    money_number(num(row.get("taxable_amount")).unwrap_or(0.0), &currency),
                );
                out.insert(
                    "taxAmount".to_owned(),
                    money_number(num(row.get("amount")).unwrap_or(0.0), &currency),
                );
                if let Some(country) = rate.and_then(|r| r.country.as_ref()) {
                    out.insert("jurisdictionCode".to_owned(), json!(country.to_uppercase()));
                }
                if let Some(reason) = &reason {
                    out.insert("taxCategoryCode".to_owned(), json!(reason));
                    if ZERO_RATE_REASONS.contains(&reason.as_str()) {
                        out.insert("exemptReason".to_owned(), json!(reason));
                    }
                }
                Value::Object(out)
            })
            .collect(),
    )
}

fn line_period(line: &Map<String, Value>) -> Option<(String, String)> {
    let period = record(line.get("period"))?;
    let start = date_from_unix(period.get("start"))?;
    let end = date_from_unix(period.get("end"))?;
    Some((start[..10].to_owned(), end[..10].to_owned()))
}

fn map_invoice_line(
    line: &Map<String, Value>,
    index: usize,
    currency: &str,
    rates: &[TaxRateInfo],
) -> DocumentLine {
    let tax_amounts = records(line.get("tax_amounts"));
    let discounts: f64 = records(line.get("discount_amounts"))
        .iter()
        .map(|row| num(row.get("amount")).unwrap_or(0.0))
        .sum();
    let net_minor = if tax_amounts.is_empty() {
        num(line.get("amount_excluding_tax"))
            .or_else(|| num(line.get("amount")))
            .unwrap_or(0.0)
            - discounts
    } else {
        num(tax_amounts[0].get("taxable_amount")).unwrap_or(0.0)
    };
    let tax_minor: f64 = tax_amounts
        .iter()
        .map(|row| num(row.get("amount")).unwrap_or(0.0))
        .sum();
    let percentage = (!tax_amounts.is_empty()).then(|| {
        tax_amounts
            .iter()
            .map(|row| {
                let id = id_of(row.get("tax_rate")).unwrap_or_default();
                rates
                    .iter()
                    .find(|r| r.id == id)
                    .map_or(0.0, |r| r.percentage)
            })
            .sum::<f64>()
    });
    let quantity = num(line.get("quantity")).unwrap_or(1.0);
    let net = weldsuite_kit::validation::js_number(&money(net_minor, currency));
    let price = record(line.get("price"));
    let description = text(line.get("description"), Some(2000))
        .or_else(|| text(price.and_then(|p| p.get("nickname")), Some(2000)))
        .unwrap_or_else(|| "Item".to_owned());
    DocumentLine {
        external_product_id: None,
        description,
        quantity: number_text(if quantity == 0.0 { 1.0 } else { quantity }),
        unit_price: to_fixed(if quantity == 0.0 { net } else { net / quantity }, 4),
        tax_rate: percentage.map(number_text),
        tax_amount: Some(money(tax_minor, currency)),
        line_total: Some(money(net_minor, currency)),
        line_total_with_tax: Some(money(net_minor + tax_minor, currency)),
        sort_order: index,
        period: line_period(line),
    }
}

fn invoice_status(invoice: &Value, now_ms: f64) -> Option<&'static str> {
    match s(invoice.get("status")).as_deref() {
        Some("paid") => Some("paid"),
        Some("void") => Some("cancelled"),
        Some("uncollectible") => Some("uncollectible"),
        Some("open") => {
            if num(invoice.get("amount_paid")).unwrap_or(0.0) > 0.0 {
                return Some("partial");
            }
            let due = num(invoice.get("due_date")).map(|s| s * 1000.0);
            Some(if due.is_some_and(|d| d < now_ms) {
                "overdue"
            } else {
                "sent"
            })
        }
        _ => None,
    }
}

/// `mapStripeInvoice(record, externalId)`: drafts and invoices before the
/// start date (`_weld_skip`) map to nothing.
fn map_invoice(record: &Value, external_id: &str) -> Option<Mapped> {
    if record.get("_weld_skip") == Some(&Value::Bool(true)) {
        return None;
    }
    let now_ms = crate::js::now_ms();
    let status = invoice_status(record, now_ms)?;
    let number = text(record.get("number"), Some(50))?;
    let currency = s(record.get("currency"))
        .unwrap_or_else(|| "eur".to_owned())
        .to_lowercase();
    let transitions = record.get("status_transitions").filter(|t| t.is_object());
    let issue = date_from_unix(transitions.and_then(|t| t.get("finalized_at")))
        .or_else(|| date_from_unix(record.get("created")))
        .unwrap_or_else(crate::js::now_iso);
    let due = date_from_unix(record.get("due_date")).unwrap_or_else(|| issue.clone());
    let paid_at = (status == "paid").then(|| {
        date_from_unix(transitions.and_then(|t| t.get("paid_at"))).unwrap_or_else(|| issue.clone())
    });
    let rates = invoice_tax_rates(record);
    let lines: Vec<DocumentLine> = records(
        record
            .get("lines")
            .filter(|l| l.is_object())
            .and_then(|l| l.get("data")),
    )
    .iter()
    .enumerate()
    .map(|(i, line)| map_invoice_line(line, i, &currency, &rates))
    .collect();
    let discount: f64 = records(record.get("total_discount_amounts"))
        .iter()
        .map(|row| num(row.get("amount")).unwrap_or(0.0))
        .sum();
    let tax = num(record.get("tax")).unwrap_or_else(|| {
        records(record.get("total_tax_amounts"))
            .iter()
            .map(|row| num(row.get("amount")).unwrap_or(0.0))
            .sum()
    });
    let total = num(record.get("total")).unwrap_or(0.0);
    let subtotal = num(record.get("subtotal_excluding_tax"))
        .or_else(|| num(record.get("subtotal")))
        .unwrap_or(total - tax);
    let customer = customer_snapshot(record);
    let values = compact(vec![
        ("invoiceNumber", json!(number)),
        ("type", json!("standard")),
        ("status", json!(status)),
        (
            "contactName",
            opt(text(record.get("customer_name"), Some(255))
                .or_else(|| text(record.get("customer_email"), Some(255)))),
        ),
        (
            "contactEmail",
            opt(text(record.get("customer_email"), Some(255))),
        ),
        (
            "contactTaxNumber",
            opt(primary_tax_id(record.get("customer_tax_ids"))),
        ),
        (
            "billingAddress",
            stripe_address(record.get("customer_address")),
        ),
        ("issueDate", json!(issue)),
        ("dueDate", json!(due)),
        ("paidAt", opt(paid_at)),
        ("sentAt", json!(issue)),
        ("currency", json!(currency.to_uppercase())),
        ("subtotal", json!(money(subtotal, &currency))),
        ("discountTotal", json!(money(discount, &currency))),
        ("taxTotal", json!(money(tax, &currency))),
        ("total", json!(money(total, &currency))),
        (
            "amountPaid",
            json!(money(
                num(record.get("amount_paid")).unwrap_or(0.0),
                &currency
            )),
        ),
        (
            "balanceDue",
            json!(if status == "cancelled" {
                "0.00".to_owned()
            } else {
                money(
                    num(record.get("amount_remaining")).unwrap_or(0.0),
                    &currency,
                )
            }),
        ),
        ("reference", opt(text(record.get("id"), Some(255)))),
        ("notes", opt(s(record.get("description")))),
        (
            "paymentLink",
            opt(text(record.get("hosted_invoice_url"), Some(500))),
        ),
        ("taxBreakdown", tax_breakdown(record, &rates)),
        ("journalEntryId", Value::Null),
    ]);
    Some(Mapped::Document {
        entity: "invoice",
        external_id: external_id.to_owned(),
        contact_external_id: customer.as_ref().map(|c| crate::clients::as_text(&c["id"])),
        nested_contact: customer,
        values,
        line_items: lines,
    })
}

fn map_balance(record: &Value, external_id: &str) -> Option<Mapped> {
    let currency = s(record.get("currency"))?.to_uppercase();
    let balance =
        num(record.get("available")).unwrap_or(0.0) + num(record.get("pending")).unwrap_or(0.0);
    Some(Mapped::BankAccount {
        external_id: external_id.to_owned(),
        values: compact(vec![
            ("name", json!(format!("Stripe balance ({currency})"))),
            ("currency", json!(currency)),
            ("bankName", json!("Stripe")),
            ("currentBalance", json!(money(balance, &currency))),
            ("isActive", json!(true)),
            ("autoReconcile", json!(false)),
            (
                "metadata",
                json!({ "stripeBalance": true, "stripeAccountId": s(record.get("account_id")) }),
            ),
        ]),
    })
}

/// `mapStripeLine(record, externalId)`: a charge, its fee, another movement
/// or the payout itself.
fn map_line(record: &Value, external_id: &str) -> Option<Mapped> {
    let currency = s(record.get("currency"))
        .unwrap_or_else(|| "EUR".to_owned())
        .to_uppercase();
    let amount = num(record.get("amount"))?;
    let date = date_from_iso(record.get("created"))?;
    let line = s(record.get("line")).unwrap_or_else(|| "gross".to_owned());
    let kind = s(record.get("type")).unwrap_or_else(|| "adjustment".to_owned());
    let reference = text(record.get("source_id"), Some(255));
    let description = s(record.get("description")).unwrap_or_else(|| {
        if line == "payout" {
            weldsuite_kit::validation::js_trim(&format!(
                "Stripe payout {}",
                s(record.get("payout_id")).unwrap_or_default()
            ))
            .to_owned()
        } else {
            format!("Stripe {kind}")
        }
    });
    let raw = compact(vec![
        ("stripeLine", json!(line)),
        ("type", json!(kind)),
        ("payoutId", opt(s(record.get("payout_id")))),
        (
            "payoutArrivalDate",
            opt(s(record.get("payout_arrival_date"))),
        ),
        (
            "balanceTransactionId",
            opt(s(record.get("balance_transaction_id"))),
        ),
        ("chargeId", opt(s(record.get("charge_id")))),
        ("invoiceId", opt(s(record.get("invoice_id")))),
        ("sourceId", opt(reference.clone())),
        (
            "reportingCategory",
            opt(s(record.get("reporting_category"))),
        ),
        ("currency", json!(currency)),
    ]);
    let counterparty = if line == "gross" {
        text(record.get("customer_name"), Some(255)).unwrap_or_else(|| "Stripe".to_owned())
    } else {
        "Stripe".to_owned()
    };
    Some(Mapped::BankTransaction {
        external_id: external_id.to_owned(),
        financial_account_external_id: Some(
            s(record.get("balance_account")).unwrap_or_else(|| balance_account_id(&currency)),
        ),
        invoice_external_id: s(record.get("invoice_id")),
        values: compact(vec![
            ("date", json!(date)),
            (
                "valueDate",
                json!(date_from_iso(record.get("available_on")).unwrap_or_else(|| date.clone())),
            ),
            ("amount", json!(money(amount, &currency))),
            ("description", json!(description)),
            ("counterpartyName", json!(counterparty)),
            ("reference", opt(reference)),
            ("transactionCode", json!(slice_units(&kind, 20))),
            ("externalId", json!(external_id)),
            ("status", json!("unreconciled")),
            ("source", json!("import")),
            ("rawData", Value::Object(raw)),
        ]),
    })
}

/// `mapStripeRecord(entity, record, externalId)`.
pub fn map_stripe_record(entity: &str, record: &Value, external_id: &str) -> Option<Mapped> {
    match entity {
        "invoice" => map_invoice(record, external_id),
        "party" => map_customer(record, external_id),
        "bank_account" => map_balance(record, external_id),
        "bank_transaction" => map_line(record, external_id),
        _ => None,
    }
}
