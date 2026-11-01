//! `POST /from-order/:orderId`: a draft invoice from a commerce order. A US
//! entity's engine taxes the order's lines (`services/sales-tax/order-invoice`);
//! elsewhere each line's rate is rebuilt from the order's amounts and linked
//! to the entity's own matching sales rate.

use axum::extract::{Path, State};
use axum::response::Response;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::address::normalize_postal_address;
use weldsuite_books_domain::books_row;
use weldsuite_books_domain::entity_context::{
    SequenceType, next_entity_number, resolve_entity_base_currency, resolve_entity_id,
};
use weldsuite_books_domain::fx::{RateQuery, draft_rate};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, created, now, reply};
use weldsuite_books_domain::js;
use weldsuite_books_domain::roles::{PromoteTo, promote_accounting_role};
use weldsuite_books_domain::sales_tax::document_tax::{
    DocumentContext, DocumentKind, IssueDate, load_sales_tax_entity, uses_sales_tax,
};
use weldsuite_books_domain::sales_tax::{allocate_cents, from_cents, to_cents};
use weldsuite_books_domain::tables::{INVOICE_ITEMS, INVOICES, ORDER_ITEMS, ORDERS};
use weldsuite_books_domain::tax::{
    DocumentTaxItem, SupplyArgs, TaxArgs, calculate_document_tax, resolve_gst_supply,
};
use weldsuite_catalogs::entity_events::INVOICE_CREATED;
use weldsuite_kit::generate_id;

use super::write::{runtime, tax_address};
use crate::errors::SalesError;
use crate::persist::{
    calculate_draft_tax, engine_unavailable_warning, invoice_tax_columns, item_tax_columns, text,
};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// `WELD_TAX_CODES` (`jurisdictions/us/tax-codes`).
const WELD_TAX_CODES: [&str; 12] = [
    "general",
    "saas",
    "digital_goods",
    "services",
    "professional_services",
    "shipping",
    "handling",
    "food_grocery",
    "prepared_food",
    "clothing",
    "prescription_drugs",
    "non_taxable",
];

/// `money(value)`.
fn money(value: Option<&str>) -> f64 {
    let parsed = js::parse_float(value.unwrap_or("0"));
    if parsed.is_finite() { parsed } else { 0.0 }
}

/// A line of `orderInvoiceLines`.
struct OrderLine {
    description: String,
    quantity: String,
    unit_price: String,
    discount_percent: String,
    product_id: Option<String>,
    tax_code: Option<String>,
    tax_rate: Option<String>,
}

struct Gross<'a> {
    item: &'a Value,
    quantity: i64,
    own: i64,
    cents: i64,
}

/// `orderInvoiceLines(db, order, items)`: the order's lines at their
/// discounted prices with their tax codes, and shipping as its own line.
#[allow(clippy::too_many_lines, reason = "orderInvoiceLines as written")]
async fn order_invoice_lines(
    db: &weldsuite_db::PgPool,
    order: &Value,
    items: &[Value],
) -> Result<Vec<OrderLine>, sqlx::Error> {
    let mut product_ids: Vec<String> = Vec::new();
    for item in items {
        if let Some(id) = text(item, "productId").filter(|id| !id.is_empty())
            && !product_ids.iter().any(|p| p == id)
        {
            product_ids.push(id.to_owned());
        }
    }
    let products: Vec<(String, Option<bool>, Option<String>)> = if product_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("select id, taxable, tax_class from products where id = any($1)")
            .bind(&product_ids)
            .fetch_all(db)
            .await?
    };
    let mut from_order: Vec<(String, String)> = Vec::new();
    if let Some(lines) = order["metadata"]["salesTax"]["lines"].as_array() {
        for line in lines {
            if let (Some(id), Some(code)) = (
                line["lineId"].as_str().filter(|s| !s.is_empty()),
                line["taxCode"].as_str().filter(|s| !s.is_empty()),
            ) {
                from_order.retain(|(l, _)| l != id);
                from_order.push((id.to_owned(), code.to_owned()));
            }
        }
    }
    let gross: Vec<Gross<'_>> = items
        .iter()
        .map(|item| {
            let raw = item["quantity"].as_i64().unwrap_or(0);
            let quantity = if raw > 0 { raw } else { 1 };
            let own = to_cents(money(text(item, "discountAmount")));
            #[allow(clippy::cast_precision_loss)]
            let cents = (to_cents(money(text(item, "unitPrice")) * quantity as f64) - own).max(0);
            Gross {
                item,
                quantity,
                own,
                cents,
            }
        })
        .collect();
    let item_discounts: i64 = gross.iter().map(|g| g.own).sum();
    let order_discount = (to_cents(money(text(order, "discountTotal"))) - item_discounts).max(0);
    let base: i64 = gross.iter().map(|g| g.cents).sum();
    #[allow(clippy::cast_precision_loss)]
    let shares = if order_discount > 0 && base > 0 {
        allocate_cents(
            order_discount.min(base),
            &gross.iter().map(|g| g.cents as f64).collect::<Vec<_>>(),
        )
    } else {
        Vec::new()
    };
    let mut lines: Vec<OrderLine> = gross
        .iter()
        .enumerate()
        .map(|(i, g)| {
            let cents = (g.cents - shares.get(i).copied().unwrap_or(0)).max(0);
            let product_id = text(g.item, "productId").map(str::to_owned);
            let product = product_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .and_then(|id| products.iter().find(|(p, _, _)| p == id));
            let own_code = from_order
                .iter()
                .find(|(line, _)| Some(line.as_str()) == text(g.item, "id"))
                .map(|(_, code)| code.clone());
            let tax_code = own_code.unwrap_or_else(|| match product {
                Some((_, Some(false), _)) => "non_taxable".to_owned(),
                Some((_, _, Some(class))) if !class.is_empty() => {
                    if WELD_TAX_CODES.contains(&class.as_str()) {
                        class.clone()
                    } else {
                        "general".to_owned()
                    }
                }
                _ => "general".to_owned(),
            });
            let description = text(g.item, "description").filter(|d| !d.is_empty());
            let name = format!(
                "{}{}",
                text(g.item, "name").unwrap_or_default(),
                description.map(|d| format!(" - {d}")).unwrap_or_default()
            );
            #[allow(clippy::cast_precision_loss)]
            let unit = js::math_round(from_cents(cents) / g.quantity as f64 * 10_000.0) / 10_000.0;
            #[allow(clippy::cast_precision_loss)]
            let exact = to_cents(unit * g.quantity as f64) == cents;
            if exact {
                OrderLine {
                    description: name,
                    quantity: g.quantity.to_string(),
                    unit_price: js::to_fixed(unit, 4),
                    discount_percent: "0".into(),
                    product_id,
                    tax_code: Some(tax_code),
                    tax_rate: None,
                }
            } else {
                OrderLine {
                    description: format!(
                        "{name} ({} x {})",
                        g.quantity,
                        js::to_fixed(money(text(g.item, "unitPrice")), 2)
                    ),
                    quantity: "1".into(),
                    unit_price: js::to_fixed(from_cents(cents), 2),
                    discount_percent: "0".into(),
                    product_id,
                    tax_code: Some(tax_code),
                    tax_rate: None,
                }
            }
        })
        .collect();
    let shipping = to_cents(money(text(order, "shippingTotal")));
    if shipping > 0 {
        lines.push(OrderLine {
            description: "Shipping".into(),
            quantity: "1".into(),
            unit_price: js::to_fixed(from_cents(shipping), 2),
            discount_percent: "0".into(),
            product_id: None,
            tax_code: Some("shipping".into()),
            tax_rate: None,
        });
    }
    Ok(lines)
}

/// The lines of a non-US order: per-line rates rebuilt from the order's
/// absolute amounts.
fn rebuilt_lines(order: &Value, items: &[Value]) -> Vec<OrderLine> {
    let mut lines: Vec<OrderLine> = items
        .iter()
        .map(|item| {
            let qty = item["quantity"].as_i64().filter(|q| *q != 0).unwrap_or(1);
            let price = js::parse_float(
                text(item, "unitPrice")
                    .filter(|p| !p.is_empty())
                    .unwrap_or("0"),
            );
            #[allow(clippy::cast_precision_loss)]
            let gross = qty as f64 * price;
            let discount = js::parse_float(
                text(item, "discountAmount")
                    .filter(|p| !p.is_empty())
                    .unwrap_or("0"),
            );
            let net = gross - discount;
            let tax = js::parse_float(
                text(item, "taxAmount")
                    .filter(|p| !p.is_empty())
                    .unwrap_or("0"),
            );
            let discount_percent = if gross > 0.0 {
                js::to_fixed(discount / gross * 100.0, 2)
            } else {
                "0".into()
            };
            let tax_rate = if net > 0.0 && tax > 0.0 {
                js::to_fixed(tax / net * 100.0, 2)
            } else {
                "0".into()
            };
            let description = text(item, "description").filter(|d| !d.is_empty());
            OrderLine {
                description: format!(
                    "{}{}",
                    text(item, "name").unwrap_or_default(),
                    description.map(|d| format!(" — {d}")).unwrap_or_default()
                ),
                quantity: qty.to_string(),
                unit_price: text(item, "unitPrice")
                    .filter(|p| !p.is_empty())
                    .unwrap_or("0")
                    .to_owned(),
                discount_percent,
                product_id: text(item, "productId").map(str::to_owned),
                tax_code: None,
                tax_rate: Some(tax_rate),
            }
        })
        .collect();
    let shipping = js::parse_float(
        text(order, "shippingTotal")
            .filter(|s| !s.is_empty())
            .unwrap_or("0"),
    );
    if shipping > 0.0 {
        lines.push(OrderLine {
            description: "Shipping".into(),
            quantity: "1".into(),
            unit_price: js::to_fixed(shipping, 2),
            discount_percent: "0".into(),
            product_id: None,
            tax_code: None,
            tax_rate: Some("0".into()),
        });
    }
    lines
}

pub(crate) async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    Path(order_id): Path<String>,
) -> Response {
    reply(
        from_order(&caller, &state, &order_id)
            .await
            .map_err(Refusal::from),
        "Failed to create invoice from order",
    )
}

#[allow(
    clippy::too_many_lines,
    reason = "both of the route's branches, US and rate-table, in its order"
)]
async fn from_order(
    caller: &Caller,
    state: &BooksState,
    order_id: &str,
) -> Result<Response, SalesError> {
    let db = &caller.db;
    let order: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(orders),
        " from orders t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(order_id)
    .fetch_optional(db)
    .await?;
    let Some(order) = order.map(|o| ORDERS.js(o)) else {
        return Err(Refusal::not_found("Order", order_id).into());
    };
    let contact_id = text(&order, "counterpartyId")
        .filter(|c| !c.is_empty())
        .or_else(|| text(&order, "customerId").filter(|c| !c.is_empty()))
        .map(str::to_owned);
    let Some(contact_id) = contact_id else {
        return Err(Refusal::bad_request("Order has no customer to invoice").into());
    };
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved — set X-Accounting-Entity-Id or configure a default entity.").into());
    };
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(order_items),
        " from order_items t where t.order_id = $1"
    ))
    .bind(order_id)
    .fetch_all(db)
    .await?;
    let items = ORDER_ITEMS.js_rows(rows);
    if items.is_empty() {
        return Err(Refusal::bad_request("Order has no line items to invoice").into());
    }
    let us = uses_sales_tax(load_sales_tax_entity(db, &entity_id).await?.as_ref());
    let billing = normalize_postal_address(
        order
            .get("billingAddress")
            .filter(|v| !v.is_null())
            .or_else(|| order.get("shippingAddress")),
    );
    let shipping = normalize_postal_address(order.get("shippingAddress"));
    let (country, province) = tax_address(shipping.as_ref(), billing.as_ref());
    let http = caller.http(state);

    let invoice_number;
    let currency;
    let invoice_id;
    let lines;
    let calc;
    let mut failure = None;
    let mut place_of_supply = Value::Null;
    if us {
        lines = order_invoice_lines(db, &order, &items).await?;
        invoice_number = next_entity_number(db, &entity_id, SequenceType::Invoice)
            .await?
            .formatted;
        currency = match text(&order, "currency").filter(|c| !c.is_empty()) {
            Some(c) => c.to_owned(),
            None => resolve_entity_base_currency(db, &entity_id).await?,
        };
        invoice_id = generate_id("inv");
        let item_ids: Vec<String> = lines.iter().map(|_| generate_id("ili")).collect();
        let tax_items: Vec<DocumentTaxItem> = lines
            .iter()
            .enumerate()
            .map(|(idx, line)| DocumentTaxItem {
                id: Some(item_ids[idx].clone()),
                description: Some(line.description.clone()),
                quantity: Some(line.quantity.clone()),
                unit_price: line.unit_price.clone(),
                discount_percent: Some(line.discount_percent.clone()),
                product_id: line.product_id.clone(),
                tax_code: line.tax_code.clone(),
                #[allow(clippy::cast_precision_loss)]
                sort_order: Some(idx as f64),
                ..DocumentTaxItem::default()
            })
            .collect();
        let doc = DocumentContext {
            kind: DocumentKind::Invoice,
            document_id: Some(invoice_id.clone()),
            document_number: Some(invoice_number.clone()),
            contact_id: Some(contact_id.clone()),
            issue_date: IssueDate::Instant(now()),
            currency: Some(currency.clone()),
            billing_address: billing.clone(),
            shipping_address: shipping.clone(),
            delivery_address: None,
            ship_from_address: None,
            marketplace_facilitated: None,
            fiscal_data: None,
            original_invoice_id: None,
        };
        let rt = runtime(caller, state);
        let mut args = TaxArgs::new(
            &entity_id,
            weldsuite_books_domain::tax::Direction::Sales,
            &tax_items,
        );
        args.buyer_country = country.as_deref();
        args.billing_province = province.as_deref();
        args.document = Some(&doc);
        args.runtime = Some(&rt);
        let drafted = calculate_draft_tax(db, &args).await?;
        failure = drafted.failure;
        calc = drafted.calc;
        return finish(
            caller,
            state,
            &order,
            order_id,
            &entity_id,
            &contact_id,
            (&invoice_id, &invoice_number, &currency),
            &lines,
            Some(&item_ids),
            &calc,
            failure.as_deref(),
            place_of_supply,
            true,
        )
        .await;
    }

    lines = rebuilt_lines(&order, &items);
    // Link each derived percentage to the entity's own matching sales rate.
    let rates: Vec<(String, String, String)> = sqlx::query_as(
        "select id, rate::text, type from tax_rates \
         where entity_id = $1 and deleted_at is null and is_active = true",
    )
    .bind(&entity_id)
    .fetch_all(db)
    .await?;
    let rate_for = |percent: &str| {
        rates
            .iter()
            .find(|(_, rate, kind)| {
                kind != "purchase"
                    && (js::numeric_text(Some(rate)) - js::numeric_text(Some(percent))).abs() < 0.01
            })
            .map(|(id, _, _)| id.clone())
    };
    let tax_items: Vec<DocumentTaxItem> = lines
        .iter()
        .map(|line| DocumentTaxItem {
            description: Some(line.description.clone()),
            quantity: Some(line.quantity.clone()),
            unit_price: line.unit_price.clone(),
            discount_percent: Some(line.discount_percent.clone()),
            tax_rate: line.tax_rate.clone(),
            tax_rate_id: rate_for(line.tax_rate.as_deref().unwrap_or("0")),
            product_id: line.product_id.clone(),
            ..DocumentTaxItem::default()
        })
        .collect();
    let gst = resolve_gst_supply(
        db,
        SupplyArgs {
            entity_id: &entity_id,
            contact_id: Some(&contact_id),
            place_of_supply: None,
            shipping_address: shipping.as_ref(),
            billing_address: billing.as_ref(),
        },
    )
    .await?;
    let mut args = TaxArgs::new(
        &entity_id,
        weldsuite_books_domain::tax::Direction::Sales,
        &tax_items,
    );
    args.buyer_country = country.as_deref();
    args.billing_province = province.as_deref();
    let args = args.with_gst(gst.as_ref());
    calc = calculate_document_tax(db, &args).await?;
    invoice_number = next_entity_number(db, &entity_id, SequenceType::Invoice)
        .await?
        .formatted;
    currency = match text(&order, "currency").filter(|c| !c.is_empty()) {
        Some(c) => c.to_owned(),
        None => resolve_entity_base_currency(db, &entity_id).await?,
    };
    invoice_id = generate_id("inv");
    if let Some(gst) = &gst {
        place_of_supply = json!(gst.place_of_supply);
    }
    let _ = http;
    finish(
        caller,
        state,
        &order,
        order_id,
        &entity_id,
        &contact_id,
        (&invoice_id, &invoice_number, &currency),
        &lines,
        None,
        &calc,
        failure.as_deref(),
        place_of_supply,
        false,
    )
    .await
}

/// The invoice row, its lines, the audit row and the event of either branch.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
async fn finish(
    caller: &Caller,
    state: &BooksState,
    order: &Value,
    order_id: &str,
    entity_id: &str,
    contact_id: &str,
    (invoice_id, invoice_number, currency): (&str, &str, &str),
    lines: &[OrderLine],
    item_ids: Option<&Vec<String>>,
    calc: &weldsuite_books_domain::tax::CalculatedDocumentTax,
    failure: Option<&str>,
    place_of_supply: Value,
    us: bool,
) -> Result<Response, SalesError> {
    let db = &caller.db;
    let at = now();
    let at_ms = js::millis_of(&at).unwrap_or(0);
    let due = js::iso_from_millis(at_ms + 30 * DAY_MS).unwrap_or_else(|| at.clone());
    let base = resolve_entity_base_currency(db, entity_id).await?;
    let http = caller.http(state);
    let rate = draft_rate(
        db,
        http.as_ref(),
        RateQuery {
            base_currency: &base,
            currency,
            at_millis: at_ms,
            typed: None,
            use_feed: true,
        },
    )
    .await?;
    let or_null = |key: &str| match text(order, key).filter(|v| !v.is_empty()) {
        Some(value) => json!(value),
        None => Value::Null,
    };
    let mut invoice = Map::new();
    invoice.insert("id".into(), json!(invoice_id));
    invoice.insert("entityId".into(), json!(entity_id));
    invoice.insert("invoiceNumber".into(), json!(invoice_number));
    invoice.insert("type".into(), json!("standard"));
    invoice.insert("status".into(), json!("draft"));
    invoice.insert("contactId".into(), json!(contact_id));
    invoice.insert("contactName".into(), or_null("customerName"));
    invoice.insert("contactEmail".into(), or_null("customerEmail"));
    invoice.insert("issueDate".into(), json!(at));
    invoice.insert("dueDate".into(), json!(due));
    invoice.insert("currency".into(), json!(currency));
    invoice.insert("exchangeRate".into(), json!(rate));
    if us {
        invoice.extend(invoice_tax_columns(calc));
        if let Some(message) = failure {
            invoice.insert(
                "taxWarnings".into(),
                json!([engine_unavailable_warning(message)]),
            );
        }
    } else {
        invoice.insert("subtotal".into(), json!(calc.subtotal));
        invoice.insert("discountTotal".into(), json!(calc.discount_total));
        invoice.insert("taxTotal".into(), json!(calc.tax_total));
        invoice.insert("total".into(), json!(calc.total));
    }
    invoice.insert("amountPaid".into(), json!("0"));
    invoice.insert("balanceDue".into(), json!(calc.balance_due));
    invoice.insert("reference".into(), order["orderNumber"].clone());
    let billing = normalize_postal_address(
        order
            .get("billingAddress")
            .filter(|v| !v.is_null())
            .or_else(|| order.get("shippingAddress")),
    );
    invoice.insert("billingAddress".into(), json!(billing));
    invoice.insert(
        "shippingAddress".into(),
        json!(normalize_postal_address(order.get("shippingAddress"))),
    );
    if !us {
        invoice.insert("placeOfSupply".into(), place_of_supply);
    }
    invoice.insert("commerceOrderId".into(), json!(order_id));
    if !us {
        invoice.insert(
            "taxBreakdown".into(),
            Value::Array(calc.tax_breakdown.clone()),
        );
    }
    invoice.insert("createdBy".into(), json!(caller.user_id));
    invoice.insert("createdAt".into(), json!(at));
    invoice.insert("updatedAt".into(), json!(at));

    let records: Vec<Map<String, Value>> = lines
        .iter()
        .enumerate()
        .map(|(idx, line)| {
            let mut row = Map::new();
            row.insert(
                "id".into(),
                json!(item_ids.map_or_else(|| generate_id("ili"), |ids| ids[idx].clone())),
            );
            row.insert("entityId".into(), json!(entity_id));
            row.insert("invoiceId".into(), json!(invoice_id));
            row.insert("description".into(), json!(line.description));
            row.insert("quantity".into(), json!(line.quantity));
            row.insert("unitPrice".into(), json!(line.unit_price));
            row.insert("discountPercent".into(), json!(line.discount_percent));
            row.extend(item_tax_columns(calc, idx));
            if us {
                row.insert("productId".into(), json!(line.product_id));
                row.insert("taxCode".into(), json!(line.tax_code));
            } else {
                row.insert(
                    "productId".into(),
                    json!(line.product_id.as_ref().filter(|p| !p.is_empty())),
                );
            }
            #[allow(clippy::cast_possible_wrap)]
            row.insert("sortOrder".into(), json!(idx as i64));
            row.insert("createdAt".into(), json!(at));
            row.insert("updatedAt".into(), json!(at));
            row
        })
        .collect();
    let mut tx = db.begin().await?;
    INVOICES
        .insert_raw(&mut *tx, INVOICES.values(&invoice))
        .await?;
    for record in &records {
        INVOICE_ITEMS
            .insert_raw(&mut *tx, INVOICE_ITEMS.values(record))
            .await?;
    }
    tx.commit().await?;
    promote_accounting_role(db, contact_id, PromoteTo::Customer).await?;
    let mut changes = Map::new();
    changes.insert(
        "commerceOrderId".into(),
        change(Value::Null, json!(order_id)),
    );
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(entity_id),
            entity_type: "invoice",
            entity_id: invoice_id,
            action: "created",
            changes: Some(changes),
        },
    )
    .await;
    caller.publish(
        state,
        INVOICE_CREATED,
        invoice_id,
        json!({
            "id": invoice_id,
            "invoiceNumber": invoice_number,
            "status": "draft",
            "total": calc.total,
            "currency": currency,
            "contactId": contact_id,
            "issueDate": at,
            "dueDate": due,
        }),
    );
    if us {
        let warnings = invoice
            .get("taxWarnings")
            .cloned()
            .unwrap_or_else(|| json!([]));
        return Ok(created(json!({
            "invoiceId": invoice_id,
            "invoiceNumber": invoice_number,
            "taxTotal": calc.tax_total,
            "total": calc.total,
            "taxWarnings": warnings,
        })));
    }
    Ok(created(
        json!({ "invoiceId": invoice_id, "invoiceNumber": invoice_number }),
    ))
}
