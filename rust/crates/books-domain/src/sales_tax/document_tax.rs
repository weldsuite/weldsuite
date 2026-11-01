//! Sales tax for one US document (`services/sales-tax/document-tax.ts`): the
//! types the document routes and [`crate::tax`] pass around, and the pieces
//! they need on every entity (is this a sales tax entity, the totals without
//! tax, which invoice line a credit line credits).
//!
//! **Boundary with the sales-tax area.** The engine calls,
//! [`calculate_us_document_tax`] and [`accrue_use_tax`], belong to the
//! sales-tax area (`books_domain::sales_tax`, PORTING.md): it replaces their
//! bodies with the port of `calculateUsDocumentTax` / `accrueUseTax` (the
//! manual engine, Avalara, Stripe Tax) and keeps these signatures, which the
//! sales and purchases routes already call. Until then a US document's tax
//! is "engine unavailable": a draft is saved untaxed and flagged, and
//! finalizing refuses (`TAX_ENGINE_UNAVAILABLE`), exactly as on Global when
//! the engine is down; it never becomes zero tax.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};
use weldsuite_db::{Keyring, PgPool};
use weldsuite_ports::OutboundHttp;

use super::errors::{EngineError, SalesTaxError};
use super::{from_cents, to_cents};
use crate::address::normalize_postal_address;
use crate::js;
use crate::tax::TaxError;

/// `DEFAULT_WELD_TAX_CODE` (`jurisdictions/us/tax-codes`).
pub const DEFAULT_WELD_TAX_CODE: &str = "general";

/// `UsDocumentKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentKind {
    Invoice,
    Estimate,
    CreditMemo,
    Bill,
}

impl DocumentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invoice => "invoice",
            Self::Estimate => "estimate",
            Self::CreditMemo => "credit_memo",
            Self::Bill => "bill",
        }
    }
}

/// `UsDocumentContext`: the document a calculation is for (also what the
/// document tax hook of Brazil reads: addresses, contact, date, fiscal data).
#[derive(Debug, Clone)]
pub struct DocumentContext {
    pub kind: DocumentKind,
    pub document_id: Option<String>,
    pub document_number: Option<String>,
    pub contact_id: Option<String>,
    /// `issueDate`: an instant (`toISOString()`) or a `yyyy-mm-dd` day, as
    /// the caller had it (a `Date` or a string).
    pub issue_date: IssueDate,
    pub currency: Option<String>,
    pub billing_address: Option<Value>,
    pub shipping_address: Option<Value>,
    /// Bills: where the goods were delivered.
    pub delivery_address: Option<Value>,
    pub ship_from_address: Option<Value>,
    pub marketplace_facilitated: Option<bool>,
    /// Brazil: the document's fiscal fields.
    pub fiscal_data: Option<Value>,
    /// Credit memos: the invoice credited.
    pub original_invoice_id: Option<String>,
}

/// A document date as TypeScript holds it: a `Date` (its `toISOString()`)
/// or a string as given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IssueDate {
    Instant(String),
    Text(String),
}

impl IssueDate {
    /// `toDay(value)` / `.toISOString().slice(0, 10)`: the first ten
    /// characters either way.
    pub fn day(&self) -> String {
        let text = match self {
            Self::Instant(iso) | Self::Text(iso) => iso,
        };
        text.chars().take(10).collect()
    }
}

/// `UsTaxItemInput`.
#[derive(Debug, Clone, Default)]
pub struct TaxItem {
    pub id: String,
    pub description: Option<String>,
    pub quantity: Option<String>,
    pub unit_price: String,
    pub discount_percent: Option<String>,
    pub sort_order: Option<f64>,
    pub product_id: Option<String>,
    pub tax_code: Option<String>,
    pub tax_use: Option<String>,
    pub tax_included: Option<bool>,
    pub tax_override_amount: Option<String>,
    pub tax_override_reason: Option<String>,
    pub accrue_use_tax: Option<bool>,
    pub original_line_id: Option<String>,
}

/// `UsProcessedItem`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProcessedItem {
    pub id: String,
    pub line_total: String,
    pub line_total_with_tax: String,
    pub tax_amount: String,
    /// The combined rate of the taxed part (`"8.2500"`).
    pub tax_rate: Option<String>,
    pub tax_code: String,
    pub overridden: bool,
}

/// `UsTaxMeta`: which engine answered, with its warnings.
#[derive(Debug, Clone, PartialEq)]
pub struct TaxMeta {
    pub engine: String,
    pub engine_ref: Option<String>,
    /// `calculatedAt`, `toISOString()`.
    pub calculated_at: String,
    pub warnings: Vec<String>,
    pub marketplace_facilitated: bool,
    pub ship_to_state: Option<String>,
    pub ship_to_postal_code: Option<String>,
    /// Needs tax but has no ship-to (or bill-to) state and ZIP.
    pub address_incomplete: bool,
    /// Credit memos: the original line each credit line reverses.
    pub original_line_ids: Option<Map<String, Value>>,
}

/// `UsDocumentTaxCalculation`.
#[derive(Debug, Clone, PartialEq)]
pub struct Calculation {
    pub subtotal: String,
    pub discount_total: String,
    pub tax_total: String,
    pub total: String,
    pub balance_due: String,
    pub tax_breakdown: Vec<Value>,
    pub processed_items: Vec<ProcessedItem>,
    pub sales_tax: TaxMeta,
}

/// `SalesTaxEntityInfo`.
#[derive(Debug, Clone, PartialEq)]
pub struct SalesTaxEntity {
    pub id: String,
    pub jurisdiction_code: String,
    pub base_currency: Option<String>,
    /// Normalized (`normalizePostalAddress`).
    pub address: Option<Value>,
}

/// `SalesTaxRuntime`: the keys that open the entity's stored engine
/// credentials, and the outbound HTTP the provider engines call.
#[derive(Debug, Clone, Default)]
pub struct Runtime {
    pub keyring: Keyring,
    pub http: Option<OutboundHttp>,
}

/// `loadSalesTaxEntity(db, entityId)`.
pub async fn load_sales_tax_entity(
    db: &PgPool,
    entity_id: &str,
) -> Result<Option<SalesTaxEntity>, sqlx::Error> {
    let row: Option<(String, String, Option<String>, Option<Value>)> = sqlx::query_as(
        "select id, jurisdiction_code, base_currency, address from entities \
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(
        |(id, jurisdiction_code, base_currency, address)| SalesTaxEntity {
            id,
            jurisdiction_code,
            base_currency,
            address: normalize_postal_address(address.as_ref()),
        },
    ))
}

/// `usesSalesTax(entity)`: the entity's jurisdiction uses the sales tax
/// engine (the US).
pub fn uses_sales_tax(entity: Option<&SalesTaxEntity>) -> bool {
    entity.is_some_and(|e| uses_sales_tax_code(&e.jurisdiction_code))
}

/// `hasAdapter(code) && getAdapter(code).features.salesTax`.
pub fn uses_sales_tax_code(jurisdiction_code: &str) -> bool {
    crate::jurisdictions::has_adapter(jurisdiction_code)
        && crate::jurisdictions::features(Some(jurisdiction_code))["salesTax"].as_bool()
            == Some(true)
}

/// `num(value, fallback)`: empty and unparsable are the fallback.
fn num(value: Option<&str>, fallback: f64) -> f64 {
    match value {
        None | Some("") => fallback,
        Some(text) => {
            let parsed = js::parse_float(text);
            if parsed.is_finite() { parsed } else { fallback }
        }
    }
}

/// `roundCents(value)`: `Math.round((value + Number.EPSILON) * 100) / 100`.
fn round_cents(value: f64) -> f64 {
    js::round_money(value)
}

/// `lineAmounts(item)`.
struct LineAmounts {
    amount: f64,
    discount: f64,
}

fn line_amounts(item: &TaxItem) -> LineAmounts {
    let quantity = num(item.quantity.as_deref(), 1.0);
    let gross = quantity * num(Some(&item.unit_price), 0.0);
    let discount = gross * (num(item.discount_percent.as_deref(), 0.0) / 100.0);
    LineAmounts {
        amount: round_cents(gross - discount),
        discount,
    }
}

/// The totals of `untaxedTotals`.
#[derive(Debug, Clone, PartialEq)]
pub struct Untaxed {
    pub subtotal: String,
    pub discount_total: String,
    pub tax_total: String,
    pub total: String,
    pub balance_due: String,
    pub processed_items: Vec<ProcessedItem>,
}

/// `untaxedTotals(items)`: what a draft shows while its engine can't answer.
pub fn untaxed_totals(items: &[TaxItem]) -> Untaxed {
    // `new Map(items.map(...))`: a repeated id keeps the last line's amounts.
    let mut amounts: HashMap<&str, LineAmounts> = HashMap::new();
    for item in items {
        amounts.insert(item.id.as_str(), line_amounts(item));
    }
    let mut subtotal = 0i64;
    let mut discount_total = 0i64;
    for item in items {
        let a = &amounts[item.id.as_str()];
        subtotal += to_cents(a.amount);
        discount_total += to_cents(a.discount);
    }
    let processed_items = items
        .iter()
        .map(|item| {
            let amount = js::to_fixed(amounts[item.id.as_str()].amount, 2);
            ProcessedItem {
                id: item.id.clone(),
                line_total: amount.clone(),
                line_total_with_tax: amount,
                tax_amount: "0.00".into(),
                tax_rate: None,
                tax_code: DEFAULT_WELD_TAX_CODE.into(),
                overridden: false,
            }
        })
        .collect();
    Untaxed {
        subtotal: js::to_fixed(from_cents(subtotal), 2),
        discount_total: js::to_fixed(from_cents(discount_total), 2),
        tax_total: js::to_fixed(from_cents(0), 2),
        total: js::to_fixed(from_cents(subtotal), 2),
        balance_due: js::to_fixed(from_cents(subtotal), 2),
        processed_items,
    }
}

/// A credit memo line, for [`map_credit_items_to_original`].
#[derive(Debug, Clone)]
pub struct CreditLine<'a> {
    pub id: &'a str,
    pub description: Option<&'a str>,
    pub unit_price: &'a str,
    pub sort_order: Option<f64>,
    pub original_line_id: Option<&'a str>,
}

/// An invoice line, for [`map_credit_items_to_original`].
#[derive(Debug, Clone)]
pub struct OriginalLine<'a> {
    pub id: &'a str,
    pub description: Option<&'a str>,
    pub unit_price: &'a str,
    pub sort_order: Option<f64>,
}

/// `mapCreditItemsToOriginal(creditItems, originalItems)`: the invoice line
/// each credit line credits: the one it names, else by description (then
/// price and position), each original line taken once where possible.
pub fn map_credit_items_to_original(
    credit_items: &[CreditLine<'_>],
    original_items: &[OriginalLine<'_>],
) -> Vec<(String, Option<String>)> {
    let mut taken: HashSet<&str> = HashSet::new();
    let mut mapping: Vec<(String, Option<String>)> = Vec::new();
    let original_ids: HashSet<&str> = original_items.iter().map(|o| o.id).collect();
    let mapped = |mapping: &Vec<(String, Option<String>)>, id: &str| {
        mapping.iter().any(|(credit, _)| credit == id)
    };
    for credit in credit_items {
        if let Some(original) = credit.original_line_id.filter(|o| original_ids.contains(o)) {
            set(&mut mapping, credit.id, Some(original.to_owned()));
            taken.insert(original);
        }
    }
    let trim =
        |text: Option<&str>| crate::jurisdictions::js_trim(text.unwrap_or_default()).to_owned();
    for credit in credit_items {
        if mapped(&mapping, credit.id) {
            continue;
        }
        let text = trim(credit.description);
        let same_text: Vec<&OriginalLine<'_>> = original_items
            .iter()
            .filter(|o| trim(o.description) == text)
            .collect();
        let sort = credit.sort_order;
        let free = |o: &&&OriginalLine<'_>| !taken.contains(o.id);
        let pick = same_text
            .iter()
            .find(|o| free(o) && o.unit_price == credit.unit_price && o.sort_order == sort)
            .or_else(|| same_text.iter().find(|o| free(o) && o.sort_order == sort))
            .or_else(|| {
                same_text
                    .iter()
                    .find(|o| free(o) && o.unit_price == credit.unit_price)
            })
            .or_else(|| same_text.iter().find(|o| free(o)))
            .or_else(|| same_text.first())
            .map(|o| o.id);
        set(&mut mapping, credit.id, pick.map(str::to_owned));
        if let Some(pick) = pick {
            taken.insert(pick);
        }
    }
    mapping
}

/// `Map.set`: a repeated key keeps its first position.
fn set(mapping: &mut Vec<(String, Option<String>)>, key: &str, value: Option<String>) {
    if let Some(entry) = mapping.iter_mut().find(|(k, _)| k == key) {
        entry.1 = value;
    } else {
        mapping.push((key.to_owned(), value));
    }
}

/// The engine is not ported yet (see the module docs).
fn engine_not_ported() -> TaxError {
    TaxError::SalesTax(SalesTaxError::Engine(EngineError {
        message: "the US sales tax engine is not available in this edition yet".into(),
        code: "not_configured",
        retryable: false,
    }))
}

/// `calculateUsDocumentTax(db, { entity, doc, items, runtime })`: a sale
/// (invoice, estimate) through the entity's engine, a credit memo at its
/// invoice's rates. **Sales-tax area**: replace the body with the engine.
#[allow(
    clippy::unused_async,
    reason = "the engine port awaits; the signature is the boundary"
)]
pub async fn calculate_us_document_tax(
    _db: &PgPool,
    _entity: &SalesTaxEntity,
    _doc: &DocumentContext,
    _items: &[TaxItem],
    _runtime: Option<&Runtime>,
) -> Result<Calculation, TaxError> {
    Err(engine_not_ported())
}

/// `UseTaxAccrual`: the use tax rows of a US bill.
#[derive(Debug, Clone, PartialEq)]
pub struct UseTaxAccrual {
    pub rows: Vec<Value>,
    pub engine: String,
    pub engine_ref: Option<String>,
    pub warnings: Vec<String>,
}

/// `accrueUseTax(db, entity, doc, items, lineNets, runtime)`: use tax on the
/// bill lines marked to accrue it; `None` when nothing accrues.
/// **Sales-tax area**: replace the body with the engine.
#[allow(
    clippy::unused_async,
    clippy::implicit_hasher,
    reason = "the engine port awaits; the signature is the boundary"
)]
pub async fn accrue_use_tax(
    _db: &PgPool,
    _entity: &SalesTaxEntity,
    _doc: &DocumentContext,
    _items: &[TaxItem],
    _line_nets: &HashMap<String, f64>,
    _runtime: Option<&Runtime>,
) -> Result<Option<UseTaxAccrual>, TaxError> {
    Err(engine_not_ported())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, quantity: &str, price: &str, discount: &str) -> TaxItem {
        TaxItem {
            id: id.into(),
            quantity: Some(quantity.into()),
            unit_price: price.into(),
            discount_percent: Some(discount.into()),
            ..TaxItem::default()
        }
    }

    #[test]
    fn untaxed_totals_add_whole_cents() {
        let totals = untaxed_totals(&[item("a", "3", "33.33", "0"), item("b", "", "10", "10")]);
        assert_eq!(totals.subtotal, "108.99");
        assert_eq!(totals.discount_total, "1.00");
        assert_eq!(totals.tax_total, "0.00");
        assert_eq!(totals.processed_items[1].line_total, "9.00");
        assert_eq!(totals.processed_items[0].tax_code, "general");
    }

    #[test]
    fn credit_lines_find_their_invoice_lines() {
        let originals = [
            OriginalLine {
                id: "o1",
                description: Some("Hours"),
                unit_price: "50.00",
                sort_order: Some(0.0),
            },
            OriginalLine {
                id: "o2",
                description: Some("Hours"),
                unit_price: "60.00",
                sort_order: Some(1.0),
            },
            OriginalLine {
                id: "o3",
                description: Some("Travel"),
                unit_price: "10.00",
                sort_order: Some(2.0),
            },
        ];
        let credits = [
            CreditLine {
                id: "c1",
                description: Some(" Hours "),
                unit_price: "60.00",
                sort_order: Some(1.0),
                original_line_id: None,
            },
            CreditLine {
                id: "c2",
                description: Some("Hours"),
                unit_price: "1.00",
                sort_order: None,
                original_line_id: None,
            },
            CreditLine {
                id: "c3",
                description: Some("Other"),
                unit_price: "1.00",
                sort_order: None,
                original_line_id: Some("o3"),
            },
            CreditLine {
                id: "c4",
                description: Some("Nothing"),
                unit_price: "1.00",
                sort_order: None,
                original_line_id: None,
            },
        ];
        let mapping = map_credit_items_to_original(&credits, &originals);
        let of = |id: &str| {
            mapping
                .iter()
                .find(|(c, _)| c == id)
                .and_then(|(_, o)| o.clone())
        };
        assert_eq!(of("c1").as_deref(), Some("o2"));
        assert_eq!(of("c2").as_deref(), Some("o1"));
        assert_eq!(of("c3").as_deref(), Some("o3"));
        assert_eq!(of("c4"), None);
    }
}
