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

// ---------------------------------------------------------------------------
// The engine path
// ---------------------------------------------------------------------------

impl From<LoadError> for TaxError {
    fn from(error: LoadError) -> Self {
        match error {
            LoadError::Engine(error) => Self::SalesTax(SalesTaxError::Engine(error)),
            LoadError::Database(error) => Self::Database(error),
        }
    }
}

impl From<EngineError> for TaxError {
    fn from(error: EngineError) -> Self {
        Self::SalesTax(SalesTaxError::Engine(error))
    }
}

impl From<DocumentError> for TaxError {
    fn from(error: DocumentError) -> Self {
        Self::SalesTax(SalesTaxError::Document(error))
    }
}

/// `useOf(value)`.
fn use_of(value: Option<&str>) -> Option<TaxUse> {
    TaxUse::parse(value)
}

/// `usableTaxCode(value)`: a WeldBooks code, or a provider's own code the
/// line carries on purpose; anything else is ignored.
fn usable_tax_code(value: Option<&str>) -> Option<String> {
    let code = crate::jurisdictions::js_trim(value?);
    if code.is_empty() {
        return None;
    }
    (is_weld_tax_code(code) || is_stripe_tax_code(code) || is_avalara_tax_code(code))
        .then(|| code.to_owned())
}

/// A product's tax fields.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProductTax {
    pub tax_class: Option<String>,
    pub taxable: Option<bool>,
}

/// `resolveLineTaxCode(lineCode, product)`: the line's own code, else
/// `non_taxable` for a product not marked taxable, else the product's tax
/// class, else `general`.
pub fn resolve_line_tax_code(line_code: Option<&str>, product: Option<&ProductTax>) -> String {
    usable_tax_code(line_code)
        .or_else(|| {
            (product.is_some_and(|p| p.taxable == Some(false))).then(|| "non_taxable".to_owned())
        })
        .or_else(|| usable_tax_code(product.and_then(|p| p.tax_class.as_deref())))
        .unwrap_or_else(|| DEFAULT_WELD_TAX_CODE.to_owned())
}

async fn load_products(
    db: &PgPool,
    items: &[TaxItem],
) -> Result<HashMap<String, ProductTax>, sqlx::Error> {
    let mut ids: Vec<String> = Vec::new();
    for id in items.iter().filter_map(|i| i.product_id.as_deref()) {
        if !id.is_empty() && !ids.iter().any(|x| x == id) {
            ids.push(id.to_owned());
        }
    }
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, Option<String>, Option<bool>)> =
        sqlx::query_as("select id, tax_class, taxable from products where id = any($1)")
            .bind(&ids)
            .fetch_all(db)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(id, tax_class, taxable)| (id, ProductTax { tax_class, taxable }))
        .collect())
}

async fn load_customer_use(db: &PgPool, contact_id: Option<&str>) -> Result<Option<TaxUse>, sqlx::Error> {
    let Some(contact_id) = contact_id.filter(|c| !c.is_empty()) else {
        return Ok(None);
    };
    let row: Option<(Option<String>,)> =
        sqlx::query_as("select tax_use from parties where id = $1 limit 1")
            .bind(contact_id)
            .fetch_optional(db)
            .await?;
    Ok(use_of(row.and_then(|(u,)| u).as_deref()))
}

fn is_foreign(address: Option<&Value>) -> bool {
    let country = address
        .and_then(|a| a.get("country"))
        .and_then(Value::as_str)
        .map(|c| crate::jurisdictions::js_trim(c).to_uppercase());
    matches!(country.as_deref(), Some(c) if !c.is_empty() && c != "US" && c != "USA" && c != "UNITED STATES")
}

/// `shipToIncomplete({ shipTo, registrations, lines })`: a US invoice with a
/// taxable line (or any line, when registered anywhere) needs a ship-to or
/// bill-to state and ZIP; a buyer abroad needs neither.
pub fn ship_to_incomplete(
    ship_to: Option<&Value>,
    registrations: &[Registration],
    lines: &[(f64, &str)],
) -> bool {
    if is_foreign(ship_to) {
        return false;
    }
    let registered = registrations.iter().any(|r| r.status == "registered");
    let needs = lines
        .iter()
        .any(|(amount, code)| *amount != 0.0 && (registered || *code != "non_taxable"));
    if !needs {
        return false;
    }
    state_code_of(ship_to).is_none() || zip5_of(ship_to).is_none()
}

/// `assertShipToForTax(args)`.
pub fn assert_ship_to_for_tax(
    ship_to: Option<&Value>,
    registrations: &[Registration],
    lines: &[(f64, &str)],
) -> Result<(), DocumentError> {
    if ship_to_incomplete(ship_to, registrations, lines) {
        Err(address_required())
    } else {
        Ok(())
    }
}

/// The engine of a calculation and the entity's registrations.
pub struct EngineContext {
    pub engine: Engine,
    pub engine_id: &'static str,
    pub registrations: Vec<Registration>,
}

fn load_options(runtime: Option<&Runtime>) -> LoadOptions<'_> {
    LoadOptions {
        keyring: runtime.map(|r| &r.keyring),
        http: runtime.and_then(|r| r.http.as_ref()),
    }
}

/// `loadEngine(db, entityId, runtime, purpose)`: the entity's engine, or for
/// use tax under Stripe (which can't compute it) the manual engine's own data.
async fn load_engine(
    db: &PgPool,
    entity_id: &str,
    runtime: Option<&Runtime>,
    use_tax: bool,
) -> Result<EngineContext, TaxError> {
    let ctx = load_sales_tax_context(db, entity_id, load_options(runtime)).await?;
    if use_tax && ctx.engine_id == "stripe_tax" {
        let data = load_manual_data(db, entity_id).await?;
        return Ok(EngineContext {
            engine: create_engine(EngineConfig::Manual(Some(data)), None)?,
            engine_id: "manual",
            registrations: ctx.registrations,
        });
    }
    Ok(EngineContext {
        engine: ctx.engine,
        engine_id: ctx.engine_id,
        registrations: ctx.registrations,
    })
}

/// `combinedRate(rows)`: the effective combined rate of the taxed part.
fn combined_rate(rows: &[&Value]) -> Option<String> {
    let taxed: Vec<&&Value> = rows
        .iter()
        .filter(|r| field(r, "taxableAmount") > 0.0 && field(r, "taxRate") > 0.0)
        .collect();
    if taxed.is_empty() {
        return (!rows.is_empty()).then(|| "0.0000".to_owned());
    }
    Some(js::to_fixed(
        taxed.iter().fold(0.0, |sum, r| sum + field(r, "taxRate")),
        4,
    ))
}

fn field(row: &Value, key: &str) -> f64 {
    js::js_number_value(row.get(key))
}

fn row_line_id(row: &Value) -> Option<&str> {
    row.get("lineId").and_then(Value::as_str)
}

fn tax_cents(rows: &[&Value]) -> i64 {
    rows.iter().map(|r| to_cents(field(r, "taxAmount"))).sum()
}

/// `totalsFrom(items, lineTotals, amounts)`.
fn totals_from(
    items: &[TaxItem],
    line_totals: &HashMap<String, (f64, f64)>,
    amounts: &HashMap<String, LineAmounts>,
) -> (String, String, String, String, String) {
    let mut subtotal = 0i64;
    let mut discount_total = 0i64;
    let mut tax_total = 0i64;
    for item in items {
        let (net, tax) = line_totals.get(&item.id).copied().unwrap_or_else(|| {
            (amounts.get(&item.id).map_or(0.0, |a| a.amount), 0.0)
        });
        subtotal += to_cents(net);
        tax_total += to_cents(tax);
        discount_total += to_cents(amounts.get(&item.id).map_or(0.0, |a| a.discount));
    }
    let total = subtotal + tax_total;
    (
        js::to_fixed(from_cents(subtotal), 2),
        js::to_fixed(from_cents(discount_total), 2),
        js::to_fixed(from_cents(tax_total), 2),
        js::to_fixed(from_cents(total), 2),
        js::to_fixed(from_cents(total), 2),
    )
}

/// `SalesTaxRequestBundle`.
pub struct RequestBundle {
    pub request: SalesTaxRequest,
    /// Each line's tax code, by line id (the last line with an id wins).
    pub tax_codes: HashMap<String, String>,
    amounts: HashMap<String, LineAmounts>,
}

/// `buildRequest(db, entity, doc, items, engine, direction)`.
async fn build_request(
    db: &PgPool,
    entity: &SalesTaxEntity,
    doc: &DocumentContext,
    items: &[TaxItem],
    registrations: &[Registration],
    use_tax: bool,
) -> Result<RequestBundle, TaxError> {
    let products = load_products(db, items).await?;
    let customer_use = if use_tax {
        None
    } else {
        load_customer_use(db, doc.contact_id.as_deref()).await?
    };
    let certificates = match doc.contact_id.as_deref().filter(|c| !c.is_empty()) {
        Some(contact) if !use_tax => load_customer_certificates(db, &entity.id, contact).await?,
        _ => Vec::new(),
    };
    let ship_from = normalize_postal_address(doc.ship_from_address.as_ref())
        .or_else(|| entity.address.clone())
        .unwrap_or_else(|| Value::Object(Map::new()));
    let ship_to = if use_tax {
        pick_ship_to(&[doc.delivery_address.as_ref()]).or_else(|| entity.address.clone())
    } else {
        pick_ship_to(&[doc.shipping_address.as_ref(), doc.billing_address.as_ref()])
    };
    let mut tax_codes = HashMap::new();
    let mut amounts = HashMap::new();
    let lines = items
        .iter()
        .map(|item| {
            let code = resolve_line_tax_code(
                item.tax_code.as_deref(),
                item.product_id
                    .as_deref()
                    .filter(|p| !p.is_empty())
                    .and_then(|p| products.get(p)),
            );
            tax_codes.insert(item.id.clone(), code.clone());
            let a = line_amounts(item);
            let line = RequestLine {
                line_id: item.id.clone(),
                amount: a.amount,
                quantity: a.quantity,
                tax_code: code,
                tax_use: use_of(item.tax_use.as_deref())
                    .or(customer_use)
                    .unwrap_or(TaxUse::Business),
                tax_included: item.tax_included == Some(true),
                tax_override: item
                    .tax_override_amount
                    .as_deref()
                    .filter(|a| !a.is_empty())
                    .map(|amount| Override {
                        amount: round_cents(num(Some(amount), 0.0)),
                        reason: item
                            .tax_override_reason
                            .as_deref()
                            .map(crate::jurisdictions::js_trim)
                            .filter(|r| !r.is_empty())
                            .unwrap_or("Set by hand")
                            .to_owned(),
                    }),
            };
            amounts.insert(item.id.clone(), a);
            line
        })
        .collect();
    let request = SalesTaxRequest {
        entity_id: entity.id.clone(),
        document_type: doc.kind.as_str().to_owned(),
        document_id: doc.document_id.clone().filter(|d| !d.is_empty()),
        document_number: doc.document_number.clone().filter(|d| !d.is_empty()),
        document_date: doc.issue_date.day(),
        currency: doc
            .currency
            .clone()
            .filter(|c| !c.is_empty())
            .or_else(|| entity.base_currency.clone())
            .unwrap_or_default(),
        ship_from,
        ship_to,
        customer: Customer {
            party_id: doc.contact_id.clone().unwrap_or_default(),
            certificates,
            tax_use: customer_use,
        },
        registrations: registrations.to_vec(),
        lines,
        marketplace_facilitated: doc.marketplace_facilitated == Some(true),
        direction: if use_tax {
            TaxDirection::Use
        } else {
            TaxDirection::Sales
        },
    };
    Ok(RequestBundle {
        request,
        tax_codes,
        amounts,
    })
}

/// `summarize(items, result, rows, taxCodes, amounts)`.
fn summarize(
    items: &[TaxItem],
    result: &SalesTaxResult,
    rows: &[Value],
    bundle: &RequestBundle,
) -> (Vec<ProcessedItem>, HashMap<String, (f64, f64)>) {
    let mut line_totals = HashMap::new();
    let processed = items
        .iter()
        .map(|item| {
            let line = result.lines.iter().find(|l| l.line_id == item.id);
            let line_rows: Vec<&Value> = rows
                .iter()
                .filter(|r| row_line_id(r) == Some(item.id.as_str()))
                .collect();
            let net = line.map_or_else(
                || bundle.amounts.get(&item.id).map_or(0.0, |a| a.amount),
                |l| l.gross_amount,
            );
            let tax = from_cents(tax_cents(&line_rows));
            line_totals.insert(item.id.clone(), (net, tax));
            ProcessedItem {
                id: item.id.clone(),
                line_total: js::to_fixed(round_cents(net), 2),
                line_total_with_tax: js::to_fixed(round_cents(net + tax), 2),
                tax_amount: js::to_fixed(tax, 2),
                tax_rate: combined_rate(&line_rows),
                tax_code: bundle
                    .tax_codes
                    .get(&item.id)
                    .cloned()
                    .unwrap_or_else(|| DEFAULT_WELD_TAX_CODE.to_owned()),
                overridden: line.is_some_and(|l| l.overridden),
            }
        })
        .collect();
    (processed, line_totals)
}

fn calculation(
    totals: (String, String, String, String, String),
    tax_breakdown: Vec<Value>,
    processed_items: Vec<ProcessedItem>,
    sales_tax: TaxMeta,
) -> Calculation {
    let (subtotal, discount_total, tax_total, total, balance_due) = totals;
    Calculation {
        subtotal,
        discount_total,
        tax_total,
        total,
        balance_due,
        tax_breakdown,
        processed_items,
        sales_tax,
    }
}

/// `calculateSale(db, entity, doc, items, runtime)`.
async fn calculate_sale(
    db: &PgPool,
    entity: &SalesTaxEntity,
    doc: &DocumentContext,
    items: &[TaxItem],
    runtime: Option<&Runtime>,
) -> Result<Calculation, TaxError> {
    let ctx = load_engine(db, &entity.id, runtime, false).await?;
    let bundle = build_request(db, entity, doc, items, &ctx.registrations, false).await?;
    let result = ctx.engine.calculate(&bundle.request).await?;
    let rows = sales_tax_result_to_breakdown(
        &result,
        &TaxLineContext {
            lines: items
                .iter()
                .map(|i| (i.id.clone(), bundle.tax_codes.get(&i.id).cloned()))
                .collect(),
            use_tax: false,
            marketplace_facilitated: doc.marketplace_facilitated == Some(true),
            registrations: &ctx.registrations,
            document_date: Some(bundle.request.document_date.clone()),
        },
    );
    let (processed_items, line_totals) = summarize(items, &result, &rows, &bundle);
    let totals = totals_from(items, &line_totals, &bundle.amounts);
    let lines: Vec<(f64, &str)> = bundle
        .request
        .lines
        .iter()
        .map(|l| (l.amount, l.tax_code.as_str()))
        .collect();
    let address_incomplete =
        ship_to_incomplete(bundle.request.ship_to.as_ref(), &ctx.registrations, &lines);
    Ok(calculation(
        totals,
        rows,
        processed_items,
        TaxMeta {
            engine: result.engine.clone(),
            engine_ref: result.engine_ref.clone(),
            calculated_at: result.calculated_at.clone(),
            warnings: result.warnings.clone(),
            marketplace_facilitated: doc.marketplace_facilitated == Some(true),
            ship_to_state: result.ship_to_state.clone(),
            ship_to_postal_code: result.ship_to_postal_code.clone(),
            address_incomplete,
            original_line_ids: None,
        },
    ))
}

// ---------------------------------------------------------------------------
// Credit memos
// ---------------------------------------------------------------------------

/// `calculateCreditMemo(db, doc, items)`: a credit memo never asks the
/// engine; it reverses the original invoice's jurisdictions and rates.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors document-tax.ts's calculateCreditMemo()"
)]
async fn calculate_credit_memo(
    db: &PgPool,
    doc: &DocumentContext,
    items: &[TaxItem],
) -> Result<Calculation, TaxError> {
    let Some(original_id) = doc.original_invoice_id.as_deref().filter(|i| !i.is_empty()) else {
        return Err(DocumentError::new(
            "CREDIT_LINE_NOT_ON_ORIGINAL",
            "A credit memo reverses the tax of the invoice it credits. Create it from the invoice (Create credit memo).",
        )
        .into());
    };
    let original: Option<(String, Option<Value>, Option<String>, Option<bool>, Option<Value>, Option<Value>)> =
        sqlx::query_as(
            "select id, tax_breakdown, tax_engine, marketplace_facilitated, shipping_address, billing_address \
             from invoices where id = $1 and deleted_at is null limit 1",
        )
        .bind(original_id)
        .fetch_optional(db)
        .await?;
    let original_items: Vec<(String, Option<String>, Option<String>, Option<String>, Option<String>, Option<i32>)> =
        match &original {
            Some((id, ..)) => {
                sqlx::query_as(
                    "select id, description, unit_price::text, quantity::text, discount_percent::text, sort_order \
                     from invoice_items where invoice_id = $1 and deleted_at is null",
                )
                .bind(id)
                .fetch_all(db)
                .await?
            }
            None => Vec::new(),
        };
    let original_rows: Vec<Value> = original
        .as_ref()
        .and_then(|o| o.1.as_ref())
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter(|r| row_line_id(r).is_some_and(|id| !id.is_empty()))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let original_taxed = original
        .as_ref()
        .is_some_and(|o| o.2.as_deref().is_some_and(|e| !e.is_empty()));

    let mut amounts: HashMap<String, LineAmounts> = HashMap::new();
    for item in items {
        amounts.insert(item.id.clone(), line_amounts(item));
    }
    let credit_lines: Vec<CreditLine<'_>> = items
        .iter()
        .map(|i| CreditLine {
            id: &i.id,
            description: i.description.as_deref(),
            unit_price: &i.unit_price,
            sort_order: i.sort_order,
            original_line_id: i.original_line_id.as_deref(),
        })
        .collect();
    let originals: Vec<OriginalLine<'_>> = original_items
        .iter()
        .map(|(id, description, unit_price, _, _, sort_order)| OriginalLine {
            id,
            description: description.as_deref(),
            unit_price: unit_price.as_deref().unwrap_or(""),
            sort_order: sort_order.map(f64::from),
        })
        .collect();
    let mapping = map_credit_items_to_original(&credit_lines, &originals);
    let mapped = |id: &str| {
        mapping
            .iter()
            .find(|(credit, _)| credit == id)
            .and_then(|(_, original)| original.clone())
    };

    // Credit lines of the same original line go in separate batches, so each
    // batch reverses a line once.
    let mut batches: Vec<Vec<(String, String, f64)>> = Vec::new();
    for item in items {
        let Some(original_line_id) = mapped(&item.id) else {
            if !original_rows.is_empty() || original_taxed {
                let mut details = Map::new();
                details.insert("lineId".into(), json!(item.id));
                return Err(DocumentError {
                    code: "CREDIT_LINE_NOT_ON_ORIGINAL",
                    message: format!(
                        "Credit line \"{}\" is not a line of the invoice being credited. A credit memo can only credit what was invoiced.",
                        item.description.as_deref().unwrap_or(&item.id)
                    ),
                    status: 400,
                    details: Some(details),
                }
                .into());
            }
            continue;
        };
        let rows: Vec<&Value> = original_rows
            .iter()
            .filter(|r| row_line_id(r) == Some(original_line_id.as_str()))
            .collect();
        if rows.is_empty() {
            continue;
        }
        let original_entered = original_items
            .iter()
            .find(|o| o.0 == original_line_id)
            .map_or(0.0, |o| {
                line_amounts(&TaxItem {
                    id: o.0.clone(),
                    quantity: o.3.clone(),
                    unit_price: o.2.clone().unwrap_or_default(),
                    discount_percent: o.4.clone(),
                    ..TaxItem::default()
                })
                .amount
            });
        let credit_entered = amounts.get(&item.id).map_or(0.0, |a| a.amount);
        let gross = line_gross(rows[0]);
        let amount = if original_entered == 0.0 {
            0.0
        } else {
            round_half_up(gross * (credit_entered / original_entered), 2)
        };
        let entry = (item.id.clone(), original_line_id.clone(), amount);
        match batches
            .iter_mut()
            .find(|b| !b.iter().any(|e| e.1 == original_line_id))
        {
            Some(batch) => batch.push(entry),
            None => batches.push(vec![entry]),
        }
    }

    let mut tax_breakdown: Vec<Value> = Vec::new();
    for batch in &batches {
        let credits: Vec<(String, f64)> = batch.iter().map(|b| (b.1.clone(), b.2)).collect();
        for row in reverse_result_for_credit_memo(&original_rows, &credits) {
            if let Some(credit) = batch.iter().find(|b| Some(b.1.as_str()) == row_line_id(&row)) {
                let mut row = row.as_object().cloned().unwrap_or_default();
                row.insert("lineId".into(), json!(credit.0));
                tax_breakdown.push(Value::Object(row));
            }
        }
    }

    let mut line_totals: HashMap<String, (f64, f64)> = HashMap::new();
    let processed_items = items
        .iter()
        .map(|item| {
            let rows: Vec<&Value> = tax_breakdown
                .iter()
                .filter(|r| row_line_id(r) == Some(item.id.as_str()))
                .collect();
            let net = if rows.is_empty() {
                amounts.get(&item.id).map_or(0.0, |a| a.amount)
            } else {
                line_gross(rows[0])
            };
            let tax = from_cents(tax_cents(&rows));
            line_totals.insert(item.id.clone(), (net, tax));
            ProcessedItem {
                id: item.id.clone(),
                line_total: js::to_fixed(round_cents(net), 2),
                line_total_with_tax: js::to_fixed(round_cents(net + tax), 2),
                tax_amount: js::to_fixed(tax, 2),
                tax_rate: combined_rate(&rows),
                tax_code: rows
                    .first()
                    .and_then(|r| r.get("taxCode"))
                    .and_then(Value::as_str)
                    .unwrap_or(DEFAULT_WELD_TAX_CODE)
                    .to_owned(),
                overridden: false,
            }
        })
        .collect();
    let totals = totals_from(items, &line_totals, &amounts);
    let ship_to = original
        .as_ref()
        .and_then(|o| pick_ship_to(&[o.4.as_ref(), o.5.as_ref()]));
    let original_line_ids: Map<String, Value> = mapping
        .into_iter()
        .map(|(credit, original)| (credit, original.map_or(Value::Null, Value::String)))
        .collect();
    Ok(calculation(
        totals,
        tax_breakdown,
        processed_items,
        TaxMeta {
            engine: original
                .as_ref()
                .and_then(|o| o.2.clone())
                .unwrap_or_else(|| "manual".to_owned()),
            engine_ref: None,
            calculated_at: crate::http::now(),
            warnings: Vec::new(),
            marketplace_facilitated: original.as_ref().is_some_and(|o| o.3 == Some(true)),
            ship_to_state: state_code_of(ship_to.as_ref()),
            ship_to_postal_code: zip5_of(ship_to.as_ref()),
            address_incomplete: false,
            original_line_ids: Some(original_line_ids),
        },
    ))
}

/// `calculateUsDocumentTax(db, { entity, doc, items, runtime })`: a sale
/// (invoice, estimate) through the entity's engine, a credit memo at its
/// invoice's rates. An engine failure is an error, never zero tax.
pub async fn calculate_us_document_tax(
    db: &PgPool,
    entity: &SalesTaxEntity,
    doc: &DocumentContext,
    items: &[TaxItem],
    runtime: Option<&Runtime>,
) -> Result<Calculation, TaxError> {
    if doc.kind == DocumentKind::CreditMemo {
        return calculate_credit_memo(db, doc, items).await;
    }
    calculate_sale(db, entity, doc, items, runtime).await
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
/// bill lines marked "accrue use tax", at the delivery address, through the
/// entity's engine (Stripe entities use their manual rates). Zero use tax
/// where no rate is configured is an error: a line marked for accrual never
/// silently accrues nothing. `None` when nothing accrues.
#[allow(clippy::implicit_hasher)]
pub async fn accrue_use_tax(
    db: &PgPool,
    entity: &SalesTaxEntity,
    doc: &DocumentContext,
    items: &[TaxItem],
    line_nets: &HashMap<String, f64>,
    runtime: Option<&Runtime>,
) -> Result<Option<UseTaxAccrual>, TaxError> {
    let accrued: Vec<&TaxItem> = items
        .iter()
        .filter(|i| i.accrue_use_tax == Some(true) && line_nets.get(&i.id).copied().unwrap_or(0.0) != 0.0)
        .collect();
    if accrued.is_empty() {
        return Ok(None);
    }
    let ctx = load_engine(db, &entity.id, runtime, true).await?;
    let sized: Vec<TaxItem> = accrued
        .iter()
        .map(|i| TaxItem {
            unit_price: js::number_text(line_nets.get(&i.id).copied().unwrap_or(0.0)),
            quantity: Some("1".into()),
            discount_percent: Some("0".into()),
            tax_included: Some(false),
            tax_override_amount: None,
            ..(*i).clone()
        })
        .collect();
    let bill = DocumentContext {
        kind: DocumentKind::Bill,
        ..doc.clone()
    };
    let bundle = build_request(db, entity, &bill, &sized, &ctx.registrations, true).await?;
    let result = ctx.engine.calculate(&bundle.request).await?;
    if result.total_tax == 0.0 && result.warnings.iter().any(|w| w == "rates_not_configured") {
        let stripe = ctx.engine_id == "manual" && entity_uses_stripe(db, &entity.id).await?;
        return Err(DocumentError::new(
            "TAX_RATES_NOT_CONFIGURED",
            if stripe {
                "Stripe Tax calculates sales tax only. To accrue use tax, add the state's jurisdictions and rates under Sales tax, or switch the engine to Avalara."
            } else {
                "No sales tax rates are set up for the delivery state, so use tax cannot be accrued. Add its jurisdictions and rates under Sales tax first."
            },
        )
        .into());
    }
    let rows = sales_tax_result_to_breakdown(
        &result,
        &TaxLineContext {
            lines: sized
                .iter()
                .map(|i| (i.id.clone(), bundle.tax_codes.get(&i.id).cloned()))
                .collect(),
            use_tax: true,
            marketplace_facilitated: false,
            registrations: &ctx.registrations,
            document_date: Some(bundle.request.document_date.clone()),
        },
    );
    Ok(Some(UseTaxAccrual {
        rows,
        engine: result.engine,
        engine_ref: result.engine_ref,
        warnings: result.warnings,
    }))
}

async fn entity_uses_stripe(db: &PgPool, entity_id: &str) -> Result<bool, sqlx::Error> {
    let engine: Option<Option<String>> =
        sqlx::query_scalar("select sales_tax_engine from entities where id = $1 limit 1")
            .bind(entity_id)
            .fetch_optional(db)
            .await?;
    Ok(engine.flatten().as_deref() == Some("stripe_tax"))
}

/// `buildStoredRequest(db, entity, doc, items, runtime)`: the request the
/// engine got for a stored document, for `commit` (provider engines record
/// the finalized document).
pub async fn build_stored_request(
    db: &PgPool,
    entity: &SalesTaxEntity,
    doc: &DocumentContext,
    items: &[TaxItem],
    runtime: Option<&Runtime>,
) -> Result<(SalesTaxRequest, EngineContext), TaxError> {
    let ctx = load_engine(db, &entity.id, runtime, false).await?;
    let bundle = build_request(db, entity, doc, items, &ctx.registrations, false).await?;
    Ok((bundle.request, ctx))
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
