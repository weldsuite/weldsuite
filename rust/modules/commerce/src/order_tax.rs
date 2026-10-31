//! Order sales tax (`commerce-api/src/services/order-sales-tax.ts`): the
//! WeldBooks sales tax engine ([`crate::sales_tax`]) applied to orders and
//! carts.
//!
//! An order has no accounting entity, so the workspace's default entity
//! decides: `settings.defaultEntityId`, else the entity flagged `isDefault`,
//! else the only entity. The engine runs only when that entity's
//! jurisdiction does sales tax (the US); otherwise the result is
//! `{ supported: false }`. An engine failure is a 503 and never zero tax.

use axum::Json;
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use serde_json::{Map, Value, json};
use sqlx::PgPool;

use crate::js::{number_text, number_value, to_fixed};
use crate::sales_tax::rounding::{allocate_cents, from_cents, to_cents};
use crate::sales_tax::tax_codes::{
    DEFAULT_WELD_TAX_CODE, is_avalara_tax_code, is_stripe_tax_code, is_weld_tax_code,
};
use crate::sales_tax::{
    Address, Certificate, EngineError, LoadError, RequestLine, TaxRequest, TaxResult, TaxUse,
    load_context, load_customer_certificates, normalize_postal_address,
};

/// The shipping charge is a tax line of its own; no document line may use this id.
pub(crate) const SHIPPING_LINE_ID: &str = "shipping";
/// The whole order as one line, when it has a subtotal but no items.
const ORDER_LINE_ID: &str = "order";
/// Anonymous carts share this customer code.
const GUEST_CUSTOMER_CODE: &str = "guest";

/// `OrderSalesTaxError`: 503 `TAX_ENGINE_UNAVAILABLE` or 422 `TAX_REQUEST_INVALID`.
#[derive(Debug)]
pub(crate) struct OrderTaxError {
    code: &'static str,
    status: StatusCode,
    message: String,
    details: Option<Value>,
}

impl OrderTaxError {
    fn request_invalid(message: impl Into<String>) -> Self {
        Self {
            code: "TAX_REQUEST_INVALID",
            status: StatusCode::UNPROCESSABLE_ENTITY,
            message: message.into(),
            details: None,
        }
    }

    /// `toOrderTaxError(err)` of an engine failure.
    fn of_engine(error: &EngineError) -> Self {
        if error.code == "invalid_request" {
            return Self {
                code: "TAX_REQUEST_INVALID",
                status: StatusCode::UNPROCESSABLE_ENTITY,
                message: error.message.clone(),
                details: Some(json!({ "reason": error.code })),
            };
        }
        Self {
            code: "TAX_ENGINE_UNAVAILABLE",
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: error.message.clone(),
            details: Some(error.details()),
        }
    }

    /// `taxErrorResponse(c, err)`.
    pub(crate) fn respond(&self) -> Response {
        let mut error = Map::new();
        error.insert("code".to_owned(), json!(self.code));
        error.insert("message".to_owned(), json!(self.message));
        if let Some(details) = &self.details {
            error.insert("details".to_owned(), details.clone());
        }
        (self.status, Json(json!({ "error": error }))).into_response()
    }
}

/// Why a calculation stopped: the tax refusal the route answers, or a
/// statement (the route's 500).
#[derive(Debug)]
pub(crate) enum TaxFailure {
    Tax(OrderTaxError),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for TaxFailure {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<OrderTaxError> for TaxFailure {
    fn from(error: OrderTaxError) -> Self {
        Self::Tax(error)
    }
}

// ---------------------------------------------------------------------------
// Input and result
// ---------------------------------------------------------------------------

/// `OrderTaxLineInput` (the quantity goes to the provider engines only).
#[derive(Debug, Clone)]
pub(crate) struct LineInput {
    pub(crate) line_id: String,
    pub(crate) product_id: Option<String>,
    pub(crate) amount: f64,
    pub(crate) tax_code: Option<String>,
    pub(crate) tax_included: bool,
}

/// `OrderSalesTaxInput`.
#[derive(Debug, Clone, Default)]
pub(crate) struct TaxInput {
    pub(crate) order_id: Option<String>,
    pub(crate) lines: Vec<LineInput>,
    pub(crate) shipping_amount: f64,
    pub(crate) ship_to: Option<Value>,
    pub(crate) bill_to: Option<Value>,
    pub(crate) customer_party_id: Option<String>,
    pub(crate) customer_use: Option<TaxUse>,
    pub(crate) date: Option<String>,
    pub(crate) currency: String,
    pub(crate) marketplace_facilitated: bool,
    pub(crate) tax_exempt: bool,
    pub(crate) extra_warnings: Vec<String>,
}

/// `OrderTaxJurisdiction` (with a line detail's exemption).
#[derive(Debug, Clone)]
pub(crate) struct Jurisdiction {
    code: String,
    name: String,
    level: &'static str,
    state_code: String,
    agency_id: Option<String>,
    rate: f64,
    taxable_amount: f64,
    tax: f64,
    exempt_reason: Option<String>,
    certificate_id: Option<String>,
}

impl Jurisdiction {
    fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("code".to_owned(), json!(self.code));
        out.insert("name".to_owned(), json!(self.name));
        out.insert("level".to_owned(), json!(self.level));
        out.insert("stateCode".to_owned(), json!(self.state_code));
        if let Some(agency_id) = self.agency_id.as_deref().filter(|a| !a.is_empty()) {
            out.insert("agencyId".to_owned(), json!(agency_id));
        }
        out.insert("rate".to_owned(), number_value(self.rate));
        out.insert(
            "taxableAmount".to_owned(),
            number_value(self.taxable_amount),
        );
        out.insert("tax".to_owned(), number_value(self.tax));
        if let Some(reason) = self.exempt_reason.as_deref().filter(|r| !r.is_empty()) {
            out.insert("exemptReason".to_owned(), json!(reason));
        }
        if let Some(id) = self.certificate_id.as_deref().filter(|c| !c.is_empty()) {
            out.insert("certificateId".to_owned(), json!(id));
        }
        Value::Object(out)
    }
}

/// `OrderTaxLineResult`.
#[derive(Debug, Clone)]
pub(crate) struct LineTax {
    line_id: String,
    tax_code: String,
    tax: f64,
    rate: f64,
    taxable_amount: f64,
    exempt_amount: f64,
    non_taxable_amount: f64,
    details: Vec<Jurisdiction>,
}

impl LineTax {
    fn to_json(&self, with_details: bool) -> Value {
        let mut out = Map::new();
        out.insert("lineId".to_owned(), json!(self.line_id));
        out.insert("taxCode".to_owned(), json!(self.tax_code));
        out.insert("tax".to_owned(), number_value(self.tax));
        out.insert("rate".to_owned(), number_value(self.rate));
        out.insert(
            "taxableAmount".to_owned(),
            number_value(self.taxable_amount),
        );
        out.insert("exemptAmount".to_owned(), number_value(self.exempt_amount));
        out.insert(
            "nonTaxableAmount".to_owned(),
            number_value(self.non_taxable_amount),
        );
        if with_details {
            out.insert(
                "details".to_owned(),
                Value::Array(self.details.iter().map(Jurisdiction::to_json).collect()),
            );
        }
        Value::Object(out)
    }
}

/// `OrderSalesTaxCalculated`.
#[derive(Debug, Clone)]
pub(crate) struct Calculated {
    entity_id: String,
    engine: String,
    calculated_at: String,
    document_date: String,
    currency: String,
    sourcing: &'static str,
    ship_to_state: Option<String>,
    ship_to_postal_code: Option<String>,
    total_tax: f64,
    shipping_tax: f64,
    lines: Vec<LineTax>,
    jurisdictions: Vec<Jurisdiction>,
    warnings: Vec<String>,
}

/// `OrderSalesTaxResult`.
#[derive(Debug, Clone)]
pub(crate) enum TaxOutcome {
    /// `no_accounting_entity` or `sales_tax_not_supported`.
    Unsupported {
        reason: &'static str,
        entity_id: Option<String>,
    },
    Calculated(Box<Calculated>),
}

impl TaxOutcome {
    /// `toTaxResponse(result)`: the per-line jurisdiction detail stays on the
    /// order's metadata.
    pub(crate) fn response(&self) -> Map<String, Value> {
        match self {
            Self::Unsupported { reason, entity_id } => {
                let mut out = Map::new();
                out.insert("supported".to_owned(), json!(false));
                out.insert("reason".to_owned(), json!(reason));
                if let Some(entity_id) = entity_id {
                    out.insert("entityId".to_owned(), json!(entity_id));
                }
                out
            }
            Self::Calculated(calculated) => calculated.to_json(false),
        }
    }
}

impl Calculated {
    fn to_json(&self, with_details: bool) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("supported".to_owned(), json!(true));
        self.fill(&mut out, with_details);
        out
    }

    /// The fields after `supported` (`metadata.salesTax` has `version` there).
    fn fill(&self, out: &mut Map<String, Value>, with_details: bool) {
        out.insert("entityId".to_owned(), json!(self.entity_id));
        out.insert("engine".to_owned(), json!(self.engine));
        out.insert("calculatedAt".to_owned(), json!(self.calculated_at));
        out.insert("documentDate".to_owned(), json!(self.document_date));
        out.insert("currency".to_owned(), json!(self.currency));
        out.insert("sourcing".to_owned(), json!(self.sourcing));
        if let Some(state) = &self.ship_to_state {
            out.insert("shipToState".to_owned(), json!(state));
        }
        if let Some(code) = &self.ship_to_postal_code {
            out.insert("shipToPostalCode".to_owned(), json!(code));
        }
        out.insert("totalTax".to_owned(), number_value(self.total_tax));
        out.insert("shippingTax".to_owned(), number_value(self.shipping_tax));
        out.insert(
            "lines".to_owned(),
            Value::Array(self.lines.iter().map(|l| l.to_json(with_details)).collect()),
        );
        out.insert(
            "jurisdictions".to_owned(),
            Value::Array(
                self.jurisdictions
                    .iter()
                    .map(Jurisdiction::to_json)
                    .collect(),
            ),
        );
        out.insert("warnings".to_owned(), json!(self.warnings));
    }
}

// ---------------------------------------------------------------------------
// Tax codes, entity and customer
// ---------------------------------------------------------------------------

fn text(value: Option<&str>) -> Option<String> {
    let trimmed = weldsuite_kit::validation::js_trim(value?);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn accepted_tax_code(code: &str) -> bool {
    is_weld_tax_code(code) || is_stripe_tax_code(code) || is_avalara_tax_code(code)
}

/// What tax reads of a product.
struct Product {
    id: String,
    taxable: Option<bool>,
    tax_class: Option<String>,
}

/// `resolveLineTaxCode(lineCode, product)`.
fn resolve_line_tax_code(
    line_code: Option<&str>,
    product: Option<&Product>,
) -> Result<String, OrderTaxError> {
    if let Some(explicit) = text(line_code) {
        if !accepted_tax_code(&explicit) {
            return Err(OrderTaxError::request_invalid(format!(
                "Unknown tax code \"{explicit}\""
            )));
        }
        return Ok(explicit);
    }
    if let Some(product) = product {
        if product.taxable == Some(false) {
            return Ok("non_taxable".to_owned());
        }
        if let Some(tax_class) = text(product.tax_class.as_deref())
            && accepted_tax_code(&tax_class)
        {
            return Ok(tax_class);
        }
    }
    Ok(DEFAULT_WELD_TAX_CODE.to_owned())
}

/// The entity orders are taxed under.
struct TaxEntity {
    id: String,
    jurisdiction_code: String,
    sales_tax_engine: Option<String>,
    address: Option<Address>,
}

type EntityRow = (String, String, Option<String>, Option<Value>);

/// `resolveOrderTaxEntity(db)`: the workspace default, else the one
/// flagged default, else the only one.
async fn resolve_order_tax_entity(db: &PgPool) -> Result<Option<TaxEntity>, sqlx::Error> {
    let entity = |(id, jurisdiction_code, sales_tax_engine, address): EntityRow| TaxEntity {
        id,
        jurisdiction_code,
        sales_tax_engine,
        address: normalize_postal_address(address.as_ref()),
    };
    let default_id: Option<Option<String>> =
        sqlx::query_scalar("select default_entity_id from settings limit 1")
            .fetch_optional(db)
            .await?;
    if let Some(default_id) = default_id.flatten().filter(|id| !id.is_empty()) {
        let row: Option<EntityRow> = sqlx::query_as(
            "select id, jurisdiction_code, sales_tax_engine, address from entities \
             where id = $1 and deleted_at is null limit 1",
        )
        .bind(&default_id)
        .fetch_optional(db)
        .await?;
        if let Some(row) = row {
            return Ok(Some(entity(row)));
        }
    }
    let flagged: Option<EntityRow> = sqlx::query_as(
        "select id, jurisdiction_code, sales_tax_engine, address from entities \
         where is_default = true and is_active = true and deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    if let Some(row) = flagged {
        return Ok(Some(entity(row)));
    }
    let mut rows: Vec<EntityRow> = sqlx::query_as(
        "select id, jurisdiction_code, sales_tax_engine, address from entities where deleted_at is null limit 2",
    )
    .fetch_all(db)
    .await?;
    Ok(if rows.len() == 1 {
        rows.pop().map(entity)
    } else {
        None
    })
}

/// The buyer: its party id (or `guest`), kind, tax use and certificates.
struct Customer {
    party_id: String,
    kind: Option<String>,
    tax_use: Option<String>,
    certificates: Vec<Certificate>,
}

async fn load_customer(
    db: &PgPool,
    entity_id: &str,
    party_id: Option<&str>,
) -> Result<Customer, sqlx::Error> {
    let guest = || Customer {
        party_id: GUEST_CUSTOMER_CODE.to_owned(),
        kind: None,
        tax_use: None,
        certificates: Vec::new(),
    };
    let Some(party_id) = party_id.filter(|p| !p.is_empty()) else {
        return Ok(guest());
    };
    let party: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select id, kind, tax_use from parties where id = $1 and deleted_at is null limit 1",
    )
    .bind(party_id)
    .fetch_optional(db)
    .await?;
    // A legacy customer id that is no party has no certificates to find.
    let Some((id, kind, tax_use)) = party else {
        return Ok(guest());
    };
    let certificates = load_customer_certificates(db, entity_id, &id).await?;
    Ok(Customer {
        party_id: id,
        kind,
        tax_use,
        certificates,
    })
}

/// `parties.taxUse`, else a company buys for business and a person for
/// personal use; an anonymous buyer is a consumer.
fn default_tax_use(tax_use: Option<&str>, kind: Option<&str>) -> TaxUse {
    match tax_use {
        Some("business") => TaxUse::Business,
        Some("personal") => TaxUse::Personal,
        _ if kind == Some("company") => TaxUse::Business,
        _ => TaxUse::Personal,
    }
}

/// The address the sale is taxed at: the ship-to, else the bill-to when the
/// ship-to has no state.
fn tax_address(ship_to: Option<Address>, bill_to: Option<Address>) -> Option<Address> {
    if ship_to.as_ref().is_some_and(|a| a.state.is_some()) {
        return ship_to;
    }
    if bill_to.as_ref().is_some_and(|a| a.state.is_some()) {
        return bill_to;
    }
    ship_to.or(bill_to)
}

fn round4(value: f64) -> f64 {
    crate::js::math_round(value * 10_000.0) / 10_000.0
}

fn today() -> String {
    crate::now().chars().take(10).collect()
}

// ---------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------

struct Totals {
    jurisdiction: Jurisdiction,
    taxable_cents: i64,
    tax_cents: i64,
}

/// `calculateOrderSalesTax(db, env, input)`.
pub(crate) async fn calculate_order_sales_tax(
    db: &PgPool,
    keyring: &weldsuite_db::Keyring,
    input: &TaxInput,
) -> Result<TaxOutcome, TaxFailure> {
    let Some(entity) = resolve_order_tax_entity(db).await? else {
        return Ok(TaxOutcome::Unsupported {
            reason: "no_accounting_entity",
            entity_id: None,
        });
    };
    // Only the US adapter has `features.salesTax`.
    if !entity.jurisdiction_code.eq_ignore_ascii_case("US") {
        return Ok(TaxOutcome::Unsupported {
            reason: "sales_tax_not_supported",
            entity_id: Some(entity.id),
        });
    }

    let mut ids: Vec<&str> = vec![SHIPPING_LINE_ID];
    for line in &input.lines {
        if ids.contains(&line.line_id.as_str()) {
            return Err(OrderTaxError::request_invalid(format!(
                "Line id \"{}\" is used twice or is reserved",
                line.line_id
            ))
            .into());
        }
        ids.push(&line.line_id);
    }

    let mut product_ids: Vec<String> = Vec::new();
    for id in input
        .lines
        .iter()
        .filter_map(|l| l.product_id.clone())
        .filter(|id| !id.is_empty())
    {
        if !product_ids.contains(&id) {
            product_ids.push(id);
        }
    }
    let products: Vec<Product> = if product_ids.is_empty() {
        Vec::new()
    } else {
        let rows: Vec<(String, Option<bool>, Option<String>)> =
            sqlx::query_as("select id, taxable, tax_class from products where id = any($1)")
                .bind(&product_ids)
                .fetch_all(db)
                .await?;
        rows.into_iter()
            .map(|(id, taxable, tax_class)| Product {
                id,
                taxable,
                tax_class,
            })
            .collect()
    };

    let mut codes: Vec<(String, String)> = Vec::new();
    for line in &input.lines {
        let product = line
            .product_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .and_then(|id| products.iter().find(|p| p.id == id));
        codes.push((
            line.line_id.clone(),
            resolve_line_tax_code(line.tax_code.as_deref(), product)?,
        ));
    }
    let shipping_cents = to_cents(input.shipping_amount);
    if shipping_cents > 0 {
        codes.push((SHIPPING_LINE_ID.to_owned(), "shipping".to_owned()));
    }
    let code_of = |line_id: &str| {
        codes.iter().find(|(id, _)| id == line_id).map_or_else(
            || DEFAULT_WELD_TAX_CODE.to_owned(),
            |(_, code)| code.clone(),
        )
    };

    let customer = load_customer(db, &entity.id, input.customer_party_id.as_deref()).await?;
    let tax_use = input
        .customer_use
        .unwrap_or_else(|| default_tax_use(customer.tax_use.as_deref(), customer.kind.as_deref()));
    let ship_to = tax_address(
        normalize_postal_address(input.ship_to.as_ref()),
        normalize_postal_address(input.bill_to.as_ref()),
    );
    let document_date = input.date.clone().unwrap_or_else(today);
    let currency = input.currency.to_uppercase();

    // A line with nothing to tax needs no engine call.
    let mut sent: Vec<RequestLine> = input
        .lines
        .iter()
        .filter(|l| to_cents(l.amount) > 0)
        .map(|l| RequestLine {
            line_id: l.line_id.clone(),
            amount: from_cents(to_cents(l.amount)),
            tax_code: code_of(&l.line_id),
            tax_use,
            tax_included: l.tax_included,
        })
        .collect();
    if shipping_cents > 0 {
        sent.push(RequestLine {
            line_id: SHIPPING_LINE_ID.to_owned(),
            amount: from_cents(shipping_cents),
            tax_code: "shipping".to_owned(),
            tax_use,
            tax_included: false,
        });
    }

    let mut engine_result: Option<TaxResult> = None;
    let engine_id = entity
        .sales_tax_engine
        .clone()
        .unwrap_or_else(|| "manual".to_owned());
    if !sent.is_empty() {
        let context = match load_context(db, &entity.id, keyring).await {
            Ok(context) => context,
            Err(LoadError::Engine(error)) => return Err(OrderTaxError::of_engine(&error).into()),
            Err(LoadError::Database(error)) => return Err(error.into()),
        };
        let request = TaxRequest {
            document_id: input.order_id.clone(),
            document_date: document_date.clone(),
            ship_from: entity.address.clone(),
            ship_to,
            certificates: customer.certificates,
            registrations: context.registrations,
            lines: sent,
            marketplace_facilitated: input.marketplace_facilitated,
        };
        engine_result = Some(context.engine.calculate(&request, crate::now()));
    }
    // The party id goes to the provider engines only.
    let _ = customer.party_id;

    let mut totals: Vec<(String, Totals)> = Vec::new();
    let mut line_result = |line_id: &str| -> LineTax {
        let found = engine_result
            .as_ref()
            .and_then(|r| r.lines.iter().find(|l| l.line_id == line_id));
        let details: Vec<Jurisdiction> = found
            .map(|l| {
                l.details
                    .iter()
                    .map(|d| Jurisdiction {
                        code: d.jurisdiction_code.clone(),
                        name: d.jurisdiction_name.clone(),
                        level: d.level,
                        state_code: d.state_code.clone(),
                        agency_id: d.agency_id.clone().filter(|a| !a.is_empty()),
                        rate: d.rate,
                        taxable_amount: d.taxable_amount,
                        tax: d.tax,
                        exempt_reason: d.exempt_reason.clone(),
                        certificate_id: d.certificate_id.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        for d in &details {
            let key = format!(
                "{}|{}|{}|{}|{}",
                d.agency_id.as_deref().unwrap_or(""),
                d.state_code,
                d.level,
                d.code,
                number_text(d.rate)
            );
            let entry = match totals.iter_mut().find(|(k, _)| *k == key) {
                Some((_, entry)) => entry,
                None => {
                    totals.push((
                        key,
                        Totals {
                            jurisdiction: Jurisdiction {
                                exempt_reason: None,
                                certificate_id: None,
                                ..d.clone()
                            },
                            taxable_cents: 0,
                            tax_cents: 0,
                        },
                    ));
                    &mut totals.last_mut().expect("just pushed").1
                }
            };
            entry.taxable_cents += to_cents(d.taxable_amount);
            entry.tax_cents += to_cents(d.tax);
        }
        LineTax {
            line_id: line_id.to_owned(),
            tax_code: code_of(line_id),
            tax: found.map_or(0.0, |l| l.tax),
            rate: round4(
                details
                    .iter()
                    .filter(|d| d.taxable_amount > 0.0)
                    .fold(0.0, |sum, d| sum + d.rate),
            ),
            taxable_amount: found.map_or(0.0, |l| l.taxable_amount),
            exempt_amount: found.map_or(0.0, |l| l.exempt_amount),
            non_taxable_amount: found.map_or(0.0, |l| l.non_taxable_amount),
            details,
        }
    };
    let mut lines: Vec<LineTax> = input
        .lines
        .iter()
        .map(|l| line_result(&l.line_id))
        .collect();
    if shipping_cents > 0 {
        lines.push(line_result(SHIPPING_LINE_ID));
    }

    let jurisdictions: Vec<Jurisdiction> = totals
        .into_iter()
        .filter(|(_, t)| t.tax_cents != 0 || t.taxable_cents != 0)
        .map(|(_, t)| Jurisdiction {
            taxable_amount: from_cents(t.taxable_cents),
            tax: from_cents(t.tax_cents),
            ..t.jurisdiction
        })
        .collect();

    let mut warnings: Vec<String> = Vec::new();
    for warning in engine_result
        .as_ref()
        .map(|r| r.warnings.clone())
        .unwrap_or_default()
        .into_iter()
        .chain(input.extra_warnings.iter().cloned())
    {
        if !warnings.contains(&warning) {
            warnings.push(warning);
        }
    }
    let tax_exempt_warning = "tax_exempt_flag_without_certificate".to_owned();
    if input.tax_exempt
        && !lines.iter().any(|l| l.exempt_amount > 0.0)
        && !warnings.contains(&tax_exempt_warning)
    {
        warnings.push(tax_exempt_warning);
    }

    let total_tax = from_cents(lines.iter().map(|l| to_cents(l.tax)).sum());
    let shipping_tax = lines
        .iter()
        .find(|l| l.line_id == SHIPPING_LINE_ID)
        .map_or(0.0, |l| l.tax);
    Ok(TaxOutcome::Calculated(Box::new(Calculated {
        entity_id: entity.id,
        engine: engine_result
            .as_ref()
            .map_or(engine_id, |r| r.engine.to_owned()),
        calculated_at: engine_result
            .as_ref()
            .map_or_else(crate::now, |r| r.calculated_at.clone()),
        document_date,
        currency,
        sourcing: engine_result.as_ref().map_or("none", |r| r.sourcing),
        ship_to_state: engine_result.as_ref().and_then(|r| r.ship_to_state.clone()),
        ship_to_postal_code: engine_result
            .as_ref()
            .and_then(|r| r.ship_to_postal_code.clone()),
        total_tax,
        shipping_tax,
        lines,
        jurisdictions,
        warnings,
    })))
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/// An order item as tax reads it (`OrderTaxItem`).
#[derive(Debug, Clone)]
pub(crate) struct TaxItem {
    id: String,
    product_id: Option<String>,
    quantity: f64,
    unit_price: Option<String>,
    discount_amount: Option<String>,
    tax_amount: Option<String>,
}

/// `loadOrderTaxItems(db, orderId)`.
pub(crate) async fn load_order_tax_items<'e>(
    db: impl sqlx::PgExecutor<'e>,
    order_id: &str,
) -> Result<Vec<TaxItem>, sqlx::Error> {
    let rows: Vec<(String, Option<String>, Option<i32>, Option<String>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "select id, product_id, quantity, unit_price::text, discount_amount::text, tax_amount::text \
             from order_items where order_id = $1 order by id",
        )
        .bind(order_id)
        .fetch_all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, product_id, quantity, unit_price, discount_amount, tax_amount)| TaxItem {
                id,
                product_id,
                quantity: f64::from(quantity.unwrap_or(0)),
                unit_price,
                discount_amount,
                tax_amount,
            },
        )
        .collect())
}

/// `money(value)`: a number, `0` for nothing or what is not one.
fn money(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Null) => 0.0,
        Some(Value::String(text)) if text.is_empty() => 0.0,
        Some(value) => {
            let parsed = weldsuite_kit::validation::js_number_of(Some(value));
            if parsed.is_finite() { parsed } else { 0.0 }
        }
    }
}

fn money_text(value: Option<&str>) -> f64 {
    money(value.map(|v| Value::String(v.to_owned())).as_ref())
}

/// JavaScript truthiness.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// A value as JavaScript passes it on as an id.
fn id_text(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Number(n)) => Some(number_text(n.as_f64().unwrap_or(f64::NAN))),
        Some(other) => Some(other.to_string()),
    }
}

/// `isoDay(order.createdAt)`.
fn iso_day_of(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => {
            crate::js::js_date_iso(text).map(|iso| iso.chars().take(10).collect())
        }
        _ => None,
    }
}

/// `{ ...value }` when it is an object (`asRecord`).
fn as_record(value: Option<&Value>) -> Option<Map<String, Value>> {
    match value {
        Some(Value::Object(map)) => Some(map.clone()),
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .enumerate()
                .map(|(i, item)| (i.to_string(), item.clone()))
                .collect(),
        ),
        _ => None,
    }
}

/// `OrderTaxOptions`.
#[derive(Debug, Clone, Default)]
pub(crate) struct TaxOptions {
    pub(crate) date: Option<String>,
    pub(crate) customer_use: Option<TaxUse>,
    pub(crate) marketplace_facilitated: bool,
}

/// `taxInputFromOrder(order, items, options)`: each item's price × quantity
/// less its own discount and its share of an order-level discount; an
/// order with a subtotal but no items is one line of general goods.
pub(crate) fn tax_input_from_order(
    order: &Map<String, Value>,
    items: &[TaxItem],
    options: &TaxOptions,
) -> TaxInput {
    let gross: Vec<(&TaxItem, f64, i64, i64)> = items
        .iter()
        .map(|item| {
            let quantity = if item.quantity > 0.0 {
                item.quantity
            } else {
                1.0
            };
            let own = to_cents(money_text(item.discount_amount.as_deref()));
            let cents = (to_cents(money_text(item.unit_price.as_deref()) * quantity) - own).max(0);
            (item, quantity, cents, own)
        })
        .collect();
    let item_discounts: i64 = gross.iter().map(|g| g.3).sum();
    let order_discount = (to_cents(money(order.get("discountTotal"))) - item_discounts).max(0);
    let base: i64 = gross.iter().map(|g| g.2).sum();
    #[allow(clippy::cast_precision_loss)]
    let shares = if order_discount > 0 && base > 0 {
        allocate_cents(
            order_discount.min(base),
            &gross.iter().map(|g| g.2 as f64).collect::<Vec<_>>(),
        )
    } else {
        Vec::new()
    };

    let mut extra_warnings = Vec::new();
    let mut lines: Vec<LineInput> = gross
        .iter()
        .enumerate()
        .map(|(i, (item, _, cents, _))| LineInput {
            line_id: item.id.clone(),
            product_id: item.product_id.clone(),
            amount: from_cents((cents - shares.get(i).copied().unwrap_or(0)).max(0)),
            tax_code: None,
            tax_included: false,
        })
        .collect();
    let subtotal = money(order.get("subtotal"));
    if lines.is_empty() && subtotal > 0.0 {
        lines = vec![LineInput {
            line_id: ORDER_LINE_ID.to_owned(),
            product_id: None,
            amount: subtotal,
            tax_code: None,
            tax_included: false,
        }];
        extra_warnings.push("no_line_items".to_owned());
    }

    let customer = match order.get("counterpartyId") {
        None | Some(Value::Null) => id_text(order.get("customerId")),
        value => id_text(value),
    };
    let currency = match order.get("currency") {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        _ => "USD".to_owned(),
    };
    TaxInput {
        order_id: id_text(order.get("id")).filter(|id| !id.is_empty()),
        lines,
        shipping_amount: money(order.get("shippingTotal")),
        ship_to: order
            .get("shippingAddress")
            .filter(|v| v.is_object() || v.is_array())
            .cloned(),
        bill_to: order
            .get("billingAddress")
            .filter(|v| v.is_object() || v.is_array())
            .cloned(),
        customer_party_id: customer,
        customer_use: options.customer_use,
        date: options
            .date
            .clone()
            .or_else(|| iso_day_of(order.get("createdAt"))),
        currency,
        marketplace_facilitated: options.marketplace_facilitated,
        tax_exempt: truthy(order.get("taxExempt")),
        extra_warnings,
    }
}

/// `OrderTaxApplication`: the order columns a calculation writes, and the
/// items whose tax changed.
#[derive(Debug, Clone)]
pub(crate) struct Application {
    pub(crate) tax_lines: Value,
    pub(crate) tax_total: String,
    pub(crate) total: String,
    pub(crate) metadata: Value,
    pub(crate) items: Vec<(String, String)>,
}

impl Application {
    /// The order columns, as properties (`Object.assign(update, application.order)`).
    pub(crate) fn order_fields(&self) -> [(&'static str, Value); 4] {
        [
            ("taxLines", self.tax_lines.clone()),
            ("taxTotal", json!(self.tax_total)),
            ("total", json!(self.total)),
            ("metadata", self.metadata.clone()),
        ]
    }

    /// `appliedOrder(id, application)`.
    pub(crate) fn applied(&self, id: &str) -> Value {
        json!({ "id": id, "taxLines": self.tax_lines, "taxTotal": self.tax_total, "total": self.total })
    }
}

/// `buildOrderTaxApplication(order, items, result)`.
pub(crate) fn build_order_tax_application(
    order: &Map<String, Value>,
    items: &[TaxItem],
    result: &Calculated,
) -> Application {
    let tax_cents = to_cents(result.total_tax);
    let has_total = match order.get("total") {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    };
    let total_cents = if has_total {
        to_cents(money(order.get("total"))) - to_cents(money(order.get("taxTotal"))) + tax_cents
    } else {
        to_cents(money(order.get("subtotal"))) - to_cents(money(order.get("discountTotal")))
            + to_cents(money(order.get("shippingTotal")))
            + tax_cents
    };

    let changed: Vec<(String, String)> = items
        .iter()
        .filter_map(|item| {
            let tax = result
                .lines
                .iter()
                .find(|l| l.line_id == item.id)
                .map_or(0.0, |l| l.tax);
            (to_cents(money_text(item.tax_amount.as_deref())) != to_cents(tax))
                .then(|| (item.id.clone(), to_fixed(tax, 2)))
        })
        .collect();

    let mut metadata = as_record(order.get("metadata")).unwrap_or_default();
    let mut sales_tax = Map::new();
    sales_tax.insert("version".to_owned(), json!(1));
    result.fill(&mut sales_tax, true);
    // `totalTax` … `warnings`, `jurisdictions`, `lines`: the same fields, in another order.
    metadata.insert("salesTax".to_owned(), Value::Object(sales_tax));

    Application {
        tax_lines: Value::Array(
            result
                .jurisdictions
                .iter()
                .filter(|j| to_cents(j.tax) != 0)
                .map(|j| json!({ "title": j.name, "rate": number_value(j.rate), "price": to_fixed(j.tax, 2) }))
                .collect(),
        ),
        tax_total: to_fixed(from_cents(tax_cents), 2),
        total: to_fixed(from_cents(total_cents), 2),
        metadata: Value::Object(metadata),
        items: changed,
    }
}

/// `calculateOrderTax(db, env, order, items, options)`: the result and,
/// when the engine ran, what applying it would write.
pub(crate) async fn calculate_order_tax(
    db: &PgPool,
    keyring: &weldsuite_db::Keyring,
    order: &Map<String, Value>,
    items: &[TaxItem],
    options: &TaxOptions,
) -> Result<(TaxOutcome, Option<Application>), TaxFailure> {
    let outcome =
        calculate_order_sales_tax(db, keyring, &tax_input_from_order(order, items, options))
            .await?;
    let application = match &outcome {
        TaxOutcome::Calculated(calculated) => {
            Some(build_order_tax_application(order, items, calculated))
        }
        TaxOutcome::Unsupported { .. } => None,
    };
    Ok((outcome, application))
}

/// `orderTaxLockReason(order)`: paid and cancelled orders are frozen.
pub(crate) fn order_tax_lock_reason(order: &Map<String, Value>) -> Option<&'static str> {
    let payment_status = order.get("paymentStatus").and_then(Value::as_str);
    if truthy(order.get("paidAt"))
        || payment_status.is_some_and(|s| ["paid", "partially_refunded", "refunded"].contains(&s))
    {
        return Some(
            "The order is paid; its tax is frozen. Preview the calculation without applying it.",
        );
    }
    if truthy(order.get("cancelledAt"))
        || order.get("status").and_then(Value::as_str) == Some("cancelled")
    {
        return Some("The order is cancelled; its tax is frozen.");
    }
    None
}

/// The item updates of an application (`orderItemTaxStatements`).
pub(crate) async fn write_item_tax(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    application: &Application,
) -> Result<(), sqlx::Error> {
    for (id, tax_amount) in &application.items {
        sqlx::query("update order_items set tax_amount = $1::numeric where id = $2")
            .bind(tax_amount)
            .bind(id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

/// `persistOrderTax(db, orderId, application)`: the order columns and its
/// items' tax, together or not at all.
pub(crate) async fn persist_order_tax(
    db: &PgPool,
    order_id: &str,
    application: &Application,
) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query(
        "update orders set tax_lines = $1, tax_total = $2::numeric, total = $3::numeric, metadata = $4, \
         updated_at = $5::timestamp where id = $6 and deleted_at is null",
    )
    .bind(&application.tax_lines)
    .bind(&application.tax_total)
    .bind(&application.total)
    .bind(&application.metadata)
    .bind(crate::now())
    .bind(order_id)
    .execute(&mut *tx)
    .await?;
    write_item_tax(&mut tx, application).await?;
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_order_like_the_service() {
        let order = json!({
            "id": "ord_1", "subtotal": "150.00", "shippingTotal": "10.00", "discountTotal": "15.00",
            "currency": "", "taxExempt": 1, "createdAt": "2026-03-15T10:00:00.000Z",
            "shippingAddress": { "state": "TX" }, "counterpartyId": null, "customerId": "pty_1",
        });
        let order = order.as_object().expect("an object");
        let item = |id: &str, price: &str, quantity: f64| TaxItem {
            id: id.to_owned(),
            product_id: None,
            quantity,
            unit_price: Some(price.to_owned()),
            discount_amount: None,
            tax_amount: Some("0.00".to_owned()),
        };
        let input = tax_input_from_order(
            order,
            &[item("a", "50.00", 2.0), item("b", "50.00", 1.0)],
            &TaxOptions::default(),
        );
        assert_eq!(
            input.lines.iter().map(|l| l.amount).collect::<Vec<_>>(),
            vec![90.0, 45.0]
        );
        assert_eq!(input.currency, "USD");
        assert_eq!(input.date.as_deref(), Some("2026-03-15"));
        assert_eq!(input.customer_party_id.as_deref(), Some("pty_1"));
        assert!(input.tax_exempt);

        let empty = tax_input_from_order(order, &[], &TaxOptions::default());
        assert_eq!(empty.lines[0].line_id, ORDER_LINE_ID);
        assert_eq!(empty.extra_warnings, vec!["no_line_items".to_owned()]);
        assert_eq!(
            order_tax_lock_reason(
                json!({ "paymentStatus": "paid" })
                    .as_object()
                    .expect("an object")
            ),
            Some(
                "The order is paid; its tax is frozen. Preview the calculation without applying it."
            )
        );
    }

    #[test]
    fn resolves_tax_codes() {
        let product = Product {
            id: "p".into(),
            taxable: Some(true),
            tax_class: Some("standard".into()),
        };
        assert_eq!(
            resolve_line_tax_code(None, Some(&product)).expect("a code"),
            "general"
        );
        assert_eq!(
            resolve_line_tax_code(Some(" saas "), None).expect("a code"),
            "saas"
        );
        assert!(resolve_line_tax_code(Some("standard"), None).is_err());
    }
}
