//! The one server-side tax calculation of invoices, credit notes, bills and
//! recurring invoices (`services/accounting-tax-resolve.ts`), with its line
//! totals ([`totals`], `accounting-tax-totals`) and India's place of supply
//! ([`gst`], `accounting-gst`). The client's figures are a preview only.
//!
//! - A line's rate comes from its tax-rate row when it names one (the
//!   client's percentage is ignored), and that row must belong to the entity
//!   and fit the direction (sales or purchase).
//! - India: CGST + SGST or IGST by place of supply.
//! - Purchase tax under reverse charge / import categories is self-assessed
//!   and stays out of the bill total.
//! - A jurisdiction with a document tax hook (Brazil) calculates the whole
//!   document at once ([`document_tax_hook`]).
//! - A US entity's sales documents go to its sales tax engine
//!   ([`crate::sales_tax::document_tax`]); a US bill keeps the vendor's tax
//!   and adds use tax on the lines marked to accrue it.

pub mod gst;
pub mod totals;

use serde_json::{Map, Value};
use weldsuite_db::PgPool;

use crate::address::normalize_postal_address;
use crate::compliance::get_contact_vat_number;
use crate::http::Refusal;
use crate::js;
use crate::jurisdictions::india::extract_state_code_from_gstin;
use crate::sales_tax::document_tax::{
    self, DocumentContext, DocumentKind, Runtime, TaxItem, TaxMeta,
};
use crate::sales_tax::errors::SalesTaxError;
pub use gst::{GstSupply, SupplyArgs, is_gst_entity, resolve_gst_bill_supply, resolve_gst_supply};
pub use totals::{
    Counterparty, HookContext, HookLine, HookResult, LineTotals, PlaceOfSupply, TaxTotalsItem,
    Totals, calculate_line_tax_totals, entity_state_code,
};

/// Sales (invoices: output tax) or purchase (bills: input tax).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Sales,
    Purchase,
}

impl Direction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sales => "sales",
            Self::Purchase => "purchase",
        }
    }
}

/// Why a calculation failed.
#[derive(Debug)]
pub enum TaxError {
    /// `TaxCalculationError`: the routes answer it with a 400.
    Calculation(String),
    /// A sales tax refusal (`salesTaxErrorResponse`): engine down, address
    /// missing, rates not configured, ….
    SalesTax(SalesTaxError),
    Database(sqlx::Error),
    /// A failure the route's `catch` answers with its 500.
    Internal(String),
}

impl From<sqlx::Error> for TaxError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<SalesTaxError> for TaxError {
    fn from(error: SalesTaxError) -> Self {
        Self::SalesTax(error)
    }
}

impl std::fmt::Display for TaxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Calculation(message) | Self::Internal(message) => f.write_str(message),
            Self::SalesTax(error) => write!(f, "{error:?}"),
            Self::Database(error) => error.fmt(f),
        }
    }
}

/// As a route answers it in `accountingErrorResponse`: a sales tax refusal
/// with its own code, a calculation error as a 400, anything else the
/// route's 500.
impl From<TaxError> for Refusal {
    fn from(error: TaxError) -> Self {
        match error {
            TaxError::Calculation(message) => Self::bad_request(message),
            TaxError::SalesTax(error) => Self::Response(Box::new(error.response())),
            TaxError::Database(error) => Self::Database(error),
            TaxError::Internal(message) => Self::Internal(message),
        }
    }
}

/// `sanitizeTaxRateId(id)`: clients send `''`, `none` or `null` for no tax.
pub fn sanitize_tax_rate_id(id: Option<&str>) -> Option<String> {
    let id = id.filter(|id| !id.is_empty())?;
    let trimmed = crate::jurisdictions::js_trim(id);
    (!matches!(trimmed, "" | "none" | "null")).then(|| trimmed.to_owned())
}

/// `DocumentTaxItem`: a document line as the calculation reads it.
#[derive(Debug, Clone, Default)]
pub struct DocumentTaxItem {
    pub quantity: Option<String>,
    pub unit_price: String,
    pub discount_percent: Option<String>,
    /// Used only without a `tax_rate_id` (lines copied from an order).
    pub tax_rate: Option<String>,
    pub tax_rate_id: Option<String>,
    // US sales tax; `id` is the line row's (breakdown rows refer to it).
    pub id: Option<String>,
    pub description: Option<String>,
    pub sort_order: Option<f64>,
    pub product_id: Option<String>,
    pub tax_code: Option<String>,
    pub tax_use: Option<String>,
    pub tax_included: Option<bool>,
    pub tax_override_amount: Option<String>,
    pub tax_override_reason: Option<String>,
    pub accrue_use_tax: Option<bool>,
    pub original_line_id: Option<String>,
    // Brazil: read by the document tax hook.
    pub ncm: Option<String>,
    pub cfop: Option<String>,
    pub fiscal_data: Option<Value>,
}

/// `CalculatedLineTax`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalculatedLine {
    pub line_total: String,
    pub line_total_with_tax: String,
    pub tax_amount: String,
    pub tax_rate_id: Option<String>,
    pub tax_rate: Option<String>,
    /// US sales tax: the product tax code the line was taxed under.
    pub tax_code: Option<String>,
}

/// `CalculatedDocumentTax`.
#[derive(Debug, Clone, PartialEq)]
pub struct CalculatedDocumentTax {
    pub subtotal: String,
    pub discount_total: String,
    pub tax_total: String,
    pub total: String,
    pub balance_due: String,
    /// `DocumentTaxBreakdownRow`s.
    pub tax_breakdown: Vec<Value>,
    pub processed_items: Vec<CalculatedLine>,
    /// US sales tax: which engine answered. Absent for VAT / GST entities.
    pub sales_tax: Option<TaxMeta>,
    /// A document tax hook's notes (Brazil).
    pub tax_warnings: Option<Vec<String>>,
}

/// What [`calculate_document_tax`] is given.
#[derive(Debug, Clone, Copy)]
pub struct TaxArgs<'a> {
    pub entity_id: &'a str,
    pub direction: Direction,
    pub items: &'a [DocumentTaxItem],
    pub buyer_country: Option<&'a str>,
    pub buyer_state_code: Option<&'a str>,
    pub buyer_gstin: Option<&'a str>,
    pub billing_province: Option<&'a str>,
    pub document: Option<&'a DocumentContext>,
    pub runtime: Option<&'a Runtime>,
}

impl<'a> TaxArgs<'a> {
    /// The arguments with nothing but the lines.
    pub fn new(entity_id: &'a str, direction: Direction, items: &'a [DocumentTaxItem]) -> Self {
        Self {
            entity_id,
            direction,
            items,
            buyer_country: None,
            buyer_state_code: None,
            buyer_gstin: None,
            billing_province: None,
            document: None,
            runtime: None,
        }
    }

    /// `...(gst ? { buyerStateCode, buyerCountry, buyerGstin } : {})`.
    #[must_use]
    pub fn with_gst(mut self, gst: Option<&'a GstSupply>) -> Self {
        if let Some(gst) = gst {
            self.buyer_state_code = gst.buyer_state_code.as_deref();
            self.buyer_country = gst.buyer_country.as_deref();
            self.buyer_gstin = gst.buyer_gstin.as_deref();
        }
        self
    }
}

/// `toUsItem(item, index)`.
fn to_us_item(item: &DocumentTaxItem, index: usize) -> TaxItem {
    TaxItem {
        id: item.id.clone().unwrap_or_else(|| format!("line_{index}")),
        description: item.description.clone(),
        quantity: item.quantity.clone(),
        unit_price: item.unit_price.clone(),
        discount_percent: item.discount_percent.clone(),
        sort_order: item.sort_order,
        product_id: item.product_id.clone(),
        tax_code: item.tax_code.clone(),
        tax_use: item.tax_use.clone(),
        tax_included: item.tax_included,
        tax_override_amount: item.tax_override_amount.clone(),
        tax_override_reason: item.tax_override_reason.clone(),
        accrue_use_tax: item.accrue_use_tax,
        original_line_id: item.original_line_id.clone(),
    }
}

/// `untaxedDocumentTax(items)`: a US document's totals before any tax, the
/// draft view while the engine is unavailable.
pub fn untaxed_document_tax(items: &[DocumentTaxItem]) -> CalculatedDocumentTax {
    let us_items: Vec<TaxItem> = items
        .iter()
        .enumerate()
        .map(|(i, item)| to_us_item(item, i))
        .collect();
    let untaxed = document_tax::untaxed_totals(&us_items);
    CalculatedDocumentTax {
        subtotal: untaxed.subtotal,
        discount_total: untaxed.discount_total,
        tax_total: untaxed.tax_total,
        total: untaxed.total,
        balance_due: untaxed.balance_due,
        tax_breakdown: Vec::new(),
        processed_items: untaxed
            .processed_items
            .into_iter()
            .map(|p| CalculatedLine {
                line_total: p.line_total,
                line_total_with_tax: p.line_total_with_tax,
                tax_amount: p.tax_amount,
                tax_rate_id: None,
                tax_rate: None,
                tax_code: None,
            })
            .collect(),
        sales_tax: None,
        tax_warnings: None,
    }
}

/// `calculateDocumentTax(db, args)`.
pub async fn calculate_document_tax(
    db: &PgPool,
    args: &TaxArgs<'_>,
) -> Result<CalculatedDocumentTax, TaxError> {
    let entity = document_tax::load_sales_tax_entity(db, args.entity_id).await?;
    let sales_tax_entity = document_tax::uses_sales_tax(entity.as_ref());

    // A credit memo of an invoice the engine never calculated keeps its own rates.
    let reuses_original = match args.document {
        Some(doc) if doc.kind == DocumentKind::CreditMemo => {
            match doc
                .original_invoice_id
                .as_deref()
                .filter(|id| !id.is_empty())
            {
                Some(original) => original_was_engine_taxed(db, original).await?,
                None => true,
            }
        }
        _ => true,
    };

    if let Some(entity) = entity.as_ref().filter(|_| sales_tax_entity)
        && args.direction == Direction::Sales
        && reuses_original
    {
        return engine_tax(db, entity, args).await;
    }

    let legacy = calculate_rate_table_tax(db, args).await?;
    let (Some(entity), Some(doc)) = (entity.as_ref().filter(|_| sales_tax_entity), args.document)
    else {
        return Ok(legacy);
    };
    if !args.items.iter().any(|i| i.accrue_use_tax == Some(true)) {
        return Ok(legacy);
    }

    // US bill: use tax on the lines the vendor charged no sales tax on.
    let us_items: Vec<TaxItem> = args
        .items
        .iter()
        .enumerate()
        .map(|(i, item)| to_us_item(item, i))
        .collect();
    let line_nets = us_items
        .iter()
        .enumerate()
        .map(|(idx, item)| {
            let net = legacy
                .processed_items
                .get(idx)
                .map_or(0.0, |p| js::numeric_text(Some(&p.line_total)));
            (item.id.clone(), net)
        })
        .collect();
    let Some(accrual) =
        document_tax::accrue_use_tax(db, entity, doc, &us_items, &line_nets, args.runtime).await?
    else {
        return Ok(legacy);
    };
    let ship_to_state = accrual
        .rows
        .first()
        .and_then(|row| row.get("stateCode"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut tax_breakdown = legacy.tax_breakdown;
    tax_breakdown.extend(accrual.rows);
    Ok(CalculatedDocumentTax {
        tax_breakdown,
        sales_tax: Some(TaxMeta {
            engine: accrual.engine,
            engine_ref: accrual.engine_ref,
            calculated_at: crate::http::now(),
            warnings: accrual.warnings,
            marketplace_facilitated: false,
            ship_to_state,
            ship_to_postal_code: None,
            address_incomplete: false,
            original_line_ids: None,
        }),
        ..legacy
    })
}

/// A US sale through the entity's engine.
async fn engine_tax(
    db: &PgPool,
    entity: &document_tax::SalesTaxEntity,
    args: &TaxArgs<'_>,
) -> Result<CalculatedDocumentTax, TaxError> {
    let Some(doc) = args.document else {
        return Err(TaxError::Calculation(
            "A sales tax calculation needs the document context (customer, date, addresses)".into(),
        ));
    };
    let us_items: Vec<TaxItem> = args
        .items
        .iter()
        .enumerate()
        .map(|(i, item)| to_us_item(item, i))
        .collect();
    let calc =
        document_tax::calculate_us_document_tax(db, entity, doc, &us_items, args.runtime).await?;
    Ok(CalculatedDocumentTax {
        subtotal: calc.subtotal,
        discount_total: calc.discount_total,
        tax_total: calc.tax_total,
        total: calc.total,
        balance_due: calc.balance_due,
        tax_breakdown: calc.tax_breakdown,
        processed_items: calc
            .processed_items
            .into_iter()
            .map(|p| CalculatedLine {
                line_total: p.line_total,
                line_total_with_tax: p.line_total_with_tax,
                tax_amount: p.tax_amount,
                tax_rate_id: None,
                tax_rate: p.tax_rate,
                tax_code: Some(p.tax_code),
            })
            .collect(),
        sales_tax: Some(calc.sales_tax),
        tax_warnings: None,
    })
}

/// `originalWasEngineTaxed(db, invoiceId)`.
async fn original_was_engine_taxed(db: &PgPool, invoice_id: &str) -> Result<bool, sqlx::Error> {
    let engine: Option<Option<String>> =
        sqlx::query_scalar("select tax_engine from invoices where id = $1 limit 1")
            .bind(invoice_id)
            .fetch_optional(db)
            .await?;
    Ok(engine.flatten().is_some_and(|e| !e.is_empty()))
}

/// A rate of the entity (`RateTableRate`).
struct RateTableRate {
    id: String,
    name: String,
    kind: String,
    rate: String,
    tax_category_code: Option<String>,
    jurisdiction_metadata: Option<Value>,
}

/// `loadEntityRates(db, entityId, rateIds)`: the rates of this entity, in
/// the order the database returns them; a rate that is not its own is
/// refused.
async fn load_entity_rates(
    db: &PgPool,
    entity_id: &str,
    rate_ids: &[String],
) -> Result<Vec<RateTableRate>, TaxError> {
    if rate_ids.is_empty() {
        return Ok(Vec::new());
    }
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        String,
        String,
        String,
        Option<String>,
        Option<Value>,
    )> = sqlx::query_as(
        "select id, name, type, rate::text, tax_category_code, jurisdiction_metadata \
             from tax_rates where id = any($1) and entity_id = $2 and deleted_at is null",
    )
    .bind(rate_ids)
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let rates: Vec<RateTableRate> = rows
        .into_iter()
        .map(
            |(id, name, kind, rate, tax_category_code, jurisdiction_metadata)| RateTableRate {
                id,
                name,
                kind,
                rate,
                tax_category_code,
                jurisdiction_metadata,
            },
        )
        .collect();
    let missing: Vec<&str> = rate_ids
        .iter()
        .filter(|id| !rates.iter().any(|r| &r.id == *id))
        .map(String::as_str)
        .collect();
    if !missing.is_empty() {
        return Err(TaxError::Calculation(format!(
            "Tax rate {} does not belong to this accounting entity",
            missing.join(", ")
        )));
    }
    Ok(rates)
}

/// `assertRateDirection(rateById, direction)`.
fn assert_rate_direction(rates: &[RateTableRate], direction: Direction) -> Result<(), TaxError> {
    let wrong = match direction {
        Direction::Sales => "purchase",
        Direction::Purchase => "sales",
    };
    // `new Map()` keeps the first row of an id where it came first.
    let mut seen: Vec<&str> = Vec::new();
    for rate in rates {
        if seen.contains(&rate.id.as_str()) {
            continue;
        }
        seen.push(&rate.id);
        if rate.kind == wrong {
            return Err(TaxError::Calculation(match direction {
                Direction::Sales => format!(
                    "Tax rate \"{}\" is a purchase rate and can't be used on an invoice. Choose a sales rate.",
                    rate.name
                ),
                Direction::Purchase => format!(
                    "Tax rate \"{}\" is a sales rate and can't be used on a bill. Choose a purchase rate.",
                    rate.name
                ),
            }));
        }
    }
    Ok(())
}

/// `lineFiscalData(item)`: the jsonb with NCM and CFOP, or none.
fn line_fiscal_data(item: &DocumentTaxItem) -> Option<Value> {
    let ncm = item.ncm.as_deref().filter(|v| !v.is_empty());
    let cfop = item.cfop.as_deref().filter(|v| !v.is_empty());
    let fiscal = item.fiscal_data.as_ref().filter(|v| js::truthy(Some(v)));
    if fiscal.is_none() && ncm.is_none() && cfop.is_none() {
        return None;
    }
    let mut out = match fiscal {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    if let Some(ncm) = ncm {
        out.insert("ncm".into(), Value::String(ncm.into()));
    }
    if let Some(cfop) = cfop {
        out.insert("cfop".into(), Value::String(cfop.into()));
    }
    Some(Value::Object(out))
}

/// `calculateRateTableTax(db, args)`: VAT / GST, and the vendor-charged tax
/// of a US bill.
async fn calculate_rate_table_tax(
    db: &PgPool,
    args: &TaxArgs<'_>,
) -> Result<CalculatedDocumentTax, TaxError> {
    let rate_ids_of: Vec<Option<String>> = args
        .items
        .iter()
        .map(|item| sanitize_tax_rate_id(item.tax_rate_id.as_deref()))
        .collect();
    let mut rate_ids: Vec<String> = Vec::new();
    for id in rate_ids_of.iter().flatten() {
        if !rate_ids.contains(id) {
            rate_ids.push(id.clone());
        }
    }
    let rates = load_entity_rates(db, args.entity_id, &rate_ids).await?;
    assert_rate_direction(&rates, args.direction)?;
    let rate_of = |id: &str| rates.iter().find(|r| r.id == id);

    let enriched: Vec<TaxTotalsItem> = args
        .items
        .iter()
        .zip(&rate_ids_of)
        .map(|(item, rate_id)| {
            let rate_row = rate_id.as_deref().and_then(rate_of);
            TaxTotalsItem {
                quantity: item
                    .quantity
                    .clone()
                    .filter(|q| !q.is_empty())
                    .unwrap_or_else(|| "1".into()),
                unit_price: item.unit_price.clone(),
                discount_percent: item
                    .discount_percent
                    .clone()
                    .filter(|d| !d.is_empty())
                    .unwrap_or_else(|| "0".into()),
                tax_rate: Some(match rate_row {
                    Some(row) => row.rate.clone(),
                    None => item.tax_rate.clone().unwrap_or_else(|| "0".into()),
                }),
                tax_rate_id: rate_id.clone(),
                tax_rate_name: rate_row.map(|r| r.name.clone()),
                tax_category_code: rate_row.and_then(|r| r.tax_category_code.clone()),
                jurisdiction_metadata: rate_row
                    .and_then(|r| r.jurisdiction_metadata.clone())
                    .filter(|m| !m.is_null()),
                fiscal_data: line_fiscal_data(item),
            }
        })
        .collect();

    // A jurisdiction with a whole-document hook (Brazil) calculates every line at once.
    let totals = if let Some((entity, hook)) = load_document_tax_hook(db, args.entity_id).await? {
        let ctx = document_tax_context(db, &entity, args.direction, args.document).await?;
        let (lines, subtotal, discount_total) = totals::hook_inputs(&enriched);
        let result = hook(&lines, &ctx)?;
        totals::hook_tax_totals(&lines, subtotal, discount_total, result)
    } else {
        let place = load_place_of_supply(
            db,
            args.entity_id,
            &PlaceOptions {
                buyer_country: args.buyer_country,
                buyer_state_code: args.buyer_state_code,
                buyer_gstin: args.buyer_gstin,
                billing_province: args.billing_province,
            },
        )
        .await?;
        calculate_line_tax_totals(
            &enriched,
            Some(&PlaceOfSupply {
                direction: Some(args.direction),
                ..place
            }),
        )
    };

    Ok(CalculatedDocumentTax {
        subtotal: totals.subtotal,
        discount_total: totals.discount_total,
        tax_total: totals.tax_total,
        total: totals.total,
        balance_due: totals.balance_due,
        tax_breakdown: totals.tax_breakdown,
        processed_items: totals
            .processed_items
            .into_iter()
            .zip(&enriched)
            .map(|(line, item)| CalculatedLine {
                line_total: line.line_total,
                line_total_with_tax: line.line_total_with_tax,
                tax_amount: line.tax_amount,
                tax_rate_id: item.tax_rate_id.clone(),
                tax_rate: item.tax_rate.clone(),
                tax_code: None,
            })
            .collect(),
        sales_tax: None,
        tax_warnings: totals.tax_warnings,
    })
}

/// The buyer facts [`load_place_of_supply`] is given.
#[derive(Debug, Clone, Copy, Default)]
pub struct PlaceOptions<'a> {
    pub buyer_country: Option<&'a str>,
    pub buyer_state_code: Option<&'a str>,
    pub buyer_gstin: Option<&'a str>,
    pub billing_province: Option<&'a str>,
}

/// `loadPlaceOfSupply(db, entityId, opts)`.
pub async fn load_place_of_supply(
    db: &PgPool,
    entity_id: &str,
    opts: &PlaceOptions<'_>,
) -> Result<PlaceOfSupply, sqlx::Error> {
    let entity: Option<(String, Option<Value>, Option<Value>)> = sqlx::query_as(
        "select jurisdiction_code, tax_identifiers, jurisdiction_settings from entities \
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let Some((jurisdiction_code, tax_identifiers, settings)) = entity else {
        return Ok(PlaceOfSupply::default());
    };
    let seller_state_code = entity_state_code(tax_identifiers.as_ref(), settings.as_ref());
    let unset = |code: &Option<String>| code.as_deref().is_none_or(str::is_empty);
    let mut buyer_state_code = opts.buyer_state_code.map(str::to_owned);
    if unset(&buyer_state_code)
        && let Some(gstin) = opts.buyer_gstin.filter(|g| !g.is_empty())
    {
        buyer_state_code = extract_state_code_from_gstin(gstin);
    }
    // A billing province may carry India's two-digit state code.
    if unset(&buyer_state_code)
        && let Some(province) = opts
            .billing_province
            .filter(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_digit()))
    {
        buyer_state_code = Some(province.to_owned());
    }
    Ok(PlaceOfSupply {
        jurisdiction_code: Some(jurisdiction_code),
        seller_state_code,
        buyer_state_code,
        buyer_country: opts.buyer_country.map(str::to_owned),
        direction: None,
    })
}

/// The entity columns a document tax hook reads (`HookEntity`).
#[derive(Debug, Clone)]
pub struct HookEntity {
    pub jurisdiction_code: String,
    pub tax_classification: Option<String>,
    pub jurisdiction_settings: Option<Value>,
}

/// `adapter.computeDocumentTaxes`.
pub type DocumentTaxHook = fn(&[HookLine], &HookContext) -> Result<HookResult, TaxError>;

/// The document tax hook of a jurisdiction, if it has one (only Brazil:
/// `jurisdictions/br/tax-engine`'s `computeDocumentTaxes`,
/// [`crate::jurisdictions::br_tax::compute_document_taxes`]).
pub fn document_tax_hook(jurisdiction_code: &str) -> Option<DocumentTaxHook> {
    match jurisdiction_code.to_uppercase().as_str() {
        "BR" => Some(crate::jurisdictions::br_tax::compute_document_taxes),
        _ => None,
    }
}

/// `loadDocumentTaxHook(db, entityId)`.
async fn load_document_tax_hook(
    db: &PgPool,
    entity_id: &str,
) -> Result<Option<(HookEntity, DocumentTaxHook)>, sqlx::Error> {
    let entity: Option<(String, Option<String>, Option<Value>)> = sqlx::query_as(
        "select jurisdiction_code, tax_classification, jurisdiction_settings from entities \
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let Some((jurisdiction_code, tax_classification, jurisdiction_settings)) = entity else {
        return Ok(None);
    };
    if !crate::jurisdictions::has_adapter(&jurisdiction_code) {
        return Ok(None);
    }
    Ok(document_tax_hook(&jurisdiction_code).map(|hook| {
        (
            HookEntity {
                jurisdiction_code,
                tax_classification,
                jurisdiction_settings,
            },
            hook,
        )
    }))
}

/// `hasDocumentTaxHook(db, entityId)`: the entity's jurisdiction calculates
/// documents as a whole (Brazil).
pub async fn has_document_tax_hook(db: &PgPool, entity_id: &str) -> Result<bool, sqlx::Error> {
    Ok(load_document_tax_hook(db, entity_id).await?.is_some())
}

/// `documentTaxContext(db, entity, direction, document)`: the counterparty
/// and document facts the hook needs.
pub async fn document_tax_context(
    db: &PgPool,
    entity: &HookEntity,
    direction: Direction,
    document: Option<&DocumentContext>,
) -> Result<HookContext, sqlx::Error> {
    let mut address = document.and_then(|d| {
        normalize_postal_address(d.shipping_address.as_ref())
            .or_else(|| normalize_postal_address(d.billing_address.as_ref()))
    });
    let mut br_fiscal: Option<Value> = None;
    let contact_id = document
        .and_then(|d| d.contact_id.as_deref())
        .filter(|id| !id.is_empty());
    if let Some(contact_id) = contact_id {
        let party: Option<(Option<Value>, Option<Value>, Option<Value>)> = sqlx::query_as(
            "select billing_address, shipping_address, br_fiscal from parties where id = $1 limit 1",
        )
        .bind(contact_id)
        .fetch_optional(db)
        .await?;
        if let Some((billing, shipping, fiscal)) = party {
            br_fiscal = fiscal.filter(|f| !f.is_null());
            if address.is_none() {
                address = normalize_postal_address(shipping.as_ref())
                    .or_else(|| normalize_postal_address(billing.as_ref()));
            }
        }
    }
    let tax_id = match get_contact_vat_number(db, contact_id).await? {
        Some(vat) => Some(vat),
        None => br_fiscal
            .as_ref()
            .and_then(|f| f.get("taxId"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    let field = |key: &str| {
        address
            .as_ref()
            .and_then(|a| a.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    Ok(HookContext {
        direction,
        issue_date: document.map(|d| match &d.issue_date {
            document_tax::IssueDate::Instant(iso) => iso.chars().take(10).collect(),
            document_tax::IssueDate::Text(text) => text.clone(),
        }),
        entity_settings: entity.jurisdiction_settings.clone(),
        entity_tax_classification: entity.tax_classification.clone(),
        counterparty: Counterparty {
            country: field("country"),
            state_code: field("state"),
            tax_id,
            fiscal: br_fiscal,
        },
        document_fiscal: document.and_then(|d| d.fiscal_data.clone()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_tax_rate_spellings() {
        assert_eq!(sanitize_tax_rate_id(None), None);
        assert_eq!(sanitize_tax_rate_id(Some("")), None);
        assert_eq!(sanitize_tax_rate_id(Some(" none ")), None);
        assert_eq!(sanitize_tax_rate_id(Some("null")), None);
        assert_eq!(
            sanitize_tax_rate_id(Some(" tr_1 ")).as_deref(),
            Some("tr_1")
        );
    }

    #[test]
    fn untaxed_us_lines_carry_no_rate() {
        let items = [DocumentTaxItem {
            quantity: Some("2".into()),
            unit_price: "12.50".into(),
            ..DocumentTaxItem::default()
        }];
        let calc = untaxed_document_tax(&items);
        assert_eq!(calc.total, "25.00");
        assert_eq!(calc.processed_items[0].tax_rate, None);
        assert_eq!(calc.tax_breakdown, Vec::<Value>::new());
    }
}
